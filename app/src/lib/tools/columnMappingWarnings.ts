/**
 * Чистые (client-safe) эвристики для проверки СОДЕРЖИМОГО сопоставленных колонок
 * в «Конструкторе базы». Цель — поймать неправильный маппинг ДО долгого прогона,
 * показав предупреждение прямо на этапе настройки.
 *
 * Класс проблем, который это закрывает (оба реальных случая 2026-06-17):
 *   - «сайт» = ссылки на hh.ru → обогащение скрейпит hh.ru (антибот) → мусор;
 *   - «сайт» = email-адреса → «Проверка сайтов» сносит все строки → пустая база;
 *   - «компания» = сайты → «Очистить названия» чистит URL вместо имени.
 *
 * Только ПРЕДУПРЕЖДАЕТ (ничего не блокирует). Порог 50% «не той» формы выбран так,
 * чтобы НЕ ругаться на нормальные колонки (тест это фиксирует).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmailValue(raw: string): boolean {
  return EMAIL_RE.test((raw ?? '').trim());
}

/** Ссылка/домен hh.ru (вакансия или работодатель), в т.ч. поддомены/протокол. */
export function isHhUrlValue(raw: string): boolean {
  return /(?:^|\/\/|\.)hh\.ru(?:\/|$)/i.test((raw ?? '').trim());
}

/** Похоже на сайт: непустое, без '@', есть домен вида name.tld (вкл. .рф). */
export function isSiteValue(raw: string): boolean {
  const v = (raw ?? '').trim();
  if (!v || v.includes('@')) return false;
  return /\.[a-zа-яё]{2,}(?:[/?:#]|$)/.test(v.toLowerCase());
}

type CellKind = 'email' | 'hh' | 'site' | 'other';

function classify(v: string): CellKind {
  if (isEmailValue(v)) return 'email';
  if (isHhUrlValue(v)) return 'hh'; // hh.ru — тоже URL, но считаем отдельно
  if (isSiteValue(v)) return 'site';
  return 'other';
}

export type MappingRole = 'company' | 'site' | 'email';

export interface MappingContentWarning {
  role: MappingRole;
  roleLabel: string;
  column: string;
  message: string;
  /** Несколько примеров значений из колонки — для наглядности в UI. */
  sample: string[];
}

const ROLE_LABELS: Record<MappingRole, string> = {
  company: 'Название компании',
  site: 'Сайт / домен',
  email: 'Email',
};

const SAMPLE_LIMIT = 60; // сколько строк сэмплируем для оценки формы
const MIN_VALUES = 5; // не судим по слишком маленькой выборке
const MISMATCH = 0.5; // ≥50% «не той» формы ⇒ предупреждаем

function colIndex(header: string[], colName: string): number {
  const target = (colName ?? '').trim().toLowerCase();
  return header.map((h) => (h ?? '').trim().toLowerCase()).indexOf(target);
}

/**
 * Возвращает предупреждения по содержимому сопоставленных колонок.
 * `mapping` — это `{ company?: colName, site?: colName, email?: colName }`
 * (как columnMapping в BaseConstructorView). `rows` — строки данных без header.
 */
export function getMappingContentWarnings(
  header: string[],
  rows: string[][],
  mapping: Record<string, string>,
): MappingContentWarning[] {
  const out: MappingContentWarning[] = [];
  if (!header || header.length === 0) return out;
  const sampleRows = rows.slice(0, SAMPLE_LIMIT);

  for (const role of ['company', 'site', 'email'] as const) {
    const column = mapping[role];
    if (!column) continue;
    const idx = colIndex(header, column);
    if (idx < 0) continue;

    const values = sampleRows.map((r) => (r[idx] ?? '').trim()).filter(Boolean);
    if (values.length < MIN_VALUES) continue;

    const counts: Record<CellKind, number> = { email: 0, hh: 0, site: 0, other: 0 };
    for (const v of values) counts[classify(v)] += 1;
    const total = values.length;
    const frac = (n: number) => n / total;
    const sample = values.slice(0, 3);
    const push = (message: string) =>
      out.push({ role, roleLabel: ROLE_LABELS[role], column, message, sample });

    if (role === 'site') {
      if (frac(counts.hh) >= MISMATCH) {
        push('в колонке ссылки на hh.ru — их нельзя обогатить (антибот), описания/почты выйдут пустыми. Похоже, выбрана не та колонка: нужен НАСТОЯЩИЙ сайт компании.');
      } else if (frac(counts.email) >= MISMATCH) {
        push('в колонке email-адреса, а не сайты. «Проверка сайтов» удалит все строки — проверьте сопоставление.');
      } else if (frac(counts.site + counts.hh) < 0.2) {
        push('значения не похожи на сайты/домены. Проверьте, что выбрана колонка с сайтом.');
      }
    } else if (role === 'company') {
      if (frac(counts.site + counts.hh) >= MISMATCH) {
        push('в колонке сайты/ссылки, а не названия — «Очистить названия» будет чистить URL вместо имени компании.');
      } else if (frac(counts.email) >= MISMATCH) {
        push('в колонке email-адреса, а не названия компаний.');
      }
    } else {
      // email
      if (frac(counts.email) < 0.3) {
        push('значения не похожи на email-адреса. Проверьте сопоставление колонки Email.');
      }
    }
  }

  return out;
}
