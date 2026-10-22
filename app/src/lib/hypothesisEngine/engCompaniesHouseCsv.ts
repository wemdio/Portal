import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { HE_ENG_REGISTRY_CATEGORIES, validateHeEngRegistryTask } from './engPublicRegistryPlan';
import { mapHeEngCompaniesHouseRecord } from './engPublicRegistries';
import { HeEngCompaniesHouseCsvError, parseHeEngCompaniesHouseCsv, type HeEngCompaniesHouseCsvRow } from './engCompaniesHouseCsvParser';
import { HeEngRegistryRetryError } from './engRegistryRetry';
import type { HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';

// Public monthly files only; never accept a URL from a company or a collection plan.
const ORIGIN = 'https://download.companieshouse.gov.uk';
const LISTING = `${ORIGIN}/en_output.html`;
const MAX_ZIP = 128 * 1024 * 1024;
const MAX_CSV = 768 * 1024 * 1024;
const MAX_INDEX = 128 * 1024 * 1024;
const MAX_CACHE = 2 * 1024 * 1024 * 1024;
const MAX_PARTS = 24;
const PART_TIME_MS = 4 * 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const SIC = HE_ENG_REGISTRY_CATEGORIES.companies_house;
const PAGE_SIZE = 25;
// Bump parserVersion when normalization/filter/order changes: offsets must not
// silently point into rebuilt data produced by a different parser.
export interface HeEngCompaniesHouseSnapshot {
  version: 1;
  parserVersion: 1;
  date: string;
  parts: Array<{ file: string; size: number; etag: string }>;
  fingerprint: string;
}
interface Options {
  signal?: AbortSignal;
  onActivity?: () => void;
  /** Local verification seams; production calls never pass these. */
  fetch?: typeof fetch;
  cacheDir?: string;
  now?: () => number;
}
interface PartIndex {
  version: 1; snapshot: string; file: string; archiveSha256: string; csvSha256: string;
  counts: Record<string, number>; bytes: Record<string, number>; hashes: Record<string, string>;
  checksum: string;
}
// unzipper is an existing dependency; it reads the central directory from disk.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as { Open: { file(file: string): Promise<{ files: Array<{
  path: string; type: string; compressedSize: number; uncompressedSize: number;
  crc32: number; flags: number; compressionMethod: number; stream(): Readable;
}> }> } };

function fail(code: string): never { throw new Error(`registry_csv_${code}`); }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function snapshotHash(value: HeEngCompaniesHouseSnapshot): string {
  return sha(JSON.stringify([value.version, value.parserVersion, value.date, value.parts.map(p => [p.file, p.size, p.etag])]));
}
function indexHash(value: PartIndex): string {
  return sha(JSON.stringify([value.version, value.snapshot, value.file, value.archiveSha256, value.csvSha256,
    SIC.map(sic => [sic, value.counts[sic], value.bytes[sic], value.hashes[sic]])]));
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function root(options: Options): string {
  return options.cacheDir ?? process.env.HE_ENG_CH_CACHE_DIR ??
    (process.env.NODE_ENV === 'production' ? '/var/lib/portal-eng-companies-house' : path.join(tmpdir(), 'portal-eng-companies-house'));
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^20\d{2}-\d{2}-01$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateHeEngCompaniesHouseSnapshot(value: HeEngCompaniesHouseSnapshot): void {
  if (!value || value.version !== 1 || value.parserVersion !== 1 || !validDate(value.date) ||
      !Array.isArray(value.parts) || !integer(value.parts.length, 1, MAX_PARTS)) fail('invalid_snapshot');
  for (const [i, part] of value.parts.entries()) {
    if (!part || part.file !== `BasicCompanyData-${value.date}-part${i + 1}_${value.parts.length}.zip` ||
        !integer(part.size, 100, MAX_ZIP) || typeof part.etag !== 'string' || !/^"[a-zA-Z0-9-]{1,120}"$/.test(part.etag)) fail('invalid_snapshot');
  }
  if (value.fingerprint !== snapshotHash(value)) fail('snapshot_fingerprint');
}
async function jsonFile<T>(file: string): Promise<T | null> {
  try {
    if ((await stat(file)).size > 64 * 1024) fail('cache_metadata_size');
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
async function request(url: string, options: Options, init: RequestInit = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: options.signal,
      headers: { 'User-Agent': 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)', ...init.headers } });
  } catch (error) { options.signal?.throwIfAborted(); throw new Error('registry_network_error', { cause: error }); }
  if (!response.ok) {
    const delay = response.headers.get('retry-after');
    await response.body?.cancel();
    const error = new Error(`registry_http_${response.status}`) as Error & { retryAfterMs?: number };
    const ms = delay && /^\d+$/.test(delay) ? Number(delay) * 1000 : delay && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(delay) ? Date.parse(delay) - Date.now() : 0;
    if (ms > 86_400_000) fail('retry_after_too_long');
    if (ms > 0 && Number.isFinite(ms)) error.retryAfterMs = ms;
    throw error;
  }
  return response;
}
async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) fail('empty_response');
  let bytes = 0; const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > limit) fail('response_size'); chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function timed<T>(options: Options, milliseconds: number, operation: (bounded: Options) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const onAbort = () => abort.abort(options.signal?.reason);
  options.signal?.throwIfAborted(); options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new Error('registry_timeout')), milliseconds);
  try { return await operation({ ...options, signal: abort.signal }); }
  catch (error) { options.signal?.throwIfAborted(); if (abort.signal.aborted) throw new Error('registry_timeout'); throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

/** Select and fingerprint a complete official monthly set before any archive or paid lookup. */
export async function getHeEngCompaniesHouseSnapshot(options: Options = {}): Promise<HeEngCompaniesHouseSnapshot> {
  options.signal?.throwIfAborted();
  const directory = root(options); await mkdir(directory, { recursive: true, mode: 0o700 });
  const latestFile = path.join(directory, 'latest.json');
  const cached = await jsonFile<{ checkedAt: number; snapshot: HeEngCompaniesHouseSnapshot }>(latestFile);
  const now = (options.now ?? Date.now)();
  if (cached) {
    validateHeEngCompaniesHouseSnapshot(cached.snapshot);
    if (integer(cached.checkedAt, 0, now) && now - cached.checkedAt < 24 * 3600_000 && now - Date.parse(cached.snapshot.date) < 62 * 86_400_000) return cached.snapshot;
  }
  return timed(options, 60_000, async bounded => {
    const html = await boundedText(await request(LISTING, bounded), 512 * 1024);
    const sets = new Map<string, Map<number, string>>(); const totals = new Map<string, number>();
    for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      let url: URL; try { url = new URL(match[1], LISTING); } catch { continue; }
      if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) continue;
      const item = /^\/BasicCompanyData-(20\d{2}-\d{2}-01)-part(\d+)_(\d+)\.zip$/.exec(url.pathname);
      if (!item || !validDate(item[1])) continue;
      const index = Number(item[2]), total = Number(item[3]);
      if (!integer(total, 1, MAX_PARTS) || !integer(index, 1, total)) continue;
      if (totals.has(item[1]) && totals.get(item[1]) !== total) fail('ambiguous_listing');
      totals.set(item[1], total); const files = sets.get(item[1]) ?? new Map<number, string>();
      files.set(index, url.pathname.slice(1)); sets.set(item[1], files);
    }
    const date = [...sets.keys()].sort().reverse().find(d => sets.get(d)!.size === totals.get(d));
    if (!date || Date.parse(date) > now || now - Date.parse(date) > 62 * 86_400_000) fail('stale_or_missing_snapshot');
    const snapshot: HeEngCompaniesHouseSnapshot = { version: 1, parserVersion: 1, date, parts: [], fingerprint: '' };
    for (const [, file] of [...sets.get(date)!].sort((a, b) => a[0] - b[0])) {
      const response = await request(`${ORIGIN}/${file}`, bounded, { method: 'HEAD' });
      snapshot.parts.push({ file, size: Number(response.headers.get('content-length')), etag: response.headers.get('etag') ?? '' });
      bounded.onActivity?.();
    }
    snapshot.fingerprint = snapshotHash(snapshot); validateHeEngCompaniesHouseSnapshot(snapshot);
    await atomicJson(latestFile, { checkedAt: now, snapshot }); return snapshot;
  });
}

async function cacheSize(directory: string, depth = 0): Promise<number> {
  if (depth > 3) fail('cache_layout');
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('cache_symlink');
    bytes += entry.isDirectory() ? await cacheSize(file, depth + 1) : (await stat(file)).size;
  }
  return bytes;
}
const buildingCaches = new Set<string>();
async function leaseAge(lock: string): Promise<number> {
  try { return Date.now() - (await stat(lock)).mtimeMs; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HeEngRegistryRetryError(30_000);
    throw error;
  }
}
/** One cache builder across concurrent ENG bases. Lease is not a collection cursor. */
async function acquire(directory: string): Promise<() => Promise<void>> {
  if (buildingCaches.has(directory)) throw new HeEngRegistryRetryError(30_000);
  buildingCaches.add(directory);
  const lock = path.join(directory, 'import.lock'); const token = randomUUID();
  try {
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await leaseAge(lock) <= LOCK_STALE_MS) throw new HeEngRegistryRetryError(30_000);
      // Serialize stale recovery, then RECHECK the lease. Without this mutex a
      // second reaper could rename the fresh replacement of the first one.
      const recovery = path.join(directory, 'recovery.lock');
      try { await mkdir(recovery); }
      catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code !== 'EEXIST') throw recoveryError;
        if (await leaseAge(recovery) > LOCK_STALE_MS) fail('cache_recovery_required');
        throw new HeEngRegistryRetryError(30_000);
      }
      try {
        const previous = await stat(lock).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (previous && Date.now() - previous.mtimeMs <= LOCK_STALE_MS) throw new HeEngRegistryRetryError(30_000);
        if (previous) {
          await rename(lock, `${lock}.stale-${token}`);
          await rm(`${lock}.stale-${token}`, { recursive: true, force: true });
        }
        try { await mkdir(lock); } catch { throw new HeEngRegistryRetryError(30_000); }
      } finally { await rm(recovery, { recursive: true, force: true }); }
    }
    await writeFile(path.join(lock, 'owner'), token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    buildingCaches.delete(directory); throw error;
  }
  const heartbeat = setInterval(() => {
    void readFile(path.join(lock, 'owner'), 'utf8').then(owner => {
      if (owner === token) return utimes(lock, new Date(), new Date());
    }).catch(() => undefined);
  }, 15_000);
  const release = async () => { clearInterval(heartbeat);
    try { if (await readFile(path.join(lock, 'owner'), 'utf8').catch(() => '') === token) await rm(lock, { recursive: true, force: true }); }
    finally { buildingCaches.delete(directory); }
  };
  Object.assign(release, { verify: async () => {
    if (await readFile(path.join(lock, 'owner'), 'utf8').catch(() => '') !== token) fail('lease_lost');
  } });
  return release;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crcUpdate(crc: number, chunk: Uint8Array): number {
  for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc;
}
async function download(file: string, part: HeEngCompaniesHouseSnapshot['parts'][number], options: Options): Promise<string> {
  const response = await request(`${ORIGIN}/${part.file}`, options, { headers: { 'If-Match': part.etag, 'Accept-Encoding': 'identity' } });
  if (response.status !== 200 || response.headers.get('etag') !== part.etag ||
      Number(response.headers.get('content-length')) !== part.size ||
      !['identity', null].includes(response.headers.get('content-encoding'))) {
    await response.body?.cancel(); fail('snapshot_changed');
  }
  if (!response.body) fail('empty_archive');
  const handle = await open(file, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) { options.signal?.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > part.size || bytes > MAX_ZIP) fail('archive_size');
      hash.update(value); await handle.writeFile(value); options.onActivity?.();
    }
    if (bytes !== part.size) fail('archive_truncated');
    return hash.digest('hex');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await handle.close(); }
}
/** Reject ZIP64/multi-disk/oversized directories before unzipper allocates entries. */
async function inspectZipDirectory(file: string, size: number): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const length = Math.min(size, 65_557); const tail = Buffer.alloc(length);
    const { bytesRead } = await handle.read(tail, 0, length, size - length);
    if (bytesRead !== length) fail('archive_truncated');
    let end = -1;
    for (let i = length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === length) { end = i; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0 ||
        tail.readUInt16LE(end + 8) !== 1 || tail.readUInt16LE(end + 10) !== 1) fail('archive_directory');
    const centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
    if (!integer(centralSize, 46, 4096) || centralOffset + centralSize !== size - length + end) fail('archive_directory');
    const central = Buffer.alloc(centralSize);
    if ((await handle.read(central, 0, centralSize, centralOffset)).bytesRead !== centralSize ||
        central.readUInt32LE(0) !== 0x02014b50 || central.readUInt16LE(6) > 20 ||
        central.readUInt16LE(34) !== 0 || 46 + central.readUInt16LE(28) + central.readUInt16LE(30) + central.readUInt16LE(32) !== centralSize ||
        central.readUInt32LE(20) === 0xffffffff || central.readUInt32LE(24) === 0xffffffff ||
        central.readUInt32LE(42) === 0xffffffff) fail('archive_directory');
  } finally { await handle.close(); }
}
async function readPart(directory: string, snapshot: HeEngCompaniesHouseSnapshot, part: number): Promise<PartIndex | null> {
  const metadata = await jsonFile<PartIndex>(path.join(directory, snapshot.fingerprint, `part-${part + 1}`, 'index.json'));
  if (!metadata) return null;
  if (metadata.version !== 1 || metadata.snapshot !== snapshot.fingerprint || metadata.file !== snapshot.parts[part].file ||
      !/^[a-f0-9]{64}$/.test(metadata.archiveSha256) || !/^[a-f0-9]{64}$/.test(metadata.csvSha256) ||
      !metadata.counts || !metadata.bytes || !metadata.hashes || SIC.some(sic => !integer(metadata.counts[sic], 0, 1_500_000) ||
        !integer(metadata.bytes[sic], 0, MAX_INDEX) || !/^[a-f0-9]{64}$/.test(metadata.hashes[sic]))) fail('cache_metadata');
  // Skipped parts still influence offsets: protect counts even when their data
  // file is not read for this page, otherwise corruption silently shifts rows.
  if (metadata.checksum !== indexHash(metadata)) fail('cache_metadata');
  return metadata;
}
async function importPart(directory: string, snapshot: HeEngCompaniesHouseSnapshot, part: number, options: Options): Promise<void> {
  const release = await acquire(directory) as (() => Promise<void>) & { verify(): Promise<void> };
  let staging = '';
  try {
    if (await readPart(directory, snapshot, part)) return;
    // Incomplete output is never served. Remove leftovers only under our lease.
    for (const entry of await readdir(directory)) if (/^staging-[a-f0-9-]+$/.test(entry)) await rm(path.join(directory, entry), { recursive: true, force: true });
    const used = await cacheSize(directory);
    const filesystem = await statfs(directory);
    if (used + MAX_ZIP + MAX_INDEX > MAX_CACHE || filesystem.bavail * filesystem.bsize < MAX_ZIP + MAX_INDEX) fail('cache_full');
    staging = path.join(directory, `staging-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
    let lastActivity = 0;
    const onActivity = () => { const now = Date.now(); if (now - lastActivity >= 1000) { lastActivity = now; options.onActivity?.(); } };
    await timed({ ...options, onActivity }, PART_TIME_MS, async bounded => {
      const spec = snapshot.parts[part]; const archive = path.join(staging, 'source.zip');
      const archiveSha256 = await download(archive, spec, bounded);
      await inspectZipDirectory(archive, spec.size);
      const zip = await unzipper.Open.file(archive);
      if (zip.files.length !== 1) fail('archive_entries');
      const entry = zip.files[0];
      if (entry.path !== spec.file.replace(/\.zip$/, '.csv') || entry.type !== 'File' || entry.compressionMethod !== 8 ||
          (entry.flags & 1) !== 0 || !integer(entry.uncompressedSize, 1, MAX_CSV) ||
          !integer(entry.compressedSize, 1, spec.size) || !integer(entry.crc32, 0, 0xffffffff)) fail('archive_entry');
      const counts: Record<string, number> = {}, bytes: Record<string, number> = {}, buffers: Record<string, string> = {};
      const hashes = new Map(SIC.map(sic => [sic, createHash('sha256')]));
      for (const sic of SIC) { counts[sic] = 0; bytes[sic] = 0; buffers[sic] = ''; }
      const flush = async (sic: string) => {
        if (!buffers[sic]) return;
        await appendFile(path.join(staging, `${sic}.ndjson`), buffers[sic], { mode: 0o600 }); buffers[sic] = '';
      };
      const stream = entry.stream(); let csvBytes = 0, crc = -1, indexedBytes = 0, records = 0;
      const csvHash = createHash('sha256');
      const abort = () => stream.destroy(new Error('registry_csv_aborted'));
      bounded.signal?.addEventListener('abort', abort, { once: true });
      async function* checkedBytes() {
        for await (const raw of stream) {
          bounded.signal?.throwIfAborted(); const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          csvBytes += chunk.length; if (csvBytes > entry.uncompressedSize || csvBytes > MAX_CSV) fail('csv_size');
          crc = crcUpdate(crc, chunk); csvHash.update(chunk); bounded.onActivity?.(); yield chunk;
        }
      }
      try {
        for await (const row of parseHeEngCompaniesHouseCsv(checkedBytes(), bounded)) {
          if (++records > 1_500_000) fail('row_limit');
          const categories = [...new Set(row.sic_codes)].filter(sic => SIC.includes(sic));
          if (!categories.length) continue;
          const line = `${JSON.stringify(row)}\n`; const length = Buffer.byteLength(line);
          for (const sic of categories) {
            counts[sic]++; bytes[sic] += length; indexedBytes += length;
            if (indexedBytes > MAX_INDEX || used + spec.size + indexedBytes > MAX_CACHE) fail('index_size');
            hashes.get(sic)!.update(line); buffers[sic] += line;
            if (Buffer.byteLength(buffers[sic]) >= 64 * 1024) await flush(sic);
          }
          if (records % 2048 === 0) await yieldLoop();
        }
        if (csvBytes !== entry.uncompressedSize || ((crc ^ -1) >>> 0) !== entry.crc32) fail('csv_checksum');
        for (const sic of SIC) { await flush(sic); if (bytes[sic] === 0) await writeFile(path.join(staging, `${sic}.ndjson`), '', { mode: 0o600 }); }
      } catch (error) {
        if (error instanceof HeEngCompaniesHouseCsvError) fail(`parse_${error.reason}`);
        throw error;
      } finally { bounded.signal?.removeEventListener('abort', abort); stream.destroy(); }
      const index: PartIndex = { version: 1, snapshot: snapshot.fingerprint, file: spec.file, archiveSha256,
        csvSha256: csvHash.digest('hex'), counts, bytes, hashes: Object.fromEntries([...hashes].map(([sic, hash]) => [sic, hash.digest('hex')])), checksum: '' };
      index.checksum = indexHash(index);
      await rm(archive); await writeFile(path.join(staging, 'index.json'), JSON.stringify(index), { mode: 0o600 });
      bounded.signal?.throwIfAborted(); await release.verify();
      const destination = path.join(directory, snapshot.fingerprint); await mkdir(destination, { recursive: true, mode: 0o700 });
      await rename(staging, path.join(destination, `part-${part + 1}`)); staging = '';
    });
  } finally { if (staging) await rm(staging, { recursive: true, force: true }); await release(); }
}
async function indexRows(file: string, index: PartIndex, sic: string, skip: number, count: number, options: Options): Promise<HeEngCompaniesHouseCsvRow[]> {
  if ((await stat(file)).size !== index.bytes[sic]) fail('index_corrupt');
  const hash = createHash('sha256'); let tail = '', rowNumber = 0; const rows: HeEngCompaniesHouseCsvRow[] = [];
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    options.signal?.throwIfAborted(); hash.update(chunk); tail += chunk;
    let end: number;
    while ((end = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, end); tail = tail.slice(end + 1);
      if (line.length > 128 * 1024) fail('index_corrupt');
      if (rowNumber >= skip && rows.length < count) {
        try { rows.push(JSON.parse(line) as HeEngCompaniesHouseCsvRow); }
        catch { fail('index_corrupt'); }
      }
      rowNumber++;
    }
    if (tail.length > 128 * 1024) fail('index_corrupt'); options.onActivity?.();
  }
  if (tail || rowNumber !== index.counts[sic] || hash.digest('hex') !== index.hashes[sic]) fail('index_corrupt');
  return rows;
}

/** Immutable per-part/SIC indexes. A short page is terminal only after ALL parts. */
export async function readHeEngCompaniesHouseCsvPage(task: HeEngRegistryTask, position: number,
  snapshot: HeEngCompaniesHouseSnapshot, options: Options = {}): Promise<HeEngRegistryPage> {
  options.signal?.throwIfAborted();
  validateHeEngRegistryTask(task); validateHeEngCompaniesHouseSnapshot(snapshot);
  if (task.provider !== 'companies_house' || task.transport !== 'csv' || !integer(position, 0, 20_000) || position % PAGE_SIZE) fail('position');
  const directory = root(options); await mkdir(directory, { recursive: true, mode: 0o700 });
  const rows: HeEngCompaniesHouseCsvRow[] = []; let remaining = position; let more = false;
  for (let part = 0; part < snapshot.parts.length; part++) {
    const index = await readPart(directory, snapshot, part);
    if (!index) {
      if (rows.length === PAGE_SIZE) { more = true; break; }
      await importPart(directory, snapshot, part, options);
      // One free archive per invocation; source cursor and paid resolver stay untouched.
      throw new HeEngRegistryRetryError(1000);
    }
    const length = index.counts[task.category];
    if (remaining >= length) { remaining -= length; continue; }
    if (rows.length === PAGE_SIZE) { more = true; break; }
    const take = Math.min(PAGE_SIZE - rows.length, length - remaining);
    rows.push(...await indexRows(path.join(directory, snapshot.fingerprint, `part-${part + 1}`, `${task.category}.ndjson`),
      index, task.category, remaining, take, options));
    more = remaining + take < length; remaining = 0;
    if (more) break;
  }
  const candidates: HeEngRegistryPage['candidates'] = []; const excluded: Record<string, number> = {};
  for (const row of rows) {
    const candidate = mapHeEngCompaniesHouseRecord(row as unknown as Record<string, unknown>, task, excluded);
    if (candidate) candidates.push(candidate);
  }
  return { candidates, recordsRead: rows.length, excluded, nextPosition: position + PAGE_SIZE, exhausted: !more };
}
