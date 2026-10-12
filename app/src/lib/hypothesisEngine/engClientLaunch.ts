/**
 * ENG: ОДИН путь запуска шаблона вертикали из английского кабинета — на две
 * точки входа (S3, решение владельца 10.10.2026: «запуски в пару кнопок»):
 *  - кнопка «Launch now» (POST api/client/eng/templates/[id]/launch, trigger
 *    'button') — роут проверяет вход (сессия, рынок, id, тело, окно, скоуп
 *    шаблона) и зовёт runHeEngTemplateLaunch;
 *  - автозапуск (engAutoLaunch.runHeEngAutoLaunchTick в воркере движка,
 *    trigger 'auto') — после «Launch» проекта шаблон вертикали, дозревший до
 *    'ready', запускается тем же вызовом: requireEngMarket и
 *    loadClientHeTemplate (те же функции, тот же порядок), затем
 *    runHeEngTemplateLaunch с startSending: true.
 *
 * Тело — бывший POST роута запуска (до 12.10.2026 жил в
 * api/client/eng/templates/[id]/launch/route.ts) БЕЗ изменений порядка и
 * текстов:
 *   гейт платных шагов (requireEngPaidAccess 'launch') → выключатель отправки
 *   аккаунта (requireHeEngSendingAccess via 'launch') → окно этого запуска
 *   (heEngLaunchWindowPlan, с 12.10.2026: первый запуск рынка — окно
 *   вызывающего, достройка — своё окно рынка) → ящики пула и пресет
 *   (ensureHeEngPresetForProject) → лимит неудачных запусков ('launch_failed')
 *   → журнал расхода + ядро runHeTemplateLaunch (force: false, скоуп владельца,
 *   locale 'en', окно запуска) → возврат попадания лимита → проекция 5xx/4xx →
 *   окно отправки на кампании и его запись (только первый запуск рынка) →
 *   проекция записи о запуске и предупреждений → проверка вызывающего перед
 *   стартом (onStartDecided, с 12.10.2026 — см. ниже) → старт кампаний
 *   (startHeEngLaunchSending via 'launch', только по startSending) → сводка
 *   отправки → конфиг ночного добора → справка команде (notifyHeClientLaunch).
 * Все тексты, константы и помощники — те же байты, что были в роуте; ответ
 * (`body`) — ровно прежний JSON (контракт api-client.launchEngTemplate); новое
 * — отказ проверки перед стартом (`sending.outcome 'refused'` с её кодом и
 * текстом) и 503 'unavailable', когда окно достройки не прочиталось.
 *
 * `trigger` меняет ТОЛЬКО контекст журнала (поле `trigger` у каждой строки
 * audit/warn/error) и справку команде (notifyHeClientLaunch). Больше ничего на
 * нём не ветвится: автоматический запуск проходит каждую защиту кнопки —
 * гейт оператора и писем ядра, чёрный список, окно США, ёмкость, удержание
 * сегментов, выключатель аккаунта, пул ящиков, паузу клиента.
 *
 * Ядро (launchTemplate.runHeTemplateLaunch) не изменено и по-прежнему ничего не
 * стартует; стартует только этот модуль (через engCampaignSending), как раньше
 * роут. RU staff-запуск, lib/clientLaunch/** и appendLeads не тронуты.
 *
 * НЕ БРОСАЕТ: брошенное ядро — 500 «Failed to launch the campaign» (раньше —
 * необработанное исключение роута и пустой 500 Next), попадание лимита
 * неудачных запусков при этом остаётся, как и было. Кроме ответа возвращается
 * `summary` — типизированный итог для автозапуска (engAutoLaunch,
 * heEngAutoLaunchVerdict): что произошло, без разбора текстов.
 *
 * retryHeEngLaunchStart — повтор ТОЛЬКО старта после успешного ядра (старт
 * не удался временно): те же гейты в том же порядке минус ядро.
 *
 * `onStartDecided` (оба вызова) — последняя проверка вызывающего прямо перед
 * startHeEngLaunchSending, когда старт уже решён (пропуска нет): кнопка и тик
 * передают engAutoLaunch.heEngStartGate — аккаунт ещё не заблокирован (бан
 * мог прийти посреди запуска) и решение «стартуем» записано в строку
 * автозапуска (код 'start_pending'). Отказ — старт не начат, итог 'refused' с
 * кодом проверки; бросок — тот же отказ 'start_not_recorded' (fail-closed).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scrubBrand } from '@/lib/scrubBrand';
import { ENG_PAID_UNAVAILABLE_TEXT, requireEngPaidAccess, type EngPaidAccessRefusal } from './engPaidAccess';
import { resolveHeLaunchSendingWindow } from './launchSchedule';
import {
  heLaunchOutcomeCode,
  heLaunchConflictOf,
  isHeLaunchClientSafeServerError,
  isHeLaunchUnpaidServerError,
  runHeTemplateLaunch,
  type HeTemplateLaunchOutcome,
} from './launchTemplate';
import {
  HE_ENG_RATE_RULES,
  heEngRetryMinutes,
  hitHeEngRateLimit,
  releaseHeEngRateHit,
} from './engRateLimit';
import { toClientEngCampaignName, toClientEngLaunchInfo } from './clientEngProjection';
import { openHeProviderJournal, withHeProviderJournal } from './costTelemetry';
import { HE_COST_LAUNCH_STAGE } from './costReport';
import { projectMarket } from './market';
import type { HeJob } from './types';
import { getHeClientFailure } from './clientErrors';
import { heLaunchIsIncomplete, parseLaunchInfo } from './launchHandoff';
import { notifyHeClientLaunch } from './opsAlert';
import { ensureHeEngPresetForProject } from './engSendingPreset';
import { requireHeEngSendingAccess } from './engSendingAccess';
import { readHeEngSendingSummaries, startHeEngLaunchSending, type HeEngStartResult } from './engCampaignSending';
import { heEngLaunchCampaigns, type HeEngStartErrorCode } from './engCampaignStatus';
import { ensureHeUsRefillConfig } from './autoPipeline';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';
import {
  applyEngSendingWindow,
  saveEngSendingWindow,
  toClientEngSendingWindow,
} from '@/app/api/client/eng/_launchWindow';

/* ─────────────── Контракт ─────────────── */

/** Кто нажал: клиент кнопкой («Launch now») или автозапуск воркера. */
export type HeEngLaunchTrigger = 'button' | 'auto';

export interface HeEngTemplateLaunchInput {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  /** Владелец проекта (клиент) — скоуп пресета, гейты, аудит. */
  userId: string;
  templateId: string;
  /** Результат loadClientHeTemplate (скоуп владельца уже проверен вызывающим). */
  owned: { project: Record<string, unknown>; template: Record<string, unknown> };
  /**
   * Окно отправки ПЕРВОГО запуска рынка (уже проверенное parseEngSendingWindow):
   * кнопка — из тела или дефолт кабинета, тик — окно намерения проекта. У
   * шаблона, у которого уже есть запись о запуске (достройка), не используется:
   * там своё окно рынка (heEngLaunchWindowPlan).
   */
  sendingWindow: ClientLaunchScheduleOverride;
  /** Стартовать кампании после ядра (`start_sending: true` кнопки; автозапуск — всегда). */
  startSending: boolean;
  trigger: HeEngLaunchTrigger;
  /** Отсюда считается срок старта кампаний (SENDING_DEADLINE_MS). */
  requestStartedAt: number;
  /**
   * Проверка прямо перед стартом кампаний (см. шапку); нет — старт без неё.
   * Зовётся только когда старт решён: у запуска нет пропуска (launch_problem /
   * window_not_applied / not_requested).
   */
  onStartDecided?: () => Promise<HeEngStartGateResult>;
}

/**
 * Итог проверки перед стартом: ok — стартуем; иначе старт не начат, `code` и
 * `message` уходят в итог старта (`sending.refusal` ответа кнопки),
 * `retryable` — повтор одного старта позже имеет смысл.
 */
export type HeEngStartGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string; retryable: boolean };

/** Проверка перед стартом бросила или не записалась — старт не начат. */
export const ENG_START_GATE_FAILED_TEXT =
  'Something went wrong on our side just now. The sending status of this market shows how to start the campaigns.';

/** Проверка перед стартом; бросок — отказ 'start_not_recorded' (fail-closed), не исключение запуска. */
async function runStartGate(
  gate: (() => Promise<HeEngStartGateResult>) | undefined,
  ctx: Record<string, unknown>,
): Promise<HeEngStartGateResult> {
  if (!gate) return { ok: true };
  try {
    return await gate();
  } catch (e) {
    void logWarn('client.eng.template.launch.start_gate_failed', e instanceof Error ? e.message : 'unknown', ctx);
    return { ok: false, code: 'start_not_recorded', message: ENG_START_GATE_FAILED_TEXT, retryable: true };
  }
}

/**
 * Итог старта кампаний этого запуска:
 *  - started — хоть одна кампания записи отправляет (стартована этим вызовом
 *    или уже отправляла);
 *  - not_started — ни одна: `reason` — пропуск роутом (launch_problem /
 *    window_not_applied / not_requested), пауза клиента (client_paused), отказ
 *    старта (refused, `code` — код engCampaignSending) или кампании не
 *    стартовали (failed: отказ рассыльщика, не хватило срока, неясный ответ).
 *    `retryable` — временный отказ: повтор одного старта (retryHeEngLaunchStart)
 *    имеет смысл.
 */
export type HeEngLaunchSendingVerdict =
  | { kind: 'started'; started: number; alreadySending: number }
  | {
      kind: 'not_started';
      reason: 'launch_problem' | 'window_not_applied' | 'not_requested' | 'client_paused' | 'refused' | 'failed';
      code: string | null;
      retryable: boolean;
    };

/**
 * Типизированный итог запуска (для автозапуска; кнопка его не читает):
 *  - refused — отказ ДО платной части, ничего не создано (гейты, лимит, 4xx
 *    ядра); `code` — машинный код отказа (гейта, ядра или конфликта ядра:
 *    launch_running / template_not_ready), null — 4xx ядра без кода;
 *  - failed — 5xx; `paid` — после классификатора сегментов (попадание лимита
 *    неудачных запусков осталось);
 *  - already_launched — у шаблона законченный запуск (409 ядра);
 *  - launched — 200: запись о запуске есть; `complete` — законченный.
 */
export type HeEngLaunchSummary =
  | { kind: 'refused'; status: number; code: string | null; retryAfterSeconds: number | null }
  | { kind: 'failed'; status: number; code: string | null; paid: boolean }
  | { kind: 'already_launched' }
  | { kind: 'launched'; complete: boolean; sending: HeEngLaunchSendingVerdict };

export interface HeEngTemplateLaunchResult {
  status: number;
  /** Ровно тело ответа роута (api-client.launchEngTemplate). */
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  summary: HeEngLaunchSummary;
}

/* ─────────────── Тексты и проекция ответа (байты бывшего роута) ─────────────── */

/**
 * Старт кампаний после ядра (блок «Отправка» ниже) укладывается в срок от
 * начала запроса: новая кампания начинается, только если до срока остаётся
 * бюджет одной кампании (engCampaignSending); не начатые клиент стартует
 * кнопкой «Start sending».
 */
const SENDING_DEADLINE_MS = 100_000;

const LAUNCH_FAILED = 'Failed to launch the campaign';

/**
 * Повтор ЗАКОНЧЕННОГО запуска (force у ядра: новые кампании для той же
 * аудитории и новая классификация сегментов) кабинету не нужен — ни «Launch
 * now», ни автозапуск его не шлют никогда, а незаконченный запуск ядро
 * достраивает без force. Отказ роута кнопки (400) — до этого модуля.
 */
export const ENG_LAUNCH_FORCE_NOT_AVAILABLE_TEXT = 'A finished launch cannot be repeated from your account.';
/**
 * Отказ ядра «уже запущено» (409 с записью о запуске) говорит про force —
 * словарь staff. Клиенту — что произошло, без него.
 */
const ALREADY_LAUNCHED = 'This template has already been launched, so it was not launched again.';

/** Лимит неудачных запусков шаблона (см. runHeEngTemplateLaunch) — числом в текстах ниже. */
const LAUNCH_FAILED_LIMIT = HE_ENG_RATE_RULES.launch_failed.limit;

/**
 * Отказ классификатора сегментов (503 segment_classification_incomplete,
 * шаг 5c ядра) — текст роута, а не константа ядра: та отправляет клиента к
 * менеджеру, а кабинет self-serve. Ничего не создано и не изменено.
 *
 * Срока повтора («через несколько минут») здесь нет: этот же отказ может
 * оказаться последним местом в лимите неудачных запусков шаблона (см. POST),
 * и тогда следующее нажатие откажет до конца часа. Поэтому фраза называет
 * само правило лимита — она правда и до него, и на нём. Окно лимита — час
 * (HE_ENG_RATE_RULES.launch_failed).
 */
const SEGMENT_CHECK_STOPPED =
  'We could not work out which segment of these letters fits too many of the addresses in this launch, so ' +
  'it was stopped before anything was sent or changed. You can try again later: once launching a template ' +
  `has not gone through ${LAUNCH_FAILED_LIMIT} times within an hour, its next try waits until an hour has ` +
  'passed since the first of them. If it keeps stopping, contact Support.';

/**
 * Запуск НЕ начат: у этого шаблона за час уже LAUNCH_FAILED_LIMIT запусков не
 * прошли после платной части (счётчик 'launch_failed', см. POST) — отказ
 * классификатора или сбой после него. Каждый повтор заново оплачивал бы
 * классификацию всей аудитории. «can check» — у шаблона без сегментных
 * вариантов классификатора нет. Число минут — до освобождения места в окне.
 */
function launchRetryLimitedText(minutes: number): string {
  return (
    `Launching this template has not gone through ${LAUNCH_FAILED_LIMIT} times within the last hour. Each try ` +
    'can check its whole audience again, so this try was not started. Nothing was sent or changed. You can try ' +
    `again in about ${minutes} minute${minutes === 1 ? '' : 's'}; if it keeps stopping, contact Support.`
  );
}

/* ── Проекция ответа запуска ── */

/**
 * Отказ отдельной сегментной кампании. Ядро склеивает его из текста ошибки API
 * рассыльщика (launchTemplate.ts, шаг 6) — бренд, коды и тело ответа. Клиенту
 * важен сам факт: часть аудитории не поехала; причину добавляет классификатор,
 * а КАКАЯ именно часть — segmentFailedWarning ниже.
 */
const WARNING_SEGMENT_FAILED = 'One segment of your audience did not launch.';

/** Не поехала ОСНОВНАЯ кампания запуска (сегмент null у ядра). */
const WARNING_MAIN_CAMPAIGN_FAILED =
  'The main campaign of this launch did not go out, so the part of your audience that has no segment of ' +
  'its own was not launched.';

/**
 * Какая именно часть аудитории не поехала. Условие сегмента — текст ИЗ ШАБЛОНА
 * КЛИЕНТА (его же гипотеза), поэтому показать его можно; но правило файла —
 * default-deny, и сырьё здесь тоже проверяется: внутренний след (кириллица
 * staff-фразы, имя подрядчика, наша таблица, ссылка) → безымянная формулировка.
 * Длина режется: «часть аудитории» в предупреждении — подпись, а не абзац.
 *
 * Зачем вообще имя: кампании запуска клиент различает только по сегменту, и
 * «один сегмент не поехал» у шаблона с тремя сегментами не даёт ему ни проверить
 * результат, ни сказать Support, чего не хватает.
 */
function segmentFailedWarning(segment: string | null): string {
  if (segment === null) return WARNING_MAIN_CAMPAIGN_FAILED;
  const named = segment.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!named || INTERNAL_TRACE_RE.test(named)) return WARNING_SEGMENT_FAILED;
  return `One segment of your audience did not launch: “${named}”.`;
}

/**
 * Имена сегментов, не поехавших в этом запуске, в порядке ядра
 * (`segment_failures` его ответа). Сам список наружу не уходит — в его `error`
 * лежит сырьё рассыльщика; наружу идут только тексты, собранные здесь.
 */
function readSegmentFailures(raw: unknown): Array<string | null> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const segment = (item as { segment?: unknown } | null)?.segment;
    return typeof segment === 'string' ? segment : null;
  });
}

/**
 * Общий ответ на предупреждение, в котором остался внутренний след. Сюда
 * попадает, в частности, предупреждение о несохранённой записи о запуске
 * (launchTemplate.ts:445): оно называет колонку `he_templates.launch_info` и
 * миграцию — словарь staff, а не клиента. Смысл для клиента тот же: кампании
 * созданы, но повторный запуск этим текстом не защищён.
 */
const WARNING_NEEDS_ATTENTION =
  'Part of the launch reported a problem on our side, so the campaigns that were created were not started. Contact Support to have them checked before you start them or launch this template again.';

/** Префикс отказа сегментной группы в английском контуре (launchTemplate.ts:429). */
const SEGMENT_FAILED_PREFIX = 'Segment campaign failed: ';

/**
 * Окно отправки клиента не доехало НИ ДО ОДНОЙ кампании. Новые кампании ядро
 * создаёт сразу с окном запуска, а кампании прошлой попытки, которые ядро не
 * трогало, роут на достройке с 12.10.2026 не переставляет (у рынка свои часы,
 * см. блок «Окно отправки» ниже) — поэтому так бывает, только когда в записи успешного
 * запуска нет ни одной кампании, или на ПЕРВОМ запуске рынка, где ядро не
 * назвало кампании с окном (`window_campaign_ids`), а PATCH окна не прошёл ни
 * у одной. Отказом ответ не делаем — слепой повтор наплодил бы дубли кампаний
 * и лидов, — но клиент обязан узнать, что до старта окно надо переставить.
 *
 * Слово «default» здесь было ложью: в кабинете «default» — это 09:00–17:00
 * Eastern (engDefaultSendingWindow), а у кампаний остались часы пресета.
 * Посмотреть настоящие часы клиент может там же, куда его отправляет фраза:
 * GET .../schedule, не найдя сохранённого выбора новее этого запуска, читает
 * окна кампаний запуска у рассыльщика (разные — говорит и это). «Save the
 * hours you want», а не «save your window again»: форма покажет прочитанные
 * часы кампаний, а не выбор, который до них не доехал. Кнопку старта фраза не
 * называет: часть кампаний может уже отправлять («Start the rest»), клиент мог
 * поставить паузу («Resume») — какая кнопка стоит, показывает блок отправки
 * шаблона (engText.engStartButtonOf).
 */
const WARNING_SCHEDULE_NOT_APPLIED =
  'The campaigns were created, but the sending window you picked did not reach them, so they kept ' +
  'their earlier sending hours, and this launch did not start sending. Open the sending window of this ' +
  'template to see those hours, save the hours you want, and then start the campaigns — the sending status ' +
  'of this template shows how.';

/**
 * Окно доехало до ЧАСТИ кампаний первого запуска рынка (сплит по сегментам
 * базы создаёт их несколько). Называем именно те, где осталось прежнее окно, —
 * это только кампании, которым окно ставил ЭТОТ роут и рассыльщик его не
 * принял: созданные ядром несут окно с момента создания, а кампании прошлой
 * попытки достройки роут не трогает (свои часы рынка). Клиент различает
 * кампании запуска только по имени, и «часть» без имён не даёт ему проверить
 * результат повторного сохранения. Имя идёт через тот же проектор, что и
 * launch_info ответа (внутренний префикс и русский фолбэк срезаны), id кампаний
 * наружу не уходят.
 *
 * Выбор при частичной перестановке НЕ сохраняется (см. блок «Окно отправки»
 * ниже), и форма окна на этом шаге показывает часы, прочитанные у кампаний, с
 * пометкой, что они у кампаний разные, — поэтому «save the hours you want», а
 * не «save it again»: выбранного окна в форме может не быть.
 */
function scheduleAppliedPartlyWarning(keptEarlierWindow: string[]): string {
  const named = keptEarlierWindow.filter((name) => name.length > 0).join(', ').slice(0, 300);
  return (
    'The sending window you picked reached only part of this launch. ' +
    (named
      ? `These campaigns kept their earlier sending hours: ${named}. `
      : 'Some campaigns kept their earlier sending hours. ') +
    'This launch did not start sending — open the sending window on this step, save the hours you want, ' +
    'and then start the campaigns — the sending status of this template shows how.'
  );
}

/**
 * Окно стоит у ВСЕХ кампаний запуска, а в кабинете не сохранилось (запись
 * выбора). Прежнее «this screen may show the default window» стало неправдой:
 * без сохранённого выбора новее запуска GET .../schedule читает окна кампаний
 * запуска у рассыльщика, то есть показывает то, что там стоит.
 */
const WARNING_SCHEDULE_NOT_SAVED =
  'Your sending window is live on the campaigns but could not be saved in the cabinet, so the ' +
  'sending-window screen reads it back from the campaigns instead.';

/**
 * Внутренний след в строке предупреждения: кириллица (фраза написана для
 * staff), имя подрядчика, имя таблицы движка или ссылка. Нужен именно
 * default-deny: три безопасных предупреждения ядра — готовые английские
 * константы (пропущенные строки базы, сегментные варианты, сплит по
 * сегментам), и новое предупреждение не должно утечь в кабинет только потому,
 * что про него здесь забыли.
 */
const INTERNAL_TRACE_RE = /[Ѐ-ӿ]|\b(?:Requesty|Serper|OpenRouter|instantly)\b|\bhe_[a-z_]+\b|https?:\/\//i;

/**
 * Предупреждения клиенту нужны (сегмент не запустился, строки базы отсеяны),
 * но собраны они для обоих контуров сразу. Безопасные константы ядра проходят
 * как есть, знакомая опасная форма заменяется своей английской, всё остальное
 * с внутренним следом — общей формулировкой. Ни один байт сырья наружу не
 * уходит: тексты собраны только из констант этого файла и клиентского
 * классификатора (clientErrors.ts, тот тоже отвечает только константами).
 */
function toClientLaunchWarnings(raw: unknown, segmentFailures: Array<string | null>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  let failureIndex = 0;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (text.startsWith(SEGMENT_FAILED_PREFIX)) {
      // Классифицируем ИСХОДНУЮ строку: правила опираются на имена подрядчиков
      // и коды их ответов — очищенный текст их бы не содержал.
      const failure = getHeClientFailure(text.slice(SEGMENT_FAILED_PREFIX.length));
      // Ядро складывает эти строки и segment_failures в ОДНОМ порядке, поэтому
      // i-й строке соответствует i-й сегмент. Списка нет (ответ без него) —
      // остаётся прежняя безымянная формулировка, а не догадка по тексту:
      // разобрать склейку «сегмент: ошибка» обратно нельзя, в условии сегмента
      // бывает ': '.
      const named = failureIndex < segmentFailures.length ? segmentFailures[failureIndex] : undefined;
      failureIndex += 1;
      out.push(
        `${named === undefined ? WARNING_SEGMENT_FAILED : segmentFailedWarning(named)} ${failure.title}`,
      );
      continue;
    }
    out.push(INTERNAL_TRACE_RE.test(text) ? WARNING_NEEDS_ATTENTION : text);
  }
  return out;
}

/* ─────────────── Итог старта ─────────────── */

/**
 * Отказы старта (engCampaignSending), которые проходят сами: сбой чтения,
 * запуск ещё держит аренду записи, настройка пула или выключатель не
 * прочитались. Повтор одного старта (retryHeEngLaunchStart) их и ждёт.
 */
const RETRYABLE_START_REFUSALS: ReadonlySet<string> = new Set([
  'launch_running',
  'sending_read_failed',
  'sending_state_unavailable',
  'sending_access_unavailable',
  'sending_setup_unavailable',
  'sending_setup_failed',
]);

/**
 * Кампании, которые этот старт не стартовал «навсегда» (рассыльщик их
 * остановил, адреса не из ящиков проекта, кампании нет): повтор старта им не
 * поможет — их видит блок отправки с причиной и Support.
 */
const PERMANENT_START_FAILURES: ReadonlySet<HeEngStartErrorCode> = new Set<HeEngStartErrorCode>([
  'mailboxes_changed',
  'needs_attention',
  'not_found',
]);

/** Итог старта из ответа startHeEngLaunchSending (без побочных действий). */
function sendingVerdictOf(started: HeEngStartResult): HeEngLaunchSendingVerdict {
  if (started.kind === 'refused') {
    const launchProblem =
      started.code === 'record_mismatch' || started.code === 'not_launched';
    return {
      kind: 'not_started',
      reason: launchProblem ? 'launch_problem' : 'refused',
      code: started.code,
      retryable: RETRYABLE_START_REFUSALS.has(started.code),
    };
  }
  if (started.clientPaused) return { kind: 'not_started', reason: 'client_paused', code: null, retryable: false };
  const startedNow = Math.max(0, started.started - started.compensated);
  if (startedNow > 0 || started.alreadySending > 0) {
    return { kind: 'started', started: startedNow, alreadySending: started.alreadySending };
  }
  // Стартовано и тут же поставлено на паузу: клиент нажал Pause посреди старта.
  if (started.compensated > 0) return { kind: 'not_started', reason: 'client_paused', code: null, retryable: false };
  const failedCodes = started.failed.map((f) => f.code);
  const transient =
    started.notAttempted > 0 ||
    started.unconfirmed > 0 ||
    failedCodes.some((code) => !PERMANENT_START_FAILURES.has(code));
  return {
    kind: 'not_started',
    reason: 'failed',
    code: failedCodes[0] ?? (started.campaigns === 0 ? 'nothing_to_start' : null),
    retryable: transient,
  };
}

/** Тело отказа гейта платных шагов — тот же JSON, что engPaidAccessResponse. */
function paidRefusalResult(refusal: EngPaidAccessRefusal): HeEngTemplateLaunchResult {
  return {
    status: refusal.status,
    body: {
      error: refusal.message,
      code: refusal.code,
      ...(refusal.retryAfterSeconds !== undefined ? { retry_after_seconds: refusal.retryAfterSeconds } : {}),
      ...(refusal.emailMissing ? { email_missing: true } : {}),
    },
    ...(refusal.retryAfterSeconds !== undefined
      ? { headers: { 'Retry-After': String(refusal.retryAfterSeconds) } }
      : {}),
    summary: { kind: 'refused', status: refusal.status, code: refusal.code, retryAfterSeconds: refusal.retryAfterSeconds ?? null },
  };
}

/* ─────────────── Окно этого запуска ─────────────── */

/**
 * Окно отправки этого запуска (решение 12.10.2026: шаг 3 обещает, что рынок,
 * который уже отправляет, держит свои часы):
 *  - у шаблона НЕТ записи о запуске (нет id первой кампании) — ПЕРВЫЙ запуск
 *    рынка ('first'): окно вызывающего (`sendingWindow` входа);
 *  - запись ЕСТЬ ('finishing': достройка незаконченного запуска; законченный
 *    ядро отвергнет 409) — СВОЁ окно рынка: сохранённый выбор шаблона
 *    (he_launch_schedule), иначе последний выбор клиента на другом шаблоне,
 *    иначе дефолт кабинета — resolveHeLaunchSendingWindow, тот же порядок, что
 *    у ядра на пути без кабинета. Переданное окно здесь не берётся, кроме
 *    проекта не us (окна-выбора у рынка нет, resolve отвечает «пресет»).
 *    Это окно получают только кампании, которые ядро создаёт или досылает
 *    в этом заходе (пустая кампания прошлой попытки); кампании прошлой
 *    попытки с адресами роут не переставляет (блок «Окно отправки» ниже);
 *  - любое чтение не удалось ('unavailable') — запуск не начинается
 *    (fail-closed): часы рынка не угадываются.
 * Колонка записи читается одним полем (launch_info->>campaign_id): у
 * незаконченного запуска в записи адреса долга.
 */
type HeEngLaunchWindowPlan =
  | { kind: 'first' | 'finishing'; window: ClientLaunchScheduleOverride }
  | { kind: 'unavailable'; reason: string };

async function heEngLaunchWindowPlan(
  portalDb: SupabaseClient,
  args: {
    templateId: string;
    userId: string;
    project: Record<string, unknown>;
    requested: ClientLaunchScheduleOverride;
  },
): Promise<HeEngLaunchWindowPlan> {
  try {
    const { data, error } = await portalDb
      .from('he_templates')
      .select('id, launch_campaign_id:launch_info->>campaign_id')
      .eq('id', args.templateId)
      .maybeSingle();
    if (error) return { kind: 'unavailable', reason: `launch record mark not read: ${error.message}` };
    const campaignId = (data as { launch_campaign_id?: unknown } | null)?.launch_campaign_id;
    if (typeof campaignId !== 'string' || campaignId.length === 0) {
      return { kind: 'first', window: args.requested };
    }
    const plan = await resolveHeLaunchSendingWindow({
      db: portalDb,
      market: projectMarket(args.project as { market?: string | null }),
      templateId: args.templateId,
      clientUserId: args.userId,
      explicit: null,
    });
    if (plan.readError) {
      const message = (plan.readError as { message?: unknown } | null)?.message;
      return { kind: 'unavailable', reason: `market sending window not read: ${String(message ?? 'unknown')}` };
    }
    return { kind: 'finishing', window: plan.window ?? args.requested };
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : 'unknown' };
  }
}

/* ─────────────── Запуск ─────────────── */

// Запуск: выключатель отправки аккаунта, ящики пула проекта и пресет из них
// (ensureHeEngPresetForProject), затем ДЕЛЕГИРУЕМ в общее ядро
// runHeTemplateLaunch (та же механика, что у staff: PAUSED-кампания, лиды
// базы, launch_info в шаблоне, незаконченный запуск достраивается), и после
// успешного ядра СТАРТУЕМ созданные кампании, если вызывающий это просит
// (`startSending`; блок «Отправка» ниже; ядро само не стартует ничего).
// Отличия клиентского контура:
// повтора законченного запуска (force) нет (роут кнопки отказывает 400 до
// этого вызова); пресет читается со скоупом владельца, тексты EN, бренд
// рассыльщика скрабим из ошибок, а ответ ядра не отдаём как есть — сужаем
// белым списком (см. выше): в нём ссылка на панель рассыльщика, id пресета и
// предупреждения, написанные для внутреннего контура. Плюс своё, чего у
// staff-запуска нет: клиент выбирает ОКНО ОТПРАВКИ (пояс/часы/дни) — ядро
// создаёт кампании сразу с ним, см. блок «Окно отправки» ниже и
// `api/client/eng/templates/[id]/schedule` для правки уже созданных кампаний.
//
// Гейт платных шагов (requireEngPaidAccess, действие 'launch') — до журнала и
// ядра: подтверждённая почта (письма уходят живым людям) и потолок расхода
// клиента (по умолчанию выключен; таблица действий в engPaidAccess.ts).
// Платная часть самого запуска — классификатор сегментов (шаг 5c ядра). Его
// повтор у законченного запуска закрыт отказом force; а запуск, который НЕ
// ПРОШЁЛ после него, — отказ классификатора (503
// segment_classification_incomplete, без ответа больше половины адресов) или
// сбой после классификации (первая кампания у рассыльщика не создалась —
// 500 без кода; бросок ядра), — записи о запуске не оставляет, и каждое
// следующее нажатие заново оплачивало классификацию всей аудитории. Поэтому
// такие запуски считаются по шаблону: не больше 3 за час (engRateLimit,
// 'launch_failed'), следующее нажатие в окне отвечает 503 без вызова ядра —
// см. блок перед журналом. Не считаются 5xx ядра ДО классификатора
// (isHeLaunchUnpaidServerError: пресет, рынок, защиты, чёрный список, аренда
// не прочитались) — они ничего не оплатили и зовут повторить через минуту.
export async function runHeEngTemplateLaunch(input: HeEngTemplateLaunchInput): Promise<HeEngTemplateLaunchResult> {
  const { portalDb, instantlyDb, userId, templateId: id, owned, sendingWindow, trigger } = input;
  const startRequested = input.startSending;
  const projectId = String(owned.project.id);
  // Бросок пришёл из ядра (после попадания лимита неудачных запусков, которое
  // он оставляет, — как раньше исключение роута), см. catch ниже.
  let inCore = false;
  try {
    const access = await requireEngPaidAccess(portalDb, userId, { action: 'launch' });
    if (!access.ok) return paidRefusalResult(access.refusal);

    // Выключатель отправки аккаунта (engSendingAccess; по умолчанию требуется,
    // HE_US_SENDING_REQUIRES_ACTIVATION=0 снимает) — до ящиков пула, ядра и
    // любого вызова рассыльщика: запуск теперь начинает отправку. Отказ «не
    // включена» записывает, что клиент ждёт, и зовёт команду (алерт).
    const sendingAccess = await requireHeEngSendingAccess(portalDb, userId, {
      projectId,
      via: 'launch',
    });
    if (!sendingAccess.ok) {
      return {
        status: sendingAccess.status,
        body: { error: sendingAccess.message, code: sendingAccess.code },
        summary: { kind: 'refused', status: sendingAccess.status, code: sendingAccess.code, retryAfterSeconds: null },
      };
    }

    // Окно этого запуска (heEngLaunchWindowPlan): первый запуск рынка — окно
    // вызывающего, достройка — своё окно рынка. Не прочиталось — 503, ничего
    // не начато и не записано (до ящиков пула, лимита и ядра).
    const windowPlan = await heEngLaunchWindowPlan(portalDb, {
      templateId: id,
      userId,
      project: owned.project,
      requested: sendingWindow,
    });
    if (windowPlan.kind === 'unavailable') {
      void logWarn('client.eng.template.launch.window_unread', windowPlan.reason, { userId, templateId: id, trigger });
      return {
        status: 503,
        body: { error: ENG_PAID_UNAVAILABLE_TEXT, code: 'unavailable' },
        summary: { kind: 'refused', status: 503, code: 'unavailable', retryAfterSeconds: null },
      };
    }
    const finishing = windowPlan.kind === 'finishing';
    const launchWindow = windowPlan.window;

    // Ящики пула проекта и пресет клиента из них (engSendingPreset — контракт
    // лейна пула): нехватка ящиков и сбой настройки — отказ до ядра, ничего не
    // создано. Дальше ядро получает ЭТОТ пресет, а не выбранный клиентом.
    const sendingPreset = await ensureHeEngPresetForProject(projectId, userId, { portalDb, instantlyDb });
    if (sendingPreset.kind !== 'ready') {
      return {
        status: sendingPreset.status,
        body: { error: sendingPreset.message, code: sendingPreset.code },
        summary: { kind: 'refused', status: sendingPreset.status, code: sendingPreset.code, retryAfterSeconds: null },
      };
    }
    const presetId = sendingPreset.presetId;

    // Неудачные запуски этого шаблона за час. Попадание пишется ДО ядра (два
    // параллельных нажатия не проходят оба последнее место) и остаётся, если
    // запуск не прошёл после платной части: отказ классификатора, любой
    // другой 5xx ядра, кроме отказов до классификатора, или бросок ядра
    // (ниже, finally). Успех, 4xx и 5xx до классификатора его возвращают.
    // Окно полно — запуск не начат, ответ 503 без кода. Без миграции
    // 20261010_0001 счёт — в памяти процесса (engRateLimit), строка warn.
    const failedHit = await hitHeEngRateLimit(portalDb, 'launch_failed', id);
    if (failedHit.fallbackReason) {
      void logWarn(
        'client.eng.template.launch.failed_limit_fallback',
        `failed-launch count decided in process memory: ${failedHit.fallbackReason}`,
        { userId, templateId: id, trigger },
      );
    }
    if (!failedHit.allowed) {
      void logAudit(
        'client.eng.template.launch.retry_limited',
        'ENG launch not started: launches of this template failed after their paid part too often within the hour',
        { userId, templateId: id, retryAfterSeconds: failedHit.retryAfterSeconds, trigger },
      );
      return {
        status: 503,
        body: {
          error: launchRetryLimitedText(heEngRetryMinutes(failedHit.retryAfterSeconds)),
          retry_after_seconds: failedHit.retryAfterSeconds,
        },
        headers: { 'Retry-After': String(failedHit.retryAfterSeconds) },
        summary: { kind: 'refused', status: 503, code: 'retry_limited', retryAfterSeconds: failedHit.retryAfterSeconds },
      };
    }

    // Журнал расхода ENG (costTelemetry.ts) вокруг ядра запуска: классификатор
    // сегментов (шаг 5c ядра) — платный вызов модели, и без журнала он не
    // попадал ни в отчёт себестоимости, ни в потолок расхода. Только у
    // проекта market='us' (рынок — из уже прочитанного скоупа, без запроса);
    // у другого рынка openHeProviderJournal отвечает null, и ядро зовётся как
    // раньше. Запись строк фоновая и не бросает: запуск её не ждёт (settle
    // здесь не зовётся — ожидание до 40 с при лежащей БД вытолкнуло бы ответ
    // за maxDuration), а сбой записи стоит строки журнала, не запуска. Стадия
    // HE_COST_LAUNCH_STAGE не из he_jobs, на месте id джобы — id шаблона
    // (costReport.ts, шапка).
    const journal = openHeProviderJournal(
      portalDb,
      projectMarket(owned.project as { market?: string | null }),
      {
        id,
        project_id: projectId,
        stage: HE_COST_LAUNCH_STAGE as HeJob['stage'],
        payload: {},
      },
      (msg) => console.warn(msg),
    );
    // Вернуть попадание 'launch_failed' — только когда исход известен и он не
    // «не прошёл после платной части». Бросок ядра оставляет его.
    let releaseFailedHit = false;
    let outcome: HeTemplateLaunchOutcome;
    inCore = true;
    try {
      outcome = await withHeProviderJournal(journal, () =>
        runHeTemplateLaunch({
          portalDb,
          instantlyDb,
          templateId: id,
          presetId,
          force: false,
          userId,
          scopeClientUserId: userId,
          locale: 'en',
          eventPrefix: 'client.eng.template.launch',
          // Окно запуска уезжает в ядро: новые кампании создаются СРАЗУ с ним
          // (шаг 4b⁗ ядра), а не с часами пресета до второго вызова. На
          // достройке это своё окно рынка (heEngLaunchWindowPlan).
          sendingWindow: launchWindow,
        }),
      );
      releaseFailedHit = outcome.status < 500 || isHeLaunchUnpaidServerError(outcome.body.error);
    } finally {
      // Не вышло вернуть — попадание считается до конца окна, строка warn.
      if (releaseFailedHit) {
        const failure = await releaseHeEngRateHit(portalDb, 'launch_failed', id, failedHit);
        if (failure) {
          void logWarn('client.eng.template.launch.failed_limit_release_failed', `hit kept: ${failure}`, {
            userId,
            templateId: id,
            trigger,
          });
        }
      }
    }
    inCore = false;

    // 5xx ядра запуска несут сырьё: сообщение Postgres (чтения шаблона и базы)
    // и тело ответа API рассыльщика (отказ первой кампании). Наружу — константа
    // + код причины, настоящий текст уходит в application_logs.
    //
    // Исключение — английские константы ядра, которые клиенту нужны КАК ЕСТЬ
    // (isHeLaunchClientSafeServerError): «чёрный список не прочитался /
    // настройки проекта не прочитались / начало запуска не записалось — кампания
    // не создана, повторите через минуту» и «рассыльщик не принял ни одного
    // адреса, кампании на паузе». Подменённые общей «Failed to launch the
    // campaign», они не давали клиенту отличить безопасный повтор от сбоя
    // посреди запуска. Сырья в них нет, это литералы словаря ядра.
    //
    // Отказ классификатора сегментов (503 segment_classification_incomplete)
    // уходит СО СВОИМ КОДОМ и статусом. Код — из словаря ядра
    // (heLaunchOutcomeCode), текст — свой (SEGMENT_CHECK_STOPPED): он
    // называет правило лимита неудачных запусков, а у ядра — срок повтора,
    // который на последнем месте лимита неправда.
    if (outcome.status >= 500 && typeof outcome.body.error === 'string') {
      const outcomeCode = heLaunchOutcomeCode(outcome);
      const paid = !isHeLaunchUnpaidServerError(outcome.body.error);
      if (outcomeCode === 'segment_classification_incomplete') {
        await logError('client.eng.template.launch_failed', new Error(outcome.body.error), {
          userId,
          templateId: id,
          status: outcome.status,
          code: outcomeCode,
          trigger,
        });
        return {
          status: 503,
          body: { error: SEGMENT_CHECK_STOPPED, code: outcomeCode },
          summary: { kind: 'failed', status: 503, code: outcomeCode, paid: true },
        };
      }
      const outward = isHeLaunchClientSafeServerError(outcome.body.error) ? outcome.body.error : LAUNCH_FAILED;
      await logError('client.eng.template.launch_failed', new Error(outcome.body.error), {
        userId,
        templateId: id,
        status: outcome.status,
        trigger,
      });
      return {
        status: 500,
        body: { error: outward },
        summary: { kind: 'failed', status: outcome.status, code: outcomeCode, paid },
      };
    }

    // 4xx — это продуктовые причины ядра (нет валидных адресов, лимит лидов,
    // уже запущено): они по-английски и предназначены клиенту. White-label:
    // в тексте всё же может проскочить бренд рассыльщика — скрабим.
    const responseBody = { ...outcome.body };
    // Машинный список отказов сегментов — вход для предупреждений ниже, и
    // наружу он НЕ уходит: в его `error` лежит текст ответа рассыльщика.
    const segmentFailures = readSegmentFailures(responseBody.segment_failures);
    delete responseBody.segment_failures;
    // Кампании, которые получили окно уже в ядре (созданы с ним или
    // переставлены PATCH'ем цепочки), — служебный список ядра: id наружу не
    // уходят, ключ удаляем.
    const windowAppliedInCore = new Set(
      Array.isArray(responseBody.window_campaign_ids)
        ? (responseBody.window_campaign_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    );
    delete responseBody.window_campaign_ids;
    if (typeof responseBody.error === 'string') {
      responseBody.error = scrubBrand(responseBody.error);
    }
    // 409 с записью о запуске у ядра ровно один — «уже запущено».
    const alreadyLaunched = outcome.status === 409 && 'launch' in responseBody;
    if (alreadyLaunched) {
      responseBody.error = ALREADY_LAUNCHED;
    }

    // ── Окно отправки на кампании запуска ──
    //
    // С 09.10.2026 окно ставит ЯДРО: новые кампании создаются сразу с окном
    // запуска, а пустая кампания прошлой попытки получает его тем же PATCH'ем,
    // что и цепочку (`window_campaign_ids` ответа ядра).
    //
    // ДОСТРОЙКА (`finishing`, у шаблона была запись о запуске): кампании,
    // которые ядро не трогало (прошлой попытки, с адресами — их получатели
    // могут быть в рассылке, кампания может уже отправлять), здесь НЕ
    // переставляются и выбор рынка не перезаписывается: у рынка свои часы
    // (шаг 3), а окно этого захода — оно же, своё окно рынка
    // (heEngLaunchWindowPlan). Часы такого рынка меняет только
    // PATCH .../schedule шаблона.
    //
    // ПЕРВЫЙ запуск рынка: ядро ставит окно каждой своей кампании; кампании,
    // которых нет в `window_campaign_ids` (ядро окно не назвало), получают его
    // здесь PATCH'ем (в нём только campaign_schedule), и выбор сохраняется,
    // если окно встало у всех.
    //
    // Только на успешном запуске (200). 409 «уже запущено» не создаёт кампаний, и
    // переставлять окно у чужого прошлого запуска этот ответ не должен — для
    // этого есть PATCH .../schedule.
    const scheduleWarnings: string[] = [];
    if (outcome.status === 200) {
      const launched = parseLaunchInfo(outcome.body.launch);
      // Сегментный сплит делает по кампании на сегмент: окно выбрано одно на
      // шаблон, значит на первом запуске ставим его всем кампаниям запуска.
      // Имя несём рядом с id: если рассыльщик окно не принял, клиенту надо
      // сказать, У КАКОЙ кампании остались прежние часы.
      const launchedCampaigns: Array<{ campaign_id: string; campaign_name: string }> = launched
        ? (launched.campaigns ?? [
            { campaign_id: launched.campaign_id, campaign_name: launched.campaign_name },
          ])
        : [];
      const campaigns = launchedCampaigns
        .filter((c) => typeof c.campaign_id === 'string' && c.campaign_id.length > 0)
        .map((c) => ({ id: c.campaign_id, name: toClientEngCampaignName(c.campaign_name) }));
      // Окно уже стоит (ядро) — второй вызов им не нужен.
      const notSetByCore = campaigns.filter((c) => !windowAppliedInCore.has(c.id));
      // На достройке кампании, которые ядро не трогало, держат свои часы.
      const needWindow = finishing ? [] : notSetByCore;

      // Сколько кампаний РЕАЛЬНО несут окно этого захода: от этого зависит и
      // текст предупреждения, и попадёт ли окно в ответ (см. ниже).
      let scheduleAppliedTo = campaigns.length - notSetByCore.length;
      // Кампании, у которых окно переставить не вышло: только они «остались на
      // прежних часах» — у созданных ядром окно стоит с первой секунды.
      const keptEarlierWindow: string[] = [];
      let lastError: unknown = null;

      if (needWindow.length > 0) {
        // Аккаунт рассыльщика — тот же, в котором ядро создало кампанию: он задан
        // пресетом ЗАПИСИ о запуске (скоуп владельца, чужой пресет невидим), а не
        // выбранным в запросе — достройку ядро ведёт пресетом, с которым запуск
        // начат (launchTemplate.ts, шаг 3). Промах аккаунтом означал бы PATCH в
        // чужой воркспейс.
        const launchPresetId = launched?.preset_id || presetId;
        const { data: presetAccountRow, error: presetAccountErr } = await instantlyDb
          .from('client_campaign_presets')
          .select('instantly_account_id')
          .eq('id', launchPresetId)
          .eq('client_user_id', userId)
          .maybeSingle();
        if (presetAccountErr) {
          await logError('client.eng.template.launch.schedule_preset_failed', presetAccountErr, {
            userId,
            templateId: id,
            trigger,
          });
          lastError = presetAccountErr;
          for (const campaign of needWindow) keptEarlierWindow.push(campaign.name);
        } else {
          const requestOptions = {
            accountId: resolveInstantlyAccountId(
              (presetAccountRow as { instantly_account_id?: string | null } | null)
                ?.instantly_account_id ?? null,
            ),
          };
          // По ОДНОЙ кампании за вызов: applyEngSendingWindow отдаёт только
          // счётчики, а клиенту нужно имя той, у которой окно не переставилось.
          // Вызов идемпотентен — в PATCH уходит только campaign_schedule.
          for (const campaign of needWindow) {
            const one = await applyEngSendingWindow({
              campaignIds: [campaign.id],
              window: launchWindow,
              requestOptions,
            });
            if (one.updated > 0) {
              scheduleAppliedTo += 1;
              continue;
            }
            keptEarlierWindow.push(campaign.name);
            lastError = one.lastError;
          }
        }
      }

      if (campaigns.length === 0) {
        scheduleWarnings.push(WARNING_SCHEDULE_NOT_APPLIED);
      } else if (keptEarlierWindow.length > 0) {
        // Текст отказа рассыльщика клиенту не показываем (бренд, коды, тело
        // ответа) — он уходит в application_logs; наружу идут константа и
        // очищенные проектором имена кампаний.
        await logError('client.eng.template.launch.schedule_apply_failed', lastError, {
          userId,
          templateId: id,
          campaigns: campaigns.length,
          failed: keptEarlierWindow.length,
          trigger,
        });
        scheduleWarnings.push(
          scheduleAppliedTo > 0
            ? scheduleAppliedPartlyWarning(keptEarlierWindow)
            : WARNING_SCHEDULE_NOT_APPLIED,
        );
      }
      // Окно стоит у ВСЕХ кампаний запуска — только тогда оно правда «окно
      // этого запуска» (и поле `schedule` ниже, и сохранённый выбор).
      const appliedToAll = campaigns.length > 0 && scheduleAppliedTo === campaigns.length;
      if (scheduleAppliedTo > 0) {
        // Выбор сохраняем, только если окно встало у всех кампаний: сохранённую
        // строку новее записи о запуске GET .../schedule печатает окном ВСЕГО
        // запуска, не спрашивая рассыльщика. При частичной перестановке строки
        // новее записи нет (прежняя — старше этой попытки: ядро пишет
        // created_at записи временем её начала), и GET читает окна у самих
        // кампаний — то есть видит, что они разные. Достройка выбор рынка не
        // пишет (он и есть окно этого захода либо его нет — см. выше).
        if (appliedToAll && !finishing) {
          const saved = await saveEngSendingWindow(portalDb, {
            templateId: id,
            clientUserId: userId,
            window: launchWindow,
          });
          if (!saved.ok) {
            // Таблица могла быть не создана (миграция не применена) — окно у
            // рассыльщика уже стоит, поэтому это предупреждение, а не отказ.
            await logError('client.eng.template.launch.schedule_save_failed', saved.error, {
              userId,
              templateId: id,
              trigger,
            });
            scheduleWarnings.push(WARNING_SCHEDULE_NOT_SAVED);
          }
        }
        await logAudit(
          'client.eng.template.launch.schedule_applied',
          'ENG client picked the sending window for a launch',
          {
            userId,
            templateId: id,
            timezone: launchWindow.timezone,
            from: launchWindow.from,
            to: launchWindow.to,
            days: launchWindow.days,
            campaigns: scheduleAppliedTo,
            atCreation: campaigns.length - notSetByCore.length,
            failed: keptEarlierWindow.length,
            finishing,
            keptOwnHours: finishing ? notSetByCore.length : 0,
            trigger,
          },
        );
      }

      // Клиенту — ровно четыре поля выбора (проекция), и ТОЛЬКО если окно
      // стоит у ВСЕХ кампаний запуска: поле означает «часы, с которыми
      // кампании уехали». Нет поля — единственное, что клиент читает про
      // окно, это предупреждение.
      if (appliedToAll) {
        responseBody.schedule = toClientEngSendingWindow(launchWindow);
      }
    }

    // Запись о запуске уезжает клиенту ДВУМЯ путями: успех (200) и «шаблон уже
    // запущен» (409, launchTemplate.ts:168) — сужаем оба, поле одно и то же.
    //
    // Проектор общий с деталкой проекта (она отдаёт ту же
    // `he_templates.launch_info`): два ответа про один объект обязаны совпадать
    // по составу полей, иначе «скрытое» поле возвращается через второй
    // эндпоинт. Сужается ТОЛЬКО ответ: в колонке ядро уже записало полную
    // запись (launchTemplate.ts:435), её не трогаем.
    if ('launch' in responseBody) {
      responseBody.launch = toClientEngLaunchInfo(responseBody.launch);
    }
    if ('warnings' in responseBody) {
      responseBody.warnings = toClientLaunchWarnings(responseBody.warnings, segmentFailures);
    }
    // Свои предупреждения дописываем ПОСЛЕ проекции: это готовые английские
    // константы этого файла, прогонять их через фильтр чужого сырья незачем.
    if (scheduleWarnings.length > 0) {
      const existing = Array.isArray(responseBody.warnings) ? (responseBody.warnings as string[]) : [];
      responseBody.warnings = [...existing, ...scheduleWarnings];
    }

    // ── Отправка: старт кампаний запуска (S2, решение владельца 10–11.10.2026) ──
    //
    // Ядро создаёт кампании на паузе и само их не стартует (его зовёт и RU
    // staff-инструмент) — стартует ЭТОТ модуль, только на успешном запуске (200)
    // и только кампании записи о запуске (законченной или достроенной этим
    // вызовом — достройка стартует то, что достроила). Не стартует, если ответ
    // несёт предупреждение, которое обещает клиенту «не стартовано»:
    //  - WARNING_NEEDS_ATTENTION (внутренний след в предупреждении ядра, в том
    //    числе несохранённая запись о запуске) — 'launch_problem';
    //  - окно отправки не доехало до всех кампаний (WARNING_SCHEDULE_NOT_APPLIED,
    //    scheduleAppliedPartlyWarning) — 'window_not_applied': кампании ушли бы
    //    на чужих часах;
    // и если вызывающий не просил старт (`startSending`) — 'not_requested':
    // старый бандл кнопки обещал кампании на паузе.
    // Без пропуска — проверка вызывающего (onStartDecided, см. шапку): её
    // отказ — 'refused' с её кодом, старт не начат.
    // Остальные проверки — внутри startHeEngLaunchSending (запись в БД содержит
    // все кампании ответа — иначе итоговая запись не сохранилась; гейт писем;
    // выключатель; пауза клиента; ящики пула и адреса живой кампании; статус).
    // Шаблоны, отказанные гейтом подстановок или классификатором сегментов, сюда
    // не доходят: это не 200. 409 «уже запущено» ничего не стартует — для не
    // стартованных кампаний запуска кабинета есть «Start sending»
    // (api/client/eng/templates/[id]/sending); запуск, созданный до выдачи
    // проекту ящиков пула, кабинет не стартует вовсе (сводка 'pre_self_serve').
    let sendingStarted = 0;
    let sendingNotStarted = 0;
    let sendingSkipReason: 'launch_problem' | 'window_not_applied' | 'not_requested' | null = null;
    let sendingVerdict: HeEngLaunchSendingVerdict = {
      kind: 'not_started',
      reason: 'launch_problem',
      code: null,
      retryable: false,
    };
    if (outcome.status === 200) {
      const record = parseLaunchInfo(outcome.body.launch);
      const recordCampaigns = record ? heEngLaunchCampaigns(record) : [];
      const withLeads = recordCampaigns.filter((c) => c.leads > 0).length;
      const warningsNow = Array.isArray(responseBody.warnings) ? (responseBody.warnings as string[]) : [];
      const skipReason: 'launch_problem' | 'window_not_applied' | 'not_requested' | null =
        !record || warningsNow.includes(WARNING_NEEDS_ATTENTION)
          ? 'launch_problem'
          : scheduleWarnings.some((w) => w !== WARNING_SCHEDULE_NOT_SAVED)
            ? 'window_not_applied'
            : !startRequested
              ? 'not_requested'
              : null;
      const nothingStarted = {
        campaigns: withLeads,
        started: 0,
        already_sending: 0,
        completed: 0,
        failed: [] as HeEngStartErrorCode[],
        not_attempted: 0,
        unconfirmed: 0,
        paused_found: 0,
        compensated: 0,
        compensation_failed: 0,
      };
      // Старт решён — последняя проверка вызывающего (onStartDecided): бан
      // аккаунта посреди запуска, запись решения в строку автозапуска.
      const gate = skipReason
        ? null
        : await runStartGate(input.onStartDecided, { userId, templateId: id, trigger });
      if (skipReason) {
        responseBody.sending = { outcome: 'skipped', skip_reason: skipReason, ...nothingStarted };
        sendingNotStarted = withLeads;
        sendingSkipReason = skipReason;
        sendingVerdict = { kind: 'not_started', reason: skipReason, code: null, retryable: false };
      } else if (gate && !gate.ok) {
        responseBody.sending = {
          outcome: 'refused',
          refusal: { code: gate.code, message: gate.message },
          ...nothingStarted,
        };
        sendingNotStarted = withLeads;
        sendingVerdict = { kind: 'not_started', reason: 'refused', code: gate.code, retryable: gate.retryable };
      } else {
        const started = await startHeEngLaunchSending({
          portalDb,
          instantlyDb,
          clientUserId: userId,
          projectId,
          templateId: id,
          via: 'launch',
          expectedCampaignIds: recordCampaigns.map((c) => c.campaignId),
          deadlineMs: input.requestStartedAt + SENDING_DEADLINE_MS,
        });
        sendingVerdict = sendingVerdictOf(started);
        if (started.kind === 'refused') {
          // Записи в БД нет, она не совпала с ответом ядра или осталась в
          // аренде — итоговая запись не сохранилась (её предупреждение уже в
          // ответе).
          const launchProblem =
            started.code === 'record_mismatch' || started.code === 'launch_running' || started.code === 'not_launched';
          responseBody.sending = launchProblem
            ? { outcome: 'skipped', skip_reason: 'launch_problem', ...nothingStarted }
            : { outcome: 'refused', refusal: { code: started.code, message: started.message }, ...nothingStarted };
          sendingNotStarted = withLeads;
          if (launchProblem) sendingSkipReason = 'launch_problem';
        } else if (started.clientPaused) {
          // Пауза клиента — или кампания записи на паузе у рассыльщика
          // (`paused_found`, шаг 6b startHeEngLaunchSending): не стартовано ничего.
          responseBody.sending = { outcome: 'client_paused', ...nothingStarted, paused_found: started.pausedFound };
          sendingNotStarted = withLeads;
        } else {
          responseBody.sending = {
            outcome: 'done',
            campaigns: started.campaigns,
            started: started.started,
            already_sending: started.alreadySending,
            completed: started.completed,
            failed: started.failed.map((f) => f.code),
            not_attempted: started.notAttempted,
            unconfirmed: started.unconfirmed,
            paused_found: 0,
            compensated: started.compensated,
            compensation_failed: started.compensationFailed,
          };
          sendingStarted = started.started - started.compensated;
          sendingNotStarted = started.failed.length + started.notAttempted;
        }
      }
    }

    // Свежая сводка отправки этого запуска (как в ответе POST .../sending): по
    // ней фраза итога запуска называет кнопку, которая теперь на карточке
    // (engText.engLaunchSendingText → engStartButtonOf). Из кэша, без живого
    // чтения; не бросает (пусто — фраза выбирает кнопку по итогу).
    if (outcome.status === 200 && 'sending' in responseBody) {
      const record = parseLaunchInfo(outcome.body.launch);
      if (record) {
        const summaries = await readHeEngSendingSummaries(portalDb, instantlyDb, {
          userId,
          launches: [{ projectId, templateId: id, launch: record }],
          refresh: false,
        });
        responseBody.sending_summary = summaries.get(id) ?? null;
      }
    }

    // ── Ежедневный добор: конфиг после первого успешного запуска (S2) ──
    // Любой 200 с записью о запуске, стартовала отправка или нет: ночь всё
    // равно проверяет, берут ли кампании контакты, и без этого ничего не
    // покупает (autoPipeline.ts, «КАМПАНИИ ЗАПУСКА ОТПРАВЛЯЮТ?»). Строка одна на
    // проект; уже заведённую — в том числе выключенную клиентом — вызов не
    // трогает. Не бросает; сбой пишется строкой warn, а включить добор клиент
    // может переключателем «Daily top-up» дашборда.
    if (outcome.status === 200 && parseLaunchInfo(outcome.body.launch)) {
      await ensureHeUsRefillConfig(portalDb, projectId);
    }

    // Команде — ИНФОРМАЦИЯ, что шаблон запущен из кабинета (кнопкой клиента
    // или автозапуском — `trigger`) и сколько кампаний начали отправку (делать
    // ничего не нужно, кроме 'launch_problem': тогда — проверить кампании
    // запуска у рассыльщика). Только успешный запуск (200, запись о запуске в
    // ответе ядра) — и законченный, и незаконченный. Не ждём (`void`): ответ
    // от Telegram не зависит, notifyHeClientLaunch не бросает; дедупликация и
    // свёртка — в opsAlert.ts.
    let summary: HeEngLaunchSummary;
    if (outcome.status === 200) {
      const record = parseLaunchInfo(outcome.body.launch);
      if (record) {
        void notifyHeClientLaunch({
          projectId,
          market: projectMarket(owned.project as { market?: string | null }),
          templateId: id,
          verticalId: typeof owned.template.vertical_id === 'string' ? owned.template.vertical_id : null,
          // Все кампании записи; у записи без списка (до сплита) — основная.
          campaignIds: (record.campaigns?.length ? record.campaigns.map((c) => c.campaign_id) : [record.campaign_id])
            .filter((cid) => cid.length > 0),
          leads: record.leads_count,
          unfinished: heLaunchIsIncomplete(record),
          forced: false,
          sending: { started: sendingStarted, notStarted: sendingNotStarted, skipReason: sendingSkipReason },
          trigger,
        });
      }
      summary = { kind: 'launched', complete: !heLaunchIsIncomplete(record), sending: sendingVerdict };
    } else if (alreadyLaunched) {
      summary = { kind: 'already_launched' };
    } else if (outcome.status >= 500) {
      // 5xx ядра без текста (ветка 5xx выше его не взяла): оплачено ли, не
      // известно — считаем платным, как бросок ядра.
      summary = { kind: 'failed', status: outcome.status, code: null, paid: true };
    } else {
      // 4xx ядра: код из словаря ядра (защиты аудитории, предполёт us), иначе
      // конфликт по самому шаблону (идёт запуск / шаблон не готов), иначе null.
      const conflict = heLaunchConflictOf(outcome);
      summary = {
        kind: 'refused',
        status: outcome.status,
        code:
          heLaunchOutcomeCode(outcome) ??
          (conflict === 'in_progress' ? 'launch_running' : conflict === 'not_ready' ? 'template_not_ready' : null),
        retryAfterSeconds: null,
      };
    }

    return { status: outcome.status, body: responseBody, summary };
  } catch (e) {
    // Бросок ядра (или любого шага, который обещает не бросать): клиенту —
    // константа, сырьё — в application_logs. Попадание лимита неудачных
    // запусков, взятое до ядра, остаётся (finally выше его не вернул) — как
    // было, когда исключение уходило из роута.
    await logError('client.eng.template.launch_failed', e, {
      userId,
      templateId: id,
      status: 500,
      thrown: true,
      trigger,
    });
    return {
      status: 500,
      body: { error: LAUNCH_FAILED },
      summary: { kind: 'failed', status: 500, code: null, paid: inCore },
    };
  }
}

/* ─────────────── Повтор старта ─────────────── */

/**
 * Повтор ТОЛЬКО старта кампаний уже законченного запуска (автозапуск, код
 * 'start_retry': ядро прошло, старт временно не удался). Те же гейты в том же
 * порядке, что у runHeEngTemplateLaunch, минус ядро: гейт платных шагов →
 * выключатель отправки (via 'launch') → ящики пула и пресет
 * (ensureHeEngPresetForProject заново делает проверку «ящик не занят
 * другим») → startHeEngLaunchSending via 'launch' по кампаниям записи о
 * запуске. via 'launch' СТРОЖЕ кнопки «Start sending»: паузу клиента не
 * снимает и кампанию на паузе у рассыльщика (2) не стартует. Прямо перед
 * стартом — `onStartDecided` (как у runHeEngTemplateLaunch).
 *
 * Отказ гейта до старта — 'not_started' с кодом гейта (`reason: 'refused'`).
 * НЕ БРОСАЕТ.
 */
export async function retryHeEngLaunchStart(
  input: Omit<HeEngTemplateLaunchInput, 'sendingWindow' | 'startSending'>,
): Promise<HeEngLaunchSendingVerdict> {
  const { portalDb, instantlyDb, userId, templateId, owned, trigger } = input;
  const projectId = String(owned.project.id);
  const ctx = { userId, projectId, templateId, trigger };
  try {
    const access = await requireEngPaidAccess(portalDb, userId, { action: 'launch' });
    if (!access.ok) {
      return {
        kind: 'not_started',
        reason: 'refused',
        code: access.refusal.code,
        retryable: access.refusal.code === 'unavailable',
      };
    }
    const sendingAccess = await requireHeEngSendingAccess(portalDb, userId, { projectId, via: 'launch' });
    if (!sendingAccess.ok) {
      return {
        kind: 'not_started',
        reason: 'refused',
        code: sendingAccess.code,
        retryable: sendingAccess.code === 'sending_access_unavailable',
      };
    }
    const preset = await ensureHeEngPresetForProject(projectId, userId, { portalDb, instantlyDb });
    if (preset.kind !== 'ready') {
      return {
        kind: 'not_started',
        reason: 'refused',
        code: preset.code,
        retryable: preset.kind === 'shortage' || preset.code !== 'sending_not_available',
      };
    }
    // Кампании записи о запуске — только скаляры и список кампаний: долг
    // незаконченного запуска (pending с адресами) сюда не нужен — повтор
    // старта бывает только у законченного.
    const { data: row, error } = await portalDb
      .from('he_templates')
      .select('id, launch_info')
      .eq('id', templateId)
      .maybeSingle();
    if (error) {
      void logWarn('client.eng.template.launch.start_retry_read_failed', `launch record not read: ${error.message}`, ctx);
      return { kind: 'not_started', reason: 'refused', code: 'sending_read_failed', retryable: true };
    }
    const record = parseLaunchInfo((row as { launch_info?: unknown } | null)?.launch_info);
    if (!record) return { kind: 'not_started', reason: 'launch_problem', code: 'not_launched', retryable: false };
    const gate = await runStartGate(input.onStartDecided, ctx);
    if (!gate.ok) return { kind: 'not_started', reason: 'refused', code: gate.code, retryable: gate.retryable };
    const started = await startHeEngLaunchSending({
      portalDb,
      instantlyDb,
      clientUserId: userId,
      projectId,
      templateId,
      via: 'launch',
      expectedCampaignIds: heEngLaunchCampaigns(record).map((c) => c.campaignId),
      deadlineMs: input.requestStartedAt + SENDING_DEADLINE_MS,
    });
    const verdict = sendingVerdictOf(started);
    void logAudit('client.eng.template.launch.start_retried', 'ENG launch campaigns start retried', {
      ...ctx,
      verdict: verdict.kind,
      ...(verdict.kind === 'started'
        ? { started: verdict.started, alreadySending: verdict.alreadySending }
        : { reason: verdict.reason, code: verdict.code }),
    });
    return verdict;
  } catch (e) {
    await logError('client.eng.template.launch.start_retry_failed', e, ctx);
    return { kind: 'not_started', reason: 'failed', code: null, retryable: true };
  }
}
