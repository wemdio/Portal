/**
 * Клиентские проекции ENG-кабинета: белые списки полей поверх строк `he_*`.
 *
 * ЕДИНСТВЕННОЕ место, где решается состав ответа `/api/client/eng/**`. Роут
 * своего белого списка не заводит: три раунда ревью волны 0 закрывали утечки
 * по одной, и четвёртая появлялась ровно там, где очередной хендлер отдавал
 * строку БД или результат ядра как есть. Пока проектор один на сущность,
 * «скрытое» поле нельзя вернуть через второй эндпоинт.
 *
 * Зачем: staff-загрузчик тянет `select('*')` (он общий с легаси-инструментом
 * /tools/hypothesis-engine и его трогать нельзя), поэтому в английский кабинет
 * сегодня уезжает внутренняя кухня студии — себестоимость и модели
 * (`cost_usd`/`tokens_used`/`llm_model`), стратегия сорсинга (`collect_info.plan`
 * с `pdl_filters` и поисковыми запросами), id внутренних джоб
 * (`tasks[].child_job_id`, `construct.bc_job_id`) и таргетинговое ноу-хау
 * (`he_vocab`, `personalization_plan`, досье вертикалей).
 *
 * Модуль ЧИСТЫЙ: ни БД, ни фетчей — только преобразование уже загруженной
 * деталки, поэтому его можно звать и из роута, и из теста.
 *
 * Принцип белого списка — как в соседнем ENG-роуте
 * `api/client/eng/dashboard/route.ts`, где колонки перечислены поимённо.
 * Состав списка собран ПО ФАКТУ использования полей экранами кабинета
 * (`components/client-eng/*`, `app/client/eng/**`): срезать лишнее нельзя —
 * тогда оплаченный прогон молча выглядит как «ничего не происходит».
 * Ключ копируется только если он есть в исходной строке: у легаси-записей
 * колонок может не быть, и подставлять им `undefined` незачем.
 *
 * Часть полей не фильтруется, а ПЕРЕВОДИТСЯ: `collect_info.tasks[].source`,
 * `collect_info.construct.note`, `he_jobs.progress.label` и
 * `launch_info.campaign_name` — экрану они нужны, но внутри лежит наша кухня
 * (код источника, русская пометка стадии с подстановкой сырья, русская подпись
 * прогресса, внутренний префикс имени кампании), поэтому наружу идёт только
 * подпись из карт COLLECT_SOURCE_LABELS / CONSTRUCT_NOTE_LABELS /
 * JOB_PROGRESS_LABELS либо очищенное имя (toClientEngCampaignName).
 *
 * Отдельный случай — сохранённая ошибка стадии (`he_projects.error`,
 * `he_bases.error`): она не переводится подписью, а СВОРАЧИВАЕТСЯ в машинный
 * код `error_code` (toClientEngStageErrorCode), который экран разворачивает
 * обратно в английский текст. Почему именно так — в шапке той функции.
 *
 * ПОЧЕМУ ИМЕННО ЗДЕСЬ, А НЕ У WRITER'А. Волна 0 несколько раз чинила такие поля
 * на СТОРОНЕ ЗАПИСИ — стадия стала писать английскую подпись, запуск перестал
 * лепить внутренний префикс. Но кабинет читает ИСТОРИЮ: строки `he_jobs` и
 * `he_templates`, записанные до правки, лежат в БД как были, и клиент видит
 * ровно их. Гейт на записи задаёт будущее, гейт на чтении закрывает прошлое —
 * нужны оба, и второй обязан жить на границе ответа.
 */

import type { HeProjectDetail } from './projectDetail';
import { HE_ENG_CAMPAIGN_NAMING } from './launchHandoff';
import { classifyHeClientError, type HeClientErrorCode } from './clientErrors';
// Пауза автопилота читается ТОЛЬКО разбором соседней полосы: второго источника
// этого факта у кабинета нет и быть не должно (см. toClientEngAutopilotHold).
// Импорт значения безопасен — модуль проекции в клиентский бандл не уезжает:
// экраны берут отсюда только типы (`import type` в engText.ts/api-client.ts).
import { toHeAutopilotPause, type HeAutopilotPauseReason } from './autopilotNext';

type Row = Record<string, unknown>;

/**
 * Проекция деталки: `vocabs`/`dossiers`/`cases` не отдаются вовсе — ни один
 * экран кабинета их не читает, а несут они словарь таргетинга и разбор
 * датасета агентства.
 */
export interface ClientEngProjectDetail {
  project: Row;
  hypotheses: Row[];
  verticals: Row[];
  chains: Row[];
  bases: Row[];
  templates: Row[];
  jobs: Row[];
}

/* ── Белые списки полей ── */

// `error` здесь НЕТ (как и в BASE_FIELDS): причина уезжает машинным кодом
// `error_code`, см. toClientEngStageErrorCode.
//
// `max_emails_per_company` — настройка САМОГО клиента («до N адресов одной
// компании», миграция 20260926_0001), а не наша кухня: без неё кабинет не может
// показать действующее значение, и выбор становится невидимым. Отдаём число, а
// не то, как оно применяется: лимит, реально применённый к конкретной базе
// (`he_bases.contact_cap_applied`), в BASE_FIELDS не входит — это отчёт
// конструктора, и объясняется он только устройством шага.
const PROJECT_FIELDS = [
  'id',
  'name',
  'website_url',
  'status',
  'market',
  'autopilot',
  'max_emails_per_company',
  'created_at',
  'updated_at',
] as const;

// brief — снапшот стадии site_profile плюс ручные overrides. Отдаём только то,
// что рисует шаг «Brief»: `website_url`/`captured_at`/`site_text_chars` дублируют
// строку проекта либо служат разбору стадии.
//
// `site_unreachable` в этом списке НЕТ и быть не должно: в строке под этим ключом
// лежит служебная пометка стадии с РУССКОЙ причиной (stages/siteProfile.ts,
// unreachableMark). Кабинет получает вместо неё ВЫЧИСЛЕННЫЙ БУЛЕВ признак того же
// имени — см. toClientEngProjectRow, где он ставится ПОСЛЕ pick и поэтому
// перекрыл бы сырую пометку, даже если ключ когда-нибудь окажется в этом списке.
const BRIEF_FIELDS = [
  'site_profile',
  'site_thin',
  'offer_override',
  'style_override',
  'signature_override',
  'business_override',
] as const;

// evidence (цитаты и ссылки доказательной стадии) в кабинете не рисуется —
// появится экран, вернём поле вместе с ним.
const HYPOTHESIS_FIELDS = [
  'id',
  'project_id',
  'vertical_id',
  'tier',
  'title',
  'description',
  'fit_rationale',
  'potential_pct',
  'status',
] as const;

// `refill_dry_*` — решение НОЧНОГО добора по этой вертикали: слот ей больше не
// выдаётся, потому что N подряд ночей не добавили ни одного контакта
// (lib/hypothesisEngine/autoPipeline.ts). Отдаём оба поля, и оба читаются
// экраном: штамп решает, рисовать ли пометку вообще, число — единственное, чем
// пометка себя объясняет. Без них намеренная остановка выглядит в кабинете как
// поломка, а кнопки «вернуть» не к чему привязать.
// `refill_resumed_at` здесь НЕТ: это техническая граница окна серии для самого
// правила, экран её не показывает и показывать не должен.
const VERTICAL_FIELDS = [
  'id',
  'project_id',
  'name',
  'summary',
  'potential_pct',
  'rank',
  'refill_dry_since',
  'refill_dry_nights',
] as const;

const CHAIN_FIELDS = ['id', 'vertical_id', 'language', 'letters', 'status', 'created_at', 'updated_at'] as const;

// sample_rows не отдаём: превью строк идёт отдельным роутом bases/[id]/rows,
// а в сырой строке базы лежат служебные поля сборки. `error` — не поле, а код
// (`error_code`), см. toClientEngStageErrorCode. `analysis` проходит не целиком,
// а двумя списками, см. BASE_ANALYSIS_FIELDS.
const BASE_FIELDS = [
  'id',
  'vertical_id',
  'filename',
  'row_count',
  'status',
  'analysis',
  'source',
  'collect_info',
  'columns',
  'created_at',
] as const;

/* ── Сохранённая ошибка стадии → машинный код ── */

/**
 * Причина падения для кабинета — КОД, а не текст.
 *
 * `he_projects.error` / `he_bases.error` пишут воркер и стадии V1: русская
 * проза с подставленным внутренним сырьём. Живые примеры писателей — по ИМЕНАМ,
 * а не по номерам строк: номера в этом списке уже успели разъехаться с кодом
 * дважды, а имена ищутся grep'ом и не врут:
 *  - `worker/hypothesisEngine.ts`, `writeJobFailure` — `${job.stage}: ${msg}` в
 *    `he_projects.error`, то есть имя стадии плюс ЛЮБОЙ `err.message` (тело
 *    ответа LLM-подрядчика, текст PostgREST с именами таблиц `he_*`); в
 *    `he_jobs.error` тот же `msg` уходит без префикса;
 *  - `worker/hypothesisEngine.ts`, `chainNextResearchStage` — та же склейка в
 *    проект, когда падает постановка следующей стадии;
 *  - `stages/baseCollect.ts`, отказ пробы среза и терминал релевант-гейта —
 *    «Вертикаль «X» не покрывается каталогом…»;
 *  - `stages/baseCollect.ts`, разбор нулевой сборки — «Авто-сборка не дала
 *    строк: pdl_companies read: …» (имена каталогов студии и текст Postgres
 *    внутри);
 *  - `stages/baseCollect.ts`, таймаут фазы CONSTRUCT — «Конструктор баз не
 *    завершился за 6ч (job <uuid>…)» — с uuid внутренней джобы.
 *
 * До этой правки строка стояла в белых списках и уезжала в тело ответа
 * дословно. Экран её не печатал (компоненты звали классификатор сами), но
 * планка волны 0 — «не на экране И не в payload», и в devtools текст был виден.
 *
 * ПОЧЕМУ КОД, А НЕ ГОТОВЫЙ АНГЛИЙСКИЙ ТЕКСТ. Подмена текста на сервере ломает
 * ровно то, ради чего классификатор и заводился: разобранная строка приезжает
 * на клиент уже по-английски, повторная классификация опознаёт её как
 * `unknown` и теряет конкретику («сегмент исчерпан» → «техническая проблема»),
 * а отмена — она сверяется ПОЛНЫМ совпадением строки — перестаёт отличаться от
 * сбоя. Код разбирается один раз, здесь, и на экране разворачивается обратно в
 * текст (`components/client-eng/engText.ts`). Словарь тот же, что у 5xx роутов
 * (`api/client/eng/_shared.ts` → `classifyHeClientError`), второго контракта
 * ошибок в контуре нет.
 */
const STAGE_CANCELLED_CODE = 'cancelled';

/**
 * Код причины для кабинета: словарь `HeClientErrorCode` плюс `cancelled`.
 *
 * `cancelled` живёт здесь, а не в `clientErrors.ts`: тот справочник описывает
 * СБОИ (у каждого кода есть «что уцелело» и «что делать»), а остановка руками
 * — не сбой, и объяснять её надо другими словами.
 */
export type HeClientStageErrorCode = HeClientErrorCode | typeof STAGE_CANCELLED_CODE;

/**
 * Строки, которые пишут в `he_*.error` НЕ-сбойные пути. Их ровно две, и
 * означают они одно — прогон остановили руками:
 *   - `Cancelled by user` — POST /api/client/eng/projects/[id]/cancel:57;
 *   - `Отменено пользователем` — тот же шаг легаси-инструмента
 *     /tools/hypothesis-engine (`projects/[id]/cancel/route.ts:73`), откуда
 *     staff тушит прогон клиента, и строка доезжает в ENG-кабинет.
 *
 * Оба роута ставят базе `status='failed'` намеренно: иначе она навсегда висит
 * в 'collecting' и держит слот автосборки вертикали. Значит отличить отмену от
 * сбоя ПО СТАТУСУ нельзя — только по самой строке, и проверка обязана стоять
 * ДО классификатора: он знает лишь про сбои и честно объявит техническим сбоем
 * всё, чего не опознал.
 *
 * Сверка полным совпадением, а не вхождением: cancel-роуты пишут константу
 * целиком и ничего к ней не добавляют, а слово «cancel/aborted» внутри длинного
 * текста — признак настоящего сбоя (AbortError, отмена на стороне подрядчика).
 * Подменить его на «вы сами отменили» — такая же ложь, только наоборот.
 */
const STAGE_CANCELLED_MARKERS = new Set(['cancelled by user', 'отменено пользователем']);

/**
 * `he_*.error` → код причины; пусто/не строка → `null` (ошибки не было).
 *
 * Неопознанная непустая строка становится `unknown`, а не пропадает: статус
 * 'failed' без причины читается как поломка продукта.
 */
export function toClientEngStageErrorCode(raw: unknown): HeClientStageErrorCode | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (STAGE_CANCELLED_MARKERS.has(trimmed.toLowerCase())) return STAGE_CANCELLED_CODE;
  return classifyHeClientError(raw);
}

/* ── Пауза автопилота (`he_projects.autopilot_error`) ── */

/**
 * Почему автопилот не повёл проект дальше — в словаре КАБИНЕТА.
 *
 * Источник факта один и он чужой: строку проекта разбирает `toHeAutopilotPause`
 * (`autopilotNext.ts`), и это единственный способ прочитать паузу. Здесь
 * происходит только перевод её причины на язык клиента — у него другой словарь
 * и другие действия, чем у движка:
 *
 *  - `retrying`          — состояние не прочиталось или не записалось
 *                          (`read_failed`/`enqueue_failed`). Единственная пара,
 *                          которую поднимает сам конвейер: ТОТ ЖЕ код
 *                          (`reconcileHeAutopilotProject`) зовёт и ночной
 *                          проход, и кнопка кабинета. Обещать клиенту
 *                          автоматический возврат тут нельзя: ночной проход
 *                          идёт только на установке с выставленным
 *                          `HE_AUTOPILOT_RECONCILE`, а по умолчанию он
 *                          выключен — поэтому английский текст этого кода
 *                          называет кнопку «Start outreach», и текст этот
 *                          ЕДИНСТВЕННЫЙ источник правды о повторе
 *                          (`components/client-eng/engText.ts`); второго,
 *                          вычисляемого флага у паузы намеренно нет;
 *  - `stage_stopped`     — оплаченная стадия уже падала, и второй раз за неё
 *                          автопилот не платит (`stage_failed`);
 *  - `letters_exhausted` — платные прогоны генерации писем на это поколение
 *                          анализа исчерпаны;
 *  - `target_missing`    — вести нечего: вертикаль или база исчезли, в джобе нет
 *                          цели (`setup_incomplete`).
 *
 * ПОЧЕМУ ОТСУТСТВИЕ ПАУЗЫ — ТОЖЕ ФАКТ. Здоровые решения координатора
 * («база уже готова», «сборка уже стоит», «цепочка ещё генерируется») паузы НЕ
 * пишут вовсе (`pauseForHeAutopilotSkip` → null). Значит «мы ждём / делать
 * нечего» кабинет показывает по ОТСУТСТВИЮ записи, а «у нас что-то не
 * сработало» — по её наличию, и перепутать их нельзя: это разные ветки экрана,
 * а не два оттенка одной.
 */
const CLIENT_AUTOPILOT_HOLD_BY_PAUSE: Record<HeAutopilotPauseReason, HeClientAutopilotHoldCode> = {
  read_failed: 'retrying',
  enqueue_failed: 'retrying',
  stage_failed: 'stage_stopped',
  letters_exhausted: 'letters_exhausted',
  setup_incomplete: 'target_missing',
};

export type HeClientAutopilotHoldCode =
  | 'retrying'
  | 'stage_stopped'
  | 'letters_exhausted'
  | 'target_missing';

/** Пауза в том виде, в каком её получает кабинет. */
export interface ClientEngAutopilotHold {
  code: HeClientAutopilotHoldCode;
  /** Когда записана (ISO); `null` — метки нет или она нечитаема. */
  at: string | null;
}

/**
 * Строка `he_projects` → пауза для кабинета; `null` — паузы нет.
 *
 * Наружу уезжает КОД и метка времени, а не причина движка: словарь движка
 * закрытый, но он про его собственные решения (`setup_incomplete` клиенту
 * ничего не говорит и звучит как его недоделка), а карта `Record` по всем
 * причинам заставляет компилятор потребовать перевод для КАЖДОЙ новой — молча
 * протечь незнакомая причина не может.
 */
export function toClientEngAutopilotHold(
  project: Row | null | undefined,
): ClientEngAutopilotHold | null {
  const pause = toHeAutopilotPause(project);
  if (!pause) return null;
  return { code: CLIENT_AUTOPILOT_HOLD_BY_PAUSE[pause.reason], at: pause.at };
}

/**
 * Состояние ночного добора ПРОЕКТА в том виде, в каком его получает кабинет.
 * Набор полный и закрытый — третьего булева флага у него нет намеренно:
 *  - `off`     — ночного добора у проекта нет: строки `he_auto_pipeline_configs`
 *                не существует либо `enabled = false`;
 *  - `running` — добор включён и ночь его поставит;
 *  - `paused`  — добор включён, но остановлен переполнением ёмкости
 *                (`refill_paused_at`, миграция 20260930_0005), и ночь его НЕ
 *                поставит, пока сотрудник не вернёт проект вручную.
 *
 * ПОЧЕМУ ЭТО ТРИ СОСТОЯНИЯ, А НЕ ДВА. До паузы кабинет знал ровно `enabled` и
 * печатал по нему «next: daily refill 03:20 UTC». У проекта на паузе `enabled`
 * остаётся `true` — то есть та же фраза стала ложью для новой формы данных.
 * Схлопывать паузу в `off` тоже нельзя: «добор не настроен» и «добор настроен,
 * но сегодня физически некуда грузить» — разные вещи и для клиента, и для нас.
 */
export type HeClientRefillState = 'off' | 'running' | 'paused';

/**
 * Строка `he_auto_pipeline_configs` → состояние добора для кабинета.
 *
 * `refill_pause_reason` СКВОЗЬ НЕ ПРОХОДИТ И НЕ ДОЛЖЕН: в колонке лежит текст
 * для сотрудника — по-русски, с именем рассыльщика и с объяснением, что
 * счётчик ёмкости общий на весь его аккаунт вместе с чужими клиентами. Наружу
 * уезжает только состояние; английскую фразу про паузу кабинет пишет сам
 * (`components/client-eng/engText.ts`), как и у пауз автопилота.
 *
 * Колонки `refill_paused_at` может не быть вовсе (миграция не применена) — её
 * отсутствие читается как «паузы нет», и это правда: без колонок механизм
 * паузы не работает ни у кабинета, ни у ночного тика, и ночь сборку поставит.
 */
export function toClientEngRefillState(config: Row | null | undefined): HeClientRefillState {
  if (!config || config.enabled !== true) return 'off';
  const pausedAt = config.refill_paused_at;
  return typeof pausedAt === 'string' && pausedAt.trim() !== '' ? 'paused' : 'running';
}

// Живая задача сборки: экран рисует источник, статус и счётчик строк. Снапшот
// задачи из плана (`task`), id дочерней джобы и текст ошибки источника —
// внутреннее состояние воркера.
// `source` СКВОЗЬ НЕ ПРОХОДИТ: в колонке лежит внутренний код источника
// (`pdl`, `eng_hiring`, `companies_directory`…) — это одновременно имена
// поставщиков данных и названия каталогов студии. Клиенту нужен ВИД сборки,
// а не её поставщик, поэтому код переводится подписью (toClientCollectTask).
const COLLECT_TASK_FIELDS = ['status', 'rows'] as const;

/**
 * Внутренний код источника → нейтральная английская подпись. Коды — union
 * `HeCollectTask['source']` (prompts/sourcePlan.ts:21); EN-план (market='us')
 * пользуется pdl/funded/eng_hiring/google_maps, остальные приходят из RU-планов
 * и легаси-записей — подписываем все.
 *
 * Карта, а не список разрешённых значений: незнакомый код НЕ проходит наружу
 * вообще. Новый источник в стадии base_collect не должен утечь в кабинет
 * только потому, что про эту карту забыли, — в худшем случае клиент увидит
 * обобщённую подпись, и это дешевле утечки.
 */
const COLLECT_SOURCE_LABELS: Record<string, string> = {
  companies_directory: 'company registry',
  hh_live: 'job postings',
  yandex_maps: 'local listings',
  google_maps: 'local listings',
  pdl: 'company database',
  funded: 'funded companies',
  eng_hiring: 'hiring signals',
};

const COLLECT_SOURCE_FALLBACK = 'data source';

/**
 * Разбор базы (`he_bases.analysis`) — только те два списка, которые кабинет
 * рисует (EngStepBases, строки «Segments:» и «Angles:»). Остальные пять полей
 * jsonb'а — четыре распределения и `data_quality_notes` — ни один экран не
 * читает, а пишет их LLM свободным текстом, поэтому наружу они не идут.
 *
 * EN-промпт разбора появился позже клиентского API (`prompts/baseAnalyze.en.ts`),
 * и у баз, разобранных в это окно, оба списка лежат в БД ПО-РУССКИ. Гейт на
 * записи прошлое не чинит, поэтому пункт с кириллицей отбрасывается на чтении:
 * список короче — честнее, чем русская строка в английском кабинете.
 */
const BASE_ANALYSIS_FIELDS = ['notable_segments', 'recommended_angles'] as const;

const CYRILLIC_RE = /[\u0400-\u04FF]/;

/**
 * Счётчики сборки: прогресс-карта + `low_relevance`.
 *
 * `low_relevance` — СКОЛЬКО строк квалити-гейт стадии пометил как вне
 * вертикали (`statsWithQuality` в stages/baseCollect). Запуск такие строки не
 * отправляет (`runHeTemplateLaunch` фильтрует `_low_relevance`), поэтому без
 * этого числа карточка базы обещает клиенту объём, которого не будет.
 *
 * Это ЧИСЛО, а не пометки строк: сами `_low_relevance` по-прежнему заперты
 * default-deny по префиксу (BASE_ROW_KEPT_MARKER) — там наша оценка КОНКРЕТНОЙ
 * строки клиента, здесь только её количество. Тот же уровень раскрытия, что
 * уже даёт кабинету проба среза (`slice_probe.hit_rate` и off-target примеры,
 * EngStepBases → AutopilotDecisions).
 *
 * `excluded_existing_bases` / `excluded_during_fetch` НЕ отдаём: эти строки
 * отсеяны как уже собранные в других базах проекта, то есть на объём запуска
 * этой базы не влияют, а объясняются только устройством межбазового дедупа.
 */
const COLLECT_STATS_FIELDS = [
  'tasks_total',
  'tasks_done',
  'tasks_failed',
  'rows_total',
  'low_relevance',
] as const;

// `note` СКВОЗЬ НЕ ПРОХОДИТ (как и tasks[].source) — переводится подписью,
// см. CONSTRUCT_NOTE_LABELS.
const CONSTRUCT_FIELDS = ['status', 'emails_found', 'valid_count'] as const;

/**
 * Пометка фазы CONSTRUCT → безопасная английская подпись. Первое совпавшее
 * правило выигрывает.
 *
 * Почему карта, а не сквозняк: раньше здесь стояло `note` в белом списке с
 * пометкой «режет его слой clientErrors на границе UI» — это неверно.
 * clientErrors разбирает только `he_*.error` (теперь — здесь же,
 * toClientEngStageErrorCode), а note карточка печатает как обычный текст
 * (EngStepBases.tsx:71) — мимо классификатора. Что движок записал, то клиент и
 * увидит.
 *
 * А записывает движок русскую прозу с подстановкой внутреннего сырья — все
 * три writer'а в stages/baseCollect.ts:
 *  - `конструктор завершился со статусом failed: <error_message BC-джобы> —
 *    импортирован частичный результат` (2184) и `… — база без обогащения`
 *    (2190): `error_message` — это любой `err.message` воркера, обрезанный до
 *    500 символов (baseConstructorWorker.ts:1101), то есть в том числе текст
 *    Postgres с именами таблиц (`Failed to persist …`, `Job not found: …`);
 *  - `Конструктор баз не завершился за 6ч (job <uuid>, статус: …)` (2209) —
 *    прямо с uuid внутренней джобы конструктора.
 *
 * Незнакомая пометка НЕ подписывается обобщённо, а ПРОПАДАЕТ — в отличие от
 * COLLECT_SOURCE_LABELS, где fallback уместен. Разница в природе поля: source
 * это закрытый union кодов, и «data source» верно для любого из них; note —
 * свободный текст, собранный подстановкой, и обобщение вроде «enrichment did
 * not finish» было бы утверждением о строке, которую мы не смогли прочитать.
 * Карточка при этом не пустеет: `construct.status` рисуется отдельной строкой
 * (EngStepBases.tsx:57-69), note — лишь уточнение под ней.
 */
const CONSTRUCT_NOTE_LABELS: Array<[RegExp, string]> = [
  [/импортирован частичный результат/i, 'Partial result imported — some rows have no validated email.'],
  [/база без обогащения/i, 'Kept without enrichment — rows have no validated email.'],
  [/Конструктор баз не завершился/i, 'Email enrichment did not finish in time.'],
];

// Провенанс решений автопилота: причина и исход — да, каталожный срез
// (`pdl_filters`) и сырая ошибка перепланирования — нет.
const PLAN_REPAIR_FIELDS = ['reason', 'outcome'] as const;

const SLICE_PROBE_FIELDS = [
  'outcome',
  'hit_rate',
  'sampled',
  'first_hit_rate',
  'off_target_examples',
  'replaced_tasks',
] as const;

// limit рисуется («Collecting base (limit 2000)»). refill/campaign_id/
// refill_result — состояние ежедневного долива: кабинет его не рисует, а
// refill_result.error несёт русский текст тарифной ошибки.
const COLLECT_INFO_FIELDS = ['limit'] as const;

/**
 * Колонка строки собранной базы, которая НЕ уезжает в превью кабинета.
 *
 * `source_detail` — провенанс строки от коллекторов (stages/baseCollect.ts:
 * 232-308): внутренний код поставщика (`pdl`, `funded:<source>`,
 * `eng_hiring:<source>`), русские подписи (`реестр`, `яндекс.карты`) и
 * ПОИСКОВЫЙ ЗАПРОС из плана (`hh: <query>`) — ровно то ноу-хау сорсинга, ради
 * которого режется `collect_info.plan`.
 *
 * Утечка не теоретическая: превью печатает строку ЦЕЛИКОМ в `title` каждой
 * <tr> (EngStepReview.tsx:102 — `JSON.stringify(row).slice(0, 600)`), так что
 * `source_detail` виден по наведению мыши, хотя своей колонки в таблице у него
 * нет (PREVIEW_COLUMNS — только company/website/email).
 */
const BASE_ROW_INTERNAL_COLUMNS = new Set(['source_detail']);

/**
 * Служебные пометки строки движок кладёт с префиксом `_` (baseCollect.ts:2238):
 * `_email_status` — вердикт валидации почты, `_low_relevance` — вердикт
 * релевант-гейта. В `columns` их нет, но в jsonb-строке они есть.
 *
 * Правило default-deny по префиксу, а не список: `_low_relevance` — наша
 * внутренняя оценка строки клиента, и следующая такая пометка не должна
 * доехать до кабинета только потому, что про неё здесь забыли. Исключение
 * ровно одно — статус почты, его превью рисует отдельной колонкой.
 */
const BASE_ROW_KEPT_MARKER = '_email_status';

/**
 * Вердикт валидации почты наружу. В jsonb лежит ячейка из выгрузки
 * конструктора (колонка «email статус», baseCollect.ts:1823-1838) — свободный
 * текст подрядчика в неизвестном нам словаре, в том числе русский; превью
 * печатает его как есть (EngStepReview.tsx:121). Поэтому выпускаем только две
 * СВОИ константы. Раскраска ячейки смотрит на 'ok' / непустую строку / пусто
 * (EngStepReview.tsx:112-118) — она сохраняется.
 */
const EMAIL_STATUS_OK = 'ok';
const EMAIL_STATUS_OTHER = 'unverified';

// personalization_plan (маппинг операторов) и fixed_block — внутренняя кухня
// генерации; letters клиент и так читает.
const TEMPLATE_FIELDS = [
  'id',
  'base_id',
  'vertical_id',
  'status',
  'letters',
  'launch_info',
  'created_at',
  'updated_at',
] as const;

// campaign_id обязателен: parseLaunchInfo (launchHandoff.ts:79) возвращает
// null для записи без него, а шаг «Review & Launch» считает запускаемыми
// шаблоны `status==='ready'` без записи о запуске ЛИБО с НЕЗАКОНЧЕННОЙ записью
// (EngStepReview.tsx) — без campaign_id уже запущенный шаблон снова
// попадёт в очередь, это второй запуск по той же аудитории. Проверено по коду.
//
// campaign_url, наоборот, не отдаём: это
// `https://app.instantly.ai/app/campaign/<id>` (instantlyCampaignUrl), то есть
// домен рассыльщика — кабинет white-label, а ссылок на кампанию он и так не
// рисует (в UI их нет, см. EngStepBases/EngDashboard). preset_id кабинету
// не нужен.
const LAUNCH_INFO_FIELDS = ['campaign_id', 'campaign_name', 'leads_count', 'created_at'] as const;

const LAUNCH_CAMPAIGN_FIELDS = ['campaign_id', 'campaign_name', 'segment', 'leads_count'] as const;

/**
 * Сегменты НЕЗАКОНЧЕННОГО запуска (`launch_info.pending`): части аудитории, у
 * которых кампании нет вовсе либо она создана, но адреса в неё не загрузились
 * (launchHandoff.ts, HeTemplateLaunchPending).
 *
 * Зачем кабинету: по этому ключу шаг «Review & Launch» узнаёт, что запуск можно
 * ДОСТРОИТЬ (heLaunchIsIncomplete — один предикат на сервер и на экран), и
 * снова показывает «Launch all (paused)». Без проекции признак оставался на
 * сервере, и кабинет видел частичный запуск как законченный: кнопка пропадала,
 * хотя API повтор уже разрешал, — вся механика достройки была недостижима.
 *
 * `segment` наружу уже уходит в LAUNCH_CAMPAIGN_FIELDS (это условие из шаблона
 * САМОГО клиента), `stage` — два нейтральных слова ('campaign' | 'leads') без
 * следа рассыльщика и наших таблиц. Остальное записи (счётчики попыток,
 * preset_id) по-прежнему не отдаётся.
 */
const LAUNCH_PENDING_FIELDS = ['segment', 'stage'] as const;

/**
 * Исторические дефолты именования кампании (`buildLaunchCampaignName`,
 * launchHandoff.ts:137-141): имя собиралось как
 * `HE · <filename|база>[ · <сегмент>] · <YYYY-MM-DD>`, обрезанное до 200.
 *
 * Значения продублированы здесь НАМЕРЕННО и меняться не должны: это слепок
 * того, что уже лежит в `he_templates.launch_info`, а не текущая настройка
 * записи. `HE_ENG_CAMPAIGN_NAMING` (prefix '', fallback 'audience') убрал их из
 * НОВЫХ us-запусков, но старые строки он не переписывает.
 *
 * `HE · ` — внутренняя метка студии (staff узнаёт свои кампании в списке
 * рассыльщика), `база` — русский фолбэк для базы без filename. Оба попадают на
 * экран клиента: имя печатают EngStepBases.tsx:149 и дашборд (`stageDetail`
 * «live: …», карточка Launch, лента «campaign launched (paused): …»).
 */
const LEGACY_CAMPAIGN_PREFIX = 'HE · ';
const LEGACY_CAMPAIGN_FALLBACK_BASE = 'база';
const CAMPAIGN_NAME_SEPARATOR = ' · ';

/**
 * Имя кампании для показа клиенту: без внутреннего префикса и без русского
 * фолбэка имени базы.
 *
 * ТОЛЬКО ОТОБРАЖЕНИЕ. В `he_templates.launch_info` и в самой кампании у
 * рассыльщика имя остаётся прежним: переименование живых кампаний — решение
 * владельца, а не следствие правки кода, и по старому имени staff ищет
 * кампанию в рассыльщике. Долив (refill) ходит по `campaign_id`, а не по имени.
 *
 * Чёрный список, а не белый (как в toClientEngBaseDataRow): остаток имени —
 * это filename базы клиента и дата, то есть его собственные данные. Резать их
 * незачем, а угадывать «безопасное» имя вместо них — значит терять единственное,
 * по чему клиент отличает один запуск от другого.
 *
 * Фолбэк подменяется только когда он стоит ПЕРВЫМ сегментом, то есть ровно на
 * месте имени базы: `база` внутри пользовательского filename — это его текст, и
 * трогать его нельзя. Разделитель тот же ` · `, которым имя и собиралось.
 */
export function toClientEngCampaignName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = raw.startsWith(LEGACY_CAMPAIGN_PREFIX)
    ? raw.slice(LEGACY_CAMPAIGN_PREFIX.length)
    : raw;
  const parts = name.split(CAMPAIGN_NAME_SEPARATOR);
  if (parts[0] !== LEGACY_CAMPAIGN_FALLBACK_BASE) return name;
  parts[0] = HE_ENG_CAMPAIGN_NAMING.fallbackBaseName ?? '';
  return parts.join(CAMPAIGN_NAME_SEPARATOR);
}

// error/progress джобы в мастере не рисуются: первый — сырой текст стадии,
// второй — русская подпись прогресса. payload сужаем до привязки джобы к
// вертикали/базе (по нему гаснут спиннеры шагов).
const JOB_FIELDS = ['id', 'stage', 'status', 'attempts', 'started_at', 'finished_at'] as const;

const JOB_PAYLOAD_FIELDS = ['vertical_id', 'base_id'] as const;

/**
 * Подпись живого прогресса (`he_jobs.progress.label`) → безопасная английская.
 * Её печатает блок «Right now» ENG-дашборда (EngDashboard.tsx:470-473) как
 * обычный текст — мимо clientErrors, как и `construct.note`.
 *
 * Писателей ровно три, все — стадии исследования, и все зовут один и тот же
 * `reportProgress(ctx, job.id, done, total, label)` с литералом:
 * `stages/brandCloud.ts:125`, `stages/competitors.ts:112`,
 * `stages/evidence.ts:121`. Сверено по `git log -p` всего дерева стадий: других
 * значений у поля не было никогда, а `progress` не пишет больше никто.
 *
 * Русские ключи — это и есть остаток данных. Рыночный гейт
 * (`market === 'us' ? 'mapping a brand' : 'разбираем бренд'`) появился в этой же
 * волне, но джобы us-проектов, записанные до деплоя, несут русскую подпись, и
 * в статусах pending/running дашборд отдаёт именно их.
 *
 * Английские ключи перечислены рядом с русскими, а не пропущены сквозняком:
 * авторитет — карта, а не язык строки. Иначе гейт на чтении обходится любым
 * будущим writer'ом, который напишет что угодно латиницей.
 *
 * Незнакомая подпись ПРОПАДАЕТ (как `note`), а не подписывается обобщённо
 * (как `source`). Обобщение здесь ничего не стоило бы клиенту: строка ленты и
 * так открывается английским именем стадии (`JOB_STAGE_LABELS[job.stage]`,
 * EngDashboard.tsx:468) и счётчиком `done/total`, то есть «что-то идёт» сказано
 * дважды до подписи. Добавить к этому «working…» — значит утверждать, что мы
 * прочитали строку, которую прочитать не смогли; для `source` фолбэк оправдан
 * тем, что подпись там ЕДИНСТВЕННОЕ, что строка говорит об источнике.
 */
const JOB_PROGRESS_LABELS: Record<string, string> = {
  'mapping a brand': 'mapping a brand',
  'studying a competitor': 'studying a competitor',
  'checking a hypothesis': 'checking a hypothesis',
  'разбираем бренд': 'mapping a brand',
  'изучаем конкурента': 'studying a competitor',
  'проверяем гипотезу': 'checking a hypothesis',
};

/**
 * Подпись прогресса наружу; не строка или нет в карте — пустая строка.
 *
 * Пустая строка, а не `undefined`: дашборд собирает `progress` объектом с
 * тремя полями и уже сегодня кладёт туда `str(progress.label)`, то есть '' для
 * отсутствующей подписи. UI печатает подпись только при непустой строке
 * (EngDashboard.tsx:472-473), так что '' гасит её и ничего не ломает.
 */
export function toClientEngJobProgressLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return JOB_PROGRESS_LABELS[raw.trim().toLowerCase()] ?? '';
}

/* ── Хелперы ── */

function asRow(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function pick(row: Row, fields: readonly string[]): Row {
  const out: Row = {};
  for (const field of fields) {
    if (field in row) out[field] = row[field];
  }
  return out;
}

function pickList(list: unknown, project: (row: Row) => Row): Row[] {
  if (!Array.isArray(list)) return [];
  const out: Row[] = [];
  for (const item of list) {
    const row = asRow(item);
    if (row) out.push(project(row));
  }
  return out;
}

/** Вложенный объект по белому списку; ключа не было — не появляется и в ответе. */
function pickNested(row: Row, key: string, fields: readonly string[]): Row | null {
  if (!(key in row)) return null;
  const nested = asRow(row[key]);
  return nested ? pick(nested, fields) : null;
}

/**
 * Разбор базы для кабинета: два списка, из них — только английские пункты.
 * Не-объект (в т.ч. null у неразобранной базы) отдаём как null, чтобы экран
 * по-прежнему различал «разбор есть» и «разбора нет».
 */
function toClientEngBaseAnalysis(raw: unknown): Row | null {
  const analysis = asRow(raw);
  if (!analysis) return null;
  const out = pick(analysis, BASE_ANALYSIS_FIELDS);
  for (const field of BASE_ANALYSIS_FIELDS) {
    if (!(field in out)) continue;
    const list = out[field];
    out[field] = Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string' && !CYRILLIC_RE.test(item))
      : [];
  }
  return out;
}

/* ── Проекции строк ── */

/**
 * Задача сборки для карточки прогресса: статус и счётчик строк как есть,
 * источник — только подписью. Карточку не гасим: клиент имеет право понимать,
 * из чего собирается его база (EngStepBases рисует строку «done · <источник> ·
 * N rows»), — скрыт поставщик, а не факт сборки.
 */
function toClientCollectTask(task: Row): Row {
  const out = pick(task, COLLECT_TASK_FIELDS);
  if ('source' in task) {
    const code = typeof task.source === 'string' ? task.source : '';
    out.source = COLLECT_SOURCE_LABELS[code] ?? COLLECT_SOURCE_FALLBACK;
  }
  return out;
}

/**
 * Фаза обогащения для карточки: счётчики как есть, пометка — только подписью.
 * Пометки нет в карте — ключа не будет и в ответе (см. CONSTRUCT_NOTE_LABELS).
 */
function toClientConstruct(construct: Row): Row {
  const out = pick(construct, CONSTRUCT_FIELDS);
  const note = construct.note;
  if (typeof note === 'string') {
    const label = CONSTRUCT_NOTE_LABELS.find(([re]) => re.test(note));
    if (label) out.note = label[1];
  }
  return out;
}

/**
 * collect_info без плана источников и внутренних id. Экспортирована отдельно:
 * тот же jsonb отдаёт ENG-дашборд (api/client/eng/dashboard), а у него свой
 * набор колонок базы — переиспользовать целиком `toClientEngBase` он не может.
 */
export function toClientEngCollectInfo(info: Row): Row {
  const out = pick(info, COLLECT_INFO_FIELDS);

  if ('tasks' in info) out.tasks = pickList(info.tasks, toClientCollectTask);

  const stats = pickNested(info, 'stats', COLLECT_STATS_FIELDS);
  if (stats) out.stats = stats;

  if ('construct' in info) {
    const construct = asRow(info.construct);
    if (construct) out.construct = toClientConstruct(construct);
  }

  const planRepair = pickNested(info, 'plan_repair', PLAN_REPAIR_FIELDS);
  if (planRepair) out.plan_repair = planRepair;

  const sliceProbe = pickNested(info, 'slice_probe', SLICE_PROBE_FIELDS);
  if (sliceProbe) out.slice_probe = sliceProbe;

  return out;
}

/**
 * Строка базы в деталке мастера (шаги «Bases & Launch» и «Review & Launch»).
 *
 * `columns` режется тем же `toClientEngBaseColumns`, что и в GET
 * /bases/[id]/rows: два ответа про одну базу обязаны совпадать, иначе
 * спрятанное одним эндпоинтом возвращается через другой. У авто-собранной базы
 * в списке лежит `source_detail` (HE_AUTO_COLLECT_COLUMNS,
 * baseCollect.ts:186-198) — имя внутренней колонки провенанса.
 *
 * Таблица превью от этого не гаснет: заголовки она берёт как пересечение
 * `base.columns` с PREVIEW_COLUMNS = company/website/email
 * (EngStepReview.tsx:65), а `source_detail` в этот список не входил никогда.
 */
export function toClientEngBase(base: Row): Row {
  const out = pick(base, BASE_FIELDS);
  if ('analysis' in base) out.analysis = toClientEngBaseAnalysis(base.analysis);
  // Ключ появляется только если он был в исходной строке (правило модуля):
  // дедуп-ветка collect-роута читает `id, status, collect_info` без `error`,
  // и обещать ей код причины незачем.
  if ('error' in base) out.error_code = toClientEngStageErrorCode(base.error);
  if ('collect_info' in base) {
    const info = asRow(base.collect_info);
    out.collect_info = info ? toClientEngCollectInfo(info) : base.collect_info;
  }
  if (Array.isArray(out.columns)) {
    out.columns = toClientEngBaseColumns(
      (out.columns as unknown[]).filter((c): c is string => typeof c === 'string'),
    );
  }
  return out;
}

/**
 * Запись о запуске. Экспортирована: ту же `he_templates.launch_info` отдаёт и
 * POST /templates/[id]/launch — два ответа про один объект обязаны совпадать по
 * составу полей, иначе «скрытое» поле возвращается через второй эндпоинт.
 * Раньше тот роут держал копию этих же двух списков и они могли разойтись.
 *
 * Не-объект отдаём как `null`, а не как есть: `launch_info` либо null, либо
 * запись ядра, и пропускать наружу неизвестный скаляр незачем.
 */
export function toClientEngLaunchInfo(raw: unknown): Row | null {
  const info = asRow(raw);
  if (!info) return null;
  const out = pick(info, LAUNCH_INFO_FIELDS);
  // Имя чистим на обоих уровнях: сегментные кампании собирались тем же
  // buildLaunchCampaignName и несут тот же префикс.
  if ('campaign_name' in out) out.campaign_name = toClientEngCampaignName(out.campaign_name);
  if (Array.isArray(info.campaigns)) {
    out.campaigns = pickList(info.campaigns, (c) => {
      const campaign = pick(c, LAUNCH_CAMPAIGN_FIELDS);
      if ('campaign_name' in campaign) {
        campaign.campaign_name = toClientEngCampaignName(campaign.campaign_name);
      }
      return campaign;
    });
  }
  // Незакончённый запуск обязан быть ВИДЕН кабинету — иначе достроить его
  // нечем (см. LAUNCH_PENDING_FIELDS). Ключа не было — не появляется: запись без
  // `pending` (все запуски до 28.09.2026) читается как законченная.
  if (Array.isArray(info.pending)) {
    out.pending = pickList(info.pending, (p) => pick(p, LAUNCH_PENDING_FIELDS));
  }
  return out;
}

function toClientTemplate(template: Row): Row {
  const out = pick(template, TEMPLATE_FIELDS);
  if ('launch_info' in template) out.launch_info = toClientEngLaunchInfo(template.launch_info);
  return out;
}

/**
 * Строка `he_jobs`. Экспортирована: четыре мутирующих роута кабинета отдают
 * свежесозданную джобу в ответе, а в строке есть `tokens_used`/`cost_usd`
 * (20260724_0001) — то же самое, что вырезано из деталки.
 */
export function toClientEngJobRow(job: Row): Row {
  const out = pick(job, JOB_FIELDS);
  if ('payload' in job) {
    const payload = asRow(job.payload);
    out.payload = payload ? pick(payload, JOB_PAYLOAD_FIELDS) : null;
  }
  return out;
}

/**
 * Строка `he_hypotheses`. Экспортирована: PATCH /hypotheses/[id] возвращает
 * размеченную гипотезу, а в строке едет `evidence` ([{claim, source_url,
 * quote}]) — доказательная база стадии, которую деталка не отдаёт.
 */
export function toClientEngHypothesisRow(hypothesis: Row): Row {
  return pick(hypothesis, HYPOTHESIS_FIELDS);
}

/* ── Списки колонок для `.select()` в роутах кабинета ── */

/**
 * Те же белые списки в синтаксисе PostgREST.
 *
 * Зачем вообще: `.select()` без аргументов тянет строку целиком — именно так
 * из четырёх роутов уезжали `tokens_used`/`cost_usd`, а из PATCH гипотезы —
 * `evidence`. Имён этих колонок в исходнике при этом нет, поэтому grep'ом
 * волны утечка и не ловилась. Роут теперь обязан назвать колонки.
 *
 * Почему литерал, а не `JOB_FIELDS.join(', ')`: supabase-js разбирает строку
 * `select` на уровне ТИПОВ и умеет это только с литеральным типом — у
 * вычисленной строки тип `string`, и ответ схлопывается в `GenericStringError`.
 *
 * Расхождение с массивом выше утечкой стать не может, и это тут главное:
 * авторитет — проектор, а `select` лишь первый барьер. Список шире проектора —
 * лишнее срежет `pick`; уже — клиент недосчитается поля, то есть заметная
 * поломка экрана, а не утечка.
 *
 * `payload` в джобе добавлен отдельно: он сужается вложенным белым списком
 * (JOB_PAYLOAD_FIELDS), а не копируется целиком, поэтому в JOB_FIELDS его нет.
 */
export const HE_JOB_CLIENT_COLUMNS = 'id, stage, status, attempts, started_at, finished_at, payload';

export const HE_HYPOTHESIS_CLIENT_COLUMNS =
  'id, project_id, vertical_id, tier, title, description, fit_rationale, potential_pct, status';

/**
 * `brief` сюда НЕ входит, хотя в проекторе он есть: список проектов и ответ на
 * создание его не рисуют, а внутри — снапшот стадии site_profile, тащить его в
 * каждый полл списка незачем. Правку брифа (PATCH /projects/[id]) грузит общий
 * со staff `patchHeProjectBrief`, и там brief приходит сам.
 *
 * `error`, наоборот, ЧИТАЕТСЯ, хотя в ответ не попадает: по нему проектор
 * считает `error_code`. Убрать колонку из выборки — значит потерять причину
 * падения вообще, оставить в PROJECT_FIELDS — вернуть текст в payload.
 */
export const HE_PROJECT_CLIENT_COLUMNS =
  'id, name, website_url, status, market, autopilot, error, created_at, updated_at';

/*
 * `max_emails_per_company` в этот литерал НЕ добавлен, хотя в PROJECT_FIELDS он
 * есть, и это ровно тот безопасный случай расхождения, который описан выше
 * («список уже проектора»): действующее значение настройки показывает шаг
 * мастера по ДЕТАЛКЕ проекта (`loadHeProjectDetail` читает строку целиком), а
 * список проектов и ответ на создание его не рисуют.
 *
 * Причина не косметическая: колонка появилась миграцией 20260926_0001, и на
 * установке без неё PostgREST отвечает 42703 на ВЕСЬ `select` — список
 * проектов кабинета лёг бы целиком. Постановка сборки по той же причине читает
 * колонку отдельным запросом и молча переходит на дефолт (`baseCollectEnqueue`).
 */

/**
 * Строка `he_projects`. Экспортирована: создание проекта и правка брифа
 * возвращают строку из `.select()`, то есть вместе с
 * `cost_usd`/`tokens_used`/`llm_model`.
 */
export function toClientEngProjectRow(project: Row): Row {
  const out = pick(project, PROJECT_FIELDS);
  if ('error' in project) out.error_code = toClientEngStageErrorCode(project.error);
  /*
   * Пауза автопилота — тоже КОДОМ, а не текстом (toClientEngAutopilotHold).
   * Ключ появляется только там, где колонку реально читали: деталка проекта
   * берёт строку целиком (`loadHeProjectDetail`, `select('*')`), а список
   * проектов и ответ на создание — по `HE_PROJECT_CLIENT_COLUMNS`, куда
   * `autopilot_error` СОЗНАТЕЛЬНО не добавлен (причина — там же, в комментарии
   * про `max_emails_per_company`: на установке без колонки PostgREST отвечает
   * 42703 на ВЕСЬ select, и список проектов лёг бы целиком). Карточка списка
   * поэтому паузу не рисует, а мастер рисует.
   */
  if ('autopilot_error' in project) out.autopilot_hold = toClientEngAutopilotHold(project);
  if ('brief' in project) {
    const brief = asRow(project.brief);
    if (brief) {
      const clientBrief = pick(brief, BRIEF_FIELDS);
      /*
       * «Сайт не открылся» и «сайт отдал мало текста» — РАЗНЫЕ факты, а флаг
       * `site_thin` один: стадия ставит его и на мёртвом домене (там читать было
       * нечего вообще), поэтому по нему одному мастер рассказывал клиенту про
       * «мало текста» ровно в том случае, когда текста не было ни строки, — и не
       * говорил, что описание бизнеса тут не «рекомендуем», а единственный способ
       * доделать research.
       *
       * Отдаём БУЛЕВ признак, выведенный из наличия служебной пометки стадии, и
       * никогда — саму пометку: в ней русская причина (kind/detail/at), а кабинет
       * английский. Пометка пишется и как `null` (сайт ожил), поэтому смотрим,
       * что это объект, а не просто наличие ключа.
       */
      clientBrief.site_unreachable = asRow(brief.site_unreachable) !== null;
      out.brief = clientBrief;
    } else {
      out.brief = project.brief;
    }
  }
  return out;
}

/* ── Превью строк собранной базы (GET /bases/[id]/rows) ── */

/** Список колонок базы без внутреннего провенанса (см. BASE_ROW_INTERNAL_COLUMNS). */
export function toClientEngBaseColumns(columns: readonly string[]): string[] {
  return columns.filter((c) => !BASE_ROW_INTERNAL_COLUMNS.has(c));
}

/**
 * Строка данных базы для превью.
 *
 * Здесь ЧЁРНЫЙ список, а не белый — в отличие от всего остального модуля, и
 * намеренно: содержимое строки принадлежит клиенту и открыто по составу
 * (у загруженной базы колонки произвольные, у собранной к
 * HE_AUTO_COLLECT_COLUMNS может добавиться `description`). Белый список молча
 * съедал бы данные, за которые клиент заплатил. Наших полей в строке ровно
 * два вида — провенанс источника и пометки с префиксом `_`, — и оба закрыты
 * по умолчанию.
 */
export function toClientEngBaseDataRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (BASE_ROW_INTERNAL_COLUMNS.has(key)) continue;
    if (key.startsWith('_')) continue;
    out[key] = value;
  }
  const status = row[BASE_ROW_KEPT_MARKER];
  if (typeof status === 'string' && status.trim()) {
    out[BASE_ROW_KEPT_MARKER] =
      status.trim().toLowerCase() === EMAIL_STATUS_OK ? EMAIL_STATUS_OK : EMAIL_STATUS_OTHER;
  }
  return out;
}

/**
 * Деталка проекта для клиентского ENG-кабинета. `loadHeProjectDetail` не
 * трогаем — его выдачу читает и staff-инструмент; проекция кладётся поверх,
 * в клиентском роуте.
 */
export function toClientEngProjectDetail(detail: HeProjectDetail): ClientEngProjectDetail {
  return {
    project: toClientEngProjectRow(detail.project),
    hypotheses: pickList(detail.hypotheses, toClientEngHypothesisRow),
    verticals: pickList(detail.verticals, (v) => pick(v, VERTICAL_FIELDS)),
    chains: pickList(detail.chains, (c) => pick(c, CHAIN_FIELDS)),
    bases: pickList(detail.bases, toClientEngBase),
    templates: pickList(detail.templates, toClientTemplate),
    jobs: pickList(detail.jobs, toClientEngJobRow),
  };
}
