import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';
import { veSourceStrategyKey } from './adaptiveCollection';

export type VeClinicSourceProfile = 'plastic_surgery' | 'osteopathy' | 'dental';

type Hypothesis = { title: string; description?: string | null; broad?: boolean | null };
const normalized = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[-‐–—]/g, ' ').replace(/\s+/g, ' ').trim();
const supportingBusiness = /постав|оборудован|материал|инструмент|производ|лаборатор|зуботех|ветеринар|рекрут|подбор|маркетинг|продвижен|консалтинг|разработ|обуч|учеб|школ|академ|курс|агентств|сервис|платформ|маркетплейс|дизайн|страхов|аутсорс|программ|приложен|дистрибьют|\b(?:crm|hr)\b/;
const plastic = /пластическ[а-я]*\s+хирург(?:и[яию]|ическ)/;
const osteopathy = /остеопат|мануальн[а-я]*\s+терап/;
const dental = /стоматолог|имплантац[а-я]*\s+зуб|зубн[а-я]*\s+клиник/;
const specialty: Record<VeClinicSourceProfile, RegExp> = { plastic_surgery: plastic, osteopathy, dental };
const excludesSpecialty = /(?:^|\s)(?:без|кроме|исключая|не)(?:\s|$)/;

function hasMixedAudience(value: string, profile: VeClinicSourceProfile): boolean {
  // Qualifiers after "с"/"для" do not name another audience. Coordinated
  // audiences must each name the same specialty; unknown ones keep the plan.
  const audience = value.split(/\s+(?:с|для)\s+/)[0];
  const parts = audience.split(/\s+(?:и|или|либо|а\s+также)\s+|[,;/&]/);
  return parts.length > 1 && parts.some((part) => !specialty[profile].test(part));
}

function detectOne(hypothesis: Hypothesis): VeClinicSourceProfile | null {
  const title = normalized(hypothesis.title);
  // The named audience establishes the source. Offers and aspirations in the
  // description must not turn another business into a specialist clinic.
  if (hypothesis.broad || supportingBusiness.test(title) || excludesSpecialty.test(title)
    || /(?:^|\s)(?:клиенты|пациенты|врачи|хирурги|стоматологи|остеопаты)(?:\s|$|[,()])/.test(title)) return null;
  const profiles = [plastic.test(title) && 'plastic_surgery', osteopathy.test(title) && 'osteopathy',
    dental.test(title) && 'dental'].filter(Boolean) as VeClinicSourceProfile[];
  if (profiles.length !== 1 || hasMixedAudience(title, profiles[0])) return null;
  // An explicitly mixed medical audience keeps the ordinary, broader plan.
  if (/косметолог|дерматолог|трихолог|многопрофиль|реабилитац|невролог|офтальмолог/.test(title)) return null;
  return profiles[0];
}

export function detectVeClinicSourceProfile(hypotheses: Hypothesis[]): VeClinicSourceProfile | null {
  if (!hypotheses.length) return null;
  const profile = detectOne(hypotheses[0]);
  return profile && hypotheses.every((hypothesis) => detectOne(hypothesis) === profile) ? profile : null;
}

/** A catalog rubric is a candidate source, not proof of a clinic's eligibility. */
export function veClinicRubricAllowed(profile: VeClinicSourceProfile, label: string): boolean {
  const value = normalized(label);
  if (supportingBusiness.test(value) || excludesSpecialty.test(value) || hasMixedAudience(value, profile)
    || /косметолог|дерматолог|трихолог|многопрофиль|реабилитац|невролог|офтальмолог/.test(value)) return false;
  if (profile === 'plastic_surgery') return plastic.test(value) && !osteopathy.test(value) && !dental.test(value);
  if (profile === 'osteopathy') return osteopathy.test(value) && !plastic.test(value) && !dental.test(value);
  return dental.test(value) && !plastic.test(value) && !osteopathy.test(value);
}

/** Mixed saved queries must never be mistaken for an exact specialty source. */
export function isVeClinicCatalogTask(task: VeCollectTask, profile: VeClinicSourceProfile): boolean {
  const queries = task.maps_query?.queries;
  return task.source === 'yandex_maps' && !!queries?.length && queries.every((query) => veClinicRubricAllowed(profile, query));
}

const QUERIES: Record<VeClinicSourceProfile, readonly string[]> = {
  plastic_surgery: ['пластическая хирургия', 'клиника пластической хирургии'],
  osteopathy: ['остеопатия', 'мануальная терапия'],
  dental: ['стоматология', 'стоматологическая клиника'],
};
// Only plain rubrics can be replaced safely: a free-form query may contain
// geography or another explicit constraint absent from maps_query.geo.
const genericClinicRubric = /^(?:медицински[йе]\s+центр[ы]?|клиник[аи]|косметология|дерматология|трихология|эстетическая\s+медицина|реабилитационный\s+центр)$/;

/** Fresh plans only: retain task count, geography, explicit filters and budgets.
 * Saved tasks own cursors and spend under their original scope keys. */
export function normalizeVeClinicSourcePlan(plan: VeSourcePlan, profile: VeClinicSourceProfile): {
  plan: VeSourcePlan; changed: boolean;
} {
  let changed = false;
  const exactKeys = new Set(plan.tasks.filter((task) => isVeClinicCatalogTask(task, profile)).map(veSourceStrategyKey));
  let tasks = plan.tasks.map((task) => {
    if (task.source !== 'yandex_maps' || !task.maps_query?.queries.length) return task;
    const queries = task.maps_query.queries.filter((query) => veClinicRubricAllowed(profile, query));
    if (!queries.length || queries.length === task.maps_query.queries.length) return task;
    const narrowed = { ...task, maps_query: { ...task.maps_query, queries } };
    const key = veSourceStrategyKey(narrowed);
    // Two pending tasks with one strategy key would both dispatch the same
    // page. Retain the mixed fallback if this exact scope already exists.
    if (exactKeys.has(key)) return task;
    exactKeys.add(key);
    changed = true;
    return narrowed;
  });
  if (!tasks.some((task) => isVeClinicCatalogTask(task, profile))) {
    const index = tasks.findIndex((task) => task.source === 'yandex_maps' && !!task.maps_query?.queries.length
      && task.maps_query.queries.every((query) => genericClinicRubric.test(normalized(query))));
    if (index !== -1) {
      const task = tasks[index];
      tasks[index] = { ...task, maps_query: { ...task.maps_query!,
        queries: QUERIES[profile].slice(0, task.maps_query!.queries.length) } };
      changed = true;
    }
  }
  const ordered = [...tasks.filter((task) => isVeClinicCatalogTask(task, profile)),
    ...tasks.filter((task) => !isVeClinicCatalogTask(task, profile))];
  if (ordered.some((task, index) => task !== tasks[index])) {
    tasks = ordered;
    changed = true;
  }
  return changed ? { plan: { ...plan, tasks }, changed } : { plan, changed };
}
