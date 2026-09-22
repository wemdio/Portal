import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

interface StepInput {
  /** Задержка от предыдущего шага в часах; у первого письма игнорируется. */
  delayHours?: number;
  subject?: string;
  body?: string;
}

interface CreateBody {
  name?: string;
  mailboxIds?: string[];
  steps?: StepInput[];
  timezone?: string;
  sendHourFrom?: number;
  sendHourTo?: number;
  sendWeekdays?: number[];
  gapSeconds?: number;
  gapJitterSeconds?: number;
}

const MAX_STEPS = 5;

async function campaignStats(campaignId: string) {
  if (!supabaseAdmin) return null;
  const db = supabaseAdmin;

  const recipientsQuery = (filter?: { column?: string; value?: unknown; gtColumn?: string; gtValue?: number }) => {
    let q = db.from('sender_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
    if (filter?.column) q = q.eq(filter.column, filter.value);
    if (filter?.gtColumn) q = q.gt(filter.gtColumn, filter.gtValue);
    return q;
  };
  const messagesQuery = (status: string) =>
    db
      .from('sender_messages')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('status', status);

  const [recipients, replied, bounced, reached, sent, scheduled, failed] = await Promise.all([
    recipientsQuery(),
    recipientsQuery({ column: 'status', value: 'replied' }),
    recipientsQuery({ column: 'status', value: 'bounced' }),
    // Знаменатель reply rate — те, кому реально ушло хотя бы одно письмо.
    // Счётчик «отправлено» для этого не годится: он считает строки писем,
    // то есть каждый шаг цепочки, и процент вышел бы заниженным в разы.
    recipientsQuery({ gtColumn: 'last_step_sent', gtValue: 0 }),
    messagesQuery('sent'),
    messagesQuery('scheduled'),
    messagesQuery('failed'),
  ]);

  const reachedCount = reached.count ?? 0;
  return {
    recipients: recipients.count ?? 0,
    replied: replied.count ?? 0,
    bounced: bounced.count ?? 0,
    reached: reachedCount,
    // Проценты не считаем здесь при нуле знаменателя — UI покажет «—».
    replyRate: reachedCount > 0 ? Math.round(((replied.count ?? 0) / reachedCount) * 1000) / 10 : null,
    bounceRate: reachedCount > 0 ? Math.round(((bounced.count ?? 0) / reachedCount) * 1000) / 10 : null,
    sent: sent.count ?? 0,
    scheduled: scheduled.count ?? 0,
    failed: failed.count ?? 0,
  };
}

/**
 * Ящики кампаний одним запросом на весь список, а не по запросу на кампанию:
 * вкладка «Письма» показывает их в боковой колонке под каждой кампанией.
 */
async function mailboxesByCampaign(campaignIds: string[]) {
  const out = new Map<string, { id: string; email: string }[]>();
  if (!supabaseAdmin || !campaignIds.length) return out;

  const { data } = await supabaseAdmin
    .from('sender_campaign_mailboxes')
    .select('campaign_id, sender_mailboxes(id, email)')
    .in('campaign_id', campaignIds);

  for (const row of (data ?? []) as { campaign_id: string; sender_mailboxes: unknown }[]) {
    // Вложенная запись приезжает объектом или массивом в зависимости от того,
    // как PostgREST разобрал связь, — приводим к одному виду.
    const raw = row.sender_mailboxes;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const mailboxes = list
      .map((m) => m as { id?: string; email?: string })
      .filter((m): m is { id: string; email: string } => Boolean(m.id && m.email))
      .map((m) => ({ id: String(m.id), email: String(m.email) }));
    const key = String(row.campaign_id);
    out.set(key, [...(out.get(key) ?? []), ...mailboxes]);
  }
  return out;
}

/** GET — список кампаний с короткой статистикой. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin
      .from('sender_campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return jsonError(error.message, 500);

    const pool = await mailboxesByCampaign((data ?? []).map((c) => String(c.id)));
    const campaigns = await Promise.all(
      (data ?? []).map(async (campaign) => ({
        ...campaign,
        mailboxes: pool.get(String(campaign.id)) ?? [],
        stats: await campaignStats(String(campaign.id)),
      })),
    );

    return NextResponse.json({ campaigns });
  });
}

/** POST — создать кампанию: пул ящиков, шаги цепочки, расписание. */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as CreateBody | null;
    if (!body) return jsonError('Невалидный JSON', 400);

    const name = (body.name ?? '').trim();
    if (!name) return jsonError('Укажите название кампании', 400);

    const mailboxIds = [...new Set((body.mailboxIds ?? []).filter((id) => typeof id === 'string' && id))];
    if (!mailboxIds.length) return jsonError('Выберите хотя бы один ящик', 400);

    const steps = (body.steps ?? []).slice(0, MAX_STEPS).filter((step) => (step.body ?? '').trim());
    if (!steps.length) return jsonError('Добавьте хотя бы одно письмо', 400);
    if (!(steps[0].subject ?? '').trim()) return jsonError('У первого письма должна быть тема', 400);

    const { data: campaign, error } = await supabaseAdmin
      .from('sender_campaigns')
      .insert({
        name,
        status: 'draft',
        timezone: body.timezone?.trim() || 'Europe/Moscow',
        send_hour_from: body.sendHourFrom ?? 9,
        send_hour_to: body.sendHourTo ?? 18,
        send_weekdays: body.sendWeekdays?.length ? body.sendWeekdays : [1, 2, 3, 4, 5],
        gap_seconds: body.gapSeconds ?? 180,
        gap_jitter_seconds: body.gapJitterSeconds ?? 120,
        created_by: auth.user.id,
      })
      .select('id')
      .single();

    if (error || !campaign) return jsonError(error?.message ?? 'Не удалось создать кампанию', 500);
    const campaignId = String(campaign.id);

    const { error: poolError } = await supabaseAdmin
      .from('sender_campaign_mailboxes')
      .insert(mailboxIds.map((mailboxId) => ({ campaign_id: campaignId, mailbox_id: mailboxId })));
    if (poolError) return jsonError(poolError.message, 500);

    const { error: stepsError } = await supabaseAdmin.from('sender_campaign_steps').insert(
      steps.map((step, index) => ({
        campaign_id: campaignId,
        step_no: index + 1,
        delay_hours: index === 0 ? 0 : Math.max(1, Math.round(step.delayHours ?? 72)),
        subject: (step.subject ?? '').trim(),
        body: (step.body ?? '').trim(),
      })),
    );
    if (stepsError) return jsonError(stepsError.message, 500);

    return NextResponse.json({ id: campaignId });
  });
}
