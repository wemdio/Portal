import 'server-only';

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export type PresignedAvatarUpload = {
  uploadUrl: string;
  publicUrl: string;
  key: string;
};

export type PresignedAvatarRead = {
  readUrl: string;
  key: string;
};

let _s3: S3Client | null = null;
let _bucket: string | null = null;
let _region: string | null = null;
let _endpoint: string | undefined;
let _publicBaseUrl: string | undefined;

function getConfig() {
  if (!_bucket) {
    _bucket = requireEnv('S3_BUCKET');
    _region = process.env.S3_REGION ?? 'us-east-1';
    _endpoint = process.env.S3_ENDPOINT;
    _publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;

    const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
    const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');

    _s3 = new S3Client({
      region: _region,
      credentials: { accessKeyId, secretAccessKey },
      endpoint: _endpoint || undefined,
      forcePathStyle: Boolean(_endpoint),
    });
  }
  return { s3: _s3!, bucket: _bucket, region: _region!, endpoint: _endpoint, publicBaseUrl: _publicBaseUrl };
}

function tryDeriveSupabasePublicBaseUrl(endpoint: string | undefined, bucket: string): string | null {
  if (!endpoint) return null;
  const m = endpoint.match(/^https?:\/\/([^/]+)\/storage\/v1\/s3\/?$/i);
  if (!m) return null;
  const host = m[1];
  const publicHost = host.replace(/\.storage\.supabase\.co$/i, '.supabase.co');
  return `https://${publicHost}/storage/v1/object/public/${encodeURIComponent(bucket)}`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function getPublicObjectUrl(key: string): string {
  const { bucket, region, endpoint, publicBaseUrl } = getConfig();

  if (publicBaseUrl) {
    return `${normalizeBaseUrl(publicBaseUrl)}/${encodePath(key)}`;
  }

  const supabaseBase = tryDeriveSupabasePublicBaseUrl(endpoint, bucket);
  if (supabaseBase) {
    return `${supabaseBase}/${encodePath(key)}`;
  }

  if (!endpoint) {
    return `https://${encodeURIComponent(bucket)}.s3.${region}.amazonaws.com/${encodePath(key)}`;
  }

  return `${normalizeBaseUrl(endpoint)}/${encodeURIComponent(bucket)}/${encodePath(key)}`;
}

export async function createAvatarUploadUrl(params: {
  userId: string;
  contentType: string;
  ext: string;
}): Promise<PresignedAvatarUpload> {
  const { s3, bucket } = getConfig();
  const safeExt = params.ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const timestamp = Date.now();
  const key = `avatars/${params.userId}/avatar-${timestamp}.${safeExt}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: params.contentType,
    CacheControl: 'public, max-age=3600',
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 });
  const publicUrl = getPublicObjectUrl(key);

  return { uploadUrl, publicUrl, key };
}

export type PresignedTaskImageUpload = {
  uploadUrl: string;
  publicUrl: string;
  key: string;
};

export async function createTaskImageUploadUrl(params: {
  contentType: string;
  ext: string;
}): Promise<PresignedTaskImageUpload> {
  const { s3, bucket } = getConfig();
  const safeExt = params.ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const key = `task-images/${crypto.randomUUID()}.${safeExt}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: params.contentType,
    CacheControl: 'public, max-age=31536000',
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 });
  const publicUrl = getPublicObjectUrl(key);

  return { uploadUrl, publicUrl, key };
}

export async function createAvatarReadUrl(params: { key: string }): Promise<PresignedAvatarRead> {
  const { s3, bucket } = getConfig();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: params.key,
  });
  const readUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 });
  return { readUrl, key: params.key };
}
