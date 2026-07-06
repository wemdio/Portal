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

const MX_LOOKUP_MAX_ATTEMPTS = 3; // 1 try + 2 retries on transient DNS errors
const MX_LOOKUP_BACKOFF_MS = 250;
const dnsSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hard = the resolver gave an AUTHORITATIVE "no such record" (NXDOMAIN / no MX).
 * Everything else (SERVFAIL, ETIMEDOUT, EAI_AGAIN, ECONNREFUSED, …) is a
 * TRANSIENT resolver failure: the domain's MX status is UNDETERMINED, NOT absent.
 * Collapsing transient failures into "no MX" is how a flaky DNS moment turned
 * a valid domain into a permanent `invalid` verdict (cached 24h) and deleted
 * live leads — the client-reported false-negative.
 */
function isHardDnsError(code: string | undefined): boolean {
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

// 'ok' = has A record (implicit MX); 'absent' = authoritative no-A; 'soft' = transient.
async function tryResolve4(domain: string): Promise<'ok' | 'absent' | 'soft'> {
  try {
    const a = await dnsResolver.resolve4(domain);
    return a && a.length > 0 ? 'ok' : 'absent';
  } catch (err) {
    return isHardDnsError((err as NodeJS.ErrnoException).code) ? 'absent' : 'soft';
  }
}

export async function lookupMX(
  domain: string,
): Promise<{ mxHosts: string[]; found: boolean; lookupFailed: boolean }> {
  for (let attempt = 1; attempt <= MX_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const records = await dnsResolver.resolveMx(domain);
      if (records && records.length > 0) {
        const sorted = records.sort((a, b) => a.priority - b.priority);
        return { mxHosts: sorted.map((r) => r.exchange), found: true, lookupFailed: false };
      }
      // No MX records → implicit MX = the domain's A record (RFC 5321 §5.1).
      const a = await tryResolve4(domain);
      if (a === 'ok') return { mxHosts: [domain], found: true, lookupFailed: false };
      if (a === 'absent') return { mxHosts: [], found: false, lookupFailed: false };
      // a === 'soft' → undetermined, fall through to retry
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (isHardDnsError(code)) {
        // Authoritative "no MX": confirm there's no implicit-MX A record either.
        const a = await tryResolve4(domain);
        if (a === 'ok') return { mxHosts: [domain], found: true, lookupFailed: false };
        if (a === 'absent') return { mxHosts: [], found: false, lookupFailed: false };
        // a === 'soft' → can't confirm absence, fall through to retry
      }
      // soft/transient error → retry
    }
    if (attempt < MX_LOOKUP_MAX_ATTEMPTS) await dnsSleep(MX_LOOKUP_BACKOFF_MS * attempt);
  }
  // Retries exhausted on a transient failure: MX status undetermined. Caller must
  // treat this as 'unknown' (retryable), NOT 'invalid', and must NOT cache it.
  return { mxHosts: [], found: false, lookupFailed: true };
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

export type SmtpCheckResult = {
  code: number;
  exists: boolean | null;
  isCatchAll: boolean | null;
  greylist: boolean;
  /** Full text of the RCPT TO reply (set by the proxy), used to tell a real
   *  "user unknown" 5xx from a policy/rate-limit 5xx. */
  smtpText?: string;
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

/**
 * True when the proxy answered us but could NOT complete an SMTP conversation
 * with the recipient's MX — connect timeout / refused / reset / host
 * unreachable, or the MX rejected US at greeting/EHLO/MAIL FROM. These are
 * almost always properties of the *egress IP* (the MX blocks that specific
 * probe IP), so the SAME probe from a DIFFERENT proxy/IP may well succeed —
 * worth a failover retry.
 *
 * A greylist 4xx, or any 2xx/5xx at RCPT, is a REAL answer about the mailbox
 * (exists/isCatchAll/greylist set) — NOT inconclusive, so we must NOT retry it
 * on the other IP (that would just double the load and risk a contradictory
 * read). Empty error with all-null is left as-is (no signal to act on).
 */
function isInconclusiveTransport(r: SmtpCheckResult): boolean {
  if (r.exists !== null || r.isCatchAll !== null || r.greylist) return false;
  const e = (r.error ?? '').toLowerCase();
  if (!e) return false;
  return /timeout|econnrefused|econnreset|ehostunreach|enetunreach|closed before|connect|unexpected greeting|ehlo\/helo rejected|mail from rejected/.test(e);
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
  // Holds a result where the proxy worked but its egress IP couldn't reach the
  // MX — kept as the fallback to return if every other proxy is also blocked.
  let lastInconclusive: SmtpCheckResult | null = null;

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

      const result = (await res.json()) as SmtpCheckResult;
      // Definitive answer (mailbox exists/catch-all/greylist, or a plain
      // all-null with no transport error) → return immediately.
      if (!isInconclusiveTransport(result)) return result;
      // This egress IP is blocked by the MX (e.g. the new probe IP can't reach
      // Yandex). Remember it and retry the SAME probe via the next proxy/IP —
      // failover, not round-robin, so complementary IPs strictly widen coverage.
      lastInconclusive = result;
      lastError = result.error;
      continue;
    } catch (err) {
      lastError = `Proxy ${baseUrl}: ${err instanceof Error ? err.message : 'unknown error'}`;
      continue;
    }
  }

  // Every proxy was blocked/unreachable: prefer returning the real MX-level
  // inconclusive result (carries smtp code/text) over a synthetic error.
  if (lastInconclusive) return lastInconclusive;
  return { code: 0, exists: null, isCatchAll: null, greylist: false, error: lastError ?? 'All SMTP proxies failed' };
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

// ─── 8. 5xx RCPT classification ──────────────────────────────────────────────

// "user unknown" signals → the mailbox genuinely does not exist (invalid).
const RCPT_USER_UNKNOWN_RE =
  /(no.?such.?(user|recipient|mailbox|address)|user.?unknown|unknown.?(user|recipient)|user.?not.?found|recipient.?(not.?found|rejected)|mailbox.?(unavailable|not.?found|disabled)|address.?(unknown|rejected)|does.?n.?.?t.?exist|not.?exist|invalid.?(recipient|mailbox|address)|5\.1\.[0-9]|нет.?такого|не.?существ|пользовател)/i;
// policy / rate-limit / temporary signals → we can't trust the 5xx as "dead".
const RCPT_POLICY_BLOCK_RE =
  /(rate.?limit|too.?many|try.?again|temporar|greylist|deferred|throttl|reputation|black.?list|blocked|spam|policy|denied|not.?allowed|service.?unavailable|5\.7\.[0-9])/i;

/**
 * Decide whether a 5xx RCPT reply means the mailbox doesn't exist ('invalid')
 * or is a policy/rate-limit/temporary rejection we can't trust ('unknown').
 * Default is 'invalid' (most 5xx at RCPT are genuine "user unknown"); we only
 * downgrade to 'unknown' when the reply clearly looks like a policy block AND
 * does NOT also say the user is unknown (e.g. Yandex "550 5.7.1 No such user!"
 * stays invalid). Falls back to 'invalid' when no reply text is available
 * (older proxy build), preserving previous behaviour.
 */
export function classifyRcpt5xx(text: string | undefined): 'invalid' | 'unknown' {
  const t = (text ?? '').trim();
  if (!t) return 'invalid';
  if (RCPT_USER_UNKNOWN_RE.test(t)) return 'invalid';
  if (RCPT_POLICY_BLOCK_RE.test(t)) return 'unknown';
  return 'invalid';
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
    if (mx.lookupFailed) {
      // Transient DNS failure — MX status undetermined, NOT "no MX". Do NOT mark
      // the address invalid and do NOT cache the negative (which would poison the
      // whole domain for 24h). Return a retryable 'unknown' so the worker
      // re-queues it instead of deleting a possibly-valid lead.
      return {
        result: 'unknown', quality: 'risky',
        is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
        did_you_mean: didYouMean, mx_found: false, smtp_code: 0,
        details: { step: 'mx', error: 'DNS lookup failed (MX undetermined)' },
        error: 'DNS lookup failed (MX undetermined)',
      };
    }
    domainInfo = {
      domain,
      mxHosts: mx.mxHosts,
      mxFound: mx.found,
      isCatchAll: null,
      isDisposable: disposableFlag,
      checkedAt: new Date(),
    };
    domainCache.set(domain, domainInfo); // cache only conclusive lookups
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
      // Proxy transport itself failed (HTTP 5xx / abort / all proxies down) —
      // don't retry the other MX through the same down proxy; let the worker
      // re-queue the whole item instead.
      if (smtpResult.error && /prox/i.test(smtpResult.error)) break;
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
    // RCPT подтверждён, но catch-all проверка не дала ответа (random-проба
    // получила не-250/не-55x: 4xx rate-limit, 503 на второй MAIL FROM в той же
    // сессии и т.п.). Такой хост может принимать ВСЁ — «ok» не заслужен: так
    // typo-squat домены (maail.ru, eandex.ru…) получали «Хороший» и уходили в
    // рассылку. Формулировка с «временный» делает статус ретраябельным в
    // queue-воркере (shouldRetry ищет «временн»); после исчерпания попыток
    // адрес остаётся 'unknown'/risky, а не 'ok'.
    if (domainInfo.isCatchAll === null) {
      return {
        result: 'unknown', quality: 'risky',
        is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
        did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
        details: { ...details, step: 'catch_all_undetermined' },
        error: 'Catch-all статус домена не определён (временный сбой проверки)',
      };
    }
    // did_you_mean НЕ понижает вердикт: сюда мы попадаем только когда домен
    // КОНКЛЮЗИВНО отверг случайный адрес (isCatchAll=false) и подтвердил
    // конкретный ящик — это поведение честного сервера, а не typo-ловушки.
    // Реальные typo-squat ловушки принимают всё подряд и уходят в ветки
    // catch_all / catch_all_undetermined выше. Понижение по одной лишь
    // levenshtein-близости к крупному провайдеру било по легитимным коротким
    // доменам (vk.com, hh.ru, 1c.ru, yandex.by…). Подсказка остаётся в
    // did_you_mean как информационная.
    return {
      result: 'ok', quality: 'good',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
      details: { ...details, step: 'smtp_ok' },
    };
  }

  if (smtpResult.exists === false) {
    // A 5xx at RCPT is usually a genuine "user unknown" → invalid. But some
    // hosts return 5xx for policy/rate-limit reasons; those we keep as
    // 'unknown' (couldn't verify) rather than deleting a possibly-valid lead.
    if (classifyRcpt5xx(smtpResult.smtpText) === 'unknown') {
      return {
        result: 'unknown', quality: 'risky',
        is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: false,
        did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
        details: { ...details, step: 'smtp_5xx_policy', smtp_text: smtpResult.smtpText },
        error: `Сервер отклонил по политике/лимиту (${smtpResult.code})`,
      };
    }
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
