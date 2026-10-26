import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import { inflateHeEngDeflate64 } from './engRegistryInflate64';
import { HeEngRegistryRetryError } from './engRegistryRetry';

/**
 * Whole-file national registers (Czech statistical register, Estonian open
 * data): one public file per source, kept on local disk and read as a stream.
 * Not on the Companies House volume: its importer counts every file there
 * against its 2 GB budget. A new container downloads the files again.
 */
const USER_AGENT = 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)';
// A download older than this is left over from a process that stopped mid-file.
const STALE_PART_MS = 60 * 60_000;

export function heEngRegistryCacheFile(name: string): string {
  return path.join(process.env.HE_ENG_REGISTRY_CACHE_DIR ?? path.join(tmpdir(), 'portal-eng-registries'), name);
}

/** A file whose contents failed the reader's checks: the next read downloads it again instead of reusing it for a week. */
export async function discardHeEngRegistryBulkFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

/**
 * A copy of a parsed value that does not keep the file text alive: V8 keeps a
 * substring of 13+ characters as a view of the whole chunk it came from, so an
 * index of such values would hold most of the file in memory.
 */
export function ownHeEngRegistryText(value: string): string {
  return value.length < 13 ? value : Buffer.from(value, 'utf8').toString('utf8');
}

/**
 * A fixed public URL chosen by our code, on disk. A copy younger than
 * maxAgeMs is reused; otherwise the file is downloaded whole under a temporary
 * name and renamed, so a reader never sees half a file. No redirects, a size
 * and a time limit, and the registry_* error codes of the registry pages.
 */
export async function readHeEngRegistryBulkFile(url: string, file: string, options: {
  maxBytes: number; maxAgeMs: number; timeoutMs: number; signal?: AbortSignal; fetch?: typeof fetch; now?: () => number;
}): Promise<string> {
  const now = (options.now ?? Date.now)();
  try {
    const info = await stat(file);
    if (info.size > 0 && now - info.mtimeMs < options.maxAgeMs) return file;
  } catch { /* Not downloaded yet. */ }
  const fail = (code: string): never => { throw new Error(code); };
  if (options.signal?.aborted) fail('registry_aborted');
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.startsWith(`${path.basename(file)}.`) || !name.endsWith('.part')) continue;
    const leftover = path.join(directory, name);
    const age = await stat(leftover).then(info => now - info.mtimeMs, () => 0);
    if (age > STALE_PART_MS) await rm(leftover, { force: true });
  }
  const part = `${file}.${randomUUID()}.part`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let closed = false;
  try {
    handle = await open(part, 'w');
    const response = await (options.fetch ?? fetch)(url, { redirect: 'error', signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) fail(`registry_http_${response.status}`);
    if (!response.body) fail('registry_invalid_response');
    const reader = response.body!.getReader();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) { await reader.cancel(); fail('registry_response_too_large'); }
        await handle!.write(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) fail('registry_invalid_response');
    closed = true;
    await handle!.close();
    await rename(part, file);
    return file;
  } catch (error) {
    if (handle && !closed) await handle.close().catch(() => undefined);
    await rm(part, { force: true });
    if (options.signal?.aborted) return fail('registry_aborted');
    if (controller.signal.aborted) return fail('registry_timeout');
    if (error instanceof Error && /^registry_[a-z0-9_]+$/.test(error.message)) throw error;
    return fail('registry_network_error');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

// unzipper is an existing dependency (Companies House snapshot); it reads the central directory from disk.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as { Open: { file(file: string): Promise<{ files: Array<{
  path: string; type: string; uncompressedSize: number; stream(): Readable }> }> } };

/**
 * The one file inside a downloaded archive; an archive with more files or an
 * oversized one is not the register's. With `name`, the one file whose name
 * matches it (NCES archives also hold a SAS copy of the table); of several,
 * the one matching `prefer` (IPEDS ships a revised «_rv» table next to the first).
 */
export async function openHeEngRegistryZipEntry(file: string, maxBytes: number, name?: RegExp, prefer?: RegExp): Promise<Readable> {
  const zip = await unzipper.Open.file(file);
  let entries = zip.files.filter(entry => entry.type === 'File' && (!name || name.test(path.basename(entry.path))));
  if (entries.length > 1 && prefer) entries = entries.filter(entry => prefer.test(path.basename(entry.path)));
  if (entries.length !== 1 || !(entries[0].uncompressedSize > 0) || entries[0].uncompressedSize > maxBytes) {
    throw new Error('registry_invalid_response');
  }
  return entries[0].stream();
}

interface RemoteOptions { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs: number }
/** A HEAD request for a public file whose name carries its year: true when it exists, false on 404. */
export async function probeHeEngRegistryFile(url: string, options: RemoteOptions): Promise<boolean> {
  const response = await remote(url, 'HEAD', undefined, options, async response => response);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`registry_http_${response.status}`);
  return true;
}

/** One request with the registry rules: no redirects, a time limit and the registry_* error codes. */
async function remote<T>(url: string, method: 'GET' | 'HEAD', range: string | undefined, options: RemoteOptions,
  read: (response: Response) => Promise<T>): Promise<T> {
  const fail = (code: string): never => { throw new Error(code); };
  if (options.signal?.aborted) fail('registry_aborted');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(url, { method, redirect: 'error', signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(range ? { Range: range } : {}) } });
    return await read(response);
  } catch (error) {
    if (options.signal?.aborted) return fail('registry_aborted');
    if (controller.signal.aborted) return fail('registry_timeout');
    if (error instanceof Error && /^registry_[a-z0-9_]+$/.test(error.message)) throw error;
    return fail('registry_network_error');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

/**
 * Bytes [start, end] of a remote file and its total size (`start` null: the
 * last `end` bytes). The range the server states is checked before the body
 * is read, and the body is read no further than it: a server that sends the
 * whole file instead is refused.
 */
async function rangeBytes(url: string, start: number | null, end: number, options: RemoteOptions): Promise<{ bytes: Buffer; total: number }> {
  return remote(url, 'GET', start === null ? `bytes=-${end}` : `bytes=${start}-${end}`, options, async response => {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const [first, last, total] = range ? [Number(range[1]), Number(range[2]), Number(range[3])] : [NaN, NaN, NaN];
    const length = last - first + 1;
    const fits = start === null ? last === total - 1 && length <= end : first === start && last === end;
    if (response.status !== 206 || !range || !fits || !(length > 0) || last >= total) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(response.status === 206 ? 'registry_invalid_response' : response.ok ? 'registry_range_unsupported' : `registry_http_${response.status}`);
    }
    if (!response.body) throw new Error('registry_invalid_response');
    const bytes = Buffer.alloc(length);
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > length) { await reader.cancel(); throw new Error('registry_invalid_response'); }
        bytes.set(value, size); size += value.byteLength;
      }
    } finally { reader.releaseLock(); }
    if (size !== length) throw new Error('registry_invalid_response');
    return { bytes, total };
  });
}

export interface HeEngRegistryRemoteZipEntry { method: number; compressed: number; size: number; offset: number; crc: number }
export interface HeEngRegistryRemoteZipDirectory { entries: Map<string, HeEngRegistryRemoteZipEntry>; end: number }
/**
 * The directory of a large remote zip archive, read with byte ranges: the
 * end-of-directory record, then the central directory. Only entries whose name
 * `keep` accepts are kept (an IRS archive lists 50 000–80 000 returns). Read
 * entries with readHeEngRegistryRemoteZipFile.
 */
export async function readHeEngRegistryRemoteZipDirectory(url: string, options: RemoteOptions,
  keep: (name: string) => boolean = () => true): Promise<HeEngRegistryRemoteZipDirectory> {
  const fail = (): never => { throw new Error('registry_invalid_response'); };
  // The end-of-directory record (22 bytes) and an archive comment of up to 64 KB.
  const tail = await rangeBytes(url, null, 65_557, options);
  const tailStart = tail.total - tail.bytes.length;
  let eocd = -1;
  for (let i = tail.bytes.length - 22; i >= 0; i -= 1) if (tail.bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail();
  const directorySize = tail.bytes.readUInt32LE(eocd + 12);
  const directoryOffset = tail.bytes.readUInt32LE(eocd + 16);
  // ZIP64 offsets (archives of 4 GB and more) are not read; a ZIP64 entry count alone is fine (the directory is walked by size).
  if (directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryOffset + directorySize > tail.total) fail();
  const directory = directoryOffset >= tailStart
    ? tail.bytes.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
    : (await rangeBytes(url, directoryOffset, directoryOffset + directorySize - 1, options)).bytes;
  const entries = new Map<string, HeEngRegistryRemoteZipEntry>();
  for (let pos = 0; pos + 46 <= directory.length;) {
    if (directory.readUInt32LE(pos) !== 0x02014b50) fail();
    const nameLength = directory.readUInt16LE(pos + 28);
    const name = directory.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    if (keep(name)) {
      if (entries.has(name)) fail();
      entries.set(name, { method: directory.readUInt16LE(pos + 10), crc: directory.readUInt32LE(pos + 16), compressed: directory.readUInt32LE(pos + 20),
        size: directory.readUInt32LE(pos + 24), offset: directory.readUInt32LE(pos + 42) });
    }
    pos += 46 + nameLength + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
  }
  return { entries, end: directoryOffset };
}

// A local header's name and extra field are rarely longer than this: one request then reads header and data together.
const LOCAL_HEADER_ROOM = 30 + 512;
/** One file of a remote archive by its directory entry: stored, deflated or Deflate64 (zip method 9), CRC-checked. */
export async function readHeEngRegistryRemoteZipFile(url: string, entry: HeEngRegistryRemoteZipEntry, end: number,
  options: RemoteOptions & { maxBytes: number }): Promise<Buffer> {
  const fail = (): never => { throw new Error('registry_invalid_response'); };
  const { method, compressed, size, offset, crc } = entry;
  if (![0, 8, 9].includes(method) || size === 0xffffffff || compressed === 0xffffffff || !(size > 0) || size > options.maxBytes || offset + 30 > end) fail();
  const first = (await rangeBytes(url, offset, Math.min(end, offset + LOCAL_HEADER_ROOM + compressed) - 1, options)).bytes;
  if (first.readUInt32LE(0) !== 0x04034b50) fail();
  const dataStart = 30 + first.readUInt16LE(26) + first.readUInt16LE(28);
  if (offset + dataStart + compressed > end) fail();
  const data = dataStart + compressed <= first.length ? first.subarray(dataStart, dataStart + compressed)
    : (await rangeBytes(url, offset + dataStart, offset + dataStart + compressed - 1, options)).bytes;
  let content: Buffer;
  try {
    content = method === 8 ? inflateRawSync(data, { maxOutputLength: options.maxBytes }) : method === 9 ? inflateHeEngDeflate64(data, size) : Buffer.from(data);
  } catch { return fail(); }
  if (content.length !== size || crc32(content) !== crc) fail();
  return content;
}

/**
 * One named file of a large remote zip archive, read with byte ranges: the
 * SEC's quarterly financial statement archive is 65 MB; its list of filers is 2 MB.
 */
export async function readHeEngRegistryRemoteZipEntry(url: string, name: string, options: RemoteOptions & { maxBytes: number }): Promise<Buffer> {
  const directory = await readHeEngRegistryRemoteZipDirectory(url, options, entry => entry === name);
  const entry = directory.entries.get(name);
  if (!entry) throw new Error('registry_invalid_response');
  return readHeEngRegistryRemoteZipFile(url, entry, directory.end, options);
}

export interface HeEngRegistryBuildOptions { fetch?: typeof fetch; now?: () => number }
/**
 * A list built in the background from downloaded files and kept for a day:
 * the stage comes back for it (a free read, no cursor moves) while it is
 * built, and a day-old list is served while the next one is built. A failed
 * build is not repeated for 15 minutes: meanwhile the old list is served, or
 * the slices wait; only after three failed builds in a row does the error
 * reach them, and a slice then gives the source up. (Throwing the first error
 * at once let one timeout end every slice of the list within 90 seconds.)
 * From the third failure the pause doubles, up to a day, so a broken source is
 * not downloaded again every 15 minutes. The build never gets a stage's
 * signal: one cancelled job must not fail the list for everyone.
 */
export function heEngRegistryBackgroundList<T>(build: (options: HeEngRegistryBuildOptions) => Promise<T>):
  (options: HeEngRegistryBuildOptions) => Promise<T> {
  let index: { at: number; value: T } | null = null;
  let building: Promise<void> | null = null;
  let failure: { at: number; error: Error; count: number } | null = null;
  return async options => {
    const now = (options.now ?? Date.now)();
    if (index && now - index.at < BACKGROUND_LIST_MAX_AGE_MS) return index.value;
    const pause = failure ? Math.min(BACKGROUND_MAX_PAUSE_MS, BACKGROUND_FAILURE_PAUSE_MS * 2 ** Math.max(0, failure.count - BACKGROUND_FAILED_BUILDS + 1)) : 0;
    const paused = failure !== null && now - failure.at < pause;
    if (!paused) {
      building ??= build({ fetch: options.fetch, now: options.now }).then(value => { index = { at: (options.now ?? Date.now)(), value }; failure = null; },
        error => {
          failure = { at: (options.now ?? Date.now)(), error: error instanceof Error ? error : new Error('registry_unavailable'), count: (failure?.count ?? 0) + 1 };
        })
        .finally(() => { building = null; });
    }
    if (index) return index.value;
    if (paused && failure!.count >= BACKGROUND_FAILED_BUILDS) throw failure!.error;
    throw new HeEngRegistryRetryError(paused ? failure!.at + pause - now : 30_000);
  };
}
const BACKGROUND_LIST_MAX_AGE_MS = 24 * 60 * 60_000;
const BACKGROUND_FAILURE_PAUSE_MS = 15 * 60_000;
const BACKGROUND_FAILED_BUILDS = 3;
const BACKGROUND_MAX_PAUSE_MS = 24 * 60 * 60_000;

/** A streaming Windows-1252 decoder with the StringDecoder interface. */
function windows1252(): { write(chunk: Buffer): string; end(): string } {
  const decoder = new TextDecoder('windows-1252');
  return { write: chunk => decoder.decode(chunk, { stream: true }), end: () => decoder.decode() };
}

/** One record from `start`, or null when the text ends before the record does (more text may follow). */
function takeRecord(text: string, start: number, delimiter: string, final: boolean): [string[], number] | null {
  const fields: string[] = [];
  let pos = start;
  for (;;) {
    let value: string;
    if (text[pos] === '"') {
      value = '';
      let i = pos + 1;
      for (;;) {
        const quote = text.indexOf('"', i);
        if (quote < 0) { if (!final) return null; value += text.slice(i); pos = text.length; break; }
        value += text.slice(i, quote);
        if (text[quote + 1] === '"') { value += '"'; i = quote + 2; continue; }
        if (quote + 1 >= text.length && !final) return null;
        pos = quote + 1;
        break;
      }
      // Stray text after a closing quote belongs to the same field.
      const tail = /[^\r\n]*/y; tail.lastIndex = pos;
      const stray = (tail.exec(text)?.[0] ?? '').split(delimiter)[0];
      value += stray; pos += stray.length;
    } else {
      const comma = text.indexOf(delimiter, pos);
      const newline = text.indexOf('\n', pos);
      let end = comma < 0 ? newline : newline < 0 ? comma : Math.min(comma, newline);
      if (end < 0) { if (!final) return null; end = text.length; }
      value = text.slice(pos, end);
      if (end === newline && value.endsWith('\r')) value = value.slice(0, -1);
      pos = end;
    }
    fields.push(value);
    if (pos >= text.length) return final ? [fields, pos] : null;
    if (text[pos] === delimiter) { pos += 1; continue; }
    if (text[pos] === '\r' && text[pos + 1] === '\n') return [fields, pos + 2];
    if (text[pos] === '\r' && pos + 1 >= text.length && !final) return null;
    return [fields, pos + 1];
  }
}

/**
 * Rows of a delimited text stream (RFC 4180 quoting: quoted fields may hold
 * the delimiter, doubled quotes and line breaks), parsed chunk by chunk without
 * holding the file. Yields to the event loop between batches; stops past
 * maxBytes of text. UTF-8 unless the file is Windows-1252 (the SEC's adviser list).
 */
export async function* heEngRegistryCsvRows(stream: AsyncIterable<Buffer | string>, delimiter: string, options: {
  maxBytes: number; signal?: AbortSignal; encoding?: 'windows-1252';
}): AsyncGenerator<string[]> {
  const decoder = options.encoding ? windows1252() : new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  let count = 0;
  let first = true;
  const records = function* (final: boolean): Generator<string[]> {
    let pos = 0;
    if (first && text.length) { if (text.charCodeAt(0) === 0xfeff) pos = 1; first = false; }
    while (pos < text.length) {
      const record = takeRecord(text, pos, delimiter, final);
      if (!record) break;
      pos = record[1];
      if (record[0].length > 1 || record[0][0] !== '') yield record[0];
    }
    text = text.slice(pos);
  };
  for await (const chunk of stream) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytes > options.maxBytes) throw new Error('registry_response_too_large');
    text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (const row of records(false)) {
      yield row;
      if (++count % 5000 === 0) { await yieldLoop(); options.signal?.throwIfAborted(); }
    }
  }
  text += decoder.end();
  yield* records(true);
}
