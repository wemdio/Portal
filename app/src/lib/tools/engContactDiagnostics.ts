import { createHash } from 'node:crypto';
import type { EngContactDiagnostics } from '@/lib/enrich/emailScraper';

export interface EngContactFindRow {
  row: number;
  companyKey: string;
  host: string;
  reason: string;
  emailsStored: number;
  crawl?: EngContactDiagnostics;
}

export interface EngContactValidationRow {
  row: number;
  companyKey: string;
  host: string;
  emails: number;
  statuses: Record<string, number>;
  reasons: Record<string, number>;
  retained?: boolean;
}

/** Operational diagnostics only: never contain mailbox values or response bodies. */
export interface EngContactCollectionDiagnostics {
  version: 1;
  strategy: 'eng_contact_first';
  find?: {
    inputRows: number;
    complete: boolean;
    rows: EngContactFindRow[];
    omittedRows: number;
  };
  validation?: {
    inputRows: number;
    outputRows?: number;
    /** Identifies an already filtered durable grid after a worker restart. */
    outputFingerprint?: string;
    complete: boolean;
    uniqueEmails: number;
    statuses: Record<string, number>;
    reasons: Record<string, number>;
    rows: EngContactValidationRow[];
    omittedRows: number;
  };
}

export interface EngContactDiagnosticOptions {
  contactPageStrategy?: 'eng_contact_first';
  initialContactDiagnostics?: EngContactCollectionDiagnostics;
  onContactDiagnostics?: (value: EngContactCollectionDiagnostics) => Promise<void>;
}

export const ENG_CONTACT_DIAGNOSTIC_ROW_LIMIT = 5000;
export function engEmailValidationReason(result: string, error: string, step?: unknown): string {
  if (result === 'invalid') {
    if (step === 'mx') return 'no_mx';
    if (step === 'syntax') return 'invalid_syntax';
    if (step === 'smtp') return 'smtp_rejected';
  }
  if (result === 'unknown' || result === 'error') {
    if (step === 'mx' || /dns/i.test(error)) return 'dns_unconfirmed';
    if (/политик|policy|egress.*reject/i.test(error)) return 'smtp_policy_refused';
    if (/catch.all/i.test(error)) return 'catch_all_unconfirmed';
    if (/greylist|временным отказом/i.test(error)) return 'greylisted';
    if (/timeout|timed out|таймаут/i.test(error)) return 'smtp_timeout';
    if (/не удалось подключиться|connect|mx.сервер/i.test(error)) return 'smtp_connection_failed';
    if (/quota|квот|переполнен/i.test(error)) return 'mailbox_quota';
  }
  return result;
}
// Same JSONB text cleanup as the worker's sanitizeRowsForJsonb. Fingerprints
// must match its durable grid, including descriptions containing control chars.
const HASH_UNSAFE_CHARS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\uFFFE\uFFFF]', 'g');
export function engContactGridFingerprint(data: string[][]): string {
  const canonical = data.map((row) => row.map((cell) => {
    if (typeof cell !== 'string') return cell;
    return Array.from(cell.replace(HASH_UNSAFE_CHARS, ''), (char) => {
      const n = char.charCodeAt(0);
      return char.length === 1 && n >= 0xd800 && n <= 0xdfff ? ' ' : char;
    }).join('');
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
const count = (v: unknown): number => typeof v === 'number' && Number.isFinite(v)
  ? Math.max(0, Math.floor(v)) : 0;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const code = (v: unknown): string => typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v)
  ? v : 'unknown';
const counts = (v: unknown): Record<string, number> => Object.fromEntries(
  Object.entries(obj(v)).slice(0, 32).filter(([k]) => code(k) === k).map(([k, n]) => [k, count(n)]),
);

export function engContactIdentity(company: string, website: string) {
  let host = '';
  try {
    host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`)
      .hostname.toLowerCase().replace(/^www\./, '').slice(0, 253);
  } catch { /* Missing/malformed URLs remain identifiable by the opaque key. */ }
  return {
    host,
    companyKey: createHash('sha256').update(`${company.trim().toLowerCase()}\0${host}`).digest('hex').slice(0, 24),
  };
}

function safeUrl(v: unknown): string {
  try {
    const u = new URL(String(v));
    if (!['https:', 'http:'].includes(u.protocol)) return '';
    // Paths can contain addresses/tokens too; diagnostics need the page path,
    // not query values, credentials, fragments or email-looking path segments.
    let decodedPath = u.pathname;
    try { decodedPath = decodeURIComponent(decodedPath); } catch { /* Keep a bounded malformed path. */ }
    const path = decodedPath.replace(/[^/]*@[^/]*/g, '[redacted]').slice(0, 256);
    return `${u.protocol}//${u.host}${path}`;
  } catch { return ''; }
}

/** Reconstruct an allowlisted bounded snapshot rather than spreading DB JSON. */
export function sanitizeEngContactDiagnostics(value: unknown): EngContactCollectionDiagnostics | undefined {
  const v = obj(value);
  if (v.version !== 1 || v.strategy !== 'eng_contact_first') return undefined;
  const out: EngContactCollectionDiagnostics = { version: 1, strategy: 'eng_contact_first' };
  const identity = (r: Record<string, unknown>) => ({
    row: count(r.row),
    companyKey: typeof r.companyKey === 'string' && /^[a-f0-9]{24}$/.test(r.companyKey) ? r.companyKey : '',
    host: typeof r.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(r.host) ? r.host : '',
  });
  const find = obj(v.find);
  if (Array.isArray(find.rows)) {
    out.find = {
      inputRows: count(find.inputRows), complete: find.complete === true,
      omittedRows: count(find.omittedRows) + Math.max(0, find.rows.length - ENG_CONTACT_DIAGNOSTIC_ROW_LIMIT),
      rows: find.rows.slice(0, ENG_CONTACT_DIAGNOSTIC_ROW_LIMIT).map((value) => {
        const r = obj(value);
        const row: EngContactFindRow = {
          ...identity(r), reason: code(r.reason), emailsStored: count(r.emailsStored),
        };
        const c = obj(r.crawl);
        if (c.version === 1 && c.strategy === 'eng_contact_first' && Array.isArray(c.pages)) {
          row.crawl = {
            version: 1, strategy: 'eng_contact_first', maxPages: count(c.maxPages),
            maxAttempts: count(c.maxAttempts), attempts: count(c.attempts),
            stopReason: code(c.stopReason) as EngContactDiagnostics['stopReason'],
            pagesRead: count(c.pagesRead), emailsFound: count(c.emailsFound), rawEmailsFound: count(c.rawEmailsFound),
            ...(c.failure ? { failure: code(c.failure) as EngContactDiagnostics['failure'] } : {}),
            pages: c.pages.slice(0, 12).map((value) => {
              const p = obj(value);
              return {
                url: safeUrl(p.url), ...(p.finalUrl ? { finalUrl: safeUrl(p.finalUrl) } : {}),
                kind: code(p.kind), source: code(p.source), outcome: code(p.outcome),
                route: p.route === 'proxy' ? 'proxy' : 'direct',
                emailsFound: count(p.emailsFound),
                ...(typeof p.status === 'number' ? { status: count(p.status) } : {}),
                ...(p.failure ? { failure: code(p.failure) } : {}),
              } as EngContactDiagnostics['pages'][number];
            }),
          };
        }
        return row;
      }),
    };
  }
  const validation = obj(v.validation);
  if (Array.isArray(validation.rows)) {
    out.validation = {
      inputRows: count(validation.inputRows), complete: validation.complete === true,
      ...(typeof validation.outputRows === 'number' ? { outputRows: count(validation.outputRows) } : {}),
      ...(typeof validation.outputFingerprint === 'string' && /^[a-f0-9]{64}$/.test(validation.outputFingerprint)
        ? { outputFingerprint: validation.outputFingerprint } : {}),
      uniqueEmails: count(validation.uniqueEmails), statuses: counts(validation.statuses), reasons: counts(validation.reasons),
      omittedRows: count(validation.omittedRows) + Math.max(0, validation.rows.length - ENG_CONTACT_DIAGNOSTIC_ROW_LIMIT),
      rows: validation.rows.slice(0, ENG_CONTACT_DIAGNOSTIC_ROW_LIMIT).map((value) => {
        const r = obj(value);
        return {
          ...identity(r), emails: count(r.emails), statuses: counts(r.statuses), reasons: counts(r.reasons),
          ...(typeof r.retained === 'boolean' ? { retained: r.retained } : {}),
        };
      }),
    };
  }
  return out;
}
