/**
 * Per-provider pace of this proxy, i.e. of its egress IP (owner 2026-10-23:
 * «лимиты на адрес и провайдера в час… главное чтобы это сильно не замедлило
 * валидацию»). The probe IPs went to Spamhaus CSS after bursts of 12–22k checks
 * a day; a token bucket per provider smooths such bursts without slowing the
 * usual volume: the defaults are well above today's average load and only a
 * flood waits. A probe that cannot get a token within SMTP_PROVIDER_WAIT_MS is
 * refused with «rate limited by proxy»; the validator then tries another IP
 * and does not treat this one as blocked.
 *
 * SMTP_PROVIDER_HOURLY_LIMITS="microsoft=3600,google=7200,…" overrides the
 * defaults (0 = no limit). Hosts of no listed provider are not paced.
 */

export type ProbeProvider = 'microsoft' | 'google' | 'yandex' | 'mailru' | 'mimecast' | 'proofpoint';

const DEFAULT_HOURLY: Record<ProbeProvider, number> = {
  microsoft: 3600, google: 7200, yandex: 7200, mailru: 7200, mimecast: 1800, proofpoint: 1800,
};
const WAIT_MS = Number(process.env.SMTP_PROVIDER_WAIT_MS ?? '3000');
const REPORT_EVERY_MS = 5 * 60_000;

/** Same groups as the validator's smtpEgressKey (app/src/lib/emailValidation/validator.ts). */
export function probeProvider(mxHost: string): ProbeProvider | null {
  const host = mxHost.toLowerCase().replace(/\.$/, '');
  if (/\.protection\.outlook\.com$|(^|\.)(outlook|hotmail)\.com$/.test(host)) return 'microsoft';
  if (/(^|\.)(google|googlemail)\.com$|\.smtp\.goog$/.test(host)) return 'google';
  if (/(^|\.)yandex\.(ru|net|com)$/.test(host)) return 'yandex';
  if (/(^|\.)mail\.ru$/.test(host)) return 'mailru';
  if (/\.mimecast\.(com|co\.za)$/.test(host)) return 'mimecast';
  if (/\.(pphosted|ppe-hosted)\.com$/.test(host)) return 'proofpoint';
  return null;
}

export function hourlyLimits(raw = process.env.SMTP_PROVIDER_HOURLY_LIMITS ?? ''): Record<ProbeProvider, number> {
  const limits = { ...DEFAULT_HOURLY };
  for (const part of raw.split(',')) {
    const [name, value] = part.split('=').map((item) => item.trim().toLowerCase());
    const number = Number(value);
    if (name in limits && Number.isFinite(number) && number >= 0) limits[name as ProbeProvider] = number;
  }
  return limits;
}

type Bucket = { tokens: number; capacity: number; perMs: number; updated: number };

export function createPace(limits = hourlyLimits(), now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const buckets = new Map<ProbeProvider, Bucket>();
  const stats = new Map<ProbeProvider, { waited: number; refused: number }>();
  let reported = now();
  const bucket = (provider: ProbeProvider): Bucket | null => {
    const perHour = limits[provider];
    if (!perHour) return null;
    let b = buckets.get(provider);
    // Five minutes' worth of probes may go at once; the rest follows the hourly rate.
    if (!b) { b = { tokens: Math.max(10, Math.ceil(perHour / 12)), capacity: Math.max(10, Math.ceil(perHour / 12)), perMs: perHour / 3_600_000, updated: now() }; buckets.set(provider, b); }
    const t = now();
    b.tokens = Math.min(b.capacity, b.tokens + (t - b.updated) * b.perMs);
    b.updated = t;
    return b;
  };
  const count = (provider: ProbeProvider, key: 'waited' | 'refused') => {
    const s = stats.get(provider) ?? { waited: 0, refused: 0 };
    s[key] += 1;
    stats.set(provider, s);
    if (now() - reported >= REPORT_EVERY_MS) {
      reported = now();
      console.log(`[smtp-proxy] pace: ${[...stats].map(([p, v]) => `${p} waited ${v.waited}, refused ${v.refused}`).join('; ')}`);
      stats.clear();
    }
  };
  /** True when a probe to this MX may start now (after at most WAIT_MS). */
  return async function acquire(mxHost: string, waitMs = WAIT_MS): Promise<boolean> {
    const provider = probeProvider(mxHost);
    if (!provider) return true;
    const started = now();
    let waited = false;
    for (;;) {
      const b = bucket(provider);
      if (!b) return true;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        if (waited) count(provider, 'waited');
        return true;
      }
      const left = waitMs - (now() - started);
      if (left <= 0) { count(provider, 'refused'); return false; }
      waited = true;
      await sleep(Math.min(left, Math.max(20, Math.ceil((1 - b.tokens) / b.perMs))));
    }
  };
}
