/**
 * Shared email validation utilities.
 *
 * Safe to import from both Next.js API routes and the worker process.
 * Does NOT use Node.js-specific modules (dns, net, etc.).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ValidationResult = {
  result: 'ok' | 'invalid' | 'disposable' | 'catch_all' | 'unknown';
  quality: 'good' | 'bad' | 'risky';
  is_free: boolean;
  is_role: boolean;
  is_disposable: boolean;
  is_catch_all: boolean;
  did_you_mean: string | null;
  mx_found: boolean;
  smtp_code: number;
  details: Record<string, unknown>;
  error?: string;
};

export type DomainInfo = {
  domain: string;
  mxHosts: string[];
  mxFound: boolean;
  isCatchAll: boolean | null;
  isDisposable: boolean;
  checkedAt: Date;
};

// ─── 1. Syntax Check ────────────────────────────────────────────────────────

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

export function checkSyntax(email: string): { valid: boolean; error?: string } {
  if (!email || email.length === 0) return { valid: false, error: 'Пустой email' };
  if (email.length > MAX_EMAIL_LENGTH) return { valid: false, error: `Длина превышает ${MAX_EMAIL_LENGTH} символов` };

  const atIndex = email.lastIndexOf('@');
  if (atIndex < 1) return { valid: false, error: 'Отсутствует символ @' };

  const local = email.substring(0, atIndex);
  const domain = email.substring(atIndex + 1);

  if (local.length > MAX_LOCAL_LENGTH) return { valid: false, error: `Локальная часть длиннее ${MAX_LOCAL_LENGTH} символов` };
  if (!domain || domain.length === 0) return { valid: false, error: 'Отсутствует домен' };
  if (!domain.includes('.')) return { valid: false, error: 'Домен без точки (нет TLD)' };

  const tld = domain.split('.').pop()!;
  if (tld.length < 2) return { valid: false, error: 'TLD слишком короткий' };

  if (local.startsWith('.') || local.endsWith('.')) return { valid: false, error: 'Точка в начале/конце локальной части' };
  if (local.includes('..')) return { valid: false, error: 'Двойная точка в локальной части' };

  if (!EMAIL_RE.test(email)) return { valid: false, error: 'Невалидный формат email' };

  return { valid: true };
}

// ─── 3. Disposable Provider Detection ───────────────────────────────────────

import disposableDomainsList from './disposableDomains.json';

const DISPOSABLE_DOMAINS = new Set(disposableDomainsList as string[]);

export function isDisposable(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

// ─── 4. Role Account Detection ──────────────────────────────────────────────

const ROLE_PREFIXES = new Set([
  'abuse','admin','administrator','billing','compliance','devnull','dns','ftp','hostmaster',
  'info','inoc','ispfeedback','ispsupport','list','list-request','maildaemon','mailerdaemon',
  'marketing','noc','no-reply','noreply','null','office','phish','phishing','postmaster',
  'privacy','registrar','root','sales','security','spam','support','sysadmin','tech',
  'undisclosed-recipients','unsubscribe','usenet','uucp','webmaster','www','hello',
  'contact','enquiry','enquiries','feedback','help','jobs','media','press','remove',
  'request','service','subscribe','all','everyone','staff','team','general',
  'zakupki','tender','zakaz','opt','priemnaya',
]);

export function isRole(local: string): boolean {
  return ROLE_PREFIXES.has(local.toLowerCase());
}

// ─── 5. Free Email Provider Detection ───────────────────────────────────────

const FREE_PROVIDERS = new Set([
  'gmail.com','yahoo.com','yahoo.co.uk','yahoo.co.in','yahoo.fr','yahoo.de','yahoo.it',
  'yahoo.es','yahoo.co.jp','yahoo.com.br','yahoo.com.au','yahoo.com.ar','yahoo.com.mx',
  'hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.de','hotmail.it','hotmail.es',
  'outlook.com','outlook.fr','outlook.de','outlook.it','outlook.es','outlook.co.uk',
  'live.com','live.co.uk','live.fr','live.de','live.nl','live.it',
  'msn.com','aol.com','aol.co.uk','protonmail.com','protonmail.ch','proton.me',
  'icloud.com','me.com','mac.com','zoho.com','zohomail.com',
  'mail.ru','bk.ru','inbox.ru','list.ru','internet.ru',
  'pochta.ru','ngs.ru','e1.ru','mail15.com',
  'yandex.ru','yandex.com','yandex.ua','yandex.by','ya.ru',
  'yandex.kz','yandex.uz','yandex.com.tr',
  'rambler.ru','lenta.ru','autorambler.ru','myrambler.ru','ro.ru',
  'gmx.com','gmx.de','gmx.net','gmx.at','gmx.ch',
  'web.de','t-online.de','freenet.de','arcor.de',
  'mail.com','email.com','usa.com','consultant.com','europe.com',
  'fastmail.com','fastmail.fm','tutanota.com','tutanota.de','tuta.io',
  'mailfence.com','disroot.org','riseup.net',
  'qq.com','163.com','126.com','sina.com','sohu.com','aliyun.com',
  'naver.com','daum.net','hanmail.net',
  'wp.pl','onet.pl','interia.pl','o2.pl','poczta.fm',
  'ukr.net','i.ua','meta.ua','bigmir.net',
  'abv.bg','dir.bg','gbg.bg',
  'centrum.cz','seznam.cz','email.cz','post.cz',
  'atlas.sk','azet.sk',
  'freemail.hu','citromail.hu','indamail.hu',
  'libero.it','virgilio.it','tiscali.it','alice.it','tin.it',
  'laposte.net','sfr.fr','free.fr','orange.fr','wanadoo.fr',
  'terra.com.br','bol.com.br','uol.com.br','ig.com.br',
  'rediffmail.com','sify.com',
]);

export function isFreeProvider(domain: string): boolean {
  return FREE_PROVIDERS.has(domain.toLowerCase());
}

// ─── 6. Typo Correction ────────────────────────────────────────────────────

const COMMON_DOMAINS = [
  'gmail.com','yahoo.com','hotmail.com','outlook.com','mail.ru','yandex.ru',
  'icloud.com','protonmail.com','aol.com','zoho.com','live.com','msn.com',
  'bk.ru','inbox.ru','list.ru','rambler.ru','ya.ru',
  'gmx.com','web.de','mail.com','fastmail.com',
  'qq.com','163.com','126.com',
];

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function suggestTypo(domain: string): string | null {
  const lower = domain.toLowerCase();
  if (COMMON_DOMAINS.includes(lower)) return null;

  let bestMatch: string | null = null;
  let bestDist = Infinity;

  for (const candidate of COMMON_DOMAINS) {
    const dist = levenshtein(lower, candidate);
    if (dist > 0 && dist <= 2 && dist < bestDist) {
      bestDist = dist;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

/**
 * Normalize an email: trim, lowercase.
 * Returns null for completely invalid inputs.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes('@')) return null;
  return trimmed.toLowerCase();
}
