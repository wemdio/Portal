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
    case 'enterprise_logos':
    case 'free_trial':
      // Tri-state booleans (see ExtractedData): true → "Да", false → "Нет",
      // undefined → DASH. Distinguishes "we checked, no enterprise/trial" from
      // "we couldn't tell" (sparse data, fetch failure).
      if (value === true) return 'Да';
      if (value === false) return 'Нет';
      return EMPTY_CELL_DASH;
    case 'cases_count':
    case 'vacancies_count':
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
    case 'hiring_roles':
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
    default:
      return EMPTY_CELL_DASH;
  }
}
