/**
 * ENG Command Center (клиентский кабинет /client/eng/dashboard): чистая
 * логика агрегата — вывод этапа вертикали из сущностей, расчёт ближайшего
 * авто-добора (ежедневно 03:20 UTC, крон heAutoPipelineCron) и сборка ленты
 * событий из jobs/templates/runs.
 *
 * Всё время — UTC: дневные суммы и слот крона считаются по UTC-суткам
 * (как daily_leads_cap в refill-ветке base_collect). Строки stageDetail и
 * текстов событий — английские: кабинет ENG-клиентов англоязычный.
 *
 * Роут app/src/app/api/client/eng/dashboard/route.ts — тонкая обвязка
 * (auth + скоуп created_by + батч-запросы), вся склейка здесь.
 */

import { heLaunchIsIncomplete, parseLaunchInfo, type HeTemplateLaunchInfo } from './launchHandoff';
import type { HeClientStageErrorCode } from './clientEngProjection';
// Только типы: набор причин пропуска одна на тик, долив и ленту, вердикт
// основной кампании — тот же, что у гейта ночи, а модуль тика (instantly-клиент,
// кэш статусов) в агрегат дашборда не едет.
import type { HeRefillMainRestartOutcome, HeRefillMainVerdict, HeRefillSendSkipReason } from './autoPipeline';
import type { HeEngClientState, HeEngSendingAccessView } from './engCampaignStatus';
// Только типы: модуль читают и экраны кабинета, а engAutoLaunch — серверный.
import type { HeEngAutoLaunchCode, HeEngAutoLaunchState } from './engAutoLaunch';
// Справочник клиентских текстов без зависимостей (тот же, что реэкспортирует
// clientErrors.ts): короткая нейтральная фраза про отказ, который чинит команда,
// и код «research ждёт описания бизнеса» (лента событий ниже).
import { HE_RESEARCH_NEEDS_DESCRIPTION_CODE, HE_TEAM_ON_IT_SHORT_EN } from '@/components/client-eng/clientFailureText';
// Порог списка Do not contact — фразе ленты о пропущенной ночи (шаг 3a- autoPipeline.ts).
import { BLOCKLIST_MAX_ENTRIES } from '@/lib/clientBlocklist/blockedContacts';

/* ─────────────────────────── Время (UTC) ─────────────────────────── */

/**
 * Пропуск ночного добора, потому что кампании запуска не берут контакты
 * (stats.sending_skip строки he_auto_pipeline_runs — её пишут тик до покупки
 * сборки и долив до провайдера, autoPipeline.ts / stages/baseCollectRefill.ts).
 * Фраза правдива для ОБОИХ мест записи: ни тот, ни другой контактов в кампанию
 * не добавил («skipped»), а куплена ли сборка, лента не говорит. Строка ленты
 * историческая, поэтому кнопку карточки она не называет: есть ли сейчас
 * «Start sending» или «Resume», зависит от нынешнего состояния (запуск до S2
 * кнопки старта не имеет вовсе), и это говорит строка «next» карточки
 * вертикали. Support назван там, где его нужно звать при любом состоянии.
 * Командой «уведомлена» здесь не пишется нигде: алерта у пропуска нет.
 */
const TOP_UP_SKIP_EN: Record<HeRefillSendSkipReason, string> = {
  top_up_off: 'daily top-up skipped — it is turned off',
  access_not_enabled: 'daily top-up skipped — sending is not on for your account yet',
  access_turned_off: 'daily top-up skipped — sending is turned off for your account; message Support',
  // Прошедшее время и по желанию клиента: строка историческая (паузы может уже
  // не быть), а пропуск 'client_paused' пишется только по Pause клиента.
  client_paused: 'daily top-up skipped — you had paused this market',
  // Гейт ночи судит ОСНОВНУЮ кампанию запуска (сегментные ночь не отменяют) —
  // фраза называет именно её. Те же фразы цитируют алерты команде
  // (autoPipeline.holdAlertBody: 'main_completed', 'main_stopped') — менять вместе.
  // Завершённую основную ночь обычно продолжает сама (стартует её после
  // долива); пропуск 'campaign_completed' пишется, только когда сами мы её не
  // продолжаем: запуск кабинет не стартовал или её прошлый повторный старт не
  // удался (блок «ЗАВЕРШЁННАЯ ОСНОВНАЯ» в autoPipeline.ts).
  campaign_completed:
    'daily top-up skipped — the main campaign of this market has completed and is not restarted automatically; ' +
    'message Support to continue it',
  campaign_stopped:
    'daily top-up skipped — our sending service stopped or removed the main campaign of this market; message Support',
  campaign_not_sending: 'daily top-up skipped — the main campaign of this market was not sending',
  status_unknown: 'daily top-up skipped — we could not confirm the main campaign of this market is sending',
  // 'unavailable' гейт пишет и когда проверить не удалось (выключатель, желание
  // клиента, кэш, пул не читаются), и когда проверка нашла, что кампания шлёт
  // не из ящиков пула проекта (запуск до self-serve, чужие адреса): фраза
  // верна для обоих — подтвердить, что кампании можно доливать, не вышло.
  unavailable: 'daily top-up skipped — we could not confirm these campaigns can take new contacts; message Support if this repeats',
  // Аккаунт владельца заблокирован сотрудником или не активен (гейт ночи,
  // autoPipeline.ts) — строку клиент видит только после разблокировки, и
  // причину блокировки она не называет. Прошедшее время: к тому моменту
  // аккаунт снова активен (как у 'client_paused' — строка историческая).
  account_blocked: 'daily top-up skipped — your account was not active',
};

/**
 * Хвост строки ленты «daily top-up: +N leads» у ночи, продолжавшей
 * завершённую основную кампанию (stats.main_restart — пишет
 * stages/baseCollectRefill.ts, «ПОВТОРНЫЙ СТАРТ»; исходы —
 * HeRefillMainRestartOutcome). null — добавить нечего: она уже отправляла
 * ('not_needed'), в неё ничего не принято ('nothing_accepted' — «+N leads»
 * правдиво и так), отмена ('cancelled' — у отменённой ночи своя строка).
 * 'failed' — «работаем» правда: долив шлёт алерт команде
 * ('main_restart_failed', autoPipeline.holdAlertBody цитирует эту фразу —
 * менять вместе).
 */
const MAIN_RESTART_FEED_EN: Record<HeRefillMainRestartOutcome, string | null> = {
  restarted: 'its completed campaign started sending again',
  not_needed: null,
  nothing_accepted: null,
  client_paused: 'you had paused this market, so its completed campaign was not started again',
  // Старт уже отправил кампании POST /activate, Pause пришёл во время него, а
  // пауза не подтвердилась: «не стартовали» было бы неправдой. «Stopping it» —
  // правда: команде ушёл алерт 'pause_failed' (engCampaignSending.ts, шаг 9).
  pause_failed:
    'you paused this market while its completed campaign was being started again; it was started and could not be paused yet, so it may still be sending (our team is stopping it)',
  access_off: 'sending was off for your account, so its completed campaign was not started again',
  cancelled: null,
  failed: `its completed campaign did not start sending again (${HE_TEAM_ON_IT_SHORT_EN})`,
};

/**
 * Возьмёт ли ближайшая ночь ЭТУ вертикаль — для строки «next» карточки, строки
 * «Daily top-up» её конвейера и счёта идущих проектов в карточке «Daily top-up»
 * блока Today. Повторяет порядок гейта ночи (autoPipeline.ts, блок «КАМПАНИИ
 * ЗАПУСКА ОТПРАВЛЯЮТ?») по тем данным, что есть у агрегата без провайдера:
 *  1. переключатель проекта — не здесь: его состояние (`projects[].refill`)
 *     кабинет печатает своей строкой;
 *  2. выключатель отправки аккаунта: 'not_enabled' → 'access_not_enabled',
 *     'turned_off' → 'access_turned_off', 'unavailable' → 'unavailable';
 *  3. желание клиента по шаблону запуска: 'paused' → 'client_paused' (и тогда,
 *     когда часть кампаний ещё отправляет: пауза не дошла до рассыльщика, а
 *     ночь всё равно пропускает); не читается → 'unavailable';
 *  4. воркспейс записи о запуске не клиента (`readable` сводки false) →
 *     'unavailable';
 *  5. запуск до self-serve отправки проекта → 'pre_self_serve': у гейта это
 *     'unavailable' шага ящиков пула (его кампании — из ящиков другого
 *     пресета), и не проходит он его при ЛЮБОМ статусе кампаний; пул не
 *     читается → 'unavailable', как у гейта;
 *  6. основной кампании нет (сплит по сегментам без неё) → 'no_main': тик такую
 *     вертикаль не берёт вовсе;
 *  7. вердикт ОСНОВНОЙ кампании по кэшу (readHeRefillMainVerdicts, то же
 *     правило, что у гейта): 'sending' → ночь её берёт; 'completed' при
 *     желании клиента 'sending' → тоже берёт (ночь продолжает завершённую:
 *     стартует её после долива — блок «ЗАВЕРШЁННАЯ ОСНОВНАЯ» в
 *     autoPipeline.ts), без желания (кабинет запуск не стартовал) или
 *     'completed_held' (прошлый повторный старт не удался) → пропуск
 *     'campaign_completed'; 'stopped' / 'not_sending' → пропуск; 'unknown'
 *     (не читался, старше 30 минут) — тик перед решением читает её сам,
 *     поэтому исход не известен, и строки кабинета говорят это условно. Кэш,
 *     шаблоны или журнал прогонов не читаются → 'unavailable'.
 * Не повторяет живую проверку адресов основной кампании (шаг 7 гейта): адресов
 * в кэше нет; такой пропуск кабинет видит строкой ленты ночи.
 */
export type EngDashTopUpVerdict =
  | 'sending'
  | 'unknown'
  | 'access_not_enabled'
  | 'access_turned_off'
  | 'unavailable'
  | 'client_paused'
  | 'pre_self_serve'
  | 'no_main'
  | 'campaign_completed'
  | 'campaign_stopped'
  | 'campaign_not_sending';

export interface EngDashTopUp {
  verdict: EngDashTopUpVerdict;
  /** Запуск разбит по сегментам: основная кампания — «Default texts» (как у карточки рынка шага 3). */
  split: boolean;
}

const TOP_UP_MAIN_VERDICT: Record<HeRefillMainVerdict, EngDashTopUpVerdict> = {
  sending: 'sending',
  unknown: 'unknown',
  // Без желания клиента 'sending' (его проверяет deriveEngTopUpVerdict).
  completed: 'campaign_completed',
  completed_held: 'campaign_completed',
  stopped: 'campaign_stopped',
  not_sending: 'campaign_not_sending',
};

/** Чистая функция — см. EngDashTopUpVerdict. */
export function deriveEngTopUpVerdict(input: {
  access: HeEngSendingAccessView;
  /** Сводка отправки читается (воркспейс записи — клиента, кэш доступен). */
  readable: boolean;
  /** Желание клиента по шаблону; null — его нет (запуск не стартовал кабинет); 'unreadable' — таблица не читается. */
  clientState: HeEngClientState | null | 'unreadable';
  /** Запуск до self-serve отправки проекта (heEngLaunchPredatesSelfServe); 'unreadable' — пул не читается. */
  preSelfServe: boolean | 'unreadable';
  /** Вердикт основной кампании; 'no_main' — её нет; null — кэш не читается. */
  main: HeRefillMainVerdict | 'no_main' | null;
}): EngDashTopUpVerdict {
  if (input.access === 'not_enabled') return 'access_not_enabled';
  if (input.access === 'turned_off') return 'access_turned_off';
  if (input.access === 'unavailable') return 'unavailable';
  if (input.clientState === 'unreadable') return 'unavailable';
  if (input.clientState === 'paused') return 'client_paused';
  if (!input.readable) return 'unavailable';
  if (input.preSelfServe === 'unreadable') return 'unavailable';
  if (input.preSelfServe) return 'pre_self_serve';
  if (input.main === 'no_main') return 'no_main';
  if (input.main === null) return 'unavailable';
  // Завершённую основную ночь продолжает сама, если клиент просил отправку.
  if (input.main === 'completed' && input.clientState === 'sending') return 'sending';
  return TOP_UP_MAIN_VERDICT[input.main];
}

/** Слот ежедневного авто-добора: 03:20 UTC (crontab heAutoPipelineCron). */
export const HE_AUTO_RUN_HOUR_UTC = 3;
export const HE_AUTO_RUN_MINUTE_UTC = 20;

/** Начало текущих UTC-суток — дневные суммы дашборда считаются по ним. */
export function utcDayStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Ближайший прогон авто-добора СТРОГО в будущем: если сейчас ровно 03:20
 * (крон стартует) или позже — следующий слот уже завтра.
 */
export function nextDailyRunIso(now: Date): string {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      HE_AUTO_RUN_HOUR_UTC,
      HE_AUTO_RUN_MINUTE_UTC,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

/* ─────────────── Остановка, которую чинит только команда ─────────────── */

/** Отказ, который чинит только команда (clientErrors.heTeamFixableFailureOf). */
export type EngTeamFixKind = 'billing' | 'configuration';

/** Платные стадии рынка, чью остановку кабинет зовёт нажать заново. */
export type EngTeamFixStage = 'chain' | 'base_analyze' | 'template';

export const ENG_TEAM_FIX_STAGES: readonly EngTeamFixStage[] = ['chain', 'base_analyze', 'template'];

/**
 * Последний закончившийся прогон стадии рынка упал отказом, который чинит
 * команда (деньги или настройка у провайдера). Наружу — только вид отказа:
 * сырой текст ошибки в кабинет не едет. Цель — рынок у писем ('chain') и
 * база у проверки контактов и итоговых писем ('template' — и генерация
 * «Rewrite letters»: та же стадия по базе снятых писем).
 *
 * Зачем: кнопка («Launch», «Rewrite letters») двигает такую остановку только
 * после починки — нажатие раньше упрётся в тот же отказ, а у писем ещё и
 * съест попытку. Письмо об остановке (engClientMail, совет 'team_fix') зовёт
 * сначала в Support; кабинет говорит то же (ENG_TEAM_FIX_STOP_EN).
 */
export interface EngTeamFixStop {
  stage: EngTeamFixStage;
  vertical_id: string | null;
  base_id: string | null;
  kind: EngTeamFixKind;
}

/** Предложение кабинета про такую остановку: то же, что у письма (совет 'team_fix'). */
export const ENG_TEAM_FIX_STOP_EN = 'A problem on our side stopped it; our team has been told.';

/** «…then press «Launch»» / «Rewrite letters» — после ENG_TEAM_FIX_STOP_EN. */
export function engTeamFixThenText(button: 'Launch' | 'Rewrite letters'): string {
  return `Message Support to find out when it is fixed, then press «${button}».`;
}

function payloadStr(payload: unknown, key: 'vertical_id' | 'base_id'): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  return asStr((payload as Record<string, unknown>)[key]);
}

/**
 * Упавшие джобы, которые ПОСЛЕДНИЕ по своей цели среди закончившихся
 * (done / failed / cancelled) джоб стадий ENG_TEAM_FIX_STAGES: ключ — стадия
 * и рынок у 'chain', стадия и база у остальных; порядок — created_at, при
 * равенстве id (то же правило, что у письма об остановке,
 * engClientMail.stageStopEvents). Ошибку роут читает отдельно, по их id, и
 * классифицирует сам (классификатор в бандл кабинета не едет).
 */
export function engLatestFailedStageJobs(
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<{ id: string; stage: EngTeamFixStage; vertical_id: string | null; base_id: string | null }> {
  const latestByKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const stage = asStr(row.stage);
    if (!(ENG_TEAM_FIX_STAGES as readonly string[]).includes(stage)) continue;
    const target = stage === 'chain' ? payloadStr(row.payload, 'vertical_id') : payloadStr(row.payload, 'base_id');
    if (!target || !asStr(row.id)) continue;
    const key = `${stage}|${target}`;
    const prev = latestByKey.get(key);
    const at = tsOf(row.created_at);
    if (!prev || at > tsOf(prev.created_at) || (at === tsOf(prev.created_at) && asStr(row.id) > asStr(prev.id))) {
      latestByKey.set(key, row);
    }
  }
  const out: Array<{ id: string; stage: EngTeamFixStage; vertical_id: string | null; base_id: string | null }> = [];
  for (const row of latestByKey.values()) {
    if (row.status !== 'failed') continue;
    const stage = asStr(row.stage) as EngTeamFixStage;
    out.push({
      id: asStr(row.id),
      stage,
      vertical_id: stage === 'chain' ? payloadStr(row.payload, 'vertical_id') : null,
      base_id: stage === 'chain' ? null : payloadStr(row.payload, 'base_id'),
    });
  }
  return out;
}

/** Остановка стадии по цели (рынок у 'chain', база у остальных); null — её нет. */
export function engTeamFixStopOf(
  stops: ReadonlyArray<EngTeamFixStop> | null | undefined,
  stage: EngTeamFixStage,
  target: string | null | undefined,
): EngTeamFixStop | null {
  if (!stops || !target) return null;
  return (
    stops.find((s) => s.stage === stage && (stage === 'chain' ? s.vertical_id === target : s.base_id === target)) ??
    null
  );
}

/* ─────────────────────────── Этап вертикали ─────────────────────────── */

/**
 * `launch_unfinished` — запись о запуске есть, но `heLaunchIsIncomplete` (часть
 * аудитории без кампании или без адресов). Тот же предикат, что у карточки
 * рынка шага 3 и у самого запуска: «live» для такой записи значило бы, что
 * клиенту делать нечего, хотя достраивает запуск «Launch now» на шаге 3 или
 * автозапуск.
 *
 * `pending` есть и у ИДУЩЕГО запуска: ядро пишет запись по ходу (группа в
 * полёте и ещё не начатые группы — launchTemplate.ts, persistProgress), а
 * аренда (`running_until`) в проекцию кабинета не уходит. Поэтому подпись
 * говорит «ещё не уехала» (has not gone out yet), а не «не уехала»: она верна
 * и посреди запуска, и после обрыва. Нажатие на шаге 5, пока аренда жива,
 * получает честный 409 «запуск ещё идёт или оборвался меньше 15 минут назад».
 *
 * `launched` — запись о запуске законченная. Это ещё НЕ «кампания идёт»:
 * идёт ли отправка, говорит не этап, а сводка отправки запуска (`sending`
 * вертикали дашборда — настоящий статус кампаний у рассыльщика из кэша
 * engCampaignStatus; её добавляет роут). Подпись этапа поэтому про то, что
 * верно при любом статусе: кампании созданы.
 *
 * `attention` — вертикаль встала на ТЕРМИНАЛЬНОМ состоянии и сама не поедет:
 * последняя своя база упала или отменена, проанализирована с нулём строк, её
 * анализ не идёт (см. EngDashAnalysisStopped), либо упал сам проект (research).
 * Причина и код — в `EngDashStageInfo.attention`. Только без идущей работы
 * вертикали (см. engDashAttentionOf): воркер повторяет джобу через 'pending',
 * не трогая статус базы, и промежуточный сбой сюда не доезжает.
 *
 * `not_selected` — у вертикали нет ни одной accepted-гипотезы (тот же
 * предикат, по которому автопилот пропускает её как 'not_selected',
 * autopilotReconcile.ts), и работы по ней сейчас нет. «Launch» шага 3 и ночной
 * проход её не трогают, поэтому ни «needs attention», ни «next: …» про неё
 * неправда: клиент её не выбрал или снял сам. Запуск, готовый
 * шаблон и идущая работа этот этап перекрывают: «Launch all» и ночной
 * долив выбор не читают, а начатая джоба доработает.
 */
export type EngDashStage =
  | 'research'
  | 'letters'
  | 'collecting'
  | 'construct'
  | 'analyzing'
  | 'analyzed'
  | 'template'
  | 'launch_unfinished'
  | 'launched'
  | 'attention'
  | 'not_selected';

/**
 * Выбор вертикали клиентом по he_hypotheses (роут, один батч по project_id):
 *  - `selected` — есть accepted-гипотеза (автопилот её ведёт);
 *  - `not_selected` — гипотезы есть, accepted среди них нет;
 *  - `no_hypotheses` — гипотез у вертикали нет вовсе (тоже не выбрана: принять
 *    на шаге 2 нечего).
 * Нет значения (undefined) — выбор не прочитан: этап выводится как до выбора.
 */
export type EngDashSelection = 'selected' | 'not_selected' | 'no_hypotheses';

/**
 * Выбор каждой вертикали из строк he_hypotheses (id, vertical_id, status).
 * Предикат — РОВНО автопилотный (autopilotReconcile.ts, 'not_selected'):
 * `vertical_id === вертикаль && status === 'accepted'`, затем непустой id.
 * Вертикали без строк в карте нет — у вызывающего это `no_hypotheses`.
 */
export function engDashSelectionByVertical(
  hypotheses: ReadonlyArray<Record<string, unknown>>,
): Map<string, EngDashSelection> {
  const out = new Map<string, EngDashSelection>();
  for (const h of hypotheses) {
    const vid = asStr(h.vertical_id);
    if (!vid) continue;
    if (h.status === 'accepted' && asStr(h.id).length > 0) out.set(vid, 'selected');
    else if (!out.has(vid)) out.set(vid, 'not_selected');
  }
  return out;
}

/**
 * Почему вертикаль в `attention`:
 *  - `base_stopped` — последняя своя (не доливная) база в 'failed': сбой стадии
 *    или отмена (код 'cancelled' — отмена отличается от сбоя только строкой
 *    причины, см. toClientEngStageErrorCode);
 *  - `base_empty` — последняя своя база 'analyzed' с row_count = 0. Автопилот
 *    считает любую 'analyzed'-базу готовой (autopilotNext: 'base_ready') и
 *    новую сборку не ставит, а шаблон по пустой базе не строится, — дальше
 *    решает человек;
 *  - `project_failed` — he_projects.status = 'failed' (его пишут только
 *    research-стадии и сбой их дочейна, worker/hypothesisEngine.ts).
 */
export type EngDashAttentionReason = 'base_stopped' | 'base_empty' | 'project_failed';

export interface EngDashAttention {
  reason: EngDashAttentionReason;
  /**
   * Код причины из проекции (`toClientEngStageErrorCode` по he_bases.error или
   * he_projects.error): только машинный код словаря кабинета, сырой текст
   * стадии наружу не уходит. null — причина не записана (и всегда у
   * `base_empty`: это не сбой, причины у него нет).
   */
  code: HeClientStageErrorCode | null;
}

/**
 * `analysis_stopped` — последняя своя база вертикали висит в 'analyzing', а
 * анализ её не идёт: ни одна активная джоба не держит её base_id и окно
 * постановки (ANALYZING_ORPHAN_GRACE_MS) прошло — общий предикат
 * isAnalyzingBaseLive автопилота, по нему же «Launch» шага 3 решает, что база
 * осиротела. Финальный фейл base_analyze базу не трогает (она так и остаётся
 * 'analyzing'), поэтому без этой причины карточка печатала «analyzing the
 * base…» вечно.
 *
 * Отдельным типом, а не четвёртым значением EngDashAttentionReason: тексты трёх
 * причин выше собирает engText.engDashAttentionText (switch по причине), а эту
 * причину карточка разбирает сама (EngDashboard.tsx).
 */
export interface EngDashAnalysisStopped {
  reason: 'analysis_stopped';
  /**
   * 'cancelled' — последний закончившийся base_analyze этой базы отменён
   * («Cancel all jobs» обогнал запись стадии). null — последний упал, не
   * закончился ни один (анализ так и не поставили) или исход не прочитан.
   */
  code: 'cancelled' | null;
  /**
   * true — нажатие «Launch» шага 3 поставит ей base_analyze заново: вертикаль
   * выбрана, проект 'researched', паузы по потолку расхода у проекта нет
   * (`spendPaused` прочитан и ложен) и выполнены условия ремонта осиротевшей
   * базы (engAnalysisRequeues). false — кнопка поведёт вертикаль другим путём
   * (цепочка, новая сборка) либо это не доказано, и карточка называет только
   * саму кнопку.
   */
  requeues: boolean;
  /**
   * true — последний анализ этой базы остановил отказ, который чинит команда
   * (EngTeamFixStop): при `requeues` карточка зовёт сначала в Support, потом к
   * «Launch». Нет поля — не этот случай или не прочитано.
   */
  teamFix?: boolean;
}

/** Причина этапа 'attention' — одна из трёх выше или остановленный анализ. */
export type EngDashAttentionInfo = EngDashAttention | EngDashAnalysisStopped;

/**
 * Пять точек прогресса карточки: research → collected → checked → letters →
 * sending. Пятая — «кампания отправляет»: этап её не ставит (из сущностей
 * движка это не выводится), её ставит роут дашборда по сводке отправки
 * (`sending.state === 'sending'`).
 */
export type EngDashDots = [boolean, boolean, boolean, boolean, boolean];

export interface EngDashVerticalSlice {
  projectStatus: string;
  /**
   * Код причины he_projects.error (toClientEngStageErrorCode) — роут считает
   * его только у проекта в 'failed'. Нет — причина не записана или не нужна.
   */
  projectErrorCode?: HeClientStageErrorCode | null;
  chains: Array<Record<string, unknown>>;
  /**
   * Строки баз вертикали. Кроме колонок he_bases роут кладёт в каждую два
   * поля проекции мастера (toClientEngBase — те же, что видит шаг 3):
   * `refill` (прогон ночного долива, а не база вертикали) и `error_code` (код
   * причины he_bases.error). Без них (`undefined`) база считается своей и без
   * записанной причины.
   */
  bases: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  /** Активные джобы вертикали (pending/running) — для живых подписей. */
  activeJobs: Array<Record<string, unknown>>;
  /**
   * true — список `activeJobs` мог оказаться неполным (роут упёрся в кап
   * выборки и не дочитал остальное): что работы у вертикали нет, не доказано,
   * и этап 'attention' не ставится (engDashAttentionOf).
   */
  liveWorkUnknown?: boolean;
  /**
   * 'analyzing'-базы вертикали, анализ которых НЕ идёт (роут: общий предикат
   * isAnalyzingBaseLive по полному списку активных джоб), → код исхода их
   * последнего закончившегося base_analyze ('cancelled' или null, см.
   * EngDashAnalysisStopped). Такая база — не идущая работа: этап 'analyzing' по
   * ней не ставится. Нет поля — роут живость не проверял (список активных джоб
   * неполон), и любая 'analyzing'-база читается идущей, как раньше.
   */
  stalledAnalysis?: ReadonlyMap<string, 'cancelled' | null>;
  /** Выбор вертикали клиентом (EngDashSelection); нет — не прочитан. */
  selection?: EngDashSelection;
  /**
   * У проекта записана пауза по потолку расхода (toClientEngAutopilotHold, код
   * 'spend_paused'; потолок по умолчанию выключен). Читают `requeues`
   * остановленного анализа (проход «Launch» над потолком кончается на
   * первой платной постановке и до ремонта этой вертикали может не дойти) и
   * подписи этапов, которые иначе звали бы к «Launch» или «Rewrite letters»
   * (письма готовы, писем нет, письма сняты): под паузой следующую платную
   * стадию не поставят ни кнопки, ни автопилот, а роут переписки откажет
   * потолком. Нет поля — паузы не прочитаны: `requeues` ложно (не доказано),
   * подписи прежние.
   */
  spendPaused?: boolean;
  /**
   * id шаблонов, чьи письма ядро запуска откажет (признак `needs_rewrite`
   * проекции — clientEngProjection.heTemplateNeedsRewrite, тот же гейт писем,
   * что у шага 4b″ launchTemplate.ts). Роут считает его только для шаблонов из
   * engDashRewriteCandidateIds. Нет — признак не считался (тогда и подписи
   * прежние).
   */
  rewriteTemplateIds?: ReadonlySet<string>;
  /**
   * Автозапуск готового шаблона вертикали (S3, engAutoLaunch): строка
   * he_eng_auto_launch шаблона этапа 'template' или синтетическое
   * 'waiting' (клиент нажал «Launch», строки ещё нет). null / нет поля —
   * автозапуск этому шаблону не назначен (клиент «Launch» не нажимал,
   * миграции нет или не прочиталось): подпись зовёт запустить на шаге 3.
   */
  autoLaunch?: EngDashAutoLaunch | null;
  /**
   * Автопилот проекта (he_projects.autopilot): true — после писем и проверки
   * контактов следующую стадию ставит он сам; false — ничего не ставит, пока
   * клиент не нажмёт «Launch» шага 3 (реконсилер включает автопилот). Нет поля —
   * не прочитан: подпись не обещает ни того, ни другого.
   */
  autopilot?: boolean;
  /**
   * Остановки стадий проекта отказом, который чинит команда (EngTeamFixStop;
   * роут — по последнему закончившемуся прогону каждой цели). Нет поля — не
   * прочитаны: подписи прежние.
   */
  teamFixStops?: ReadonlyArray<EngTeamFixStop>;
  /** id вертикали — для остановки её писем в `teamFixStops`; нет — не сверяется. */
  verticalId?: string;
  /**
   * Выключатель отправки аккаунта, когда он держит «Launch now» ('not_enabled'
   * — ждёт разовой проверки командой, 'revoked' — выключен). Читают подпись
   * готового шаблона без автозапуска («launch it on step 3» при нём неправда)
   * и, при 'revoked', подписи этапа писем, которые иначе звали бы к «Launch»
   * шага 3: та при нём выключена (так и после разблокировки, пока сотрудник
   * не включит отправку), а также подписи снятых писем (команда чинит) и
   * автозапуска 'account_blocked', которые звали бы к «Rewrite letters» и
   * «Launch» — обе тогда откажут 403. Нет поля — включён, не требуется или не
   * прочитан.
   */
  accountAccess?: 'not_enabled' | 'revoked';
}

/**
 * Какую остановку этапа чинит команда — для подписи и строки «next»:
 * 'letters' — письма (этап 'letters'), 'final_letters' — итоговые письма
 * (этап 'analyzed'), 'rewrite' — новые письма «Rewrite letters» (этап
 * 'analyzed' со снятыми письмами). Проверка контактов — у причины
 * 'analysis_stopped' (`teamFix`).
 */
export type EngDashTeamFix = 'letters' | 'final_letters' | 'rewrite';

/** Состояние автозапуска шаблона этапа — то, что нужно подписи. */
export interface EngDashAutoLaunch {
  state: HeEngAutoLaunchState;
  code: HeEngAutoLaunchCode | null;
  /**
   * Только у 'waiting' без кода (тик рынок ещё не пробовал): выключатель
   * отправки аккаунта, прочитанный роутом, когда он держит старт —
   * 'not_enabled' (ждёт разовой проверки командой) или 'revoked' (выключен).
   * Нет поля — включён, не требуется или не прочитан. То же правило, что у
   * строки рынка на шаге 3 (обещать «скоро» при выключателе нельзя).
   */
  access?: 'not_enabled' | 'revoked';
  /**
   * У 'waiting' без кода: рынок ждёт тика дольше HE_ENG_AUTO_LAUNCH_STALE_MS
   * (от даты строки, у синтетической — от даты шаблона). У 'running': аренду
   * никто не держит — попытка брошена (engAutoLaunch.heEngAutoLaunchLeaseExpired).
   * В обоих случаях на шаге 3 стоит «Launch now».
   */
  stale?: boolean;
}

/**
 * Короткая подпись этапа 'template' по автозапуску (полные фразы и кнопки —
 * у шага 3 мастера). Каждая правда для любой формы своего состояния: «we try
 * again» — строка ждёт следующей попытки тика, «see step 3» — там причина и
 * действие (кнопка или Support). null — подпись без автозапуска.
 * `accountAccess` — выключатель отправки аккаунта (EngDashVerticalSlice):
 * при 'revoked' «Launch» шага 3 выключена, и подпись к ней не зовёт.
 */
export function engDashAutoLaunchDetail(
  auto: EngDashAutoLaunch | null | undefined,
  accountAccess?: 'not_enabled' | 'revoked',
): string | null {
  if (!auto) return null;
  if (auto.state === 'running') {
    return auto.stale === true ? 'starting has not finished — see step 3' : 'starting sending…';
  }
  if (auto.state === 'failed') return 'could not start after several tries — nothing was sent; see step 3';
  // 'done' у шаблона БЕЗ записи о запуске (этап 'template') — только
  // 'needs_support': запись о запуске не легла, старт не делался.
  if (auto.state === 'done') {
    return auto.code === 'needs_support' ? 'sending could not start — nothing was started; see step 3' : null;
  }
  if (auto.state === 'waiting') {
    if (auto.code !== null) return 'starting did not work on this try — we try again shortly';
    if (auto.access === 'not_enabled') return 'ready — sending starts after a one-time check of your account';
    if (auto.access === 'revoked') return 'sending is turned off for your account — message Support';
    if (auto.stale === true) return 'ready — starting is taking longer than usual; see step 3';
    return 'ready — sending starts automatically shortly';
  }
  switch (auto.code) {
    case 'sending_not_enabled':
      return 'ready — sending starts after a one-time check of your account';
    case 'sending_turned_off':
      return 'sending is turned off for your account — message Support';
    case 'email_not_verified':
      return 'ready — confirm your email to start sending';
    // Нейтрально: spend_day_limit пишет и общий потолок ENG, которого аккаунт
    // клиента не достигал (engPaidAccess.engSpendLimitRefusal).
    case 'spend_limit':
    case 'spend_day_limit':
      return 'ready — a usage limit stops it; see step 3';
    case 'unavailable':
    case 'setup_unavailable':
    case 'mailboxes_short':
      return 'ready — we are preparing sending for your account';
    case 'research_running':
      return 'waiting for the research to finish';
    case 'letters_need_rewrite':
      return 'letters need rewriting — nothing was sent; see step 3';
    case 'account_blocked':
      // Строку снова берёт только новое «Launch» (автозапуск её не перепроверяет).
      return accountAccess === 'revoked'
        ? 'sending is turned off for your account — message Support'
        : 'sending has not started — press «Launch» on step 3';
    default:
      return 'sending could not start — nothing was sent; see step 3';
  }
}

export interface EngDashStageInfo {
  stage: EngDashStage;
  stageDetail: string;
  dots: EngDashDots;
  /**
   * База-«паспорт» вертикали: из неё берутся `row_count` и счётчики
   * конструктора (emails_found/valid_count).
   *
   * ВНИМАНИЕ: `row_count` — это СТРОКИ базы, а не компании. ENG-сборка
   * разносит один адрес на строку (шаг `split_emails` в `constructStepsFor`
   * для market='us'), поэтому у компании с пятью адресами строк пять, и
   * `row_count` до капа адресов на компанию (по умолчанию 5) раз больше
   * числа компаний. Компаний в этом модуле НЕТ: `he_bases.row_count` их не
   * знает, поэтому любая подпись здесь называет строки строками. Само число
   * компаний живёт в `collect_info.stats.companies_total` (пишет
   * `capImportedRows` в `stages/baseCollect.ts`), и роут дашборда берёт
   * `companies` оттуда, а `rows` — из этого `row_count`; у баз, собранных до
   * появления ключа, компаний нет вовсе — там 0 со смыслом «не знаем».
   */
  mainBase: Record<string, unknown> | null;
  launch: HeTemplateLaunchInfo | null;
  /**
   * Шаблон этапа ('template' — готовый незапущенный, 'launch_unfinished' —
   * запущенный не до конца) в `rewriteTemplateIds`: его письма запуск
   * откажет, и ни «launch when set», ни «finish the launch» правдой не будут.
   * У остальных этапов — false.
   */
  lettersNeedRewrite: boolean;
  /**
   * Итоговые письма рынка сняты «Rewrite letters» ('failed' у he_templates
   * пишет только роут переписки), а новых нет и генерация не идёт: ни
   * запущенного, ни готового шаблона, самый новый — снятый. «Launch» такой
   * рынок не двигает (реконсилер считает шаблон существующим) — путь только
   * «Rewrite letters» или Support на шаге 3. Нет поля — не этот случай.
   */
  lettersRetired?: boolean;
  /** Остановку этапа чинит команда (EngDashTeamFix); нет поля — не этот случай. */
  teamFix?: EngDashTeamFix;
  /** Причина этапа 'attention'; у остальных этапов — null. */
  attention: EngDashAttentionInfo | null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function tsOf(v: unknown): number {
  const t = Date.parse(asStr(v));
  return Number.isNaN(t) ? 0 : t;
}

/** Последняя по created_at строка (стабильно: при равенстве — поздняя в списке). */
function latest<T extends Record<string, unknown>>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best || tsOf(row.created_at) >= tsOf(best.created_at)) best = row;
  }
  return best;
}

/** Шаблон с запуском, самый свежий по дате запуска (force-перезапуск перезаписывает launch_info). */
function latestLaunchedTemplate(
  templates: Array<Record<string, unknown>>,
): { row: Record<string, unknown>; launch: HeTemplateLaunchInfo } | null {
  let best: { row: Record<string, unknown>; launch: HeTemplateLaunchInfo; ts: number } | null = null;
  for (const row of templates) {
    const launch = parseLaunchInfo(row.launch_info);
    if (!launch) continue;
    const ts = tsOf(launch.created_at) || tsOf(row.created_at);
    if (!best || ts >= best.ts) best = { row, launch, ts };
  }
  return best ? { row: best.row, launch: best.launch } : null;
}

/**
 * Шаблон вертикали, о запуске которого говорит этап (тот же выбор, что у
 * deriveEngVerticalStage: самый свежий по дате запуска) — роут дашборда читает
 * по нему сводку отправки. null — запущенного шаблона нет.
 */
export function engDashLaunchedTemplate(
  templates: Array<Record<string, unknown>>,
): { templateId: string; launch: HeTemplateLaunchInfo } | null {
  const launched = latestLaunchedTemplate(templates);
  const templateId = launched ? asStr(launched.row.id) : '';
  return launched && templateId ? { templateId, launch: launched.launch } : null;
}

function collectInfo(base: Record<string, unknown> | null): Record<string, unknown> {
  const info = base?.collect_info;
  return info && typeof info === 'object' ? (info as Record<string, unknown>) : {};
}

/**
 * Шаблоны, о которых этап вертикали может сказать «запускай» или «достраивай»
 * (deriveEngVerticalStage): по каждой вертикали — свежий запущенный, если его
 * запуск не закончен, а без запущенного — свежий готовый незапущенный. Ровно
 * их роут дашборда проверяет гейтом писем: письма и строки баз нужны только
 * им, а не каждому шаблону аккаунта на 15-секундном полле.
 */
export function engDashRewriteCandidateIds(templates: Array<Record<string, unknown>>): string[] {
  const byVertical = new Map<string, Array<Record<string, unknown>>>();
  for (const t of templates) {
    const vid = asStr(t.vertical_id);
    const list = byVertical.get(vid);
    if (list) list.push(t);
    else byVertical.set(vid, [t]);
  }
  const ids: string[] = [];
  for (const list of byVertical.values()) {
    const launched = latestLaunchedTemplate(list);
    const row = launched
      ? heLaunchIsIncomplete(launched.launch)
        ? launched.row
        : null
      : latestReadyUnlaunched(list);
    const id = asStr(row?.id);
    if (id) ids.push(id);
  }
  return ids;
}

/** Свежий готовый шаблон без записи о запуске — тот, что этап 'template' зовёт запускать. */
function latestReadyUnlaunched(templates: Array<Record<string, unknown>>): Record<string, unknown> | null {
  return latest(templates.filter((t) => asStr(t.status) === 'ready' && !parseLaunchInfo(t.launch_info)));
}

/**
 * id шаблона этапа 'template' (свежий готовый без записи о запуске) — роут
 * дашборда читает по нему строку автозапуска (тот же выбор, что у этапа).
 */
export function engDashReadyTemplateId(templates: Array<Record<string, unknown>>): string | null {
  const id = asStr(latestReadyUnlaunched(templates)?.id);
  return id || null;
}

/**
 * Поставит ли клиентское «Launch» (шаг 3) этой 'analyzing'-базе, чей анализ не
 * идёт, base_analyze заново (бесплатная вставка джобы; строки второй раз не
 * покупаются). Ровно условия ремонта осиротевшей базы в autopilotReconcile.ts
 * по базам вертикали (`verticalBases`) и её цепочкам:
 *  - база своя (не доливная) авто-сборки и со строками — у загруженного файла
 *    кнопка базу не видит, а базу без строк ремонт закрывает 'failed', и
 *    кнопка ставит новую сборку;
 *  - она ЕДИНСТВЕННАЯ своя авто-база в 'analyzing': живая соседняя ремонт
 *    останавливает, а чинится только самая свежая из осиротевших (живость
 *    соседей отсюда не видна — при соседях ответ false);
 *  - у вертикали нет своей авто-базы в 'collecting' или 'analyzed' — любая из
 *    них ремонт останавливает. Черновик писем для ENG больше не нужен.
 * Выбор вертикали (accepted-гипотеза), статус проекта ('researched' — иначе
 * кнопки нет) и паузу по потолку расхода (`spendPaused`) проверяет
 * вызывающий. Колонки базы не проверяются: строки и колонки пишет одна и та
 * же запись финала сборки.
 */
export function engAnalysisRequeues(
  base: Record<string, unknown>,
  verticalBases: ReadonlyArray<Record<string, unknown>>,
  _chains: ReadonlyArray<Record<string, unknown>>,
): boolean {
  const ownAuto = verticalBases.filter((b) => b.refill !== true && asStr(b.source) === 'auto');
  const ownAutoAnalyzing = ownAuto.filter((b) => asStr(b.status) === 'analyzing');
  const baseId = asStr(base.id);
  return (
    baseId !== '' &&
    asNum(base.row_count) > 0 &&
    ownAutoAnalyzing.length === 1 &&
    asStr(ownAutoAnalyzing[0].id) === baseId &&
    !ownAuto.some((b) => asStr(b.status) === 'collecting' || asStr(b.status) === 'analyzed')
  );
}

/** Код причины, который роут положил в строку базы (`error_code`); иначе null. */
function baseErrorCode(base: Record<string, unknown>): HeClientStageErrorCode | null {
  return typeof base.error_code === 'string' && base.error_code ? (base.error_code as HeClientStageErrorCode) : null;
}

/**
 * Встала ли вертикаль на терминальном состоянии (этап 'attention').
 *
 * Зовётся ТОЛЬКО когда у вертикали нет ни записи о запуске, ни готового
 * шаблона, ни базы в 'collecting', ни 'analyzing'-базы с идущим анализом, ни
 * своей 'analyzed'-базы со строками, и она выбрана или выбор не прочитан
 * (deriveEngVerticalStage проверяет всё это раньше), то есть когда пути
 * вперёд у неё уже нет. Дальше три гейта «работа ещё идёт», при любом из них
 * ответ null и карточка печатает прежний этап:
 *  - проект в 'researching': research вертикали проекта пересоздаёт, а
 *    упавшая база старой вертикали ничего не решает;
 *  - у вертикали есть активная джоба (pending/running по её vertical_id или
 *    base_id): повтор или подъём ещё в полёте, состояние не терминальное;
 *  - список активных джоб неполон (`liveWorkUnknown`): идёт ли работа,
 *    неизвестно, а «встала» без этого знания — неправда.
 *
 * Порядок причин: упавший проект — первым. Пока он 'failed', «Launch»
 * шага 3 недоступен (кнопке нужен 'researched'), и совет про базу был бы
 * неправдой; дальше — ПОСЛЕДНЯЯ своя база (доливные прогоны не считаются: их
 * исход — лента событий и блок добора, а не этап вертикали). Старая упавшая
 * база под более новой 'uploaded' — не причина: решает последняя. Последняя
 * своя в 'analyzing' — причина только из `stalledAnalysis` (анализ не идёт).
 */
function engDashAttentionOf(input: EngDashVerticalSlice): EngDashAttentionInfo | null {
  if (input.liveWorkUnknown === true || input.projectStatus === 'researching' || input.activeJobs.length > 0) {
    return null;
  }
  if (input.projectStatus === 'failed') {
    return { reason: 'project_failed', code: input.projectErrorCode ?? null };
  }
  const own = input.bases.filter((b) => b.refill !== true);
  const lastOwn = latest(own);
  if (!lastOwn) return null;
  const status = asStr(lastOwn.status);
  if (status === 'failed') return { reason: 'base_stopped', code: baseErrorCode(lastOwn) };
  if (status === 'analyzed' && asNum(lastOwn.row_count) === 0) return { reason: 'base_empty', code: null };
  const lastOwnId = asStr(lastOwn.id);
  if (status === 'analyzing' && input.stalledAnalysis?.has(lastOwnId) === true) {
    const teamFix = engTeamFixStopOf(input.teamFixStops, 'base_analyze', lastOwnId) !== null;
    return {
      reason: 'analysis_stopped',
      code: input.stalledAnalysis.get(lastOwnId) ?? null,
      ...(teamFix ? { teamFix: true } : {}),
      // Кнопка есть только у 'researched'-проекта, а невыбранную вертикаль
      // (или вертикаль с непрочитанным выбором) она не трогает вовсе. Под
      // записанной паузой по потолку расхода (или с непрочитанными паузами)
      // повтор анализа не доказан — см. `spendPaused`.
      requeues:
        input.selection === 'selected' &&
        input.projectStatus === 'researched' &&
        input.spendPaused === false &&
        engAnalysisRequeues(lastOwn, input.bases, input.chains),
    };
  }
  return null;
}

/** Короткая строка этапа 'attention' (подпись строки карты пайплайна). */
function attentionDetail(attention: EngDashAttentionInfo): string {
  switch (attention.reason) {
    case 'project_failed':
      if (attention.code === 'cancelled') return 'research cancelled';
      // Research ждёт описания бизнеса (website_thin): та же пауза до ответа
      // клиента, что у тега «needs your input» и строки карточки, — не «stopped».
      if (attention.code === HE_RESEARCH_NEEDS_DESCRIPTION_CODE) return 'research waiting for your description';
      return 'research stopped';
    case 'base_stopped':
      return attention.code === 'cancelled' ? 'collection cancelled' : 'collection stopped';
    case 'base_empty':
      return 'base came back with no rows';
    case 'analysis_stopped':
      return attention.code === 'cancelled' ? 'analysis cancelled' : 'analysis stopped';
  }
}

/**
 * Этап вертикали из сущностей (порядок конвейера: research →
 * base (collecting → construct → analyzing) → letters → launched; дальше
 * ежедневный refill — отдельным блоком дашборда). Приоритет: запущенное
 * всегда сверху; активная работа базы (collecting/construct/analyzing)
 * важнее «статичного» analyzed — ре-collect той же вертикали честно
 * показывает прогресс, а не вчерашний финиш. Когда пути вперёд нет вовсе (ни
 * запуска, ни шаблона, ни идущей базы, ни своей базы со строками) —
 * 'attention' по терминальному состоянию (engDashAttentionOf), а не ожидание
 * следующего шага, которое читалось как бесконечная работа. Перед
 * этим — 'not_selected': невыбранную вертикаль без запуска, шаблона и идущей
 * работы автопилот не двигает, и ни «next: …», ни «needs attention» про неё
 * неправда.
 *
 * 'analyzing'-база из `stalledAnalysis` идущей работой не считается: её этап —
 * 'attention' (analysis_stopped), если причина выводится, иначе прежний
 * 'analyzing' (у вертикали идёт другая джоба, проект в research или последняя
 * своя база — другая).
 */
export function deriveEngVerticalStage(input: EngDashVerticalSlice): EngDashStageInfo {
  const { projectStatus, bases, templates, activeJobs } = input;

  const launched = latestLaunchedTemplate(templates);
  const readyTemplate = latestReadyUnlaunched(templates);
  const needsRewrite = (row: Record<string, unknown>): boolean =>
    input.rewriteTemplateIds?.has(asStr(row.id)) === true;
  const isStalled = (b: Record<string, unknown>): boolean => input.stalledAnalysis?.has(asStr(b.id)) === true;
  const analyzingBase = latest(bases.filter((b) => asStr(b.status) === 'analyzing' && !isStalled(b)));
  const stalledAnalyzingBase = latest(bases.filter((b) => asStr(b.status) === 'analyzing' && isStalled(b)));
  const collectingBase = latest(bases.filter((b) => asStr(b.status) === 'collecting'));
  const analyzedBase = latest(bases.filter((b) => asStr(b.status) === 'analyzed'));
  // Своя (не доливная) 'analyzed'-база со строками — та, из которой вертикаль
  // ещё может получить шаблон. Пустая или доливная этого пути не даёт.
  const usableAnalyzedBase = latest(
    bases.filter((b) => b.refill !== true && asStr(b.status) === 'analyzed' && asNum(b.row_count) > 0),
  );
  const hasCollectedBase = bases.some((b) => b.refill !== true && (asStr(b.status) === 'analyzing' || asStr(b.status) === 'analyzed'));

  // База-«паспорт» вертикали: из которой собран запущенный/готовый шаблон,
  // иначе свежая своя analyzed со строками, иначе свежая analyzed, иначе
  // текущая собирающаяся.
  const templateBaseId = asStr((launched?.row ?? readyTemplate)?.base_id);
  const mainBase =
    (templateBaseId ? bases.find((b) => asStr(b.id) === templateBaseId) : undefined) ??
    usableAnalyzedBase ??
    analyzedBase ??
    collectingBase ??
    latest(bases);

  if (launched && heLaunchIsIncomplete(launched.launch)) {
    // Достройку ядро откажет тем же гейтом писем (4b″), поэтому подпись про
    // письма, а не «ещё не уехала» с намёком «нажми ещё раз».
    const rewrite = needsRewrite(launched.row);
    return {
      stage: 'launch_unfinished',
      stageDetail: rewrite
        ? 'launch unfinished — these letters cannot finish it and need rewriting'
        : 'launch unfinished — part of the audience has not gone out yet',
      dots: [true, true, true, true, false],
      mainBase,
      launch: launched.launch,
      lettersNeedRewrite: rewrite,
      attention: null,
    };
  }
  if (launched) {
    // Отправляет ли запуск — говорит сводка отправки (роут, `sending`), а не
    // этап: подпись верна при любом статусе кампаний у рассыльщика.
    return {
      stage: 'launched',
      stageDetail: 'campaigns created',
      dots: [true, true, true, true, false],
      mainBase,
      launch: launched.launch,
      lettersNeedRewrite: false,
      attention: null,
    };
  }
  if (readyTemplate) {
    const rewrite = needsRewrite(readyTemplate);
    return {
      stage: 'template',
      stageDetail: rewrite
        ? 'letters need rewriting — nothing was sent; see step 3'
        : (engDashAutoLaunchDetail(input.autoLaunch, input.accountAccess) ??
          (input.accountAccess === 'revoked'
            ? 'ready — sending is turned off for your account; message Support'
            : input.accountAccess === 'not_enabled'
              ? 'ready — sending can start after a one-time check of your account'
              : 'letters ready — launch it on step 3')),
      dots: [true, true, true, true, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: rewrite,
      attention: null,
    };
  }
  const analyzingStage: EngDashStageInfo = {
    stage: 'analyzing',
    stageDetail: 'analyzing the base…',
    dots: [true, true, false, false, false],
    mainBase,
    launch: null,
    lettersNeedRewrite: false,
    attention: null,
  };
  if (analyzingBase) return analyzingStage;
  if (collectingBase) {
    const info = collectInfo(collectingBase);
    const construct =
      info.construct && typeof info.construct === 'object'
        ? (info.construct as Record<string, unknown>)
        : null;
    if (construct && asStr(construct.status) === 'dispatched') {
      const emails = asNum(construct.emails_found);
      const valid = asNum(construct.valid_count);
      return {
        stage: 'construct',
        // Имя шага — как у строки карты пайплайна («Email enrichment»), а не
        // внутреннее «constructor».
        stageDetail:
          emails > 0 ? `email enrichment: ${valid}/${emails} valid` : 'email enrichment: finding emails…',
        dots: [true, true, false, false, false],
        mainBase,
        launch: null,
        lettersNeedRewrite: false,
        attention: null,
      };
    }
    const stats =
      info.stats && typeof info.stats === 'object' ? (info.stats as Record<string, unknown>) : null;
    const done = asNum(stats?.tasks_done);
    const total = asNum(stats?.tasks_total);
    return {
      stage: 'collecting',
      stageDetail: total > 0 ? `collecting: task ${done}/${total}` : 'collecting: starting…',
      dots: [true, false, false, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      attention: null,
    };
  }
  // Невыбранная вертикаль: дальше её двигает только выбор клиента. Не во время
  // research (вертикали пересоздаются, все гипотезы ещё 'proposed') и не у
  // упавшего проекта (его причина — 'attention' ниже, и «Launch» там
  // недоступен); при живой или неизвестной работе — прежний этап.
  //
  // Совет «accept one of its hypotheses» — только у 'researched': кнопка
  // «Launch» есть лишь там (EngStepLaunch, canLaunch). У
  // 'draft' (отменённый research, cancel-роут) принятие гипотезы ничего не
  // двигает — research не идёт и сам не начнётся, а кабинет запускает его
  // заново только после технического сбоя (решение владельца 10.10.2026;
  // отмена — не сбой; повтор есть лишь у 'draft' без research-джоб или с
  // упавшей последней). Поэтому кнопку не называем, а отправляем на шаг 1:
  // текст «что делать» там есть у каждой формы 'draft' — «Try again» либо
  // Support; ПОЧЕМУ research не идёт, шаг 1 знает не всегда, поэтому «what to
  // do», а не «why». Иной статус
  // сюда не доходит (выше отсечены 'researching' и 'failed'); незнакомый —
  // одним фактом.
  if (
    input.selection !== undefined &&
    input.selection !== 'selected' &&
    input.liveWorkUnknown !== true &&
    activeJobs.length === 0 &&
    projectStatus !== 'researching' &&
    projectStatus !== 'failed'
  ) {
    return {
      stage: 'not_selected',
      stageDetail:
        input.selection === 'no_hypotheses'
          ? 'not selected — this market has no buyer ideas, so it cannot be picked'
          : projectStatus === 'researched'
            ? 'not selected — tick it on step 2 to include it'
            : projectStatus === 'draft'
              ? 'not selected — research is not running on this project; step 1 says what to do'
              : 'not selected',
      dots: [true, hasCollectedBase, usableAnalyzedBase !== null, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      attention: null,
    };
  }
  // Письма сняты «Rewrite letters», новых нет, генерация не идёт (её джоба —
  // в активных джобах вертикали по base_id). Список активных джоб неполон —
  // «не написаны» не доказано, подпись прежняя.
  const newestTemplate = latest(templates);
  if (
    newestTemplate !== null &&
    asStr(newestTemplate.status) === 'failed' &&
    input.liveWorkUnknown !== true &&
    !activeJobs.some((j) => asStr(j.stage) === 'template')
  ) {
    // Новые письма не написал отказ, который чинит команда: «Rewrite letters»
    // до починки съест попытку впустую — сначала Support. Под паузой потолка
    // расхода кнопку не зовём вовсе (карточка шага 3 тогда без неё, роут
    // переписки откажет потолком) — поле `teamFix` остаётся данными. При
    // выключенной отправке аккаунта ('revoked') «Rewrite letters» откажет 403
    // sending_turned_off (карточка шага 3 тогда без неё) — тоже не зовём.
    const teamFix = engTeamFixStopOf(input.teamFixStops, 'template', asStr(newestTemplate.base_id)) !== null;
    return {
      stage: 'analyzed',
      stageDetail:
        input.spendPaused === true
          ? 'new letters were not written — nothing was sent; on hold, paused on our side'
          : teamFix
            ? input.accountAccess === 'revoked'
              ? 'new letters were not written — a problem on our side; message Support'
              : 'new letters were not written — a problem on our side; message Support, then «Rewrite letters» on step 3'
            : 'new letters were not written — nothing was sent; see step 3',
      dots: [true, true, true, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      lettersRetired: true,
      ...(teamFix ? { teamFix: 'rewrite' as const } : {}),
      attention: null,
    };
  }
  if (usableAnalyzedBase) {
    // Итоговые письма этой базы остановил отказ, который чинит команда: у базы
    // нет ни одного шаблона и генерация по ней сейчас не идёт (идущая —
    // новее упавшей). Список активных джоб неполон — не доказано.
    const analyzedId = asStr(usableAnalyzedBase.id);
    const teamFix =
      input.liveWorkUnknown !== true &&
      engTeamFixStopOf(input.teamFixStops, 'template', analyzedId) !== null &&
      !templates.some((t) => asStr(t.base_id) === analyzedId) &&
      !activeJobs.some((j) => asStr(j.stage) === 'template' && payloadStr(j.payload, 'base_id') === analyzedId);
    const writingLetters = activeJobs.some((j) => asStr(j.stage) === 'template' && payloadStr(j.payload, 'base_id') === analyzedId);
    return {
      stage: writingLetters ? 'letters' : 'analyzed',
      // «rows», а не «companies»: см. mainBase в EngDashStageInfo. Слово взято
      // у шага 3 мастера (EngStepBases.SendVolume: «… rows with a verified
      // email», превью: «… rows»), чтобы у одного и
      // того же числа в кабинете было одно имя.
      stageDetail: writingLetters
        ? 'writing letters for the checked contacts…'
        : teamFix
          ? `base analyzed: ${asNum(usableAnalyzedBase.row_count)} rows — letter writing stopped by a problem on our side`
          : `base analyzed: ${asNum(usableAnalyzedBase.row_count)} rows`,
      dots: [true, true, true, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      ...(teamFix ? { teamFix: 'final_letters' as const } : {}),
      attention: null,
    };
  }
  const attention = engDashAttentionOf(input);
  if (attention) {
    return {
      stage: 'attention',
      stageDetail: attentionDetail(attention),
      dots: [attention.reason !== 'project_failed', hasCollectedBase, false, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      attention,
    };
  }
  // Остановленный анализ, по которому причину не вывели (идёт другая джоба
  // вертикали, проект в research, последняя своя база — другая): прежний этап.
  if (stalledAnalyzingBase) return analyzingStage;
  // Сюда доходит 'analyzed'-база без строк или доливная, которую attention не
  // взял: у вертикали идёт джоба, проект в research, последняя своя база не
  // терминальна ('uploaded') или 'analyzed' у вертикали — только доливные
  // прогоны. Подпись прежняя.
  if (analyzedBase) {
    return {
      stage: 'analyzed',
      stageDetail: `base analyzed: ${asNum(analyzedBase.row_count)} rows`,
      dots: [true, true, true, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      attention: null,
    };
  }
  if (projectStatus === 'researching') {
    return {
      stage: 'research',
      stageDetail: 'researching your market…',
      dots: [false, false, false, false, false],
      mainBase,
      launch: null,
      lettersNeedRewrite: false,
      attention: null,
    };
  }
  return {
    stage: 'collecting',
    // ENG starts with the base. Legacy chains and their failures do not hold it.
    stageDetail:
      input.spendPaused === true
        ? 'contact collection has not started — on hold, paused on our side'
        : input.accountAccess === 'revoked'
          ? 'contact collection has not started — sending is turned off for your account; message Support'
          : input.autopilot === true
            ? 'contact collection is next — step 3 «Launch» shows progress'
            : 'contact collection has not started — press «Launch» on step 3',
    dots: [true, false, false, false, false],
    mainBase,
    launch: null,
    lettersNeedRewrite: false,
    attention: null,
  };
}

/* ─────────────────────────── Лента событий ─────────────────────────── */

export interface EngDashEvent {
  type:
    | 'letters_ready'
    | 'base_collected'
    | 'base_analyzed'
    | 'template_ready'
    | 'launched'
    /** Запуск записан, но не закончен (`heLaunchIsIncomplete`) — не «launched». */
    | 'launch_unfinished'
    | 'refill_appended'
    /**
     * Ночь БЕЗ отправки и БЕЗ сбоя кода. Причины разные, строка ленты одна:
     * отправлять нечего ('no_new'), у рассыльщика нет места
     * (stats.error_kind='instantly_capacity'), дневной бюджет не дал строк
     * (stats.budget_outcome), отмена клиентом без подтверждённого приёма
     * (stats.cancelled) и пропуск, потому что кампании запуска не берут
     * контакты (stats.sending_skip). Тип переиспользован осознанно:
     * в кабинете он рисуется серым, а 'failed' — красным сбоем (EVENT_ICON,
     * components/client-eng/EngDashboard.tsx), и отложенная ночь — именно
     * серая. Разница причин — в тексте, а не в типе: заводить ключ, которого
     * нет в клиентском union, значит рисовать событие значком по умолчанию.
     */
    | 'refill_empty'
    /**
     * Research ждёт ответа клиента, а не упал: site_profile отказала кодом
     * website_thin (сайт почти без текста, описания бизнеса нет) и продолжится
     * той же джобой после «Save and continue» шага 1. Под 'failed' лента
     * рисовала это красным «research failed» — словами и цветом сбоя.
     */
    | 'needs_input'
    | 'failed';
  text: string;
  /** ISO-время события (сортировка desc по нему). */
  at: string;
}

export const ENG_DASH_EVENTS_LIMIT = 15;

const JOB_STAGE_LABELS: Record<string, string> = {
  site_profile: 'research',
  competitors: 'competitor research',
  brand_cloud: 'brand cloud',
  hypotheses: 'hypotheses',
  evidence: 'evidence',
  clustering: 'clustering',
  chain: 'letter writing',
  vocab: 'vocabulary',
  base_collect: 'base collection',
  base_analyze: 'base analysis',
  template: 'template build',
  dossier: 'dossier',
};

function withVertical(text: string, name: string): string {
  return name ? `${text} · ${name}` : text;
}

/**
 * События из уже выбранных сущностей (без доп. запросов): финишированные
 * джобы (по updated_at), запуски кампаний (launch_info.created_at) и
 * refill-прогоны (completed_at). Отсортированы desc, кап eventsLimit.
 *
 * У упавшей джобы роут может положить `error_code` — код причины
 * (toClientEngStageErrorCode по he_jobs.error, сырой текст сюда не нужен):
 * упавшая site_profile с кодом website_thin — не сбой, а 'needs_input'.
 */
export function buildEngDashboardEvents(input: {
  jobs: Array<Record<string, unknown>>;
  bases: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  verticalNames: Map<string, string>;
  limit?: number;
}): EngDashEvent[] {
  const { jobs, bases, templates, runs, verticalNames } = input;
  const limit = input.limit ?? ENG_DASH_EVENTS_LIMIT;
  const events: EngDashEvent[] = [];

  const baseById = new Map(bases.map((b) => [asStr(b.id), b]));
  const nameOfVertical = (id: string) => verticalNames.get(id) ?? '';
  const nameByBaseId = (baseId: string) => {
    const b = baseById.get(baseId);
    return b ? nameOfVertical(asStr(b.vertical_id)) : '';
  };

  for (const job of jobs) {
    const stage = asStr(job.stage);
    const status = asStr(job.status);
    const at = asStr(job.updated_at) || asStr(job.created_at);
    if (!at) continue;
    const payload =
      job.payload && typeof job.payload === 'object'
        ? (job.payload as Record<string, unknown>)
        : {};
    const vname =
      nameOfVertical(asStr(payload.vertical_id)) || nameByBaseId(asStr(payload.base_id));

    if (status === 'failed' && stage === 'site_profile' && job.error_code === HE_RESEARCH_NEEDS_DESCRIPTION_CODE) {
      events.push({ type: 'needs_input', text: 'research is waiting for your business description', at });
      continue;
    }
    if (status === 'failed') {
      events.push({
        type: 'failed',
        // Незнакомая стадия — общее слово, а не сырое имя стадии из he_jobs.
        text: withVertical(`${JOB_STAGE_LABELS[stage] ?? 'a step'} failed`, vname),
        at,
      });
      continue;
    }
    if (status !== 'done') continue;
    switch (stage) {
      case 'chain':
        events.push({ type: 'letters_ready', text: withVertical('letters ready', vname), at });
        break;
      case 'base_collect':
        events.push({ type: 'base_collected', text: withVertical('base collected', vname), at });
        break;
      case 'base_analyze': {
        const b = baseById.get(asStr(payload.base_id));
        const rows = b ? asNum(b.row_count) : 0;
        events.push({
          type: 'base_analyzed',
          // Та же подпись, что у stageDetail этапа 'analyzed': строки, не
          // компании (см. mainBase в EngDashStageInfo).
          text: withVertical(`base analyzed: ${rows} rows`, vname),
          at,
        });
        break;
      }
      case 'template':
        events.push({ type: 'template_ready', text: withVertical('template ready', vname), at });
        break;
      default:
        // Внутренние стадии research (site_profile/competitors/…) — слишком
        // гранулярны для ленты; живой прогресс виден в activeJobs.
        break;
    }
  }

  for (const t of templates) {
    const launch = parseLaunchInfo(t.launch_info);
    if (!launch) continue;
    const at = launch.created_at || asStr(t.created_at);
    if (!at) continue;
    const name = launch.campaign_name ? `: ${launch.campaign_name}` : '';
    events.push(
      heLaunchIsIncomplete(launch)
        ? {
            type: 'launch_unfinished',
            text: `campaign launch unfinished — part of the audience has not gone out yet${name}`,
            at,
          }
        : { type: 'launched', text: `campaign launched${name}`, at },
    );
  }

  for (const run of runs) {
    const status = asStr(run.status);
    if (status === 'collecting') continue; // ещё работает — виден в activeJobs
    const at = asStr(run.completed_at) || asStr(run.created_at);
    if (!at) continue;
    const vname = nameOfVertical(asStr(run.vertical_id));
    const stats =
      run.stats && typeof run.stats === 'object' ? (run.stats as Record<string, unknown>) : {};
    if (status === 'appended') {
      // Часть строк рассыльщик не взял по ёмкости (stats.deferred +
      // deferred_reason, пишет stages/baseCollectRefill.ts). Ночь состоялась,
      // но не целиком: без остатка «+N leads» читается как «уехало всё».
      // «not sent», а не «on hold»: число — про ЭТОТ прогон, и только это про
      // него правда при любой судьбе строк. Судьба у них разная: у market='us'
      // компании, ни один адрес которых не дошёл до рассыльщика, ложатся в
      // очередь переноса (he_refill_carryover, stages/baseCollectRefill.ts) и
      // идут первыми в следующие ночи своей вертикали — до
      // HE_REFILL_CARRYOVER_MAX_AGE_DAYS (7) суток, потом отпускаются, и их
      // может заново подготовить обычная сборка; вторые адреса компаний,
      // которым письмо ушло, не переносятся вовсе (компания охвачена); очередь
      // не прочиталась или не записалась (нет миграции) — не переносится
      // ничего, компании остаются исключёнными. «on hold» обещало бы, что
      // уедут все эти строки, а этого не обещает ни одна из форм. Причину не
      // называем (решение владельца 04.10.2026): «работаем» правда, потому что
      // та же ветка долива, что пишет deferred_reason, сначала шлёт алерт
      // команде (alertRefillCapacityStop → opsAlert.ts).
      const deferred = asNum(stats.deferred);
      const heldBack =
        deferred > 0 && asStr(stats.deferred_reason) === 'instantly_capacity'
          ? `, ${deferred} not sent (${HE_TEAM_ON_IT_SHORT_EN})`
          : '';
      // Адреса, которые долив снял сам: письмо кампании прочиталось бы у них
      // неверно — пустота на месте подстановки или замена не на месте
      // (stats.held_unfilled, stages/baseCollectRefill.ts, шаг 3a). «skipped»,
      // а не «not sent yet»: число — про ЭТУ ночь, и уедут ли они, зависит от
      // писем — компания без иного адреса ждёт в очереди переноса с пометкой
      // «ждёт писем» и уходит, только если до конца её срока шаблон вертикали
      // переписали и перезапустили, иначе срок выходит и её отпускают в пул
      // (блок «ПЕРЕНОС» в stages/baseCollectRefill.ts). Только у 'appended': у 'no_new'
      // допущенных строк нет вовсе, а у отказа ленте важнее его причина.
      const unfilled = asNum(stats.held_unfilled);
      const skipped =
        unfilled > 0
          ? `, ${unfilled} skipped (the letters would not read right for ${unfilled === 1 ? 'this contact' : 'these contacts'})`
          : '';
      // Ночь продолжала завершённую основную кампанию (stats.main_restart).
      const restartOutcome =
        stats.main_restart && typeof stats.main_restart === 'object'
          ? asStr((stats.main_restart as Record<string, unknown>).outcome)
          : '';
      const restartText = Object.prototype.hasOwnProperty.call(MAIN_RESTART_FEED_EN, restartOutcome)
        ? MAIN_RESTART_FEED_EN[restartOutcome as HeRefillMainRestartOutcome]
        : null;
      const restarted = restartText ? `, ${restartText}` : '';
      events.push({
        type: 'refill_appended',
        text: withVertical(`daily top-up: +${asNum(stats.appended)} leads${heldBack}${skipped}${restarted}`, vname),
        at,
      });
    } else if (status === 'no_new') {
      // 'no_new' ставится по ДВУМ причинам (stages/baseCollectRefill.ts):
      // пустой harvest (новых компаний действительно нет) и valid === 0
      // (компании нашлись, но ни одного адреса с вердиктом 'ok'); у
      // market='us' — только если и очередь переноса не дала ни одного
      // допущенного адреса. Про компании мы знаем только в первом случае,
      // поэтому подпись говорит ровно то, что верно для обоих: отправлять нечего.
      events.push({ type: 'refill_empty', text: withVertical('daily top-up: nothing new to send', vname), at });
    } else if (status === 'failed') {
      // Нет места у рассыльщика — не сбой кода, а ночь, которую некуда было
      // отправить. Подпись — про ЭТОТ прогон («stopped»), а не про состояние
      // добора («on hold»): строка ленты историческая, а durable-пауза проекта
      // (he_auto_pipeline_configs.refill_paused_at) пишется best-effort — без
      // конфига или колонок её нет, а поставленную снимает сотрудник. Текущее
      // состояние добора кабинет печатает отдельно, по `projects[].refill`.
      // Читаем машинную причину, а не текст: stats.error_kind='instantly_capacity'
      // пишут оба отказа по ёмкости — предполёт тика до сборки (autoPipeline.ts,
      // строка журнала без base_id) и отказ долива (stages/baseCollectRefill.ts,
      // runStats), — поэтому у ленты одно условие на оба. Причину клиенту не
      // называем (решение владельца 04.10.2026): короткая общая фраза, и она
      // правда, потому что оба места записи такого отказа шлют алерт команде
      // (lib/hypothesisEngine/opsAlert.ts).
      // Нулевой дневной бюджет — НЕ поломка, а решение, и у него ДВА исхода с
      // разным смыслом: 'cap_exhausted' — кап проекта на сегодня занят другими
      // бронями; 'already_reserved' — это повтор прогона той же базы, а её
      // первый прогон ещё держит свою бронь (кап проекта при этом может быть
      // свободен — писать «лимит исчерпан» было бы неправдой).
      const budgetOutcome = asStr(stats.budget_outcome);
      // Отмена клиентом («Cancel all jobs») — решение человека, а не сбой:
      // stats.cancelled пишет stages/baseCollectRefill.ts (refillUserCancelled).
      // «nothing added» здесь не пишем: строка прогона знает только
      // подтверждённый приём (stats.appended), а запрос в полёте мог лечь.
      if (stats.cancelled === true) {
        const appendedBeforeCancel = asNum(stats.appended);
        events.push(
          appendedBeforeCancel > 0
            ? {
                type: 'refill_appended',
                text: withVertical(`daily top-up cancelled: +${appendedBeforeCancel} leads before the cancel`, vname),
                at,
              }
            : { type: 'refill_empty', text: withVertical('daily top-up cancelled', vname), at },
        );
        continue;
      }
      // Пропуск: кампании запуска не берут контакты (stats.sending_skip, см.
      // TOP_UP_SKIP_EN). Ниже отмены: у отменённого прогона пропуска нет.
      const sendingSkip = asStr(stats.sending_skip) as HeRefillSendSkipReason;
      if (Object.prototype.hasOwnProperty.call(TOP_UP_SKIP_EN, sendingSkip)) {
        events.push({ type: 'refill_empty', text: withVertical(TOP_UP_SKIP_EN[sendingSkip], vname), at });
        continue;
      }
      // stats.error_kind='letters_held' пишет крон до покупки сборки
      // (autoPipeline.ts, шаг 3a--): письмо запущенного шаблона прочиталось бы
      // неверно у любой строки, ночь пропущена, команде ушёл алерт.
      events.push(
        asStr(stats.error_kind) === 'instantly_capacity'
          ? {
              type: 'refill_empty',
              text: withVertical(`daily top-up stopped: ${HE_TEAM_ON_IT_SHORT_EN}`, vname),
              at,
            }
          : asStr(stats.error_kind) === 'letters_held'
            ? {
                type: 'refill_empty',
                text: withVertical('daily top-up paused: the letters need rewriting — message Support to have them rewritten', vname),
                at,
              }
          // stats.error_kind 'blocklist_over_cap' / 'blocklist_unreadable' пишет
          // крон до покупки сборки (autoPipeline.ts, шаг 3a- «СПИСОК DO NOT
          // CONTACT»): список владельца не читается, ночь не куплена, команде
          // ушёл алерт. Строка историческая: число — порог списка, а не его
          // нынешний размер (его пишет страница Do not contact).
          : asStr(stats.error_kind) === 'blocklist_over_cap'
            ? {
                type: 'refill_empty',
                text: withVertical(
                  `daily top-up skipped — your Do not contact list held more than ${BLOCKLIST_MAX_ENTRIES.toLocaleString('en-US')} ` +
                    'entries, so no one could be checked against it; remove entries on the Do not contact page',
                  vname,
                ),
                at,
              }
          : asStr(stats.error_kind) === 'blocklist_unreadable'
            ? {
                type: 'refill_empty',
                text: withVertical(
                  'daily top-up skipped — we could not read your Do not contact list, so no one was added; message Support if this repeats',
                  vname,
                ),
                at,
              }
          : budgetOutcome === 'cap_exhausted'
            ? {
                type: 'refill_empty',
                text: withVertical("daily top-up: nothing added — today's contact limit was already taken", vname),
                at,
              }
            : budgetOutcome === 'already_reserved'
              ? {
                  type: 'refill_empty',
                  text: withVertical('daily top-up: nothing added — repeat of a run that already started today', vname),
                  at,
                }
              : { type: 'failed', text: withVertical('daily top-up failed', vname), at },
      );
    }
  }

  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
