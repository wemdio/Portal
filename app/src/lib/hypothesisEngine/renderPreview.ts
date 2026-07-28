/**
 * Превью финальных писем шаблона 85/15 по лидам из загруженной базы.
 *
 * Чистая подстановка {{operators}} значениями колонок строки — без LLM и без
 * внешних вызовов. Сегментные варианты (letters[].segment_variants) НЕ
 * выбираются автоматически: их `when` — человекочитаемое условие, поэтому
 * превью всегда рендерит дефолтный body, а варианты показываются в UI отдельно.
 *
 * Правила подстановки:
 *  - matched-маппинг: берём значение row[column] (строкифицированное, trimmed);
 *  - пустое/отсутствующее значение → fallback маппинга, если он задан;
 *  - иначе оператор остаётся как есть ({{var}}) и записывается в unresolved;
 *  - unmatched-операторы (и операторы вне маппинга) → как есть + unresolved.
 */

import type { HeOperatorMapping } from './types';

/** Тот же регексп операторов, что и в stages/template. */
const OPERATOR_RE = /\{\{\s*([A-Za-zА-Яа-яЁё0-9_.-]+)\s*\}\}/g;

/** Колонки-кандидаты для подписи лида (lowercase, в порядке приоритета). */
const LABEL_COLUMNS = ['companyname', 'company', 'компания'];

export interface HePreviewLead {
  subject: string;
  body: string;
  wait_days: number;
  /** Имена операторов (без скобок), которые не удалось подставить. */
  unresolved: string[];
}

export interface HePreviewResult {
  rows: Array<{ rowLabel: string; letters: HePreviewLead[] }>;
}

/**
 * Токен разметки превью для UI-подсветки: подставленные значения (value)
 * отдельно от неразрешённых операторов (unresolved, текст как в шаблоне).
 */
export interface HePreviewToken {
  text: string;
  kind: 'text' | 'value' | 'unresolved';
  /** Имя оператора (без скобок) для kind value/unresolved. */
  operator?: string;
}

/** Строка ячейки базы: не-строки строкифицируются, результат trim. */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function indexMapping(
  operatorMapping: HeOperatorMapping[],
): Map<string, HeOperatorMapping> {
  const map = new Map<string, HeOperatorMapping>();
  for (const m of operatorMapping) {
    const key = m.operator.toLowerCase();
    if (!map.has(key)) map.set(key, m);
  }
  return map;
}

function resolveOperator(
  name: string,
  mapping: Map<string, HeOperatorMapping>,
  row: Record<string, unknown>,
): { kind: 'value'; text: string } | { kind: 'unresolved' } {
  const m = mapping.get(name.toLowerCase());
  if (m && m.matched && m.column) {
    const value = stringifyCell(row[m.column]);
    if (value) return { kind: 'value', text: value };
    const fallback = (m.fallback ?? '').trim();
    if (fallback) return { kind: 'value', text: fallback };
  }
  return { kind: 'unresolved' };
}

/**
 * Разбивает текст письма на токены с подстановкой операторов по строке базы.
 * Используется UI для подсветки; unresolved — имена неразрешённых операторов
 * (дедуплицированы регистронезависимо, в порядке появления).
 */
export function tokenizePreviewText(
  text: string,
  operatorMapping: HeOperatorMapping[],
  row: Record<string, unknown>,
): { tokens: HePreviewToken[]; unresolved: string[] } {
  const mapping = indexMapping(operatorMapping);
  const tokens: HePreviewToken[] = [];
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();
  let last = 0;
  for (const match of text.matchAll(OPERATOR_RE)) {
    const idx = match.index;
    if (idx > last) tokens.push({ text: text.slice(last, idx), kind: 'text' });
    const name = (match[1] ?? '').trim();
    const resolved = resolveOperator(name, mapping, row);
    if (resolved.kind === 'value') {
      tokens.push({ text: resolved.text, kind: 'value', operator: name });
    } else {
      tokens.push({ text: match[0], kind: 'unresolved', operator: name });
      const key = name.toLowerCase();
      if (!seenUnresolved.has(key)) {
        seenUnresolved.add(key);
        unresolved.push(name);
      }
    }
    last = idx + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: 'text' });
  return { tokens, unresolved };
}

/** Подпись лида: первая непустая из колонок companyName/company/компания, иначе «Лид N». */
function previewRowLabel(
  row: Record<string, unknown>,
  columns: string[],
  index: number,
): string {
  const keys = [...columns, ...Object.keys(row)];
  for (const candidate of LABEL_COLUMNS) {
    // Колонок, отличающихся только регистром («Компания»/«компания»), может быть
    // несколько — берём первую с непустым значением.
    for (const key of keys) {
      if (key.toLowerCase() !== candidate) continue;
      const value = stringifyCell(row[key]);
      if (value) return value;
    }
  }
  return `Лид ${index + 1}`;
}

function flattenTokens(tokens: HePreviewToken[]): string {
  return tokens.map((t) => t.text).join('');
}

function mergeUnresolved(first: string[], second: string[]): string[] {
  const seen = new Set(first.map((n) => n.toLowerCase()));
  const out = [...first];
  for (const name of second) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Превью писем по первым maxRows строкам базы (по умолчанию 3).
 * Рендерится дефолтный текст писем; сегментные варианты сознательно игнорируются.
 */
export function renderTemplatePreview(input: {
  letters: Array<{
    subject: string | null;
    body: string;
    wait_days: number;
    segment_variants?: Array<{ when: string; text: string }>;
  }>;
  operatorMapping: HeOperatorMapping[];
  rows: Array<Record<string, unknown>>;
  columns: string[];
  maxRows?: number;
}): HePreviewResult {
  const maxRows = Math.max(0, input.maxRows ?? 3);
  const rows = input.rows.slice(0, maxRows);
  return {
    rows: rows.map((row, index) => ({
      rowLabel: previewRowLabel(row, input.columns, index),
      letters: input.letters.map((letter) => {
        const subject = tokenizePreviewText(letter.subject ?? '', input.operatorMapping, row);
        const body = tokenizePreviewText(letter.body ?? '', input.operatorMapping, row);
        return {
          subject: flattenTokens(subject.tokens),
          body: flattenTokens(body.tokens),
          wait_days: letter.wait_days ?? 0,
          unresolved: mergeUnresolved(subject.unresolved, body.unresolved),
        };
      }),
    })),
  };
}
