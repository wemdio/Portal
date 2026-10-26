import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldLoop } from 'node:timers/promises';

/**
 * Whole-file national registers (Czech statistical register, Estonian open
 * data): one public file per source, kept on local disk and read as a stream.
 * In production the files sit on the ENG workers' Companies House volume, so a
 * redeploy does not download them again.
 */
const USER_AGENT = 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)';
// A download older than this is left over from a process that stopped mid-file.
const STALE_PART_MS = 60 * 60_000;

export function heEngRegistryCacheFile(name: string): string {
  return path.join(process.env.HE_ENG_REGISTRY_CACHE_DIR ?? (process.env.NODE_ENV === 'production'
    ? '/var/lib/portal-eng-companies-house/registries' : path.join(tmpdir(), 'portal-eng-registries')), name);
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

/** The one file inside a downloaded archive; an archive with more files or an oversized one is not the register's. */
export async function openHeEngRegistryZipEntry(file: string, maxBytes: number): Promise<Readable> {
  const zip = await unzipper.Open.file(file);
  const entries = zip.files.filter(entry => entry.type === 'File');
  if (entries.length !== 1 || !(entries[0].uncompressedSize > 0) || entries[0].uncompressedSize > maxBytes) {
    throw new Error('registry_invalid_response');
  }
  return entries[0].stream();
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
 * maxBytes of text.
 */
export async function* heEngRegistryCsvRows(stream: AsyncIterable<Buffer | string>, delimiter: string, options: {
  maxBytes: number; signal?: AbortSignal;
}): AsyncGenerator<string[]> {
  const decoder = new StringDecoder('utf8');
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
