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

const bucket = requireEnv('S3_BUCKET');
const region = process.env.S3_REGION ?? 'us-east-1';
const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');
const endpoint = process.env.S3_ENDPOINT;
const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;

function tryDeriveSupabasePublicBaseUrl(): string | null {
  if (!endpoint) return null;
  const m = endpoint.match(/^https?:\/\/([^/]+)\/storage\/v1\/s3\/?$/i);
  if (!m) return null;
  const host = m[1];
  const publicHost = host.replace(/\.storage\.supabase\.co$/i, '.supabase.co');
  return `https://${publicHost}/storage/v1/object/public/${encodeURIComponent(bucket)}`;
}

const s3 = new S3Client({
  region,
  credentials: { accessKeyId, secretAccessKey },
  endpoint: endpoint || undefined,
  forcePathStyle: Boolean(endpoint),
});

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function encodePath(value: string): string {
  // Encode each path segment but keep slashes.
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function getPublicObjectUrl(key: string): string {
  if (publicBaseUrl) {
    return `${normalizeBaseUrl(publicBaseUrl)}/${encodePath(key)}`;
  }

  const supabaseBase = tryDeriveSupabasePublicBaseUrl();
  if (supabaseBase) {
    return `${supabaseBase}/${encodePath(key)}`;
  }

  // Default AWS-style URL.
  if (!endpoint) {
    return `https://${encodeURIComponent(bucket)}.s3.${region}.amazonaws.com/${encodePath(key)}`;
  }

  // Generic S3-compatible endpoint fallback (path-style).
  return `${normalizeBaseUrl(endpoint)}/${encodeURIComponent(bucket)}/${encodePath(key)}`;
}

export async function createAvatarUploadUrl(params: {
  userId: string;
  contentType: string;
  ext: string;
}): Promise<PresignedAvatarUpload> {
  const safeExt = params.ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const timestamp = Date.now();
  // Store avatars under a fixed prefix ("folder") in the bucket.
  // In S3 this is just a key prefix; no separate folder creation is required.
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

export async function createAvatarReadUrl(params: { key: string }): Promise<PresignedAvatarRead> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: params.key,
  });
  const readUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 10 });
  return { readUrl, key: params.key };
}

