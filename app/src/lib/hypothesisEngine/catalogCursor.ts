/**
 * ЗАКЛАДКА КАТАЛОГА И ПЕРЕИСПОЛЬЗУЕМЫЙ ПЛАН ИСТОЧНИКОВ — только ENG (market='us').
 *
 * ЗАЧЕМ. Ночной добор ENG (heAutoPipelineCron → base_collect с payload.refill)
 * каждую ночь создаёт НОВУЮ строку he_bases с пустым `collect_info`. Значит
 * каждая ночь заново планирует источники (платный вызов модели) и заново читает
 * каталог С НАЧАЛА среза. Пока исключение уже собранных компаний работало только
 * на мёрдже, вторая и все последующие ночи получали те же самые первые N строк и
 * выбрасывали их — ноль новых компаний при полностью потраченном проходе.
 *
 * ПОЧЕМУ НЕ В `he_bases.collect_info`. В V2 задача переоткрывается внутри ТОЙ ЖЕ
 * базы, поэтому там закладка живёт в состоянии задачи. У V1 диспатч задачи
 * происходит один раз за базу, а refill заводит новую базу, — закладка в задаче
 * не имела бы ни писателя (базу больше не трогают), ни читателя (следующая база
 * её не видит). Поэтому стор ВНЕШНИЙ, ключ — вертикаль × источник × хеш фильтров.
 *
 * ЗАКЛАДКУ МЕЖДУ СБОРКАМИ ДЕРЖИТ ТОЛЬКО pdl, И ЭТО НЕ ДЕТАЛЬ.
 *  - `pdl_companies` — одноразовый bulk-дамп (19,5M строк, один ingest-скрипт),
 *    `id text primary key`. Закладка по `id` верна: порядок выдачи RPC — строго
 *    `order by id`, новых вставок между ночами нет, строки на месте не
 *    переписываются (обновление дампа — DELETE и загрузка заново; после него
 *    закладки pdl сбрасывают вручную).
 *  - `funded_companies` и `eng_hiring_cache` — живые фиды, и их строки
 *    ПЕРЕПИСЫВАЮТСЯ НА МЕСТЕ с прежним `created_at` (у funded — poll-sec-daily и
 *    обогащение из PDL, у eng_hiring — ночной ingest jobhive). Закладка по
 *    времени вставки перешагивала бы строку, которую фильтр среза в ту ночь не
 *    вернул, и после переписывания её не прочитал бы уже никто. Поэтому
 *    закладки между сборками у них НЕТ: слот выдаётся с `from: null`, чтение
 *    сдвигов не отдаёт (stages/baseCollect.ts, «ЧТЕНИЕ КАТАЛОГА С ЗАКЛАДКОЙ»),
 *    каждая сборка читает срез с начала, а уже собранные компании отсеиваются
 *    на выборке и limit не тратят. funded внутри ОДНОГО прогона листается
 *    keyset'ом `(created_at, id)`; eng_hiring у `us` читается свежими
 *    вакансиями вперёд (`published_at desc, id`, офсетные страницы) и только
 *    строками, которые фид видел за последние трое суток.
 *
 * ПЛАН ЛЕЖИТ ЗДЕСЬ ЖЕ, И ЭТО ТОТ ЖЕ ПУНКТ, А НЕ ДОВЕСОК. Ключ закладки — хеш
 * фильтров задачи; фильтры приходят из плана. Пока план каждую ночь строится
 * заново платным вызовом модели, фильтры (а с ними и хеш) меняются, и закладка
 * не совпадает НИ РАЗУ — стор был бы бесполезен. Поэтому план хранится рядом со
 * своими закладками: одна строка = «срезы этой вертикали и то, где мы в каждом
 * из них». Сменился вход планировщика — план перестраивается, и закладки чужих
 * срезов той же записью выбрасываются.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни один вызов не бросает: закладка — это ускорение, а не
 * деньги. Нет строки в сторе (миграция 20260930_0002 не применена, блип БД) —
 * читается как «закладок нет». Потерянная запись закладки стоит одного лишнего
 * скана на следующую ночь, а брошенное исключение стоило бы оплаченной сборки.
 *
 * НО «ЗАКЛАДОК НЕТ» — ЭТО НЕ «КАК ДО ЭТОЙ ПРАВКИ». Режим чтения каталога в
 * стадии выбирается по РЫНКУ, а не по доступности стора: при market='us' срез
 * всё равно читается тем же порядком (pdl — keyset по id, funded — по времени
 * вставки внутри прогона, eng_hiring — свежие вакансии вперёд и только
 * source='jobhive'), просто pdl — с первой строки и без записи. Отсюда порядок
 * выката: миграцию 20260930_0002 (она же заводит индекс funded по времени
 * вставки) применяют ДО деплоя кода, иначе ENG-чтение funded уходит в
 * сортировку всей отфильтрованной выборки без индекса. Порядок eng_hiring — тот
 * же, что у прежнего чтения без закладки, и индекс по времени вставки ему не
 * нужен: под этот порядок заведён (source, country_code, published_at desc) в
 * 20260617_0001.
 */

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { HeCollectTask, HeSourcePlan } from './prompts/sourcePlan';
import { sliceProbeRejectBelow, sliceProbeRepairBelow } from './sliceProbe';

/** Источники-каталоги ENG: читаются напрямую и имеют закладку. */
export type HeCatalogSource = 'pdl' | 'funded' | 'eng_hiring';

const CATALOG_SOURCES: readonly string[] = ['pdl', 'funded', 'eng_hiring'];

/** Задача читает каталог напрямую (а не дочерней джобой парсера)? */
export function isHeCatalogSource(source: string): source is HeCatalogSource {
  return CATALOG_SOURCES.includes(source);
}

/**
 * Закладка среза: последняя строка РАЗОБРАННОГО ПРЕФИКСА выдачи.
 *
 * В сторе лежат только закладки pdl (ключ — только id): живым фидам закладку
 * между сборками стадия не выдаёт (см. шапку). `inserted_at` есть у курсора
 * страницы funded ВНУТРИ прогона и у закладок funded/eng_hiring, оставшихся в
 * сторе от прежнего кода, — их slotFor не читает. Закладка без `inserted_at`
 * для funded/eng_hiring непригодна и трактуется как «закладки нет»: продолжать
 * keyset по времени вставки от одного id нельзя.
 */
export interface HeCatalogBookmark {
  id: string;
  inserted_at?: string;
  /**
   * Когда закладка записана (ISO) — ставит `move` в момент приёма сдвига, а не
   * чтение каталога: иначе штамп выписывался бы на каждую просмотренную строку.
   * Читается обрезкой карты (BOOKMARK_LIMIT); у закладок из старых записей его
   * может не быть, и такая уходит в конец сортировки.
   */
  at?: string;
}

/** Слот закладки: ключ среза в сторе + значение, с которого продолжаем. */
export interface HeCatalogSlot {
  key: string;
  from: HeCatalogBookmark | null;
}

/** Строка стора в том виде, в котором её читает стадия. */
export interface HeCatalogCursorRow {
  /** Переиспользуемый план источников (null — не сохранён). */
  plan: HeSourcePlan | null;
  /** Хеш входа планировщика, по которому план построен (null — неизвестен). */
  planKey: string | null;
  /** Закладки срезов: ключ heCatalogSliceKey → закладка. */
  bookmarks: Record<string, HeCatalogBookmark>;
  /**
   * Когда платное расширение плана последний раз кончилось ничем (null — не
   * было). Хранится у ПЛАНА, а не у базы: базы ночные, и отметка в
   * collect_info одной базы не мешала бы следующей ночи купить тот же отказ.
   */
  widenFailedAt: string | null;
}

const CURSOR_TABLE = 'he_catalog_cursors';

/**
 * Сколько закладок держим на вертикаль. Срезов у плана максимум четыре
 * (HeSourcePlanSchema), запас — под смену плана, после которой прежние ключи
 * ещё какое-то время осмысленны. Перебор ключей означает, что план менялся
 * много раз, и самые старые закладки всё равно указывают в чужие срезы.
 */
const BOOKMARK_LIMIT = 16;

/** Стабильный хеш произвольного значения: ключи объектов отсортированы. */
function stableHash(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.entries(input as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]);
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}

/**
 * Ключ закладки задачи: источник + хеш ЕГО фильтров (+ уровень ослабления).
 * Не-каталожный источник (реестр, hh, карты) закладки не имеет — null.
 *
 * Хеш считается по тому под-объекту, который реально управляет выдачей, а не по
 * задаче целиком: `rationale` — проза модели, она меняется от прогона к прогону
 * и обнуляла бы закладку при том же самом срезе.
 *
 * `widen` — УРОВЕНЬ ОСЛАБЛЕНИЯ ПОРОГА, с которым читается тот же объект
 * фильтров (baseCollect, market='us'): 0 — как спланировано, 1 — «порог или
 * пустое поле», 2 — порога нет вовсе. Ключ обязан их РАЗЛИЧАТЬ, и это не
 * украшение. Ослабленный срез — НАДМНОЖЕСТВО исходного: если пустить его под
 * тем же ключом, закладка узкого среза уедет по строкам, которых узкий срез
 * никогда не видел, и после выключения расширения они будут потеряны
 * навсегда. С отдельным ключом у каждого уровня своя закладка, и выключение
 * флага возвращает ровно прежнее чтение.
 *
 * Уровень 0 печатается БЕЗ суффикса — иначе ключи всех уже записанных закладок
 * сменились бы, и первая же ночь после выката перечитала бы каждый срез с
 * начала.
 */
export function heCatalogSliceKey(task: HeCollectTask, widen = 0): string | null {
  if (!isHeCatalogSource(task.source)) return null;
  const filters =
    task.source === 'pdl'
      ? task.pdl_filters
      : task.source === 'funded'
        ? task.funded_filters
        : task.eng_hiring_query;
  // Задача без своего под-объекта фильтров до DISPATCH не доживает (схема
  // HeCollectTaskSchema требует его по источнику), но закладку без фильтров
  // заводить нельзя: она склеила бы разные срезы в один ключ.
  if (!filters) return null;
  return `${task.source}:${stableHash(filters)}${widen > 0 ? `:w${widen}` : ''}`;
}

/**
 * Хеш ВХОДА планировщика: пока он совпадает, сохранённый план можно взять
 * вместо нового платного вызова модели.
 *
 * Хешируется РОВНО то, что видит промпт (`SourcePlanPromptInput`: имя и
 * описание вертикали, синонимы, отобранные гипотезы с tier и описанием, типы
 * компаний из вокабуляра), плюс рынок — промпты RU и EN разные, и один план на
 * два рынка невозможен. Ничего сверх входа промпта здесь быть не должно:
 * лишнее поле (например, статус гипотезы, который промпт не печатает) обнуляло
 * бы переиспользование на правке, не меняющей план.
 *
 * ПЛЮС РЕВИЗИЯ КОДА, и вот зачем. Вход промпта — не единственное, от чего
 * зависит сохранённый план: его формируют ещё текст самого промпта и
 * пост-обработка (снятие необоснованных порогов размера). Правка любого из
 * них живёт в коде, а не во входе, поэтому без ревизии вертикаль, у которой
 * гипотезы и словарь не менялись, переиспользовала бы план, построенный по
 * СТАРОМУ промпту, — правка выкатилась бы и не подействовала, и ничто бы об
 * этом не сказало. Поднимайте число руками, меняя промпт плана, правило
 * снятия порогов, а при включённом ремонте среза — ещё и вопрос пробы или
 * ремонтный промпт (sliceProbe.ts, buildCatalogRepairMessagesEn).
 *
 * ПЛЮС ПОРОГИ ПРОБЫ СРЕЗА — сами, без ручного bump'а. Проба и ремонт среза
 * (ensureSliceMatchesVertical в stages/baseCollect.ts) бегут ТОЛЬКО при
 * построении нового плана: переиспользованный план их не проходит. Пороги —
 * env (HE_SLICE_PROBE_REPAIR_BELOW / _REJECT_BELOW, по умолчанию 0), и без них
 * в ключе включение ремонта не действовало бы ни на одну вертикаль, у которой
 * план уже сохранён, — то есть на все ENG-вертикали после их первой сборки, и
 * лог об этом молчал бы. Поэтому пороги входят в хеш, но ТОЛЬКО когда ремонт
 * включён (REPAIR_BELOW > 0): при нуле проба плана не меняет (условие ремонта
 * ложно всегда, а отказ проверяется только после ремонта), и ключ остаётся
 * байт-в-байт прежним — выкат этой правки ни одного плана не перестраивает.
 * Цена включения названа заранее: в первую ночь после смены порогов каждая
 * ENG-вертикаль один раз покупает новый план и пробу среза (именно это и
 * означает «включить ремонт»); закладки срезов, чьи фильтры не изменились,
 * совпадут по ключу фильтров и сохранятся.
 */
export const HE_SOURCE_PLAN_REVISION = 1;

export function heCatalogPlanKey(market: string, input: unknown): string {
  const repairBelow = sliceProbeRepairBelow();
  return stableHash({
    v: HE_SOURCE_PLAN_REVISION,
    market,
    input,
    // undefined отфильтровывает stableHash: при выключенном ремонте ключ тот же,
    // что до появления этого поля.
    probe: repairBelow > 0 ? { repair: repairBelow, reject: sliceProbeRejectBelow() } : undefined,
  });
}

/**
 * Прочитать стор вертикали.
 *
 * `null` означает «стора нет» (таблицы нет — миграция не применена — либо
 * чтение отказало). Это НЕ то же самое, что пустая строка: на `null` закладки
 * не читаются и не пишутся (содержимое неизвестно, и upsert затёр бы чужие), а
 * сохранённый план не переиспользуется — планировщик оплачивается заново, а
 * отметка безрезультатного расширения не хранится (heWidenOnCooldown(null) —
 * false). Но это НЕ чтение каталога «как до правки» (см. шапку файла): режим
 * чтения выбирается по рынку, поэтому срез по-прежнему читается тем же
 * порядком (pdl — keyset по id, просто с первой строки; funded — по времени
 * вставки внутри прогона; eng_hiring — свежие вакансии вперёд, только
 * source='jobhive'; у живых фидов закладки между сборками нет и со стором), а
 * исключение уже собранных компаний на выборке работает и без стора.
 */
export async function loadHeCatalogCursor(
  db: SupabaseClient,
  verticalId: string,
  log?: (message: string) => void,
): Promise<HeCatalogCursorRow | null> {
  const { data, error } = await db
    .from(CURSOR_TABLE)
    .select('plan, plan_key, bookmarks, widen_failed_at')
    .eq('vertical_id', verticalId)
    .maybeSingle();
  if (error) {
    log?.(
      `[base_collect] стор закладок каталога недоступен (${error.message.slice(0, 120)}) — закладки не читаются `
        + 'и не пишутся, план не переиспользуется; срезы читаются тем же порядком, pdl — с первой строки '
        + '(funded — по времени вставки внутри прогона, eng_hiring — свежие вакансии вперёд, только jobhive), '
        + 'исключение собранных компаний на выборке работает',
    );
    return null;
  }
  if (!data) return { plan: null, planKey: null, bookmarks: {}, widenFailedAt: null };
  const row = data as {
    plan?: unknown;
    plan_key?: unknown;
    bookmarks?: unknown;
    widen_failed_at?: unknown;
  };
  return {
    plan: isSourcePlan(row.plan) ? row.plan : null,
    planKey: typeof row.plan_key === 'string' && row.plan_key ? row.plan_key : null,
    bookmarks: readBookmarks(row.bookmarks),
    widenFailedAt: typeof row.widen_failed_at === 'string' ? row.widen_failed_at : null,
  };
}

/**
 * Окно остывания после безрезультатной ПЛАТНОЙ покупки среза.
 *
 * Неделя, потому что причина отказа обычно не в дне: узкая вертикаль, у
 * которой модель раз за разом возвращает уже прочитанный срез, вернёт его и
 * завтра. Без окна это был бы один bulk-вызов на вертикаль КАЖДУЮ ночь за ноль
 * строк — отметка в collect_info от этого не спасает, она живёт в базе, а база
 * у каждой ночи новая.
 */
export const HE_WIDEN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Остывание ещё идёт: покупать расширение рано. */
export function heWidenOnCooldown(row: HeCatalogCursorRow | null, nowMs: number): boolean {
  if (!row?.widenFailedAt) return false;
  const at = Date.parse(row.widenFailedAt);
  return Number.isFinite(at) && nowMs - at < HE_WIDEN_COOLDOWN_MS;
}

/**
 * Запомнить безрезультатную покупку рядом с планом. Никогда не бросает: отказ
 * записи значит лишь, что следующая ночь попробует ещё раз.
 */
export async function rememberHeCatalogWidenFailure(
  db: SupabaseClient,
  verticalId: string,
): Promise<void> {
  const { error } = await db
    .from(CURSOR_TABLE)
    .update({ widen_failed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('vertical_id', verticalId);
  if (error) return;
}

/**
 * Записать закладки и/или план одной строкой стора.
 *
 * Никогда не бросает: отказ возвращается как `false` и означает лишь, что
 * следующая ночь начнёт срез с прежней закладки (лишний скан, не потеря).
 * `planSliceKeys` задаётся ВМЕСТЕ с новым планом: закладки, не принадлежащие
 * его срезам, этой же записью выбрасываются — иначе карта копила бы мёртвые
 * ключи прошлых планов.
 */
export async function saveHeCatalogCursor(
  db: SupabaseClient,
  args: {
    verticalId: string;
    market: string;
    bookmarks: Record<string, HeCatalogBookmark>;
    plan?: { plan: HeSourcePlan; planKey: string; sliceKeys: string[] };
  },
  log?: (message: string) => void,
): Promise<boolean> {
  const bookmarks = args.plan
    ? pickBookmarks(args.bookmarks, args.plan.sliceKeys)
    : capBookmarks(args.bookmarks);
  const row: Record<string, unknown> = {
    vertical_id: args.verticalId,
    market: args.market,
    bookmarks,
    updated_at: new Date().toISOString(),
  };
  if (args.plan) {
    row.plan = args.plan.plan;
    row.plan_key = args.plan.planKey;
    row.plan_at = new Date().toISOString();
  }
  try {
    const { error } = await db.from(CURSOR_TABLE).upsert(row, { onConflict: 'vertical_id' });
    if (error) {
      log?.(`[base_collect] закладку каталога записать не удалось: ${error.message.slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (e) {
    log?.(`[base_collect] закладку каталога записать не удалось: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    return false;
  }
}

/** Закладка пригодна для этого источника? */
export function usableBookmark(
  source: HeCatalogSource,
  bookmark: HeCatalogBookmark | undefined,
): HeCatalogBookmark | null {
  if (!bookmark || !bookmark.id) return null;
  // Ключ funded/eng_hiring — время вставки: без него продолжать нечем, и
  // закладку берём как отсутствующую. (Между сборками стадия этим источникам
  // закладку не выдаёт вовсе — см. шапку.)
  if (source !== 'pdl' && !bookmark.inserted_at) return null;
  return bookmark;
}

/** Две закладки указывают в одну строку? (нечего писать — не пишем) */
export function sameBookmark(a: HeCatalogBookmark | null, b: HeCatalogBookmark | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && (a.inserted_at ?? '') === (b.inserted_at ?? '');
}

function isSourcePlan(value: unknown): value is HeSourcePlan {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { tasks?: unknown }).tasks);
}

function readBookmarks(value: unknown): Record<string, HeCatalogBookmark> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, HeCatalogBookmark> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { id?: unknown; inserted_at?: unknown; at?: unknown };
    if (typeof item.id !== 'string' || !item.id) continue;
    out[key] = {
      id: item.id,
      ...(typeof item.inserted_at === 'string' && item.inserted_at ? { inserted_at: item.inserted_at } : {}),
      ...(typeof item.at === 'string' && item.at ? { at: item.at } : {}),
    };
  }
  return out;
}

/** Оставить закладки только названных срезов (запись нового плана). */
function pickBookmarks(
  bookmarks: Record<string, HeCatalogBookmark>,
  sliceKeys: string[],
): Record<string, HeCatalogBookmark> {
  const wanted = new Set(sliceKeys);
  const out: Record<string, HeCatalogBookmark> = {};
  for (const [key, value] of Object.entries(bookmarks)) {
    if (wanted.has(key)) out[key] = value;
  }
  return out;
}

/** Обрезать карту до BOOKMARK_LIMIT самых свежих закладок. */
function capBookmarks(bookmarks: Record<string, HeCatalogBookmark>): Record<string, HeCatalogBookmark> {
  const entries = Object.entries(bookmarks);
  if (entries.length <= BOOKMARK_LIMIT) return bookmarks;
  entries.sort(([, a], [, b]) => (b.at ?? '').localeCompare(a.at ?? ''));
  return Object.fromEntries(entries.slice(0, BOOKMARK_LIMIT));
}
