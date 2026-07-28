/**
 * Превью финальных писем шаблона 85/15 по лидам из загруженной базы.
 *
 * Чистая подстановка {{operators}} значениями колонок строки — без LLM и без
 * внешних вызовов. Сегментные варианты (letters[].segment_variants) НЕ
 * выбираются автоматически: их `when` — человекочитаемое условие, поэтому
 * превью всегда рендерит дефолтный body, а варианты показываются в UI отдельно.
 *
 * Правила подстановки (зеркалят рендер Instantly):
 *  - matched-маппинг: берём значение row[column] (строкифицированное, trimmed);
 *  - matched + пустая/отсутствующая ячейка → пустая строка: Instantly рендерит
 *    существующую пустую переменную как '', никогда — как литерал {{var}}.
 *    Такой оператор попадает в emptyVars (отдельно от unresolved). Ветки
 *    «matched + пусто → fallback» здесь сознательно нет: боевой пайплайн не
 *    проставляет fallback у matched-маппингов, и превью не должно показывать
 *    подстановку, которой в Instantly не будет;
 *  - unmatched-оператор с fallback → подставляется fallback (как обещает
 *    таблица маппинга «Подставим: …»), токен kind='fallback';
 *  - unmatched без fallback и операторы вне маппинга → как есть + unresolved.
 */

import type { HeOperatorMapping } from './types';

/**
 * Тот же регексп операторов, что и в stages/template (байт-в-байт).
 * Экспортирован для UI-подсветки (OperatorText), чтобы подсветка совпадала
 * с продакшн-экстракцией операторов. Флаг g: split/matchAll клонируют регексп,
 * общий lastIndex не мутируется.
 */
export const OPERATOR_RE = /\{\{\s*([A-Za-zА-Яа-яЁё0-9_.-]+)\s*\}\}/g;

/** Колонки-кандидаты для подписи лида (lowercase, в порядке приоритета). */
const LABEL_COLUMNS = ['companyname', 'company', 'компания'];

export interface HePreviewLead {
  subject: string;
  body: string;
  wait_days: number;
  /** Имена операторов (без скобок), которые не удалось подставить. */
  unresolved: string[];
  /**
   * Имена matched-операторов, подставленных пустой строкой (колонка есть,
   * ячейка пуста). Отдельно от unresolved: это не ошибка маппинга, а пустые
   * данные у лида.
   */
  emptyVars: string[];
}

export interface HePreviewResult {
  rows: Array<{ rowLabel: string; letters: HePreviewLead[] }>;
}

/**
 * Токен разметки превью для UI-подсветки: подставленные значения (value)
 * отдельно от неразрешённых операторов (unresolved, текст как в шаблоне)
 * и запасного текста (fallback — unmatched-оператор с fallback из маппинга).
 */
export interface HePreviewToken {
  text: string;
  kind: 'text' | 'value' | 'fallback' | 'unresolved';
  /** Имя оператора (без скобок) для kind value/fallback/unresolved. */
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

type ResolvedOperator =
  /** value с empty=true — matched-маппинг, но ячейка пуста (Instantly → ''). */
  | { kind: 'value'; text: string; empty?: boolean }
  /** fallback — unmatched-оператор, у которого в маппинге задан fallback. */
  | { kind: 'fallback'; text: string }
  | { kind: 'unresolved' };

function resolveOperator(
  name: string,
  mapping: Map<string, HeOperatorMapping>,
  row: Record<string, unknown>,
): ResolvedOperator {
  const m = mapping.get(name.toLowerCase());
  if (m && m.matched && m.column) {
    const value = stringifyCell(row[m.column]);
    if (value) return { kind: 'value', text: value };
    // Колонка есть, ячейка пуста → Instantly подставит пустую строку, а не
    // литерал {{var}}. Fallback matched-маппинга здесь НЕ применяется: боевой
    // пайплайн (stages/template) не проставляет fallback у matched-маппингов,
    // и превью не должно показывать подстановку, которой в рассылке не будет.
    return { kind: 'value', text: '', empty: true };
  }
  if (m && !m.matched) {
    const fallback = (m.fallback ?? '').trim();
    if (fallback) return { kind: 'fallback', text: fallback };
  }
  return { kind: 'unresolved' };
}

/**
 * Разбивает текст письма на токены с подстановкой операторов по строке базы.
 * Используется UI для подсветки; unresolved/emptyVars — имена операторов
 * (дедуплицированы регистронезависимо, в порядке появления, первое написание).
 */
export function tokenizePreviewText(
  text: string,
  operatorMapping: HeOperatorMapping[],
  row: Record<string, unknown>,
): { tokens: HePreviewToken[]; unresolved: string[]; emptyVars: string[] } {
  const mapping = indexMapping(operatorMapping);
  const tokens: HePreviewToken[] = [];
  const unresolved: string[] = [];
  const emptyVars: string[] = [];
  const seenUnresolved = new Set<string>();
  const seenEmpty = new Set<string>();
  let last = 0;
  for (const match of text.matchAll(OPERATOR_RE)) {
    const idx = match.index;
    if (idx > last) tokens.push({ text: text.slice(last, idx), kind: 'text' });
    const name = (match[1] ?? '').trim();
    const resolved = resolveOperator(name, mapping, row);
    if (resolved.kind === 'value') {
      tokens.push({ text: resolved.text, kind: 'value', operator: name });
      if (resolved.empty) {
        const key = name.toLowerCase();
        if (!seenEmpty.has(key)) {
          seenEmpty.add(key);
          emptyVars.push(name);
        }
      }
    } else if (resolved.kind === 'fallback') {
      tokens.push({ text: resolved.text, kind: 'fallback', operator: name });
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
  return { tokens, unresolved, emptyVars };
}

/**
 * Подпись лида. Сначала маппинг: matched-оператор companyName/company указывает
 * на реальную колонку базы — так работают и русскоязычные реестры
 * («Название компании»). Затем — колонки-кандидаты LABEL_COLUMNS, в конце «Лид N».
 */
function previewRowLabel(
  row: Record<string, unknown>,
  columns: string[],
  operatorMapping: HeOperatorMapping[],
  index: number,
): string {
  for (const m of operatorMapping) {
    if (!m.matched || !m.column) continue;
    const op = m.operator.toLowerCase();
    if (op !== 'companyname' && op !== 'company') continue;
    const value = stringifyCell(row[m.column]);
    if (value) return value;
  }
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

/** Слияние списков операторов с регистронезависимым дедупом (первое написание). */
function mergeOperatorNames(first: string[], second: string[]): string[] {
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
      rowLabel: previewRowLabel(row, input.columns, input.operatorMapping, index),
      letters: input.letters.map((letter) => {
        const subject = tokenizePreviewText(letter.subject ?? '', input.operatorMapping, row);
        const body = tokenizePreviewText(letter.body ?? '', input.operatorMapping, row);
        return {
          subject: flattenTokens(subject.tokens),
          body: flattenTokens(body.tokens),
          wait_days: letter.wait_days ?? 0,
          unresolved: mergeOperatorNames(subject.unresolved, body.unresolved),
          emptyVars: mergeOperatorNames(subject.emptyVars, body.emptyVars),
        };
      }),
    })),
  };
}
