import 'server-only';

/**
 * Письма ENG-клиенту в ключевые моменты self-serve пути — ОДИН раз на событие.
 *
 * ЗАЧЕМ. После круга S3 клиент жмёт одну кнопку «Launch» и уходит: письма,
 * сбор базы, итоговые письма и запуск идут сами, часами. Экран обещает «We'll
 * email you when your markets are ready» и «We'll email you when sending starts
 * or if something needs you» — этот модуль и есть то обещание.
 *
 * ДВА ВХОДА, оба НЕ БРОСАЮТ:
 *  - sendHeEngClientNotice — событие, о котором знает вызывающий: тик
 *    автозапуска воркера (engAutoLaunch.ts) — sending_started, sending_waiting
 *    и action_needed с кодами letters_need_rewrite / start_failed /
 *    needs_support. Ручные кнопки кабинета писем не шлют: клиент и так на
 *    экране;
 *  - runHeEngClientMailScan — проход того же тика раз в минуту (НЕ зависит от
 *    выключателя HE_ENG_AUTO_LAUNCH): события, которые видны только по данным,
 *    плюс повтор неотправленных:
 *      · research_ready; research_stopped — исследование упало ('failed') или
 *        встало ('researching', ни одна стадия не шла дольше окна шага 1);
 *      · у проектов с включённым автозапуском (нажат «Launch»):
 *        collect_stopped, autopilot_hold (паузы из MAILED_HOLD_CODES; пауза
 *        'retrying' — только продержавшаяся RETRYING_PERSIST_MS) и остановки
 *        платных стадий рынка — letters_stopped (цепочка писем),
 *        check_stopped (проверка контактов, base_analyze), final_letters_stopped
 *        (первые итоговые письма базы), rewrite_stopped (итоговые письма
 *        «Rewrite letters»). Об остановках стадий и о продержавшейся паузе
 *        'retrying' вместе с письмом уходит алерт команде (opsAlert,
 *        вид 'stage_stopped', отдельным сообщением на событие) — решение
 *        владельца по умолчанию: о такой остановке узнают и клиент, и команда.
 *
 * СЛЕДУЮЩИЙ ШАГ ПИСЬМА (next_step) решается по данным в момент заявки и
 * называет только то, что правда двигает остановку (каждое правило — у
 * своего места ниже): «Launch» на шаге 3 — где путь «Launch»
 * (reconcileHeAutopilotProject, trigger 'client') ставит эту стадию заново;
 * «Rewrite letters» — у упавшей перезаписи, пока бюджет писем поколения
 * анализа не исчерпан; «Try again» на шаге 1 — где роут исследования повтор
 * примет (engResearchRetryVerdict); иначе — Support. Если кнопка есть, но
 * остановил отказ, который чинит только команда (деньги или ключ провайдера:
 * clientErrors.heTeamFixableFailureOf у стадий, код проекта 'billing' /
 * 'configuration' у research), — 'team_fix': сначала Support («узнать, когда
 * починят»), потом та же кнопка. Так же говорит кабинет (clientFailureText,
 * TEAM_FIX_WHAT_TO_DO и шаг 1): нажатие до починки упрётся в тот же отказ.
 * Если кнопка есть, но стадию писем остановил бесплатный отказ за наш бренд в
 * поле брифа (пометка воркера в payload джобы,
 * letterBrandGuard.heJobUnpaidBrandInput), — 'edit_brief': письмо называет
 * поле шага 1 и слово (из той же пометки) и только потом кнопку остановки:
 * нажатие без правки поля упрётся в тот же отказ (путь «Launch» и роут
 * «Rewrite letters» проверяют поле до постановки).
 *
 * ДЕДУП (he_eng_client_emails, миграция 20261012_0002). Сначала заявка —
 * insert … on conflict (dedupe_key) do nothing; письмо шлёт только тот, чья
 * вставка прошла (и только он зовёт алерт команде). Удача — sent_at; неудача —
 * строка остаётся, проход повторяет её не раньше чем через 10 минут после
 * прошлой попытки, всего не больше 3 попыток (attempts считает попытки, повтор
 * берёт строку условным UPDATE по attempts — два процесса одну строку не
 * отправят). Текст ошибки SMTP — в лог, не в колонку. Таблицы нет — не шлём
 * НИЧЕГО (без дедупа одно событие стало бы письмом в минуту), алертов
 * 'stage_stopped' тоже нет, и один раз предупреждаем в лог.
 *
 * ПАУЗА АВТОПИЛОТА — ОДНО ПИСЬМО НА ЭПИЗОД, а не на метку паузы: метку
 * (autopilot_error_at) переписывает каждый проход реконсилера, то есть каждое
 * «Launch», и ключ по ней слал письмо о той же стоящей паузе после каждого
 * нажатия. Ключ — action:autopilot_hold:<проект>:<код паузы>:<номер эпизода>,
 * номер — 1 + число закрытых эпизодов этого кода у проекта. Эпизод открыт,
 * пока проект стоит на паузе с этим кодом; closeClearedHolds закрывает его
 * (closed_at), когда видит паузу снятой или с другим кодом. Пока эпизод открыт,
 * письма о том же коде нет; снялась или сменила код и вернулась — новое письмо.
 * Не увиденное проходом снятие (пауза снялась и вернулась между двумя
 * проходами) — тот же эпизод, письма нет: ошибка в сторону тишины.
 *
 * ПОЛУЧАТЕЛЬ — только владелец проекта (he_projects.created_by): профиль с
 * role='client', market='eng', не is_demo и с адресом. Проект — market='us'.
 * Всё остальное — 'not_eng' / 'no_email', и заявка не создаётся.
 *
 * ЗАБЛОКИРОВАННЫЙ ПОЛУЧАТЕЛЬ (решение владельца 12.10.2026: блокировка
 * останавливает всё, письма клиенту тоже) — 'blocked': ни заявки, ни SMTP.
 * Признаков два, хватает любого: активная отметка блокировки
 * (he_eng_account_blocks — пакетом вместе с профилями, readRecipients) и живой
 * бан Supabase (auth.users.banned_until в будущем — читается перед самой
 * заявкой, loadNoticeContext: бан, поставленный мимо раздела «Английские
 * клиенты», отметки не пишет). Повтор неотправленных закрывает строку такого
 * получателя без отправки (attempts = 3, лог retry_dropped). Сбой любого из
 * этих чтений — письма в этом проходе нет и попытка не тратится; таблицы
 * отметок нет (миграция 20261013_0001) — решает только бан.
 *
 * ВЫКЛЮЧЕННАЯ ОТПРАВКА. Выключатель отправки аккаунта 'revoked' (сотрудник
 * выключил; так и после разблокировки, пока сотрудник не включит снова) —
 * письма идут, но «Launch», «Launch now», «Rewrite letters», «Collect again»
 * и «Start sending» откажут 403 sending_turned_off. Поэтому каждая попытка
 * (и первая, и повтор) перед отправкой читает выключатель
 * (readHeEngSendingAccess, loadNoticeContext), и при 'revoked' текст вместо
 * такой кнопки говорит «Sending is turned off for your account. Message
 * Support» (engClientNotice, sendingOff) — как кабинет в том же состоянии.
 * next_step (решение заявки) не меняется: включат отправку до повтора —
 * повтор назовёт кнопку. «Try again» исследования, «Pause» и выбор рынков
 * выключатель не спрашивают и называются как прежде. Сбой чтения — 'failed',
 * как у остальных чтений контекста письма: заявки нет, попытка не тратится.
 *
 * ОКНО СОБЫТИЯ — 6 часов. Проход смотрит только на свежие факты (кластеризация
 * закончилась, research упал или встал, база или стадия встали, пауза записана
 * в последние 6 часов), поэтому первый запуск кода не разошлёт письма о давних
 * событиях, а простой воркера дольше окна событие пропустит (экран кабинета
 * его покажет всё равно). Факты базы, стадий, паузы и вставшего research ещё и
 * «отстаиваются» 15 минут (пауза 'retrying' — час): остановку, которую сразу
 * поднял повтор или сам клиент, пока был на экране, клиенту не пишем.
 *
 * ОБЪЁМ И ПОЛНОТА. Намерения проход читает страницами по INTENT_PAGE в порядке
 * project_id с курсором, который идёт по кругу (intentCursor): за круг —
 * каждое включённое намерение, сколько бы их ни было, и ни одно не стоит в
 * очереди за старыми (намерения сами не гаснут: «Launch» нажат — строка
 * wanted навсегда, пока клиент не отменит). Страница, у которой кончился
 * бюджет отправок, читается снова следующим проходом. Круг дольше одного
 * прохода — строка лога (не чаще BUDGET_LOG_EVERY_MS), круг дольше окна
 * события за вычетом отстоя — своё событие лога: события могли выпасть из окна.
 * Чтения со многими строками на id (джобы, базы, вертикали, гипотезы, цепочки,
 * шаблоны, эпизоды) идут кусками по MANY_CHUNK id с limit READ_LIMIT (не
 * больше 1000: столько PostgREST отдаёт за раз и сам режет молча). Кусок,
 * упёршийся в limit, — не «всё прочитано»: события ЕГО проектов (или рынков)
 * в этом проходе не пишутся (лог), а не уходят по неполному срезу (иначе
 * «ничего не идёт» при обрезанном списке живых джоб); остальные куски — как
 * обычно. Доливные базы отсекаются в самом запросе (NOT_REFILL_BASE_OR): их
 * по одной на рынок за ночь, и без этого чтения баз упирались бы в limit.
 * Исследование — по 500 проектов на запрос, упор — тоже в лог. Чтения стадий
 * — только когда в окне есть упавшая джоба стадии и только по рынкам и базам
 * ещё не заявленных упавших джоб; бюджет писем (heTemplateGenerationBudget) —
 * только для ещё не заявленных событий; не больше SCAN_SEND_CAP отправок за
 * проход.
 *
 * ССЫЛКИ — всегда на ENG-хост из окружения (heEngAppOrigin), не на Host
 * запроса; шаги мастера — ?step=1|2|3.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderEngClientNoticeEmail } from '@/lib/email/templates/engClientNotice';
import { logWarn } from '@/lib/loggerServer';
import { heTemplateGenerationBudget } from './autopilotNext';
import { heEngAccountBlockOf, readHeEngAccountBlocks } from './engAccountBlockMarker';
import {
  toClientEngAutopilotHold,
  toClientEngBase,
  toClientEngStageErrorCode,
  type ClientEngAutopilotHold,
} from './clientEngProjection';
import { heTeamFixableFailureOf } from './clientErrors';
import { HE_RESEARCH_NEEDS_DESCRIPTION_CODE } from '@/components/client-eng/clientFailureText';
import { heBrandInputFieldLabelEn, heJobUnpaidBrandInput, type HeBrandInputLeak } from './letterBrandGuard';
import { engAnalysisRequeues } from './engDashboard';
import { heEngAppOrigin, HE_ENG_VERIFY_FROM_NAME } from './engEmailVerificationMail';
import { readHeEngSendingAccess } from './engSendingAccess';
import { notifyHeClientStop, type HeOpsStageStopStage, type HeOpsStop } from './opsAlert';
import { engResearchRetryVerdict, HE_RESEARCH_STAGES, HE_RESEARCH_STALL_GRACE_MS } from './researchJob';
import { normalizeWebsiteInput } from './websiteUrl';

export const HE_ENG_CLIENT_EMAILS_TABLE = 'he_eng_client_emails';

export const HE_ENG_CLIENT_NOTICE_KINDS = [
  'research_ready',
  'research_stopped',
  'sending_waiting',
  'sending_started',
  'action_needed',
] as const;

export type HeEngClientNoticeKind = (typeof HE_ENG_CLIENT_NOTICE_KINDS)[number];

export const HE_ENG_CLIENT_ACTION_CODES = [
  'letters_need_rewrite',
  'start_failed',
  'needs_support',
  'collect_stopped',
  'autopilot_hold',
  'letters_stopped',
  'final_letters_stopped',
  'check_stopped',
  'rewrite_stopped',
] as const;

export type HeEngClientActionCode = (typeof HE_ENG_CLIENT_ACTION_CODES)[number];

/**
 * Следующий шаг, который называет письмо (колонка next_step; шапка модуля).
 * 'team_fix' — отказ, который чинит команда: Support, потом кнопка остановки
 * (у research — «Try again», у rewrite_stopped — «Rewrite letters», у
 * остальных стадий — «Launch»). 'edit_brief' — стадию писем остановил
 * бесплатный отказ за наш бренд в поле брифа: поправить поле шага 1, потом
 * кнопка остановки (шапка модуля).
 */
export const HE_ENG_CLIENT_NEXT_STEPS = ['launch', 'rewrite', 'try_again', 'support', 'team_fix', 'edit_brief'] as const;

export type HeEngClientNextStep = (typeof HE_ENG_CLIENT_NEXT_STEPS)[number];

/** Коды остановок платных стадий рынка: ключ — по id упавшей джобы (refId). */
const STAGE_STOP_CODES = ['letters_stopped', 'final_letters_stopped', 'check_stopped', 'rewrite_stopped'] as const;

type HeEngStageStopCode = (typeof STAGE_STOP_CODES)[number];

export interface HeEngClientNotice {
  kind: HeEngClientNoticeKind;
  projectId: string;
  /** Шаблон (рынок) события: обязателен для sending_started, letters_need_rewrite, start_failed. */
  templateId?: string | null;
  /** Только у action_needed — и там обязателен. */
  code?: HeEngClientActionCode | null;
  /**
   * Второй ориентир события: id последней research-джобы (research_stopped),
   * id базы (collect_stopped), код паузы кабинета (autopilot_hold), id
   * упавшей джобы (остановки стадий), класс итога автозапуска (needs_support).
   * У autopilot_hold и needs_support письмо читает его и как причину
   * (текст паузы, «не стартовало — сначала Support»).
   */
  refId?: string | null;
  /** Только autopilot_hold: номер эпизода паузы этого кода у проекта (шапка, «ПАУЗА АВТОПИЛОТА»). */
  episode?: number | null;
  /**
   * Только needs_support: requested_at намерения (нажатие «Launch»), при
   * котором автозапуск сдался. У классов, которые поднимает новое нажатие
   * ('failed', 'refused'), входит в ключ (heEngClientNoticeKey).
   */
  launchRequestedAt?: string | null;
  /** Какой следующий шаг называет письмо; в ключ события не входит. */
  next?: HeEngClientNextStep | null;
}

/** 'blocked' — получатель заблокирован (шапка, «ЗАБЛОКИРОВАННЫЙ ПОЛУЧАТЕЛЬ»): ни заявки, ни SMTP. */
export type HeEngClientNoticeResult =
  | 'sent'
  | 'duplicate'
  | 'not_eng'
  | 'no_email'
  | 'blocked'
  | 'unavailable'
  | 'failed';

type Row = Record<string, unknown>;

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60_000;
const EVENT_WINDOW_MS = 6 * 60 * 60_000;
/** Сколько «отстаивается» остановка базы, стадии, research или пауза автопилота до письма. */
const SETTLE_MS = 15 * 60_000;
/**
 * Сколько должна продержаться пауза 'retrying' (read_failed / enqueue_failed),
 * прежде чем о ней письмо и алерт. Сама она НЕ снимается: ночной проход
 * (HE_AUTOPILOT_RECONCILE) по умолчанию выключен, а дочейн воркера после
 * упавшей постановки не повторяется. Снимают её только новое «Launch»
 * (реконсилер переписывает причину; клиент, получивший на экране 500 «Failed
 * to launch», обычно жмёт снова за минуты) и прогресс следующей done-джобы
 * проекта, у которого выбран один рынок (followupMayClearPause), — если у
 * этого рынка ещё шла стадия, она кончается в пределах своего прогона. Час
 * покрывает оба случая; дольше ждать — только дольше молчать о рынке, который
 * сам не пойдёт.
 */
const RETRYING_PERSIST_MS = 60 * 60_000;
/** Не больше стольких отправок за один проход: тик воркера стоит между джобами. */
const SCAN_SEND_CAP = 5;
/** Проектов на запрос исследования (свежие первыми; упор — в лог). */
const RESEARCH_PAGE = 500;
/** Намерений на проход (страница кругового курсора, шапка — «ОБЪЁМ И ПОЛНОТА»). */
const INTENT_PAGE = 200;
/** Открытых эпизодов паузы на проход closeClearedHolds (тоже по кругу). */
const HOLD_PAGE = 200;

/**
 * Коды паузы автопилота (кабинетный словарь toClientEngAutopilotHold), о
 * которых пишем сразу после отстоя. 'retrying' — отдельно: только
 * продержавшаяся RETRYING_PERSIST_MS, с советом «Launch» и алертом команде.
 * 'stage_stopped' НЕ пишем: каждую его причину (pauseForHeAutopilotSkip —
 * base_failed / collect_failed_before, chain_failed_before,
 * analysis_failed_before) уже пишет своё письмо этого прохода —
 * collect_stopped, letters_stopped, check_stopped — с проверенным советом
 * (у отказа, который чинит команда, — Support прежде кнопки). Второе письмо о
 * той же остановке звало бы к «Launch» без этой проверки.
 */
const MAILED_HOLD_CODES = new Set(['letters_exhausted', 'target_missing', 'spend_paused']);

/** Стадии рынка, окончательную остановку которых проход пишет клиенту. */
const STAGE_STOP_STAGES = ['chain', 'base_analyze', 'template'];

/**
 * Таблица намерения запуска. Владелец имени — engAutoLaunch.ts
 * (HE_ENG_LAUNCH_INTENT_TABLE); здесь повторено, а не импортировано:
 * engAutoLaunch зовёт проход этого модуля, и обратный импорт замкнул бы цикл.
 */
const LAUNCH_INTENT_TABLE = 'he_eng_launch_intent';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Длина списка в одном `in (...)`: id идут в URL запроса PostgREST. */
const ID_CHUNK = 100;
/** Ключи дедупа длиннее uuid — их кусок короче. */
const KEY_CHUNK = 30;
/**
 * Чтения, где на один id приходится много строк (джобы и базы проекта,
 * вертикали, гипотезы, цепочки и шаблоны рынка, эпизоды пауз): куски по
 * MANY_CHUNK id, limit READ_LIMIT (шапка, «ОБЪЁМ И ПОЛНОТА»).
 */
const MANY_CHUNK = 20;
const READ_LIMIT = 1000;

/**
 * «Не доливная база» в запросе — то же правило, что isRefillBase (и проекция
 * кабинета): доливная — collect_info.refill = true ИЛИ имя «auto-refill…».
 * Пустые значения (ключа refill нет, filename null) — не доливная. Одним
 * or(): (refill нет ∨ refill ≠ true) ∧ (имени нет ∨ не «auto-refill…»),
 * раскрыто в четыре and(). После чтения isRefillBase проверяет ещё раз.
 */
const NOT_REFILL_BASE_OR = [
  'and(collect_info->>refill.is.null,filename.is.null)',
  'and(collect_info->>refill.is.null,filename.not.like.auto-refill%)',
  'and(collect_info->>refill.neq.true,filename.is.null)',
  'and(collect_info->>refill.neq.true,filename.not.like.auto-refill%)',
].join(',');

type ReadResult = PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;

/** Не чаще раза в столько — строка лога об упоре прохода в свой бюджет (на событие лога, в процессе). */
const BUDGET_LOG_EVERY_MS = 60 * 60_000;
const budgetLoggedAt = new Map<string, number>();

/**
 * Проход упёрся в свой бюджет (страница, limit чтения): строка лога, но не
 * чаще BUDGET_LOG_EVERY_MS на событие — проход идёт раз в минуту, и упор,
 * который держится, иначе писал бы строку каждую минуту.
 */
function logBudgetHit(event: string, message: string, context?: Record<string, unknown>): void {
  const now = Date.now();
  const last = budgetLoggedAt.get(event);
  if (last !== undefined && now - last < BUDGET_LOG_EVERY_MS) return;
  budgetLoggedAt.set(event, now);
  void logWarn(event, message, context);
}

/**
 * Чтение по списку кусками. null — хоть один кусок не прочитался (ошибка — в
 * лог под event): по этому чтению писем в проходе нет. С `limit` (каждый
 * запрос обязан вызываться с `.limit(limit)`) кусок, вернувший столько строк,
 * сколько limit, мог быть обрезан: его строк в `rows` нет, а его id — в `cut`,
 * и вызывающий не пишет событий по ним в этом проходе («ничего не идёт» по
 * обрезанному списку живых джоб дало бы письмо об остановке того, что идёт);
 * упор — в лог (logBudgetHit). Остальные куски прочитаны целиком.
 */
interface InRead {
  rows: Row[];
  cut: Set<string>;
}

async function readIn(
  ids: string[],
  chunk: number,
  event: string,
  read: (part: string[]) => ReadResult,
  limit?: number,
): Promise<InRead | null> {
  const rows: Row[] = [];
  const cut = new Set<string>();
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const { data, error } = await read(part);
    if (error) {
      void logWarn(event, errText(error));
      return null;
    }
    const got = (data ?? []) as Row[];
    if (limit !== undefined && got.length >= limit) {
      for (const id of part) cut.add(id);
      logBudgetHit(
        `${event}.limit`,
        `read returned ${got.length} rows, its limit: the slice may be cut — no email about these ${part.length} ids this pass`,
        { ids: part.length },
      );
      continue;
    }
    rows.push(...got);
  }
  return { rows, cut };
}

function ms(v: unknown): number {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? 0 : t;
}

/** Нет таблицы: 42P01 от Postgres, PGRST205 от PostgREST (нет в кэше схемы). */
function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

function errText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.slice(0, 200) : String(error).slice(0, 200);
}

let missingTableWarned = false;
function warnMissingTableOnce(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  void logWarn(
    'he.eng_client_mail.table_missing',
    `${HE_ENG_CLIENT_EMAILS_TABLE} is missing (migration 20261012_0002 not applied): client emails are off`,
  );
}

function isNoticeKind(v: unknown): v is HeEngClientNoticeKind {
  return HE_ENG_CLIENT_NOTICE_KINDS.some((k) => k === v);
}

function isActionCode(v: unknown): v is HeEngClientActionCode {
  return HE_ENG_CLIENT_ACTION_CODES.some((c) => c === v);
}

function isNextStep(v: unknown): v is HeEngClientNextStep {
  return HE_ENG_CLIENT_NEXT_STEPS.some((s) => s === v);
}

function isStageStopCode(v: unknown): v is HeEngStageStopCode {
  return STAGE_STOP_CODES.some((c) => c === v);
}

/**
 * Ключ события; null — у уведомления не та форма (нет обязательного поля).
 * Один ключ — одно письмо навсегда: повторное событие того же вида по тому же
 * объекту письма не даёт.
 */
export function heEngClientNoticeKey(notice: HeEngClientNotice): string | null {
  const project = notice.projectId?.trim();
  if (!project) return null;
  const template = notice.templateId?.trim() || null;
  const ref = notice.refId?.trim() || null;
  switch (notice.kind) {
    case 'research_ready':
      return `research_ready:${project}`;
    case 'research_stopped':
      return ref ? `research_stopped:${project}:${ref}` : null;
    case 'sending_waiting':
      return `sending_waiting:${project}`;
    case 'sending_started':
      return template ? `sending_started:${template}` : null;
    case 'action_needed':
      switch (notice.code) {
        case 'letters_need_rewrite':
        case 'start_failed':
          return template ? `action:${notice.code}:${template}` : null;
        case 'needs_support': {
          // refId — причина, которую тик автозапуска различает сам ('spend_limit',
          // 'sending_turned_off'); без неё — общий «не получилось». Разные
          // причины одного рынка — разные события: письмо о потолке расхода не
          // должно глушить позднее «запуск сдался».
          // У 'failed' и 'refused' в ключе ещё и нажатие «Launch»: строку
          // 'failed' новое нажатие возвращает в 'waiting', у 'held' ставит срок
          // «сейчас» — и второе «сдался» после нового нажатия должно дать
          // письмо, а не «дубликат» первого.
          const press = ref === 'failed' || ref === 'refused' ? pressStampOf(notice.launchRequestedAt) : null;
          return `action:needs_support:${template ?? project}${ref ? `:${ref}` : ''}${press ? `:${press}` : ''}`;
        }
        case 'collect_stopped':
          return ref ? `action:collect_stopped:${ref}` : null;
        case 'autopilot_hold': {
          // Эпизод, а не метка паузы: метку переписывает каждое «Launch» (шапка).
          const episode = notice.episode;
          return ref && typeof episode === 'number' && Number.isInteger(episode) && episode >= 1
            ? `action:autopilot_hold:${project}:${ref}:${episode}`
            : null;
        }
        case 'letters_stopped':
        case 'final_letters_stopped':
        case 'check_stopped':
        case 'rewrite_stopped':
          // Одна упавшая джоба — одно событие: повтор, упавший снова, — новая
          // джоба и новое письмо.
          return ref ? `action:${notice.code}:${ref}` : null;
        default:
          return null;
      }
    default:
      return null;
  }
}

/** Нажатие «Launch» для ключа письма: миллисекунды requested_at (одна запись — одна строка, как бы её ни отформатировала БД). */
function pressStampOf(requestedAt: string | null | undefined): string | null {
  const t = Date.parse(str(requestedAt));
  return Number.isFinite(t) && t > 0 ? String(t) : null;
}

/* ── Получатель ── */

type RecipientVerdict =
  | { kind: 'ok'; userId: string; email: string }
  | { kind: 'not_eng' }
  | { kind: 'no_email' }
  | { kind: 'blocked' };

function recipientOf(profile: Row | null | undefined): RecipientVerdict {
  if (!profile) return { kind: 'not_eng' };
  if (profile.role !== 'client' || profile.market !== 'eng' || profile.is_demo === true) return { kind: 'not_eng' };
  const email = str(profile.email).trim();
  if (!email) return { kind: 'no_email' };
  return { kind: 'ok', userId: str(profile.id), email };
}

const PROFILE_COLUMNS = 'id, email, role, market, is_demo';

/**
 * Профили владельцев одним чтением и отметки блокировки тех из них, кому
 * письмо вообще ушло бы (активная отметка — 'blocked'). null — не прочиталось
 * одно из двух (письма по этому списку в проходе нет).
 */
async function readRecipients(db: SupabaseClient, userIds: string[]): Promise<Map<string, RecipientVerdict> | null> {
  const out = new Map<string, RecipientVerdict>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const read = await readIn(ids, ID_CHUNK, 'he.eng_client_mail.profiles_read_failed', (part) =>
    db.from('profiles').select(PROFILE_COLUMNS).in('id', part).limit(part.length),
  );
  if (!read) return null;
  const byId = new Map(read.rows.map((p) => [str(p.id), p]));
  for (const id of ids) out.set(id, recipientOf(byId.get(id)));
  const okIds = ids.filter((id) => out.get(id)?.kind === 'ok');
  if (okIds.length > 0) {
    const blocks = await readHeEngAccountBlocks(db, okIds);
    if (blocks.state === 'error') {
      void logWarn('he.eng_client_mail.block_read_failed', blocks.detail, { code: blocks.code });
      return null;
    }
    for (const id of okIds) {
      if (heEngAccountBlockOf(blocks, id).state === 'blocked') out.set(id, { kind: 'blocked' });
    }
  }
  return out;
}

/** Бан Supabase сейчас: 'gone' — пользователя в auth нет (писать некому). */
type LiveBan = { kind: 'banned' | 'clear' | 'gone' } | { kind: 'error'; message: string };

/**
 * Живой бан получателя (auth.users.banned_until в будущем; непарсящийся срок —
 * бан, fail-closed) — то же правило, что engAutoLaunch.readHeEngAccountStanding.
 * НЕ БРОСАЕТ.
 */
async function readLiveBan(db: SupabaseClient, userId: string): Promise<LiveBan> {
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) {
      const authErr = error as { status?: number; code?: string; message?: string };
      if (authErr.status === 404 || authErr.code === 'user_not_found') return { kind: 'gone' };
      return { kind: 'error', message: `auth user read: ${String(authErr.message ?? '').slice(0, 200)}` };
    }
    const user = data?.user ?? null;
    if (!user) return { kind: 'gone' };
    const bannedUntil = typeof user.banned_until === 'string' ? user.banned_until.trim() : '';
    if (!bannedUntil) return { kind: 'clear' };
    const until = Date.parse(bannedUntil);
    return { kind: !Number.isFinite(until) || until > Date.now() ? 'banned' : 'clear' };
  } catch (e) {
    return { kind: 'error', message: `auth user read threw: ${errText(e)}` };
  }
}

/**
 * Память прохода: бан по получателю (одно чтение auth на получателя за
 * проход) и проекты, чей получатель оказался заблокирован (их события в этом
 * проходе больше не готовятся и не читают контекст).
 */
interface RecipientMemo {
  bans: Map<string, 'banned' | 'clear' | 'gone'>;
  blockedProjects: Set<string>;
}

/* ── Контекст письма ── */

interface NoticeContext {
  recipient: { userId: string; email: string };
  website: string | null;
  marketName: string | null;
  /** Выключатель отправки аккаунта — 'revoked' на момент этой попытки (шапка, «ВЫКЛЮЧЕННАЯ ОТПРАВКА»). */
  sendingOff: boolean;
  /**
   * Поля брифа с нашим брендом из пометки бесплатного отказа упавшей джобы
   * стадии (только у остановок стадий; пусто — пометки нет или поля
   * потерялись) — письмо 'edit_brief' их называет.
   */
  brandInputs: HeBrandInputLeak[];
}

type ContextOutcome =
  | { kind: 'ok'; ctx: NoticeContext }
  | { kind: 'not_eng' }
  | { kind: 'no_email' }
  | { kind: 'blocked' }
  | { kind: 'failed'; message: string };

/** Сайт для текста письма: «acme.com», а не «https://acme.com/». */
function websiteLabel(raw: unknown): string | null {
  const url = str(raw).trim();
  if (!url) return null;
  return normalizeWebsiteInput(url)?.hostname ?? url.slice(0, 120);
}

/** Имя вертикали проекта; чужая вертикаль — ошибка скоупа. */
async function readMarketName(
  db: SupabaseClient,
  projectId: string,
  verticalId: string,
): Promise<{ kind: 'ok'; name: string | null } | { kind: 'failed'; message: string }> {
  if (!verticalId) return { kind: 'ok', name: null };
  const { data, error } = await db.from('he_verticals').select('name, project_id').eq('id', verticalId).maybeSingle();
  if (error) return { kind: 'failed', message: `vertical read: ${errText(error)}` };
  if (!data) return { kind: 'ok', name: null };
  const row = data as Row;
  if (str(row.project_id) !== projectId) return { kind: 'failed', message: 'vertical of another project' };
  return { kind: 'ok', name: str(row.name).trim() || null };
}

/** Вертикаль базы проекта; '' — базы нет; чужая база — ошибка скоупа. */
async function readBaseVertical(
  db: SupabaseClient,
  projectId: string,
  baseId: string,
): Promise<{ kind: 'ok'; verticalId: string } | { kind: 'failed'; message: string }> {
  if (!baseId) return { kind: 'ok', verticalId: '' };
  const { data, error } = await db.from('he_bases').select('vertical_id, project_id').eq('id', baseId).maybeSingle();
  if (error) return { kind: 'failed', message: `base read: ${errText(error)}` };
  const base = data as Row | null;
  if (base && str(base.project_id) !== projectId) return { kind: 'failed', message: 'base of another project' };
  return { kind: 'ok', verticalId: str(base?.vertical_id) };
}

/**
 * Вертикаль упавшей джобы стадии: из payload (цепочка) или через её базу; и
 * поля брифа из пометки бесплатного отказа (heJobUnpaidBrandInput) — их
 * называет письмо 'edit_brief'.
 */
async function readJobVertical(
  db: SupabaseClient,
  projectId: string,
  jobId: string,
): Promise<{ kind: 'ok'; verticalId: string; brandInputs: HeBrandInputLeak[] } | { kind: 'failed'; message: string }> {
  const { data, error } = await db
    .from('he_jobs')
    .select('project_id, payload')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return { kind: 'failed', message: `job read: ${errText(error)}` };
  const job = data as Row | null;
  if (!job) return { kind: 'ok', verticalId: '', brandInputs: [] };
  if (str(job.project_id) !== projectId) return { kind: 'failed', message: 'job of another project' };
  const payload = (job.payload ?? null) as Row | null;
  const brandInputs = heJobUnpaidBrandInput(payload) ?? [];
  if (str(payload?.vertical_id)) return { kind: 'ok', verticalId: str(payload?.vertical_id), brandInputs };
  const base = await readBaseVertical(db, projectId, str(payload?.base_id));
  return base.kind === 'ok' ? { ...base, brandInputs } : base;
}

/**
 * Контекст письма прямо перед заявкой: проект, получатель (профиль и отметка
 * блокировки — readRecipients), живой бан получателя (readLiveBan; `memo` —
 * одно чтение на получателя за проход), рынок, выключатель отправки аккаунта
 * (readHeEngSendingAccess; повтор читает его заново). 'blocked' — получатель
 * заблокирован: заявки нет. Любой сбой чтения — 'failed' (письма нет, заявки
 * нет, попытка повтора не тратится).
 */
async function loadNoticeContext(
  db: SupabaseClient,
  notice: HeEngClientNotice,
  memo?: RecipientMemo,
): Promise<ContextOutcome> {
  const { data: project, error: projectErr } = await db
    .from('he_projects')
    .select('id, created_by, market, website_url')
    .eq('id', notice.projectId)
    .maybeSingle();
  if (projectErr) return { kind: 'failed', message: `project read: ${errText(projectErr)}` };
  if (!project) return { kind: 'failed', message: 'project not found' };
  const p = project as Row;
  if (p.market !== 'us') return { kind: 'not_eng' };
  const ownerId = str(p.created_by);
  if (!ownerId) return { kind: 'not_eng' };

  const recipients = await readRecipients(db, [ownerId]);
  if (!recipients) return { kind: 'failed', message: 'profile or block marker read failed' };
  const recipient = recipients.get(ownerId) ?? { kind: 'not_eng' as const };
  if (recipient.kind !== 'ok') return recipient;

  let ban = memo?.bans.get(ownerId);
  if (!ban) {
    const live = await readLiveBan(db, ownerId);
    if (live.kind === 'error') return { kind: 'failed', message: live.message };
    ban = live.kind;
    memo?.bans.set(ownerId, ban);
  }
  if (ban === 'banned') return { kind: 'blocked' };
  if (ban === 'gone') return { kind: 'not_eng' };

  let verticalId = '';
  let brandInputs: HeBrandInputLeak[] = [];
  const templateId = notice.templateId?.trim();
  if (templateId) {
    const { data, error } = await db.from('he_templates').select('vertical_id').eq('id', templateId).maybeSingle();
    if (error) return { kind: 'failed', message: `template read: ${errText(error)}` };
    verticalId = str((data as Row | null)?.vertical_id);
  } else if (notice.kind === 'action_needed' && notice.code === 'collect_stopped' && notice.refId) {
    const base = await readBaseVertical(db, notice.projectId, notice.refId);
    if (base.kind === 'failed') return base;
    verticalId = base.verticalId;
  } else if (notice.kind === 'action_needed' && isStageStopCode(notice.code) && notice.refId) {
    const job = await readJobVertical(db, notice.projectId, notice.refId);
    if (job.kind === 'failed') return job;
    verticalId = job.verticalId;
    brandInputs = job.brandInputs;
  }
  const market = await readMarketName(db, notice.projectId, verticalId);
  if (market.kind === 'failed') return market;

  // Выключатель отправки (шапка, «ВЫКЛЮЧЕННАЯ ОТПРАВКА»): то же чтение без
  // записи и алерта, что у кабинета (GET /dashboard, GET проекта). Нет таблицы
  // ('unavailable', 'not_required') — выключить аккаунт было негде.
  const access = await readHeEngSendingAccess(db, ownerId);
  if (access.state === 'error') return { kind: 'failed', message: `sending access read: ${access.detail ?? 'error'}` };

  return {
    kind: 'ok',
    ctx: {
      recipient: { userId: recipient.userId, email: recipient.email },
      website: websiteLabel(p.website_url),
      marketName: market.name,
      sendingOff: access.state === 'revoked',
      brandInputs,
    },
  };
}

/** Куда ведёт кнопка письма. */
function ctaUrlOf(notice: HeEngClientNotice): string {
  const origin = heEngAppOrigin();
  const project = `${origin}/client/eng/projects/${encodeURIComponent(notice.projectId)}`;
  switch (notice.kind) {
    case 'research_ready':
      return `${project}?step=2`;
    case 'research_stopped':
      return `${project}?step=1`;
    case 'sending_waiting':
    case 'sending_started':
      return `${origin}/client/eng/dashboard`;
    case 'action_needed':
      return notice.code === 'start_failed' ? `${origin}/client/eng/dashboard` : `${project}?step=3`;
  }
}

/** Отправить письмо; true — SMTP-сервер его принял. Не бросает. */
async function deliver(notice: HeEngClientNotice, ctx: NoticeContext, key: string): Promise<boolean> {
  try {
    const { subject, html, text } = renderEngClientNoticeEmail({
      kind: notice.kind,
      code: notice.kind === 'action_needed' ? notice.code ?? null : null,
      next: notice.next ?? null,
      // Причина события: код паузы (autopilot_hold) или класс итога
      // автозапуска (needs_support) — письмо говорит по ней своё предложение.
      reason:
        notice.kind === 'action_needed' && (notice.code === 'autopilot_hold' || notice.code === 'needs_support')
          ? notice.refId?.trim() || null
          : null,
      marketName: ctx.marketName,
      website: ctx.website,
      ctaUrl: ctaUrlOf(notice),
      sendingOff: ctx.sendingOff,
      // Только у 'edit_brief': поле шага 1 подписью кабинета и слово клиента.
      brandInputs:
        notice.next === 'edit_brief'
          ? ctx.brandInputs.map((i) => ({ label: heBrandInputFieldLabelEn(i.field) ?? i.field, word: i.brand }))
          : null,
    });
    await sendTransactionalEmail({ to: ctx.recipient.email, subject, html, text, fromName: HE_ENG_VERIFY_FROM_NAME });
    return true;
  } catch (e) {
    void logWarn('he.eng_client_mail.send_failed', errText(e), { key, projectId: notice.projectId });
    return false;
  }
}

async function markSent(db: SupabaseClient, key: string): Promise<void> {
  try {
    const { error } = await db
      .from(HE_ENG_CLIENT_EMAILS_TABLE)
      .update({ sent_at: new Date().toISOString() })
      .eq('dedupe_key', key)
      .is('sent_at', null);
    if (error) void logWarn('he.eng_client_mail.mark_sent_failed', errText(error), { key });
  } catch (e) {
    // Письмо ушло; незаписанная отметка — только возможный повтор через 10 минут.
    void logWarn('he.eng_client_mail.mark_sent_failed', errText(e), { key });
  }
}

/**
 * Заявка и отправка. `claimed` — заявку вставил ЭТОТ вызов (письмо ушло или
 * ждёт повтора): по нему проход зовёт алерт команде ровно один раз на событие.
 * `sendingOff` (только при `claimed`) — с каким выключателем отправки ушла
 * первая попытка: алерт говорит команде то же, что письмо клиенту.
 */
async function claimAndDeliver(
  db: SupabaseClient,
  notice: HeEngClientNotice,
  memo?: RecipientMemo,
): Promise<{ result: HeEngClientNoticeResult; claimed: boolean; sendingOff?: boolean }> {
  try {
    if (!isNoticeKind(notice.kind) || (notice.kind === 'action_needed' && !isActionCode(notice.code))) {
      return { result: 'failed', claimed: false };
    }
    const key = heEngClientNoticeKey(notice);
    if (!key) return { result: 'failed', claimed: false };

    const loaded = await loadNoticeContext(db, notice, memo);
    if (loaded.kind === 'failed') {
      void logWarn('he.eng_client_mail.context_failed', loaded.message, { key, projectId: notice.projectId });
      return { result: 'failed', claimed: false };
    }
    if (loaded.kind !== 'ok') return { result: loaded.kind, claimed: false };

    const nowIso = new Date().toISOString();
    const { data: claimedRows, error: claimErr } = await db
      .from(HE_ENG_CLIENT_EMAILS_TABLE)
      .upsert(
        {
          dedupe_key: key,
          user_id: loaded.ctx.recipient.userId,
          project_id: notice.projectId,
          template_id: notice.templateId?.trim() || null,
          ref_id: notice.refId?.trim().slice(0, 100) || null,
          kind: notice.kind,
          code: notice.kind === 'action_needed' ? notice.code : null,
          next_step: isNextStep(notice.next) ? notice.next : null,
          attempts: 1,
          last_attempt_at: nowIso,
        },
        { onConflict: 'dedupe_key', ignoreDuplicates: true },
      )
      .select('dedupe_key');
    if (claimErr) {
      if (isMissingTable(claimErr)) {
        warnMissingTableOnce();
        return { result: 'unavailable', claimed: false };
      }
      void logWarn('he.eng_client_mail.claim_failed', errText(claimErr), { key, projectId: notice.projectId });
      return { result: 'failed', claimed: false };
    }
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) return { result: 'duplicate', claimed: false };

    const sendingOff = loaded.ctx.sendingOff;
    if (!(await deliver(notice, loaded.ctx, key))) return { result: 'failed', claimed: true, sendingOff };
    await markSent(db, key);
    return { result: 'sent', claimed: true, sendingOff };
  } catch (e) {
    void logWarn('he.eng_client_mail.notice_failed', errText(e), { projectId: notice?.projectId ?? null });
    return { result: 'failed', claimed: false };
  }
}

/**
 * Письмо о событии — один раз на ключ события (heEngClientNoticeKey).
 * НЕ БРОСАЕТ. 'duplicate' — заявка с этим ключом уже есть (письмо ушло,
 * уходит или ждёт повтора); 'blocked' — получатель заблокирован (заявки нет);
 * 'unavailable' — нет таблицы дедупа; 'failed' — не та форма уведомления,
 * сбой чтения (заявки нет) или SMTP (заявка тогда остаётся, и проход
 * повторит её).
 */
export async function sendHeEngClientNotice(
  db: SupabaseClient,
  notice: HeEngClientNotice,
): Promise<HeEngClientNoticeResult> {
  return (await claimAndDeliver(db, notice)).result;
}

/* ── Проход ── */

interface ScanState {
  now: number;
  sent: number;
  failed: number;
  /** Сколько ещё отправок можно сделать в этом проходе. */
  left: number;
  /** Бан получателей и заблокированные проекты этого прохода (RecipientMemo). */
  memo: RecipientMemo;
}

/**
 * Событие прохода. `prepare` — то, что стоит чтений (бюджет писем, имя
 * рынка для алерта), и зовётся только для событий, у которых заявки ещё нет;
 * null из него — не досчиталось (сбой чтения): событие ждёт следующего
 * прохода, письма с непроверенным советом нет. `alert` строится по
 * выключателю отправки, с которым ушло письмо (строка «клиент видит» —
 * clientSeesText).
 */
interface ScanCandidate {
  notice: HeEngClientNotice;
  prepare?: () => Promise<{ notice: HeEngClientNotice; alert: ((sendingOff: boolean) => HeOpsStop) | null } | null>;
}

/** Повтор неотправленных. 'missing' — таблицы нет, проходу дальше делать нечего. */
async function retryUnsent(db: SupabaseClient, state: ScanState): Promise<'ok' | 'missing' | 'failed'> {
  const cutoff = new Date(state.now - RETRY_AFTER_MS).toISOString();
  const { data, error } = await db
    .from(HE_ENG_CLIENT_EMAILS_TABLE)
    .select('dedupe_key, project_id, template_id, ref_id, kind, code, next_step, attempts, last_attempt_at, created_at')
    .is('sent_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) {
    if (isMissingTable(error)) {
      warnMissingTableOnce();
      return 'missing';
    }
    void logWarn('he.eng_client_mail.retry_read_failed', errText(error));
    return 'failed';
  }
  for (const row of (data ?? []) as Row[]) {
    if (state.left <= 0) break;
    const lastAttempt = ms(row.last_attempt_at) || ms(row.created_at);
    if (lastAttempt > state.now - RETRY_AFTER_MS) continue;
    const key = str(row.dedupe_key);
    const attempts = typeof row.attempts === 'number' ? row.attempts : MAX_ATTEMPTS;
    const notice: HeEngClientNotice = {
      kind: row.kind as HeEngClientNoticeKind,
      projectId: str(row.project_id),
      templateId: str(row.template_id) || null,
      code: isActionCode(row.code) ? row.code : null,
      refId: str(row.ref_id) || null,
      next: isNextStep(row.next_step) ? row.next_step : null,
    };
    if (!key || !notice.projectId || !isNoticeKind(notice.kind)) continue;

    const loaded = await loadNoticeContext(db, notice, state.memo);
    if (loaded.kind === 'failed') continue; // сбой чтения — попытку не тратим
    if (loaded.kind !== 'ok') {
      // Получатель больше не подходит (сменился профиль, пропал адрес,
      // аккаунт заблокирован — отметкой или баном) — письмо закрывается без
      // отправки. После разблокировки оно не уходит.
      await db
        .from(HE_ENG_CLIENT_EMAILS_TABLE)
        .update({ attempts: MAX_ATTEMPTS, last_attempt_at: new Date(state.now).toISOString() })
        .eq('dedupe_key', key)
        .is('sent_at', null);
      void logWarn('he.eng_client_mail.retry_dropped', `recipient ${loaded.kind}`, { key });
      continue;
    }

    // Аренда повтора: условный UPDATE по attempts — второй процесс строку не возьмёт.
    const { data: taken, error: takeErr } = await db
      .from(HE_ENG_CLIENT_EMAILS_TABLE)
      .update({ attempts: attempts + 1, last_attempt_at: new Date(state.now).toISOString() })
      .eq('dedupe_key', key)
      .eq('attempts', attempts)
      .is('sent_at', null)
      .select('dedupe_key');
    if (takeErr || !Array.isArray(taken) || taken.length === 0) continue;

    state.left -= 1;
    if (await deliver(notice, loaded.ctx, key)) {
      await markSent(db, key);
      state.sent += 1;
    } else {
      state.failed += 1;
    }
  }
  return 'ok';
}

/** Ключи, по которым заявка уже есть (письмо ушло, уходит или ждёт повтора). */
async function readExistingKeys(db: SupabaseClient, keys: string[]): Promise<Set<string> | null> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  const read = await readIn(keys, KEY_CHUNK, 'he.eng_client_mail.keys_read_failed', (part) =>
    db.from(HE_ENG_CLIENT_EMAILS_TABLE).select('dedupe_key').in('dedupe_key', part).limit(part.length),
  );
  if (!read) return null;
  for (const row of read.rows) out.add(str(row.dedupe_key));
  return out;
}

/**
 * Отправить кандидатов, у которых ещё нет заявки, в пределах бюджета прохода.
 * Алерт команде кандидата уходит, только если заявку вставил этот вызов.
 * Получатель оказался заблокирован (живой бан — 'blocked') — ни заявки, ни
 * алерта, бюджет отправок не тратится, и остальные события его проектов в
 * этом проходе пропускаются без чтений (state.memo.blockedProjects).
 * false — до конца списка не дошли (кончился бюджет отправок или не
 * прочитались заявки): вызывающий читает эти события снова следующим проходом.
 */
async function sendCandidates(db: SupabaseClient, state: ScanState, candidates: ScanCandidate[]): Promise<boolean> {
  if (candidates.length === 0) return true;
  if (state.left <= 0) return false;
  const keyed = candidates
    .map((candidate) => ({ candidate, key: heEngClientNoticeKey(candidate.notice) }))
    .filter((c): c is { candidate: ScanCandidate; key: string } => c.key !== null);
  const existing = await readExistingKeys(db, keyed.map((c) => c.key));
  if (!existing) return false;
  for (const { candidate, key } of keyed) {
    if (existing.has(key)) continue;
    if (state.memo.blockedProjects.has(candidate.notice.projectId)) continue;
    if (state.left <= 0) return false;
    existing.add(key);
    let notice = candidate.notice;
    let alert: ((sendingOff: boolean) => HeOpsStop) | null = null;
    if (candidate.prepare) {
      let prepared: Awaited<ReturnType<NonNullable<ScanCandidate['prepare']>>>;
      try {
        prepared = await candidate.prepare();
      } catch (e) {
        void logWarn('he.eng_client_mail.prepare_failed', errText(e), { key, projectId: notice.projectId });
        prepared = null;
      }
      if (!prepared) continue;
      notice = prepared.notice;
      alert = prepared.alert;
    }
    const { result, claimed, sendingOff } = await claimAndDeliver(db, notice, state.memo);
    if (claimed && alert) void notifyHeClientStop(alert(sendingOff === true));
    if (result === 'blocked') {
      state.memo.blockedProjects.add(notice.projectId);
    } else if (result === 'sent') {
      state.left -= 1;
      state.sent += 1;
    } else if (result === 'failed') {
      state.left -= 1;
      state.failed += 1;
    } else if (result === 'unavailable') {
      return false;
    }
  }
  return true;
}

/** Последняя по времени строка из списка. */
function latestBy(rows: Row[], field: string): Row | null {
  let best: Row | null = null;
  for (const row of rows) if (!best || ms(row[field]) > ms(best[field])) best = row;
  return best;
}

/** Самая поздняя метка research-джобы — те же поля, что у engResearchRetryVerdict. */
function researchJobStamp(job: Row): number {
  return Math.max(ms(job.finished_at), ms(job.updated_at), ms(job.started_at), ms(job.created_at));
}

const RESEARCH_JOB_COLUMNS = 'id, project_id, status, created_at, started_at, finished_at, updated_at';

/**
 * Последняя research-джоба каждого проекта; null — не прочиталось. `cut` —
 * проекты, чей кусок упёрся в limit: их последняя джоба не известна, и
 * событий по ним в этом проходе нет.
 */
async function readLatestResearchJobs(
  db: SupabaseClient,
  projectIds: string[],
): Promise<{ latest: Map<string, Row>; cut: Set<string> } | null> {
  const jobs = await readIn(
    projectIds,
    MANY_CHUNK,
    'he.eng_client_mail.research_jobs_read_failed',
    (part) =>
      db
        .from('he_jobs')
        .select(RESEARCH_JOB_COLUMNS)
        .in('project_id', part)
        .in('stage', HE_RESEARCH_STAGES)
        .order('created_at', { ascending: false })
        .limit(READ_LIMIT),
    READ_LIMIT,
  );
  if (!jobs) return null;
  const latest = new Map<string, Row>();
  for (const pid of projectIds) {
    const last = latestBy(jobs.rows.filter((j) => str(j.project_id) === pid), 'created_at');
    if (last) latest.set(pid, last);
  }
  return { latest, cut: jobs.cut };
}

/**
 * research_ready и research_stopped — по свежим проектам us.
 *
 *  - research_ready: проект 'researched', его последняя кластеризация 'done'
 *    закончилась в окне, у проекта есть хоть одна вертикаль (иначе «мы
 *    выбрали рынки» — неправда) и клиент ещё не нажал Launch (строки
 *    намерения нет — иначе «выберите и нажмите Launch» опоздало);
 *  - research_stopped, упал: проект 'failed' (его пишут только research-стадии
 *    и сбой их дочейна), причина — не отмена руками, последняя research-джоба
 *    не отменена и менялась в окне. Совет — вердиктом роута «Try again»
 *    (engResearchRetryVerdict): 'retry_failed' — «Try again» (у кода проекта
 *    'billing' / 'configuration' — 'team_fix': Support, потом «Try again»),
 *    иначе Support. Кроме кода website_thin (research ждёт описания бизнеса,
 *    HE_RESEARCH_NEEDS_DESCRIPTION_CODE): совета нет вовсе (next null —
 *    «откройте проект, там видно, что случилось и что делать»), потому что
 *    его продолжает «Save and continue» шага 1, а не «Try again» и не Support;
 *    ключ — id джобы с суффиксом кода (ниже);
 *  - research_stopped, встал: проект 'researching', и вердикт того же роута —
 *    'retry_stalled' (ни одна research-стадия не идёт дольше окна шага 1,
 *    HE_RESEARCH_STALL_GRACE_MS, — «Try again» на шаге 1 уже стоит); письмо —
 *    после ещё SETTLE_MS отстоя (сборщик брошенных строк может дочейнить
 *    следующую стадию позже) и только если последняя стадия шла в окне.
 * Ключ — с id последней research-джобы: повтор «Try again», упавший или
 * вставший снова, — новое письмо; встал, а потом упал на той же джобе — одно.
 */
async function scanResearchEvents(db: SupabaseClient, state: ScanState): Promise<void> {
  const since = state.now - EVENT_WINDOW_MS;
  const [doneRes, runningRes] = await Promise.all([
    db
      .from('he_projects')
      .select('id, status, error, created_by, created_at, updated_at')
      .eq('market', 'us')
      .in('status', ['researched', 'failed'])
      .gte('updated_at', new Date(since).toISOString())
      .order('updated_at', { ascending: false })
      .limit(RESEARCH_PAGE),
    db
      .from('he_projects')
      .select('id, status, error, created_by, created_at, updated_at')
      .eq('market', 'us')
      .eq('status', 'researching')
      .gte('updated_at', new Date(since).toISOString())
      .order('updated_at', { ascending: false })
      .limit(RESEARCH_PAGE),
  ]);
  if (doneRes.error || runningRes.error) {
    void logWarn('he.eng_client_mail.projects_read_failed', errText(doneRes.error ?? runningRes.error));
    return;
  }
  for (const [label, res] of [['researched_failed', doneRes], ['researching', runningRes]] as const) {
    // Свежие первыми: упор отрезает самые старые проекты окна — в лог.
    if ((res.data ?? []).length >= RESEARCH_PAGE) {
      logBudgetHit(
        `he.eng_client_mail.research_page_full.${label}`,
        `more than ${RESEARCH_PAGE} us projects changed in the event window: the oldest of them are not checked this pass`,
      );
    }
  }
  const projects = [...((doneRes.data ?? []) as Row[]), ...((runningRes.data ?? []) as Row[])];
  if (projects.length === 0) return;
  const recipients = await readRecipients(db, projects.map((p) => str(p.created_by)));
  if (!recipients) return;
  const eligible = projects.filter((p) => recipients.get(str(p.created_by))?.kind === 'ok');

  const researched = eligible.filter((p) => p.status === 'researched').map((p) => str(p.id));
  const stopped = eligible.filter(
    (p) =>
      p.status === 'researching' ||
      (p.status === 'failed' && toClientEngStageErrorCode(p.error) !== 'cancelled'),
  );

  const candidates: ScanCandidate[] = [];

  if (researched.length > 0) {
    const jobs = await readIn(
      researched,
      MANY_CHUNK,
      'he.eng_client_mail.clustering_read_failed',
      (part) =>
        db
          .from('he_jobs')
          .select('project_id, finished_at, updated_at')
          .in('project_id', part)
          .eq('stage', 'clustering')
          .eq('status', 'done')
          .limit(READ_LIMIT),
      READ_LIMIT,
    );
    // Кусок, упёршийся в limit (jobs.cut), — его проекты ждут следующего прохода.
    const fresh = !jobs
      ? []
      : researched.filter((pid) => {
          if (jobs.cut.has(pid)) return false;
          const own = jobs.rows.filter((j) => str(j.project_id) === pid);
          const last = own.reduce((acc, j) => Math.max(acc, ms(j.finished_at) || ms(j.updated_at)), 0);
          return last >= since;
        });
    const existing = await readExistingKeys(db, fresh.map((pid) => `research_ready:${pid}`));
    const pending = existing ? fresh.filter((pid) => !existing.has(`research_ready:${pid}`)) : [];
    if (pending.length > 0) {
      const verticals = await readIn(
        pending,
        MANY_CHUNK,
        'he.eng_client_mail.verticals_read_failed',
        (part) => db.from('he_verticals').select('project_id').in('project_id', part).limit(READ_LIMIT),
        READ_LIMIT,
      );
      // Клиент уже нажал Launch (есть строка намерения) — рынки он видел, и
      // «выберите и нажмите Launch» ему уже не нужно. Нет таблицы намерения —
      // автозапуска нет, письмо пишем; сбой чтения — тоже пишем (текст верен).
      const launched = new Set<string>();
      for (let i = 0; i < pending.length; i += ID_CHUNK) {
        const part = pending.slice(i, i + ID_CHUNK);
        const { data: intents, error: intentErr } = await db
          .from(LAUNCH_INTENT_TABLE)
          .select('project_id')
          .in('project_id', part)
          .limit(part.length);
        if (intentErr) {
          if (!isMissingTable(intentErr)) void logWarn('he.eng_client_mail.intent_read_failed', errText(intentErr));
          break;
        }
        for (const r of (intents ?? []) as Row[]) launched.add(str(r.project_id));
      }
      if (verticals) {
        const withMarkets = new Set(verticals.rows.map((v) => str(v.project_id)));
        for (const pid of pending) {
          if (withMarkets.has(pid) && !launched.has(pid) && !verticals.cut.has(pid)) {
            candidates.push({ notice: { kind: 'research_ready', projectId: pid } });
          }
        }
      }
    }
  }

  if (stopped.length > 0) {
    const lastJobs = await readLatestResearchJobs(db, stopped.map((p) => str(p.id)));
    for (const p of lastJobs ? stopped : []) {
      const pid = str(p.id);
      // Срез джоб проекта обрезан — последняя джоба не известна: ждём.
      if (lastJobs?.cut.has(pid)) continue;
      const last = lastJobs?.latest.get(pid) ?? null;
      if (last?.status === 'cancelled') continue;
      const verdict = engResearchRetryVerdict({
        status: p.status,
        errorCode: toClientEngStageErrorCode(p.error),
        lastResearchJob: last,
        project: p,
        now: state.now,
        graceMs: HE_RESEARCH_STALL_GRACE_MS,
      });
      if (p.status === 'failed') {
        if (!last || ms(last.updated_at) < since || verdict === 'running') continue;
        const code = toClientEngStageErrorCode(p.error);
        // Research ждёт описания бизнеса (тонкий сайт, website_thin): не сбой,
        // и ни «Try again» (его роут откажет — это не технический сбой), ни
        // «запустить можно только через Support» (его продолжает «Save and
        // continue» шага 1) письмо не называет — next null: «остановилось,
        // откройте проект — там, что случилось и что можно сделать», а шаг 1
        // просит описание. Ключ — свой (суффикс к id джобы): продолжение
        // возвращает в очередь ТУ ЖЕ джобу, и её поздний технический сбой
        // должен дать своё письмо, а не «дубликат» этого.
        if (code === HE_RESEARCH_NEEDS_DESCRIPTION_CODE) {
          candidates.push({
            notice: {
              kind: 'research_stopped',
              projectId: pid,
              refId: `${str(last.id)}:${HE_RESEARCH_NEEDS_DESCRIPTION_CODE}`,
              next: null,
            },
          });
          continue;
        }
        // Отказ, который чинит команда (деньги или ключ провайдера): «Try
        // again» до починки упрётся в тот же отказ — сначала Support, как
        // говорит шаг 1 (retryFailedText) и справочник (TEAM_FIX_WHAT_TO_DO).
        const teamFix = code === 'billing' || code === 'configuration';
        candidates.push({
          notice: {
            kind: 'research_stopped',
            projectId: pid,
            refId: str(last.id),
            next: verdict === 'retry_failed' ? (teamFix ? 'team_fix' : 'try_again') : 'support',
          },
        });
      } else if (verdict === 'retry_stalled') {
        const stamp = last ? researchJobStamp(last) : Math.max(ms(p.updated_at), ms(p.created_at));
        if (stamp < since || stamp > state.now - HE_RESEARCH_STALL_GRACE_MS - SETTLE_MS) continue;
        candidates.push({
          notice: {
            kind: 'research_stopped',
            projectId: pid,
            refId: last ? str(last.id) : `stalled-${stamp}`,
            next: 'try_again',
          },
        });
      }
    }
  }

  await sendCandidates(db, state, candidates);
}

/* ── Остановки стадий рынка (проекты с включённым автозапуском) ── */

/** Остановка платной стадии рынка, найденная по данным (до бюджета писем). */
interface StageStopEvent {
  code: HeEngStageStopCode;
  alertStage: HeOpsStageStopStage;
  projectId: string;
  verticalId: string;
  baseId: string | null;
  jobId: string;
  reason: string;
  /**
   * Кнопка, которая ставит эту стадию заново, без учёта бюджета писем;
   * null — ни одна (совет — Support).
   */
  button: 'launch' | 'rewrite' | null;
  /** Кнопка упирается ещё и в бюджет писем поколения анализа базы. */
  lettersBudget: boolean;
  /**
   * Джобу остановил отказ, который чинит только команда (деньги или ключ
   * провайдера, heTeamFixableFailureOf): кнопка двигает остановку только после
   * починки — совет 'team_fix' (Support прежде кнопки).
   */
  teamFix: boolean;
  /**
   * Джобу закрыл бесплатный отказ за наш бренд в поле брифа (пометка воркера,
   * heJobUnpaidBrandInput): кнопка двигает остановку только после правки
   * поля — совет 'edit_brief' (поле шага 1 прежде кнопки).
   */
  brandInput: boolean;
}

/** Срез конвейера проектов с упавшими стадиями — одной пачкой чтений. */
interface StageSnapshot {
  /** Упавшие и отменённые джобы стадий в окне (STAGE_STOP_STAGES). */
  ended: Row[];
  /** Идущие джобы проектов (pending / running), любые стадии. */
  live: Row[];
  /**
   * Проект → выбранные клиентом вертикали (есть accepted-гипотеза) — только
   * среди рынков ещё не заявленных упавших джоб.
   */
  selected: Map<string, Set<string>>;
  /** Базы упавших джоб и не доливные базы их рынков. */
  bases: Row[];
  chains: Row[];
  templates: Row[];
  /** Проекты, чей кусок чтения упёрся в limit: событий по ним в этом проходе нет. */
  cutProjects: Set<string>;
  /** Рынки (вертикали), чей кусок чтения упёрся в limit. */
  cutVerticals: Set<string>;
}

/** Ключ цели джобы: цепочка — вертикаль, остальные стадии — база. */
function stageTarget(job: Row): string {
  return job.stage === 'chain' ? `v:${str(job.vertical_id)}` : `b:${str(job.base_id)}`;
}

/** Шаблон помечен запуском: кампания в записи или живая аренда попытки (heTemplateLaunchMarked). */
function templateLaunchMarked(t: Row, nowMs: number): boolean {
  if (str(t.launch_campaign_id)) return true;
  const until = ms(t.launch_running_until);
  return until > nowMs;
}

/** Своя авто-база (не доливная) — тем же признаком, что у реконсилера (autoBases). */
function isOwnAutoBase(b: Row): boolean {
  return b.source === 'auto' && !str(b.filename).startsWith('auto-refill');
}

/**
 * Окончательные остановки стадий по срезу — что пишем и какой кнопкой это
 * двигается. Чистая функция; правила ровно те, что у пути «Launch»
 * (reconcileHeAutopilotProject, trigger 'client') и роута «Rewrite letters»:
 *
 *  - letters_stopped: последняя джоба цепочки ВЫБРАННОЙ вертикали 'failed',
 *    готовой цепочки нет, цепочка не идёт. «Launch» ставит цепочку заново
 *    (новый платный прогон, сколько нажатий — столько прогонов);
 *  - check_stopped: последний base_analyze базы 'failed', база всё ещё
 *    'analyzing' (финальный фейл анализа базу не трогает), по ней ничего не
 *    идёт. «Launch» ставит анализ заново ремонтом осиротевшей базы — только
 *    при условиях engAnalysisRequeues (та же функция, что у шага 3);
 *  - final_letters_stopped: последняя template-джоба 'analyzed'-базы 'failed',
 *    у базы нет ни одного шаблона. «Launch» ставит генерацию, только если это
 *    свежая своя analyzed-база рынка со строками при готовой цепочке И бюджет
 *    писем не исчерпан (иначе реконсилер пишет letters_exhausted);
 *  - rewrite_stopped: то же, но у базы только снятые «Rewrite letters»
 *    шаблоны ('failed'). «Launch» это НЕ двигает (реконсилер считает шаблон
 *    базы по любому статусу); двигает «Rewrite letters» (путь F роута), пока
 *    бюджет писем не исчерпан.
 * Общие условия: проект 'researched'; джоба упала в окне, отстоялась SETTLE_MS
 * и позже нажатия Launch; у рынка нет ни готового/черновика шаблона, ни
 * шаблона с запуском (тогда рынок не стоит — его ведёт автозапуск). Пауза
 * проекта 'spend_paused' — кнопки нет: путь «Launch» и роут перезаписи
 * упираются в потолок расхода. Кнопка есть, но джобу остановил отказ, который
 * чинит команда (teamFix), — совет 'team_fix' (решается в stageStopCandidate).
 */
function stageStopEvents(input: {
  snapshot: StageSnapshot;
  projects: Map<string, { requestedAt: number; spendPaused: boolean }>;
  since: number;
  settled: number;
  nowMs: number;
}): StageStopEvent[] {
  const { snapshot, projects, since, settled, nowMs } = input;
  const latestEnded = new Map<string, Row>();
  for (const job of snapshot.ended) {
    const key = `${str(job.project_id)}|${str(job.stage)}|${stageTarget(job)}`;
    const prev = latestEnded.get(key);
    if (!prev || ms(job.created_at) > ms(prev.created_at) || (ms(job.created_at) === ms(prev.created_at) && str(job.id) > str(prev.id))) {
      latestEnded.set(key, job);
    }
  }
  const out: StageStopEvent[] = [];
  for (const job of latestEnded.values()) {
    if (job.status !== 'failed') continue;
    const pid = str(job.project_id);
    const project = projects.get(pid);
    if (!project || snapshot.cutProjects.has(pid)) continue;
    const endedAt = ms(job.finished_at) || ms(job.updated_at);
    if (endedAt < since || endedAt > settled || endedAt < project.requestedAt) continue;
    const selected = snapshot.selected.get(pid) ?? new Set<string>();
    const live = snapshot.live.filter((j) => str(j.project_id) === pid);
    const stage = str(job.stage);

    let verticalId: string;
    let base: Row | null = null;
    if (stage === 'chain') {
      verticalId = str(job.vertical_id);
    } else {
      base = snapshot.bases.find((b) => str(b.id) === str(job.base_id) && str(b.project_id) === pid) ?? null;
      if (!base || isRefillBase(base)) continue;
      verticalId = str(base.vertical_id);
    }
    if (!verticalId || !selected.has(verticalId) || snapshot.cutVerticals.has(verticalId)) continue;
    const vTemplates = snapshot.templates.filter((t) => str(t.vertical_id) === verticalId);
    if (vTemplates.some((t) => t.status !== 'failed' || templateLaunchMarked(t, nowMs))) continue;
    const vChains = snapshot.chains.filter((c) => str(c.vertical_id) === verticalId);
    const chainReady = vChains.some((c) => c.status === 'ready');
    const common = {
      projectId: pid,
      verticalId,
      jobId: str(job.id),
      reason: str(job.error),
      teamFix: heTeamFixableFailureOf(job.error) !== null,
      brandInput: str(job.unpaid_refusal) === 'brand_input',
    };

    if (stage === 'chain') {
      if (chainReady) continue;
      if (live.some((j) => j.stage === 'chain' && str(j.vertical_id) === verticalId)) continue;
      out.push({
        ...common,
        code: 'letters_stopped',
        alertStage: 'chain',
        baseId: null,
        button: project.spendPaused ? null : 'launch',
        lettersBudget: false,
      });
      continue;
    }

    const baseId = str(base?.id);
    if (live.some((j) => str(j.base_id) === baseId)) continue;
    const vBases = snapshot.bases.filter((b) => str(b.vertical_id) === verticalId);
    // Состояние рынка решает его ПОСЛЕДНЯЯ своя авто-база (как у
    // collect_stopped и карточки рынка на шаге 3): остановка на более старой
    // базе рынок не держит, а у более новой — своё событие.
    const latestOwn = latestBy(vBases.filter(isOwnAutoBase), 'created_at');
    if (!base || str(latestOwn?.id) !== baseId) continue;

    if (stage === 'base_analyze') {
      if (base.status !== 'analyzing') continue;
      const requeues = engAnalysisRequeues(
        { id: baseId, row_count: base.row_count },
        vBases.map((b) => ({ id: b.id, status: b.status, source: b.source, refill: isRefillBase(b) })),
        vChains,
      );
      out.push({
        ...common,
        code: 'check_stopped',
        alertStage: 'base_analyze',
        baseId,
        button: requeues && !project.spendPaused ? 'launch' : null,
        lettersBudget: false,
      });
      continue;
    }

    // template
    if (base.status !== 'analyzed') continue;
    const baseTemplates = vTemplates.filter((t) => str(t.base_id) === baseId);
    if (baseTemplates.length === 0) {
      // Реконсилер ставит письма свежей своей analyzed-базе рынка (это она —
      // последняя своя) при готовой цепочке; базе без строк кабинет советует
      // Support, а не «Launch».
      const launchable = chainReady && num(base.row_count) > 0;
      out.push({
        ...common,
        code: 'final_letters_stopped',
        alertStage: 'template',
        baseId,
        button: launchable && !project.spendPaused ? 'launch' : null,
        lettersBudget: true,
      });
    } else {
      out.push({
        ...common,
        code: 'rewrite_stopped',
        alertStage: 'template_rewrite',
        baseId,
        button: project.spendPaused ? null : 'rewrite',
        lettersBudget: true,
      });
    }
  }
  return out;
}

/** Коды, которыми может быть заявлено письмо об упавшей джобе стадии. */
function stageStopCodesOf(job: Row): HeEngStageStopCode[] {
  switch (job.stage) {
    case 'chain':
      return ['letters_stopped'];
    case 'base_analyze':
      return ['check_stopped'];
    case 'template':
      return ['final_letters_stopped', 'rewrite_stopped'];
    default:
      return [];
  }
}

function stageStopKeysOf(job: Row): string[] {
  return stageStopCodesOf(job)
    .map((code) => heEngClientNoticeKey({ kind: 'action_needed', code, projectId: str(job.project_id), refId: str(job.id) }))
    .filter((k): k is string => k !== null);
}

/** Колонки базы, которые читает правило остановок (stageStopEvents) и признак долива. */
const STAGE_BASE_COLUMNS =
  'id, project_id, vertical_id, status, source, row_count, filename, created_at, refill_flag:collect_info->>refill';

/**
 * Срез конвейера для проектов с упавшими стадиями; null — не прочитался
 * (письма ждут следующего прохода). `fresh` — упавшая джоба годится в
 * событие по времени (окно, отстой, после нажатия Launch). Джобы, письмо о
 * которых уже заявлено, срез не читают: иначе каждое событие стоило бы пачки
 * чтений каждую минуту все 6 часов окна. Остальное читается только по ещё не
 * заявленным упавшим джобам: их базы (по id), их рынки (вертикаль цепочки или
 * базы) — выбор, не доливные базы, цепочки и шаблоны этих рынков — и идущие
 * джобы их проектов. Кусок, упёршийся в limit, даёт cutProjects / cutVerticals.
 */
async function readStageSnapshot(
  db: SupabaseClient,
  projectIds: string[],
  since: number,
  fresh: (job: Row) => boolean,
): Promise<StageSnapshot | null> {
  const endedRead = await readIn(
    projectIds,
    MANY_CHUNK,
    'he.eng_client_mail.stage_jobs_read_failed',
    (part) =>
      db
        .from('he_jobs')
        .select(
          'id, project_id, stage, status, error, created_at, updated_at, finished_at, vertical_id:payload->>vertical_id, ' +
            'base_id:payload->>base_id, unpaid_refusal:payload->>unpaid_refusal',
        )
        .in('project_id', part)
        .in('stage', STAGE_STOP_STAGES)
        .in('status', ['failed', 'cancelled'])
        .gte('updated_at', new Date(since).toISOString())
        .limit(READ_LIMIT),
    READ_LIMIT,
  );
  if (!endedRead) return null;
  const cutProjects = new Set(endedRead.cut);
  const cutVerticals = new Set<string>();
  const empty = (): StageSnapshot => ({
    ended: [],
    live: [],
    selected: new Map(),
    bases: [],
    chains: [],
    templates: [],
    cutProjects,
    cutVerticals,
  });
  const failed = endedRead.rows.filter((j) => j.status === 'failed' && fresh(j));
  const claimed = await readExistingKeys(db, failed.flatMap(stageStopKeysOf));
  if (!claimed) return null;
  const open = failed.filter((j) => !stageStopKeysOf(j).some((k) => claimed.has(k)));
  const withFailed = [...new Set(open.map((j) => str(j.project_id)))];
  if (withFailed.length === 0) return empty();

  // Базы упавших джоб (базовых стадий) — по id; рынки — их вертикали и
  // вертикали упавших цепочек.
  const baseIds = [...new Set(open.filter((j) => j.stage !== 'chain').map((j) => str(j.base_id)).filter(Boolean))];
  const ownBases = await readIn(baseIds, ID_CHUNK, 'he.eng_client_mail.stage_context_failed', (part) =>
    db.from('he_bases').select(STAGE_BASE_COLUMNS).in('id', part).limit(part.length),
  );
  if (!ownBases) return null;
  const verticalIds = [
    ...new Set([
      ...open.filter((j) => j.stage === 'chain').map((j) => str(j.vertical_id)),
      ...ownBases.rows.map((b) => str(b.vertical_id)),
    ]),
  ].filter(Boolean);

  const live = await readIn(
    withFailed,
    MANY_CHUNK,
    'he.eng_client_mail.stage_context_failed',
    (part) =>
      db
        .from('he_jobs')
        .select('project_id, stage, vertical_id:payload->>vertical_id, base_id:payload->>base_id')
        .in('project_id', part)
        .in('status', ['pending', 'running'])
        .limit(READ_LIMIT),
    READ_LIMIT,
  );
  if (!live) return null;
  for (const pid of live.cut) cutProjects.add(pid);
  const ended = endedRead.rows.filter((j) => withFailed.includes(str(j.project_id)));
  if (verticalIds.length === 0) {
    return { ...empty(), ended, live: live.rows, bases: ownBases.rows };
  }
  const [hypotheses, marketBases, chains, templates] = await Promise.all([
    readIn(
      verticalIds,
      MANY_CHUNK,
      'he.eng_client_mail.stage_context_failed',
      (part) =>
        db
          .from('he_hypotheses')
          .select('project_id, vertical_id')
          .in('vertical_id', part)
          .eq('status', 'accepted')
          .limit(READ_LIMIT),
      READ_LIMIT,
    ),
    readIn(
      verticalIds,
      MANY_CHUNK,
      'he.eng_client_mail.stage_context_failed',
      (part) =>
        db
          .from('he_bases')
          .select(STAGE_BASE_COLUMNS)
          .in('vertical_id', part)
          .or(NOT_REFILL_BASE_OR)
          .limit(READ_LIMIT),
      READ_LIMIT,
    ),
    readIn(
      verticalIds,
      MANY_CHUNK,
      'he.eng_client_mail.stage_context_failed',
      (part) => db.from('he_chains').select('vertical_id, status').in('vertical_id', part).limit(READ_LIMIT),
      READ_LIMIT,
    ),
    readIn(
      verticalIds,
      MANY_CHUNK,
      'he.eng_client_mail.stage_context_failed',
      (part) =>
        db
          .from('he_templates')
          .select('id, vertical_id, base_id, status, launch_campaign_id:launch_info->>campaign_id, launch_running_until:launch_info->>running_until')
          .in('vertical_id', part)
          .limit(READ_LIMIT),
      READ_LIMIT,
    ),
  ]);
  if (!hypotheses || !marketBases || !chains || !templates) return null;
  for (const read of [hypotheses, marketBases, chains, templates]) {
    for (const vid of read.cut) cutVerticals.add(vid);
  }
  const selected = new Map<string, Set<string>>();
  for (const h of hypotheses.rows) {
    const pid = str(h.project_id);
    const vid = str(h.vertical_id);
    if (!pid || !vid) continue;
    if (!selected.has(pid)) selected.set(pid, new Set());
    selected.get(pid)?.add(vid);
  }
  const basesById = new Map<string, Row>();
  for (const b of [...ownBases.rows, ...marketBases.rows]) basesById.set(str(b.id), b);
  return {
    ended,
    live: live.rows,
    selected,
    bases: [...basesById.values()],
    chains: chains.rows,
    templates: templates.rows,
    cutProjects,
    cutVerticals,
  };
}

/** Имя рынка для алерта команде; null — не прочиталось (алерт уйдёт с id). */
async function readVerticalName(db: SupabaseClient, verticalId: string): Promise<string | null> {
  try {
    const { data, error } = await db.from('he_verticals').select('name').eq('id', verticalId).maybeSingle();
    if (error) return null;
    return str((data as Row | null)?.name).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Что команда читает в строке «клиент видит»: какое письмо уходит и какой шаг
 * в нём назван. `sendingOff` — письмо ушло при выключенной отправке аккаунта:
 * кнопки 'launch' / 'rewrite' / 'team_fix' оно не называет (шапка,
 * «ВЫКЛЮЧЕННАЯ ОТПРАВКА») — и строка команде тоже.
 */
function clientSeesText(
  heading: string,
  next: HeEngClientNextStep,
  code: HeEngStageStopCode | undefined,
  sendingOff: boolean,
): string {
  if (sendingOff && (next === 'launch' || next === 'rewrite' || next === 'team_fix' || next === 'edit_brief')) {
    return (
      `клиенту отправляется письмо «${heading}» — отправка аккаунта выключена, поэтому кнопку письмо не называет ` +
      'и зовёт в Support' +
      (next === 'team_fix' ? ' (сказано: временная проблема на нашей стороне, команда уже работает)' : '')
    );
  }
  const step =
    next === 'launch'
      ? 'нажать «Launch» на шаге 3'
      : next === 'edit_brief'
        ? 'убрать наш бренд из поля брифа на шаге 1 «Your business» (письмо называет поле и слово), потом нажать ' +
          (code === 'rewrite_stopped' ? '«Rewrite letters» на карточке рынка' : '«Launch» на шаге 3')
      : next === 'rewrite'
        ? 'нажать «Rewrite letters» на карточке рынка (шаг 3)'
        : next === 'try_again'
          ? 'нажать «Try again» на шаге 1'
          : next === 'team_fix'
            ? 'сначала написать в Support и узнать, когда починят (сказано: временная проблема на нашей стороне, ' +
              `команда уже работает), потом нажать ${code === 'rewrite_stopped' ? '«Rewrite letters» на карточке рынка' : '«Launch» на шаге 3'} — ` +
              'ответить ему в чате поддержки, когда отказ починен'
            : 'написать в Support (сказано, что команда в курсе)';
  return `клиенту отправляется письмо «${heading}» — ${step}`;
}

const STAGE_STOP_HEADING: Record<HeEngStageStopCode, string> = {
  letters_stopped: 'Writing the letters stopped',
  final_letters_stopped: 'Writing the final letters stopped',
  check_stopped: 'Checking the contacts stopped',
  rewrite_stopped: 'Rewriting the letters stopped',
};

/** Кандидат письма об остановке стадии: совет (с бюджетом писем) и алерт — в prepare. */
function stageStopCandidate(db: SupabaseClient, event: StageStopEvent, projectName: string | null): ScanCandidate {
  const base: HeEngClientNotice = {
    kind: 'action_needed',
    code: event.code,
    projectId: event.projectId,
    refId: event.jobId,
  };
  return {
    notice: base,
    prepare: async () => {
      let next: HeEngClientNextStep = event.button ?? 'support';
      if (event.button && event.lettersBudget && event.baseId) {
        // Сбой чтения бросает HeAutopilotReadError — sendCandidates считает
        // это «не досчиталось», и событие ждёт следующего прохода.
        const budget = await heTemplateGenerationBudget(db, { projectId: event.projectId, baseId: event.baseId });
        next = budget.allowed ? event.button : 'support';
      }
      // Кнопка двигает остановку, но отказ на нашей стороне (деньги, ключ):
      // нажатие до починки упрётся в тот же отказ — сначала Support, потом
      // та же кнопка; кнопку письмо называет по коду остановки.
      if (next !== 'support' && event.teamFix) next = 'team_fix';
      // Кнопка двигает остановку, но стадию писем остановило поле брифа с
      // нашим брендом: нажатие без правки поля упрётся в тот же отказ (путь
      // «Launch» и роут «Rewrite letters» проверяют его до постановки) —
      // сначала поле шага 1, потом та же кнопка.
      if ((next === 'launch' || next === 'rewrite') && event.brandInput) next = 'edit_brief';
      const notice: HeEngClientNotice = { ...base, next };
      const verticalName = await readVerticalName(db, event.verticalId);
      return {
        notice,
        alert: (sendingOff) => ({
          projectId: event.projectId,
          projectName,
          market: 'us',
          stage: event.alertStage,
          kind: 'stage_stopped',
          provider: 'pipeline',
          reason: event.reason || null,
          jobId: event.jobId,
          baseId: event.baseId,
          verticalId: event.verticalId,
          verticalName,
          eventKey: heEngClientNoticeKey(notice),
          clientSees: clientSeesText(STAGE_STOP_HEADING[event.code], next, event.code, sendingOff),
        }),
      };
    },
  };
}

/**
 * Курсор страниц намерений: project_id последней прочитанной строки; '' — круг
 * начинается сначала. В памяти процесса: после рестарта круг начинается
 * заново, и это только повторное чтение, а не повторное письмо (дедуп —
 * таблица). Шапка — «ОБЪЁМ И ПОЛНОТА».
 */
let intentCursor = '';
/** Текущий круг страниц намерений: начат (часы прохода; 0 — не начат) и сколько проходов занял. */
let intentCycle = { startedAt: 0, passes: 0 };

/** Страница включённых намерений после курсора; null — не прочиталась (или таблицы нет). */
async function readIntentPage(db: SupabaseClient): Promise<Row[] | null> {
  let query = db.from(LAUNCH_INTENT_TABLE).select('project_id, user_id, requested_at').eq('wanted', true);
  if (intentCursor) query = query.gt('project_id', intentCursor);
  const { data, error } = await query.order('project_id', { ascending: true }).limit(INTENT_PAGE);
  if (error) {
    // Нет таблицы намерения (миграция 20261012_0001 не применена) — автозапуска
    // нет, и писать этим видам не о чем.
    if (!isMissingTable(error)) void logWarn('he.eng_client_mail.intent_read_failed', errText(error));
    return null;
  }
  return (data ?? []) as Row[];
}

/**
 * Сдвинуть курсор после страницы. `advance` false — у страницы остались
 * не отправленные события (кончился бюджет отправок прохода): следующий
 * проход читает ту же страницу. Неполная страница — круг закончен: курсор
 * сначала; круг дольше одного прохода — проход упирался в INTENT_PAGE, и это
 * в лог (logBudgetHit), а круг дольше окна события за вычетом отстоя — своим
 * событием лога: событие могло выйти из окна, не дождавшись своей страницы.
 */
function advanceIntentCursor(page: Row[], advance: boolean, now: number): void {
  if (intentCycle.startedAt === 0) intentCycle = { startedAt: now, passes: 0 };
  intentCycle.passes += 1;
  if (!advance) return;
  if (page.length >= INTENT_PAGE) {
    intentCursor = str(page[page.length - 1].project_id);
    return;
  }
  const { startedAt, passes } = intentCycle;
  intentCursor = '';
  intentCycle = { startedAt: 0, passes: 0 };
  if (passes <= 1) return;
  const minutes = Math.round((now - startedAt) / 60_000);
  const late = now - startedAt > EVENT_WINDOW_MS - SETTLE_MS;
  logBudgetHit(
    late ? 'he.eng_client_mail.intent_cycle_late' : 'he.eng_client_mail.intent_cycle',
    `wanted launch intents need ${passes} passes of ${INTENT_PAGE} (${minutes} min) per full round` +
      (late ? ': longer than the event window, so some events were not emailed' : ''),
    { passes, minutes },
  );
}

/**
 * Курсор прохода по открытым эпизодам паузы (dedupe_key последней строки);
 * '' — сначала. Тот же круг, что у намерений, — в памяти процесса.
 */
let holdCursor = '';

/**
 * Закрыть эпизоды паузы, которых больше нет (шапка, «ПАУЗА АВТОПИЛОТА»):
 * открытая строка autopilot_hold, у проекта которой сейчас нет паузы или пауза
 * с другим кодом, получает closed_at, и следующая пауза того же кода — новый
 * эпизод и новое письмо. Смотрит все открытые эпизоды, а не только у проектов с
 * намерением: пауза могла сняться, пока «Launch» был отменён. Не больше
 * HOLD_PAGE строк за проход, по кругу (упор — в лог). Сбой чтения — ничего не
 * закрываем: незакрытый эпизод даёт тишину, а не лишнее письмо.
 */
async function closeClearedHolds(db: SupabaseClient, state: ScanState): Promise<void> {
  let query = db
    .from(HE_ENG_CLIENT_EMAILS_TABLE)
    .select('dedupe_key, project_id, ref_id')
    .eq('code', 'autopilot_hold')
    .is('closed_at', null);
  if (holdCursor) query = query.gt('dedupe_key', holdCursor);
  const { data, error } = await query.order('dedupe_key', { ascending: true }).limit(HOLD_PAGE);
  if (error) {
    void logWarn('he.eng_client_mail.hold_episodes_read_failed', errText(error));
    return;
  }
  const rows = (data ?? []) as Row[];
  if (rows.length >= HOLD_PAGE) {
    holdCursor = str(rows[rows.length - 1].dedupe_key);
    logBudgetHit(
      'he.eng_client_mail.hold_page_full',
      `more than ${HOLD_PAGE} open hold letters: a cleared hold is noticed within a few passes, not in this one`,
    );
  } else {
    holdCursor = '';
  }
  if (rows.length === 0) return;
  const projects = await readIn(
    [...new Set(rows.map((r) => str(r.project_id)).filter(Boolean))],
    ID_CHUNK,
    'he.eng_client_mail.hold_projects_read_failed',
    (part) => db.from('he_projects').select('id, autopilot_error, autopilot_error_at').in('id', part).limit(part.length),
  );
  if (!projects) return;
  const current = new Map(projects.rows.map((p) => [str(p.id), toClientEngAutopilotHold(p)?.code ?? null]));
  const cleared = rows
    .filter((r) => (current.get(str(r.project_id)) ?? null) !== str(r.ref_id))
    .map((r) => str(r.dedupe_key))
    .filter(Boolean);
  const closedAt = new Date(state.now).toISOString();
  for (let i = 0; i < cleared.length; i += KEY_CHUNK) {
    const { error: closeErr } = await db
      .from(HE_ENG_CLIENT_EMAILS_TABLE)
      .update({ closed_at: closedAt })
      .in('dedupe_key', cleared.slice(i, i + KEY_CHUNK))
      .is('closed_at', null);
    if (closeErr) {
      void logWarn('he.eng_client_mail.hold_close_failed', errText(closeErr));
      return;
    }
  }
}

/**
 * События проектов с действующим намерением запуска (клиент нажал Launch и
 * ждёт, что всё пойдёт само; без намерения он ведёт проект руками и видит
 * остановку на экране) — страница намерений за проход (intentCursor). Факт —
 * не старше окна, не раньше нажатия Launch и отстоялся SETTLE_MS.
 *
 *  - collect_stopped: последняя своя (не доливная) база выбранного рынка в
 *    'failed', не отменена руками, и у рынка нет идущей работы (джоба по его
 *    вертикали или базе) — иначе остановку уже поднимает повтор;
 *  - autopilot_hold: пауза автопилота с кодом из MAILED_HOLD_CODES — одно
 *    письмо на эпизод паузы (шапка, «ПАУЗА АВТОПИЛОТА»). Пауза 'retrying' —
 *    только у исследованного проекта и только продержавшаяся
 *    RETRYING_PERSIST_MS: совет «Launch» (путь идемпотентный и ставит
 *    недостающее заново) и алерт команде;
 *  - остановки платных стадий рынка — stageStopEvents.
 */
async function scanLaunchEvents(db: SupabaseClient, state: ScanState): Promise<void> {
  const page = await readIntentPage(db);
  if (!page) return;
  const intents = new Map<string, { userId: string; requestedAt: number }>();
  for (const row of page) {
    const pid = str(row.project_id);
    if (pid) intents.set(pid, { userId: str(row.user_id), requestedAt: ms(row.requested_at) });
  }
  // Сбой чтения ниже — курсор всё равно идёт дальше: страница вернётся в
  // следующем круге, а упорный сбой одной страницы не стопорит остальные.
  let finished = true;
  try {
    if (intents.size > 0) finished = await scanIntentPage(db, state, intents);
  } finally {
    advanceIntentCursor(page, finished, state.now);
  }
}

async function scanIntentPage(
  db: SupabaseClient,
  state: ScanState,
  intents: Map<string, { userId: string; requestedAt: number }>,
): Promise<boolean> {
  const since = state.now - EVENT_WINDOW_MS;
  const settled = state.now - SETTLE_MS;
  const projectRows = await readIn([...intents.keys()], ID_CHUNK, 'he.eng_client_mail.intent_projects_read_failed', (part) =>
    db
      .from('he_projects')
      .select('id, name, status, created_by, market, autopilot_error, autopilot_error_at')
      .in('id', part)
      .limit(part.length),
  );
  if (!projectRows) return true;
  const projects = projectRows.rows.filter(
    (p) => p.market === 'us' && str(p.created_by) !== '' && str(p.created_by) === intents.get(str(p.id))?.userId,
  );
  if (projects.length === 0) return true;
  const recipients = await readRecipients(db, projects.map((p) => str(p.created_by)));
  if (!recipients) return true;
  const eligible = projects.filter((p) => recipients.get(str(p.created_by))?.kind === 'ok');
  if (eligible.length === 0) return true;

  const candidates: ScanCandidate[] = [];

  // Паузы, годные в письмо по времени; эпизод — по заявкам ниже.
  const holds: Array<{ p: Row; hold: ClientEngAutopilotHold & { at: string } }> = [];
  for (const p of eligible) {
    const pid = str(p.id);
    const hold = toClientEngAutopilotHold(p);
    if (!hold || !hold.at) continue;
    const at = ms(hold.at);
    const requestedAt = intents.get(pid)?.requestedAt ?? Infinity;
    if (hold.code === 'retrying') {
      if (p.status !== 'researched') continue;
      if (at < since || at > state.now - RETRYING_PERSIST_MS || at < requestedAt) continue;
    } else {
      if (!MAILED_HOLD_CODES.has(hold.code)) continue;
      if (at < since || at > settled || at < requestedAt) continue;
    }
    holds.push({ p, hold: { code: hold.code, at: hold.at } });
  }
  if (holds.length > 0) {
    // Заявки писем о паузах этих проектов: открытый эпизод того же кода —
    // письмо уже есть; иначе номер нового эпизода — закрытые + 1. Сбой
    // чтения — писем о паузах в этом проходе нет (номер эпизода не угадываем).
    // Кусок, упёршийся в limit, — паузы его проектов ждут следующего прохода.
    const episodes = await readIn(
      [...new Set(holds.map(({ p }) => str(p.id)))],
      MANY_CHUNK,
      'he.eng_client_mail.hold_episodes_read_failed',
      (part) =>
        db
          .from(HE_ENG_CLIENT_EMAILS_TABLE)
          .select('project_id, ref_id, closed_at')
          .eq('code', 'autopilot_hold')
          .in('project_id', part)
          .limit(READ_LIMIT),
      READ_LIMIT,
    );
    for (const { p, hold } of episodes ? holds : []) {
      const pid = str(p.id);
      if (episodes?.cut.has(pid)) continue;
      const own = (episodes?.rows ?? []).filter((r) => str(r.project_id) === pid && str(r.ref_id) === hold.code);
      if (own.some((r) => !str(r.closed_at))) continue;
      const episode = own.length + 1;
      if (hold.code === 'retrying') {
        const notice: HeEngClientNotice = {
          kind: 'action_needed',
          code: 'autopilot_hold',
          projectId: pid,
          refId: hold.code,
          episode,
          next: 'launch',
        };
        candidates.push({
          notice,
          prepare: async () => ({
            notice,
            alert: (sendingOff) => ({
              projectId: pid,
              projectName: str(p.name) || null,
              market: 'us',
              stage: 'autopilot_retrying',
              kind: 'stage_stopped',
              provider: 'pipeline',
              reason: `autopilot_error=${str(p.autopilot_error)} с ${hold.at}`,
              eventKey: heEngClientNoticeKey(notice),
              clientSees: clientSeesText('Work on your project is on hold', 'launch', undefined, sendingOff),
            }),
          }),
        });
        continue;
      }
      candidates.push({
        notice: {
          kind: 'action_needed',
          code: 'autopilot_hold',
          projectId: pid,
          refId: hold.code,
          episode,
          // spend_paused ждёт команду (письмо так и говорит), остальным — Support.
          next: hold.code === 'spend_paused' ? null : 'support',
        },
      });
    }
  }

  // Упавшие базы — без доливных (они в запросе не читаются, NOT_REFILL_BASE_OR).
  // Кусок, упёршийся в limit (проекты или рынки), — события его ждут
  // следующего прохода.
  const projectIds = eligible.map((p) => str(p.id));
  const failedRows = await readIn(
    projectIds,
    MANY_CHUNK,
    'he.eng_client_mail.failed_bases_read_failed',
    (part) =>
      db
        .from('he_bases')
        .select('id, project_id, vertical_id, error, filename, updated_at, refill_flag:collect_info->>refill')
        .in('project_id', part)
        .eq('status', 'failed')
        .gte('updated_at', new Date(since).toISOString())
        .or(NOT_REFILL_BASE_OR)
        .limit(READ_LIMIT),
    READ_LIMIT,
  );
  if (failedRows) {
    const stopped = failedRows.rows.filter((b) => {
      const updated = ms(b.updated_at);
      return (
        !isRefillBase(b) &&
        toClientEngStageErrorCode(b.error) !== 'cancelled' &&
        updated <= settled &&
        updated >= (intents.get(str(b.project_id))?.requestedAt ?? Infinity)
      );
    });
    const verticalIds = [...new Set(stopped.map((b) => str(b.vertical_id)).filter(Boolean))];
    if (verticalIds.length > 0) {
      const allBases = await readIn(
        verticalIds,
        MANY_CHUNK,
        'he.eng_client_mail.collect_context_failed',
        (part) =>
          db
            .from('he_bases')
            .select('id, vertical_id, created_at, filename, refill_flag:collect_info->>refill')
            .in('vertical_id', part)
            .or(NOT_REFILL_BASE_OR)
            .limit(READ_LIMIT),
        READ_LIMIT,
      );
      const accepted = allBases
        ? await readIn(
            verticalIds,
            MANY_CHUNK,
            'he.eng_client_mail.collect_context_failed',
            (part) =>
              db
                .from('he_hypotheses')
                .select('vertical_id')
                .in('vertical_id', part)
                .eq('status', 'accepted')
                .limit(READ_LIMIT),
            READ_LIMIT,
          )
        : null;
      const activeJobs = accepted
        ? await readIn(
            [...new Set(stopped.map((b) => str(b.project_id)))],
            MANY_CHUNK,
            'he.eng_client_mail.collect_context_failed',
            (part) =>
              db
                .from('he_jobs')
                .select('project_id, vertical_id:payload->>vertical_id, base_id:payload->>base_id')
                .in('project_id', part)
                .in('status', ['pending', 'running'])
                .limit(READ_LIMIT),
            READ_LIMIT,
          )
        : null;
      if (allBases && accepted && activeJobs) {
        const selected = new Set(accepted.rows.map((h) => str(h.vertical_id)));
        for (const base of stopped) {
          const vid = str(base.vertical_id);
          const bid = str(base.id);
          const pid = str(base.project_id);
          if (allBases.cut.has(vid) || accepted.cut.has(vid) || activeJobs.cut.has(pid)) continue;
          if (!selected.has(vid)) continue;
          const lastOwn = latestBy(allBases.rows.filter((b) => str(b.vertical_id) === vid && !isRefillBase(b)), 'created_at');
          if (!lastOwn || str(lastOwn.id) !== bid) continue;
          if (activeJobs.rows.some((j) => str(j.vertical_id) === vid || str(j.base_id) === bid)) continue;
          candidates.push({
            notice: { kind: 'action_needed', code: 'collect_stopped', projectId: pid, refId: bid },
          });
        }
      }
    }
  }

  // Остановки платных стадий — только у исследованных проектов: у остальных
  // кнопки «Launch» нет, а рынки пересоздаёт research.
  const researched = eligible.filter((p) => p.status === 'researched');
  if (researched.length > 0) {
    const byProject = new Map<string, { requestedAt: number; spendPaused: boolean }>();
    const names = new Map<string, string | null>();
    for (const p of researched) {
      const pid = str(p.id);
      byProject.set(pid, {
        requestedAt: intents.get(pid)?.requestedAt ?? Infinity,
        spendPaused: toClientEngAutopilotHold(p)?.code === 'spend_paused',
      });
      names.set(pid, str(p.name) || null);
    }
    const snapshot = await readStageSnapshot(db, researched.map((p) => str(p.id)), since, (job) => {
      const endedAt = ms(job.finished_at) || ms(job.updated_at);
      const requestedAt = byProject.get(str(job.project_id))?.requestedAt ?? Infinity;
      return endedAt >= since && endedAt <= settled && endedAt >= requestedAt;
    });
    if (snapshot && snapshot.ended.length > 0) {
      const events = stageStopEvents({ snapshot, projects: byProject, since, settled, nowMs: state.now });
      for (const event of events) candidates.push(stageStopCandidate(db, event, names.get(event.projectId) ?? null));
    }
  }

  return sendCandidates(db, state, candidates);
}

/** Прогон ночного долива, а не база вертикали — тем же признаком, что у проекции кабинета. */
function isRefillBase(base: Row): boolean {
  return (
    toClientEngBase({
      filename: base.filename,
      collect_info: { refill: base.refill_flag === 'true' || base.refill_flag === true },
    }).refill === true
  );
}

/**
 * Проход писем по данным: повтор неотправленных, затем research_ready /
 * research_stopped, затем закрытие снятых эпизодов паузы и события страницы
 * намерений (collect_stopped, autopilot_hold, остановки стадий). Не больше
 * SCAN_SEND_CAP отправок за проход (остальное — в следующую минуту).
 * НЕ БРОСАЕТ; без таблицы дедупа не делает ничего.
 */
export async function runHeEngClientMailScan(
  db: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<{ sent: number; failed: number }> {
  const state: ScanState = {
    now: (opts.now ?? new Date()).getTime(),
    sent: 0,
    failed: 0,
    left: SCAN_SEND_CAP,
    memo: { bans: new Map(), blockedProjects: new Set() },
  };
  try {
    if ((await retryUnsent(db, state)) === 'missing') return { sent: 0, failed: 0 };
    await scanResearchEvents(db, state);
    await closeClearedHolds(db, state);
    await scanLaunchEvents(db, state);
  } catch (e) {
    void logWarn('he.eng_client_mail.scan_failed', errText(e));
  }
  return { sent: state.sent, failed: state.failed };
}
