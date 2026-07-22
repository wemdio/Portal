#!/usr/bin/env node
// Перенос файлов из Supabase Cloud Storage в self-hosted Storage API.
// Архивный migration helper: после cutover 22.07.2026 текущий production target
// находится на 139.60.162.12. Не запускайте повторно без отдельного плана миграции.
//
// Метаданные (storage.buckets, storage.objects) уже перенесены через pg_dump
// в migrate-from-supabase.sh — этот скрипт лишь копирует БИНАРНЫЕ файлы.
//
// Использование:
//   SOURCE_SUPABASE_URL=https://pwcidzaqudfkodgmesyk.supabase.co \
//   SOURCE_SERVICE_ROLE_KEY=eyJ... \
//   TARGET_SUPABASE_URL=http://<target-host>:35480 \
//   TARGET_SERVICE_ROLE_KEY=eyJ... \
//   node deploy/main-db/migrate-storage-files.mjs
//
// Опции:
//   --buckets=knowledge-base,avatars   — только эти бакеты (по умолчанию все)
//   --concurrency=8                    — параллельные загрузки (по умолчанию 4)
//   --skip-existing                    — пропускать файлы, которые уже есть в target
//   --dry-run                          — только посчитать, не переносить

import process from 'node:process';

const SOURCE_URL = (process.env.SOURCE_SUPABASE_URL || '').replace(/\/+$/, '');
const SOURCE_KEY = process.env.SOURCE_SERVICE_ROLE_KEY || '';
const TARGET_URL = (process.env.TARGET_SUPABASE_URL || '').replace(/\/+$/, '');
const TARGET_KEY = process.env.TARGET_SERVICE_ROLE_KEY || '';

if (!SOURCE_URL || !SOURCE_KEY || !TARGET_URL || !TARGET_KEY) {
  console.error('FATAL: задай SOURCE_SUPABASE_URL, SOURCE_SERVICE_ROLE_KEY, TARGET_SUPABASE_URL, TARGET_SERVICE_ROLE_KEY');
  process.exit(1);
}

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? 'true');
}

const ONLY_BUCKETS = (args.get('buckets') || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number.parseInt(args.get('concurrency') || '4', 10));
const SKIP_EXISTING = args.get('skip-existing') === 'true';
const DRY_RUN = args.get('dry-run') === 'true';

async function api(base, key, path, init = {}) {
  const url = `${base}/storage/v1${path}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    apikey: key,
    ...(init.headers || {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok && resp.status !== 404) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${url} -> ${resp.status} ${body.slice(0, 200)}`);
  }
  return resp;
}

async function listBuckets(base, key) {
  const r = await api(base, key, '/bucket');
  return r.json();
}

async function listObjects(base, key, bucket, prefix = '', acc = []) {
  // storage api: POST /object/list/<bucket> { prefix, limit, offset }
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const resp = await api(base, key, `/object/list/${bucket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      // metadata.mimetype === null часто означает «папка» (фолдер) — рекурсивно
      if (item.id === null || item.metadata === null) {
        await listObjects(base, key, bucket, fullPath, acc);
      } else {
        acc.push({ bucket, path: fullPath, size: item.metadata?.size ?? 0, mimetype: item.metadata?.mimetype });
      }
    }
    if (items.length < PAGE) break;
    offset += PAGE;
  }
  return acc;
}

async function downloadObject(bucket, path) {
  const r = await api(SOURCE_URL, SOURCE_KEY, `/object/${bucket}/${encodeURI(path)}`);
  if (r.status === 404) return null;
  const blob = await r.arrayBuffer();
  return Buffer.from(blob);
}

async function targetHas(bucket, path) {
  const r = await api(TARGET_URL, TARGET_KEY, `/object/info/authenticated/${bucket}/${encodeURI(path)}`);
  return r.status === 200;
}

async function uploadObject(bucket, path, body, mimetype) {
  // PUT /object/<bucket>/<path>; x-upsert=true чтобы не падать если уже есть
  const r = await fetch(`${TARGET_URL}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TARGET_KEY}`,
      apikey: TARGET_KEY,
      'Content-Type': mimetype || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`upload ${bucket}/${path} -> ${r.status} ${text.slice(0, 200)}`);
  }
}

async function ensureBucketExists(name, sourceBucket) {
  // GET /bucket/<name> 404 -> POST /bucket
  const r = await api(TARGET_URL, TARGET_KEY, `/bucket/${name}`);
  if (r.status === 200) return;
  await fetch(`${TARGET_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TARGET_KEY}`,
      apikey: TARGET_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: name,
      name,
      public: !!sourceBucket?.public,
      file_size_limit: sourceBucket?.file_size_limit ?? null,
      allowed_mime_types: sourceBucket?.allowed_mime_types ?? null,
    }),
  });
  console.log(`  [+] bucket created: ${name} (public=${!!sourceBucket?.public})`);
}

async function processInBatches(items, n, fn) {
  let cursor = 0;
  let done = 0;
  let failed = 0;
  const total = items.length;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await fn(items[i]);
        done++;
      } catch (err) {
        failed++;
        console.error(`  [x] ${items[i].bucket}/${items[i].path}: ${err.message}`);
      }
      if ((done + failed) % 10 === 0) {
        process.stdout.write(`\r  progress: ${done + failed}/${total} (ok=${done}, fail=${failed})`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');
  return { done, failed };
}

async function main() {
  console.log(`Source: ${SOURCE_URL}`);
  console.log(`Target: ${TARGET_URL}`);
  console.log('');

  const sourceBuckets = await listBuckets(SOURCE_URL, SOURCE_KEY);
  const buckets = ONLY_BUCKETS.length > 0
    ? sourceBuckets.filter((b) => ONLY_BUCKETS.includes(b.name))
    : sourceBuckets;

  console.log(`Найдено бакетов: ${buckets.length}`);
  for (const b of buckets) console.log(`  - ${b.name} (public=${b.public})`);
  console.log('');

  for (const bucket of buckets) {
    console.log(`══ ${bucket.name} ══`);
    if (!DRY_RUN) await ensureBucketExists(bucket.name, bucket);

    const objects = await listObjects(SOURCE_URL, SOURCE_KEY, bucket.name);
    console.log(`  объектов: ${objects.length} (общий размер: ${(objects.reduce((s, o) => s + (o.size || 0), 0) / 1024 / 1024).toFixed(1)} МБ)`);

    if (DRY_RUN) continue;

    const { done, failed } = await processInBatches(objects, CONCURRENCY, async (obj) => {
      if (SKIP_EXISTING && (await targetHas(obj.bucket, obj.path))) return;
      const body = await downloadObject(obj.bucket, obj.path);
      if (!body) throw new Error('not found in source');
      await uploadObject(obj.bucket, obj.path, body, obj.mimetype);
    });
    console.log(`  итого: ok=${done}, fail=${failed}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
