/**
 * Email validation engine (worker-only).
 *
 * This module uses Node.js built-in `dns` and `net` modules and MUST only
 * be imported from the worker process, never from Next.js API routes.
 *
 * For API-route-safe helpers (syntax check, normalizeEmail, etc.)
 * import from './shared' instead.
 */

import * as dns from 'dns';
import * as net from 'net';
import * as os from 'os';
import {
  checkSyntax,
  isDisposable,
  isRole,
  isFreeProvider,
  suggestTypo,
  type ValidationResult,
  type DomainInfo,
} from './shared';

// Re-export everything from shared so the worker can import from one place
export { checkSyntax, normalizeEmail, isDisposable, isRole, isFreeProvider, suggestTypo } from './shared';
export type { ValidationResult, DomainInfo } from './shared';

// ─── 2. Domain / MX Check ───────────────────────────────────────────────────

const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

export async function lookupMX(domain: string): Promise<{ mxHosts: string[]; found: boolean }> {
  try {
    const records = await dnsResolver.resolveMx(domain);
    if (records && records.length > 0) {
      const sorted = records.sort((a, b) => a.priority - b.priority);
      return { mxHosts: sorted.map((r) => r.exchange), found: true };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL') {
      try {
        await dnsResolver.resolve4(domain);
        return { mxHosts: [domain], found: true };
      } catch {
        return { mxHosts: [], found: false };
      }
    }
    return { mxHosts: [], found: false };
  }
  return { mxHosts: [], found: false };
}

export async function checkDomain(domain: string): Promise<boolean> {
  try {
    await dnsResolver.resolve4(domain);
    return true;
  } catch {
    try {
      await dnsResolver.resolve6(domain);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── 7. SMTP Verification ──────────────────────────────────────────────────

const SMTP_CONNECT_TIMEOUT_MS = 8_000;
const SMTP_COMMAND_TIMEOUT_MS = 8_000;

/**
 * HELO domain for the local-dev direct SMTP fallback. In production all
 * traffic goes through the smtp-proxy, which picks its own HELO based on
 * the proxy VPS's hostname/PTR. This is used only when SMTP_PROXY_URLS is
 * empty (local dev).
 */
const LOCAL_HELO_DOMAIN = process.env.EMAIL_VALIDATION_HELO_DOMAIN ?? os.hostname();
const LOCAL_HELO_FROM = `verify@${LOCAL_HELO_DOMAIN}`;

export type SmtpCheckResult = {
  code: number;
  exists: boolean | null;
  isCatchAll: boolean | null;
  greylist: boolean;
  error?: string;
};

// ─── 7a. Remote SMTP proxy (round-robin with failover) ──────────────────────

const SMTP_PROXY_URLS: string[] = (() => {
  const single = process.env.SMTP_PROXY_URL?.trim();
  const multi = process.env.SMTP_PROXY_URLS?.trim();
  if (multi) return multi.split(',').map((u) => u.trim()).filter(Boolean);
  if (single) return [single];
  return [];
})();

const SMTP_PROXY_API_KEY = process.env.SMTP_PROXY_API_KEY ?? '';
const SMTP_PROXY_TIMEOUT_MS = 25_000;

let proxyIndex = 0;

function nextProxyUrl(): string {
  const url = SMTP_PROXY_URLS[proxyIndex % SMTP_PROXY_URLS.length];
  proxyIndex = (proxyIndex + 1) % SMTP_PROXY_URLS.length;
  return url;
}

async function smtpVerifyViaProxy(
  email: string,
  mxHost: string,
  options?: { checkCatchAll?: boolean; timeout?: number },
): Promise<SmtpCheckResult> {
  // HELO is picked by the proxy itself (from EMAIL_VALIDATION_HELO_DOMAIN
  // env var or os.hostname() on the proxy VPS), so it matches the IP's PTR.
  const body = {
    email,
    mxHost,
    checkCatchAll: options?.checkCatchAll ?? false,
    timeout: options?.timeout ?? SMTP_CONNECT_TIMEOUT_MS,
  };

  let lastError: string | undefined;

  for (let attempt = 0; attempt < SMTP_PROXY_URLS.length; attempt++) {
    const baseUrl = nextProxyUrl();
    const url = `${baseUrl.replace(/\/+$/, '')}/smtp-check`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SMTP_PROXY_TIMEOUT_MS);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SMTP_PROXY_API_KEY ? { Authorization: `Bearer ${SMTP_PROXY_API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        lastError = `Proxy ${baseUrl}: HTTP ${res.status}`;
        continue;
      }

      return (await res.json()) as SmtpCheckResult;
    } catch (err) {
      lastError = `Proxy ${baseUrl}: ${err instanceof Error ? err.message : 'unknown error'}`;
      continue;
    }
  }

  return { code: 0, exists: null, isCatchAll: null, greylist: false, error: lastError ?? 'All SMTP proxies failed' };
}

// ─── 7b. Direct SMTP (fallback for local dev / no proxy configured) ─────────

type SmtpResponse = { code: number; text: string };

function parseSmtpResponse(data: string): SmtpResponse {
  const match = data.match(/^(\d{3})[\s-]/);
  return { code: match ? parseInt(match[1], 10) : 0, text: data.trim() };
}

function smtpCommand(socket: net.Socket, command: string, timeoutMs: number): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SMTP timeout waiting for response to: ${command.split('\r\n')[0]}`));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      const text = data.toString('utf-8');
      if (/^\d{3} /m.test(text)) {
        resolve(parseSmtpResponse(text));
      } else {
        let accumulated = text;
        const onMore = (chunk: Buffer) => {
          accumulated += chunk.toString('utf-8');
          if (/^\d{3} /m.test(accumulated)) {
            clearTimeout(timer);
            socket.removeListener('data', onMore);
            resolve(parseSmtpResponse(accumulated));
          }
        };
        socket.on('data', onMore);
      }
    };
    const onError = (err: Error) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      reject(err);
    };

    socket.once('error', onError);
    socket.on('data', onData);
    socket.write(command + '\r\n');
  });
}

function waitForGreeting(socket: net.Socket, timeoutMs: number): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('SMTP greeting timeout'));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      resolve(parseSmtpResponse(data.toString('utf-8')));
    };
    const onError = (err: Error) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      reject(err);
    };

    socket.once('data', onData);
    socket.once('error', onError);
  });
}

async function smtpVerifyDirect(
  email: string,
  mxHost: string,
  options?: { checkCatchAll?: boolean; timeout?: number },
): Promise<SmtpCheckResult> {
  const timeout = options?.timeout ?? SMTP_CONNECT_TIMEOUT_MS;
  const result: SmtpCheckResult = { code: 0, exists: null, isCatchAll: null, greylist: false };
  const helo = { domain: LOCAL_HELO_DOMAIN, from: LOCAL_HELO_FROM };

  let socket: net.Socket | null = null;

  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP connect timeout')), timeout);
      const s = net.createConnection({ host: mxHost, port: 25, timeout }, () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const greeting = await waitForGreeting(socket, SMTP_COMMAND_TIMEOUT_MS);
    if (greeting.code !== 220) {
      result.error = `Unexpected greeting: ${greeting.code}`;
      return result;
    }

    const ehloResp = await smtpCommand(socket, `EHLO ${helo.domain}`, SMTP_COMMAND_TIMEOUT_MS);
    if (ehloResp.code !== 250) {
      const heloResp = await smtpCommand(socket, `HELO ${helo.domain}`, SMTP_COMMAND_TIMEOUT_MS);
      if (heloResp.code !== 250) {
        result.error = `EHLO/HELO rejected: ${heloResp.code}`;
        return result;
      }
    }

    const mailFrom = await smtpCommand(socket, `MAIL FROM:<${helo.from}>`, SMTP_COMMAND_TIMEOUT_MS);
    if (mailFrom.code !== 250) {
      result.error = `MAIL FROM rejected: ${mailFrom.code}`;
      return result;
    }

    const rcptTo = await smtpCommand(socket, `RCPT TO:<${email}>`, SMTP_COMMAND_TIMEOUT_MS);
    result.code = rcptTo.code;

    if (rcptTo.code === 250) {
      result.exists = true;
    } else if (rcptTo.code >= 550 && rcptTo.code <= 559) {
      result.exists = false;
    } else if (rcptTo.code >= 450 && rcptTo.code <= 459) {
      result.greylist = true;
      result.exists = null;
    } else if (rcptTo.code >= 400 && rcptTo.code < 500) {
      result.greylist = true;
      result.exists = null;
    }

    if (options?.checkCatchAll && result.exists === true) {
      const domain = email.split('@')[1];
      const randomLocal = `verify-check-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
      const randomEmail = `${randomLocal}@${domain}`;

      await smtpCommand(socket, 'RSET', SMTP_COMMAND_TIMEOUT_MS);
      await smtpCommand(socket, `MAIL FROM:<${helo.from}>`, SMTP_COMMAND_TIMEOUT_MS);
      const catchAllRcpt = await smtpCommand(socket, `RCPT TO:<${randomEmail}>`, SMTP_COMMAND_TIMEOUT_MS);

      if (catchAllRcpt.code === 250) {
        result.isCatchAll = true;
      } else if (catchAllRcpt.code >= 550 && catchAllRcpt.code <= 559) {
        result.isCatchAll = false;
      }
    }

    try {
      await smtpCommand(socket, 'QUIT', 3000);
    } catch {
      // QUIT timeout is non-critical
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SMTP error';
    result.error = msg;

    if (msg.includes('ECONNREFUSED') || msg.includes('connect timeout')) {
      result.exists = null;
    }
  } finally {
    if (socket) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
  }

  return result;
}

// ─── 7c. Public entry point ─────────────────────────────────────────────────

export async function smtpVerify(
  email: string,
  mxHost: string,
  options?: { checkCatchAll?: boolean; timeout?: number },
): Promise<SmtpCheckResult> {
  if (SMTP_PROXY_URLS.length > 0) {
    return smtpVerifyViaProxy(email, mxHost, options);
  }
  throw new Error(
    'SMTP_PROXY_URLS is not configured. Direct SMTP connections on port 25 are disabled to prevent IP blacklisting. Set SMTP_PROXY_URLS environment variable.',
  );
}

// ─── 10. Smart Verify (Aggregate Signals) ───────────────────────────────────

export async function validateEmail(
  rawEmail: string,
  domainCache: Map<string, DomainInfo>,
): Promise<ValidationResult> {
  const email = rawEmail.trim().toLowerCase();
  const details: Record<string, unknown> = {};

  const syntax = checkSyntax(email);
  if (!syntax.valid) {
    return {
      result: 'invalid', quality: 'bad',
      is_free: false, is_role: false, is_disposable: false, is_catch_all: false,
      did_you_mean: null, mx_found: false, smtp_code: 0,
      details: { step: 'syntax', error: syntax.error },
    };
  }

  const atIndex = email.lastIndexOf('@');
  const local = email.substring(0, atIndex);
  const domain = email.substring(atIndex + 1);

  const roleFlag = isRole(local);
  const freeFlag = isFreeProvider(domain);

  const disposableFlag = isDisposable(domain);
  if (disposableFlag) {
    return {
      result: 'disposable', quality: 'bad',
      is_free: freeFlag, is_role: roleFlag, is_disposable: true, is_catch_all: false,
      did_you_mean: null, mx_found: false, smtp_code: 0,
      details: { step: 'disposable' },
    };
  }

  const typoSuggestion = suggestTypo(domain);
  const didYouMean = typoSuggestion ? `${local}@${typoSuggestion}` : null;

  let domainInfo = domainCache.get(domain);
  if (!domainInfo) {
    const mx = await lookupMX(domain);
    domainInfo = {
      domain,
      mxHosts: mx.mxHosts,
      mxFound: mx.found,
      isCatchAll: null,
      isDisposable: disposableFlag,
      checkedAt: new Date(),
    };
    domainCache.set(domain, domainInfo);
  }

  if (!domainInfo.mxFound) {
    return {
      result: 'invalid', quality: 'bad',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
      did_you_mean: didYouMean, mx_found: false, smtp_code: 0,
      details: { step: 'mx', error: 'Нет MX-записей для домена' },
    };
  }

  const needCatchAllCheck = domainInfo.isCatchAll === null;
  let smtpResult: SmtpCheckResult | null = null;

  for (const mxHost of domainInfo.mxHosts.slice(0, 3)) {
    try {
      smtpResult = await smtpVerify(email, mxHost, {
        checkCatchAll: needCatchAllCheck,
        timeout: SMTP_CONNECT_TIMEOUT_MS,
      });
      if (smtpResult.isCatchAll !== null && domainInfo.isCatchAll === null) {
        domainInfo.isCatchAll = smtpResult.isCatchAll;
      }
      if (smtpResult.exists !== null || smtpResult.isCatchAll !== null) break;
      if (smtpResult.greylist) break;
    } catch {
      details.mxHostFailed = mxHost;
      continue;
    }
  }

  const isCatchAll = domainInfo.isCatchAll === true;
  const mxFound = domainInfo.mxFound;

  if (!smtpResult) {
    return {
      result: 'unknown', quality: 'risky',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: isCatchAll,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: 0,
      details: { step: 'smtp', error: 'Не удалось подключиться ни к одному MX-серверу' },
      error: 'Не удалось подключиться ни к одному MX-серверу',
    };
  }

  details.smtp_code = smtpResult.code;
  if (smtpResult.error) details.smtp_error = smtpResult.error;

  if (smtpResult.greylist) {
    return {
      result: 'unknown', quality: 'risky',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: isCatchAll,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
      details: { ...details, step: 'greylist' },
      error: 'Сервер ответил временным отказом (greylisting)',
    };
  }

  if (isCatchAll) {
    return {
      result: 'catch_all', quality: 'risky',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: true,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
      details: { ...details, step: 'catch_all' },
    };
  }

  if (smtpResult.exists === true) {
    return {
      result: 'ok', quality: 'good',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
      details: { ...details, step: 'smtp_ok' },
    };
  }

  if (smtpResult.exists === false) {
    return {
      result: 'invalid', quality: 'bad',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
      details: { ...details, step: 'smtp_invalid' },
    };
  }

  return {
    result: 'unknown', quality: 'risky',
    is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: isCatchAll,
    did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
    details: { ...details, step: 'unknown' },
    error: smtpResult.error ?? 'Неопределённый ответ SMTP-сервера',
  };
}
