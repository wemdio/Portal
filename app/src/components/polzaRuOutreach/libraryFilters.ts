/**
 * Поиск, фильтры, сортировка и пагинация для библиотек «Нашего автоаутрича».
 *
 * Чистые функции без React: список уже загружен целиком, всё считается на
 * клиенте, новых запросов к API не появляется. Вынесено из компонента, чтобы
 * правила (и особенно порог лидов) жили в одном месте и проверялись тестами.
 *
 * Дизайн: docs/superpowers/specs/2026-09-24-polza-ru-outreach-ux-design.md.
 */

export type Rec = Record<string, unknown> & { id: string };

/**
 * Кейс попадает в письмо 3 только от 8 лидов — то же правило, что в подсказке
 * библиотеки и в подборе кейса на бэкенде. Утверждённый кейс ниже порога
 * выглядит рабочим, но в письма не идёт, поэтому список помечает его отдельно.
 */
export const MIN_CASE_LEADS = 8;

export const PAGE_SIZE = 20;

export type SortKey = 'default' | 'leads_desc' | 'leads_asc' | 'name' | 'updated';

export interface ListQuery {
  /** Подстрока: ищем по полям из `searchFields`, регистр не важен. */
  query: string;
  /** Код статуса или '' — любой. */
  status: string;
  /** Отраслевая группа или '' — любая. Применима только к кейсам. */
  industry: string;
  sort: SortKey;
}

export const EMPTY_QUERY: ListQuery = { query: '', status: '', industry: '', sort: 'default' };

/** Число лидов у кейса; `null`, если не указано или записано мусором. */
export function leadsOf(rec: Rec): number | null {
  const raw = rec.leads_count;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Кейс утверждён, но в письма не пройдёт: лидов меньше порога или их нет.
 * Черновик сюда не попадает — он и так не участвует в подборе.
 */
export function isBelowLeadBar(rec: Rec): boolean {
  if (rec.status !== 'approved') return false;
  const leads = leadsOf(rec);
  return leads === null || leads < MIN_CASE_LEADS;
}

function textOf(rec: Rec, fields: readonly string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number') parts.push(String(v));
  }
  return parts.join(' ').toLowerCase();
}

function nameOf(rec: Rec): string {
  for (const key of ['public_name', 'sender_name', 'claim_text', 'title']) {
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function timeOf(rec: Rec): number {
  for (const key of ['updated_at', 'created_at']) {
    const v = rec[key];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

/** Сравнение с пустыми значениями всегда в конце списка — и по возрастанию, и по убыванию. */
function compareLeads(a: Rec, b: Rec, dir: 1 | -1): number {
  const la = leadsOf(a);
  const lb = leadsOf(b);
  if (la === null && lb === null) return 0;
  if (la === null) return 1;
  if (lb === null) return -1;
  return (la - lb) * dir;
}

export function applyListQuery(rows: readonly Rec[], q: ListQuery, searchFields: readonly string[]): Rec[] {
  const needle = q.query.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (needle && !textOf(r, searchFields).includes(needle)) return false;
    if (q.status && r.status !== q.status) return false;
    if (q.industry) {
      const groups = r.industry_groups;
      if (!Array.isArray(groups) || !groups.includes(q.industry)) return false;
    }
    return true;
  });

  switch (q.sort) {
    case 'leads_desc':
      return out.sort((a, b) => compareLeads(a, b, -1));
    case 'leads_asc':
      return out.sort((a, b) => compareLeads(a, b, 1));
    case 'name':
      return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ru'));
    case 'updated':
      return out.sort((a, b) => timeOf(b) - timeOf(a));
    default:
      return out;
  }
}

export interface Page<T> {
  rows: T[];
  /** Номер страницы после клампа — от 0. */
  page: number;
  totalPages: number;
  /** Индекс первой строки страницы в отфильтрованном списке. */
  from: number;
}

/**
 * Страница списка. `pageRaw` кламается: после удаления записей или смены
 * фильтра номер страницы может оказаться за пределами — тогда показываем
 * последнюю, а не пустой экран.
 */
export function paginate<T>(rows: readonly T[], pageRaw: number, size: number = PAGE_SIZE): Page<T> {
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(0, pageRaw), totalPages - 1);
  const from = page * size;
  return { rows: rows.slice(from, from + size), page, totalPages, from };
}
