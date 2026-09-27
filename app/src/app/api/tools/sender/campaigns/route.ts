import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { createCampaign, SenderOpError, type CampaignStepInput } from '@/lib/sender/campaignOps';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Сколько последних кампаний отдаёт список. Вкладка раскладывает их по папкам,
 * и при 50 последних частые заливки одного автоаутрича вытесняли с экрана
 * рассылки другого. Постраничности нет: кампаний — сотни, не тысячи.
 */
const LIST_LIMIT = 200;
/**
 * Кампаний, чья статистика считается одновременно. У каждой — семь запросов
 * счётчиков, и 200 кампаний разом — это 1400 запросов в пул PostgREST на
 * 30 соединений.
 */
const STATS_CHUNK = 20;
/** Кампаний на один запрос пулов: id уезжают в адрес запроса. */
const POOL_CHUNK = 50;

interface CreateBody {
  name?: string;
  mailboxIds?: string[];
  steps?: CampaignStepInput[];
  timezone?: string;
  sendHourFrom?: number;
  sendHourTo?: number;
  sendWeekdays?: number[];
  gapSeconds?: number;
  gapJitterSeconds?: number;
}

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

  // Пачками: 200 id в одном in-фильтре — это ~7 КБ адреса, у самого края
  // того, что пропускает шлюз перед PostgREST.
  const rows: { campaign_id: string; sender_mailboxes: unknown }[] = [];
  for (let i = 0; i < campaignIds.length; i += POOL_CHUNK) {
    const { data } = await supabaseAdmin
      .from('sender_campaign_mailboxes')
      .select('campaign_id, sender_mailboxes(id, email)')
      .in('campaign_id', campaignIds.slice(i, i + POOL_CHUNK));
    rows.push(...((data ?? []) as { campaign_id: string; sender_mailboxes: unknown }[]));
  }

  for (const row of rows) {
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

/**
 * GET — последние кампании с короткой статистикой. Вместе с настройками
 * приезжают папка (folder_id) и источник (source_kind, source_job_id):
 * вкладка группирует по ним кампании. truncated — в список влезли не все.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    // Одна строка сверх лимита — признак, что старые кампании не влезли.
    const { data, error } = await supabaseAdmin
      .from('sender_campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT + 1);

    if (error) return jsonError(error.message, 500);

    const rows = (data ?? []).slice(0, LIST_LIMIT);
    const pool = await mailboxesByCampaign(rows.map((c) => String(c.id)));
    const campaigns: Record<string, unknown>[] = [];
    for (let i = 0; i < rows.length; i += STATS_CHUNK) {
      campaigns.push(
        ...(await Promise.all(
          rows.slice(i, i + STATS_CHUNK).map(async (campaign) => ({
            ...campaign,
            mailboxes: pool.get(String(campaign.id)) ?? [],
            stats: await campaignStats(String(campaign.id)),
          })),
        )),
      );
    }

    return NextResponse.json({ campaigns, truncated: (data ?? []).length > LIST_LIMIT });
  });
}

/**
 * POST — создать кампанию: пул ящиков, шаги цепочки, расписание. Проверки и
 * запись — в lib/sender/campaignOps: тем же путём кампании заводит заливка
 * из автоаутрича.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as CreateBody | null;
    if (!body) return jsonError('Невалидный JSON', 400);

    try {
      const { id } = await createCampaign({
        name: body.name ?? '',
        mailboxIds: body.mailboxIds ?? [],
        steps: body.steps ?? [],
        timezone: body.timezone,
        sendHourFrom: body.sendHourFrom,
        sendHourTo: body.sendHourTo,
        sendWeekdays: body.sendWeekdays,
        gapSeconds: body.gapSeconds,
        gapJitterSeconds: body.gapJitterSeconds,
        createdBy: auth.user.id,
      });
      return NextResponse.json({ id });
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }
  });
}
