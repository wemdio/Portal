import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import {
  extractOrConvertToMp3,
  transcribeAudio,
  setServerSideProgress,
  clearServerSideProgress,
} from '@/lib/transcription';
import {
  getMainS3ObjectBuffer,
  deleteMainS3Object,
} from '@/lib/mainS3Server';
import { startTrace } from '@/lib/tracer';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.mp4', '.avi']);
const MAX_FILE_SIZE_BYTES = 600 * 1024 * 1024;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getExtension(filename: string | null): string {
  if (!filename) return '';
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
}

/**
 * POST /api/tools/audio-transcribe
 * Body: { s3Key: string, filename: string, jobId?: string }
 *
 * Файл уже залит браузером НАПРЯМУЮ в S3 через presigned PUT (см. /presign).
 * Тело этого POST'а — крошечный JSON, поэтому корпоративные шлюзы, которые
 * душат multipart-аплоды на polza-portal.ru, его не режут. Сервер сам
 * скачивает файл из S3 быстрым server-to-server соединением и прогоняет
 * его через ту же цепочку что и раньше (ffmpeg → transcribe-worker).
 */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  let body: { s3Key?: unknown; filename?: unknown; jobId?: unknown };
  try {
    body = (await req.json()) as { s3Key?: unknown; filename?: unknown; jobId?: unknown };
  } catch {
    return jsonError('Ожидается JSON с полем s3Key', 400);
  }

  const s3Key = typeof body.s3Key === 'string' ? body.s3Key.trim() : '';
  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  const transcribeJobId =
    typeof body.jobId === 'string' && body.jobId.trim() ? body.jobId.trim() : undefined;

  if (!s3Key) return jsonError('Не указан ключ файла (s3Key)', 400);
  if (!filename) return jsonError('Не указано имя файла', 400);

  // Анти-spoofing: ключ обязан лежать в подкаталоге этого пользователя. Presign
  // выдаёт ровно такой формат, любое отклонение = кто-то пытается прочитать
  // чужой файл через свою сессию.
  const expectedPrefix = `audio-transcribe/${user.id}/`;
  if (!s3Key.startsWith(expectedPrefix)) {
    return jsonError('Неверный ключ файла', 400);
  }

  const ext = getExtension(filename);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return jsonError('Неверный формат файла. Поддерживаются: MP3, WAV, MP4, AVI.', 400);
  }

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = getIp(req);
  const logMeta = { userId: user.id, requestId, route, ip };
  const trace: Awaited<ReturnType<typeof startTrace>> | null = await startTrace({
    name: 'audio_transcribe.process',
    input: { requestId, route, ip, userId: user.id, s3Key },
    message: 'Запуск расшифровки аудио/видео (S3 upload)',
    userId: user.id,
  });

  // Сообщаем UI: файл на сервере уже принят, качаем из S3. Без этого polling
  // видел бы 404 пока идёт скачивание + ffmpeg, и прогресс-бар стоял бы
  // на «Загружаем...» лишние секунды/минуты.
  if (transcribeJobId) {
    setServerSideProgress(transcribeJobId, 'preparing', 2);
  }

  let fileBytes: Buffer | null = null;
  let lastDownloadErr: unknown = null;
  // Retry the S3 download на транзиентные сбои (сеть до Timeweb флапает,
  // DNS иногда таймаутит). Три попытки с exp-бэкоффом достаточно, чтобы
  // проскочить типичный blip и не мучать пользователя «загрузите заново».
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fileBytes = await getMainS3ObjectBuffer(s3Key);
      lastDownloadErr = null;
      break;
    } catch (err) {
      lastDownloadErr = err;
      // Дублируем в stderr — logError уходит в БД (application_logs), а её
      // из `docker logs portal` не грепнешь. Без console.error расследование
      // ошибки скачки требует ходить в базу.
      console.error(
        `[audio.transcribe] S3 download attempt ${attempt}/3 failed for key=${s3Key}:`,
        err,
      );
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  if (lastDownloadErr) {
    if (transcribeJobId) clearServerSideProgress(transcribeJobId);
    await trace?.fail(lastDownloadErr, { stage: 'download_from_s3', s3Key });
    await logError('audio.transcribe.s3.download.failed', lastDownloadErr, { stage: 'download_from_s3', s3Key }, logMeta);
    return jsonError('Не удалось скачать файл из хранилища. Попробуйте загрузить заново.', 500);
  }

  if (!fileBytes) {
    if (transcribeJobId) clearServerSideProgress(transcribeJobId);
    const err = new Error(`S3 object not found: ${s3Key}`);
    await trace?.fail(err, { stage: 'download_from_s3', s3Key });
    await logError('audio.transcribe.s3.missing', err, { stage: 'download_from_s3', s3Key }, logMeta);
    return jsonError('Файл не найден в хранилище. Загрузите заново.', 404);
  }

  if (fileBytes.byteLength > MAX_FILE_SIZE_BYTES) {
    if (transcribeJobId) clearServerSideProgress(transcribeJobId);
    const err = new Error(`File too large: ${fileBytes.byteLength} bytes`);
    await trace?.fail(err, { stage: 'validate_file' });
    await logError('audio.transcribe.validation.failed', err, { stage: 'validate_file' }, logMeta);
    // Убираем битый файл сразу — незачем ему в S3 залёживаться.
    void deleteMainS3Object(s3Key).catch(() => {});
    return jsonError('Файл превышает лимит 600 МБ.', 400);
  }

  try {
    await logInfo(
      'audio.transcribe.start',
      'Audio transcription started (S3 flow)',
      {
        filename,
        inputBytes: fileBytes.byteLength,
        extension: ext,
        s3Key,
      },
      logMeta,
    );
    if (transcribeJobId) {
      setServerSideProgress(transcribeJobId, 'converting', 3);
    }
    const mp3 = await extractOrConvertToMp3({
      bytes: fileBytes,
      inputExt: ext,
    });
    // Хэндофф воркеру — очищаем локальное pre-worker-состояние, чтобы UI сразу
    // начал видеть «настоящий» queued/converting/transcribing.
    if (transcribeJobId) clearServerSideProgress(transcribeJobId);
    await trace?.setOutput({
      filename,
      inputBytes: fileBytes.byteLength,
      mp3Bytes: mp3.byteLength,
    });
    const text = await transcribeAudio({
      audioMp3: mp3,
      filename,
      jobId: transcribeJobId,
    });

    void (async () => {
      try {
        await supabase.from('audio_transcripts').insert({
          user_id: user.id,
          filename,
          length: text.length,
          text,
        });
      } catch {
        // swallow; история не должна ломать основной поток
      }
    })();

    // Файл в S3 больше не нужен — расшифровка сохранена в БД. Fire-and-forget,
    // ошибка удаления не должна валить успешный ответ пользователю.
    void deleteMainS3Object(s3Key).catch((err) => {
      void logError(
        'audio.transcribe.s3.cleanup.failed',
        err,
        { s3Key },
        logMeta,
      );
    });

    await trace?.end(
      {
        filename,
        inputBytes: fileBytes.byteLength,
        mp3Bytes: mp3.byteLength,
        textLength: text.length,
      },
      'Расшифровка завершена',
    );
    await logInfo(
      'audio.transcribe.success',
      'Audio transcription completed',
      {
        filename,
        inputBytes: fileBytes.byteLength,
        mp3Bytes: mp3.byteLength,
        textLength: text.length,
      },
      logMeta,
    );

    return NextResponse.json({
      text,
      filename,
      length: text.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Неизвестная ошибка при расшифровке аудио';
    if (transcribeJobId) clearServerSideProgress(transcribeJobId);
    // При ошибке файл в S3 тоже удаляем — юзер увидит ошибку и перезагрузит,
    // а мусор в бакете копить незачем.
    void deleteMainS3Object(s3Key).catch(() => {});
    await trace?.fail(err, {
      stage: 'transcribe',
      filename,
      inputBytes: fileBytes.byteLength,
    });
    await logError(
      'audio.transcribe.failed',
      err,
      {
        stage: 'transcribe',
        filename,
        inputBytes: fileBytes.byteLength,
      },
      logMeta,
    );
    return jsonError(message, 500);
  }
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const { data, error } = await supabase
    .from('audio_transcripts')
    .select('id, created_at, filename, length, text')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    items: data ?? [],
  });
}
