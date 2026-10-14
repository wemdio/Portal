/**
 * Потолок расхода ENG (P-A-project-spend-ceiling). ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН.
 *
 * ВЫКЛЮЧЕН — ЗНАЧИТ НИЧЕГО. Пока ни HE_US_PROJECT_SPEND_CAP_USD, ни
 * HE_US_PROJECT_DAY_SPEND_CAP_USD, ни два порога клиента
 * (HE_US_CLIENT_SPEND_CAP_USD, HE_US_CLIENT_DAY_SPEND_CAP_USD), ни общий
 * потолок ENG (HE_US_ENG_DAY_SPEND_CAP_USD) не заданы (пусто
 * или переменной нет — это дефолт), каждая проверка ниже возвращает 'off' ДО
 * первого запроса к БД: ни
 * чтения журнала, ни записи паузы, ни алерта. Поведение любого рынка в дефолтной
 * конфигурации — прежнее, байт в байт по запросам.
 *
 * ЧТО ОГРАНИЧИВАЕТ (когда включён), только he_projects.market = 'us':
 *  - потолок ПРОЕКТА — расход проекта за всё время журнала;
 *  - потолок СУТОК — расход ЭТОГО ЖЕ проекта за СКОЛЬЗЯЩИЕ последние 24 часа
 *    (от момента проверки назад), а не за календарные UTC-сутки. Ночной тик
 *    добора идёт в 03:20 UTC: календарные сутки показали бы ему только расход
 *    с полуночи, и ночную покупку суточный порог почти никогда не остановил
 *    бы. В окне тика — расход последних 24 часов, как правило вместе со
 *    сборкой, купленной прошлой ночью (её оплата идёт после вчерашнего тика;
 *    выпадают только минуты, на которые сегодняшний тик пришёл позже). Не
 *    рынка целиком: такой потолок ставит на паузу и проекты, которые за эти
 *    сутки не потратили ничего, а паузу добора снимают по каждому руками.
 *    Поэтому рынок целиком — отдельный ОБЩИЙ потолок ENG (ниже, по умолчанию
 *    выключен, задаётся с запасом выше обычного суточного расхода ENG): он
 *    стоп-кран против опустошения общего с RU баланса провайдера, а не
 *    ежедневный лимит.
 *  - потолок КЛИЕНТА — сумма по ВСЕМ us-проектам владельца проекта
 *    (he_projects.created_by), за всё время (HE_US_CLIENT_SPEND_CAP_USD) и за
 *    скользящие 24 часа (HE_US_CLIENT_DAY_SPEND_CAP_USD). Считает его
 *    engClientSpend.ts (checkHeClientSpendCeilingForProject), здесь он только
 *    ЗОВЁТСЯ — внутри checkHeSpendCeiling, и поэтому действует везде, где
 *    действует потолок проекта: кнопки кабинета (enforceHeSpendCeiling),
 *    ворота дочейна воркера и реконсилера (createHeSpendGate), ночной тик
 *    добора (autoPipeline.ts) и выключение прохода автоподъёма баз
 *    (baseAutoResume.ts, heSpendCeilingOn). Без него десять проектов одного
 *    клиента обходили потолок проекта в десять раз. 'over' клиента делает то
 *    же, что 'over' проекта (пауза ЭТОГО проекта + алерт), — другие проекты
 *    клиента встанут на своей следующей платной постановке. Выключен (дефолт)
 *    — ни одного лишнего запроса.
 *  - ОБЩИЙ потолок ENG за скользящие 24 часа (HE_US_ENG_DAY_SPEND_CAP_USD) —
 *    расход ВСЕХ us-проектов всех клиентов (engClientSpend.ts, «ОБЩИЙ ПОТОЛОК
 *    ENG»). Едет той же проверкой клиента и действует везде, где она: 'over'
 *    с порогом 'eng_day' НЕ СТАВИТ платную стадию, как любой порог, но
 *    DURABLE-ПАУЗЫ НЕ ПИШЕТ — ни паузы автопилота (enforceHeSpendCeiling,
 *    createHeSpendGate → дочейн и реконсилер пропускают шаг без паузы), ни
 *    паузы ночного добора (autoPipeline.ts пропускает ночь проекта, как
 *    budget_exhausted). Почему: порог общий и скользящий — его достигает
 *    расход ВСЕХ клиентов, и он отпускает сам, когда окно 24 часов
 *    сдвинется; пауза на каждом проекте, которую снимает только человек
 *    (staff-кнопка добора, полный проход реконсилера), остановила бы весь
 *    рынок до ручного разбора по проекту, а ночь в 03:20 видит в окне
 *    вчерашний добор и ставила бы её снова. Пропущенный шаг двигает «Launch»
 *    клиента на шаге 3 (кнопка кабинета ниже порога пройдёт), следующий
 *    дочейн или ночной проход реконсилера (если включён); пропущенная ночь
 *    добора — следующая ночь. Кнопки кабинета упираются раньше — в гейт
 *    платных шагов (engPaidAccess: код spend_day_limit с нейтральной фразой
 *    ENG_SPEND_PAUSED_GLOBAL_TEXT). Алерт у него один на окно на процесс —
 *    его шлёт сама проверка, поэтому alertHeSpendCeiling по 'eng_day' своего
 *    сообщения про проект не шлёт (иначе каждый остановленный проект писал
 *    бы ту же новость отдельно); каждый непоставленный шаг — строкой warn
 *    вызывающего (лог воркера / портала). RU/VE2 не трогает: проект не 'us'
 *    получает 'not_us' / 'off', как у остальных.
 *
 * КАК СЧИТАЕТСЯ РАСХОД. Только журнал ENG (costTelemetry.readHeProviderSpend,
 * источник application_logs 'he_provider_usage'), а не he_jobs.cost_usd: тот не
 * знает Serper и пишет 0 вместо неизвестной цены. Сумму считает сервер одним
 * запросом (функция he_provider_spend_sum, миграция 20261009_0001) — весь
 * журнал проекта, сколько бы в нём ни было строк. Пока миграция не применена
 * (функции нет), — прежнее постраничное чтение, не больше 20 000 строк. Сумма
 * журнала — НИЖНЯЯ граница настоящего расхода: в ней нет обращений без цены
 * (их только число), Serper без тарифа (HE_US_SERPER_USD_PER_1000 не задан —
 * поиск не оценивается вовсе), конструктора баз, staff-структуризации кейсов
 * и классификатора staff-запуска с непрочитанным рынком проекта (API-роуты
 * без журнала; классификатор запуска us-проекта журнал видит — оба роута
 * запуска шаблона открывают его стадией 'launch'), вызова в полёте при смерти
 * процесса, строк, не легших в журнал, и всего, что было до выката журнала
 * (у старого проекта потолок проекта поэтому срабатывает позже, чем должен).
 * Отсюда правило вердиктов:
 *  - 'over' по нижней границе — правда (настоящий расход не меньше);
 *  - 'under' — «известная часть ниже потолка», не больше;
 *  - журнал прочитан не весь (truncated — только постраничный путь без
 *    миграции) и прочитанное ниже потолка — 'unknown': недочитанные строки
 *    могли бы его превысить. Без миграции потолок проекта у проекта длиннее
 *    20 000 обращений поэтому не держит — миграция это и чинит.
 *
 * НЕИЗВЕСТНО — ЗНАЧИТ ПУСКАЕМ (fail-open). Сбой чтения журнала или рынка,
 * срок проверки (HE_SPEND_CHECK_TIMEOUT_MS), неполное чтение ниже потолка —
 * постановка идёт как без потолка; строку в лог пишет вызывающий, передавший
 * `warn` (воркер, клиентские кнопки), у ночного добора причина едет в detail
 * ночи, а реконсилер `warn` не передаёт — у него этот случай без строки. Причина та же,
 * что у самого журнала и у предполёта ёмкости: телеметрия не имеет права
 * становиться отказом продукта. Fail-closed здесь означал бы, что любой сбой
 * application_logs (таблица без партиций, в publication realtime) ставит на
 * паузу ВСЕ us-проекты, — потолок защищает от убегающего расхода, а не от
 * собственной слепоты. Цена — в «unknown» потолок не держит.
 *
 * ЧТО ДЕЛАЕТ 'over'. Только НЕ СТАВИТ следующую платную стадию. Идущая
 * стадия доработает, уже стоящие джобы исполнятся: потолок никогда не обрывает
 * оплаченную работу на лету и не отменяет поставленное (отсюда честный перебор
 * в отчёте лейна). Проект при этом НЕ 'failed' — он на паузе в своём записанном
 * состоянии:
 *  - автопилот и кнопки кабинета (в том числе старт исследования) — причина
 *    'spend_ceiling' в he_projects.autopilot_error (recordHeAutopilotPause;
 *    миграция 20260930_0001), кабинет показывает её кодом 'spend_paused';
 *  - ночной добор — he_auto_pipeline_configs.refill_paused_at
 *    (pauseHeAutoPipelineRefill; миграция 20260930_0005) с причиной
 *    buildHeSpendCeilingPauseReason, кабинет — состояние добора 'spend_paused'.
 * И каждый раз — алерт команде (opsAlert, вид 'spend_ceiling', окно молчания
 * 6 ч по проекту): только поэтому текст кабинета вправе сказать «команда
 * уведомлена».
 *
 * ИССЛЕДОВАНИЕ ПРОВЕРЯЕТСЯ ТОЛЬКО НА СТАРТЕ — кнопкой кабинета «Try again»
 * (роут client/eng/projects/[id]/research; есть только у research, вставшего
 * техническим сбоем). Начатую цепочку research воркер
 * доводит до конца без проверки (worker/hypothesisEngine.ts,
 * enqueueNextResearchStage): пауза посреди цепочки оставила бы проект
 * 'researching' без джобы, а выйти из неё можно только повтором с site_profile,
 * то есть заплатив ещё раз за уже сделанные стадии. Цена — перебор не больше
 * ОДНОГО исследования (с повторами упавших стадий, как у любой стадии): старт
 * видит расход чуть ниже порога, и цепочка из шести стадий (site_profile …
 * clustering) проходит целиком. Создание проекта (первое исследование)
 * потолком ПРОЕКТА не проверяется: у нового проекта журнала нет, порог
 * недостижим; потолок КЛИЕНТА его проверяет — гейт платных шагов кабинета
 * (engPaidAccess.requireEngPaidAccess, действие 'create_project'). Staff-кнопка
 * исследования не проверяется намеренно (см. ниже про staff-инструмент).
 *
 * КТО СНИМАЕТ ПАУЗУ. Таймера нет ни у одной. Потолок проекта не опускается
 * сам — нужен поднятый HE_US_PROJECT_SPEND_CAP_USD (потолок клиента —
 * поднятый HE_US_CLIENT_SPEND_CAP_USD); потолки суток отпускает
 * время — когда расход проекта за последние 24 часа опустится ниже порога, —
 * но и тогда никто не ставит пропущенную стадию сам. Возобновляет человек тем
 * же путём, что и любую паузу автопилота: «Start outreach» клиента
 * (reconcileHeAutopilotProject; ночной проход того же кода — только при
 * HE_AUTOPILOT_RECONCILE, по умолчанию его нет), «Try again» шага 1, если отказ
 * получил старт исследования (отказ состояния проекта не меняет, и кнопка
 * остаётся), staff-кнопка снятия паузы добора.
 * Staff-инструмент (/api/tools/hypothesis-engine/**) этой проверки не делает
 * намеренно: это поверхность, с которой сотрудник продолжает проект по одному
 * шагу, а дочейны после его шага снова упираются в потолок.
 *
 * Причину 'spend_ceiling' на проекте снимают только те, кто вправе сказать,
 * что ни одна вертикаль на ней больше не стоит:
 *  - полный проход реконсилера — он видит все вертикали;
 *  - дочейн автопилота при прогрессе своей вертикали, когда это разрешает
 *    followupMayClearPause (других выбранных вертикалей нет) — его общее
 *    правило снятия любой причины (autopilotNext.enqueueAutopilotFollowups);
 *  - проверка кнопки кабинета, увидевшая 'under' (enforceHeSpendCeiling), —
 *    через clearHeSpendCeilingPauseIfSafe: только у проекта без автопилота
 *    (пропущенных шагов автопилота нет, причину записал отказ кнопки) или
 *    когда followupMayClearPause разрешает для её вертикали.
 * Ворота прохода (createHeSpendGate: дочейн воркера, реконсилер) по 'under'
 * не снимают ничего — у их вызывающих снятие своё, по правилам выше.
 *
 * Модуль без логгера (как autoPipeline.ts): его тянут воркер, крон и роуты
 * Next; строки лога пишет вызывающий через `warn`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { clearHeSpendCeilingPauseIfSafe, recordHeAutopilotPause } from './autopilotNext';
import type { HeSpendGate } from './autopilotNext';
import { readHeProviderSpend, type HeProviderSpend } from './costTelemetry';
// Цикл импортов с engClientSpend намеренный и безопасный: обе стороны читают
// чужие экспорты только внутри функций, ни одного на верхнем уровне модуля.
import {
  HE_US_CLIENT_DAY_SPEND_CAP_ENV,
  HE_US_CLIENT_SPEND_CAP_ENV,
  HE_US_ENG_DAY_SPEND_CAP_ENV,
  checkHeClientSpendCeilingForProject,
  type HeClientSpend,
} from './engClientSpend';
import { normalizeHeMarket } from './market';
import { notifyHeClientStop } from './opsAlert';

/** Потолок проекта за всё время журнала, USD. Пусто/нет — выключен (дефолт). */
export const HE_US_PROJECT_SPEND_CAP_ENV = 'HE_US_PROJECT_SPEND_CAP_USD';
/**
 * Потолок проекта за СКОЛЬЗЯЩИЕ последние 24 часа (HE_SPEND_DAY_WINDOW_MS до
 * момента проверки), USD. Не календарные UTC-сутки — см. шапку. Пусто/нет —
 * выключен (дефолт).
 */
export const HE_US_PROJECT_DAY_SPEND_CAP_ENV = 'HE_US_PROJECT_DAY_SPEND_CAP_USD';
/** Окно потолка суток: последние 24 часа до момента проверки. */
export const HE_SPEND_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Тариф Serper, USD за 1 000 кредитов. Пусто/нет — поиск в сумму не входит
 * вовсе (в коде тарифа нет, см. решение владельца в отчёте журнала).
 */
export const HE_US_SERPER_TARIFF_ENV = 'HE_US_SERPER_USD_PER_1000';

/**
 * Срок одной проверки. Не уложилась — 'unknown' (пускаем). Воркер проверяет
 * (ворота дочейна автопилота) под сроком участка после стадии
 * (POST_STAGE_DEADLINE_MS = 2 мин), и проверка не должна съесть его: чтение
 * журнала — одна сумма на сервере, а без миграции — до 20 страниц.
 */
export const HE_SPEND_CHECK_TIMEOUT_MS = 20_000;

/** Причина паузы автопилота, которую пишет потолок (HE_AUTOPILOT_PAUSE_REASONS). */
export const HE_SPEND_CEILING_PAUSE = 'spend_ceiling' as const;

export interface HeSpendCaps {
  /** null — потолок проекта выключен. */
  projectCapUsd: number | null;
  /** null — потолок суток выключен. */
  dayCapUsd: number | null;
  /** Потолок КЛИЕНТА за всё время (HE_US_CLIENT_SPEND_CAP_USD); null — выключен. */
  clientCapUsd: number | null;
  /** Потолок клиента за последние 24 часа (HE_US_CLIENT_DAY_SPEND_CAP_USD); null — выключен. */
  clientDayCapUsd: number | null;
  /** Общий потолок ENG за последние 24 часа (HE_US_ENG_DAY_SPEND_CAP_USD); null — выключен. */
  engDayCapUsd: number | null;
  /** null — Serper не оценивается. */
  serperUsdPer1000: number | null;
  /** Переменные, заданные нечитаемым значением (0, минус, не число) — считаются не заданными. */
  rejected: string[];
}

function positiveUsd(raw: string | undefined): number | null | 'rejected' {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : 'rejected';
}

/**
 * Пороги из окружения. Пусто или нет переменной — выключен (дефолт).
 * Нечитаемое значение («0», «-5», «abc») — тоже выключен, но имя едет в
 * `rejected`, и вызывающий пишет его в лог: «0» не означает «пауза для всех».
 */
export function readHeSpendCaps(env: NodeJS.ProcessEnv = process.env): HeSpendCaps {
  const rejected: string[] = [];
  const read = (name: string): number | null => {
    const value = positiveUsd(env[name]);
    if (value === 'rejected') {
      rejected.push(name);
      return null;
    }
    return value;
  };
  return {
    projectCapUsd: read(HE_US_PROJECT_SPEND_CAP_ENV),
    dayCapUsd: read(HE_US_PROJECT_DAY_SPEND_CAP_ENV),
    clientCapUsd: read(HE_US_CLIENT_SPEND_CAP_ENV),
    clientDayCapUsd: read(HE_US_CLIENT_DAY_SPEND_CAP_ENV),
    engDayCapUsd: read(HE_US_ENG_DAY_SPEND_CAP_ENV),
    serperUsdPer1000: read(HE_US_SERPER_TARIFF_ENV),
    rejected,
  };
}

/**
 * Включён ли потолок хоть одним порогом — проекта, клиента или общим потолком
 * ENG (тариф Serper сам по себе его не включает). Читатели «включён ли вообще»:
 * ранний выход checkHeSpendCeiling и выключение прохода автоподъёма баз
 * (baseAutoResume.ts), который ставит сборку внутри SQL, мимо этой проверки.
 */
export function heSpendCeilingOn(
  caps: Pick<HeSpendCaps, 'projectCapUsd' | 'dayCapUsd' | 'clientCapUsd' | 'clientDayCapUsd'>
    & Partial<Pick<HeSpendCaps, 'engDayCapUsd'>>,
): boolean {
  return heProjectCapsOn(caps) || heClientCapsOn(caps);
}

function heProjectCapsOn(caps: Pick<HeSpendCaps, 'projectCapUsd' | 'dayCapUsd'>): boolean {
  return caps.projectCapUsd !== null || caps.dayCapUsd !== null;
}

/** Пороги, которые считает проверка клиента: его собственные и общий потолок ENG. */
function heClientCapsOn(
  caps: Pick<HeSpendCaps, 'clientCapUsd' | 'clientDayCapUsd'> & Partial<Pick<HeSpendCaps, 'engDayCapUsd'>>,
): boolean {
  return caps.clientCapUsd !== null || caps.clientDayCapUsd !== null || (caps.engDayCapUsd ?? null) !== null;
}

/* ─────────────── Чистое решение ─────────────── */

export interface HeSpendCeilingInput {
  /** Известный расход проекта (нижняя граница); null — неизвестен. */
  projectSpendUsd: number | null;
  /** Известный расход проекта за последние 24 часа; null — неизвестен. */
  daySpendUsd: number | null;
  /** null — порог выключен. */
  projectCapUsd: number | null;
  /** null — порог выключен. */
  dayCapUsd: number | null;
}

/**
 * 'client' / 'client_day' — потолки клиента (сумма по всем его us-проектам);
 * 'eng_day' — общий потолок ENG (все us-проекты всех клиентов, 24 часа).
 */
export type HeSpendCap = 'project' | 'day' | 'client' | 'client_day' | 'eng_day';

/**
 *  - 'off'     — оба порога выключены (расход не смотрится вовсе);
 *  - 'over'    — известный расход ДОСТИГ порога (>=): дальше не ставим;
 *  - 'unknown' — у включённого порога расход неизвестен, и ни один порог не
 *                доказанно достигнут: вызывающий пускает (fail-open);
 *  - 'under'   — у каждого включённого порога известный расход ниже него.
 */
export type HeSpendCeilingVerdict =
  | { kind: 'off' }
  | { kind: 'under' }
  | { kind: 'over'; cap: HeSpendCap; spendUsd: number; capUsd: number }
  | { kind: 'unknown'; cap: HeSpendCap };

const validCap = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const knownSpend = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Достигнут ли потолок. Чистая: без БД, без часов, без окружения.
 *
 * Порог null (или не положительное конечное число) — выключен, его расход не
 * читается вовсе. Расход null (или не конечное, отрицательное) — неизвестен.
 * «Доказанно достигнут» важнее «неизвестно»: если один порог достигнут, второй
 * неизвестный ничего не меняет. Порог проекта проверяется первым — в алерте
 * назван он, а не сутки.
 */
export function exceedsHeSpendCeiling(input: HeSpendCeilingInput): HeSpendCeilingVerdict {
  const projectCap = validCap(input.projectCapUsd);
  const dayCap = validCap(input.dayCapUsd);
  if (projectCap === null && dayCap === null) return { kind: 'off' };
  const projectSpend = knownSpend(input.projectSpendUsd);
  const daySpend = knownSpend(input.daySpendUsd);
  if (projectCap !== null && projectSpend !== null && projectSpend >= projectCap) {
    return { kind: 'over', cap: 'project', spendUsd: projectSpend, capUsd: projectCap };
  }
  if (dayCap !== null && daySpend !== null && daySpend >= dayCap) {
    return { kind: 'over', cap: 'day', spendUsd: daySpend, capUsd: dayCap };
  }
  if (projectCap !== null && projectSpend === null) return { kind: 'unknown', cap: 'project' };
  if (dayCap !== null && daySpend === null) return { kind: 'unknown', cap: 'day' };
  return { kind: 'under' };
}

/* ─────────────── Проверка по журналу ─────────────── */

export interface HeSpendCheck {
  /** 'not_us' — проект не рынка us: потолок к нему не применяется. */
  verdict: HeSpendCeilingVerdict | { kind: 'not_us' };
  caps: HeSpendCaps;
  /** Имя проекта (для алерта), если прочиталось. */
  projectName: string | null;
  /** Журнал проекта за всё время (только при включённом потолке проекта). */
  projectSpend: HeProviderSpend | null;
  /** Журнал проекта за последние 24 часа (только при включённом потолке суток). */
  daySpend: HeProviderSpend | null;
  /** Расход клиента за всё время (только при включённом потолке клиента). */
  clientSpend: HeClientSpend | null;
  /** Расход клиента за последние 24 часа (только при включённом потолке клиента за сутки). */
  clientDaySpend: HeClientSpend | null;
  /** Расход всего рынка us за последние 24 часа (только при включённом общем потолке ENG). */
  engDaySpend: HeClientSpend | null;
  /** Почему расход неизвестен (безопасный текст для лога); null — прочитан. */
  failure: string | null;
}

/**
 * Сумма, годная для порога: нижняя граница, если журнал прочитан целиком
 * (сумма на сервере — всегда); при неполном чтении (постраничный путь без
 * миграции 20261009_0001) — только если уже она достигает порога, иначе
 * недочитанное могло бы его превысить → null, «неизвестно» (пускаем).
 */
function boundedSpend(spend: HeProviderSpend, cap: number | null): number | null {
  if (!spend.truncated) return spend.knownUsd;
  return cap !== null && spend.knownUsd >= cap ? spend.knownUsd : null;
}

/**
 * Срок без unref НАМЕРЕННО: одноразовый крон, у которого повисло чтение
 * журнала, иначе мог бы выйти посреди обхода, не дождавшись ни вердикта, ни
 * своей паузы; таймер снимается, как только работа кончилась.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface HeSpendCheckArgs {
  projectId: string;
  /** Рынок, если вызывающий его уже прочитал (тогда без лишнего SELECT). */
  market?: unknown;
  projectName?: string | null;
  caps?: HeSpendCaps;
  now?: Date;
  timeoutMs?: number;
}

/**
 * Проверить потолки проекта И клиента. НИКОГДА НЕ БРОСАЕТ и не ждёт дольше
 * `timeoutMs` (обе проверки идут параллельно, у каждой свой срок).
 *
 * Запросы: при выключенных потолках — ноль. Потолок проекта: рынок и имя
 * проекта (один SELECT, если вызывающий не передал рынок), затем журнал — за
 * всё время (потолок проекта) и за последние 24 часа до `now` (потолок суток),
 * параллельно, по одной сумме на сервере (без миграции — постранично).
 * Потолок клиента: владелец и рынок проекта (один SELECT), затем по одной
 * сумме на сервере на каждый включённый порог (engClientSpend.ts). Рынок не
 * 'us' — журнал не читается.
 *
 * Сведение двух ответов: доказанное 'over' важнее всего (порог проекта
 * называется первым, как и раньше), затем 'unknown' (пускаем, fail-open),
 * затем 'not_us', затем 'under'.
 */
export async function checkHeSpendCeiling(
  db: SupabaseClient,
  args: HeSpendCheckArgs,
): Promise<HeSpendCheck> {
  const caps = args.caps ?? readHeSpendCaps();
  const base: HeSpendCheck = {
    verdict: { kind: 'off' },
    caps,
    projectName: args.projectName ?? null,
    projectSpend: null,
    daySpend: null,
    clientSpend: null,
    clientDaySpend: null,
    engDaySpend: null,
    failure: null,
  };
  if (!heSpendCeilingOn(caps)) return base;
  // Рынок уже известен и он не 'us' — ни одна из проверок не нужна.
  if (args.market !== undefined && normalizeHeMarket(args.market) !== 'us') {
    return { ...base, verdict: { kind: 'not_us' } };
  }
  const [project, client] = await Promise.all([
    heProjectCapsOn(caps) ? checkHeProjectCaps(db, { ...args, caps }) : Promise.resolve(null),
    heClientCapsOn(caps) ? checkHeClientCaps(db, { ...args, caps }) : Promise.resolve(null),
  ]);
  const merged: HeSpendCheck = {
    ...base,
    projectName: project?.projectName ?? base.projectName,
    projectSpend: project?.projectSpend ?? null,
    daySpend: project?.daySpend ?? null,
    clientSpend: client?.clientSpend ?? null,
    clientDaySpend: client?.clientDaySpend ?? null,
    engDaySpend: client?.engDaySpend ?? null,
    failure: [project?.failure, client?.failure].filter(Boolean).join('; ') || null,
  };
  const pv = project?.verdict ?? null;
  const cv = client?.verdict ?? null;
  const verdict: HeSpendCheck['verdict'] =
    pv?.kind === 'over' ? pv
      : cv?.kind === 'over' ? cv
        : pv?.kind === 'unknown' ? pv
          : cv?.kind === 'unknown' ? cv
            : pv?.kind === 'not_us' || cv?.kind === 'not_us' ? { kind: 'not_us' }
              : pv?.kind === 'under' || cv?.kind === 'under' ? { kind: 'under' }
                : { kind: 'off' };
  return { ...merged, verdict };
}

/**
 * Потолки клиента и общий потолок ENG по id проекта — вызов
 * engClientSpend.checkHeClientSpendCeilingForProject и перевод его ответа в
 * словарь этого модуля. Не бросает (вызываемая не бросает). 'off' от неё при
 * включённом пороге значит одно — проект не 'us'.
 */
async function checkHeClientCaps(
  db: SupabaseClient,
  args: HeSpendCheckArgs & { caps: HeSpendCaps },
): Promise<Pick<HeSpendCheck, 'verdict' | 'clientSpend' | 'clientDaySpend' | 'engDaySpend' | 'failure'>> {
  const check = await checkHeClientSpendCeilingForProject(db, {
    projectId: args.projectId,
    caps: {
      totalCapUsd: args.caps.clientCapUsd,
      dayCapUsd: args.caps.clientDayCapUsd,
      engDayCapUsd: args.caps.engDayCapUsd,
      serperUsdPer1000: args.caps.serperUsdPer1000,
      rejected: [],
    },
    now: args.now,
    timeoutMs: args.timeoutMs,
  });
  const v = check.verdict;
  const cap = (c: 'total' | 'day' | 'eng_day'): HeSpendCap =>
    c === 'total' ? 'client' : c === 'day' ? 'client_day' : 'eng_day';
  const verdict: HeSpendCheck['verdict'] =
    v.kind === 'over' ? { kind: 'over', cap: cap(v.cap), spendUsd: v.spendUsd, capUsd: v.capUsd }
      : v.kind === 'unknown' ? { kind: 'unknown', cap: cap(v.cap) }
        : v.kind === 'under' ? { kind: 'under' }
          : { kind: 'not_us' };
  return {
    verdict,
    clientSpend: check.total,
    clientDaySpend: check.day,
    engDaySpend: check.engDay,
    failure: check.failure ? `client: ${check.failure}` : null,
  };
}

/** Потолок ПРОЕКТА — прежняя проверка (см. checkHeSpendCeiling). Не бросает. */
async function checkHeProjectCaps(
  db: SupabaseClient,
  args: HeSpendCheckArgs & { caps: HeSpendCaps },
): Promise<HeSpendCheck> {
  const caps = args.caps;
  const result: HeSpendCheck = {
    verdict: { kind: 'off' },
    caps,
    projectName: args.projectName ?? null,
    projectSpend: null,
    daySpend: null,
    clientSpend: null,
    clientDaySpend: null,
    engDaySpend: null,
    failure: null,
  };

  const unknown = (failure: string): HeSpendCheck => ({
    ...result,
    verdict: { kind: 'unknown', cap: caps.projectCapUsd !== null ? 'project' : 'day' },
    failure,
  });

  try {
    const outcome = await withTimeout(
      (async () => {
        let market = args.market;
        if (market === undefined) {
          const { data, error } = await db
            .from('he_projects')
            .select('market, name')
            .eq('id', args.projectId)
            .maybeSingle();
          if (error) return { failure: `he_projects market read: ${error.code ?? 'error'}` };
          // Проекта нет — ставить некому и платить не за что; пусть решает
          // вызывающий (его собственная вставка упрётся в FK или в дедуп).
          if (!data) return { failure: 'project not found' };
          const row = data as { market?: unknown; name?: unknown };
          market = row.market;
          if (result.projectName === null && typeof row.name === 'string') result.projectName = row.name;
        }
        if (normalizeHeMarket(market) !== 'us') return { notUs: true as const };
        // Окно суток — скользящее: последние 24 часа до момента проверки.
        const nowMs = (args.now ?? new Date()).getTime();
        const dayWindow = {
          fromIso: new Date(nowMs - HE_SPEND_DAY_WINDOW_MS).toISOString(),
          toIso: new Date(nowMs).toISOString(),
        };
        const [projectSpend, daySpend] = await Promise.all([
          caps.projectCapUsd !== null
            ? readHeProviderSpend(db, { projectId: args.projectId, serperUsdPer1000: caps.serperUsdPer1000 })
            : Promise.resolve(null),
          caps.dayCapUsd !== null
            ? readHeProviderSpend(db, {
              projectId: args.projectId,
              ...dayWindow,
              serperUsdPer1000: caps.serperUsdPer1000,
            })
            : Promise.resolve(null),
        ]);
        return { projectSpend, daySpend };
      })(),
      args.timeoutMs ?? HE_SPEND_CHECK_TIMEOUT_MS,
    );
    if (outcome === 'timeout') return unknown(`check exceeded ${args.timeoutMs ?? HE_SPEND_CHECK_TIMEOUT_MS} ms`);
    if ('failure' in outcome) return unknown(outcome.failure ?? 'unknown');
    if ('notUs' in outcome) return { ...result, verdict: { kind: 'not_us' } };
    const { projectSpend, daySpend } = outcome;
    return {
      ...result,
      projectSpend,
      daySpend,
      verdict: exceedsHeSpendCeiling({
        projectSpendUsd: projectSpend ? boundedSpend(projectSpend, caps.projectCapUsd) : null,
        daySpendUsd: daySpend ? boundedSpend(daySpend, caps.dayCapUsd) : null,
        projectCapUsd: caps.projectCapUsd,
        dayCapUsd: caps.dayCapUsd,
      }),
      // Неполное чтение бывает только на постраничном пути — значит, функции
      // суммы в БД нет: строка лога говорит, что чинит её миграция.
      failure:
        (projectSpend?.truncated || daySpend?.truncated)
          ? 'journal read truncated at 20 000 rows (he_provider_spend_sum missing: migration 20261009_0001 not applied)'
          : null,
    };
  } catch (e) {
    // Текст ошибки чтения журнала — от costTelemetry (код ответа функции суммы
    // либо «application_logs … read: <сообщение PostgREST>» постраничного
    // пути): в лог воркера он годится, наружу не уходит.
    return unknown(e instanceof Error ? e.message.slice(0, 200) : 'unknown');
  }
}

/* ─────────────── Алерт команде ─────────────── */

/** Откуда пришла остановленная постановка — строка алерта и лога. */
export type HeSpendPath =
  | 'autopilot_followup'
  | 'autopilot_reconcile_client'
  | 'autopilot_reconcile_nightly'
  | 'client_button'
  // Тик автозапуска (engAutoLaunch → engClientLaunch.runHeEngTemplateLaunch).
  | 'auto_launch'
  | 'nightly_refill';

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Причина для алерта: какой порог, сколько известно, что не поставлено. */
/**
 * Подпись порога для алерта. Функцией, а не таблицей на верхнем уровне модуля:
 * имена порогов клиента импортируются из engClientSpend, а он импортирует этот
 * модуль — таблица, вычисленная при загрузке, прочла бы их до инициализации.
 */
function capLabel(cap: HeSpendCap): string {
  switch (cap) {
    case 'project':
      return `потолок проекта ${HE_US_PROJECT_SPEND_CAP_ENV}`;
    case 'day':
      return `потолок за последние 24 ч ${HE_US_PROJECT_DAY_SPEND_CAP_ENV}`;
    case 'client':
      return `потолок клиента (все его us-проекты) ${HE_US_CLIENT_SPEND_CAP_ENV}`;
    case 'client_day':
      return `потолок клиента за последние 24 ч ${HE_US_CLIENT_DAY_SPEND_CAP_ENV}`;
    case 'eng_day':
      return `общий потолок ENG (все us-проекты всех клиентов) за последние 24 ч ${HE_US_ENG_DAY_SPEND_CAP_ENV}`;
  }
}

export function describeHeSpendStop(check: HeSpendCheck, stage: string, path: HeSpendPath): string {
  const verdict = check.verdict;
  const spend: Pick<HeProviderSpend, 'calls' | 'unpricedCalls' | 'lostRows' | 'skippedRows'> | null =
    verdict.kind !== 'over'
      ? check.projectSpend
      : verdict.cap === 'day'
        ? check.daySpend
        : verdict.cap === 'client'
          ? check.clientSpend
          : verdict.cap === 'client_day'
            ? check.clientDaySpend
            : verdict.cap === 'eng_day'
              ? check.engDaySpend
              : check.projectSpend;
  const head =
    verdict.kind === 'over'
      ? `${capLabel(verdict.cap)}: ` +
        `известно ${usd(verdict.spendUsd)} ≥ ${usd(verdict.capUsd)}` +
        (spend ? ` по ${spend.calls} обращ.` : '')
      : `потолок: ${verdict.kind}`;
  // Нижняя граница — словами: число без оговорки команда прочтёт как точное.
  const caveats = [
    spend && spend.unpricedCalls > 0 ? `без цены ${spend.unpricedCalls} обращ.` : null,
    check.caps.serperUsdPer1000 === null ? 'Serper не оценён (нет тарифа)' : null,
    spend && spend.lostRows > 0 ? `потеряно строк журнала ${spend.lostRows}` : null,
    spend && spend.skippedRows > 0 ? `не разобрано строк журнала ${spend.skippedRows}` : null,
  ].filter(Boolean);
  return `${head}${caveats.length ? ` (нижняя граница: ${caveats.join(', ')})` : ''}; не поставлено: ${stage} (${path})`;
}

/**
 * Алерт команде: проект встал на потолке. Не бросает; ждёт не дольше срока
 * отправки opsAlert (HE_OPS_SEND_TIMEOUT_MS). Одноразовый процесс (крон)
 * обязан позвать flushHeOpsAlerts перед выходом — как и для остальных видов.
 *
 * Общий потолок ENG ('eng_day') — без сообщения про проект: про него уже
 * написала сама проверка (engClientSpend.checkHeEngDaySpendCeiling — одно
 * сообщение на окно на процесс), а он останавливает все us-проекты разом, и
 * сообщение на каждый был бы той же новостью много раз. Пауза проекта при этом
 * записывается вызывающим как обычно.
 */
export function alertHeSpendCeiling(args: {
  projectId: string;
  check: HeSpendCheck;
  stage: string;
  path: HeSpendPath;
  jobId?: string | null;
  baseId?: string | null;
  verticalId?: string | null;
  /** Поставил ли паузу ЭТОТ вызов (null — не применимо или неизвестно). */
  pauseRecorded?: boolean | null;
  clientSees: string;
}): Promise<void> {
  if (args.check.verdict.kind === 'over' && args.check.verdict.cap === 'eng_day') return Promise.resolve();
  return notifyHeClientStop({
    projectId: args.projectId,
    projectName: args.check.projectName,
    // Алерт уходит только после вердикта 'over', а он бывает только у 'us'.
    market: 'us',
    stage: args.stage,
    kind: 'spend_ceiling',
    provider: 'budget',
    reason: describeHeSpendStop(args.check, args.stage, args.path),
    jobId: args.jobId ?? null,
    baseId: args.baseId ?? null,
    verticalId: args.verticalId ?? null,
    pauseRecorded: args.pauseRecorded ?? null,
    clientSees: args.clientSees,
  });
}

/* ─────────────── Решение у постановки ─────────────── */

export interface HeSpendEnforceArgs {
  projectId: string;
  market?: unknown;
  projectName?: string | null;
  /** Стадия, которую собирались поставить. */
  stage: string;
  path: HeSpendPath;
  jobId?: string | null;
  baseId?: string | null;
  verticalId?: string | null;
  /** Строка лога вызывающего (неизвестный расход, нечитаемый порог). */
  warn?: (msg: string) => void;
  caps?: HeSpendCaps;
  now?: Date;
}

/** Снимать ли по 'under' устаревшую причину: прямые вызовы — да, ворота прохода — нет. */
export interface HeSpendEnforceOptions {
  clearStalePause: boolean;
}

export interface HeSpendDecision {
  /**
   * false — потолок достигнут: НЕ ставить; пауза и алерт уже сделаны (у общего
   * потолка ENG — без паузы, см. heSpendStopIsGlobal).
   */
  allowed: boolean;
  check: HeSpendCheck;
}

/**
 * Остановил ли постановку ОБЩИЙ потолок ENG ('eng_day'). Тогда паузы на
 * проекте нет (шапка, «ОБЩИЙ потолок ENG»), и вызывающему нельзя отвечать
 * фразой карточки паузы (HE_SPEND_PAUSED_EN: «…continues when they resume
 * it») — роутам кабинета отвечать engSpendLimitRefusal('eng_day').
 */
export function heSpendStopIsGlobal(check: Pick<HeSpendCheck, 'verdict'>): boolean {
  return check.verdict.kind === 'over' && check.verdict.cap === 'eng_day';
}

/** Что клиент видит при паузе автопилота по потолку (строка алерта). */
const CLIENT_SEES_AUTOPILOT_HOLD = 'карточку паузы «Work on this project is paused on our side…» (код spend_paused)';

/**
 * Проверить потолок прямо перед платной постановкой и, если он достигнут,
 * поставить проект на паузу автопилота ('spend_ceiling') и сообщить команде.
 * Для ночного добора — НЕ этот путь (у него своя пауза, autoPipeline.ts).
 *
 *  - 'over'           → пауза + алерт, allowed=false;
 *  - 'over' общего потолка ENG ('eng_day') → allowed=false БЕЗ паузы и без
 *                       алерта про проект (алерт рынка уже отправила проверка;
 *                       почему без паузы — шапка, «ОБЩИЙ потолок ENG»), строка
 *                       warn вызывающего: какой шаг какого проекта не поставлен;
 *  - 'under'          → allowed=true; устаревшую причину 'spend_ceiling'
 *                       снимает clearHeSpendCeilingPauseIfSafe, и только там,
 *                       где это не прячет пропущенный шаг ДРУГОЙ вертикали:
 *                       у проекта без автопилота или когда followupMayClearPause
 *                       разрешает для `verticalId` (без вертикали — research,
 *                       письма по базе — у проекта с автопилотом не снимает:
 *                       это сделает «Start outreach»). Обычно это один SELECT
 *                       строки проекта и ни одной записи;
 *  - 'unknown'        → строка warn, allowed=true (fail-open, см. шапку);
 *  - 'off' / 'not_us' → ничего, allowed=true, запросов к БД ноль (off) или
 *                       один SELECT рынка, если его не передали (not_us).
 * Никогда не бросает.
 */
export async function enforceHeSpendCeiling(
  db: SupabaseClient,
  args: HeSpendEnforceArgs,
  options: HeSpendEnforceOptions = { clearStalePause: true },
): Promise<HeSpendDecision> {
  const caps = args.caps ?? readHeSpendCaps();
  if (caps.rejected.length > 0 && args.warn) {
    args.warn(`[he-spend] нечитаемое значение ${caps.rejected.join(', ')} — этот порог считается выключенным`);
  }
  const check = await checkHeSpendCeiling(db, {
    projectId: args.projectId,
    market: args.market,
    projectName: args.projectName,
    caps,
    now: args.now,
  });
  const verdict = check.verdict;
  if (verdict.kind === 'over' && verdict.cap === 'eng_day') {
    // Общий потолок ENG: шаг не ставим, durable-паузы НЕ пишем — порог
    // скользящий и общий, он отпускает сам (шапка, «ОБЩИЙ потолок ENG»).
    // Строка warn — чтобы по логу было видно, какой проект недополучил шаг.
    args.warn?.(
      `[he-spend] общий потолок ENG достигнут ($${verdict.spendUsd.toFixed(2)} ≥ $${verdict.capUsd.toFixed(2)} ` +
        `за 24 ч) — ${args.stage} проекта ${args.projectId} не поставлен (${args.path}), паузы нет: ` +
        'шаг двигает «Launch» клиента на шаге 3, когда расход опустится ниже порога',
    );
    return { allowed: false, check };
  }
  if (verdict.kind === 'over') {
    const paused = await recordHeAutopilotPause(db, args.projectId, HE_SPEND_CEILING_PAUSE);
    await alertHeSpendCeiling({
      projectId: args.projectId,
      check,
      stage: args.stage,
      path: args.path,
      jobId: args.jobId,
      baseId: args.baseId,
      verticalId: args.verticalId,
      pauseRecorded: paused,
      clientSees: CLIENT_SEES_AUTOPILOT_HOLD,
    });
    return { allowed: false, check };
  }
  if (verdict.kind === 'under') {
    if (options.clearStalePause) {
      await clearHeSpendCeilingPauseIfSafe(db, args.projectId, args.verticalId ?? null);
    }
  } else if (verdict.kind === 'unknown' && args.warn) {
    args.warn(
      `[he-spend] расход проекта ${args.projectId} или его клиента неизвестен (${check.failure ?? verdict.cap}) — ` +
        `${args.stage} ставим без потолка (fail-open)`,
    );
  }
  return { allowed: true, check };
}

/**
 * Ворота для одного прохода автопилота (дочейн воркера, реконсилер): проверка
 * делается ОДИН раз, при первой платной постановке, и её итог запоминается —
 * между постановками одного прохода расход не меняется (платит воркер, а он
 * ещё не взял ни одной из них). Стадия в алерте — та, на которой ворота
 * спросили впервые. Пока ворота не спросили, запросов нет вовсе.
 *
 * По 'under' ворота причину паузы НЕ снимают: дочейн снимает её сам при
 * прогрессе по правилу followupMayClearPause, реконсилер — итогом полного
 * прохода (см. шапку, «Причину 'spend_ceiling' на проекте снимают…»).
 *
 * `stopIsGlobal()` — отказ дал ОБЩИЙ потолок ENG (паузы нет): дочейн и
 * реконсилер тогда пропускают шаг без своей паузы (причина
 * 'spend_ceiling_global'). До первого отказа — false.
 */
export function createHeSpendGate(
  db: SupabaseClient,
  args: Omit<HeSpendEnforceArgs, 'stage'>,
): HeSpendGate {
  let decision: Promise<boolean> | null = null;
  let global = false;
  const gate = (stage: string) => {
    if (!decision) {
      decision = enforceHeSpendCeiling(db, { ...args, stage }, { clearStalePause: false }).then(
        (d) => {
          global = !d.allowed && heSpendStopIsGlobal(d.check);
          return d.allowed;
        },
        () => true,
      );
    }
    return decision;
  };
  return Object.assign(gate, { stopIsGlobal: () => global });
}

/* ─────────────── Ночной добор ─────────────── */

/**
 * Начало текста причины паузы ночного добора, записанной потолком, — МАШИННЫЙ
 * ПРИЗНАК этой паузы, неизменный: по нему её отличают от паузы по ёмкости и от
 * отмены клиентом (isHeSpendCeilingPauseReason) ночной тик, серверная проекция
 * кабинета и staff-карточка (колонка refill_pause_reason — стаффный русский
 * текст, как у соседних поводов, и в кабинет сама не проецируется — едет
 * только состояние). Менять нельзя: паузы, записанные прежним
 * началом, перестали бы узнаваться. Копия начала — в карточке паузы
 * staff-инструмента (components/hypothesis-engine/ProjectDetail.tsx,
 * HE_SPEND_CEILING_PAUSE_NOTE_COPY: клиентский компонент этот модуль
 * импортировать не может).
 */
export const HE_SPEND_CEILING_PAUSE_NOTE = 'Потолок расхода ENG достигнут';

/** Текст причины паузы добора по потолку — для сотрудника. */
export function buildHeSpendCeilingPauseReason(check: HeSpendCheck): string {
  return (
    `${HE_SPEND_CEILING_PAUSE_NOTE}: ${describeHeSpendStop(check, 'base_collect', 'nightly_refill')}. ` +
    'Ночной добор остановлен до явного возобновления сотрудником; если порог не поднят (а для суточного — ' +
    'если расход проекта или клиента за последние 24 часа всё ещё не ниже него), следующая ночь поставит паузу снова.'
  );
}

/**
 * Пауза добора записана потолком расхода — стабильный признак для серверных
 * читателей refill_pause_reason: ночного тика (autoPipeline.ts) и проекции
 * кабинета (clientEngProjection.ts). Клиентский компонент модуль не
 * импортирует — у него копия начала (см. HE_SPEND_CEILING_PAUSE_NOTE).
 */
export function isHeSpendCeilingPauseReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(HE_SPEND_CEILING_PAUSE_NOTE);
}
