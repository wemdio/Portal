/**
 * Shared formatter that turns one extractor's typed output into a
 * spreadsheet-friendly string. Used by both:
 *   - server-side `applySignalJobResults` (final write after job completes)
 *   - client-side polling in `DatabaseSpreadsheet` (live updates while running)
 *
 * Keeping a single implementation prevents drift between the two surfaces
 * (DRY) — if we change how prices or hiring roles render, both sides update
 * together.
 *
 * Contract (per user requirement): no cell may be empty. Any "we didn't
 * find a value" path renders as DASH ("–", en-dash). Booleans are
 * tri-state: true → "Да", false → "Нет", undefined/null → DASH — this
 * preserves the difference between "confident no" and "we couldn't tell".
 */
import type { ExtractorKey } from '@/lib/enrich/extractors/types';

/** Renderer for the "nothing here" cell. Never use '' for an extra column — the
 *  user requirement is that every cell is filled. Exported so the applier can
 *  use the same character when failing-row extras are written. */
export const EMPTY_CELL_DASH = '–';

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

export function formatExtraValue(key: ExtractorKey, value: unknown): string {
  // Universal "nothing to show" guard — catches every extractor whose result
  // never landed (undefined) or was explicitly empty (null).
  if (value === undefined || value === null) return EMPTY_CELL_DASH;

  switch (key) {
    case 'customers':
    case 'integrations':
    case 'case_industries': {
      const items = nonEmptyStrings(value);
      return items.length > 0 ? items.join(', ') : EMPTY_CELL_DASH;
    }
    case 'social_media':
    case 'event_geo': {
      // Списки строк рендерятся одинаково — через запятую. social_media это
      // нормализованные URL'ы найденных соцсетей; event_geo — список городов
      // ("Москва, Санкт-Петербург, Казань") где у HoReCa-компании есть точки.
      const items = nonEmptyStrings(value);
      return items.length > 0 ? items.join(', ') : EMPTY_CELL_DASH;
    }
    case 'event_opening_summary':
    case 'event_redesign_summary':
    case 'event_renovation_summary':
    case 'event_geo_summary':
      // Каждая summary-колонка — короткая LLM-выжимка (1-2 предложения).
      // Если парная сигнал-колонка вернулась "Нет"/DASH, summary тоже DASH —
      // нет смысла показывать выжимку события, которого не было.
      return typeof value === 'string' && value.trim().length > 0
        ? value
        : EMPTY_CELL_DASH;
    case 'enterprise_logos':
    case 'free_trial':
    case 'event_opening':
    case 'event_redesign':
    case 'event_renovation':
      // Tri-state booleans (see ExtractedData): true → "Да", false → "Нет",
      // undefined → DASH. Distinguishes "we checked, no enterprise/trial" from
      // "we couldn't tell" (sparse data, fetch failure). Event signals follow
      // the same contract — Да when LLM found an opening / rebrand / renovation
      // post, Нет when LLM saw the posts but found no such signal, DASH when
      // we had nothing to analyze (no social posts + no blog).
      if (value === true) return 'Да';
      if (value === false) return 'Нет';
      return EMPTY_CELL_DASH;
    case 'cases_count':
      // number — точное; строка «N+» — оценка LLM; 0/пусто → DASH.
      if (typeof value === 'number') return value > 0 ? String(value) : EMPTY_CELL_DASH;
      if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : EMPTY_CELL_DASH;
      return EMPTY_CELL_DASH;
    case 'vacancies_count':
      // number — точное; строка «N+» — оценка LLM; 0/пусто → DASH.
      if (typeof value === 'number') return value > 0 ? String(value) : EMPTY_CELL_DASH;
      if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : EMPTY_CELL_DASH;
      return EMPTY_CELL_DASH;
    case 'team_size':
      // 0 = "we didn't find any" → DASH, not "0". A real published "у нас 0
      // открытых вакансий" is rare and not worth distinguishing.
      return typeof value === 'number' && value > 0 ? String(value) : EMPTY_CELL_DASH;
    case 'founded_year':
      // A year of 0 / NaN / out-of-range is "didn't find it" — DASH.
      return typeof value === 'number' && value >= 1800 && value <= 2100
        ? String(value)
        : EMPTY_CELL_DASH;
    case 'pricing_model': {
      if (typeof value !== 'string' || value === 'unknown') return EMPTY_CELL_DASH;
      const modelLabels: Record<string, string> = {
        'self-serve': 'Самообслуживание',
        'sales-led': 'Через продажи',
        'enterprise': 'Энтерпрайз',
        'freemium': 'Фримиум',
      };
      return modelLabels[value] ?? value;
    }
    case 'blog_last_post':
    case 'stack':
    case 'profile':
    case 'client_segment':
      return typeof value === 'string' && value.trim().length > 0
        ? value
        : EMPTY_CELL_DASH;
    case 'pricing_min':
      if (typeof value === 'object' && value !== null && 'value' in value && 'currency' in value) {
        const v = value as { value: number; currency: string };
        if (typeof v.value === 'number' && v.value > 0 && typeof v.currency === 'string' && v.currency.length > 0) {
          return `${v.value} ${v.currency}`;
        }
      }
      return EMPTY_CELL_DASH;
    case 'hiring_roles': {
      // Two shapes since the 09.06 industrial-segment rewrite:
      //   - NEW: string[] of top-5 concrete profession names extracted from
      //     vacancy titles ("Лифтёры, Монтажники, Диспетчеры"). The applier
      //     stores them in result_text under hiring_roles for backward-compat
      //     with the existing column key in the spreadsheet.
      //   - LEGACY: object {marketing/engineering/sales/design/product} of
      //     booleans, from runs before the rewrite. Render with the old RU
      //     labels so historical xlsx exports stay stable.
      const items = nonEmptyStrings(value);
      if (items.length > 0) return items.join(', ');
      if (typeof value === 'object' && value !== null) {
        const r = value as { marketing?: boolean; engineering?: boolean; sales?: boolean; design?: boolean; product?: boolean };
        const parts: string[] = [];
        if (r.engineering) parts.push('инженеры');
        if (r.marketing) parts.push('маркетинг');
        if (r.sales) parts.push('продажи');
        if (r.design) parts.push('дизайн');
        if (r.product) parts.push('продукт');
        return parts.length > 0 ? parts.join(', ') : EMPTY_CELL_DASH;
      }
      return EMPTY_CELL_DASH;
    }
    default:
      return EMPTY_CELL_DASH;
  }
}
