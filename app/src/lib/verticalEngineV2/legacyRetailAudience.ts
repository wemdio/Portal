import { readVeAudienceScope, type VeAudienceScope } from './audienceScope';

export type VeRetailSourceProfile = 'material_manufacturers' | 'jewelry_manufacturers_or_chains';

interface LegacyRetailHypothesis {
  title: string;
  description?: string | null;
  origin?: 'generated' | 'manual';
  audience_scope?: VeAudienceScope | null;
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
  .replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
const normalizedSet = (values: readonly string[]) => [...new Set(values.map(normalize))].sort();
const sameSet = (first: readonly string[], second: readonly string[]) =>
  JSON.stringify(normalizedSet(first)) === JSON.stringify(normalizedSet(second));

/** Audited legacy generator output, not a rule for arbitrary retail hypotheses.
 * Match the complete description: a new region, exclusion or explicit condition
 * must not be silently discarded merely because the title still looks familiar.
 */
const corrections: ReadonlyArray<{
  profile: VeRetailSourceProfile;
  title: string;
  description: string;
  scope: VeAudienceScope;
}> = [{
  profile: 'material_manufacturers',
  title: 'Производители строительно-отделочных материалов',
  description: 'Заводы сухих смесей, напольных покрытий, плитки и ЛКМ с собственным шоурумом и интернет-магазином. Потеря прямых частных заказов при передаче их сторонним дилерам.',
  scope: {
    version: 1,
    kind: 'segment',
    any_of: [
      'Производители сухих строительных смесей',
      'Производители напольных покрытий',
      'Производители плитки',
      'Производители лакокрасочных материалов',
    ],
    required: [],
    excluded: [
      'Дилеры, дистрибьюторы и магазины без собственного производства целевых материалов',
      'Производители только промышленного оборудования, не производящие целевые материалы',
    ],
  },
}, {
  profile: 'jewelry_manufacturers_or_chains',
  title: 'Ювелирные заводы и сети украшений',
  description: 'Производители золотых и серебряных украшений с фирменной розницей и интернет-витриной. Сложность удержания клиента между покупками к праздничным датам.',
  scope: {
    version: 1,
    kind: 'segment',
    any_of: [
      'Производители ювелирных изделий из золота или серебра',
      'Розничные сети ювелирных украшений из золота или серебра',
    ],
    required: [],
    excluded: [
      'Компании, занимающиеся только ремонтом ювелирных изделий без производства или розничной сети',
      'Ломбарды и скупщики ювелирных изделий',
      'Производители и продавцы только бижутерии, без ювелирных изделий из золота или серебра',
    ],
  },
}];

/** Called only while freezing a new audience or an explicitly continued preview.
 * This returns a definition for the usual evidence gate, never an admission.
 * Manual and existing structured definitions always remain authoritative.
 */
export function deriveVeRetailAudienceScope(hypothesis: LegacyRetailHypothesis): VeAudienceScope | null {
  if (readVeAudienceScope(hypothesis.audience_scope) || hypothesis.origin !== 'generated') return null;
  const correction = corrections.find((entry) => normalize(entry.title) === normalize(hypothesis.title)
    && normalize(entry.description) === normalize(hypothesis.description ?? ''));
  return correction ? structuredClone(correction.scope) : null;
}

/** Source specialization is allowed only for the complete recognized activity
 * set. Unknown exclusions and every explicit requirement keep the scoped plan.
 * A mixed audience must never be rewritten to whichever retail branch matched.
 */
export function veRetailSourceProfileForScope(
  raw: VeAudienceScope | null | undefined,
  origin?: LegacyRetailHypothesis['origin'],
): VeRetailSourceProfile | null {
  const scope = readVeAudienceScope(raw);
  if (!scope || origin === 'manual' || scope.required.length) return null;
  return corrections.find((entry) => sameSet(scope.any_of, entry.scope.any_of)
    && scope.excluded.every((item) => entry.scope.excluded.some((known) => normalize(known) === normalize(item))))?.profile ?? null;
}
