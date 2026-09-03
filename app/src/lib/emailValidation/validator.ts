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
import { domainToASCII } from 'url';
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

/**
 * Keep only DELIVERABLE MX exchanges, sorted by priority. Drops RFC 7505
 * "null MX": a single `MX 0 .` record (Node reports its exchange as "" or ".")
 * by which a domain EXPLICITLY declares it accepts no mail. If the records exist
 * but are all null/empty, the result is [] → the domain has no deliverable MX,
 * so the address is undeliverable (invalid), not "couldn't verify" (previously
 * an empty exchange was probed as mxHost="" → proxy "Missing required fields" →
 * a spurious 'unknown').
 */
export function deliverableMxHosts(
  records: { exchange: string; priority: number }[],
): string[] {
  return records
    .filter((r) => {
      const h = (r.exchange ?? '').trim();
      return h !== '' && h !== '.';
    })
    .sort((a, b) => a.priority - b.priority)
    .map((r) => r.exchange.trim());
}

export async function lookupMX(
  domain: string,
): Promise<{ mxHosts: string[]; found: boolean; lookupFailed: boolean }> {
  for (let attempt = 1; attempt <= MX_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const records = await dnsResolver.resolveMx(domain);
      if (records && records.length > 0) {
        const hosts = deliverableMxHosts(records);
        if (hosts.length > 0) return { mxHosts: hosts, found: true, lookupFailed: false };
        // Records existed but were all null-MX/empty → domain accepts no mail.
        return { mxHosts: [], found: false, lookupFailed: false };
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
  // Ретраи пиннутого резолвера (8.8.8.8/1.1.1.1) исчерпаны. Последний шанс —
  // ОС-резолвер (системные DNS): пиннутые серверы могут резаться сетью/
  // фаерволом VPS, а системный резолвер отвечает. Один раз за lookup, прежде
  // чем признать MX неопределённым.
  try {
    const records = await dns.promises.resolveMx(domain);
    if (records && records.length > 0) {
      const hosts = deliverableMxHosts(records);
      if (hosts.length > 0) return { mxHosts: hosts, found: true, lookupFailed: false };
      return { mxHosts: [], found: false, lookupFailed: false };
    }
    // Нет MX → implicit MX = A-запись домена (RFC 5321 §5.1).
    const a = await dns.promises.resolve4(domain);
    return a && a.length > 0
      ? { mxHosts: [domain], found: true, lookupFailed: false }
      : { mxHosts: [], found: false, lookupFailed: false };
  } catch (err) {
    if (isHardDnsError((err as NodeJS.ErrnoException).code)) {
      // Авторитетный «нет MX» от ОС-DNS: подтверждаем отсутствие implicit-A.
      try {
        const a = await dns.promises.resolve4(domain);
        if (a && a.length > 0) return { mxHosts: [domain], found: true, lookupFailed: false };
        return { mxHosts: [], found: false, lookupFailed: false };
      } catch (aErr) {
        if (isHardDnsError((aErr as NodeJS.ErrnoException).code)) {
          return { mxHosts: [], found: false, lookupFailed: false };
        }
      }
    }
  }
  // Retries exhausted on a transient failure: MX status undetermined. Caller must
  // treat this as 'unknown' (retryable), NOT 'invalid', and must NOT cache it.
  return { mxHosts: [], found: false, lookupFailed: true };
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

// ─── Per-(MX host × egress IP) transport-block memory ───────────────────────
// Some MX operators block a specific probe IP (e.g. Yandex silently drops the
// 31.76.79.220 egress → the probe eats the full connect timeout, ~8s, before
// failover). Without memory, round-robin sends ~1/N of every same-MX probe into
// that dead wait. We remember (mxHost, proxyUrl) transport failures and, on the
// NEXT probe to that MX, try known-good IPs FIRST and blocked ones LAST — so
// after ONE learning probe the ~8s penalty disappears for the rest of the job.
//
// This only REORDERS the failover sequence; a blocked IP is still tried as a
// last resort, and entries expire, so it never drops coverage and never changes
// a verdict — it only avoids known-dead waits.
const SMTP_EGRESS_BLOCK_TTL_MS = Number(
  process.env.SMTP_EGRESS_BLOCK_TTL_MS ?? String(30 * 60 * 1000),
);
const mxEgressBlock = new Map<string, Map<string, number>>();

function isEgressBlocked(mxHost: string, url: string): boolean {
  const m = mxEgressBlock.get(mxHost);
  const exp = m?.get(url);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    m!.delete(url);
    if (m!.size === 0) mxEgressBlock.delete(mxHost);
    return false;
  }
  return true;
}

function markEgressBlocked(mxHost: string, url: string): void {
  let m = mxEgressBlock.get(mxHost);
  if (!m) {
    m = new Map();
    mxEgressBlock.set(mxHost, m);
  }
  m.set(url, Date.now() + SMTP_EGRESS_BLOCK_TTL_MS);
}

// ─── Per-MX greylist IP-affinity ────────────────────────────────────────────
// Greylisting keys on the SENDING IP (or its /24): the MX defers the first
// contact from an unfamiliar IP and only accepts a retry FROM THE SAME IP after
// a delay. With several probe IPs on different subnets, round-robin sends each
// (delayed) greylist retry out a DIFFERENT IP → every attempt looks like a fresh
// first-contact and the greylist counter never satisfies, so the address stays
// 'unknown' forever. Remember which IP greylisted an MX and try THAT IP first on
// the next probe, so the delayed retry lands on the same IP and clears.
// TTL 90 минут: должен перекрывать весь график greylist-ретраев воркера
// (5/15/30 мин), иначе поздний ретрай уйдёт с другого IP и greylist не снимется.
const SMTP_GREYLIST_AFFINITY_TTL_MS = Number(
  process.env.SMTP_GREYLIST_AFFINITY_TTL_MS ?? String(90 * 60 * 1000),
);
const mxGreylistAffinity = new Map<string, { url: string; expiry: number }>();

function getGreylistAffinity(mxHost: string): string | null {
  const a = mxGreylistAffinity.get(mxHost);
  if (!a) return null;
  if (a.expiry <= Date.now()) {
    mxGreylistAffinity.delete(mxHost);
    return null;
  }
  return a.url;
}

function markGreylistAffinity(mxHost: string, url: string): void {
  mxGreylistAffinity.set(mxHost, { url, expiry: Date.now() + SMTP_GREYLIST_AFFINITY_TTL_MS });
}

/** Reset the egress-block + greylist-affinity memory (tests only). */
export function __resetEgressBlockCache(): void {
  mxEgressBlock.clear();
  mxGreylistAffinity.clear();
  proxyIndex = 0;
}

/**
 * Failover try-order for this MX: the global round-robin rotation (advanced once
 * per call for load-spreading), with (a) the IP that greylisted this MX pinned
 * FIRST (so a delayed retry hits the same IP and clears the greylist), and
 * (b) IPs known to be transport-blocked for THIS mx moved to the end so they're
 * only used as a last resort.
 */
function proxyTryOrder(mxHost: string): string[] {
  const n = SMTP_PROXY_URLS.length;
  const rotated: string[] = [];
  for (let i = 0; i < n; i += 1) rotated.push(SMTP_PROXY_URLS[(proxyIndex + i) % n]);
  proxyIndex = (proxyIndex + 1) % n;
  const good = rotated.filter((u) => !isEgressBlocked(mxHost, u));
  const bad = rotated.filter((u) => isEgressBlocked(mxHost, u));
  let order = good.concat(bad);
  // Greylist retries must return from the SAME IP that greylisted → pin it first
  // (unless it has since become transport-blocked for this MX, in which case we
  // don't want to pay its dead-wait first).
  const affinity = getGreylistAffinity(mxHost);
  if (affinity && !isEgressBlocked(mxHost, affinity) && order.includes(affinity)) {
    order = [affinity, ...order.filter((u) => u !== affinity)];
  }
  return order;
}

/**
 * True when the proxy answered us but could NOT complete an SMTP conversation
 * with the recipient's MX — connect timeout / refused / reset / host
 * unreachable, the proxy's own DNS failed to resolve the MX (getaddrinfo /
 * EAI_AGAIN / ENOTFOUND), or the MX rejected US at greeting/EHLO/MAIL FROM.
 * These are almost always properties of the *egress IP* (or the proxy's DNS),
 * so the SAME probe from a DIFFERENT proxy/IP may well succeed —
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
  return /timeout|econnrefused|econnreset|ehostunreach|enetunreach|closed before|connect|unexpected greeting|ehlo\/helo rejected|mail from rejected|getaddrinfo|eai_again|enotfound/.test(e);
}

/**
 * 4xx-тексты, означающие отказ по свойствам НАШЕГО egress (IP/envelope), а не
 * настоящий greylisting получателя: FCrDNS/PTR-проверки («cannot find your
 * hostname», «Client host rejected», rdns/ptr), репутационные и блэклистные
 * отказы. Такой 4xx никогда не снимется ретраем с того же IP — его надо
 * фейловерить на другой egress. Отсутствие здесь «try again/greylist» — ок:
 * для сомнительных текстов остаётся безопасный greylist-путь (см. вызов).
 */
const RCPT_4XX_EGRESS_RE =
  /(cannot find your (host)?name|client host rejected|unknown (client|host)|reverse.?dns|missing.?ptr|no.?ptr|ptr.?record|\brdns\b|fcrdns|helo.?(command|name)?.?reject|reputation|spamhaus|barracuda|block.?list)/i;

async function smtpVerifyViaProxy(
  email: string,
  mxHost: string,
  options?: { checkCatchAll?: boolean; timeout?: number; signal?: AbortSignal },
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

  for (const baseUrl of proxyTryOrder(mxHost)) {
    // Воркер остановлен или потерял аренду: перебирать оставшиеся egress'ы
    // нечего — задача уже не наша, а каждая проба здесь платная. Проверка
    // ДО запроса: иначе отключённое от задачи тело успевало бы обойти весь
    // пул прокси по 25 с на каждый.
    if (options?.signal?.aborted) {
      lastError = lastError ?? 'SMTP probe aborted';
      break;
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/smtp-check`;

    // Таймаут пробы и внешняя остановка — один контроллер: fetch без сигнала
    // висел бы до SMTP_PROXY_TIMEOUT_MS даже после SIGTERM.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SMTP_PROXY_TIMEOUT_MS);
    const abortFromOuter = () => controller.abort();
    options?.signal?.addEventListener('abort', abortFromOuter, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SMTP_PROXY_API_KEY ? { Authorization: `Bearer ${SMTP_PROXY_API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        lastError = `Proxy ${baseUrl}: HTTP ${res.status}`;
        continue;
      }

      const result = (await res.json()) as SmtpCheckResult;
      // Definitive answer (mailbox exists/catch-all/greylist, or a plain
      // all-null with no transport error) → return immediately.
      if (!isInconclusiveTransport(result)) {
        // 4xx про НАШ egress (FCrDNS/PTR/hostname/reputation) — это НЕ
        // greylisting: сервер режет саму пробу с этого IP, и ретрай с того
        // же IP никогда не пройдёт. Фейловерим на другой egress вместо
        // greylist-affinity (реальная регрессия 2026-07-25: mx2.isource.ru
        // «450 4.7.25 Client host rejected: cannot find your hostname»
        // убивал все пробы через IP без PTR, хотя третий egress давал 250).
        if (result.greylist && RCPT_4XX_EGRESS_RE.test(result.smtpText ?? '')) {
          markEgressBlocked(mxHost, baseUrl);
          lastInconclusive = {
            ...result,
            error: `Egress rejected by MX policy (4xx): ${result.smtpText ?? result.code}`,
          };
          lastError = lastInconclusive.error;
          continue;
        }
        // Greylisted → pin this IP for the MX so the delayed retry returns from
        // the same egress and clears the greylist (see mxGreylistAffinity).
        if (result.greylist) markGreylistAffinity(mxHost, baseUrl);
        return result;
      }
      // This egress IP is blocked by the MX (e.g. the new probe IP can't reach
      // Yandex). Remember it so same-MX probes deprioritise it, and retry the
      // SAME probe via the next proxy/IP — failover, not round-robin, so
      // complementary IPs strictly widen coverage.
      markEgressBlocked(mxHost, baseUrl);
      lastInconclusive = result;
      lastError = result.error;
      continue;
    } catch (err) {
      lastError = `Proxy ${baseUrl}: ${err instanceof Error ? err.message : 'unknown error'}`;
      continue;
    } finally {
      // И таймер, и подписка на внешний сигнал снимаются на ВСЕХ выходах из
      // итерации (return/continue/throw): раньше clearTimeout стоял только на
      // успешном пути, и упавшая проба оставляла висеть таймер до срабатывания.
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abortFromOuter);
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
  options?: { checkCatchAll?: boolean; timeout?: number; signal?: AbortSignal },
): Promise<SmtpCheckResult> {
  if (SMTP_PROXY_URLS.length > 0) {
    return smtpVerifyViaProxy(email, mxHost, options);
  }
  throw new Error(
    'SMTP_PROXY_URLS is not configured. Direct SMTP connections on port 25 are disabled to prevent IP blacklisting. Set SMTP_PROXY_URLS environment variable.',
  );
}

// ─── 8. 5xx RCPT classification ──────────────────────────────────────────────

// ANTI-PROBE rejections → the server rejected OUR probe (its sender/envelope/IP),
// NOT the recipient. Even real, live mailboxes get these, so a 5xx here is NOT
// proof the address is dead — treat as unverifiable ('unknown'). Observed on
// strict corporate/pharma gateways: "550 5.1.1 Backscatter Protection detected
// an invalid or unauthenticated address" for both real AND fake recipients.
// Must be checked BEFORE user-unknown, because these replies often also carry a
// 5.1.1 code that would otherwise be read as "user unknown".
const RCPT_ANTIPROBE_RE =
  /(backscatter|sender.?(verif|callout|callback|address.?verif|reject)|call.?back|un.?authenticat|not.?authenticat|authentication.?(fail|requir)|\bspf\b|\bdkim\b|\bdmarc\b|relay(ing)?.?(denied|access)|reverse.?dns|missing.?ptr|no.?ptr|bad.?outbound|outbound.?sender)/i;
// "user unknown" signals → the mailbox genuinely does not exist (invalid).
// Числовой код сужен до 5.1.1/5.1.10 — реальных «recipient not found»: голое
// 5.1.x ловило и репутационные 5.1.0/5.1.8 (sender rejected, bad outbound
// sender), которые про НАШУ пробу, а не про ящик.
const RCPT_USER_UNKNOWN_RE =
  /(no.?such.?(user|recipient|mailbox|address)|user.?unknown|unknown.?(user|recipient)|user.?not.?found|recipient.?not.?found|mailbox.?(not.?found|disabled)|address.?unknown|does.?n.?.?t.?exist|not.?exist|invalid.?(recipient|mailbox|address)|5\.1\.(?:1|10)(?![0-9])|нет.?такого|не.?существ|пользовател)/i;
// «Мягкие» user-unknown формулировки: Exchange Online и др. пишут
// "550 5.4.1 Recipient address rejected: Access denied" про ПОЛИТИКУ, а не про
// отсутствие ящика. Считаем их «user unknown» ТОЛЬКО когда рядом нет policy-слов.
const RCPT_USER_UNKNOWN_SOFT_RE =
  /(recipient.?rejected|mailbox.?unavailable|address.?rejected)/i;
const RCPT_POLICY_WORDS_RE = /(access.?denied|policy|denied)/i;
// Переполненный ящик / квота: ящик ЖИВ, просто не принимает почту сейчас —
// это не «user unknown». Проверяется ДО user-unknown.
const RCPT_QUOTA_RE =
  /(mailbox.?full|over.?quota|quota.?exceed|insufficient.?storage)/i;
// policy / rate-limit / temporary signals → we can't trust the 5xx as "dead".
// Кириллические токены — русскоязычные MTA (Яндекс, Mail.ru, корп. Exchange RU):
// "550 Слишком много соединений с вашего IP" и т.п.
const RCPT_POLICY_BLOCK_RE =
  /(rate.?limit|too.?many|try.?again|temporar|greylist|deferred|throttl|reputation|black.?list|blocked|spam|policy|denied|not.?allowed|service.?unavailable|5\.7\.[0-9]|слишком|много|превыш|лимит|повтор|позже|отклонен|спам|заблокир|чёрн|черн)/i;

/**
 * Decide whether a 5xx RCPT reply means the mailbox doesn't exist ('invalid')
 * or is a policy/rate-limit/temporary rejection we can't trust ('unknown').
 * Default is 'invalid' (most 5xx at RCPT are genuine "user unknown"); we only
 * downgrade to 'unknown' when the reply clearly looks like a policy block AND
 * does NOT also say the user is unknown (e.g. Yandex "550 5.7.1 No such user!"
 * stays invalid). Falls back to 'invalid' when no reply text is available
 * (older proxy build), preserving previous behaviour.
 *
 * `probedEmail` — адрес, который мы проверяли: MTA часто эхом возвращает его в
 * тексте ответа, и токены из localpart/домена (spf@…, x@dmarc.io) не должны
 * срабатывать как анти-пробные SPF/DKIM/DMARC-сигналы. Эхо вырезается и в
 * <скобках>, и в «голом» виде (без скобок) перед проверкой RCPT_ANTIPROBE_RE.
 */
export function classifyRcpt5xx(text: string | undefined, probedEmail?: string): 'invalid' | 'unknown' {
  const t = (text ?? '').trim();
  if (!t) return 'invalid';
  // Anti-probe rejection (backscatter / sender-verify / sender-reject / auth /
  // relay-denied): the server rejected our probe, not the mailbox. Checked FIRST
  // so its 5.1.1 code isn't mistaken for "user unknown". A live mailbox can get
  // this, so we must NOT call it invalid — it's unverifiable.
  //
  // Strip the echoed <recipient@domain> first: most MTAs echo the probed address
  // in the reply, so a genuinely-dead role/monitoring mailbox like <spf@…>,
  // <dkim@…> or a look-alike domain like <x@dmarc.io> would otherwise match the
  // SPF/DKIM/DMARC tokens and wrongly survive as 'unknown' — the dangerous
  // direction (dead address kept → bounce). Real anti-probe phrasing
  // ("Backscatter Protection", "SPF check failed") lives OUTSIDE the brackets.
  let antiprobeText = t.replace(/<[^>]*>/g, ' ');
  if (probedEmail) {
    // «Голое» эхо без скобок: '550 5.1.1 spf@acme.com: User unknown'.
    const escaped = probedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    antiprobeText = antiprobeText.replace(new RegExp(escaped, 'gi'), ' ');
  }
  if (RCPT_ANTIPROBE_RE.test(antiprobeText)) return 'unknown';
  // Квота/переполнение — ящик жив, 5xx тут не «user unknown».
  if (RCPT_QUOTA_RE.test(t)) return 'unknown';
  if (RCPT_USER_UNKNOWN_RE.test(t)) return 'invalid';
  // «Мягкие» формулировки — invalid только без policy-слов рядом
  // ("Recipient address rejected: Access denied" — политика, не мёртвый ящик).
  if (RCPT_USER_UNKNOWN_SOFT_RE.test(t) && !RCPT_POLICY_WORDS_RE.test(t)) return 'invalid';
  if (RCPT_POLICY_BLOCK_RE.test(t)) return 'unknown';
  return 'invalid';
}

// ─── 10. Smart Verify (Aggregate Signals) ───────────────────────────────────

export async function validateEmail(
  rawEmail: string,
  domainCache: Map<string, DomainInfo>,
  /**
   * signal — остановка воркера или потеря аренды задачи. Пробрасывается в
   * SMTP-пробы через прокси: без него отключённое от задачи тело продолжало бы
   * платные обращения к пулу прокси минутами (до 3 MX × весь пул × 25 с).
   * Необязателен: validateEmail зовут и вне механизма задач.
   */
  options?: { signal?: AbortSignal },
): Promise<ValidationResult> {
  let email = rawEmail.trim().toLowerCase();
  // IDN-домены (почта.рф → xn--80a1acny.xn--p1ai): syntax/MX/SMTP идут по
  // punycode-форме домена, иначе такие адреса падали на проверке синтаксиса.
  // Нормализованный адрес воркер хранит как введён — ValidationResult его
  // не возвращает, поэтому конвертация чисто внутренняя.
  const atIdx0 = email.lastIndexOf('@');
  if (atIdx0 > 0) {
    const rawDomain = email.substring(atIdx0 + 1);
    const asciiDomain = domainToASCII(rawDomain);
    if (asciiDomain && asciiDomain !== rawDomain) {
      email = `${email.substring(0, atIdx0)}@${asciiDomain}`;
    }
  }
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
  // Первый подтверждённый exists=true: backup-MX со протухшей таблицей ящиков
  // может ответить 550 на живой адрес — такому contradictory-ответу НЕЛЬЗЯ
  // перебивать уже подтверждённый primary (иначе stale backup-MX убивает живой
  // лид, которого старый однопроходный цикл сохранял).
  let firstOkResult: SmtpCheckResult | null = null;

  const mxHostsToTry = domainInfo.mxHosts.slice(0, 3);
  for (let mxIndex = 0; mxIndex < mxHostsToTry.length; mxIndex += 1) {
    // Остановка воркера прекращает перебор MX сразу: иначе после SIGTERM тело
    // ходило бы ещё к двум резервным MX. Вердикт при этом остаётся
    // неопределённым, и вызывающий (воркер) просто не записывает его — строка
    // очереди вернётся в pending по reset_stale.
    if (options?.signal?.aborted) break;
    const mxHost = mxHostsToTry[mxIndex];
    try {
      smtpResult = await smtpVerify(email, mxHost, {
        checkCatchAll: needCatchAllCheck,
        timeout: SMTP_CONNECT_TIMEOUT_MS,
        signal: options?.signal,
      });
      if (smtpResult.isCatchAll !== null && domainInfo.isCatchAll === null) {
        domainInfo.isCatchAll = smtpResult.isCatchAll;
      }
      // Backup-MX отверг ящик, который предыдущий MX уже подтвердил: стоп,
      // вердикт остаётся за подтвердившим (catch-all при этом может остаться
      // неопределённым → честный catch_all_undetermined, а не invalid).
      if (smtpResult.exists === false && firstOkResult) {
        smtpResult = firstOkResult;
        break;
      }
      if (smtpResult.exists === true && !firstOkResult) {
        firstOkResult = smtpResult;
      }
      // Ящик подтверждён, но catch-all этого MX не определён: у следующего MX
      // домена random-проба может дать ответ — пробуем его с checkCatchAll=true,
      // чтобы не оставлять адрес в catch_all_undetermined, пока есть MX.
      // Для freemail (FREE_PROVIDERS) не ходим дальше: вердикт 'ok' при
      // неопределённом catch-all уже обеспечен freemail-trust ниже, лишние
      // пробы на каждый адрес домена не нужны.
      if (
        smtpResult.exists === true &&
        domainInfo.isCatchAll === null &&
        needCatchAllCheck &&
        !freeFlag &&
        mxIndex < mxHostsToTry.length - 1
      ) {
        continue;
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
      details: { ...details, step: 'greylist', smtp_text: smtpResult.smtpText },
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
      // Исключение — кураторский freemail (FREE_PROVIDERS, точное совпадение):
      // крупные провайдеры (mail.ru, gmail.com, yandex.ru…) не отвечают на
      // random-пробу по принципиальным причинам (анти-энумерация), поэтому
      // catch-all там не определим В ПРИНЦИПЕ, а RCPT-подтверждение ящика —
      // достаточный сигнал. Typo-squat домены (maail.ru, eandex.ru) в
      // FREE_PROVIDERS НЕ входят и по-прежнему уходят в unknown ниже.
      if (freeFlag) {
        return {
          result: 'ok', quality: 'good',
          is_free: true, is_role: roleFlag, is_disposable: false, is_catch_all: false,
          did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
          details: { ...details, step: 'smtp_ok' },
        };
      }
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
    // Квота («550 5.2.2 mailbox full») — НЕ user unknown и НЕ policy-ретрай:
    // пропускаем классификатор и уходим в терминальный over_quota ниже.
    if (!RCPT_QUOTA_RE.test(smtpResult.smtpText ?? '')) {
      if (classifyRcpt5xx(smtpResult.smtpText, email) === 'unknown') {
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
  }

  // Переполненный ящик / превышенная квота (452 при exists===null, либо
  // «mailbox full»/«over quota» текст — в т.ч. 5xx при exists===false): ящик,
  // скорее всего, ЖИВ, но сейчас не принимает почту.
  // ТЕРМИНАЛЬНЫЙ unknown (step 'over_quota'): текст ошибки намеренно БЕЗ
  // «временн»/greylist-токенов — воркер НЕ должен ретраить (квота за минуты
  // ретрая не рассосётся), но и удалять адрес как invalid нельзя.
  if (smtpResult.code === 452 || RCPT_QUOTA_RE.test(smtpResult.smtpText ?? '')) {
    return {
      result: 'unknown', quality: 'risky',
      is_free: freeFlag, is_role: roleFlag, is_disposable: false, is_catch_all: isCatchAll,
      did_you_mean: didYouMean, mx_found: mxFound, smtp_code: smtpResult.code,
      details: { ...details, step: 'over_quota', smtp_text: smtpResult.smtpText },
      error: `Ящик переполнен или превышена квота (${smtpResult.code})`,
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
