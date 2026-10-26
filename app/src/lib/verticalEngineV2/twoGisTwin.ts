import { isVeTwoGisTask } from './twoGisQuarantine';
import { VE_TWO_GIS_RUBRIC_SETS, veTwoGisRubricKey } from './twoGisRows';
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
} as const;

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
