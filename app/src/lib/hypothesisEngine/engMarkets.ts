/**
 * Рынки (вертикали) ENG-кабинета на шаге 2 «Choose markets» — ОДНО правило на
 * экран и на сервер (PUT /api/client/eng/projects/[id]/markets), чтобы галочки,
 * которые видит клиент, и то, что сохраняет роут, не разъехались.
 *
 * Модуль чистый и клиентобезопасный: ни БД, ни сети, ни серверных импортов —
 * его тянет и мастер кабинета (components/client-eng), и роут. Формы строк
 * минимальные и с `unknown`-полями: на сервере это строки PostgREST
 * (Record<string, unknown>), в браузере — DTO проекции; обе к ним подходят.
 *
 * ЧТО ТАКОЕ «ВЫБРАН». Рынок выбран, когда у него есть хоть одна гипотеза
 * 'accepted' — тот же предикат, по которому реконсилер автопилота
 * (autopilotReconcile.ts), роут «Collect again» и дашборд решают, вести ли
 * вертикаль. Второго признака выбора (колонки, таблицы) нет и не заводится:
 * сохранение шага 2 переводит гипотезы рынка proposed → accepted (выбор) и
 * accepted → proposed (снятие), никогда не в rejected.
 *
 * ЧТО ТАКОЕ «РЕКОМЕНДОВАН». Первые HE_ENG_RECOMMENDED_MARKETS рынков по
 * he_verticals.rank (1 — лучший; его пишет кластеризация и пересчитывает
 * reviewRecompute: % desc → больше участников → ниже тир → имя). Годен рынок с
 * rank, с potential_pct > 0 и хотя бы одной неотклонённой гипотезой. Rank от
 * выбора не меняется: пересчёт берёт proposed и accepted одним пулом, двигают
 * его только отклонения (легаси-доска). Поэтому галочки по рекомендации ставятся
 * только «свежему» проекту (heEngMarketsFresh), а значок «Recommended» стоит
 * всегда.
 */

/** Сколько рынков кабинет отмечает сам: первая покупка ограничена (сборка до 2 000 компаний, письма и запуск на рынок) и совпадает с тремя ящиками пула проекта. */
export const HE_ENG_RECOMMENDED_MARKETS = 3;

/** Длина строки «почему этот рынок» на карточке шага 2. */
export const HE_ENG_MARKET_WHY_MAX_CHARS = 220;

/** Сколько рынков принимает одно сохранение шага 2 (больше вертикалей кластеризация не делает). */
export const HE_ENG_MARKETS_MAX_PER_SAVE = 50;

/** Вертикаль — только поля, которые читает правило. */
export interface HeEngMarketVertical {
  id?: unknown;
  name?: unknown;
  summary?: unknown;
  rank?: unknown;
  potential_pct?: unknown;
}

/** Гипотеза — только поля, которые читает правило. */
export interface HeEngMarketHypothesis {
  id?: unknown;
  vertical_id?: unknown;
  status?: unknown;
  potential_pct?: unknown;
  fit_rationale?: unknown;
}

/** Цепочка писем, база, шаблон и джоба — для признака «работа по рынку началась». */
export interface HeEngMarketChain {
  vertical_id?: unknown;
  status?: unknown;
}

export interface HeEngMarketBase {
  id?: unknown;
  vertical_id?: unknown;
  status?: unknown;
}

export interface HeEngMarketTemplate {
  vertical_id?: unknown;
}

export interface HeEngMarketJob {
  status?: unknown;
  payload?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Выбранные рынки: id вертикалей, у которых есть accepted-гипотеза с непустым
 * id (тот же предикат, что у реконсилера и роута «Collect again»). Порядок —
 * первого появления во входе; повторов нет.
 */
export function heEngSelectedVerticalIds(hypotheses: readonly HeEngMarketHypothesis[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hypotheses) {
    const verticalId = str(h.vertical_id);
    if (!verticalId || h.status !== 'accepted' || !str(h.id) || seen.has(verticalId)) continue;
    seen.add(verticalId);
    out.push(verticalId);
  }
  return out;
}

/**
 * Свежий проект: ни одна гипотеза ещё не принята и не отклонена — клиент
 * рынки не выбирал. Только тогда экран ставит галочки по рекомендации; дальше
 * галочки — это выбранные рынки (heEngSelectedVerticalIds).
 */
export function heEngMarketsFresh(hypotheses: readonly HeEngMarketHypothesis[]): boolean {
  return !hypotheses.some((h) => h.status === 'accepted' || h.status === 'rejected');
}

/**
 * Рекомендованные рынки: годные (rank есть, potential_pct > 0, хотя бы одна
 * неотклонённая гипотеза) по возрастанию rank, первые
 * HE_ENG_RECOMMENDED_MARKETS. Годных меньше — рекомендованы все годные.
 * Равный rank (две вертикали после ручной правки) разводит имя — тот же
 * последний тайбрейк, что у кластеризации.
 */
export function heEngRecommendedVerticalIds(
  verticals: readonly HeEngMarketVertical[],
  hypotheses: readonly HeEngMarketHypothesis[],
): string[] {
  const withLiveIdeas = new Set<string>();
  for (const h of hypotheses) {
    const verticalId = str(h.vertical_id);
    if (verticalId && h.status !== 'rejected') withLiveIdeas.add(verticalId);
  }
  return verticals
    .map((v) => ({ id: str(v.id), name: str(v.name), rank: num(v.rank), pct: num(v.potential_pct) }))
    .filter((v) => v.id && v.rank !== null && v.pct !== null && v.pct > 0 && withLiveIdeas.has(v.id))
    .sort((a, b) => (a.rank as number) - (b.rank as number) || a.name.localeCompare(b.name))
    .slice(0, HE_ENG_RECOMMENDED_MARKETS)
    .map((v) => v.id);
}

/**
 * Первое предложение текста: до первой точки, «!» или «?», за которыми пробел
 * или конец, — но не короче 30 символов, чтобы сокращение («U.S. firms»,
 * «e.g. clinics») не обрезало мысль на полуслове.
 */
function firstSentence(text: string): string {
  const re = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + 1;
    if (end >= 30) return text.slice(0, end);
  }
  return text;
}

/** Не длиннее предела: целым словом и с многоточием. */
function clampWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= HE_ENG_MARKET_WHY_MAX_CHARS) return flat;
  return clampWords(firstSentence(flat), HE_ENG_MARKET_WHY_MAX_CHARS);
}

/**
 * «Почему этот рынок» — одна строка карточки шага 2: описание вертикали
 * (summary кластеризации; у вертикали-одиночки это описание её гипотезы), а
 * без него — первое предложение fit_rationale лучшей по potential_pct
 * неотклонённой гипотезы рынка, у которой он есть. Не больше
 * HE_ENG_MARKET_WHY_MAX_CHARS символов; длинный текст — первым предложением.
 * Нечего сказать — null (карточка без строки причины).
 */
export function heEngMarketWhy(
  vertical: HeEngMarketVertical,
  hypotheses: readonly HeEngMarketHypothesis[],
): string | null {
  const summary = str(vertical.summary).trim();
  if (summary) return oneLine(summary);
  const verticalId = str(vertical.id);
  if (!verticalId) return null;
  const best = hypotheses
    .filter((h) => str(h.vertical_id) === verticalId && h.status !== 'rejected' && str(h.fit_rationale).trim())
    .sort((a, b) => (num(b.potential_pct) ?? 0) - (num(a.potential_pct) ?? 0))[0];
  if (!best) return null;
  const rationale = str(best.fit_rationale).replace(/\s+/g, ' ').trim();
  return clampWords(firstSentence(rationale), HE_ENG_MARKET_WHY_MAX_CHARS);
}

function payloadId(payload: unknown, key: 'vertical_id' | 'base_id'): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  return str((payload as Record<string, unknown>)[key]);
}

/**
 * Работа по рынку началась — снять с него галочку уже нельзя (роут шага 2
 * отвечает 409 market_started, экран показывает рынок отмеченным и
 * запертым). Началась, если у рынка есть хоть что-то из:
 *  - цепочка писем не в 'failed' (готовая или пишется);
 *  - база не в 'failed' (собирается, проверяется, готова, долив);
 *  - любой шаблон — итоговые письма есть только после оплаченных сборки и
 *    анализа, а запущенный шаблон — это кампания;
 *  - живая (pending/running) джоба на эту вертикаль или на её базу.
 * Рынок, у которого всё упало, НЕ начат: снятие галочки ничего не обрывает и
 * ничего не прячет, а новая попытка по нему — только явным выбором и «Launch».
 *
 * `activeJobs` можно передать хоть все джобы проекта: джоба без статуса
 * pending/running не считается. В деталке кабинета список джоб урезан
 * свежими строками, поэтому решает сервер, а экран только подсказывает.
 */
export function heEngMarketStarted(
  verticalId: string,
  state: {
    chains: readonly HeEngMarketChain[];
    bases: readonly HeEngMarketBase[];
    templates: readonly HeEngMarketTemplate[];
    activeJobs: readonly HeEngMarketJob[];
  },
): boolean {
  if (!verticalId) return false;
  if (state.chains.some((c) => str(c.vertical_id) === verticalId && c.status !== 'failed')) return true;
  if (state.templates.some((t) => str(t.vertical_id) === verticalId)) return true;
  const baseIds = new Set<string>();
  for (const b of state.bases) {
    if (str(b.vertical_id) !== verticalId) continue;
    if (b.status !== 'failed') return true;
    const id = str(b.id);
    if (id) baseIds.add(id);
  }
  return state.activeJobs.some((j) => {
    if (j.status !== 'pending' && j.status !== 'running') return false;
    if (payloadId(j.payload, 'vertical_id') === verticalId) return true;
    const baseId = payloadId(j.payload, 'base_id');
    return baseId !== '' && baseIds.has(baseId);
  });
}
