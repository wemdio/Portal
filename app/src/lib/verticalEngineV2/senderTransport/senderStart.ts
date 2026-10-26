import type { SupabaseClient } from '@supabase/supabase-js';
import type { RecipientInput } from '@/lib/sender/recipientImport';
import { SenderOpError, startCampaign } from '@/lib/sender/campaignOps';
import { placeholderKeys, varKey } from '@/lib/sender/templateVars';
import { activateDeliveredContactCampaigns } from '../contactDeliveryActivation';
import { readContactDeliveryPages } from '../contactDeliveryInventory';
import { normalizeLaunchMailboxIds } from '../launchPortfolio';
import { readCampaignPools } from './senderDelivery';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { senderScheduledStartNote } from './labels';
import { parseSenderSteps, senderTemplateFault, veLeadToRecipient } from './senderTemplate';

/**
 * «Запустить в «Рассылке»» с карточки кампаний VE2: запустить черновики (и
 * паузы) одного запуска тем же путём, что кнопка «Рассылки»
 * (campaignOps.startCampaign — со сверкой стоп-листов), но только свои
 * кампании и только те, в которые подача сейчас идёт. Подключается только
 * маршрутом: campaignOps — серверный модуль.
 */

export interface VeSenderStartChild {
  /** id строки очереди: по нему — строки подачи кампании. */
  row_id: string;
  campaign_id: string;
  campaign_name: string;
  remote_status: number | null;
  status_observed_at: string | null;
  leads_count: number;
}

export interface VeSenderStartRow {
  status: string;
  source_kind: string;
  project_id: string | null;
  /** Запуск, назначенный в «Рассылке» на время: кнопкой отсюда он отменился бы молча. */
  scheduled_start_at?: string | null;
}

export type VeSenderStartStep =
  | { campaign_id: string; campaign_name: string; action: 'start' }
  | { campaign_id: string; campaign_name: string; action: 'skip' | 'refuse'; reason: string };

export interface VeSenderStartResult {
  campaign_id: string;
  campaign_name: string;
  outcome: 'started' | 'skipped' | 'failed';
  message: string | null;
}

export class VeSenderStartError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Что делать с каждой кампанией запуска. Чужая или переставленная на чужие
 * ящики кампания и кампания со сломанными письмами (−1) не запускаются: подача
 * в них остановлена, а отправка ушла бы мимо плана или с пустыми местами.
 * Состояние должно быть проверено в этом же запросе (checkedSince): старое −1
 * могли исправить, а старый «Черновик» — сломать после проверки. Идущая и
 * завершённая — пропуск. Черновик без контактов «Рассылка» не запустит («В
 * кампании нет получателей») — тоже пропуск с объяснением.
 */
export function planVeSenderStart(input: {
  portalProjectId: string;
  scope: readonly string[];
  children: readonly VeSenderStartChild[];
  rows: ReadonlyMap<string, VeSenderStartRow>;
  pools: ReadonlyMap<string, readonly string[]>;
  checkedSince: number;
}): VeSenderStartStep[] {
  const scope = new Set(normalizeLaunchMailboxIds(input.scope));
  return input.children.map((child): VeSenderStartStep => {
    const base = { campaign_id: child.campaign_id, campaign_name: child.campaign_name };
    const row = input.rows.get(child.campaign_id);
    if (!row) return { ...base, action: 'refuse', reason: 'Кампании нет в «Рассылке».' };
    if (row.source_kind !== 've2' || row.project_id !== input.portalProjectId) {
      return { ...base, action: 'refuse', reason: 'Кампания не принадлежит этому запуску.' };
    }
    if (row.status === 'running') return { ...base, action: 'skip', reason: 'Уже идёт.' };
    if (row.status === 'done') return { ...base, action: 'skip', reason: 'Завершена — запустить её снова нельзя.' };
    if (row.scheduled_start_at) {
      return { ...base, action: 'skip', reason: senderScheduledStartNote(row.scheduled_start_at, input.checkedSince, row.status === 'paused') };
    }
    const pool = input.pools.get(child.campaign_id) ?? [];
    if (!pool.length || pool.some((email) => !scope.has(email))) {
      return { ...base, action: 'refuse', reason: 'Ящики кампании изменены вручную — верните ящики пресета, затем запускайте.' };
    }
    const observed = child.status_observed_at ? Date.parse(child.status_observed_at) : Number.NaN;
    if (!(observed >= input.checkedSince)) {
      return { ...base, action: 'refuse', reason: 'Не удалось проверить состояние кампании перед запуском — запускать не стали.' };
    }
    if (child.remote_status === -1) {
      return { ...base, action: 'refuse', reason: 'Письма кампании не подходят к контактам — исправьте их в «Рассылке», затем запускайте.' };
    }
    if (row.status !== 'draft' && row.status !== 'paused') {
      return { ...base, action: 'skip', reason: `Состояние «${row.status}» — запуск не нужен.` };
    }
    if (child.leads_count <= 0) {
      return { ...base, action: 'skip', reason: 'Первая порция контактов ещё не загружена — запустить можно после неё.' };
    }
    return { ...base, action: 'start' };
  });
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * Сообщения наблюдения, которые специалист может понять и исправить, — точные
 * тексты наблюдателя (кампании уже названы по имени) и известные отказы
 * записи состояния. Всё прочее — ошибки базы и служебные тексты — нет.
 */
// Кампания в тексте наблюдателя — меткой: в названиях бывают «», на которых споткнулся бы шаблон.
const CAMPAIGN = '(\\u0000\\d+\\u0000)';
const SPECIALIST_NOTES: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  // Длинную причину активация режет до 500 символов — хвост «— подача…» может не дойти.
  [new RegExp(`^кампания «Рассылки» ${CAMPAIGN}: (.+?)( — подача в неё остановлена)?$`, 's'),
    (m) => `Кампания «Рассылки» ${m[1]}: ${m[2]}${m[3] ? '' : '…'} — подача в неё остановлена.`],
  [new RegExp(`^кампания «Рассылки» ${CAMPAIGN} остановлена — новые контакты в неё не подаются$`), (m) => `Кампания «Рассылки» ${m[1]} завершена — новые контакты в неё не подаются.`],
  [new RegExp(`^пул ящиков кампании «Рассылки» ${CAMPAIGN} изменён — подача остановлена$`), (m) => `Ящики кампании «Рассылки» ${m[1]} изменены вручную — подача в запуск остановлена.`],
  [new RegExp(`^кампании «Рассылки» ${CAMPAIGN} нет$`), (m) => `Кампании «Рассылки» ${m[1]} больше нет.`],
  [new RegExp(`^кампания «Рассылки» ${CAMPAIGN} не принадлежит этому запуску$`), (m) => `Кампания «Рассылки» ${m[1]} не принадлежит этому запуску.`],
  [/^Подача контактов в «Рассылку» выключена$/, () => 'Подача контактов в «Рассылку» сейчас выключена.'],
  [/supply approval is stale/, () => 'Согласование подачи контактов устарело — согласуйте подачу заново.'],
  [/campaign preparation or bound delivery plan is not confirmed/, () => 'План загрузки этого запуска не подтверждён — проверьте план выполнения проекта.'],
];
const NOTE_FALLBACK = 'Состояние кампаний «Рассылки» сейчас не проверить — повторите позже.';

function specialistNote(note: string, names: readonly string[]): string | null {
  for (const [pattern, render] of SPECIALIST_NOTES) {
    const match = note.match(pattern);
    if (match) {
      const shown = render(match).replace(/\u0000(\d+)\u0000/g, (_, index: string) => `«${names[Number(index)] || 'без названия'}»`);
      return UUID_ANYWHERE.test(shown) || shown.includes('\u0000') ? null : shown;
    }
  }
  return null;
}

/**
 * Сообщения наблюдения для специалиста: без id строки очереди, кампании — по
 * названию, только известные тексты. Остальное — одной общей строкой, а
 * дословно — в hidden, для журнала.
 */
function observationNotes(
  itemId: string,
  notes: readonly string[] | undefined,
  children: readonly VeSenderStartChild[],
): { shown: string[]; hidden: string[] } {
  const shown: string[] = [];
  const hidden: string[] = [];
  const names = children.map((child) => child.campaign_name);
  for (const raw of notes ?? []) {
    let note = raw.startsWith(`${itemId}: `) ? raw.slice(itemId.length + 2) : raw;
    children.forEach((child, index) => {
      note = note.split(child.campaign_id).join(`\u0000${index}\u0000`);
    });
    const known = specialistNote(note, names);
    if (known) {
      if (!shown.includes(known)) shown.push(known);
    } else {
      hidden.push(raw);
      if (!shown.includes(NOTE_FALLBACK)) shown.push(NOTE_FALLBACK);
    }
  }
  return { shown, hidden };
}

/** Сколько контактов кампании сверять с её письмами перед запуском. */
const RECIPIENT_SAMPLE = 200;

/**
 * Письма кампании против её же контактов — их «Рассылка» и отправит после
 * запуска. Наблюдение сверяет письма только с очередью подачи, а у черновика,
 * в который уже ушли все контакты, очереди нет. Контакты — из принятых строк
 * подачи, тем же правилом, что запуск и наблюдение: пустая колонка под
 * переменной — переменная есть (в базе «Рассылки» пустые значения не
 * хранятся, по ней выходило бы «переменной нет»). Строк подачи нет — по
 * получателям кампании. Переменная, которой нет у контактов, ищется во всех
 * письмах цепочки (follow-up вышли бы с пустым местом), пустые письма — в
 * первом (их планировщик закрывает без отправки). Причина — текст, null —
 * письма в порядке. Ошибка чтения — исключение.
 */
async function readRecipientFault(db: SupabaseClient, child: VeSenderStartChild): Promise<string | null> {
  const { data: steps, error: stepsError } = await db.from('sender_campaign_steps')
    .select('step_no, subject, body').eq('campaign_id', child.campaign_id);
  if (stepsError) throw new Error(`письма кампании не прочитаны: ${stepsError.message}`);
  const stepRows = (steps ?? []) as Array<{ step_no: unknown; subject: unknown; body: unknown }>;
  const { variants, spellings } = parseSenderSteps(stepRows);
  const { data: accepted, error: acceptedError } = await db.from('ve_contact_delivery_rows')
    .select('lead_payload').eq('campaign_row_id', child.row_id).eq('status', 'accepted')
    .order('drip_order', { ascending: true }).limit(RECIPIENT_SAMPLE);
  if (acceptedError) throw new Error(`контакты кампании не прочитаны: ${acceptedError.message}`);
  let rows: RecipientInput[] = ((accepted ?? []) as Array<{ lead_payload?: unknown }>)
    .map((row) => row.lead_payload)
    .filter((lead): lead is LeadCreatePayload => Boolean(lead) && typeof lead === 'object' && typeof (lead as { email?: unknown }).email === 'string')
    .map((lead) => veLeadToRecipient(lead, (lead as { _ve_company_identity?: unknown })._ve_company_identity, spellings));
  if (!rows.length) {
    const { data: recipients, error: recipientsError } = await db.from('sender_recipients')
      .select('email, name, vars').eq('campaign_id', child.campaign_id).eq('status', 'active').limit(RECIPIENT_SAMPLE);
    if (recipientsError) throw new Error(`получатели кампании не прочитаны: ${recipientsError.message}`);
    rows = ((recipients ?? []) as Array<{ email: unknown; name: unknown; vars: unknown }>).map((row) => ({
      email: String(row.email ?? ''),
      name: typeof row.name === 'string' && row.name.trim() ? row.name : null,
      vars: row.vars && typeof row.vars === 'object' && !Array.isArray(row.vars)
        ? Object.fromEntries(Object.entries(row.vars as Record<string, unknown>).map(([key, value]) => [key, value == null ? '' : String(value)]))
        : {},
    }));
  }
  const fault = senderTemplateFault(variants, rows);
  if (fault || !rows.length) return fault;
  const provided = new Set(rows.flatMap((row) => [...Object.keys(row.vars).map(varKey), 'email', ...(row.name ? ['name', 'first_name'] : [])]));
  const missing = [...new Set(stepRows.flatMap((step) => placeholderKeys(`${String(step.subject ?? '')}\n${String(step.body ?? '')}`)))]
    .filter((key) => !provided.has(key));
  return missing.length
    ? `в письмах кампании есть переменные, которых нет у её получателей: ${missing.map((key) => `{{${key}}}`).join(', ')}`
    : null;
}

/** Текст отказа «Рассылки» для специалиста: её 4xx — понятные тексты, 5xx — сырые ошибки базы. */
function startRefusalMessage(error: InstanceType<typeof SenderOpError>): string {
  if (error.status < 500) return error.message;
  return error.message.startsWith('Стоп-листы клиента и проекта не сверены')
    ? 'Стоп-листы клиента и проекта не сверены — запуск отложен. Повторите позже.'
    : 'Не удалось запустить — повторите.';
}

async function readChildren(db: SupabaseClient, itemId: string): Promise<VeSenderStartChild[]> {
  const rows = await readContactDeliveryPages<{
    id: string; campaign_id: string; campaign_name: string | null; remote_status: number | null; status_observed_at: string | null; leads_count: number | null;
  }>(
    'sender start children', (from, to) => db.from('ve_launch_queue_campaigns')
      .select('id, campaign_id, campaign_name, remote_status, status_observed_at, leads_count', { count: 'exact' })
      .eq('item_id', itemId).order('id', { ascending: true }).range(from, to));
  return rows.map((row) => ({
    row_id: String(row.id),
    campaign_id: String(row.campaign_id),
    campaign_name: String(row.campaign_name ?? ''),
    remote_status: typeof row.remote_status === 'number' ? row.remote_status : null,
    status_observed_at: typeof row.status_observed_at === 'string' ? row.status_observed_at : null,
    leads_count: Number(row.leads_count) || 0,
  }));
}

/**
 * Запустить кампании «Рассылки» запуска шаблона. Сначала свежее наблюдение
 * (поправленные письма снимают −1 сразу; не прошло — кампании не
 * запускаются), после запуска — ещё одно, чтобы карточка показала «Идёт» без
 * ожидания воркера. Повтор безопасен: идущие пропускаются. diagnostics —
 * дословные ошибки для журнала, не для экрана.
 */
export async function startVeSenderBundle(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  input: { veProjectId: string; templateId: string },
): Promise<{ results: VeSenderStartResult[]; notes: string[]; diagnostics: string[] }> {
  const { data: item, error: itemError } = await db.from('ve_launch_queue_items')
    .select('id, status, transport, mailbox_ids').eq('project_id', input.veProjectId).eq('template_id', input.templateId).maybeSingle();
  if (itemError) throw new VeSenderStartError('Не удалось прочитать запуск. Повторите.', 503, 'VE_SENDER_START_READ_FAILED');
  if (!item) throw new VeSenderStartError('У шаблона нет запуска.', 404, 'VE_SENDER_START_NO_LAUNCH');
  if (item.transport !== 'sender') {
    throw new VeSenderStartError('Кампании этого запуска — в Instantly, запускайте их там.', 409, 'VE_SENDER_START_NOT_SENDER');
  }
  if (!['prepared', 'queued', 'active', 'uncertain'].includes(String(item.status))) {
    throw new VeSenderStartError('Запуск закрыт — его кампании не запускаются.', 409, 'VE_SENDER_START_CLOSED');
  }
  const { data: project, error: projectError } = await db.from('ve_projects')
    .select('portal_project_id').eq('id', input.veProjectId).maybeSingle();
  if (projectError) throw new VeSenderStartError('Не удалось прочитать проект. Повторите.', 503, 'VE_SENDER_START_READ_FAILED');
  const portalProjectId = typeof project?.portal_project_id === 'string' ? project.portal_project_id : '';
  if (!portalProjectId) {
    throw new VeSenderStartError('Проект не привязан к проекту Portal — кампании «Рассылки» не запускаются.', 409, 'VE_SENDER_START_PROJECT');
  }

  const checkedSince = Date.now();
  const before = await activateDeliveredContactCampaigns({ portalDb: db, veProjectId: input.veProjectId, itemId: item.id });
  const children = await readChildren(db, item.id);
  if (!children.length) throw new VeSenderStartError('У запуска нет кампаний.', 409, 'VE_SENDER_START_NO_CAMPAIGNS');
  let observed = observationNotes(item.id, before.senderErrors, children);
  const diagnostics = [...observed.hidden];
  const ids = children.map((child) => child.campaign_id);
  const { data: rows, error: rowsError } = await db.from('sender_campaigns')
    .select('id, status, source_kind, project_id, scheduled_start_at').in('id', ids);
  if (rowsError) throw new VeSenderStartError('Не удалось прочитать кампании «Рассылки». Повторите.', 503, 'VE_SENDER_START_READ_FAILED');
  let pools: Map<string, string[]>;
  try {
    pools = await readCampaignPools(db, ids);
  } catch {
    throw new VeSenderStartError('Не удалось прочитать ящики кампаний «Рассылки». Повторите.', 503, 'VE_SENDER_START_READ_FAILED');
  }
  const plan = planVeSenderStart({
    portalProjectId,
    scope: Array.isArray(item.mailbox_ids) ? item.mailbox_ids : [],
    children,
    rows: new Map(((rows ?? []) as Array<VeSenderStartRow & { id: string }>).map((row) => [String(row.id), row])),
    pools,
    checkedSince,
  });

  const results: VeSenderStartResult[] = [];
  for (const step of plan) {
    const base = { campaign_id: step.campaign_id, campaign_name: step.campaign_name };
    if (step.action !== 'start') {
      results.push({ ...base, outcome: step.action === 'skip' ? 'skipped' : 'failed', message: step.reason });
      continue;
    }
    let fault: string | null;
    try {
      fault = await readRecipientFault(db, children.find((child) => child.campaign_id === step.campaign_id)!);
    } catch (error) {
      diagnostics.push(`${step.campaign_id}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ ...base, outcome: 'failed', message: 'Не удалось проверить письма кампании перед запуском — запускать не стали.' });
      continue;
    }
    if (fault) {
      results.push({ ...base, outcome: 'failed', message: `Письма не подходят к получателям: ${fault}. Исправьте их в «Рассылке», затем запускайте.` });
      continue;
    }
    try {
      await startCampaign(step.campaign_id, { instantlyDb });
      results.push({ ...base, outcome: 'started', message: null });
    } catch (error) {
      // 409 — её уже запустили (второй клик, другая вкладка) или завершили: не ошибка запуска.
      if (error instanceof SenderOpError) {
        if (error.status >= 500) diagnostics.push(`${step.campaign_id}: ${error.message}`);
        // Кампания уже идёт, но часть базы не встала в очередь — это запуск, а не отказ, и совет «Рассылки» нужен специалисту.
        if (error.message.startsWith('Кампания запущена, но часть базы не встала в очередь')) {
          results.push({ ...base, outcome: 'started',
            message: 'Кампания запущена, но часть контактов не встала в очередь — поставьте её на паузу и запустите ещё раз в «Рассылке».' });
          continue;
        }
        results.push({ ...base, outcome: error.status === 409 ? 'skipped' : 'failed', message: startRefusalMessage(error) });
        continue;
      }
      diagnostics.push(`${step.campaign_id}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ ...base, outcome: 'failed', message: 'Не удалось запустить — повторите.' });
    }
  }
  if (results.some((result) => result.outcome === 'started')) {
    const after = await activateDeliveredContactCampaigns({ portalDb: db, veProjectId: input.veProjectId, itemId: item.id })
      .catch((error: unknown) => {
        diagnostics.push(`после запуска: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    if (after) {
      observed = observationNotes(item.id, after.senderErrors, children);
      diagnostics.push(...observed.hidden);
    }
  }
  return { results, notes: observed.shown, diagnostics };
}
