import 'server-only';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';

/**
 * MAIN S3 client (TWC s3.twcstorage.ru). Используется для:
 * - бэкапов (через сервис backup);
 * - хранения статичных referencе-файлов (например, регламент/структура/примеры
 *   писем для инструмента «Цепочки писем 2.0»);
 * - произвольных загрузок инструментов, которым нужен «общий» бакет.
 *
 * Переменные окружения берутся под префиксом MAIN_S3_*. Для совместимости
 * допускаются варианты без префикса MAIN_ (S3_*) — используются как фолбэк,
 * чтобы не ломать локальные dev-конфиги.
 */

function pickEnv(...names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function requireEnv(...names: string[]): string {
  const value = pickEnv(...names);
  if (!value) {
    throw new Error(`Missing one of environment variables: ${names.join(', ')}`);
  }
  return value;
}

let _s3: S3Client | null = null;
let _bucket: string | null = null;
let _region: string | null = null;
let _endpoint: string | undefined;

function getConfig() {
  if (!_bucket) {
    _bucket = requireEnv('MAIN_S3_BUCKET', 'S3_BUCKET');
    _region = pickEnv('MAIN_S3_REGION', 'S3_REGION') || 'ru-1';
    _endpoint = pickEnv('MAIN_S3_ENDPOINT', 'S3_ENDPOINT') || undefined;

    const accessKeyId = requireEnv('MAIN_S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY_ID');
    const secretAccessKey = requireEnv('MAIN_S3_SECRET_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY');

    _s3 = new S3Client({
      region: _region,
      credentials: { accessKeyId, secretAccessKey },
      endpoint: _endpoint,
      forcePathStyle: Boolean(_endpoint),
    });
  }
  return { s3: _s3!, bucket: _bucket, region: _region!, endpoint: _endpoint };
}

export type MainS3PutResult = {
  key: string;
  bucket: string;
  size: number;
};

export async function putMainS3Object(params: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
  cacheControl?: string;
}): Promise<MainS3PutResult> {
  const { s3, bucket } = getConfig();
  const body = typeof params.body === 'string' ? Buffer.from(params.body, 'utf-8') : Buffer.from(params.body);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: body,
      ContentType: params.contentType ?? 'application/octet-stream',
      CacheControl: params.cacheControl ?? 'private, max-age=300',
    }),
  );
  return { key: params.key, bucket, size: body.length };
}

/**
 * Стримящая multipart-загрузка в MAIN S3. Полезно когда тело — большой поток
 * (например ZIP-архив, который собирается в реальном времени из множества
 * DOCX по мере выгрузки): не держим всё в памяти, S3-SDK заливает чанками
 * по 5 MB параллельно.
 */
export async function uploadMainS3Stream(params: {
  key: string;
  body: Readable;
  contentType?: string;
  cacheControl?: string;
}): Promise<MainS3PutResult> {
  const { s3, bucket } = getConfig();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType ?? 'application/octet-stream',
      CacheControl: params.cacheControl ?? 'private, max-age=300',
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false,
  });

  let totalSize = 0;
  upload.on('httpUploadProgress', (p) => {
    if (typeof p.loaded === 'number') totalSize = p.loaded;
  });

  await upload.done();
  return { key: params.key, bucket, size: totalSize };
}

export async function getMainS3ObjectText(key: string): Promise<string | null> {
  const { s3, bucket } = getConfig();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    if (typeof (body as { transformToString?: unknown }).transformToString === 'function') {
      return await (body as { transformToString: (encoding?: string) => Promise<string> }).transformToString('utf-8');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? '';
    if (/NoSuchKey|NotFound/i.test(String(code))) return null;
    throw err;
  }
}

export async function getMainS3ObjectBuffer(key: string): Promise<Buffer | null> {
  const { s3, bucket } = getConfig();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
      const arr = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(arr);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? '';
    if (/NoSuchKey|NotFound/i.test(String(code))) return null;
    throw err;
  }
}

export async function deleteMainS3Object(key: string): Promise<void> {
  const { s3, bucket } = getConfig();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function mainS3ObjectExists(key: string): Promise<boolean> {
  const { s3, bucket } = getConfig();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? '';
    if (/NoSuchKey|NotFound|404/i.test(String(code))) return false;
    throw err;
  }
}

export async function createMainS3DownloadUrl(params: { key: string; expiresInSeconds?: number; downloadFilename?: string }): Promise<string> {
  const { s3, bucket } = getConfig();
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: params.key,
    ResponseContentDisposition: params.downloadFilename
      ? `attachment; filename="${encodeURIComponent(params.downloadFilename)}"`
      : undefined,
  });
  return getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 60 * 10 });
}

/**
 * Presigned PUT URL — браузер заливает файл НАПРЯМУЮ в S3, минуя наш сервер
 * (обходит лимит размера тела роута Next). Тот же механизм, что у аватарок/
 * картинок задач. Клиент делает: fetch(url, { method:'PUT', body:file,
 * headers:{ 'Content-Type': contentType } }).
 */
export async function createMainS3UploadUrl(params: {
  key: string;
  contentType?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const { s3, bucket } = getConfig();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: params.key,
    ContentType: params.contentType ?? 'application/octet-stream',
  });
  return getSignedUrl(s3, cmd, { expiresIn: params.expiresInSeconds ?? 60 * 30 });
}

/**
 * Стримящее чтение объекта из S3. Для парсинга больших файлов (миллионы
 * строк) — не грузим весь файл в память, читаем потоком построчно.
 * Возвращает null если ключа нет.
 */
export async function getMainS3ObjectStream(key: string): Promise<Readable | null> {
  const { s3, bucket } = getConfig();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (res.Body as Readable) ?? null;
  } catch (err) {
    const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code ?? '';
    if (/NoSuchKey|NotFound/i.test(String(code))) return null;
    throw err;
  }
}
