#!/usr/bin/env node
// Генерирует JWT_SECRET и подписывает им anon + service_role токены
// в формате, совместимом с Supabase (и нашим self-hosted GoTrue/PostgREST/Storage).
//
// Использование:
//   node scripts/generate-keys.mjs                  # новые ключи (выкинут всех юзеров)
//   node scripts/generate-keys.mjs --secret=<jwt>   # использовать существующий JWT_SECRET
//                                                  # из старого Supabase Cloud (сохраняет
//                                                  # существующие сессии после cutover)

import crypto from 'node:crypto';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? 'true');
}

const JWT_SECRET = args.get('secret') || crypto.randomBytes(32).toString('base64url');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

const issuedAt = Math.floor(Date.now() / 1000);
// Долгоиграющие ключи (10 лет). Это стандарт для service_role/anon в Supabase.
const expiresAt = issuedAt + 60 * 60 * 24 * 365 * 10;

const anonPayload = {
  role: 'anon',
  iss: 'supabase',
  iat: issuedAt,
  exp: expiresAt,
};

const servicePayload = {
  role: 'service_role',
  iss: 'supabase',
  iat: issuedAt,
  exp: expiresAt,
};

const ANON_KEY = signJwt(anonPayload, JWT_SECRET);
const SERVICE_ROLE_KEY = signJwt(servicePayload, JWT_SECRET);

const REALTIME_DB_ENC_KEY = crypto.randomBytes(16).toString('base64url').slice(0, 16);
const REALTIME_SECRET_KEY_BASE = crypto.randomBytes(48).toString('base64url');

console.log('# ─── Скопируй в deploy/main-db/.env на DB-сервере ───');
console.log(`MAIN_JWT_SECRET=${JWT_SECRET}`);
console.log(`MAIN_ANON_KEY=${ANON_KEY}`);
console.log(`MAIN_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`);
console.log(`MAIN_REALTIME_DB_ENC_KEY=${REALTIME_DB_ENC_KEY}`);
console.log(`MAIN_REALTIME_SECRET_KEY_BASE=${REALTIME_SECRET_KEY_BASE}`);
console.log('');
console.log('# ─── На Portal-сервере (/home/Portal/prod/.env) ────');
console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}`);
console.log(`SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`);
