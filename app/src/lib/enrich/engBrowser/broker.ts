import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import iconv from 'iconv-lite';
import { isEngHtmlBlocked } from '@/lib/enrich/engPageFallbackPolicy';
import { createUsWebsiteFetchGuard } from '@/lib/enrich/publicAddress';
import { fetchFollowingGuarded } from '@/lib/enrich/websiteParser';
import { BrowserError, DEFAULT_TIMEOUT, MAX_RESOURCES, MAX_TIMEOUT, RESOURCE_BYTES, SESSION_BYTES, readJson, reply, socketJson } from './protocol';

type Page = { url: string; contentType: string; body: string; headers: Record<string, string> };
type Session = { token: string; controller: AbortController; resources: number; bytes: number; initial: Page | null; initialServed: boolean; refusal: string | null };
const guard = createUsWebsiteFetchGuard();

function urlAllowed(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrowserError('refused'); }
  if (url.protocol !== 'https:' || url.username || url.password || raw.length > 2048) throw new BrowserError('refused');
  return url.href;
}
function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (current instanceof BrowserError) return current.code;
    if ((current as { websiteAddressRefused?: unknown }).websiteAddressRefused === true) return 'refused';
    current = (current as { cause?: unknown }).cause;
  }
  return 'unavailable';
}
function errorStatus(code: string): number {
  if (code === 'busy' || code === 'unavailable') return 503;
  if (code === 'timeout' || code === 'cancelled') return 504;
  if (code === 'unauthorized') return 401;
  return 422;
}
function secureEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function fetchPage(session: Session, raw: string): Promise<Page> {
  const url = urlAllowed(raw);
  if (session.resources >= MAX_RESOURCES || session.bytes >= SESSION_BYTES) throw new BrowserError('resource_limit');
  session.resources++;
  const signal = session.controller.signal;
  signal.throwIfAborted();
  if (!guard.directDispatcher) throw new BrowserError('refused');
  const { res, url: finalUrl } = await fetchFollowingGuarded(url, {
    method: 'GET', redirect: 'manual', signal,
    dispatcher: guard.directDispatcher,
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; PortalWebsiteReader/1.0)', accept: 'text/html,application/xhtml+xml,text/css,application/javascript,text/javascript;q=0.9,*/*;q=0.1', 'accept-language': 'en-US,en;q=0.9' },
  } as RequestInit, guard, signal);
  if ([401, 403, 407, 429, 451].includes(res.status)) { await res.body?.cancel().catch(() => {}); throw new BrowserError('blocked'); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new BrowserError(res.status >= 500 ? 'unavailable' : 'http_error'); }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!/^(?:text\/html|application\/xhtml\+xml|text\/css|(?:application|text)\/(?:javascript|x-javascript)|application\/json)\b/.test(contentType)) {
    await res.body?.cancel().catch(() => {}); throw new BrowserError('content_type');
  }
  const chunks: Buffer[] = []; let bytes = 0;
  const reader = res.body?.getReader();
  try {
    if (reader) for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; session.bytes += next.value.byteLength;
      if (bytes > RESOURCE_BYTES || session.bytes > SESSION_BYTES) { await reader.cancel().catch(() => {}); throw new BrowserError('resource_limit'); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader?.releaseLock(); }
  const rawBody = Buffer.concat(chunks);
  const charset = /charset\s*=\s*[\"']?([^;\s\"']+)/i.exec(contentType)?.[1] ?? 'utf8';
  const decodedBody = iconv.decode(rawBody, iconv.encodingExists(charset) ? charset : 'utf8');
  if (/^(?:text\/html|application\/xhtml)/.test(contentType) && isEngHtmlBlocked(decodedBody)) throw new BrowserError('blocked');
  const headers: Record<string, string> = {};
  for (const name of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-expose-headers']) {
    const value = res.headers.get(name);
    if (value && value.length <= 2048) headers[name] = value;
  }
  return { url: finalUrl, contentType, body: rawBody.toString('base64'), headers };
}

export function createBroker(options: { token: string; runnerSocket: string }) {
  const sessions = new Map<string, Session>();
  const capacity = 1;
  async function ready(): Promise<boolean> {
    try { const health = await socketJson(options.runnerSocket, '/health', null, AbortSignal.timeout(1500)); return health.ready === true && health.isolation === 'network-none-v1'; }
    catch { return false; }
  }
  const render = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') { const ok = await ready(); reply(res, ok ? 200 : 503, { ready: ok }); return; }
    if (req.method !== 'POST' || req.url !== '/render') { reply(res, 404, { error: 'not_found' }); return; }
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !secureEqual(auth.slice(7), options.token)) { reply(res, 401, { error: 'unauthorized' }); return; }
    let session: Session | undefined; let timer: NodeJS.Timeout | undefined;
    try {
      const body = await readJson(req); if (typeof body.url !== 'string') throw new BrowserError('bad_url');
      const url = urlAllowed(body.url);
      if (sessions.size >= capacity) throw new BrowserError('busy');
      const timeout = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) ? Math.max(1, Math.min(MAX_TIMEOUT, Math.floor(body.timeoutMs))) : DEFAULT_TIMEOUT;
      const controller = new AbortController();
      session = { token: randomBytes(32).toString('hex'), controller, resources: 0, bytes: 0, initial: null, initialServed: false, refusal: null };
      sessions.set(session.token, session);
      timer = setTimeout(() => controller.abort(), timeout);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      if (!(await ready())) throw new BrowserError('unavailable');
      session.initial = await fetchPage(session, url);
      if (!/^(?:text\/html|application\/xhtml\+xml)\b/.test(session.initial.contentType)) throw new BrowserError('content_type');
      const output = await socketJson(options.runnerSocket, '/render', { session: session.token, url: session.initial.url }, controller.signal);
      if (controller.signal.aborted) throw new BrowserError('cancelled');
      if (output.url !== session.initial.url || typeof output.html !== 'string' || Buffer.byteLength(output.html) > RESOURCE_BYTES) throw new BrowserError('invalid_result');
      if (isEngHtmlBlocked(output.html)) throw new BrowserError('blocked');
      reply(res, 200, { url: output.url, html: output.html, source: 'browser' });
    } catch (error) {
      const code = session?.refusal ?? (session?.controller.signal.aborted ? 'timeout' : errorCode(error));
      reply(res, errorStatus(code), { error: code });
    } finally {
      if (timer) clearTimeout(timer);
      if (session) { session.controller.abort(); sessions.delete(session.token); }
    }
  });
  const internal = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/verify', '/fetch'].includes(req.url ?? '')) { reply(res, 404, { error: 'not_found' }); return; }
    let session: Session | undefined;
    try {
      const body = await readJson(req); session = typeof body.session === 'string' ? sessions.get(body.session) : undefined;
      if (!session || session.controller.signal.aborted || !session.initial) throw new BrowserError('unauthorized');
      if (req.url === '/verify') { reply(res, 200, { url: session.initial.url }); return; }
      if (typeof body.url !== 'string') throw new BrowserError('bad_url');
      const url = urlAllowed(body.url);
      // Initial response is retrieved exactly once by the runner, without another request.
      if (url === session.initial.url && !session.initialServed) { session.initialServed = true; reply(res, 200, session.initial); return; }
      const page = await fetchPage(session, url);
      // Do not give a response from a redirected resource a false origin.
      if (page.url !== url) throw new BrowserError('redirect');
      reply(res, 200, page);
    } catch (error) {
      const code = errorCode(error);
      if (session && ['refused', 'blocked', 'bad_url', 'resource_limit', 'invalid_result', 'redirect', 'content_type', 'http_error'].includes(code)) { session.refusal = code === 'bad_url' ? 'refused' : code; session.controller.abort(); }
      reply(res, errorStatus(code), { error: code });
    }
  });
  render.headersTimeout = 5_000;
  render.requestTimeout = 25_000;
  render.setTimeout(25_000, socket => socket.destroy());
  internal.headersTimeout = 5_000;
  internal.requestTimeout = 25_000;
  internal.setTimeout(25_000, socket => socket.destroy());
  return { render, internal };
}
