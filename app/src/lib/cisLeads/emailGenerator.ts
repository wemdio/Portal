/**
 * TASK 7.2 — Генерация email по шаблонам.
 * Шаблоны: name@domain, n.surname@domain, first.last@domain и т.д.
 * Проверка валидности формата (опционально — проверка через API в другом модуле).
 */

const LOCAL_PART_RE = /^[a-zA-Z0-9._%+-]+$/;
const MAX_LOCAL_LEN = 64;

export interface EmailCandidate {
  email: string;
  pattern: string;
}

/**
 * Нормализует имя/фамилию для подстановки в шаблон: латиница, lowercase, убрать лишнее.
 */
function toSlug(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-zа-яёa-z0-9\s]/g, '')
    .replace(/\s+/g, '');
}

/**
 * Транслитерация кириллицы в латиницу для email (упрощённая).
 */
function transliterate(cyrillic: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return cyrillic
    .split('')
    .map((c) => map[c] ?? (c.match(/[a-z0-9]/i) ? c.toLowerCase() : ''))
    .join('');
}

function toLatinSlug(name: string | null | undefined): string {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  const cyrillic = raw.replace(/\s+/g, ' ').toLowerCase();
  const hasCyrillic = /[а-яё]/.test(cyrillic);
  const slug = hasCyrillic ? transliterate(cyrillic) : toSlug(raw);
  return slug.replace(/[^a-z0-9]/g, '');
}

/**
 * Генерирует кандидатов email по имени, фамилии и домену.
 * Шаблоны: first@domain, last@domain, first.last@domain, f.last@domain, first.l@domain, n.surname (n = first letter).
 */
export function generateCandidateEmails(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  domain: string | null | undefined,
): EmailCandidate[] {
  const d = String(domain ?? '').trim().toLowerCase();
  if (!d || d.includes(' ') || !d.includes('.')) return [];

  const first = toLatinSlug(firstName);
  const last = toLatinSlug(lastName);
  const f = first.charAt(0);
  const l = last.charAt(0);

  const candidates: EmailCandidate[] = [];
  const add = (local: string, pattern: string) => {
    if (!local || local.length > MAX_LOCAL_LEN) return;
    const email = `${local}@${d}`;
    if (LOCAL_PART_RE.test(local)) candidates.push({ email, pattern });
  };

  if (first) add(first, 'first');
  if (last) add(last, 'last');
  if (first && last) {
    add(`${first}.${last}`, 'first.last');
    add(`${first}_${last}`, 'first_last');
    add(`${first}${last}`, 'firstlast');
  }
  if (f && last) add(`${f}.${last}`, 'n.surname');
  if (f && l) add(`${f}${last}`, 'n surname');
  if (first && l) add(`${first}.${l}`, 'first.l');

  return candidates;
}

/**
 * Генерирует кандидатов из полного имени (Full Name) и домена.
 * Разбивает fullName на first/last по первому пробелу или по 2+ словам.
 */
export function generateCandidateEmailsFromFullName(
  fullName: string | null | undefined,
  domain: string | null | undefined,
): EmailCandidate[] {
  const parts = String(fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return [];
  const firstName = parts[0] ?? '';
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
  return generateCandidateEmails(firstName, lastName, domain);
}

/**
 * Проверка формата email (RFC-подобный). Не проверяет доставляемость.
 */
export function isValidEmailFormat(email: string | null | undefined): boolean {
  const s = String(email ?? '').trim();
  if (!s || s.length > 254) return false;
  const idx = s.indexOf('@');
  if (idx <= 0 || idx >= s.length - 1) return false;
  const local = s.slice(0, idx);
  const domain = s.slice(idx + 1);
  if (local.length > MAX_LOCAL_LEN) return false;
  return LOCAL_PART_RE.test(local) && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain);
}
