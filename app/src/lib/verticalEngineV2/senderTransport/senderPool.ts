import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeLaunchMailboxIds } from '../launchPortfolio';
import type { VeSenderPoolSummary } from './labels';
import { veSenderScheduleFromPreset, type VeSenderSchedule } from './senderLaunchPlan';

/**
 * Ящики пресета в «Рассылке» для экранов запуска: сколько из них рабочие
 * (проверены и включены — то же правило, что у запуска, senderLaunch) и
 * сколько новых контактов они отправят за рабочий день. Только показ: запуск
 * сам проверяет ящики и отказывает, если рабочих нет.
 */

interface PoolRow { id: unknown; email: unknown; status: unknown; enabled: unknown }
interface LimitRow { id: unknown; daily_campaign_limit: unknown; daily_total_limit: unknown }
type PoolWindow = Pick<VeSenderSchedule, 'sendHourFrom' | 'sendHourTo' | 'gapSeconds' | 'gapJitterSeconds'>;

/** Как planner «Рассылки» читает id ящиков: кусками, чтобы URL запроса не разрастался. */
const MAILBOX_CHUNK = 50;

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function emailOf(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Один ящик на адрес, первый рабочий, — как readSenderPool запуска. Новых в
 * день с ящика — меньшее из лимита первых писем и доли общего лимита на одну
 * цепочку (follow-up «Рассылка» планирует раньше новых); общий лимит ещё
 * ограничен окном отправки с паузой между письмами. Это потолок: другие
 * кампании «Рассылки» на тех же ящиках делят те же лимиты.
 */
export function summarizeVeSenderPool(
  presetEmails: readonly string[],
  pool: readonly PoolRow[],
  limits: readonly LimitRow[],
  opts: { steps: number; window: PoolWindow | null },
): VeSenderPoolSummary {
  const wanted = new Set(presetEmails.map(emailOf).filter(Boolean));
  const found = new Set<string>();
  const chosen = new Map<string, string>();
  for (const row of pool) {
    const email = emailOf(row.email);
    if (!wanted.has(email)) continue;
    found.add(email);
    if (row.status === 'verified' && row.enabled === true && !chosen.has(email)) chosen.set(email, String(row.id));
  }
  const byId = new Map(limits.map((row) => [String(row.id), row]));
  const steps = Math.max(1, count(opts.steps));
  const window = opts.window;
  const windowCap = window
    ? Math.floor(Math.max(0, window.sendHourTo - window.sendHourFrom) * 3600 / Math.max(1, window.gapSeconds + window.gapJitterSeconds / 2))
    : Number.POSITIVE_INFINITY;
  let newPerDay = 0;
  for (const id of chosen.values()) {
    const limit = byId.get(id);
    if (!limit) continue;
    newPerDay += Math.min(count(limit.daily_campaign_limit), Math.floor(Math.min(count(limit.daily_total_limit), windowCap) / steps));
  }
  return { preset_mailboxes: wanted.size, in_sender: found.size, ready: chosen.size, new_per_day: newPerDay };
}

/** Ящики по адресам пресета. Ошибка чтения — исключение: показ решает сам, что выводить. */
export async function readVeSenderPoolSummary(
  portalDb: SupabaseClient,
  presetEmails: readonly string[],
  opts: { steps: number; window: PoolWindow | null },
): Promise<VeSenderPoolSummary> {
  const emails = [...new Set(presetEmails.map(emailOf).filter(Boolean))];
  if (!emails.length) return summarizeVeSenderPool([], [], [], opts);
  const { data, error } = await portalDb.rpc('ve_sender_pool_for_emails', { p_emails: emails });
  if (error) throw new Error(`ящики «Рассылки» не прочитаны: ${error.message}`);
  const pool = (Array.isArray(data) ? data : []) as PoolRow[];
  const ids = [...new Set(pool.filter((row) => row.status === 'verified' && row.enabled === true).map((row) => String(row.id)))];
  const limits: LimitRow[] = [];
  for (let offset = 0; offset < ids.length; offset += MAILBOX_CHUNK) {
    const { data: rows, error: limitError } = await portalDb.from('sender_mailboxes')
      .select('id, daily_campaign_limit, daily_total_limit').in('id', ids.slice(offset, offset + MAILBOX_CHUNK));
    if (limitError) throw new Error(`лимиты ящиков «Рассылки» не прочитаны: ${limitError.message}`);
    limits.push(...((rows ?? []) as LimitRow[]));
  }
  return summarizeVeSenderPool(emails, pool, limits, opts);
}

/** То же по пресету: его ящики и окно отправки. steps — писем в цепочке. */
export async function readVeSenderPoolForPreset(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient,
  presetId: string,
  steps: number,
): Promise<VeSenderPoolSummary> {
  const { data: preset, error } = await instantlyDb.from('client_campaign_presets')
    .select('email_account_ids, schedule_from, schedule_to, schedule_days, schedule_timezone, email_gap_minutes')
    .eq('id', presetId).maybeSingle();
  if (error || !preset) throw new Error('пресет не прочитан');
  // Окно, которое «Рассылка» не примет, запуск отклонит сам; здесь — без ограничения окном.
  const schedule = veSenderScheduleFromPreset(preset);
  return readVeSenderPoolSummary(portalDb, normalizeLaunchMailboxIds(preset.email_account_ids), {
    steps,
    window: schedule.ok ? schedule.schedule : null,
  });
}

/**
 * Добавить ящики «Рассылки» к обзору плана — только там, где их показывают
 * (обзор Step 5, закреплённый план, обзор автоаутрича), и только у обзора
 * запуска в «Рассылку» или у шаблона, уже запущенного в неё (recordedSender:
 * обзор говорит, куда пойдёт новый запуск, а записанный уже не переедет).
 * Остальные обзоры (опрос запаса, согласование, воркер) их не читают.
 * Ошибка — sender_pool: null, обзор не падает.
 */
export async function attachVeSenderPool<T extends { status: number; body: Record<string, unknown> }>(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient,
  outcome: T,
  input: { templateId: string; presetId: string; recordedSender?: boolean },
): Promise<T> {
  const preview = outcome.body.preview;
  if (outcome.status !== 200 || !preview || typeof preview !== 'object'
    || ((preview as { transport?: unknown }).transport !== 'sender' && !input.recordedSender)) {
    return outcome;
  }
  let pool: VeSenderPoolSummary | null = null;
  try {
    const { data: template, error } = await portalDb.from('ve_templates').select('letters').eq('id', input.templateId).maybeSingle();
    if (error || !template) throw new Error('шаблон не прочитан');
    const letters = (template as { letters?: unknown }).letters;
    pool = await readVeSenderPoolForPreset(portalDb, instantlyDb, input.presetId, Array.isArray(letters) ? letters.length : 1);
  } catch {
    pool = null;
  }
  return { ...outcome, body: { ...outcome.body, preview: { ...(preview as Record<string, unknown>), sender_pool: pool } } };
}
