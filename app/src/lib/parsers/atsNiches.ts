// Niche presets for the ATS parser, shared by the client form and the server
// runner. Each `match` is a case-insensitive RegExp source tested against job
// titles. Free-text from the form overrides the preset (see resolveAtsMatch).

export type AtsNicheKey =
  | 'marketing_sales'
  | 'fleet_logistics'
  | 'it_dev'
  | 'finance'
  | 'hr_recruiting';

export interface AtsNiche {
  key: AtsNicheKey;
  label: string;
  /** RegExp source (compiled case-insensitive) matched against job titles. */
  match: string;
}

export const ATS_NICHES: AtsNiche[] = [
  {
    key: 'marketing_sales',
    label: 'Маркетинг и продажи',
    match:
      'marketing|marketer|growth|demand gen|lead gen|product marketing|brand|content|seo|sem|ppc|paid|gtm|\\bb2b\\b|business development|account executive|sales development|sales manager|sales lead|enterprise sales|partnerships?|channel sales|revenue|\\bsdr\\b|\\bbdr\\b',
  },
  {
    key: 'fleet_logistics',
    label: 'Флот и логистика',
    match:
      'fleet|logistics|\\bdriver\\b|dispatch|supply chain|warehouse|transportation|freight|courier|last mile',
  },
  {
    key: 'it_dev',
    label: 'Разработка и IT',
    match:
      'engineer|developer|programmer|devops|software|backend|frontend|full[ -]?stack|data scientist|machine learning|platform|\\bsre\\b|\\bqa\\b',
  },
  {
    key: 'finance',
    label: 'Финансы',
    match: 'finance|financial|accounting|accountant|controller|fp&a|treasury|payroll|bookkeep',
  },
  {
    key: 'hr_recruiting',
    label: 'HR и рекрутинг',
    match: '\\bhr\\b|human resources|recruit|talent|sourcer|hrbp|people ops',
  },
];

const NICHE_BY_KEY = new Map<string, AtsNiche>(ATS_NICHES.map((n) => [n.key, n]));

export function nicheLabel(key: string | undefined | null): string {
  if (!key) return '';
  return NICHE_BY_KEY.get(key)?.label ?? key;
}

/**
 * RegExp source for filtering job titles. A non-empty `customMatch` (free text)
 * wins over the niche preset; otherwise the preset; otherwise marketing/sales.
 */
export function resolveAtsMatch(niche?: string | null, customMatch?: string | null): string {
  const custom = (customMatch ?? '').trim();
  if (custom) {
    // Treat free text as comma/semicolon/newline-separated keywords, escaped so
    // a stray character can't produce an invalid RegExp.
    const parts = custom
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (parts.length) return parts.join('|');
  }
  const preset = niche ? NICHE_BY_KEY.get(niche) : undefined;
  return (preset ?? ATS_NICHES[0]).match;
}
