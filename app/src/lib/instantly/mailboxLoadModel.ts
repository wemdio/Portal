/**
 * Чистая часть дашборда «Нагрузка почт»: какой день показывать, чей тег и в
 * работе ли он. Без БД — сюда приходят готовые строки датасета, отсюда уходит
 * то, что рисует страница. Запросы живут в mailboxLoad.ts.
 *
 * Зачем отдельно: правила, ради которых модуль появился, — про смысл, а не
 * про SQL, и их надо уметь прогнать на настоящих строках одним вызовом.
 *
 * 1. День по умолчанию — последний полный день, когда кампании шлют по
 *    расписанию. Раньше это был последний день с отправками в датасете, и в
 *    понедельник страница показывала воскресенье: из ~290 активных кампаний по
 *    выходным шлют 2–3, и 90 тегов из 93 горели «Простоем».
 *
 * 2. Тег живёт своими кампаниями — теми, что ссылаются на него списком тегов
 *    или его ящиками поимённо. Ящик часто стоит под двумя тегами (старым
 *    клиентским и нынешним), и письма, ушедшие с него через чужой тег, —
 *    работа того тега, а не этого. Раньше клиент тега считался по числу
 *    кампаний за всю историю, и строку подписывал давно завершённый проект;
 *    первый вариант этой правки считал тегу любые отправки с его ящиков, и
 *    брошенные теги (Альфа, Smartway_2) оставались в таблице «Недогрузом»
 *    чужого клиента. Теги без своей работы уходят в блок «Не в работе», где
 *    свободными считаются только ящики, не занятые тегами в работе.
 */

export type TagStatus = 'no_capacity' | 'stopped' | 'idle' | 'low' | 'ok' | 'full' | 'over';

/**
 * Откуда взят клиент тега — всегда по СВОИМ кампаниям тега:
 *  - day      — свои кампании, славшие с ящиков тега в выбранный день;
 *  - recent   — в день не слали, но слали за RECENT_WINDOW_DAYS;
 *  - active   — не слали и за окно, берём активные кампании, назначенные на тег;
 *  - history  — активных нет, берём самую позднюю из прежних;
 *  - none     — своих кампаний у тега нет.
 */
export type OwnerSource = 'day' | 'recent' | 'active' | 'history' | 'none';

export type TagLoad = {
  tagId: string;
  tag: string;
  activeMailboxes: number;
  totalMailboxes: number;
  capacity: number; // Σ effective daily_limit по активным ящикам
  sent: number; // отправлено за день со всех ящиков тега (через любой тег)
  utilization: number | null; // sent/capacity; null если потолок 0
  status: TagStatus;
  specialist: string | null; // специалист основного клиента
  client: string | null; // основной клиент (см. ownerSource)
  otherSpecialists: string[]; // прочие специалисты тега (для подсказки)
  // прочие клиенты на ящиках тега: их кампании на этом теге или письма,
  // ушедшие в этот день с общих ящиков через их тег
  otherClients: string[];
  projectCount: number;
  ownerSource: OwnerSource;
  // Своя кампания без проекта в портале, которая перевешивает привязанные, —
  // подсказка вместо клиента (свежий запуск ещё не привязали к проекту).
  unlinkedCampaign: string | null;
  // клиент не по кампаниям (они не привязаны к проекту), а по имени тега
  matchedByName: boolean;
};

export type InactiveReason = 'project_done' | 'no_recent_activity' | 'no_campaigns' | 'not_launched';

/** Тег, которым сейчас никто не работает. */
export type InactiveTag = {
  tagId: string;
  tag: string;
  reason: InactiveReason;
  totalMailboxes: number; // все ящики тега
  // активные ящики, не занятые тегами в работе, и их потолок. У not_launched
  // это ящики клиента, который ещё не запущен: в «свободные» итоги не входят
  activeMailboxes: number;
  capacity: number;
  busyElsewhere: number; // активные ящики тега, занятые другим тегом (в работе или клиентом до запуска)
  client: string | null; // последний клиент тега (или проект с тем же именем)
  specialist: string | null;
  projectStatus: string | null;
  workFormat: string | null;
  matchedByName: boolean; // клиент найден по имени тега, а не по кампаниям
  lastCampaignDay: string | null; // 'YYYY-MM-DD' создания последней своей кампании
};

export type SpecialistLoad = {
  specialist: string; // '__unassigned__' → «Не привязано»
  tagCount: number;
  activeMailboxes: number;
  capacity: number;
  sent: number;
  utilization: number | null;
  status: TagStatus;
  clients: string[];
  tags: string[];
};

export type MailboxRow = {
  email: string;
  statusValue: number | null;
  status: string | null; // label_ru
  dailyLimit: number; // effective (NULL → дефолт 30)
  isDefaultLimit: boolean; // лимит не выставлен явно, действует дефолт
  sent: number;
  lastUsed: string | null; // 'YYYY-MM-DD' последней отправки (в пределах 30 дн)
};

export type MailboxLoad = {
  asOfDay: string; // 'YYYY-MM-DD' — за какой день данные
  latestDay: string | null; // последний полный день в датасете (для date-picker max)
  isSendingDay: boolean; // по расписанию большинства кампаний в этот день шлют
  skippedDays: string[]; // выходные после asOfDay, пропущенные выбором по умолчанию
  lastSync: string | null; // ISO последнего успешного синка
  syncAgeHours: number | null;
  stale: boolean; // синк устарел (> STALE_SYNC_HOURS)
  generatedAt: string;
  tags: TagLoad[]; // только теги в работе
  specialists: SpecialistLoad[];
  inactiveTags: InactiveTag[];
  totals: { activeMailboxes: number; capacity: number; sent: number; utilization: number | null };
  // свободные активные ящики тегов «не в работе» (каждый ящик один раз; без
  // ящиков клиентов, которых ещё не запустили)
  inactiveTotals: { tagCount: number; activeMailboxes: number; capacity: number };
  notes: string[];
};

// пороги утилизации (доля факт/потолок)
const LOW = 0.4; // ниже — недогруз
const FULL = 0.9; // выше — фактически потолок
const OVER = 1.05; // выше — перебор (подняли лимиты / всплеск)

// дефолт воркспейса Instantly для ящиков без явного daily_limit (API тогда
// вообще не отдаёт блок настроек отправки). Значение подтверждено замером.
export const DEFAULT_DAILY_LIMIT = 30;

// Окно «тег в работе»: свои кампании слали за эти дни, включая выбранный.
// Неделя — чтобы тег, славший в среду, не выпадал из таблицы в пятницу.
export const RECENT_WINDOW_DAYS = 7;

// Статусы проекта, после которых его ящики считаются свободными. Остальные
// (В работе, Тестирование, Подготовка, На паузе) — проект идёт, и простой его
// ящиков — настоящий сигнал. Список совпадает с deadlineCron.
const DONE_PROJECT_STATUSES = new Set(['завершен', 'отменен']);

export const UNASSIGNED = '__unassigned__';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// формат + календарная валидность ('2026-02-31' проходит регексп, но ::date
// в Postgres кидает out of range → ложный 500 build_failed в мониторинге)
export function isCalendarDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** День недели в нумерации Instantly: 0 — воскресенье … 6 — суббота. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function shiftDay(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86_400_000).toISOString().slice(0, 10);
}

export const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * Голоса расписаний: scheduled — активные кампании, у которых вообще задано
 * расписание; dN — сколько из них шлёт в день недели N (0 — воскресенье).
 */
export type ScheduleVotes = { scheduled: number | string } & Record<`d${0 | 1 | 2 | 3 | 4 | 5 | 6}`, number | string>;

/**
 * Дни недели, в которые по расписанию шлёт большинство активных кампаний.
 *
 * Большинство, а не «хоть одна»: две-три кампании с включёнными выходными
 * есть всегда, и правило «хоть одна» вернуло бы на экран воскресенье.
 */
export function sendingWeekdays(votes: ScheduleVotes | null | undefined): number[] {
  const scheduled = num(votes?.scheduled);
  if (!votes || scheduled <= 0) return [];
  const out: number[] = [];
  for (const dow of [0, 1, 2, 3, 4, 5, 6] as const) {
    if (num(votes[`d${dow}`]) * 2 >= scheduled) out.push(dow);
  }
  return out;
}

/**
 * День по умолчанию: последний полный день, когда кампании шлют по
 * расписанию. Пропущенные выходные возвращаются отдельно — страница называет
 * их, а не прячет молча.
 *
 * Пропускаются только дни недели, в которые по расписанию не шлют. Будний
 * день, в который рассылка встала, остаётся днём по умолчанию и показывается
 * пустым — поэтому и latestDay берётся по календарю синка, а не по последнему
 * дню с письмами (см. resolveAsOf).
 */
export function pickDefaultDay(latestDay: string, weekdays: number[]): { day: string; skipped: string[] } {
  if (weekdays.length === 0) return { day: latestDay, skipped: [] };
  const sending = new Set(weekdays);
  const skipped: string[] = [];
  let day = latestDay;
  for (let i = 0; i < 7 && !sending.has(weekdayOf(day)); i += 1) {
    skipped.push(day);
    day = shiftDay(day, -1);
  }
  if (!sending.has(weekdayOf(day))) return { day: latestDay, skipped: [] };
  return { day, skipped: skipped.reverse() };
}

export function classify(capacity: number, sent: number): TagStatus {
  // потолка нет: различаем «ничего не происходит» и «слал, но сейчас все
  // ящики выключены» (status — снимок текущего момента, отправки — история дня)
  if (capacity <= 0) return sent > 0 ? 'stopped' : 'no_capacity';
  const u = sent / capacity;
  if (u <= 0) return 'idle';
  if (u < LOW) return 'low';
  if (u < FULL) return 'ok';
  if (u <= OVER) return 'full';
  return 'over';
}

// ── входные строки датасета ──────────────────────────────────────────────────

/** Ящик под тегом (маппинги уже без скрытых тегов Coldy/Trigga). */
export type BoxRow = { tag_id: string; tag: string | null; email: string; status: number | string | null; daily_limit: number | string | null };
/** Отправки ящика за выбранный день по кампаниям. */
export type DaySendRow = { eaccount: string; campaign_id: string | null; campaign_name: string | null; sent: number | string };
/** Отправки кампании за окно RECENT_WINDOW_DAYS (дневная аналитика Instantly). */
export type CampaignVolumeRow = { campaign_id: string; sent: number | string };
/**
 * Своя кампания тега: ссылается на него списком тегов (via_tag) или его
 * ящиками в email_list.
 */
export type CampaignRefRow = {
  tag_id: string; campaign_id: string; campaign_name: string | null;
  status: number | string | null;
  created_day: string | null; // 'YYYY-MM-DD' (UTC)
  created_at: string | null; // полная метка — порядок кампаний одного дня
  via_tag: boolean | null;
  list_overlap: number | string | null; // сколько живых ящиков тега в email_list
};
/** Привязка кампании к проекту портала. */
export type ProjectLinkRow = { campaign_id: string; project_id: string };
export type ProjectRow = { id: string; client: string | null; specialist: string | null; status: string | null; work_format: string | null };

export type AssembleInput = {
  asOfDay: string;
  boxes: BoxRow[];
  daySends: DaySendRow[];
  recentCampaigns: CampaignVolumeRow[];
  campaignRefs: CampaignRefRow[];
  projectLinks: ProjectLinkRow[];
  projects: ProjectRow[];
  isPoolTag: (name: string) => boolean;
};

export type Assembled = Pick<MailboxLoad, 'tags' | 'specialists' | 'inactiveTags' | 'totals' | 'inactiveTotals'>;

type Project = { id: string; client: string | null; specialist: string | null; status: string | null; workFormat: string | null };
type Owner = {
  source: OwnerSource;
  primary: Project | null;
  others: Project[];
  unlinkedCampaign: string | null;
};
type Box = { email: string; active: boolean; limit: number; sent: number };

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

const isDone = (status: string | null): boolean =>
  status != null && DONE_PROJECT_STATUSES.has(status.trim().toLowerCase().replace(/ё/g, 'е'));

// сравнение «имя тега ≈ клиент» — та же нормализация, что на странице
const normName = (s: string | null | undefined) => (s ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const lowerName = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');


const byClient = (a: Project, b: Project) => (a.client ?? '').localeCompare(b.client ?? '', 'ru') || a.id.localeCompare(b.id);

type Weighted = { campaignId: string | null; name: string | null; weight: number };

/**
 * Клиент по весам своих кампаний (письма за день или за окно). Кампания без
 * проекта в портале весит наравне с проектами: если она перевешивает, клиент
 * пуст и вместо него подсказка с её именем — иначе пара хвостовых писем
 * старого проекта подписала бы строку вместо свежего непривязанного запуска.
 */
function ownerByWeights(items: Weighted[], linksByCampaign: Map<string, Project[]>, source: 'day' | 'recent'): Owner | null {
  const projects = new Map<string, { project: Project; weight: number }>();
  const unlinked = new Map<string, number>();
  let total = 0;
  for (const it of items) {
    if (it.weight <= 0) continue;
    total += it.weight;
    const links = it.campaignId ? linksByCampaign.get(it.campaignId) : undefined;
    if (!links || links.length === 0) {
      const name = clean(it.name) ?? it.campaignId ?? '';
      if (name) unlinked.set(name, (unlinked.get(name) ?? 0) + it.weight);
      continue;
    }
    for (const project of links) {
      const cur = projects.get(project.id) ?? { project, weight: 0 };
      cur.weight += it.weight;
      projects.set(project.id, cur);
    }
  }
  if (total <= 0) return null;
  const ranked = [...projects.values()].sort((a, b) => b.weight - a.weight || byClient(a.project, b.project));
  const topUnlinked = [...unlinked.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))[0];
  if (topUnlinked && (ranked.length === 0 || topUnlinked[1] > ranked[0].weight)) {
    return { source, primary: null, others: ranked.map((x) => x.project), unlinkedCampaign: topUnlinked[0] };
  }
  return { source, primary: ranked[0].project, others: ranked.slice(1).map((x) => x.project), unlinkedCampaign: null };
}

/**
 * Клиент по свежести своих кампаний: чья кампания создана последней. У
 * истории (все кампании встали) прочие проекты не показываем — это бывшие
 * клиенты, а не те, кто делит ящики сейчас.
 */
function ownerByRecency(refs: CampaignRefRow[], linksByCampaign: Map<string, Project[]>, source: 'active' | 'history'): Owner {
  const byRecency = [...refs].sort((a, b) =>
    (b.created_at ?? b.created_day ?? '').localeCompare(a.created_at ?? a.created_day ?? '')
    || a.campaign_id.localeCompare(b.campaign_id));
  // Активная кампания живого проекта держит тег, даже если рядом висит более
  // свежая активная кампания завершённого: иначе тег идущего проекта ушёл бы
  // в «Проект завершён» из-за чужого хвоста или порядка одного дня.
  if (source === 'active') {
    const live = byRecency.flatMap((r) => linksByCampaign.get(r.campaign_id) ?? []).filter((p) => !isDone(p.status));
    if (live.length > 0) {
      const ranked = [...new Map(byRecency.flatMap((r) => linksByCampaign.get(r.campaign_id) ?? []).map((p) => [p.id, p])).values()];
      return { source, primary: live[0], others: ranked.filter((p) => p.id !== live[0].id), unlinkedCampaign: null };
    }
  }
  const ranked: Project[] = [];
  const seen = new Set<string>();
  let firstLinkedAt = -1;
  byRecency.forEach((ref, i) => {
    for (const project of linksByCampaign.get(ref.campaign_id) ?? []) {
      if (firstLinkedAt < 0) firstLinkedAt = i;
      if (!seen.has(project.id)) { seen.add(project.id); ranked.push(project); }
    }
  });
  const newest = byRecency[0];
  // самая свежая кампания не привязана и новее любой привязанной — ящики,
  // скорее всего, уже у нового клиента; старый проект не подставляем
  const newestUnlinked = newest && firstLinkedAt !== 0
    && (firstLinkedAt < 0 || (newest.created_day ?? '') > (byRecency[firstLinkedAt].created_day ?? ''));
  // (сравнение по дню, а не по метке: кампании одного дня — одна волна)
  if (newestUnlinked) {
    return { source, primary: null, others: source === 'active' ? ranked : [], unlinkedCampaign: clean(newest.campaign_name) };
  }
  return {
    source,
    primary: ranked[0] ?? null,
    others: source === 'active' ? ranked.slice(1) : [],
    unlinkedCampaign: ranked.length === 0 ? clean(newest?.campaign_name) : null,
  };
}

/**
 * В работе ли тег.
 *
 *  - свои кампании слали в день → в работе;
 *  - слали за окно RECENT_WINDOW_DAYS → в работе, если только проект не
 *    закрыт и все свои кампании не завершены (тогда это хвост);
 *  - не слали, но проект тега идёт (не завершён и не отменён) → в работе:
 *    это и есть простой, ради которого страница существует;
 *  - висят активные свои кампании без проекта в портале → в работе (свежий
 *    запуск ещё не успели привязать);
 *  - иначе тег не в работе: проект завершён, кампании давно встали или своих
 *    кампаний у тега нет вовсе (если есть живой проект с тем же именем —
 *    клиента ещё не запустили). Письма с его ящиков через чужой тег сюда не
 *    в счёт — это работа того тега.
 */
function inactiveReason(owner: Owner, hasLiveOwnCampaign: boolean, namedProject: Project | null): InactiveReason | null {
  if (owner.source === 'day') return null;
  if (owner.source === 'recent') {
    // недельное окно не держит тег, чей проект закрыт, а свои кампании все
    // завершены: это хвост, а не работа (GenieMap 09.10 — последние свои
    // письма 06.10, остальное чужие письма с общих ящиков)
    return isDone(owner.primary?.status ?? null) && !hasLiveOwnCampaign ? 'project_done' : null;
  }
  if (owner.source === 'none') {
    // своих кампаний нет, но есть живой проект с тем же именем — клиента ещё
    // не запустили (или он ведётся в Coldy): его ящики не свободны
    return namedProject && !isDone(namedProject.status) ? 'not_launched' : 'no_campaigns';
  }
  const status = owner.primary?.status ?? null;
  if (isDone(status)) return 'project_done';
  if (status) return null;
  if (owner.source === 'active') return null;
  return 'no_recent_activity';
}

const groupBy = <T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = out.get(k) ?? [];
    arr.push(r);
    out.set(k, arr);
  }
  return out;
};

/**
 * Собирает строки страницы из строк датасета. Чистая функция — без БД и часов.
 */
export function assembleMailboxLoad(input: AssembleInput): Assembled {
  const projectsById = new Map<string, Project>();
  for (const p of input.projects) {
    projectsById.set(p.id, {
      id: p.id, client: clean(p.client), specialist: clean(p.specialist), status: clean(p.status), workFormat: clean(p.work_format),
    });
  }
  const linksByCampaign = new Map<string, Project[]>();
  for (const l of input.projectLinks) {
    const project = projectsById.get(l.project_id);
    if (!project) continue;
    const arr = linksByCampaign.get(l.campaign_id) ?? [];
    if (!arr.some((p) => p.id === project.id)) arr.push(project);
    linksByCampaign.set(l.campaign_id, arr);
  }
  const projectsByName = groupBy([...projectsById.values()].filter((p) => normName(p.client)), (p) => normName(p.client));
  // Проект с тем же именем, что у тега, — только подпись, когда кампании тега
  // не привязаны к проекту или их нет вовсе (клиент в подготовке, ведётся в
  // Coldy). На то, в работе ли тег, не влияет. Живой проект важнее завершённого.
  //
  // Сначала точное совпадение, затем имя клиента, начинающееся с имени тега
  // целым словом («Аудит Профи» → «Аудит Профи АйТи», «Когнитус» →
  // «Когнитус (чат - Анна) Колди»), но не «Deep» → «Deepcont».
  const allProjects = [...projectsById.values()];
  const liveFirst = (a: Project, b: Project) => Number(isDone(a.status)) - Number(isDone(b.status)) || byClient(a, b);
  const projectByTagName = (tagName: string): Project | null => {
    const exact = projectsByName.get(normName(tagName)) ?? [];
    if (exact.length > 0) return [...exact].sort(liveFirst)[0];
    const t = lowerName(tagName);
    if (normName(t).length < 4) return null;
    const prefixed = allProjects.filter((p) => {
      const c = lowerName(p.client);
      return c.length > t.length && c.startsWith(t) && !/[\p{L}\p{N}]/u.test(c[t.length]);
    });
    return prefixed.sort(liveFirst)[0] ?? null;
  };
  const daySendsByBox = groupBy(input.daySends, (r) => r.eaccount);
  const sentByBox = new Map<string, number>();
  for (const r of input.daySends) sentByBox.set(r.eaccount, (sentByBox.get(r.eaccount) ?? 0) + num(r.sent));
  const recentByCampaign = new Map(input.recentCampaigns.map((r) => [r.campaign_id, num(r.sent)]));

  // тег → его ящики (дедуп: в маппингах бывают точные дубли строк)
  const tagBoxes = new Map<string, { name: string; boxes: Map<string, Box> }>();
  for (const b of input.boxes) {
    const name = b.tag ?? '';
    // пул-теги «неименные …» — не клиенты (это резерв ящиков): их ящики уже
    // посчитаны под клиентскими тегами, отдельной строкой не дублируем.
    if (input.isPoolTag(name)) continue;
    const entry = tagBoxes.get(b.tag_id) ?? { name, boxes: new Map<string, Box>() };
    const limit = b.daily_limit == null ? DEFAULT_DAILY_LIMIT : num(b.daily_limit);
    entry.boxes.set(b.email, { email: b.email, active: num(b.status) === 1, limit, sent: sentByBox.get(b.email) ?? 0 });
    tagBoxes.set(b.tag_id, entry);
  }

  // Свои кампании тега. Кампания, созданная позже выбранного дня, в тот день
  // тегу не принадлежала. Назначение на тег (via_tag) — всегда своё.
  // Поимённый список ящиков (email_list) — своё только для тега, который
  // держит больше всего этих ящиков: запуски движка ставят ящики списком, а
  // ящик несёт и нынешний клиентский тег, и старые — иначе каждый такой
  // запуск возвращал бы в таблицу все старые теги на тех же ящиках.
  //
  // Ничья по пересечению частая: ящики, перешедшие от завершённого клиента,
  // несут оба тега (OneScreen целиком внутри Вороного, Reunico внутри
  // Profit-Gateway), и запуск на части таких ящиков даёт обоим тегам одно
  // число. Тогда сначала выбывают теги завершённых клиентов, затем остаются
  // теги, чьи ящики список покрывает полнее всего (запуск, собранный по
  // тегу X, покрывает X целиком, а надмножество — лишь частично).
  const datedRefs = input.campaignRefs.filter((r) => tagBoxes.has(r.tag_id) && (!r.created_day || r.created_day <= input.asOfDay));
  const viaTagByTag = groupBy(datedRefs.filter((r) => r.via_tag), (r) => r.tag_id);
  const tagClientDone = (tagId: string): boolean => {
    const newestFirst = [...(viaTagByTag.get(tagId) ?? [])]
      .sort((a, b) => (b.created_at ?? b.created_day ?? '').localeCompare(a.created_at ?? a.created_day ?? ''));
    for (const r of newestFirst) {
      const ps = linksByCampaign.get(r.campaign_id) ?? [];
      if (ps.length > 0) return ps.every((p) => isDone(p.status));
    }
    return isDone(projectByTagName(tagBoxes.get(tagId)?.name ?? '')?.status ?? null);
  };
  const listRefs = groupBy(datedRefs.filter((r) => !r.via_tag && num(r.list_overlap) > 0), (r) => r.campaign_id);
  const keptListRefs: CampaignRefRow[] = [];
  for (const rows of listRefs.values()) {
    const best = Math.max(...rows.map((r) => num(r.list_overlap)));
    let tied = rows.filter((r) => num(r.list_overlap) === best);
    const live = tied.filter((r) => !tagClientDone(r.tag_id));
    if (live.length > 0) tied = live;
    const cover = (r: CampaignRefRow) => num(r.list_overlap) / (tagBoxes.get(r.tag_id)?.boxes.size || 1);
    const bestCover = Math.max(...tied.map(cover));
    keptListRefs.push(...tied.filter((r) => cover(r) === bestCover));
  }
  const refsByTag = groupBy([...datedRefs.filter((r) => r.via_tag), ...keptListRefs], (r) => r.tag_id);

  // Держит ли кампания тег без писем: всё, кроме черновика (0) и завершённой
  // (3). Пауза (2) держит, только если проект жив или неизвестен: проекты
  // здесь обычно закрывают паузой, и пауза завершённого проекта держала бы
  // его тег «Простоем» всю неделю окна (Onlanta, Leadtheway, Smartway_2).
  const holdsTag = (r: CampaignRefRow): boolean => {
    const st = num(r.status);
    if (st === 0 || st === 3) return false;
    if (st !== 2) return true;
    const ps = linksByCampaign.get(r.campaign_id) ?? [];
    return ps.length === 0 || ps.some((p) => !isDone(p.status));
  };

  type Working = { row: TagLoad; boxes: Box[] };
  type Idle = { row: Omit<InactiveTag, 'activeMailboxes' | 'capacity' | 'busyElsewhere'>; boxes: Box[] };
  const working: Working[] = [];
  const idle: Idle[] = [];

  for (const [tagId, { name, boxes }] of tagBoxes) {
    const list = [...boxes.values()];
    const refs = refsByTag.get(tagId) ?? [];
    const own = new Set(refs.map((r) => r.campaign_id));

    // письма дня с ящиков тега: свои кампании — работа тега, чужие — работа
    // соседнего тега на общих ящиках (только в подсказку «делят ящики»)
    const ownDay = new Map<string, Weighted>();
    const foreignDay: Weighted[] = [];
    for (const b of list) {
      for (const r of daySendsByBox.get(b.email) ?? []) {
        const w: Weighted = { campaignId: r.campaign_id, name: r.campaign_name, weight: num(r.sent) };
        if (r.campaign_id && own.has(r.campaign_id)) {
          const cur = ownDay.get(r.campaign_id) ?? { ...w, weight: 0 };
          cur.weight += w.weight;
          ownDay.set(r.campaign_id, cur);
        } else {
          foreignDay.push(w);
        }
      }
    }
    const ownRecent: Weighted[] = refs
      .map((r) => ({ campaignId: r.campaign_id, name: r.campaign_name, weight: recentByCampaign.get(r.campaign_id) ?? 0 }))
      .filter((w) => w.weight > 0);

    // Без писем тег держат только кампании, назначенные на сам тег. Ссылка
    // через email_list слабая: заготовка «Exportbase» (активна с июля, ни
    // одного письма, один ящик в списке) иначе держала «в работе» два
    // завершённых тега. Письма такой кампании выше учтены — они доказывают
    // работу сами.
    const byTag = refs.filter((r) => r.via_tag);
    const standing = byTag.length > 0 ? byTag : refs;
    const active = byTag.filter((r) => num(r.status) === 1);
    const owner: Owner = ownerByWeights([...ownDay.values()], linksByCampaign, 'day')
      ?? ownerByWeights(ownRecent, linksByCampaign, 'recent')
      ?? (active.length > 0 ? ownerByRecency(active, linksByCampaign, 'active')
        : standing.length > 0 ? ownerByRecency(standing, linksByCampaign, 'history')
          : { source: 'none', primary: null, others: [], unlinkedCampaign: null });
    const namedProject = owner.primary ? null : projectByTagName(name);
    const reason = inactiveReason(owner, standing.some(holdsTag), namedProject);

    if (reason) {
      const project = owner.primary ?? namedProject;
      const matchedByName = !owner.primary && project != null;
      idle.push({
        row: {
          tagId, tag: name, reason,
          totalMailboxes: list.length,
          client: project?.client ?? null,
          specialist: project?.specialist ?? null,
          projectStatus: project?.status ?? null,
          workFormat: project?.workFormat ?? null,
          matchedByName,
          lastCampaignDay: standing.reduce<string | null>(
            (max, r) => (r.created_day && (!max || r.created_day > max) ? r.created_day : max), null),
        },
        boxes: list,
      });
      continue;
    }

    // соседи по ящикам: прочие проекты своих кампаний + кто слал в этот день
    // с общих ящиков через свой тег
    const foreign = ownerByWeights(foreignDay, linksByCampaign, 'day');
    const sharers = [...owner.others, ...(foreign ? [foreign.primary, ...foreign.others].filter((p): p is Project => !!p) : [])];
    // Тег в работе без привязанных кампаний подписываем по имени только живым
    // проектом: завершённый тёзка — это прежний клиент тега, а слать с него
    // может уже новый (первая кампания нового клиента на старом теге).
    const primary = owner.primary ?? (namedProject && !isDone(namedProject.status) ? namedProject : null);
    const matchedByName = !owner.primary && primary != null;
    const otherClients = [...new Set(sharers.map((p) => p.client).filter((c): c is string => !!c))]
      .filter((c) => c !== primary?.client);
    const otherSpecialists = [...new Set(sharers.map((p) => p.specialist).filter((s): s is string => !!s))]
      .filter((s) => s !== primary?.specialist);
    const activeMailboxes = list.filter((b) => b.active).length;
    const capacity = list.reduce((s, b) => s + (b.active ? b.limit : 0), 0);
    const sent = list.reduce((s, b) => s + b.sent, 0);
    working.push({
      row: {
        tagId, tag: name,
        activeMailboxes, totalMailboxes: list.length,
        capacity, sent,
        utilization: capacity > 0 ? sent / capacity : null,
        status: classify(capacity, sent),
        specialist: primary?.specialist ?? null,
        client: primary?.client ?? null,
        otherSpecialists, otherClients,
        projectCount: new Set([primary, ...owner.others].filter((p): p is Project => !!p).map((p) => p.client)).size,
        ownerSource: owner.source,
        unlinkedCampaign: owner.unlinkedCampaign,
        matchedByName,
      },
      boxes: list,
    });
  }

  // порядок: сначала теги с потолком по убыванию потолка (это рабочие клиенты),
  // затем «stopped» (слали, но выключены), затем пустые.
  const tags = working.map((w) => w.row).sort((a, b) => {
    if ((a.capacity > 0) !== (b.capacity > 0)) return a.capacity > 0 ? -1 : 1;
    if (a.capacity > 0) return b.capacity - a.capacity;
    return b.sent - a.sent;
  });

  // Ящики, занятые тегами в работе. Итоги, специалисты и «свободные» ящики
  // считают каждый ящик один раз: ящик под двумя тегами — один ящик.
  const workingBoxes = new Map<string, Box>();
  for (const w of working) for (const b of w.boxes) workingBoxes.set(b.email, b);

  const sumBoxes = (boxes: Iterable<Box>) => {
    let activeMailboxes = 0;
    let capacity = 0;
    let sent = 0;
    for (const b of boxes) {
      if (b.active) { activeMailboxes += 1; capacity += b.limit; }
      sent += b.sent;
    }
    return { activeMailboxes, capacity, sent };
  };

  // свод по специалистам: по уникальным ящикам его тегов — общие ящики
  // соседних тегов одного клиента (Deepcont и Deep, МКТ и velar2) иначе
  // попадали бы в его потолок дважды
  const bySpec = new Map<string, { tags: string[]; clients: string[]; boxes: Map<string, Box> }>();
  for (const w of working) {
    const key = w.row.specialist ?? UNASSIGNED;
    const agg = bySpec.get(key) ?? { tags: [], clients: [], boxes: new Map<string, Box>() };
    agg.tags.push(w.row.tag);
    if (w.row.client) agg.clients.push(w.row.client);
    for (const b of w.boxes) agg.boxes.set(b.email, b);
    bySpec.set(key, agg);
  }
  const specialists: SpecialistLoad[] = [...bySpec.entries()]
    .map(([specialist, agg]) => {
      const t = sumBoxes(agg.boxes.values());
      return {
        specialist,
        tagCount: agg.tags.length,
        ...t,
        utilization: t.capacity > 0 ? t.sent / t.capacity : null,
        status: classify(t.capacity, t.sent),
        clients: [...new Set(agg.clients)],
        tags: agg.tags,
      };
    })
    .sort((a, b) => {
      // «Не привязано» всегда в конец
      if ((a.specialist === UNASSIGNED) !== (b.specialist === UNASSIGNED)) return a.specialist === UNASSIGNED ? 1 : -1;
      return b.capacity - a.capacity;
    });

  // «Не в работе»: в строке и в итоге — только ящики, которых не занял ни один
  // тег в работе и не закрепили за клиентом, которого ещё не запустили (новый
  // клиент часто получает ящики завершённого вместе со старым тегом — через
  // старый тег они бы снова сосчитались свободными). Занятые показываем
  // числом: тег не потерялся, его ящики заняты другим тегом.
  const reserved = new Set(idle.filter((i) => i.row.reason === 'not_launched').flatMap((i) => i.boxes.map((b) => b.email)));
  const freeBoxes = new Map<string, Box>();
  const inactiveTags: InactiveTag[] = idle.map(({ row, boxes }) => {
    const own = row.reason === 'not_launched';
    const taken = (b: Box) => workingBoxes.has(b.email) || (!own && reserved.has(b.email));
    const free = boxes.filter((b) => !taken(b));
    if (!own) for (const b of free) freeBoxes.set(b.email, b);
    const t = sumBoxes(free);
    return {
      ...row,
      activeMailboxes: t.activeMailboxes,
      capacity: t.capacity,
      busyElsewhere: boxes.filter((b) => b.active && taken(b)).length,
    };
  });
  const reasonRank: Record<InactiveReason, number> = { project_done: 0, no_recent_activity: 1, no_campaigns: 2, not_launched: 3 };
  inactiveTags.sort((a, b) => reasonRank[a.reason] - reasonRank[b.reason]
    || b.capacity - a.capacity || a.tag.localeCompare(b.tag, 'ru'));

  const total = sumBoxes(workingBoxes.values());
  const free = sumBoxes(freeBoxes.values());
  return {
    tags,
    specialists,
    inactiveTags,
    totals: { ...total, utilization: total.capacity > 0 ? total.sent / total.capacity : null },
    inactiveTotals: { tagCount: inactiveTags.length, activeMailboxes: free.activeMailboxes, capacity: free.capacity },
  };
}
