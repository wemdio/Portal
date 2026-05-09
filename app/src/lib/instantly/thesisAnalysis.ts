import type { Email } from './types';

// ─── Subject extractors ──────────────────────────────────────────────────────

export function subjectHasNumber(subject?: string | null): boolean {
  if (!subject) return false;
  return /\d/.test(subject);
}

export function subjectHasQuestion(subject?: string | null): boolean {
  if (!subject) return false;
  return /\?/.test(subject);
}

export function countWords(text?: string | null): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `text` mentions a person's name as a whole-word match (case-insensitive).
 * Uses Unicode-aware boundaries (works for Cyrillic). Empty/null name returns false.
 */
export function mentionsName(text: string, name?: string | null): boolean {
  if (!text || !name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  // \b doesn't work reliably for Cyrillic; use lookarounds for non-letter boundaries.
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegex(trimmed)}(?=$|[^\\p{L}\\p{N}_])`,
    'iu',
  );
  return re.test(text);
}

const COMPANY_SUFFIXES = [
  'inc', 'inc.', 'llc', 'llc.', 'ltd', 'ltd.', 'corp', 'corp.', 'co', 'co.',
  'gmbh', 'plc', 'sa', 's.a.', 'oy', 'ab', 'pte',
  'ооо', 'оао', 'зао', 'пао', 'ао', 'ип',
];

function normalizeCompany(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/[",.()]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = s.split(' ').filter((p) => !COMPANY_SUFFIXES.includes(p));
  return parts.join(' ').trim();
}

/**
 * True if `text` mentions a company name (case-insensitive, suffix-stripped).
 * Matches "Acme" in "Acme Inc on the news" when looking up "Acme Inc.".
 */
export function mentionsCompany(text: string, company?: string | null): boolean {
  if (!text || !company) return false;
  const norm = normalizeCompany(company);
  if (norm.length < 2) return false;
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegex(norm)}(?=$|[^\\p{L}\\p{N}_])`,
    'iu',
  );
  return re.test(text);
}

// ─── Body extractors ─────────────────────────────────────────────────────────

const COMMON_ACRONYMS = ['e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'st.'];

/**
 * Counts sentences split by . ! ? while masking common acronyms.
 * Returns 0 for empty, and at least 1 for any non-empty text without terminators.
 */
export function countSentences(text?: string | null): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let masked = trimmed.toLowerCase();
  for (const acr of COMMON_ACRONYMS) {
    masked = masked.split(acr).join(acr.replace(/\./g, '∎'));
  }
  const parts = masked.split(/[.!?]+/).map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length || 1;
}

const TIMELINE_PATTERNS: RegExp[] = [
  /\bin\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
  /\bwithin\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
  /за\s+\d+\s+(дн|дней|нед|недел|месяц)/i,
  /через\s+\d+\s+(дн|дней|нед|недел|месяц)/i,
];

export function bodyHasTimelineHook(text?: string | null): boolean {
  if (!text) return false;
  return TIMELINE_PATTERNS.some((re) => re.test(text));
}

const CTA_PATTERNS = [
  /\bcall\b.*\?/i,
  /\bchat\b.*\?/i,
  /\bdemo\b.*\?/i,
  /worth\b.*\?/i,
  /\bопен\b.*\?/i,
  /созвонимся\??/i,
  /встрет(имся|иться)/i,
  /15[\s-]?(min|minute|минут)/i,
  /\b30[\s-]?(min|minute|минут)/i,
];

export function hasCtaQuestion(text?: string | null): boolean {
  if (!text) return false;
  return CTA_PATTERNS.some((re) => re.test(text));
}

export function hasNumber(text?: string | null): boolean {
  if (!text) return false;
  return /\d/.test(text);
}

// ─── Heuristic personalization (no lead-context required) ────────────────────

const NEUTRAL_AUDIENCE_WORDS = new Set([
  'team', 'there', 'all', 'everyone', 'folks', 'colleagues',
  'команда', 'коллеги', 'друзья',
]);

const EN_GREETINGS = '(?:hi|hey|hello|dear|good\\s+morning|good\\s+afternoon)';
const RU_GREETINGS = '(?:привет|здравствуй(?:те)?|добр(?:ый|ое|ого)\\s+(?:день|утро|вечер))';

const GREETING_NAME_RE = new RegExp(
  `^\\s*(?:${EN_GREETINGS}|${RU_GREETINGS})[\\s,]+(?:mr\\.|ms\\.|mrs\\.|dr\\.|г-н|г-жа)?\\s*([\\p{Lu}][\\p{L}'’-]{1,20})`,
  'iu',
);

/**
 * True if `text` starts with a greeting (EN/RU) followed by a capitalized
 * name-like token that is NOT a generic audience word like "team" / "there" / "all".
 */
export function greetingWithCapitalizedName(text?: string | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  const m = trimmed.match(GREETING_NAME_RE);
  if (!m) return false;
  const name = (m[1] ?? '').toLowerCase();
  if (!name) return false;
  if (NEUTRAL_AUDIENCE_WORDS.has(name)) return false;
  // Reject if the greeting/name part isn't actually capitalized in the original.
  // The first capture is captured as written; ensure first letter is upper.
  const original = m[1] ?? '';
  return /^[\p{Lu}]/u.test(original);
}

/**
 * Check the first ~200 chars (the greeting zone) for a personalized greeting.
 */
export function bodyHasFirstNameGreeting(text?: string | null): boolean {
  if (!text) return false;
  const head = text.trim().slice(0, 200);
  return greetingWithCapitalizedName(head);
}

/** True if a template has a `{{variable}}` placeholder (intended personalization). */
export function hasTemplateVariable(text?: string | null): boolean {
  if (!text) return false;
  return /\{\{\s*[\w.-]+\s*\}\}/.test(text);
}

/** Counts distinct {{variables}} in the template. */
export function countTemplateVariables(text?: string | null): number {
  if (!text) return 0;
  const set = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) set.add(m[1].toLowerCase());
  return set.size;
}

// ─── Threading ───────────────────────────────────────────────────────────────

/**
 * Groups emails by thread_id. Falls back to "lead:<lead_id>" key if thread_id missing.
 */
export function groupEmailsByThread(emails: Email[]): Map<string, Email[]> {
  const map = new Map<string, Email[]>();
  for (const e of emails) {
    const key = e.thread_id || (e.lead ? `lead:${e.lead}` : `orphan:${e.id}`);
    const arr = map.get(key) || [];
    arr.push(e);
    map.set(key, arr);
  }
  return map;
}

function tsOf(e: Email): string {
  return e.timestamp_email ?? e.timestamp_created ?? '';
}

/**
 * Returns the 1-based step number for a sent email (ue_type=1) within its thread,
 * counting only sent emails ordered chronologically. Non-sent emails return 0.
 */
export function inferStepNumber(target: Email, threadEmails: Email[]): number {
  if (target.ue_type !== 1) return 0;
  const sent = threadEmails
    .filter((e) => e.ue_type === 1)
    .sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : 0));
  const idx = sent.findIndex((e) => e.id === target.id);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * True if any lead reply (ue_type=2) appears strictly after the sent email's timestamp,
 * in the same thread.
 */
export function didEmailGetReply(sent: Email, threadEmails: Email[]): boolean {
  const sentTs = tsOf(sent);
  if (!sentTs) return false;
  return threadEmails.some(
    (e) => e.ue_type === 2 && tsOf(e) > sentTs,
  );
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
 */
function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

export type ZTestResult = {
  z: number | null;
  pValue: number | null;
  rate1: number;
  rate2: number;
  lift: number | null;
};

/**
 * Two-proportion Z-test (pooled). Returns z statistic and two-tailed p-value.
 */
export function proportionsZTest(s1: number, n1: number, s2: number, n2: number): ZTestResult {
  if (n1 <= 0 || n2 <= 0) {
    return { z: null, pValue: null, rate1: 0, rate2: 0, lift: null };
  }
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const pooled = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const lift = p2 > 0 ? (p1 - p2) / p2 : null;
  if (se === 0) return { z: null, pValue: null, rate1: p1, rate2: p2, lift };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue, rate1: p1, rate2: p2, lift };
}

/**
 * Wilson score interval for a proportion.
 */
export function wilsonInterval(s: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = s / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Returns the index of the bucket [edges[i], edges[i+1]) containing value.
 * Last bucket is open: values >= edges[last-1] go into the last index.
 * Returns -1 if value < edges[0].
 */
export function bucketize(value: number, edges: number[]): number {
  if (edges.length < 2) return -1;
  if (value < edges[0]) return -1;
  for (let i = 0; i < edges.length - 1; i++) {
    if (value < edges[i + 1]) return i;
  }
  return edges.length - 2;
}

// ─── Aggregators ─────────────────────────────────────────────────────────────

export type FeatureBucketStats = {
  n: number;
  successes: number;
  rate: number;
  ci: [number, number];
};

export type BinaryFeatureAnalysis = {
  withFeature: FeatureBucketStats;
  withoutFeature: FeatureBucketStats;
  lift: number | null;
  zTest: ZTestResult;
};

export function analyzeBinaryFeature<T>(
  items: T[],
  getFlag: (i: T) => boolean,
  getOutcome: (i: T) => boolean,
): BinaryFeatureAnalysis {
  let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
  for (const it of items) {
    const flag = getFlag(it);
    const ok = getOutcome(it);
    if (flag) {
      n1++;
      if (ok) s1++;
    } else {
      n2++;
      if (ok) s2++;
    }
  }
  const z = proportionsZTest(s1, n1, s2, n2);
  return {
    withFeature: {
      n: n1,
      successes: s1,
      rate: n1 ? s1 / n1 : 0,
      ci: wilsonInterval(s1, n1),
    },
    withoutFeature: {
      n: n2,
      successes: s2,
      rate: n2 ? s2 / n2 : 0,
      ci: wilsonInterval(s2, n2),
    },
    lift: z.lift,
    zTest: z,
  };
}

export type Bucket = {
  index: number;
  label: string;
  n: number;
  successes: number;
  rate: number;
  ci: [number, number];
};

export function analyzeBucketed<T>(
  items: T[],
  getValue: (i: T) => number,
  getOutcome: (i: T) => boolean,
  edges: number[],
  labels?: string[],
): Bucket[] {
  const k = edges.length - 1;
  const counts = Array.from({ length: k }, () => ({ n: 0, s: 0 }));
  for (const it of items) {
    const v = getValue(it);
    const idx = bucketize(v, edges);
    if (idx < 0) continue;
    counts[idx].n++;
    if (getOutcome(it)) counts[idx].s++;
  }
  return counts.map((c, i) => ({
    index: i,
    label: labels?.[i] ?? `[${edges[i]}, ${edges[i + 1]})`,
    n: c.n,
    successes: c.s,
    rate: c.n ? c.s / c.n : 0,
    ci: wilsonInterval(c.s, c.n),
  }));
}
