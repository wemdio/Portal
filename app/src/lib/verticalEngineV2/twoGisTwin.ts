import { isVeTwoGisTask } from './twoGisQuarantine';
import { VE_TWO_GIS_RUBRIC_SETS, veTwoGisRubricKey } from './twoGisRows';
import { veTwoGisQueryScope } from './collectionGeography';
import { readVeTwoGisSourceFlag, veTwoGisFlagCurrent, veTwoGisOutputState, veTwoGisReadBlock, type VeTwoGisSettings,
  type VeTwoGisSourceFlag } from './twoGisSettings';
import type { VeTwoGisAllow } from './twoGisPage';
import type { VeCollectTaskState } from './stages/baseCollect';

/**
 * Состояние близнеца two_gis в collect_info (план 26.10, R3 часть 3б). Чистый модуль:
 * курсор, маркер сбоев подбора рубрик, разрешения базы и тексты заметок. Читает и
 * пишет состояние только baseCollect (dispatchVeTwoGisTwin); запись — одна на диспатч.
 */

/** Сбоев подряд (страница, журнал, подбор рубрик) до закрытия близнеца. */
export const VE_TWO_GIS_MAX_ERRORS = 3;
/** Курсор живёт в jsonb базы рядом со строками: длинный список рубрик обрезается с хвоста. */
export const VE_TWO_GIS_CURSOR_MAX_BYTES = 1024;

/** Разрешения базы в курсоре: n — не компании, p — частные рубрики, i — ИП, g — госорганы. */
export type VeTwoGisAllowMarks = { n?: 1; p?: 1; i?: 1; g?: 1 };
// type, а не interface: курсор присваивается state.two_gis = { version: 1 } & Record<string, unknown>.
export type VeTwoGisCursor = { version: 1; snapshot_id: number; features_version: number; mapping_revision: number;
  rubrics: string[]; allow?: VeTwoGisAllowMarks; after: string; claimed: number; pages: number; errors?: number };
export type VeTwoGisTwinState = { kind: 'none'; mappingFailures: number } | { kind: 'cursor'; cursor: VeTwoGisCursor } | { kind: 'invalid' };

/** Заметки близнеца для UI (тесты ссылаются на них). */
export const VE_TWO_GIS_TWIN_NOTES = {
  profile: 'Справочник организаций не читается для базы с профилем аудитории',
  projectInns: 'Справочник организаций не читается: у проекта исключения по ИНН, а в карточках ИНН нет',
  scope: 'География сбора не сводится к регионам и городам России: справочник организаций не читается',
  cursor: 'Курсор справочника организаций не читается: близнец закрыт',
  off: 'Справочник организаций выключен',
  snapshot: 'Снимок справочника организаций сменился',
  removed: 'Проект убран из выдачи справочника организаций',
  dictionary: 'В справочнике организаций нет подходящих рубрик',
  dictionarySize: 'Справочник организаций: словарь рубрик больше 5000, подбор невозможен',
  modelConfig: 'Подбор рубрик справочника организаций недоступен: модель не настроена',
  mapping: 'Рубрики справочника организаций не подобраны: три сбоя подряд',
  errors: 'Справочник организаций: три сбоя чтения подряд',
  ceiling: 'Достигнут потолок кандидатов справочника организаций',
  exhausted: 'справочник организаций исчерпан',
  progress: 'выборка из справочника организаций',
  readError: 'ошибка чтения справочника организаций',
  closed: 'Выдача справочника организаций закрыта дольше суток',
  readFailing: 'Справочник организаций не читается дольше суток',
} as const;

/**
 * Отсрочка близнеца (часть 4). Постоянные причины считаются на тике из настроек и OutreachOS и в
 * близнеца не пишутся; событийные находит чтение 2ГИС в диспатче и пишет в state.two_gis_wait.
 */
export type VeTwoGisStandingReason = 'settings_unavailable' | 'closed' | 'reads_disabled' | 'quiet' | 'outreachos';
export type VeTwoGisEventReason = 'import' | 'busy' | 'paused' | 'read_failed' | 'error' | 'journal' | 'model';
export type VeTwoGisPostponeReason = VeTwoGisStandingReason | VeTwoGisEventReason;
const EVENT_REASONS: readonly VeTwoGisEventReason[] = ['import', 'busy', 'paused', 'read_failed', 'error', 'journal', 'model'];
export const VE_TWO_GIS_POSTPONE_REASONS: readonly VeTwoGisPostponeReason[] = ['settings_unavailable', 'closed', 'reads_disabled',
  'quiet', 'outreachos', ...EVENT_REASONS];

/** Отсрочка и таймеры живости — РЯДОМ с курсором (state.two_gis_wait), никогда не внутри state.two_gis. */
export interface VeTwoGisTwinWait {
  postponed?: { reason: VeTwoGisEventReason; since: string; not_before: string };
  read_failing?: { since: string; last: string };
  was_active?: true;
}
export type VeTwoGisOutreachOs = 'idle' | 'running' | 'unreadable' | 'not_read';
/** Факты тика для предиката отсрочки: одно now, настройки и OutreachOS на весь тик. */
export interface VeTwoGisTickGate { now: Date; flag: VeTwoGisSourceFlag; projectId: string; cap: number;
  settings: VeTwoGisSettings | null; outreachOs: VeTwoGisOutreachOs }
export type VeTwoGisPostponed = { kind: 'read' }
  | { kind: 'wait'; reason: VeTwoGisPostponeReason; notBefore: Date | null }
  | { kind: 'retire'; note: string };

export const VE_TWO_GIS_RETRY_MS = 30 * 60_000; // журнал, модель, засчитанные сбои 'other'
export const VE_TWO_GIS_BUSY_MS = 60_000;
export const VE_TWO_GIS_PAUSE_FALLBACK_MS = 10 * 60_000; // = PAUSE_MS в twoGisSource.ts
export const VE_TWO_GIS_READ_FAIL_MS = 24 * 3_600_000;
export const VE_TWO_GIS_READ_FAIL_GAP_MS = 2 * 3_600_000;
export const VE_TWO_GIS_CLOSED_RETIRE_MS = 24 * 3_600_000;
export const VE_TWO_GIS_OUTREACHOS_STEP_MS = 15 * 60_000;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonNegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ALLOW_KEYS = new Set(['n', 'p', 'i', 'g']);

function readAllow(value: unknown): VeTwoGisAllowMarks | null | undefined {
  if (value === undefined) return undefined;
  const marks = record(value);
  if (!marks || Object.entries(marks).some(([key, mark]) => !ALLOW_KEYS.has(key) || mark !== 1)) return null;
  return marks as VeTwoGisAllowMarks;
}

/**
 * jsonb → состояние близнеца. Нет поля — подбора ещё не было; маркер {version, mapping_failures}
 * без рубрик — подбор срывался n раз. Курсор — только целый и на снимке флага; чужие поля
 * (not_before и т. п. из будущих частей) сохраняются, как при откате R1. Иначе — invalid.
 */
export function readVeTwoGisTwinState(value: unknown, flag: { snapshot_id: number; features_version: number }): VeTwoGisTwinState {
  if (value === undefined || value === null) return { kind: 'none', mappingFailures: 0 };
  const raw = record(value);
  if (!raw || raw.version !== 1) return { kind: 'invalid' };
  if (raw.rubrics === undefined && (raw.mapping_failures === 1 || raw.mapping_failures === 2)) {
    return { kind: 'none', mappingFailures: raw.mapping_failures };
  }
  const rubrics = raw.rubrics;
  const allow = readAllow(raw.allow);
  if (raw.snapshot_id !== flag.snapshot_id || raw.features_version !== flag.features_version
    || typeof raw.mapping_revision !== 'number' || !Number.isSafeInteger(raw.mapping_revision) || raw.mapping_revision < 1
    || !Array.isArray(rubrics) || rubrics.length < 1 || rubrics.length > 8
    || !rubrics.every((rubric) => typeof rubric === 'string' && rubric.trim() !== '')
    || typeof raw.after !== 'string' || !nonNegativeInt(raw.claimed) || !nonNegativeInt(raw.pages)
    || (raw.errors !== undefined && (!nonNegativeInt(raw.errors) || raw.errors > VE_TWO_GIS_MAX_ERRORS - 1))
    || allow === null) return { kind: 'invalid' };
  const cursor: VeTwoGisCursor = { ...raw, version: 1, snapshot_id: flag.snapshot_id, features_version: flag.features_version,
    mapping_revision: raw.mapping_revision, rubrics: [...rubrics as string[]], after: raw.after,
    claimed: raw.claimed, pages: raw.pages };
  if (allow) cursor.allow = { ...allow };
  return { kind: 'cursor', cursor };
}

const cursorBytes = (cursor: VeTwoGisCursor) => new TextEncoder().encode(JSON.stringify(cursor)).length;

/** Курсор не длиннее VE_TWO_GIS_CURSOR_MAX_BYTES: рубрики снимаются с хвоста; ни одна не влезла — null. */
export function fitVeTwoGisCursor(cursor: VeTwoGisCursor): VeTwoGisCursor | null {
  const fitted = { ...cursor, rubrics: [...cursor.rubrics] };
  while (fitted.rubrics.length && cursorBytes(fitted) > VE_TWO_GIS_CURSOR_MAX_BYTES) fitted.rubrics.pop();
  return fitted.rubrics.length ? fitted : null;
}

/** Сколько доменов база уже заявила в журнале линии: сумма claimed по всем близнецам, и закрытым тоже. */
export function veTwoGisClaimedByBase(tasks: ReadonlyArray<{ source?: unknown; two_gis?: unknown }> | undefined): number {
  return (tasks ?? []).reduce((sum, state) => {
    if (!isVeTwoGisTask(state)) return sum;
    const claimed = record(state.two_gis)?.claimed;
    return sum + (nonNegativeInt(claimed) ? claimed : 0);
  }, 0);
}

const isoMs = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);
const validFailing = (value: unknown): value is { since: string; last: string } => {
  const raw = record(value);
  return !!raw && Number.isFinite(isoMs(raw.since)) && Number.isFinite(isoMs(raw.last)) && isoMs(raw.since) <= isoMs(raw.last);
};

/** jsonb → отсрочка. Терпимо: битая часть снимается, остальное остаётся; не бросает и не бывает invalid. */
export function readVeTwoGisTwinWait(value: unknown): VeTwoGisTwinWait {
  const raw = record(value);
  const wait: VeTwoGisTwinWait = {};
  if (!raw) return wait;
  const postponed = record(raw.postponed);
  if (postponed && EVENT_REASONS.includes(postponed.reason as VeTwoGisEventReason)
    && Number.isFinite(isoMs(postponed.since)) && Number.isFinite(isoMs(postponed.not_before))) {
    wait.postponed = { reason: postponed.reason as VeTwoGisEventReason, since: postponed.since as string, not_before: postponed.not_before as string };
  }
  if (validFailing(raw.read_failing)) wait.read_failing = { since: raw.read_failing.since, last: raw.read_failing.last };
  if (raw.was_active === true) wait.was_active = true;
  return wait;
}

/** Своя лестница повторов близнеца: 5 мин, 15 мин, затем час. */
export function veTwoGisLadderMs(elapsedMs: number): number {
  return elapsedMs < 5 * 60_000 ? 5 * 60_000 : elapsedMs < 20 * 60_000 ? 15 * 60_000 : 60 * 60_000;
}

/**
 * Серия сбоев чтения для суточного таймера. Разрыв больше 2 ч между засчитанными сбоями (тихое окно,
 * OutreachOS, ожидание оплаты, остановленная база) из серии вычитается: считается только время сбоев.
 */
export function bumpVeTwoGisReadFailing(prev: VeTwoGisTwinWait['read_failing'] | undefined, now: Date):
  { read_failing: { since: string; last: string }; failingMs: number } {
  const at = now.getTime();
  if (!validFailing(prev) || isoMs(prev.last) > at) return { read_failing: { since: now.toISOString(), last: now.toISOString() }, failingMs: 0 };
  let since = isoMs(prev.since);
  const gap = at - isoMs(prev.last);
  if (gap > VE_TWO_GIS_READ_FAIL_GAP_MS) since += gap;
  return { read_failing: { since: new Date(since).toISOString(), last: now.toISOString() }, failingMs: at - since };
}

/** Вердикт уровня базы — один для всех её близнецов: закрыть, ждать или читать. */
export function veTwoGisSettingsVerdict(flag: VeTwoGisSourceFlag, settings: VeTwoGisSettings | null, projectId: string,
  now: Date): VeTwoGisPostponed {
  const notes = VE_TWO_GIS_TWIN_NOTES;
  if (!settings) return { kind: 'wait', reason: 'settings_unavailable', notBefore: null };
  if (settings.mode !== 'on') return { kind: 'retire', note: notes.off };
  if (!veTwoGisFlagCurrent(flag, settings)) return { kind: 'retire', note: notes.snapshot };
  const output = veTwoGisOutputState(settings, projectId);
  if (output === 'removed') return { kind: 'retire', note: notes.removed };
  if (output !== 'open') {
    // client_use=off: отсрочка, через сутки от переключения — закрытие (метку пишет триггер настроек).
    const changed = isoMs(settings.client_use_changed_at ?? '');
    if (Number.isFinite(changed) && now.getTime() - changed >= VE_TWO_GIS_CLOSED_RETIRE_MS) return { kind: 'retire', note: notes.closed };
    return { kind: 'wait', reason: 'closed', notBefore: Number.isFinite(changed) ? new Date(changed + VE_TWO_GIS_CLOSED_RETIRE_MS) : null };
  }
  const block = veTwoGisReadBlock(settings, now);
  if (block?.reason === 'reads_disabled') return { kind: 'wait', reason: 'reads_disabled', notBefore: null };
  if (block?.reason === 'quiet') return { kind: 'wait', reason: 'quiet', notBefore: block.until };
  return { kind: 'read' };
}

/** Предикат отсрочки близнеца на тике: настройки базы, затем OutreachOS, затем событийная отсрочка. */
export function veTwoGisPostponed(state: { two_gis_wait?: unknown }, gate: VeTwoGisTickGate): VeTwoGisPostponed {
  const base = veTwoGisSettingsVerdict(gate.flag, gate.settings, gate.projectId, gate.now);
  if (base.kind !== 'read') return base;
  // Не прочиталось — значит «идёт»: общий ресурс не делим.
  if (gate.outreachOs !== 'idle') {
    return { kind: 'wait', reason: 'outreachos', notBefore: new Date(gate.now.getTime() + VE_TWO_GIS_OUTREACHOS_STEP_MS) };
  }
  const postponed = readVeTwoGisTwinWait(state.two_gis_wait).postponed;
  if (postponed && Date.parse(postponed.not_before) > gate.now.getTime()) {
    return { kind: 'wait', reason: postponed.reason, notBefore: new Date(postponed.not_before) };
  }
  return { kind: 'read' };
}

/** Закрытия без чтения 2ГИС — в том же порядке, что в диспатче: профиль, ИНН проекта, география, курсор. */
export function veTwoGisStaticRetire(state: Pick<VeCollectTaskState, 'task' | 'two_gis'>, flag: VeTwoGisSourceFlag,
  facts: { profiled: boolean; projectInnRules: boolean }): string | null {
  const notes = VE_TWO_GIS_TWIN_NOTES;
  if (facts.profiled) return notes.profile;
  if (facts.projectInnRules) return notes.projectInns;
  const query = state.task?.two_gis_query;
  if (!query?.from_queries?.length || !veTwoGisQueryScope(query)) return notes.scope;
  if (readVeTwoGisTwinState(state.two_gis, flag).kind === 'invalid') return notes.cursor;
  return null;
}

/** Потолок доменов близнецов базы — то же значение, что DISPATCH отдаёт диспатчу. */
export function veTwoGisCap(info: { target_progress?: unknown }, flag: VeTwoGisSourceFlag): number {
  const max = record(info.target_progress)?.max_candidates;
  return flag.max_candidates ?? (typeof max === 'number' && Number.isSafeInteger(max) && max > 0 ? max : 0);
}

type VeTwoGisLiveState = { source?: unknown; status?: unknown; unavailable?: unknown; exhausted?: unknown; hit_ceiling?: unknown; two_gis?: unknown };

/**
 * Живой близнец: может ещё дать кандидатов. Отсрочка в живость не входит — её вычитают только там,
 * где действуют сейчас. Потолок — по базе (соседи тоже); done — только с настоящим курсором.
 */
export function veTwoGisTwinLive(state: VeTwoGisLiveState, tasks: ReadonlyArray<{ source?: unknown; two_gis?: unknown }> | undefined,
  flag: VeTwoGisSourceFlag | null, cap: number): boolean {
  if (!flag || !isVeTwoGisTask(state) || state.unavailable || state.exhausted || state.hit_ceiling) return false;
  if (veTwoGisClaimedByBase(tasks) >= cap) return false;
  if (state.status === 'pending') return true;
  return state.status === 'done' && readVeTwoGisTwinState(state.two_gis, flag).kind === 'cursor';
}

/** Близнец вне игры: для не-близнеца false, для близнеца без флага true (жёсткое правило R1). */
export function veTwoGisOut(info: { two_gis_source?: unknown; tasks?: readonly unknown[]; target_progress?: unknown },
  task: VeTwoGisLiveState | null | undefined): boolean {
  if (!isVeTwoGisTask(task)) return false;
  const flag = readVeTwoGisSourceFlag(info.two_gis_source);
  return !(flag && veTwoGisTwinLive(task!, info.tasks as ReadonlyArray<{ source?: unknown; two_gis?: unknown }> | undefined,
    flag, veTwoGisCap(info, flag)));
}

/** ИП разрешены базе, если хоть один близнец заморозил отметку i (veTwoGisAllow при подборе рубрик). Нет курсора — нет разрешения (п.6). */
export function veTwoGisIpAllowedByBase(tasks: ReadonlyArray<{ source?: unknown; two_gis?: unknown }> | undefined): boolean {
  return (tasks ?? []).some((state) => isVeTwoGisTask(state) && readAllow(record(state.two_gis)?.allow)?.i === 1);
}

export function compactVeTwoGisAllow(allow: VeTwoGisAllow): VeTwoGisAllowMarks | undefined {
  const marks: VeTwoGisAllowMarks = {};
  if (allow.nonCompany) marks.n = 1;
  if (allow.privateRubric) marks.p = 1;
  if (allow.ipName) marks.i = 1;
  if (allow.government) marks.g = 1;
  return Object.keys(marks).length ? marks : undefined;
}

export function expandVeTwoGisAllow(marks: VeTwoGisAllowMarks | undefined): VeTwoGisAllow {
  return { nonCompany: marks?.n === 1, privateRubric: marks?.p === 1, ipName: marks?.i === 1, government: marks?.g === 1 };
}

/**
 * Разрешения базы на флаги карточек — при подборе рубрик, один раз (замораживаются в курсоре).
 * nonCompany/privateRubric/government — ХОТЬ ОДНА выбранная рубрика в наборе. ipName — только
 * когда задача реестра в плане базы берёт ИП (не расширенная companies_directory с includeIp):
 * один источник — решение планировщика. Текст гипотезы не разбирается: отрицания и оговорки
 * («исключаются ИП», «ИП не старше 3 лет») ломали эвристику в обе стороны; без сигнала — ИП нет
 * (п.6). Задачи — из info.tasks: info.plan переписывается репланом и расширением. ИП — частная
 * рубрика (решение п.6): privateRubric ||= ipName.
 */
export function veTwoGisAllow(input: { rubrics: readonly string[]; tasks: readonly VeCollectTaskState[] },
  sets = VE_TWO_GIS_RUBRIC_SETS): VeTwoGisAllow {
  const keys = new Set(input.rubrics.map(veTwoGisRubricKey));
  const some = (labels: readonly string[]) => labels.some((label) => keys.has(veTwoGisRubricKey(label)));
  const ipName = input.tasks.some((state) => !isVeTwoGisTask(state) && state.task?.source === 'companies_directory'
    && !state.task.widened && state.task.directory_filters?.includeIp === true);
  return { nonCompany: some(sets.nonCompany), privateRubric: some(sets.privateRubric) || ipName, ipName, government: some(sets.government) };
}
