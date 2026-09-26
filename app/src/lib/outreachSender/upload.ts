import 'server-only';

import type { OutreachLang } from '@/lib/outreachLlm/types';
import { RU_OUTREACH_PARSER_TYPE } from '@/lib/polzaRuOutreach/types';
import {
  createCampaign,
  EDITABLE_CAMPAIGN_STATUSES,
  importRecipients,
  SenderOpError,
  startCampaign,
  type CampaignStepInput,
  type ImportRecipientsResult,
} from '@/lib/sender/campaignOps';
import { fillPoolFromFolder } from '@/lib/sender/folders';
import { chunkForInFilter } from '@/lib/sender/inFilter';
import { normalizeRecipientEmail, type RecipientInput } from '@/lib/sender/recipientImport';
import type { CampaignSourceKind } from '@/lib/sender/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Автоаутрич RU / EN → «Рассылка»: заливка готовых компаний запуска в
 * рассылку папки «Автоаутрич RU/EN» и запуск рассылки по кнопке
 * (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md, §5).
 *
 * Правила самой рассылки — создание, стоп-лист, дубли, пустое первое письмо,
 * проверки запуска — здесь не повторяются, а берутся из lib/sender/campaignOps:
 * кнопка аутрича не должна пускать в рассылку то, чего не пустила бы форма
 * «Рассылки». Здесь только то, что знает аутрич: какие строки готовы, как из
 * строки получается получатель и какие строки уже залиты.
 *
 * Цепочка у каждой компании своя, поэтому письма едут в переменных получателя
 * (subject_1, email_1..email_4), а шаги рассылки — просто {{email_N}}: одна
 * рассылка везёт письма всех компаний запуска.
 */

export type { OutreachLang };

interface OutreachRow {
  id: string;
  email: string;
  /** Как компанию зовут в письме: у RU бренд, у EN название. */
  company: string;
  domain: string;
  letters: unknown;
}

interface OutreachSource {
  /** Язык в названии рассылки: «RU · 26.09 · 500 компаний». */
  label: string;
  parserType: string;
  table: string;
  folderKey: string;
  sourceKind: CampaignSourceKind;
  /** Колонка с адресом компании. */
  emailColumn: string;
  /** Условия «строка готова» помимо адреса: колонка = значение. */
  readyEq: Array<[column: string, value: string]>;
  /** Колонка — одно из значений. */
  readyIn: Array<[column: string, values: string[]]>;
  /** Колонки, которые обязаны быть заполнены. */
  readyNotNull: string[];
  /** Колонки строки, нужные для получателя. */
  columns: string;
  toRow: (raw: Record<string, unknown>) => OutreachRow;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/*
 * В рассылку идут только строки нового конвейера (с 26.09.2026): письма
 * собраны по шаблону цепочки оффера (chain_template_id заполнен), а почта
 * прошла портальную проверку. У запусков до 26.09 почту никто не проверял, а
 * их готовые строки могли уже уйти в работу выгрузкой в Excel — «залить» такой
 * старый запуск значило бы написать компаниям второй раз и с непроверенных
 * адресов. unverified — «не удалось проверить» — у обоих аутричей уходит в
 * спорные и сюда не попадает и так; crm_contact у русского — адрес контакта
 * из AMO: его не проверяют, это наш собственный контакт.
 */
const SOURCES: Record<OutreachLang, OutreachSource> = {
  ru: {
    label: 'RU',
    parserType: RU_OUTREACH_PARSER_TYPE,
    table: 'polza_ru_outreach_companies',
    folderKey: 'auto_ru',
    sourceKind: 'polza_ru',
    emailColumn: 'recipient_email',
    // Готовая — прошла все этапы и автопроверку писем. «Спорные» (doubtful) и
    // ручная проверка остаются за человеком и в рассылку не идут.
    readyEq: [
      ['row_status', 'ready'],
      ['qa_status', 'passed'],
    ],
    readyIn: [['email_verification', ['ok', 'catch_all', 'crm_contact']]],
    readyNotNull: ['chain_template_id'],
    columns: 'id, recipient_email, company_brand, company_name, normalized_domain, letters',
    toRow: (raw) => ({
      id: String(raw.id),
      email: text(raw.recipient_email),
      // Бренд — так компанию называют в письмах; юрлицо — запасной вариант.
      company: text(raw.company_brand) || text(raw.company_name),
      domain: text(raw.normalized_domain),
      letters: raw.letters,
    }),
  },
  en: {
    label: 'EN',
    parserType: 'polza_outreach',
    table: 'polza_outreach_companies',
    folderKey: 'auto_en',
    sourceKind: 'polza_en',
    emailColumn: 'selected_company_email',
    // needs_review (почта не проверена, письма не прошли гарды, сверх лимита)
    // — к человеку, в рассылку не идёт.
    readyEq: [['status', 'ready']],
    readyIn: [['email_verification', ['ok', 'catch_all']]],
    readyNotNull: ['chain_template_id'],
    columns: 'id, selected_company_email, company_name, normalized_domain, letters',
    toRow: (raw) => ({
      id: String(raw.id),
      email: text(raw.selected_company_email),
      company: text(raw.company_name),
      domain: text(raw.normalized_domain),
      letters: raw.letters,
    }),
  },
};

/** Писем в цепочке у обоих аутричей; у рассылки столько же шагов. */
const LETTERS = 4;
/** Задержка письма, если в папке её нет: день, как в сидах папок. */
const DEFAULT_DELAY_HOURS = 24;
/** Страница чтения строк: больше PostgREST за раз не отдаёт. */
const PAGE = 1000;
/**
 * Ящиков за один запрос — как MAILBOX_CHUNK в campaignOps. id и адреса почты
 * в остальных in-фильтрах режутся по весу (sender/inFilter.ts): они уезжают в
 * адрес запроса, а шлюз режет длинные адреса (414).
 */
const MAILBOX_CHUNK = 50;
/** Запуск закончился — строки больше не меняются, заливать можно. */
const FINISHED_JOB_STATUSES = ['completed', 'failed'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function db() {
  if (!supabaseAdmin) throw new SenderOpError('Сервис не настроен', 503);
  return supabaseAdmin;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── Запуск, папка, строки ───────────────────────────────────────────────────

interface JobRow {
  id: string;
  createdAt: string;
  status: string;
}

async function loadJob(source: OutreachSource, jobId: string): Promise<JobRow> {
  // Кривой id дал бы 500 «invalid input syntax for type uuid» вместо понятного ответа.
  if (!UUID_RE.test(jobId)) throw new SenderOpError('Запуск не найден', 404);
  const { data, error } = await db()
    .from('parser_jobs')
    .select('id, created_at, status')
    .eq('id', jobId)
    .eq('parser_type', source.parserType)
    .maybeSingle();
  if (error) throw new SenderOpError(error.message, 500);
  if (!data) throw new SenderOpError('Запуск не найден', 404);
  return { id: String(data.id), createdAt: String(data.created_at), status: String(data.status) };
}

interface FolderRow {
  id: string;
  name: string;
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  send_weekdays: number[];
  gap_seconds: number;
  gap_jitter_seconds: number;
  step_delays_hours: number[] | null;
  mailbox_ids: string[] | null;
}

async function loadFolder(source: OutreachSource): Promise<FolderRow> {
  // Папку ищем по ключу, а не по названию: название на экране могут поменять.
  const { data, error } = await db()
    .from('sender_folders')
    .select('id, name, timezone, send_hour_from, send_hour_to, send_weekdays, gap_seconds, gap_jitter_seconds, step_delays_hours, mailbox_ids')
    .eq('key', source.folderKey)
    .maybeSingle();
  if (error) throw new SenderOpError(error.message, 500);
  if (!data) {
    throw new SenderOpError(`В «Рассылке» нет папки «Автоаутрич ${source.label}» (${source.folderKey})`, 500);
  }
  return data as FolderRow;
}

/**
 * Ящики папки, которые ещё существуют, в порядке выбора, и сколько из них
 * может слать прямо сейчас. У элементов mailbox_ids нет внешнего ключа
 * (миграция 20260926_0002): удалённый ящик остаётся в массиве, и без сверки
 * вставка пула рассылки упала бы на внешнем ключе sender_campaign_mailboxes.
 * «Может слать» — проверен и с галочкой, те же условия, что у планировщика.
 */
async function folderMailboxes(folder: FolderRow): Promise<{ ids: string[]; working: number }> {
  const wanted = [...new Set((folder.mailbox_ids ?? []).map(String))];
  const canSend = new Map<string, boolean>();
  for (const part of chunks(wanted, MAILBOX_CHUNK)) {
    const { data, error } = await db().from('sender_mailboxes').select('id, status, enabled').in('id', part);
    if (error) throw new SenderOpError(error.message, 500);
    for (const row of data ?? []) canSend.set(String(row.id), row.status === 'verified' && row.enabled === true);
  }
  const ids = wanted.filter((id) => canSend.has(id));
  return { ids, working: ids.filter((id) => canSend.get(id)).length };
}

/** Методы фильтра PostgREST, нужные условию «строка готова»; все возвращают сам запрос. */
interface ReadyFilterable {
  eq(column: string, value: unknown): ReadyFilterable;
  in(column: string, values: unknown[]): ReadyFilterable;
  not(column: string, operator: string, value: unknown): ReadyFilterable;
}

/**
 * Условие «строка готова к заливке» — одно на чтение и на отметку строк:
 * отметка повторяет его, чтобы не застолбить строку, которая между чтением и
 * отметкой перестала быть готовой (переписанная цепочка, ручная правка).
 * Строка без адреса готовой не бывает, но проверка здесь дешевле разбора.
 */
function applyReady<Q>(query: Q, source: OutreachSource): Q {
  let filtered = (query as unknown as ReadyFilterable).not(source.emailColumn, 'is', null);
  for (const [column, value] of source.readyEq) filtered = filtered.eq(column, value);
  for (const [column, values] of source.readyIn) filtered = filtered.in(column, values);
  for (const column of source.readyNotNull) filtered = filtered.not(column, 'is', null);
  return filtered as unknown as Q;
}

/** Готовые строки запуска — отбор для заливки и для экрана один. */
function readyQuery(source: OutreachSource, jobId: string, columns: string, count?: 'exact') {
  return applyReady(
    db()
      .from(source.table)
      .select(columns, count ? { count, head: true } : undefined)
      .eq('job_id', jobId),
    source,
  );
}

/**
 * Готовые строки, ещё не залитые ни в одну рассылку, — все, по страницам.
 * Порядок устойчивый (время, потом id): иначе страницы range() могли бы
 * потерять или повторить строку, а при общей почте у двух компаний первой в
 * заливке считается та, что готова раньше.
 */
async function loadPendingRows(source: OutreachSource, jobId: string): Promise<OutreachRow[]> {
  const rows: OutreachRow[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await readyQuery(source, jobId, source.columns)
      .is('sender_campaign_id', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new SenderOpError(error.message, 500);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const raw of page) {
      // Пока запуск идёт, строки становятся готовыми между страницами и
      // сдвигают их — одна и та же строка может прийти дважды.
      const row = source.toRow(raw);
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

async function countUploaded(source: OutreachSource, jobId: string): Promise<number> {
  const { count, error } = await readyQuery(source, jobId, 'id', 'exact').not('sender_campaign_id', 'is', null);
  if (error) throw new SenderOpError(error.message, 500);
  return count ?? 0;
}

// ── Строка аутрича → получатель рассылки ────────────────────────────────────

function letterAt(letters: unknown, n: number): { subject: string; body: string } | null {
  if (!Array.isArray(letters)) return null;
  const found = letters.find(
    (item) => item !== null && typeof item === 'object' && Number((item as { n?: unknown }).n) === n,
  ) as { subject?: unknown; body?: unknown } | undefined;
  if (!found) return null;
  return { subject: text(found.subject), body: text(found.body) };
}

/**
 * Получатель из готовой строки. Строку без темы или без текста первого
 * письма не пропустит importRecipients: шаг 1 рассылки — тема {{subject_1}} и
 * тело {{email_1}}, и пустое после подстановки первое письмо в рассылку не
 * льётся (skippedEmptyLetter) — правило одно с формой «Рассылки».
 * Недостающее письмо 2–4 — пустая строка: такой шаг планировщик не
 * отправляет, и цепочка для компании просто кончается раньше.
 */
function recipientOf(row: OutreachRow): RecipientInput {
  const vars: Record<string, string> = {
    subject_1: letterAt(row.letters, 1)?.subject ?? '',
    company: row.company,
    domain: row.domain,
  };
  for (let n = 1; n <= LETTERS; n += 1) vars[`email_${n}`] = letterAt(row.letters, n)?.body ?? '';
  return { email: row.email, name: row.company || null, vars };
}

// ── Новая рассылка ──────────────────────────────────────────────────────────

const MSK_DAY_MONTH = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });

function companiesLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} компания`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} компании`;
  return `${count} компаний`;
}

/** «RU · 26.09 · 500 компаний»: язык, день запуска по Москве, сколько компаний заливали. */
function campaignNameFor(source: OutreachSource, jobCreatedAt: string, companies: number): string {
  return `${source.label} · ${MSK_DAY_MONTH.format(new Date(jobCreatedAt))} · ${companiesLabel(companies)}`;
}

/**
 * Шаги рассылки: письмо 1 со своей темой, письма 2–4 — с пустой темой, то
 * есть ответом в той же ветке («Re: …», template.followUpSubject). Задержки —
 * из папки: [24,24,24] — это дни 0, +1, +2, +3.
 */
function chainSteps(folder: FolderRow): CampaignStepInput[] {
  const steps: CampaignStepInput[] = [{ subject: '{{subject_1}}', body: '{{email_1}}' }];
  for (let n = 2; n <= LETTERS; n += 1) {
    const delay = Number(folder.step_delays_hours?.[n - 2]);
    steps.push({
      subject: '',
      body: `{{email_${n}}}`,
      delayHours: Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_DELAY_HOURS,
    });
  }
  return steps;
}

// ── Отметки строк ───────────────────────────────────────────────────────────

/**
 * Застолбить строки за рассылкой до заливки. Обновляются только строки без
 * отметки, и в ответ приходят именно они: два одновременных нажатия (две
 * вкладки, два человека) не зальют одни и те же компании в две рассылки —
 * вторая получит только то, что не успела взять первая. Иначе после первой
 * цепочки компания получила бы вторую такую же с другого ящика.
 */
async function claimRows(
  source: OutreachSource,
  jobId: string,
  ids: string[],
  campaignId: string,
  claimed: string[],
): Promise<void> {
  const uploadedAt = new Date().toISOString();
  for (const part of chunkForInFilter(ids)) {
    const { data, error } = await applyReady(
      db()
        .from(source.table)
        .update({ sender_campaign_id: campaignId, sender_uploaded_at: uploadedAt })
        .eq('job_id', jobId)
        .in('id', part)
        .is('sender_campaign_id', null),
      source,
    ).select('id');
    if (error) throw new SenderOpError(error.message, 500);
    // Пополняем список вызывающего сразу: если следующая пачка упадёт, он
    // знает, что снимать.
    for (const row of data ?? []) claimed.push(String(row.id));
  }
}

/**
 * Снять отметку заливки — вместе с датой, иначе у незалитой строки осталась
 * бы «дата заливки». campaignId — снимаем только отметку этой рассылки; null —
 * рассылку уже удалили, внешний ключ обнулил ссылку, осталась дата.
 */
async function releaseRows(source: OutreachSource, ids: string[], campaignId: string | null): Promise<void> {
  for (const part of chunkForInFilter(ids)) {
    const query = db()
      .from(source.table)
      .update({ sender_campaign_id: null, sender_uploaded_at: null })
      .in('id', part);
    const { error } = await (campaignId ? query.eq('sender_campaign_id', campaignId) : query.is('sender_campaign_id', null));
    if (error) throw new SenderOpError(error.message, 500);
  }
}

/**
 * Строки, чей адрес уже стоит в рассылке. Нужны уборке после сбоя доливки:
 * часть получателей могла лечь до сбоя, и снять с их строк отметку значило бы
 * залить эти компании второй раз, например в новую рассылку.
 */
async function rowsAlreadyInCampaign(
  campaignId: string,
  rows: Array<{ id: string; recipient: RecipientInput }>,
): Promise<Set<string>> {
  const byEmail = new Map<string, string[]>();
  for (const row of rows) {
    const email = normalizeRecipientEmail(row.recipient.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), row.id]);
  }
  const inCampaign = new Set<string>();
  for (const part of chunkForInFilter([...byEmail.keys()])) {
    const { data, error } = await db()
      .from('sender_recipients')
      .select('email')
      .eq('campaign_id', campaignId)
      .in('email', part);
    if (error) throw new SenderOpError(error.message, 500);
    for (const row of data ?? []) for (const id of byEmail.get(String(row.email)) ?? []) inCampaign.add(id);
  }
  return inCampaign;
}

// ── Заливка ─────────────────────────────────────────────────────────────────

export interface UploadJobInput {
  lang: OutreachLang;
  jobId: string;
  /** new — новая рассылка в папке; append — долить в существующую рассылку папки. */
  mode: 'new' | 'append';
  /** Для append: рассылка папки аутрича в статусе черновика или паузы. */
  campaignId?: string | null;
  userId: string | null;
}

export interface UploadJobResult {
  campaignId: string;
  campaignName: string;
  folderName: string;
  mode: 'new' | 'append';
  /** Строк запуска в этой заливке. */
  rows: number;
  /** Новых получателей в рассылке. */
  inserted: number;
  /** Адрес в стоп-листе: строка не помечена и зальётся, если адрес уберут из стоп-листа. */
  skippedSuppressed: number;
  /** Адрес уже стоял в рассылке — строка помечена залитой. */
  skippedExisting: number;
  /** У двух компаний одна почта: письмо получит первая, обе строки помечены. */
  skippedDuplicates: number;
  /** Некорректный адрес — строка не помечена. */
  skippedInvalid: number;
  /** Первое письмо без темы или без текста — строка не помечена. */
  skippedEmptyLetter: number;
  /** Готовых строк запуска, залитых раньше: второй раз они не льются. */
  alreadyUploaded: number;
}

async function appendTarget(folder: FolderRow, campaignId: string | null | undefined) {
  if (!campaignId) throw new SenderOpError('Выберите рассылку, в которую добавить компании', 400);
  if (!UUID_RE.test(campaignId)) throw new SenderOpError('Рассылка не найдена', 404);
  const { data, error } = await db()
    .from('sender_campaigns')
    .select('id, name, status, folder_id')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new SenderOpError(error.message, 500);
  if (!data) throw new SenderOpError('Рассылка не найдена', 404);
  if (String(data.folder_id ?? '') !== folder.id) {
    throw new SenderOpError(`Добавлять можно только в рассылку папки «${folder.name}»`, 409);
  }
  // Как у правки рассылки: идущая материализует письма заранее, и долитые
  // компании смешались бы с очередью на ходу — сначала пауза.
  const status = String(data.status);
  if (status === 'running') {
    throw new SenderOpError('Рассылка идёт — чтобы долить в неё компании, сначала поставьте её на паузу', 409);
  }
  if (!EDITABLE_CAMPAIGN_STATUSES.includes(status)) {
    throw new SenderOpError('Рассылка завершена — выберите другую или создайте новую', 409);
  }
  return { id: String(data.id), name: String(data.name) };
}

function nothingLandedMessage(result: ImportRecipientsResult): string {
  const parts: string[] = [];
  if (result.skippedSuppressed) parts.push(`в стоп-листе — ${result.skippedSuppressed}`);
  if (result.skippedInvalid) parts.push(`некорректный адрес — ${result.skippedInvalid}`);
  if (result.skippedEmptyLetter) parts.push(`первое письмо без темы или текста — ${result.skippedEmptyLetter}`);
  return `Ни одна компания не попала в рассылку${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * «Залить в Рассылку»: готовые строки запуска, ещё не залитые, — в новую
 * рассылку папки (mode 'new') или в существующую (mode 'append').
 *
 * Только после окончания запуска: пока он идёт, воркер ещё меняет строки —
 * готовая может уйти в «сверх лимита» или в спорные, а письма пересобираются.
 * Залитое до этого уехало бы в рассылку в промежуточном виде.
 *
 * Новая рассылка берёт из папки расписание, паузы, задержки писем и ящики.
 * Рабочих ящиков в папке может ещё не быть — черновик создаётся всё равно
 * (заливка не стоит) и с пустым пулом, а понятная ошибка «Выберите ящики в
 * настройках папки» приходит на запуске (startJobCampaign).
 *
 * Строки помечаются рассылкой (sender_campaign_id, sender_uploaded_at), если
 * адрес теперь в ней: добавлен сейчас, уже стоял или повторяет такой адрес.
 * Стоп-лист, некорректный адрес и пустое первое письмо не помечаются —
 * повторное нажатие их снова попробует, а доливает только новые готовые строки.
 */
export async function uploadJobToSender(input: UploadJobInput): Promise<UploadJobResult> {
  const source = SOURCES[input.lang];
  const job = await loadJob(source, input.jobId);
  if (!FINISHED_JOB_STATUSES.includes(job.status)) {
    throw new SenderOpError('Заливать можно после окончания запуска', 409);
  }
  const folder = await loadFolder(source);
  const target = input.mode === 'append' ? await appendTarget(folder, input.campaignId) : null;

  const [pending, alreadyUploaded] = await Promise.all([loadPendingRows(source, job.id), countUploaded(source, job.id)]);
  if (!pending.length) {
    throw new SenderOpError(
      alreadyUploaded ? 'Все готовые компании запуска уже залиты в «Рассылку»' : 'В запуске пока нет готовых компаний',
      409,
    );
  }
  const candidates = pending.map((row) => ({ id: row.id, recipient: recipientOf(row) }));

  let campaignId: string;
  let campaignName: string;
  if (target) {
    campaignId = target.id;
    campaignName = target.name;
  } else {
    // Пул — только если в папке есть рабочий ящик. Иначе рассылка остаётся с
    // пустым пулом и возьмёт ящики папки при запуске (fillPoolFromFolder):
    // скопируй мы сейчас одни непроверенные ящики, пул стал бы непустым, и
    // выбор рабочих ящиков в папке эту рассылку уже не спас бы.
    const mailboxes = await folderMailboxes(folder);
    // Имя с числом кандидатов — временное: после заливки в нём будет число
    // реально добавленных получателей.
    campaignName = campaignNameFor(source, job.createdAt, candidates.length);
    ({ id: campaignId } = await createCampaign({
      name: campaignName,
      mailboxIds: mailboxes.working ? mailboxes.ids : [],
      allowEmptyPool: true,
      steps: chainSteps(folder),
      timezone: folder.timezone,
      sendHourFrom: folder.send_hour_from,
      sendHourTo: folder.send_hour_to,
      sendWeekdays: folder.send_weekdays,
      gapSeconds: folder.gap_seconds,
      gapJitterSeconds: folder.gap_jitter_seconds,
      folderId: folder.id,
      sourceKind: source.sourceKind,
      sourceJobId: job.id,
      createdBy: input.userId,
    }));
  }

  const claimed: string[] = [];
  try {
    await claimRows(source, job.id, candidates.map((c) => c.id), campaignId, claimed);
    if (!claimed.length) {
      throw new SenderOpError('Эти компании прямо сейчас заливаются в другую рассылку — обновите экран', 409);
    }

    const claimedSet = new Set(claimed);
    const batch = candidates.filter((c) => claimedSet.has(c.id));
    const imported = await importRecipients(
      campaignId,
      batch.map((c) => c.recipient),
      { mode: 'append' },
    );

    const landed = new Set(imported.inCampaignRows);
    await releaseRows(
      source,
      batch.filter((_, index) => !landed.has(index)).map((c) => c.id),
      campaignId,
    );
    if (!landed.size) throw new SenderOpError(nothingLandedMessage(imported), 422);

    // «RU · 26.09 · N компаний» — N по факту: стоп-лист, дубли и строки без
    // письма в рассылку не легли. Имя — для людей, сбой переименования
    // заливку не отменяет.
    if (!target) {
      const finalName = campaignNameFor(source, job.createdAt, imported.inserted);
      if (finalName !== campaignName) {
        const { error: renameError } = await db()
          .from('sender_campaigns')
          .update({ name: finalName, updated_at: new Date().toISOString() })
          .eq('id', campaignId);
        if (!renameError) campaignName = finalName;
      }
    }

    return {
      campaignId,
      campaignName,
      folderName: folder.name,
      mode: target ? 'append' : 'new',
      rows: batch.length,
      inserted: imported.inserted,
      skippedSuppressed: imported.skippedSuppressed,
      skippedExisting: imported.skippedExisting,
      skippedDuplicates: imported.skippedDuplicates,
      skippedInvalid: imported.skippedInvalid,
      skippedEmptyLetter: imported.skippedEmptyLetter,
      alreadyUploaded,
    };
  } catch (e) {
    // Уборка без общей транзакции, по возможности; ошибка уходит та, что была.
    try {
      if (target) {
        // В существующей рассылке снимаем отметку только со строк, чей адрес
        // в неё так и не лёг: получатели, добавленные до сбоя, остаются, и их
        // строки должны остаться залитыми — иначе следующая заливка отправила
        // бы эти компании во вторую рассылку. Не удалось проверить — отметки
        // не трогаем вовсе: лучше строка, которую надо долить руками, чем
        // вторая цепочка той же компании.
        const claimedIds = new Set(claimed);
        const kept = await rowsAlreadyInCampaign(campaignId, candidates.filter((c) => claimedIds.has(c.id)));
        await releaseRows(source, claimed.filter((id) => !kept.has(id)), campaignId);
      } else {
        // Новую рассылку удаляем целиком: пул, шаги и получатели уходят
        // каскадом, ссылку в строках обнуляет внешний ключ. Дату заливки
        // снимаем сами — и только если рассылка действительно удалена: иначе
        // её получатели остались бы без отметки в строках и залились бы снова.
        const { error: deleteError } = await db().from('sender_campaigns').delete().eq('id', campaignId);
        if (!deleteError) await releaseRows(source, claimed, null);
      }
    } catch {
      /* уборка по возможности */
    }
    throw e;
  }
}

// ── Запуск ──────────────────────────────────────────────────────────────────

/**
 * «Запустить рассылку» с экрана запуска: только рассылку, созданную этим
 * запуском. Рассылку, в которую запуск лишь долил компании, запускают там,
 * где её создали, — иначе кнопка одного запуска запускала бы чужую базу.
 * Проверки самого запуска (получатели, ящики, шаги) — campaignOps.startCampaign.
 *
 * Рассылка без ящиков перед запуском берёт ящики своей папки —
 * sender/folders.fillPoolFromFolder, то же правило, что у кнопки «Запустить»
 * в «Рассылке»: заполняется только пустой пул и только если в папке есть
 * рабочий ящик, иначе — «Выберите ящики в настройках папки …».
 */
export async function startJobCampaign(input: {
  lang: OutreachLang;
  jobId: string;
  campaignId: string;
}): Promise<{ campaignId: string; mailboxesAdded: number }> {
  const source = SOURCES[input.lang];
  const job = await loadJob(source, input.jobId);
  if (!UUID_RE.test(input.campaignId)) throw new SenderOpError('Рассылка не найдена', 404);

  const { data: campaign, error } = await db()
    .from('sender_campaigns')
    .select('id, status, source_kind, source_job_id')
    .eq('id', input.campaignId)
    .maybeSingle();
  if (error) throw new SenderOpError(error.message, 500);
  if (!campaign) throw new SenderOpError('Рассылка не найдена', 404);
  if (String(campaign.source_job_id ?? '') !== job.id || campaign.source_kind !== source.sourceKind) {
    throw new SenderOpError('Эта рассылка создана не из этого запуска — запустите её во вкладке «Рассылка»', 409);
  }
  // Повторный старт идущей рассылки заново выставил бы очередь тем, чьё письмо
  // уже стоит в ней; завершённую не перезапускаем вовсе.
  const status = String(campaign.status);
  if (status === 'running') throw new SenderOpError('Рассылка уже идёт', 409);
  if (!EDITABLE_CAMPAIGN_STATUSES.includes(status)) {
    throw new SenderOpError('Рассылка завершена — запустить её снова нельзя', 409);
  }

  const campaignId = String(campaign.id);
  const mailboxesAdded = await fillPoolFromFolder(campaignId);
  await startCampaign(campaignId);
  return { campaignId, mailboxesAdded };
}

// ── Что видно на экране запуска ─────────────────────────────────────────────

export interface JobSenderCampaign {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  /** Строк этого запуска в рассылке. */
  fromThisJob: number;
  /** Получателей в рассылке всего (вместе с долитыми из других запусков). */
  recipients: number;
  sent: number;
  replied: number;
  /** Создана этим запуском и не идёт — кнопка «Запустить рассылку» работает. */
  canStart: boolean;
}

export interface JobSenderStatus {
  /**
   * Статус запуска (parser_jobs.status). Заливать можно только законченный —
   * completed или failed (в том числе остановленный); пока он идёт, кнопку
   * заливки экран держит выключенной, сервер отвечает 409.
   */
  jobStatus: string;
  folder: {
    id: string;
    name: string;
    /** Ящиков в папке (удалённые не считаются). */
    mailboxes: number;
    /** Из них проверены и с галочкой — без них рассылка не запустится. */
    workingMailboxes: number;
  };
  /** Рассылки, созданные запуском или получившие его строки; новые сверху. */
  campaigns: JobSenderCampaign[];
  /**
   * Готовые строки, ещё не залитые. uploadable — зальются нажатием;
   * suppressed — адрес в стоп-листе; invalid — адрес некорректный. Письма
   * здесь не читаются (это мегабайты на каждый показ экрана): строку без темы
   * или без первого письма заливка отсеет сама и скажет об этом.
   */
  pending: { total: number; uploadable: number; suppressed: number; invalid: number };
  /** Готовых строк, уже залитых в рассылки. */
  uploaded: number;
  /** Рассылки папки, в которые можно долить: черновик или пауза, новые сверху. */
  appendTargets: Array<{ id: string; name: string; status: string }>;
}

const CAMPAIGN_COLUMNS = 'id, name, status, created_at, started_at, source_kind, source_job_id';

async function campaignCounts(campaignId: string) {
  const recipients = () =>
    db().from('sender_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
  const [all, replied, sent] = await Promise.all([
    recipients(),
    recipients().eq('status', 'replied'),
    db()
      .from('sender_messages')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('status', 'sent'),
  ]);
  return { recipients: all.count ?? 0, replied: replied.count ?? 0, sent: sent.count ?? 0 };
}

async function suppressedAmong(emails: string[]): Promise<Set<string>> {
  const suppressed = new Set<string>();
  for (const part of chunkForInFilter(emails)) {
    const { data, error } = await db().from('sender_suppressions').select('email').in('email', part);
    if (error) throw new SenderOpError(error.message, 500);
    for (const row of data ?? []) suppressed.add(String(row.email));
  }
  return suppressed;
}

export async function getJobSenderStatus(input: { lang: OutreachLang; jobId: string }): Promise<JobSenderStatus> {
  const source = SOURCES[input.lang];
  const job = await loadJob(source, input.jobId);
  const folder = await loadFolder(source);

  // Лёгкий проход по готовым строкам: адрес и отметка, без писем.
  const perCampaign = new Map<string, number>();
  const pendingEmails: Array<string | null> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await readyQuery(source, job.id, `id, ${source.emailColumn}, sender_campaign_id`)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new SenderOpError(error.message, 500);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of page) {
      const campaignId = row.sender_campaign_id ? String(row.sender_campaign_id) : null;
      if (campaignId) perCampaign.set(campaignId, (perCampaign.get(campaignId) ?? 0) + 1);
      else pendingEmails.push(normalizeRecipientEmail(String(row[source.emailColumn] ?? '')));
    }
    if (page.length < PAGE) break;
  }

  // Те же правила, что у заливки: адрес приводится normalizeRecipientEmail,
  // стоп-лист — sender_suppressions.
  const valid = pendingEmails.filter((email): email is string => Boolean(email));
  const suppressedSet = await suppressedAmong([...new Set(valid)]);
  const suppressed = valid.filter((email) => suppressedSet.has(email)).length;

  // Свои рассылки — по source_job_id; чужие, куда запуск доливал, — по
  // отметкам строк.
  const [own, filled, mailboxes, targets] = await Promise.all([
    db().from('sender_campaigns').select(CAMPAIGN_COLUMNS).eq('source_job_id', job.id).eq('source_kind', source.sourceKind),
    perCampaign.size
      ? db().from('sender_campaigns').select(CAMPAIGN_COLUMNS).in('id', [...perCampaign.keys()])
      : Promise.resolve({ data: [], error: null }),
    folderMailboxes(folder),
    db()
      .from('sender_campaigns')
      .select('id, name, status')
      .eq('folder_id', folder.id)
      .in('status', EDITABLE_CAMPAIGN_STATUSES)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);
  for (const result of [own, filled, targets]) {
    if (result.error) throw new SenderOpError(result.error.message, 500);
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(own.data ?? []), ...(filled.data ?? [])] as Record<string, unknown>[]) {
    byId.set(String(row.id), row);
  }
  const linked = [...byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const campaigns = await Promise.all(
    linked.map(async (row): Promise<JobSenderCampaign> => {
      const id = String(row.id);
      const status = String(row.status);
      return {
        id,
        name: String(row.name),
        status,
        createdAt: String(row.created_at),
        startedAt: row.started_at ? String(row.started_at) : null,
        fromThisJob: perCampaign.get(id) ?? 0,
        ...(await campaignCounts(id)),
        canStart:
          String(row.source_job_id ?? '') === job.id &&
          row.source_kind === source.sourceKind &&
          EDITABLE_CAMPAIGN_STATUSES.includes(status),
      };
    }),
  );

  return {
    jobStatus: job.status,
    folder: { id: folder.id, name: folder.name, mailboxes: mailboxes.ids.length, workingMailboxes: mailboxes.working },
    campaigns,
    pending: {
      total: pendingEmails.length,
      uploadable: valid.length - suppressed,
      suppressed,
      invalid: pendingEmails.length - valid.length,
    },
    uploaded: [...perCampaign.values()].reduce((sum, n) => sum + n, 0),
    appendTargets: ((targets.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
    })),
  };
}
