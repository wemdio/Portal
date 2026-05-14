/**
 * Shared formatter that turns one extractor's typed output into a
 * spreadsheet-friendly string. Used by both:
 *   - server-side `applySignalJobResults` (final write after job completes)
 *   - client-side polling in `DatabaseSpreadsheet` (live updates while running)
 *
 * Keeping a single implementation prevents drift between the two surfaces
 * (DRY) — if we change how prices or hiring roles render, both sides update
 * together.
 */
import type { ExtractorKey } from '@/lib/enrich/extractors/types';

export function formatExtraValue(key: ExtractorKey, value: unknown): string {
  if (value === undefined || value === null) return '';

  switch (key) {
    case 'customers':
    case 'integrations':
    case 'case_industries':
      return Array.isArray(value) ? value.filter((s) => typeof s === 'string').join(', ') : '';
    case 'enterprise_logos':
    case 'free_trial':
      return value === true ? 'Да' : '';
    case 'cases_count':
    case 'vacancies_count':
    case 'team_size':
      return typeof value === 'number' && value > 0 ? String(value) : '';
    case 'founded_year':
      return typeof value === 'number' ? String(value) : '';
    case 'pricing_model': {
      if (typeof value !== 'string' || value === 'unknown') return '';
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
      return typeof value === 'string' ? value : '';
    case 'pricing_min':
      if (typeof value === 'object' && value !== null && 'value' in value && 'currency' in value) {
        const v = value as { value: number; currency: string };
        return `${v.value} ${v.currency}`;
      }
      return '';
    case 'hiring_roles':
      if (typeof value === 'object' && value !== null) {
        const r = value as { marketing?: boolean; engineering?: boolean; sales?: boolean; design?: boolean; product?: boolean };
        const parts: string[] = [];
        if (r.engineering) parts.push('инженеры');
        if (r.marketing) parts.push('маркетинг');
        if (r.sales) parts.push('продажи');
        if (r.design) parts.push('дизайн');
        if (r.product) parts.push('продукт');
        return parts.join(', ');
      }
      return '';
    default:
      return '';
  }
}
