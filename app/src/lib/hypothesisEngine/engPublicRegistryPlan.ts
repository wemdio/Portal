import { createHash } from 'node:crypto';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { engCountryIso2, normalizeEngCountry } from './engCountries';
import type { HeEngRegistryPlan, HeEngRegistryProvider, HeEngRegistryTask } from './engPublicRegistryTypes';

/** Closed catalogue: a source can only run a reviewed, sector-specific query. */
export const HE_ENG_REGISTRY_CATEGORIES: Readonly<Record<HeEngRegistryProvider, readonly string[]>> = {
  brreg: ['58.29', '62', '64', '65', '66', '86.10', '86.2', '86.23', '49.41', '41', '55.10', '28'],
  france: ['58.29A', '58.29B', '58.29C', '62.01Z', '62.02A', '64.19Z', '65.12Z', '66.19B', '66.30Z', '86.10Z', '86.21Z', '86.23Z', '49.41A', '49.41B', '41.20B', '55.10Z', '28.99B'],
  companies_house: ['58290', '62012', '62020', '64191', '64192', '65120', '66190', '66300', '86101', '86210', '86230', '49410', '41201', '41202', '55100', '28990'],
  fdic: ['banks'],
  nppes: ['Dentist', 'Clinic/Center', 'General Acute Care Hospital', 'Clinical Medical Laboratory'],
  fmcsa: ['freight_carriers'],
};

const PROVIDER_ISO: Readonly<Record<HeEngRegistryProvider, string>> = {
  brreg: 'no', france: 'fr', companies_house: 'gb', fdic: 'us', nppes: 'us', fmcsa: 'us',
};
const MAX_TASKS = 120;
type Sector = { match: RegExp; omit?: RegExp; sources: Partial<Record<HeEngRegistryProvider, readonly string[]>> };
// Official classifications: Brreg SN, INSEE NAF rev.2, Companies House condensed
// SIC, CMS taxonomy. These are discovery categories, not evidence of suitability.
const SECTORS: readonly Sector[] = [
  { match: /\b(?:software (?:vendors?|companies|developers?|providers?|products?|publishers?|publishing)|saas|it (?:services?|companies|consultanc(?:y|ies))|cloud (?:platform|software) vendors?)\b/i,
    // Standard software publishers are explicitly outside NAF 62.01Z.
    sources: { brreg: ['58.29', '62'], france: ['58.29A', '58.29B', '58.29C', '62.01Z', '62.02A'], companies_house: ['58290', '62012', '62020'] } },
  { match: /\b(?:banks?|banking institutions|credit institutions|building societies)\b/i,
    // Custody specialists do not authorize scanning every retail/commercial bank.
    omit: /\b(?:custodian|custodial|custody|depositary|depository)[ -]+banks?\b/gi,
    sources: { brreg: ['64'], france: ['64.19Z'], companies_house: ['64191', '64192'], fdic: ['banks'] } },
  { match: /\b(?:fund (?:services?|administrators?|administration)|custodians?|depositar(?:y|ies)|transfer agents?|investor services?|mancos?)\b/i,
    sources: { brreg: ['66'], france: ['66.19B', '66.30Z'], companies_house: ['66190', '66300'] } },
  { match: /\b(?:(?:asset|wealth|investment|fund) manag(?:ers?|ement)|investment advisers?|investment advisors?)\b/i,
    sources: { brreg: ['66'], france: ['66.30Z'], companies_house: ['66300'] } },
  { match: /\b(?:insurers?|reinsurers?|insurance (?:carriers?|companies))\b/i,
    sources: { brreg: ['65'], france: ['65.12Z'], companies_house: ['65120'] } },
  { match: /\b(?:dentists?|dental (?:clinics?|practices?|groups?|offices?))\b/i,
    sources: { brreg: ['86.23'], france: ['86.23Z'], companies_house: ['86230'], nppes: ['Dentist'] } },
  { match: /\bhospitals?\b/i,
    sources: { brreg: ['86.10'], france: ['86.10Z'], companies_house: ['86101'], nppes: ['General Acute Care Hospital'] } },
  { match: /\b(?:(?:medical|outpatient|healthcare|primary care) (?:clinics?|cent(?:er|re)s?|practices?)|physician groups)\b/i,
    sources: { brreg: ['86.2'], france: ['86.21Z'], companies_house: ['86210'], nppes: ['Clinic/Center'] } },
  { match: /\b(?:clinical|medical|diagnostic) laborator(?:y|ies)\b/i,
    sources: { nppes: ['Clinical Medical Laboratory'] } },
  { match: /\b(?:trucking|road (?:freight|haulage)|freight carriers?|haulage (?:companies|operators)|truck (?:fleets?|operators?))\b/i,
    sources: { brreg: ['49.41'], france: ['49.41A', '49.41B'], companies_house: ['49410'], fmcsa: ['freight_carriers'] } },
  { match: /\b(?:construction (?:companies|contractors|firms)|building contractors|general contractors)\b/i,
    sources: { brreg: ['41'], france: ['41.20B'], companies_house: ['41201', '41202'] } },
  { match: /\b(?:hotels?|hotel (?:groups?|chains?|operators?))\b/i,
    sources: { brreg: ['55.10'], france: ['55.10Z'], companies_house: ['55100'] } },
  { match: /\b(?:machinery (?:manufacturers?|companies)|industrial equipment manufacturers?)\b/i,
    sources: { brreg: ['28'], france: ['28.99B'], companies_house: ['28990'] } },
];

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function fields(task: HeEngRegistryTask): unknown[] {
  return [task.provider, task.country, task.category, task.minEmployees ?? null, task.maxEmployees ?? null];
}
function taskId(scopeKey: string, task: HeEngRegistryTask): string { return hash([scopeKey, ...fields(task)]).slice(0, 24); }
function fingerprint(scopeKey: string, tasks: readonly HeEngRegistryTask[]): string {
  // Arrays deliberately survive PostgreSQL JSONB's object-key reordering.
  return hash([1, scopeKey, tasks.map(task => [task.id, ...fields(task)])]);
}
function audienceClause(raw: string | undefined): string {
  const clause = sliceWholeChars(stripUnstorableJsonChars(raw ?? ''), 0, 1000).replace(/https?:\S+|\S+@\S+/gi, ' ')
    .replace(/^(?:these are|targets? (?:are|include)|companies include)\s+/i, '')
    .split(/\b(?:with|where|whose|which|that|serving|serve|helping|help|selling|sold|providing|for|to|using|used|needing|seeking|targeting|supporting|focused)\b|[.;]/i)[0];
  // An exclusion is not another buyer category. Keep affirmative clauses,
  // including "not banks but software companies" and "not only ... but also".
  // For an ambiguous trailing exclusion, ordinary search can recover candidates;
  // never turn its excluded industry into a new registry scan.
  return clause
    .replace(/\(\s*(?:not(?!\s+only\b)|no|without|exclud(?:e[sd]?|ing)|except)\b[^)]*\)/gi, ' ')
    .replace(/\bnon-[a-z]+\b/gi, ' ')
    .split(/\bbut(?:\s+(?:also|instead))?\b/i)
    .map(part => part.split(/\b(?:not(?!\s+only\b)|no|without|exclud(?:e[sd]?|ing)|except|other\s+than|rather\s+than|instead\s+of)\b/i)[0])
    .join(' ');
}

export function createHeEngRegistryPlan(input: {
  scopeKey: string;
  hypotheses: ReadonlyArray<{ title: string; description?: string }>;
  allowedCountries: readonly string[];
  employeeRange?: { min: number; max: number | null };
}): HeEngRegistryPlan {
  if (!input.scopeKey || input.scopeKey.length > 256 || stripUnstorableJsonChars(input.scopeKey) !== input.scopeKey ||
    !input.hypotheses.length || !input.allowedCountries.length) {
    throw new Error('ENG registries require a scope, selected hypotheses and explicit countries.');
  }
  const range = input.employeeRange;
  if (range && (!Number.isSafeInteger(range.min) || range.min < 0 ||
    (range.max !== null && (!Number.isSafeInteger(range.max) || range.max < range.min)))) {
    throw new Error('ENG registry employee range is invalid.');
  }
  const countries = [...new Set(input.allowedCountries.map(raw => {
    const country = normalizeEngCountry(raw);
    if (!country) throw new Error('ENG registry country is unsupported.');
    return country;
  }))].sort();
  const terms = input.hypotheses.slice(0, 20).flatMap(h => [audienceClause(h.title), audienceClause(h.description)]);
  const selections = new Set<string>();
  for (const sector of SECTORS) if (terms.some(term => sector.match.test(sector.omit ? term.replace(sector.omit, '') : term))) {
    for (const [provider, categories] of Object.entries(sector.sources)) {
      for (const category of categories) selections.add(`${provider}:${category}`);
    }
  }
  const tasks: HeEngRegistryTask[] = [];
  for (const country of countries) for (const selected of [...selections].sort()) {
    const [provider, category] = selected.split(':') as [HeEngRegistryProvider, string];
    if (PROVIDER_ISO[provider] !== engCountryIso2(country)) continue;
    const task: HeEngRegistryTask = { id: '', provider, country, category,
      ...(range ? { minEmployees: range.min, ...(range.max !== null ? { maxEmployees: range.max } : {}) } : {}) };
    task.id = taskId(input.scopeKey, task);
    tasks.push(task);
  }
  if (tasks.length > MAX_TASKS) throw new Error('ENG registry plan is too large.');
  const plan: HeEngRegistryPlan = { version: 1, scopeKey: input.scopeKey, fingerprint: fingerprint(input.scopeKey, tasks), tasks };
  validateHeEngRegistryPlan(plan, input.scopeKey);
  return plan;
}

export function validateHeEngRegistryTask(task: HeEngRegistryTask): void {
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
    Object.keys(task).some(key => !['id', 'provider', 'country', 'category', 'minEmployees', 'maxEmployees'].includes(key)) ||
    typeof task.id !== 'string' || !/^[a-f0-9]{24}$/.test(task.id) ||
    !Object.hasOwn(HE_ENG_REGISTRY_CATEGORIES, task.provider) ||
    !HE_ENG_REGISTRY_CATEGORIES[task.provider].includes(task.category) ||
    normalizeEngCountry(task.country) !== task.country || engCountryIso2(task.country) !== PROVIDER_ISO[task.provider] ||
    (task.minEmployees !== undefined && (!Number.isSafeInteger(task.minEmployees) || task.minEmployees < 0)) ||
    (task.maxEmployees !== undefined && (!Number.isSafeInteger(task.maxEmployees) || task.maxEmployees < (task.minEmployees ?? 0)))) {
    throw new Error('ENG registry task is invalid.');
  }
}

export function validateHeEngRegistryPlan(plan: HeEngRegistryPlan, scopeKey: string): void {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== 4 ||
    plan.version !== 1 || plan.scopeKey !== scopeKey || !scopeKey || scopeKey.length > 256 || stripUnstorableJsonChars(scopeKey) !== scopeKey ||
    !Array.isArray(plan.tasks) || plan.tasks.length > MAX_TASKS) throw new Error('ENG registry plan is invalid.');
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    validateHeEngRegistryTask(task);
    if (task.id !== taskId(scopeKey, task) || seen.has(task.id)) throw new Error('ENG registry task identity is invalid.');
    seen.add(task.id);
  }
  if (plan.fingerprint !== fingerprint(scopeKey, plan.tasks)) throw new Error('ENG registry plan fingerprint is invalid.');
}
