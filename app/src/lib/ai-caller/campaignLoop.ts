/**
 * Цикл обзвона одной кампании.
 *
 * Работает под арендой строки `ai_campaigns` (app/src/lib/jobs/lifecycle.ts):
 * тело вызывается раннером из app/worker/aiCaller.ts, а `ctx` приносит сюда
 * сигнал остановки и жетон владения. Отсюда три правила, которые здесь нельзя
 * нарушать:
 *
 *  1. Любая запись в строку КАМПАНИИ ограждена `.eq('run_token', ctx.runToken)`.
 *     Строку могли перехватить, пока мы работали, и тогда она уже не наша.
 *  2. На остановке (`ctx.signal`) не пишем терминальный статус. Кампанию
 *     продолжит другая реплика с того же места — все места хранятся в базе.
 *  3. Контакт берётся АТОМАРНО (CAS по статусу). Библиотека намеренно допускает
 *     короткое окно, когда уходящий владелец ещё работает, а сосед уже захватил
 *     строку; без захвата контакта в этом окне два исполнителя набрали бы одного
 *     и того же человека — это два платных звонка и дважды звонящий телефон.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createCall, getCall, type AiCallerProvider } from '@/lib/ai-caller-provider';
import { normalizeRuPhoneNumber } from '@/lib/phone-normalization';

const CALL_DELAY_MIN_MS = 5_000;
const CALL_DELAY_MAX_MS = 15_000;
const CALL_POLL_INTERVAL_MS = 3_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_POLL_ERRORS = 5;
const MAX_CREATE_CALL_RETRIES = 2;
/** Пауза после сбоя запроса к базе — чтобы цикл не долбил её без передышки. */
const DB_ERROR_BACKOFF_MS = 5_000;
/** Сколько ждать чужой звонок, прежде чем ещё раз свериться с провайдером. */
const FOREIGN_CALL_WAIT_MS = 30_000;
/** Звонок считается успешным, только если человек реально говорил. */
const SUCCESS_MIN_DURATION_SEC = 15;

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** Что раннер аренды даёт телу: сигнал остановки и жетон владения строкой. */
export interface CampaignRunContext {
  signal: AbortSignal;
  runToken: string;
}

/**
 * Прерываемая пауза.
 *
 * Раньше это был голый setTimeout, и остановка ждала её до конца: между
 * звонками — до 15 секунд, а внутри ожидания конца звонка — до двух минут по 3
 * секунды. Теперь сигнал будит паузу мгновенно, и деплой укладывается в свой
 * бюджет (`docker compose stop --timeout 15`), не доводя до SIGKILL.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function randomDelay(): number {
  return Math.floor(Math.random() * (CALL_DELAY_MAX_MS - CALL_DELAY_MIN_MS + 1)) + CALL_DELAY_MIN_MS;
}

/**
 * «У провайдера нет такого звонка».
 *
 * Обёртки провайдеров (lib/vapi.ts, lib/elevenlabs-convai.ts) складывают код
 * ответа в текст ошибки (`Vapi 404: …`, `ElevenLabs 404: …`), отдельного поля
 * статуса у них нет. Разбираем по коду в тексте — и ТОЛЬКО 404: любая другая
 * ошибка (сеть, 5xx, лимит) означает «не знаем», и трактовать её как «звонка не
 * было» значило бы набрать человека второй раз.
 */
function isCallNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(msg);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

interface Campaign {
  id: string;
  assistant_id: string;
  phone_number_id: string;
  provider: AiCallerProvider;
  status: string;
}

interface Contact {
  id: string;
  phone_number: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
}

/** Исход звонка в том виде, в котором он ложится в строку контакта. */
interface CallOutcome {
  duration: number | null;
  endedReason: string | null;
  hasTranscript: boolean;
}

/** Владение строкой кампании снимается тремя нулями — как это делает библиотека. */
const CLEAR_OWNERSHIP = { lease_until: null, run_token: null, worker_id: null };

/** Разобрать ответ провайдера о законченном звонке в наш исход. */
function readCallOutcome(callData: Record<string, unknown>): CallOutcome {
  const duration =
    callData.startedAt && callData.endedAt
      ? Math.round(
          (new Date(callData.endedAt as string).getTime() -
            new Date(callData.startedAt as string).getTime()) /
            1000,
        )
      : null;
  return {
    duration,
    endedReason: (callData.endedReason as string) || null,
    hasTranscript: !!((callData.transcript as string)?.trim()),
  };
}

function isSuccessfulCall(outcome: CallOutcome): boolean {
  return outcome.hasTranscript && (outcome.duration ?? 0) > SUCCESS_MIN_DURATION_SEC;
}

/**
 * Причины, которые придумываем МЫ, а не провайдер: ожидание вышло за свой
 * потолок, провайдер перестал отвечать, процесс остановили. Общее у них одно —
 * настоящего исхода звонка мы не знаем.
 *
 * Контакт с такой причиной обязан остаться в «звоним»: закрыть его — потерять
 * оплаченный разговор из отчёта, вернуть в очередь — набрать человека второй раз
 * поверх, возможно, ещё идущего звонка. Правильный ответ один — сверка при
 * следующем заходе, у неё для этого есть идентификатор звонка.
 */
const INCONCLUSIVE_REASONS = new Set(['timeout', 'poll_errors', 'stopped']);

function isInconclusive(outcome: CallOutcome): boolean {
  return outcome.endedReason != null && INCONCLUSIVE_REASONS.has(outcome.endedReason);
}

/**
 * Двинуть счётчики кампании атомарно, в самой базе.
 *
 * Раньше оба счётчика были чтением-изменением-записью из памяти процесса
 * (`calledCount++`, потом `update called_contacts = calledCount`). В окне
 * пересечения владельцев и при параллельном ручном звонке из интерфейса это
 * молча теряет инкременты: кто записал последним, тот и затёр соседа. RPC
 * делает `col = col + delta` внутри одного UPDATE — потерять инкремент нечем.
 *
 * Жетон передаётся насквозь: функция сама ограждает запись по нему, и запись
 * перехваченной кампании не проходит. `null` — для ручного пути из интерфейса,
 * у которого аренды нет.
 */
async function bumpCounters(
  db: SupabaseClient,
  campaignId: string,
  deltas: { called?: number; successful?: number },
  runToken: string | null,
  log: LogFn,
): Promise<void> {
  const { error } = await db.rpc('ai_campaign_bump_counters', {
    p_campaign_id: campaignId,
    p_called: deltas.called ?? 0,
    p_successful: deltas.successful ?? 0,
    p_run_token: runToken,
  });
  if (error) log('warn', `Не смог обновить счётчики кампании: ${error.message}`);
}

/**
 * Ждать конца звонка, опрашивая провайдера.
 *
 * Останавливается по `shouldStop()` (в том числе по сигналу раннера) и на
 * прерывании возвращает endedReason='stopped' — вызывающий обязан по нему
 * НЕ закрывать контакт, а оставить его в «звоним»: звонок продолжается у
 * провайдера, и его исход подберёт сверка при следующем захвате кампании.
 */
async function waitForCallEnd(
  callId: string,
  provider: AiCallerProvider,
  shouldStop: () => boolean,
  log: LogFn,
  signal?: AbortSignal,
): Promise<CallOutcome> {
  const start = Date.now();
  let errors = 0;

  while (!shouldStop()) {
    if (Date.now() - start > CALL_TIMEOUT_MS) {
      log('warn', `Call ${callId} timed out after ${CALL_TIMEOUT_MS}ms`);
      return { duration: null, endedReason: 'timeout', hasTranscript: false };
    }

    await sleep(CALL_POLL_INTERVAL_MS, signal);
    if (shouldStop()) break;

    let callData: Record<string, unknown>;
    try {
      callData = (await getCall(callId, provider, signal)) as Record<string, unknown>;
      errors = 0;
    } catch (err) {
      // Прерывание — не ошибка провайдера и в бюджет ошибок не идёт: выходим.
      if (isAbortError(err) || shouldStop()) break;
      errors++;
      log('warn', `Poll error #${errors} for call ${callId}: ${err instanceof Error ? err.message : String(err)}`);
      if (errors >= MAX_POLL_ERRORS) {
        return { duration: null, endedReason: 'poll_errors', hasTranscript: false };
      }
      continue;
    }

    const status = (callData.status as string) ?? '';
    if (status === 'ended' || status === 'failed') return readCallOutcome(callData);
  }

  return { duration: null, endedReason: 'stopped', hasTranscript: false };
}

/** Записать законченный звонок в строку контакта и в счётчик успехов. */
async function recordCallResult(
  db: SupabaseClient,
  campaignId: string,
  contactId: string,
  outcome: CallOutcome,
  runToken: string | null,
  log: LogFn,
): Promise<void> {
  await db
    .from('ai_campaign_contacts')
    .update({
      status: 'completed',
      call_duration: outcome.duration,
      call_ended_reason: outcome.endedReason,
    })
    .eq('id', contactId)
    // Только из «звоним»: контакт мог быть закрыт другим путём (сверкой соседа,
    // ручным завершением из интерфейса), и переписывать чужой итог нечем.
    .eq('status', 'calling');

  if (isSuccessfulCall(outcome)) {
    await bumpCounters(db, campaignId, { successful: 1 }, runToken, log);
  }
}

/** Вернуть контакт в очередь: звонка не было или он не состоялся. */
async function returnContactToQueue(
  db: SupabaseClient,
  contactId: string,
): Promise<void> {
  await db
    .from('ai_campaign_contacts')
    .update({ status: 'pending', called_at: null, vapi_call_id: null })
    .eq('id', contactId)
    .eq('status', 'calling');
}

/**
 * Сверить контакты, застрявшие в статусе «звоним», с провайдером.
 *
 * ЧТО БЫЛО ДО: `resetStuckContacts` слепо возвращала такие контакты в
 * «ожидает» и стирала идентификатор звонка. Человека набирали второй раз, а
 * первый звонок — уже оплаченный, с потерянным результатом — так и оставался
 * оплаченным. Ровно этот сброс и делал перезапуск воркера видимым для клиента:
 * повторный звонок через минуту после первого.
 *
 * ЧТО СТАЛО: спрашиваем провайдера об исходе именно этого звонка (getCall есть
 * у обоих провайдеров — lib/vapi.ts, lib/elevenlabs-convai.ts, ключи те же, что
 * у самого цикла) и записываем результат. В очередь контакт возвращается только
 * когда звонка у провайдера нет вовсе (404) либо он закончился, НЕ соединившись
 * (нет startedAt → длительности нет): такой звонок человек не увидел, и набрать
 * его — это не повтор, а первая попытка.
 *
 * Живой звонок (queued/ringing/in-progress) дожидаем обычным ожиданием: мы
 * законный владелец кампании, звонок наш, и его исход надо дописать.
 *
 * `called_contacts` здесь НЕ трогаем: его двинул прежний владелец сразу после
 * создания звонка. Если процесс умер между записью идентификатора и
 * инкрементом, счётчик недосчитает один звонок — это лучше, чем риск
 * посчитать его дважды.
 */
export async function reconcileStuckContacts(
  db: SupabaseClient,
  campaignId: string,
  provider: AiCallerProvider,
  log: LogFn,
  ctx?: CampaignRunContext,
): Promise<void> {
  const { data, error } = await db
    .from('ai_campaign_contacts')
    .select('id, vapi_call_id')
    .eq('campaign_id', campaignId)
    .eq('status', 'calling');

  if (error) {
    log('error', `Не смог прочитать незавершённые звонки: ${error.message}`);
    return;
  }
  const stuck = (data ?? []) as Array<{ id: string; vapi_call_id: string | null }>;
  if (!stuck.length) return;

  log('info', `Сверяю ${stuck.length} незавершённых звонк(а/ов) с провайдером`);
  const runToken = ctx?.runToken ?? null;
  const shouldStop = () => ctx?.signal.aborted ?? false;

  for (const contact of stuck) {
    if (shouldStop()) return;

    if (!contact.vapi_call_id) {
      // Звонок не успели создать — платить не за что, контакт свободен.
      await returnContactToQueue(db, contact.id);
      log('info', `Контакт ${contact.id}: звонок не создавался — возвращён в очередь`);
      continue;
    }

    let callData: Record<string, unknown>;
    try {
      callData = (await getCall(contact.vapi_call_id, provider, ctx?.signal)) as Record<string, unknown>;
    } catch (err) {
      if (isAbortError(err) || shouldStop()) return;
      if (isCallNotFound(err)) {
        await returnContactToQueue(db, contact.id);
        log('info', `Контакт ${contact.id}: звонка ${contact.vapi_call_id} у провайдера нет — возвращён в очередь`);
        continue;
      }
      // Провайдер не ответил. Контакт СОЗНАТЕЛЬНО оставляем в «звоним»: сверку
      // повторит следующий захват кампании, а сброс в очередь сейчас — это
      // второй звонок живому человеку по догадке.
      log(
        'error',
        `Контакт ${contact.id}: не смог свериться по звонку ${contact.vapi_call_id} — ${err instanceof Error ? err.message : String(err)}. Оставляю «звоним» до следующей сверки.`,
      );
      continue;
    }

    const status = (callData.status as string) ?? '';
    const outcome =
      status === 'ended' || status === 'failed'
        ? readCallOutcome(callData)
        : await waitForCallEnd(contact.vapi_call_id, provider, shouldStop, log, ctx?.signal);

    if (outcome.endedReason === 'stopped') return;
    if (isInconclusive(outcome)) {
      log(
        'warn',
        `Контакт ${contact.id}: исход звонка ${contact.vapi_call_id} так и не получен (${outcome.endedReason}) — остаётся «звоним» до следующей сверки`,
      );
      continue;
    }

    if (outcome.duration == null) {
      // Соединения не было (нет startedAt) — человек звонка не видел.
      await returnContactToQueue(db, contact.id);
      log('info', `Контакт ${contact.id}: звонок не состоялся (${outcome.endedReason ?? '—'}) — возвращён в очередь`);
      continue;
    }

    await recordCallResult(db, campaignId, contact.id, outcome, runToken, log);
    log(
      'info',
      `Контакт ${contact.id}: исход звонка подтянут от провайдера — ${outcome.duration}s, ${outcome.endedReason ?? '—'}`,
    );
  }
}

type ContactClaim =
  | { kind: 'claimed'; contact: Contact }
  | { kind: 'empty' }
  | { kind: 'lost' }
  | { kind: 'failed' };

/**
 * Взять следующий контакт АТОМАРНО.
 *
 * Отбор кандидата остался прежним (`campaign_id` + `status='pending'` +
 * порядок по created_at) — ровно под частичный индекс
 * `ai_campaign_contacts_status_idx (campaign_id, status) where status='pending'`.
 * Новое здесь — второй запрос: перевод в «звоним» идёт условием
 * `.eq('status','pending')`, то есть CAS. Строку получит ровно один
 * исполнитель, остальные увидят ноль строк и возьмут следующий контакт.
 *
 * CAS индексу не мешает: он бьёт по первичному ключу (`id`), а частичный индекс
 * обслуживает первый запрос, где предикат `status='pending'` остался
 * равенством и по-прежнему покрывается индексом.
 */
async function claimNextContact(
  db: SupabaseClient,
  campaignId: string,
): Promise<ContactClaim> {
  const { data: candidate, error: selectError } = await db
    .from('ai_campaign_contacts')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (selectError) return { kind: 'failed' };
  if (!candidate) return { kind: 'empty' };

  const { data: claimed, error: casError } = await db
    .from('ai_campaign_contacts')
    .update({ status: 'calling', called_at: new Date().toISOString() })
    .eq('id', candidate.id)
    .eq('status', 'pending')
    .select('id, phone_number, company_name, contact_name, email')
    .maybeSingle();

  // Ошибку запроса нельзя считать проигранной гонкой: ноль строк из-за сбоя
  // ничего не говорит об очереди.
  if (casError) return { kind: 'failed' };
  return claimed ? { kind: 'claimed', contact: claimed as Contact } : { kind: 'lost' };
}

/**
 * Сколько контактов кампании прямо сейчас в статусе «звоним».
 *
 * null — не смогли посчитать. Отдельно от нуля намеренно: ноль разрешает
 * закрыть кампанию как завершённую, и списать сбой запроса на «звонящих нет»
 * значило бы закрыть её с потерянным контактом в отчёте.
 */
async function countCallingContacts(
  db: SupabaseClient,
  campaignId: string,
): Promise<number | null> {
  const { count, error } = await db
    .from('ai_campaign_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'calling');
  return error ? null : (count ?? 0);
}

/**
 * Цикл обзвона кампании. Тело задачи раннера аренды.
 *
 * Статус `running` тело НЕ пишет: строка уже в нём — именно поэтому раннер её и
 * захватил. Прежняя безусловная запись `status='running'` на входе была
 * механизмом воскрешения: залежавшаяся команда «старт» поднимала кампанию,
 * которую оператор остановил.
 */
export async function runCampaignLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  log: LogFn,
  ctx: CampaignRunContext,
) {
  const { data: campaign, error: cErr } = await db
    .from('ai_campaigns')
    .select('id, assistant_id, phone_number_id, provider, status')
    .eq('id', campaignId)
    .single();

  if (cErr || !campaign) {
    log('error', `Campaign ${campaignId} not found`);
    return;
  }

  const camp = campaign as Campaign;

  /**
   * Запись в строку кампании, ограждённая жетоном владения.
   *
   * `onlyWhileRunning` добавляет второе условие и обязателен для записей,
   * которые МЕНЯЮТ статус: между чтением статуса и этой записью оператор мог
   * нажать «Пауза», и без условия мы бы затёрли его решение своим
   * «завершено». Для снятия владения условие, наоборот, вредно — там статус уже
   * не `running`, в том и дело.
   */
  const writeCampaign = async (
    patch: Record<string, unknown>,
    opts: { onlyWhileRunning?: boolean } = {},
  ) => {
    let query = db
      .from('ai_campaigns')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', campaignId)
      .eq('run_token', ctx.runToken);
    if (opts.onlyWhileRunning) query = query.eq('status', 'running');
    const { error } = await query;
    if (error) log('error', `Не смог записать в кампанию ${campaignId}: ${error.message}`);
  };

  const providerKey = camp.provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'VAPI_API_KEY';
  if (!process.env[providerKey]) {
    log('error', `${providerKey} not set — cannot make calls`);
    await writeCampaign({ status: 'paused', ...CLEAR_OWNERSHIP }, { onlyWhileRunning: true });
    return;
  }

  await reconcileStuckContacts(db, campaignId, camp.provider, log, ctx);
  if (shouldStop()) return;

  log('info', `Campaign "${campaignId}" loop started (provider: ${camp.provider})`);
  let waitingForForeignCallLogged = false;

  while (!shouldStop()) {
    // Кампанию могли остановить снаружи (кнопка «Пауза» пишет статус напрямую).
    const { data: fresh, error: freshError } = await db
      .from('ai_campaigns')
      .select('status')
      .eq('id', campaignId)
      .maybeSingle();

    if (freshError) {
      log('warn', `Не смог перечитать статус кампании: ${freshError.message}`);
      await sleep(DB_ERROR_BACKOFF_MS, ctx.signal);
      continue;
    }

    if (fresh?.status !== 'running') {
      log('info', `Campaign status changed to "${fresh?.status ?? '—'}" — exiting loop`);
      // Статус не наш, а оператора: трогаем только владение, чтобы строка не
      // осталась с живой арендой и мёртвым исполнителем.
      await writeCampaign(CLEAR_OWNERSHIP);
      return;
    }

    const claim = await claimNextContact(db, campaignId);

    if (claim.kind === 'failed') {
      log('warn', 'Запрос захвата контакта не выполнился — повторю через паузу');
      await sleep(DB_ERROR_BACKOFF_MS, ctx.signal);
      continue;
    }

    // Контакт увели — в очереди было что брать, идём за следующим. Короткая
    // пауза: круг стоит три запроса, и без неё проигранная гонка крутила бы их
    // без передышки.
    if (claim.kind === 'lost') {
      await sleep(500, ctx.signal);
      continue;
    }

    if (claim.kind === 'empty') {
      // Ожидающих нет, но кто-то может ещё звонить: в окне пересечения
      // владельцев сосед держит контакт в «звоним». Объявить кампанию
      // завершённой сейчас — потерять этот контакт из отчёта.
      const calling = await countCallingContacts(db, campaignId);
      if (calling === null || calling > 0) {
        if (!waitingForForeignCallLogged) {
          waitingForForeignCallLogged = true;
          log('info', `Ожидающих контактов нет, но ${calling ?? '?'} ещё в звонке — жду и сверяю, кампанию не закрываю`);
        }
        await sleep(FOREIGN_CALL_WAIT_MS, ctx.signal);
        if (shouldStop()) return;
        await reconcileStuckContacts(db, campaignId, camp.provider, log, ctx);
        continue;
      }
      await writeCampaign({ status: 'completed', ...CLEAR_OWNERSHIP }, { onlyWhileRunning: true });
      log('info', 'All contacts processed — campaign completed');
      return;
    }

    const c = claim.contact;
    const phone = normalizeRuPhoneNumber(c.phone_number);

    if (!phone) {
      log('warn', `Invalid phone "${c.phone_number}" for contact ${c.id}, marking failed`);
      await db.from('ai_campaign_contacts').update({ status: 'failed' }).eq('id', c.id);
      continue;
    }

    log('info', `Calling ${phone} (contact ${c.id}, company: ${c.company_name ?? '—'})`);

    /*
     * Создание звонка СОЗНАТЕЛЬНО идёт без ctx.signal — в отличие от чтений
     * исхода ниже.
     *
     * Оборвать POST — не значит отменить звонок: провайдер мог его уже принять,
     * а мы бы об этом не узнали и вернули контакт в очередь. Следующий
     * исполнитель набрал бы человека второй раз — ровно то, ради чего вся эта
     * задача и делается. Запрос короткий, ждать его конца дешевле; на сигнал мы
     * смотрим МЕЖДУ попытками, где звонка в полёте нет.
     */
    let callId: string | null = null;
    for (let attempt = 0; attempt <= MAX_CREATE_CALL_RETRIES; attempt++) {
      if (shouldStop()) break;
      try {
        const call = await createCall(
          {
            assistantId: camp.assistant_id,
            phoneNumberId: camp.phone_number_id,
            customer: { number: phone },
            contactData: {
              contactName: c.contact_name || undefined,
              companyName: c.company_name || undefined,
              email: c.email || undefined,
            },
          },
          camp.provider,
        );
        callId = (call as Record<string, string>).id;
        break;
      } catch (err) {
        if (isAbortError(err) || shouldStop()) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_CREATE_CALL_RETRIES) {
          log('warn', `createCall attempt ${attempt + 1} failed: ${msg}, retrying...`);
          await sleep(2_000, ctx.signal);
        } else {
          log('error', `createCall failed after ${MAX_CREATE_CALL_RETRIES + 1} attempts: ${msg}`);
        }
      }
    }

    if (!callId) {
      // Остановка застала нас до создания звонка — контакт возвращаем в
      // очередь, иначе он навсегда остался бы «звонящим» без звонка.
      if (shouldStop()) {
        await returnContactToQueue(db, c.id);
        return;
      }
      await db.from('ai_campaign_contacts').update({ status: 'failed' }).eq('id', c.id);
      continue;
    }

    // Идентификатор звонка пишем ДО инкремента: именно по нему сверка узнаёт,
    // что звонок был, и не набирает человека второй раз.
    await db.from('ai_campaign_contacts').update({ vapi_call_id: callId }).eq('id', c.id);
    await bumpCounters(db, campaignId, { called: 1 }, ctx.runToken, log);

    const result = await waitForCallEnd(callId, camp.provider, shouldStop, log, ctx.signal);

    if (result.endedReason === 'stopped') {
      // Остановка посреди звонка. Контакт остаётся в «звоним» с живым
      // идентификатором: исход подтянет сверка при следующем захвате.
      log('info', `Остановка во время звонка ${callId} — исход подтянет сверка`);
      return;
    }

    if (isInconclusive(result)) {
      // Ожидание вышло за потолок или провайдер замолчал. Раньше контакт в этом
      // месте закрывался как «completed» с пустой длительностью — оплаченный
      // разговор пропадал из отчёта. Теперь он остаётся «звоним», и его исход
      // допишет сверка: идентификатор звонка для этого уже сохранён.
      log('warn', `Звонок ${callId} без исхода (${result.endedReason}) — контакт остаётся «звоним» до сверки`);
    } else {
      await recordCallResult(db, campaignId, c.id, result, ctx.runToken, log);
      log(
        'info',
        `Call completed: ${phone}, duration=${result.duration ?? '?'}s, reason=${result.endedReason ?? '?'}, success=${isSuccessfulCall(result)}`,
      );
    }

    if (shouldStop()) break;

    const delay = randomDelay();
    log('info', `Next call in ${Math.round(delay / 1000)}s`);
    await sleep(delay, ctx.signal);
  }

  log('info', 'Campaign loop stopped (shouldStop signal)');
}
