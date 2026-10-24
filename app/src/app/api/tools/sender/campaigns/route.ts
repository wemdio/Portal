import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { createCampaign, SenderOpError, type CampaignStepInput } from '@/lib/sender/campaignOps';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { saveCampaignTags } from '@/lib/sender/campaignTags';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Сколько последних кампаний отдаёт список. Вкладка раскладывает их по папкам,
 * и при 50 последних частые заливки одного автоаутрича вытесняли с экрана
 * рассылки другого. Постраничности нет: кампаний — сотни, не тысячи.
 */
const LIST_LIMIT = 200;
/** Кампаний на один запрос пулов: id уезжают в адрес запроса. */
const POOL_CHUNK = 50;

interface CreateBody {
  name?: string;
  mailboxIds?: string[];
  /** Теги ящиков, привязанные к кампании целиком. */
  tagIds?: string[];
  steps?: CampaignStepInput[];
  timezone?: string;
  sendHourFrom?: number;
  sendHourTo?: number;
  sendWeekdays?: number[];
  gapSeconds?: number;
  gapJitterSeconds?: number;
  /** Проект портала; null или нет поля — без проекта. */
  projectId?: string | null;
  /** Клиент кабинета, чей стоп-лист действует на базу; null или нет поля — без клиента. */
  clientUserId?: string | null;
  /** Автосохранение недописанной формы: проверки откладываются до запуска. */
  draft?: boolean;
}

type StatsRow = {
  campaign_id: string;
  recipients: number; replied: number; bounced: number; reached: number;
  finished: number; unsubscribed: number; in_progress: number; not_contacted: number;
  sent: number; scheduled: number; failed: number; sent_today: number; new_today: number;
  step_count: number; remaining: number;
};

/**
 * Статистика всех кампаний одним вызовом sender_campaign_stats_all: раньше
 * здесь было ~16 запросов счётчиков на кампанию, и список грузился секундами.
 * «Сегодня» считается в поясе кампании — у EN по Нью-Йорку.
 */
async function statsByCampaign() {
  const out = new Map<string, ReturnType<typeof toStats>>();
  if (!supabaseAdmin) return out;
  const { data, error } = await supabaseAdmin.rpc('sender_campaign_stats_all');
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as StatsRow[]) out.set(String(row.campaign_id), toStats(row));
  return out;
}

function toStats(row: StatsRow) {
  const n = (v: unknown) => Number(v) || 0;
  const reached = n(row.reached);
  const replied = n(row.replied);
  const bounced = n(row.bounced);
  const sent = n(row.sent);
  return {
    recipients: n(row.recipients),
    replied,
    bounced,
    reached,
    // Проценты не считаем здесь при нуле знаменателя — UI покажет «—».
    replyRate: reached > 0 ? Math.round((replied / reached) * 1000) / 10 : null,
    bounceRate: reached > 0 ? Math.round((bounced / reached) * 1000) / 10 : null,
    sent,
    scheduled: n(row.scheduled),
    failed: n(row.failed),
    sentToday: n(row.sent_today),
    finished: n(row.finished),
    unsubscribed: n(row.unsubscribed),
    inProgress: n(row.in_progress),
    notContacted: n(row.not_contacted),
    newToday: n(row.new_today),
    // Ушедшие плюс те, что осталось отправить активным, — для «прогресса по письмам».
    lettersTotal: n(row.step_count) > 0 ? sent + n(row.remaining) : null,
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
    const [pool, stats] = await Promise.all([
      mailboxesByCampaign(rows.map((c) => String(c.id))),
      statsByCampaign(),
    ]);
    const campaigns = rows.map((campaign) => ({
      ...campaign,
      mailboxes: pool.get(String(campaign.id)) ?? [],
      stats: stats.get(String(campaign.id)) ?? null,
    }));

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
        projectId: body.projectId ?? null,
        clientUserId: body.clientUserId ?? null,
        // Форма сохраняет недописанный черновик сама — его проверять по полной
        // нельзя: ни писем, ни ящиков там может ещё не быть.
        partial: body.draft === true,
        createdBy: auth.user.id,
      });
      if (Array.isArray(body.tagIds)) await saveCampaignTags(id, body.tagIds.map(String));
      return NextResponse.json({ id });
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }
  });
}
