import { veSourceStrategyKey } from './adaptiveCollection';
import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';

export type VeMediaSourceProfile = 'games_animation' | 'streaming_tv';
type Hypothesis = { title: string; description?: string | null; broad?: boolean | null };
const normalized = (value: string) => value.toLowerCase().replace(/ё/g, 'е')
  .replace(/[-‐–—]/g, ' ').replace(/\s+/g, ' ').trim();

const audience: Record<VeMediaSourceProfile, RegExp> = {
  games_animation: /^(?:игровые издатели|анимационные студии|владельцы ip)$/,
  streaming_tv: /^(?:онлайн кинотеатры|телеканалы|видеоплатформы)$/,
};
const qualifier: Record<VeMediaSourceProfile, string> = {
  games_animation: 'титрами, ui, мерчем и промо',
  streaming_tv: 'большим объемом промо, титров, постеров и интерфейсов',
};
const offer: Record<VeMediaSourceProfile, string> = {
  games_animation: 'шрифт помогает создать узнаваемый мир и локализовать кириллицу',
  streaming_tv: 'нужна узнаваемая экранная типографика',
};

/** Only these explicitly selected, narrow audiences opt in. A parent's media
 * vertical, the client's offer, a broad hypothesis or an unknown mix cannot. */
export function detectVeMediaSourceProfile(input: { market: string; hypotheses: Hypothesis[] }): VeMediaSourceProfile | null {
  if (input.market !== 'ru' || input.hypotheses.length !== 1 || input.hypotheses[0].broad !== false) return null;
  const hypothesis = input.hypotheses[0], title = normalized(hypothesis.title);
  const profile = title === 'игры и анимация' ? 'games_animation' : title === 'стриминги и тв' ? 'streaming_tv' : null;
  if (!profile) return null;
  if (hypothesis.description?.trim()) {
    const description = normalized(hypothesis.description);
    const sentences = description.split(/\.\s*/).filter(Boolean);
    // Only known qualifiers/offers may be skipped. Unknown text after "с"
    // can name another audience, including inside parentheses or a new clause.
    if (!sentences.length || sentences.slice(1).some((sentence) => sentence !== offer[profile])) return null;
    const clauses = sentences[0].split(/\s+с\s+/);
    if (clauses.length > 2 || (clauses.length === 2 && clauses[1] !== qualifier[profile])) return null;
    const buyers = clauses[0].split(/\s+(?:и|или)\s+|\s*[,;/]\s*/);
    if (!buyers.length || buyers.some((buyer) => !audience[profile].test(buyer.trim()))) return null;
  }
  return profile;
}

/** These rubrics admit candidates only. In particular, "Анимация" is a
 * catalog source for animation studios, not proof of their business model. */
export function veMediaRubricAllowed(profile: VeMediaSourceProfile, label: string): boolean {
  const value = normalized(label);
  if (/(?:^|\s)(?:без|кроме|не)(?:\s|$)|казино|азарт|букмекер|игровые автоматы|игровой клуб|игровые клубы|компьютерные клубы|аниматор|праздник|мероприят|концерт|звукозапис|оборудован|реклам|обуч|школ|курс/.test(value)) return false;
  return profile === 'games_animation'
    ? /^(?:анимация|мультипликация|анимационн(?:ая|ые) студи(?:я|и)|студи(?:я|и) анимации|студи(?:я|и) разработки игр|разработка (?:компьютерных |видео)?игр|издател(?:и|ьства) (?:компьютерных |видео)?игр|геймдев)$/.test(value)
    : /^(?:телекомпани(?:я|и)|телерадиокомпани(?:я|и)|телеканал(?:ы)?|телевидение|телевещание|онлайн кинотеатр(?:ы)?|видеоплатформ(?:а|ы))$/.test(value);
}

export function isVeMediaCatalogTask(task: VeCollectTask, profile: VeMediaSourceProfile): boolean {
  return task.source === 'yandex_maps' && !!task.maps_query?.queries.length
    && task.maps_query.queries.every((query) => veMediaRubricAllowed(profile, query));
}

// Populated fallback labels verified on 2026-10-13. Exact word-form matching
// avoids another paid mapping call for this fallback. Games remain covered by registry/HH;
// the animation rubric is not a claim that the catalog covers game publishers.
const catalogQuery: Record<VeMediaSourceProfile, string> = {
  games_animation: 'анимация', streaming_tv: 'телекомпания',
};
const hhQuery: Record<VeMediaSourceProfile, string> = {
  games_animation: 'геймдев OR "разработка игр" OR "издатель игр" OR "анимационная студия" OR мультипликация',
  streaming_tv: '"онлайн-кинотеатр" OR телеканал OR видеоплатформа OR телевещание',
};
const genericRole = /^(?:дизайнер|бренд дизайнер|художник|креативный(?: директор)?|бренд|иллюстратор)$/;
const plainMediaRubric = /^(?:игровая студия|студия разработки игр|игры|игровая индустрия|медиа компания|телестудия|кинотеатр(?:ы)?|продюсерский центр|концертный зал|продакшн студия|студия звукозаписи)$/;

/** Fresh plans/replans only: no saved cursors, paid child jobs or spend
 * receipts may be normalized. Registry filters retain the wider discovery
 * coverage of games/video businesses registered outside a single activity. */
export function normalizeVeMediaSourcePlan(plan: VeSourcePlan, profile: VeMediaSourceProfile): { plan: VeSourcePlan; changed: boolean } {
  let changed = false;
  const tasks = plan.tasks.map((task) => {
    if (task.source === 'yandex_maps' && task.maps_query?.queries.length
      && task.maps_query.queries.every((query) => veMediaRubricAllowed(profile, query) || plainMediaRubric.test(normalized(query)))) {
      const valid = task.maps_query.queries.filter((query) => veMediaRubricAllowed(profile, query));
      const queries = valid.length ? valid : [catalogQuery[profile]];
      if (queries.length === task.maps_query.queries.length && queries.every((query, index) => query === task.maps_query!.queries[index])) return task;
      changed = true;
      return { ...task, maps_query: { ...task.maps_query, queries } };
    }
    // Rewrite only a proven list of unconstrained generic creative roles.
    // Quotes, fields, Boolean restrictions and embedded geography stay intact.
    if (task.source === 'hh_live' && task.hh_query?.text
      && task.hh_query.text.split(/\s+OR\s+/).every((role) => genericRole.test(normalized(role)))) {
      changed = true;
      return { ...task, hh_query: { ...task.hh_query, text: hhQuery[profile] } };
    }
    return task;
  });
  const ordered = [...tasks.filter((task) => isVeMediaCatalogTask(task, profile)),
    ...tasks.filter((task) => !isVeMediaCatalogTask(task, profile) && task.source !== 'hh_live'),
    ...tasks.filter((task) => task.source === 'hh_live')];
  if (ordered.some((task, index) => task !== tasks[index])) changed = true;
  if (!changed) return { plan, changed: false };
  const keys = new Set<string>();
  const unique = ordered.filter((task) => {
    const key = veSourceStrategyKey(task);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return { plan: { ...plan, tasks: unique }, changed: true };
}
