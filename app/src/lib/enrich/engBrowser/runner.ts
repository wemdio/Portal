import http from 'node:http';
import os from 'node:os';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { isEngHtmlBlocked } from '@/lib/enrich/engPageFallbackPolicy';
import { BrowserError, RESOURCE_BYTES, readJson, reply, socketJson } from './protocol';

export function isIsolated(): boolean {
  if (process.platform !== 'linux' || process.env.ENG_BROWSER_SANDBOX !== 'network-none-v1' || process.getuid?.() === 0) return false;
  return Object.values(os.networkInterfaces()).flat().every(address => !address || address.internal);
}

export async function createRunner(brokerSocket: string) {
  if (!isIsolated()) throw new BrowserError('isolation_required');
  // chromiumSandbox=true removes Playwright's --no-sandbox launch flag.
  // If the host cannot support Chromium's sandbox, startup fails closed.
  const browser: Browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  // Launch can appear successful before Chromium's sandbox rejects the first page.
  // Readiness must stay false unless an actual page can be created.
  try {
    const probe = await browser.newContext({ serviceWorkers: 'block' });
    try { await probe.newPage(); } finally { await probe.close(); }
  } catch (error) { await browser.close().catch(() => {}); throw error; }
  let active = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const ready = isIsolated() && browser.isConnected();
      reply(res, ready ? 200 : 503, { ready, isolation: ready ? 'network-none-v1' : 'unavailable' }); return;
    }
    if (req.method !== 'POST' || req.url !== '/render') { reply(res, 404, { error: 'not_found' }); return; }
    let context: BrowserContext | undefined; let acquired = false; let fatal: string | undefined;
    let pending = 0; let lastChange = Date.now();
    const controller = new AbortController();
    let hardStop: NodeJS.Timeout | undefined;
    controller.signal.addEventListener('abort', () => { hardStop = setTimeout(() => process.exit(1), 2000); hardStop.unref(); }, { once: true });
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      if (!isIsolated() || !browser.isConnected()) throw new BrowserError('unavailable');
      if (active) throw new BrowserError('busy');
      active = true; acquired = true;
      const input = await readJson(req);
      if (typeof input.session !== 'string' || !/^[a-f0-9]{64}$/.test(input.session) || typeof input.url !== 'string') throw new BrowserError('bad_request');
      const session = input.session; const url = input.url;
      const verify = await socketJson(brokerSocket, '/verify', { session }, controller.signal);
      if (verify.url !== url) throw new BrowserError('unauthorized');
      context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', acceptDownloads: false });
      const closeOnAbort = () => { void context?.close().catch(() => {}); };
      controller.signal.addEventListener('abort', closeOnAbort, { once: true });
      await context.routeWebSocket(/.*/, ws => ws.close());
      await context.route('**/*', async route => {
        pending += 1; lastChange = Date.now();
        try {
          const request = route.request();
          if (request.method() !== 'GET' || ['image', 'media', 'font'].includes(request.resourceType())) { await route.abort(); return; }
          const resource = await socketJson(brokerSocket, '/fetch', { session, url: request.url() }, controller.signal);
          if (resource.url !== request.url() || typeof resource.body !== 'string' || typeof resource.contentType !== 'string') throw new BrowserError('invalid_result');
          const body = Buffer.from(resource.body, 'base64');
          if (body.byteLength > RESOURCE_BYTES) throw new BrowserError('invalid_result');
          const headers: Record<string, string> = {};
          if (resource.headers && typeof resource.headers === 'object' && !Array.isArray(resource.headers)) {
            const received = resource.headers as Record<string, unknown>;
            for (const name of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-expose-headers']) {
              if (typeof received[name] === 'string' && received[name].length <= 2048) headers[name] = received[name];
            }
          }
          await route.fulfill({ status: 200, contentType: resource.contentType, headers, body });
        } catch (error) {
          fatal ??= error instanceof BrowserError ? error.code : 'unavailable';
          await route.abort().catch(() => {});
        } finally { pending -= 1; lastChange = Date.now(); }
      });
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (fatal) throw new BrowserError(fatal);
      if (!response?.ok() || page.url() !== url) throw new BrowserError('unavailable');
      // A fixed sleep can return partial HTML while a slow resource later fails
      // or populates the DOM. Require a quiet network window, bounded separately
      // from the caller deadline. Unknown or still-running requests are terminal.
      const settleDeadline = Date.now() + 8_000;
      let html: string;
      for (;;) {
        if (fatal) throw new BrowserError(fatal);
        if (controller.signal.aborted || page.url() !== url) throw new BrowserError('cancelled');
        if (Date.now() >= settleDeadline) throw new BrowserError('incomplete');
        if (pending === 0 && Date.now() - lastChange >= 1_000) {
          const stableSince = lastChange;
          html = await page.content();
          // A request may start while page.content is in flight.
          if (fatal) throw new BrowserError(fatal);
          if (controller.signal.aborted || page.url() !== url) throw new BrowserError('incomplete');
          if (pending === 0 && lastChange === stableSince) break;
        }
        await page.waitForTimeout(50);
      }
      if (Buffer.byteLength(html) > RESOURCE_BYTES) throw new BrowserError('resource_limit');
      if (isEngHtmlBlocked(html)) throw new BrowserError('blocked');
      reply(res, 200, { url, html });
    } catch (error) {
      reply(res, 503, { error: fatal ?? (error instanceof BrowserError ? error.code : 'unavailable') });
    } finally {
      clearTimeout(timer);
      if (context) {
        // Closing a hung Chromium context must not leave the runner permanently busy.
        const cleanupDeadline = setTimeout(() => process.exit(1), 2000);
        cleanupDeadline.unref();
        try { await context.close().catch(() => {}); } finally { clearTimeout(cleanupDeadline); }
      }
      if (hardStop) clearTimeout(hardStop);
      if (acquired) active = false;
    }
  });
  return { server, close: () => browser.close() };
}
