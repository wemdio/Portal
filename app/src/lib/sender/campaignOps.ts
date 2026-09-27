import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { chunkForInFilter } from './inFilter';
import {
  normalizeRecipientEmail,
  normalizeRecipients,
  type ParsedRecipient,
  type RecipientInput,
} from './recipientImport';
import { applyVars, recipientVars } from './template';
import type { CampaignSourceKind } from './types';

/**
 * Операции над кампанией «Рассылки»: создание, шаги цепочки, заливка базы и
 * запуск. Живут здесь, а не в роутах, потому что вызывающих двое: форма
 * сендера (/api/tools/sender/campaigns/**) и заливка из автоаутричей RU и EN.
 * Правило у них обязано быть одно — иначе кнопка «Залить в Рассылку» пускала
 * бы в кампанию то, что форма не пустила бы.
 *
 * Ошибка для человека — SenderOpError: текст показывается оператору как есть,
 * статус роут отдаёт в ответ.
 */

export class SenderOpError extends Error {
  /** HTTP-статус, с которым роут отдаёт ошибку. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'SenderOpError';
  }
}

/** Шаг цепочки в том виде, в каком его присылает форма; проверяет prepareSteps. */
export interface CampaignStepInput {
  subject?: string;
  body?: string;
  /** Задержка от предыдущего шага в часах; у первого письма игнорируется. */
  delayHours?: number;
}

/** Проверенный шаг — ровно то, что ложится в sender_campaign_steps. */
export interface PreparedStep {
  step_no: number;
  delay_hours: number;
  subject: string;
  body: string;
}

/**
 * Править настройки и заменять базу можно только у того, что ещё не едет:
 * у черновика и у кампании на паузе. Планировщик материализует письма в
 * очередь заранее, и правка идущей кампании догнала бы только часть базы.
 */
export const EDITABLE_CAMPAIGN_STATUSES = ['draft', 'paused'];

const MAX_STEPS = 5;
/** Строк базы за одну вставку: строки едут в теле запроса, не в адресе. */
const INSERT_CHUNK = 500;
/**
 * Ящиков пула за один запрос: in-фильтр уезжает в адрес запроса, а шлюз
 * режет длинные адреса (414). id одной длины — 50 штук это ~2 КБ. Адреса
 * почты разной длины, их пачки набираются по весу (inFilter.ts).
 */
const MAILBOX_CHUNK = 50;

function requireDb() {
  if (!supabaseAdmin) throw new SenderOpError('Сервис не настроен', 503);
  return supabaseAdmin;
}

/**
 * Шаги цепочки → строки sender_campaign_steps. Шаги без текста выпадают, а
 * оставшиеся нумеруются подряд. У первого письма обязательна тема: от неё
 * строятся темы follow-up («Re: …» — template.followUpSubject).
 */
export function prepareSteps(steps: CampaignStepInput[]): PreparedStep[] {
  const list = steps.slice(0, MAX_STEPS).filter((step) => (step.body ?? '').trim());
  if (!list.length) throw new SenderOpError('Добавьте хотя бы одно письмо', 400);
  if (!(list[0].subject ?? '').trim()) throw new SenderOpError('У первого письма должна быть тема', 400);
  return list.map((step, index) => ({
    step_no: index + 1,
    delay_hours: index === 0 ? 0 : Math.max(1, Math.round(step.delayHours ?? 72)),
    subject: (step.subject ?? '').trim(),
    body: (step.body ?? '').trim(),
  }));
}

/**
 * Название, пул ящиков и шаги — без них кампании нет. Одна проверка на
 * создание и на правку: тексты ошибок оператор видит одинаковые.
 *
 * allowEmptyPool — исключение для черновика из автоаутрича (createCampaign):
 * форма и правка по-прежнему требуют ящики.
 */
export function validateCampaignDraft(
  input: { name: string; mailboxIds: string[]; steps: CampaignStepInput[] },
  opts: { allowEmptyPool?: boolean } = {},
) {
  const name = (input.name ?? '').trim();
  if (!name) throw new SenderOpError('Укажите название кампании', 400);

  const mailboxIds = [...new Set((input.mailboxIds ?? []).filter((id) => typeof id === 'string' && id))];
  if (!mailboxIds.length && !opts.allowEmptyPool) throw new SenderOpError('Выберите хотя бы один ящик', 400);

  return { name, mailboxIds, steps: prepareSteps(input.steps ?? []) };
}

async function insertSteps(campaignId: string, steps: PreparedStep[]): Promise<void> {
  const { error } = await requireDb()
    .from('sender_campaign_steps')
    .insert(steps.map((step) => ({ campaign_id: campaignId, ...step })));
  if (error) throw new SenderOpError(error.message, 500);
}

/**
 * Переписать шаги цепочки целиком: набор маленький, а разбор «что добавили,
 * что убрали» на каждое сохранение — лишний источник расхождений. Статус
 * кампании проверяет вызывающий (EDITABLE_CAMPAIGN_STATUSES).
 */
export async function replaceSteps(campaignId: string, steps: PreparedStep[]): Promise<void> {
  const { error } = await requireDb().from('sender_campaign_steps').delete().eq('campaign_id', campaignId);
  if (error) throw new SenderOpError(error.message, 500);
  await insertSteps(campaignId, steps);
}

export interface CreateCampaignInput {
  name: string;
  mailboxIds: string[];
  steps: CampaignStepInput[];
  /** Окно отправки и паузы; не заданы — значения по умолчанию, как у колонок таблицы. */
  timezone?: string;
  sendHourFrom?: number;
  sendHourTo?: number;
  /** 1 = понедельник … 7 = воскресенье. */
  sendWeekdays?: number[];
  gapSeconds?: number;
  gapJitterSeconds?: number;
  /** Папка рассылок (sender_folders) — у рассылок из автоаутрича. */
  folderId?: string | null;
  sourceKind?: CampaignSourceKind;
  /** Запуск автоаутрича (parser_jobs.id), из которого зальются получатели. */
  sourceJobId?: string | null;
  /**
   * Черновик без ящиков — только у заливки из автоаутрича. Ящики рассылка
   * берёт из папки, а там их могли ещё не выбрать (сиды папок приходят
   * пустыми), и заливка из-за этого стоять не должна. Уехать такая рассылка
   * всё равно не может: startCampaign без пула не запускает, а кнопка
   * аутрича перед запуском подставляет ящики папки.
   */
  allowEmptyPool?: boolean;
  createdBy: string | null;
}

/**
 * Новая кампания-черновик: настройки, пул ящиков и шаги. Писем не будет, пока
 * не зальют базу (importRecipients) и не запустят (startCampaign).
 */
export async function createCampaign(input: CreateCampaignInput): Promise<{ id: string }> {
  const db = requireDb();
  const { name, mailboxIds, steps } = validateCampaignDraft(input, { allowEmptyPool: input.allowEmptyPool });

  const { data: campaign, error } = await db
    .from('sender_campaigns')
    .insert({
      name,
      status: 'draft',
      timezone: input.timezone?.trim() || 'Europe/Moscow',
      send_hour_from: input.sendHourFrom ?? 9,
      send_hour_to: input.sendHourTo ?? 18,
      send_weekdays: input.sendWeekdays?.length ? input.sendWeekdays : [1, 2, 3, 4, 5],
      gap_seconds: input.gapSeconds ?? 180,
      gap_jitter_seconds: input.gapJitterSeconds ?? 120,
      folder_id: input.folderId ?? null,
      source_kind: input.sourceKind ?? 'manual',
      source_job_id: input.sourceJobId ?? null,
      created_by: input.createdBy,
    })
    .select('id')
    .single();

  if (error || !campaign) throw new SenderOpError(error?.message ?? 'Не удалось создать кампанию', 500);
  const campaignId = String(campaign.id);

  try {
    if (mailboxIds.length) {
      const { error: poolError } = await db
        .from('sender_campaign_mailboxes')
        .insert(mailboxIds.map((mailboxId) => ({ campaign_id: campaignId, mailbox_id: mailboxId })));
      if (poolError) throw new SenderOpError(poolError.message, 500);
    }

    await insertSteps(campaignId, steps);
  } catch (e) {
    // Три вставки идут без общей транзакции. Без уборки черновик без пула или
    // без шагов оставался в списке полуфабрикатом, а повторное «Создать»
    // заводило рядом второй такой же. Пул и шаги уходят каскадом.
    await db.from('sender_campaigns').delete().eq('id', campaignId);
    throw e;
  }

  return { id: campaignId };
}

export interface ImportRecipientsResult {
  /** Новых получателей добавлено в кампанию. */
  inserted: number;
  /** Годных строк: адрес корректный, не повтор, первое письмо не пустое (до стоп-листа). */
  accepted: number;
  /** Адрес некорректный. */
  skippedInvalid: number;
  /** Первое письмо у строки выходит пустым: пустое тело или пустая тема. */
  skippedEmptyLetter: number;
  /** Повтор адреса внутри этой же заливки (остаётся первое вхождение). */
  skippedDuplicates: number;
  /** Адрес в стоп-листе. */
  skippedSuppressed: number;
  /** Адрес уже стоял в этой кампании: повторная заливка его не дублирует. */
  skippedExisting: number;
  /**
   * Номера входных строк, чей адрес теперь стоит в кампании: добавлен сейчас,
   * был в ней раньше или повторяет такой адрес. Нужны заливке из аутрича,
   * чтобы отметить залитые строки, не повторяя у себя правила приведения адреса.
   */
  inCampaignRows: number[];
}

/**
 * Адреса из списка, стоящие в стоп-листе. Не прочитали — ошибка, а не пустой
 * список: иначе при сбое базы (в том числе 414 на длинном адресе запроса)
 * адреса из стоп-листа молча уехали бы в кампанию.
 */
async function loadSuppressedEmails(emails: string[]): Promise<Set<string>> {
  const db = requireDb();
  const suppressed = new Set<string>();
  for (const part of chunkForInFilter(emails)) {
    const { data, error } = await db.from('sender_suppressions').select('email').in('email', part);
    if (error) throw new SenderOpError(`Не удалось сверить базу со стоп-листом: ${error.message}`, 500);
    for (const row of data ?? []) suppressed.add(String(row.email));
  }
  return suppressed;
}

/**
 * Залить базу получателей в кампанию.
 *
 * Адреса из стоп-листа в кампанию не попадают, повторная заливка тех же
 * адресов не создаёт дублей: адрес уникален в пределах кампании.
 *
 * Строка, у которой первое письмо после подстановки выходит пустым — тело
 * или тема, — не заливается. У рассылки из автоаутрича тело шага — целиком
 * {{email_1}}, тема — {{subject_1}}, и пустая переменная означала бы письмо
 * без единого слова или без темы с нашего ящика. Шаг сверяется с тем, что
 * сохранено в кампании сейчас, поэтому шаги сохраняют до заливки базы (так
 * делают и форма, и заливка из аутрича).
 *
 * mode 'replace' заменяет базу, а не дополняет: из кампании уходят только те,
 * кому ещё ничего не планировали и не отправляли. Переписки замена не трогает
 * — иначе «перезалить базу» означало бы потерять историю по тем, кто уже
 * получил письмо и, может быть, ответил. Нет ни одной годной строки — база не
 * трогается вовсе (accepted = 0), что с этим делать, решает вызывающий.
 */
export async function importRecipients(
  campaignId: string,
  rows: RecipientInput[],
  opts: { mode: 'append' | 'replace' } = { mode: 'append' },
): Promise<ImportRecipientsResult> {
  const db = requireDb();

  const { data: campaign } = await db
    .from('sender_campaigns')
    .select('id, status')
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign) throw new SenderOpError('Кампания не найдена', 404);

  const replace = opts.mode === 'replace';
  if (replace && !EDITABLE_CAMPAIGN_STATUSES.includes(String(campaign.status))) {
    throw new SenderOpError('Заменить базу можно у черновика или остановленной кампании', 409);
  }
  // База, долитая в уже идущую кампанию, должна поехать сразу: у черновика
  // очередь выставляется в момент запуска.
  const nextStepAt = campaign.status === 'running' ? new Date().toISOString() : null;

  // Первое письмо рендерим так же, как планировщик: тело и тему. Шага нет —
  // сверять не с чем, а запуск такую кампанию и так не пропустит.
  const { data: firstStep, error: stepError } = await db
    .from('sender_campaign_steps')
    .select('subject, body')
    .eq('campaign_id', campaignId)
    .eq('step_no', 1)
    .maybeSingle();
  if (stepError) throw new SenderOpError(stepError.message, 500);
  const firstLetterFilled = firstStep
    ? (recipient: ParsedRecipient) => {
        const vars = recipientVars(recipient);
        return Boolean(
          applyVars(String(firstStep.body ?? ''), vars).trim() && applyVars(String(firstStep.subject ?? ''), vars).trim(),
        );
      }
    : undefined;

  // Пустое письмо отсеивается до поиска повторов (keep): иначе такая строка,
  // стоящая первой, вытесняла бы как «повтор» годную строку с тем же адресом.
  const parsed = normalizeRecipients(rows, { keep: firstLetterFilled });
  const recipients = parsed.recipients;

  const result: ImportRecipientsResult = {
    inserted: 0,
    accepted: recipients.length,
    skippedInvalid: parsed.invalid,
    skippedEmptyLetter: parsed.rejected,
    skippedDuplicates: parsed.duplicates,
    skippedSuppressed: 0,
    skippedExisting: 0,
    inCampaignRows: [],
  };
  if (!recipients.length) return result;

  // Стоп-лист — до любых записей: не прочитался он — замена базы не должна
  // успеть стереть старую.
  const suppressed = await loadSuppressedEmails(recipients.map((recipient) => recipient.email));

  if (replace) {
    // mailbox_id проставляется ровно в тот момент, когда планировщик завёл
    // письмо, поэтому «пустой ящик и нулевой шаг» — это и есть «мы к нему
    // ещё не прикасались».
    const { error: wipeError } = await db
      .from('sender_recipients')
      .delete()
      .eq('campaign_id', campaignId)
      .eq('last_step_sent', 0)
      .is('mailbox_id', null);
    if (wipeError) throw new SenderOpError(wipeError.message, 500);
  }

  const toInsert = recipients
    .filter((recipient) => !suppressed.has(recipient.email))
    .map((recipient) => ({
      campaign_id: campaignId,
      email: recipient.email,
      name: recipient.name,
      vars: recipient.vars,
      status: 'active',
      next_step_at: nextStepAt,
    }));

  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK);
    // ignoreDuplicates: адрес, который уже стоит в кампании, не трогаем, а в
    // ответ возвращаются только реально вставленные строки.
    const { data, error } = await db
      .from('sender_recipients')
      .upsert(chunk, { onConflict: 'campaign_id,email', ignoreDuplicates: true })
      .select('id');
    if (error) throw new SenderOpError(error.message, 500);
    result.inserted += data?.length ?? 0;
  }

  result.skippedSuppressed = suppressed.size;
  result.skippedExisting = toInsert.length - result.inserted;
  const inCampaign = new Set(toInsert.map((row) => row.email));
  rows.forEach((row, index) => {
    const email = normalizeRecipientEmail(row.email);
    if (email && inCampaign.has(email)) result.inCampaignRows.push(index);
  });
  return result;
}

/**
 * Есть ли в пуле ящик, с которого планировщик действительно будет слать:
 * прошедший проверку входа и с галочкой «берём в рассылку» — те же условия,
 * что в planner.planCampaign.
 */
async function poolHasWorkingMailbox(mailboxIds: string[]): Promise<boolean> {
  const db = requireDb();
  for (let i = 0; i < mailboxIds.length; i += MAILBOX_CHUNK) {
    const { count, error } = await db
      .from('sender_mailboxes')
      .select('id', { count: 'exact', head: true })
      .in('id', mailboxIds.slice(i, i + MAILBOX_CHUNK))
      .eq('status', 'verified')
      .eq('enabled', true);
    if (error) throw new SenderOpError(error.message, 500);
    if (count) return true;
  }
  return false;
}

/**
 * Статусы письма, при которых шаг получателя уже занят: письмо ждёт отправки
 * (scheduled, sending), упало (failed) или с неизвестным исходом (unknown).
 * Второй раз такой шаг не ставится — уникальность (recipient_id, step_no).
 * Отменённые (canceled) к этому моменту startCampaign уже удалил.
 */
const STEP_TAKEN_STATUSES = ['scheduled', 'sending', 'failed', 'unknown'];
/** Страница чтения очереди: больше PostgREST за раз не отдаёт. */
const PAGE = 1000;

/**
 * Активные получатели кампании, у которых письмо текущего шага
 * (last_step_sent + 1) уже есть, — с прочитанным last_step_sent. Отправленные
 * письма не читаются: после отправки шаг получателя сдвигается
 * (sendWorker.afterSend), а их в большой кампании десятки тысяч.
 */
async function recipientsWithTakenStep(campaignId: string): Promise<Array<{ id: string; lastStepSent: number }>> {
  const db = requireDb();
  const stepsOf = new Map<string, Set<number>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('sender_messages')
      .select('id, recipient_id, step_no')
      .eq('campaign_id', campaignId)
      .in('status', STEP_TAKEN_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new SenderOpError(error.message, 500);
    for (const row of data ?? []) {
      const recipientId = String(row.recipient_id);
      stepsOf.set(recipientId, (stepsOf.get(recipientId) ?? new Set<number>()).add(Number(row.step_no)));
    }
    if (!data || data.length < PAGE) break;
  }

  const taken: Array<{ id: string; lastStepSent: number }> = [];
  for (const part of chunkForInFilter([...stepsOf.keys()])) {
    const { data, error } = await db
      .from('sender_recipients')
      .select('id, last_step_sent')
      .in('id', part)
      .eq('status', 'active');
    if (error) throw new SenderOpError(error.message, 500);
    for (const row of data ?? []) {
      const lastStepSent = Number(row.last_step_sent);
      if (stepsOf.get(String(row.id))?.has(lastStepSent + 1)) taken.push({ id: String(row.id), lastStepSent });
    }
  }
  return taken;
}

/**
 * Запустить кампанию. Получатели, которым ещё ничего не отправляли, встают в
 * очередь немедленно: дальше их разложит по окну отправки планировщик.
 *
 * Кампанию без писем или без единого рабочего ящика не запускаем: раньше она
 * становилась «идущей» и молча не отправляла ничего — планировщик пропускал
 * её на каждом проходе, а оператор ждал писем.
 *
 * Запускается только черновик или кампания на паузе. Идущую повторно не
 * запускаем: очередь ей заново выставила бы тех, чьё письмо уже стоит в
 * очереди, — планировщик упирался бы в уникальность (recipient_id, step_no)
 * на каждом проходе. Завершённую — тоже: её письма сняты, и «запуск» молча
 * вернул бы в работу базу, которую оператор закрыл. Дата первого запуска при
 * продолжении после паузы не сдвигается.
 */
export async function startCampaign(campaignId: string): Promise<void> {
  const db = requireDb();
  const nowIso = new Date().toISOString();

  const { data: campaign, error: campaignError } = await db
    .from('sender_campaigns')
    .select('id, status, started_at')
    .eq('id', campaignId)
    .maybeSingle();
  if (campaignError) throw new SenderOpError(campaignError.message, 500);
  if (!campaign) throw new SenderOpError('Кампания не найдена', 404);
  if (campaign.status === 'running') throw new SenderOpError('Кампания уже идёт', 409);
  if (!EDITABLE_CAMPAIGN_STATUSES.includes(String(campaign.status))) {
    throw new SenderOpError('Кампания завершена — запустить её снова нельзя', 409);
  }

  const { count, error: countError } = await db
    .from('sender_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'active');
  if (countError) throw new SenderOpError(countError.message, 500);
  if (!count) throw new SenderOpError('В кампании нет получателей', 422);

  const { data: pool, error: poolError } = await db
    .from('sender_campaign_mailboxes')
    .select('mailbox_id')
    .eq('campaign_id', campaignId);
  if (poolError) throw new SenderOpError(poolError.message, 500);
  const mailboxIds = (pool ?? []).map((row) => String(row.mailbox_id));
  if (!mailboxIds.length) throw new SenderOpError('В кампании нет ящиков', 422);
  if (!(await poolHasWorkingMailbox(mailboxIds))) {
    throw new SenderOpError(
      'В пуле кампании нет проверенных ящиков: письма уходят только с ящиков, которые прошли проверку входа и отмечены галочкой',
      422,
    );
  }

  const { count: stepCount, error: stepsError } = await db
    .from('sender_campaign_steps')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);
  if (stepsError) throw new SenderOpError(stepsError.message, 500);
  if (!stepCount) throw new SenderOpError('В кампании нет шагов — добавьте хотя бы одно письмо', 422);

  // Пауза отменяет запланированные письма, но строки остаются, а у очереди
  // есть уникальность (recipient_id, step_no). Без уборки повторный запуск
  // упирался бы в неё и молча не отправлял ничего тем, кто стоял в очереди
  // на момент паузы. Отменённое письмо никуда не уходило — удаляем.
  // Обе записи проверяются до смены статуса: упали — кампания остаётся как
  // была, и повторное «Запустить» просто пройдёт их заново.
  const { error: cleanupError } = await db
    .from('sender_messages')
    .delete()
    .eq('campaign_id', campaignId)
    .eq('status', 'canceled');
  if (cleanupError) throw new SenderOpError(cleanupError.message, 500);

  const { error: requeueError } = await db
    .from('sender_recipients')
    .update({ next_step_at: nowIso, updated_at: nowIso })
    .eq('campaign_id', campaignId)
    .eq('status', 'active')
    .is('next_step_at', null);
  if (requeueError) throw new SenderOpError(requeueError.message, 500);

  // Кроме тех, чьё письмо текущего шага уже есть: пауза застаёт письма в
  // отправке (claim переводит их в unknown), бывают упавшие. Такому шагу
  // второй раз не бывать, а в очереди получатель упирался бы в уникальность
  // на каждом проходе планировщика и стоял бы в голове его выборки. Снимаем
  // после общей постановки — одним запросом по всем её не выразить; кампания
  // до смены статуса не идёт, и планировщик их в этом промежутке не видит.
  // Снимаем только тех, кто всё ещё на прочитанном шаге: письмо «в отправке»
  // могло тем временем уйти, и отправка уже назначила следующий шаг
  // (sendWorker.afterSend) — затереть его next_step_at значило оборвать цепочку.
  const byStep = new Map<number, string[]>();
  for (const { id, lastStepSent } of await recipientsWithTakenStep(campaignId)) {
    const ids = byStep.get(lastStepSent);
    if (ids) ids.push(id);
    else byStep.set(lastStepSent, [id]);
  }
  for (const [lastStepSent, ids] of byStep) {
    for (const part of chunkForInFilter(ids)) {
      const { error: holdError } = await db
        .from('sender_recipients')
        .update({ next_step_at: null, updated_at: nowIso })
        .in('id', part)
        .eq('status', 'active')
        .eq('last_step_sent', lastStepSent);
      if (holdError) throw new SenderOpError(holdError.message, 500);
    }
  }

  // Смена статуса — одним условным обновлением: из двух одновременных
  // «Запустить» (или «Запустить» и «Завершить») проходит одно, второе видит,
  // что кампания уже не черновик и не на паузе.
  const { data: switched, error } = await db
    .from('sender_campaigns')
    .update({ status: 'running', updated_at: nowIso, started_at: campaign.started_at ?? nowIso })
    .eq('id', campaignId)
    .in('status', EDITABLE_CAMPAIGN_STATUSES)
    .select('id');
  if (error) throw new SenderOpError(error.message, 500);
  if (!switched?.length) throw new SenderOpError('Кампанию уже запустили или завершили — обновите экран', 409);
}
