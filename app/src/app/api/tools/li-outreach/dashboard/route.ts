import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type LeadRow = { id: string; company: string | null; status: string };
// `already_invited` is the side-track from the invite step: LinkedIn refused
// our invite because the recipient was already invited (by us in another
// campaign, or by another tool). Such leads are NOT counted in `invited`,
// matching what the LinkedIn account dashboard reports as "Приглашений
// отправлено" (only invites actually sent in this run).
type Funnel = { new: number; invited: number; already_invited: number; connected: number; messaged: number; replied: number; completed: number; error: number; total: number };

function emptyFunnel(): Funnel {
  return { new: 0, invited: 0, already_invited: 0, connected: 0, messaged: 0, replied: 0, completed: 0, error: 0, total: 0 };
}

function addToFunnel(f: Funnel, status: string): void {
  f.total++;
  if (status !== 'total' && status in f) (f[status as keyof Funnel] as number)++;
}
type CampaignLeadRow = {
  status: string;
  user_replied: boolean;
  invite_accepted: boolean;
  created_at: string;
  lead_id: string;
  invite_sent_at: string | null;
  invite_accepted_at: string | null;
  replied_at: string | null;
  updated_at: string;
};
type CampaignRow = {
  id: string;
  name: string;
  status: string;
  daily_invite_limit: number;
  invites_sent_today: number;
  last_invite_date: string | null;
  lead_list_id: string | null;
};
type LogRow = { campaign_id: string; account_id: string | null; level: string; message: string; created_at: string };

/** Сутки активности: что реально делали, а не сколько строк в журнале. */
type Day = { date: string; invites: number; messages: number; errors: number };
type AccountActivity = { account_id: string; invites_today: number; invites: number; messages: number; errors: number; last_action_at: string | null };
type Activity = { timeline: Day[]; accounts: AccountActivity[] };

const MAX_DAYS = 92;
const DAY_MS = 86400000;

/** Период статистики: сутки от `from` до `to` включительно (YYYY-MM-DD, UTC, как и журнал). */
interface Period { from: string; to: string; days: number }

/** `?days=7|14|30` или `?from=…&to=…`; по умолчанию 30 дней. Длиннее трёх месяцев не отдаём. */
function parsePeriod(url: URL): Period {
  const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  const today = new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (isDate(from) && isDate(to) && from <= to) {
    const end = to > today ? today : to;
    const days = Math.min(Math.round((Date.parse(end) - Date.parse(from)) / DAY_MS) + 1, MAX_DAYS);
    const start = new Date(Date.parse(end) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    return { from: start, to: end, days: Math.max(days, 1) };
  }
  const requested = parseInt(url.searchParams.get('days') ?? '30', 10);
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 30, 1), MAX_DAYS);
  return { from: new Date(Date.parse(today) - (days - 1) * DAY_MS).toISOString().slice(0, 10), to: today, days };
}

/** Журнал за период → активность по дням и по аккаунтам. Считаем только отправленные инвайты и сообщения и ошибки. */
function buildActivity(logs: LogRow[], today: string, period: Period): Activity {
  const dayMap = new Map<string, Day>();
  for (let i = 0; i < period.days; i++) {
    const key = new Date(Date.parse(period.from) + i * DAY_MS).toISOString().slice(0, 10);
    dayMap.set(key, { date: key, invites: 0, messages: 0, errors: 0 });
  }
  const accounts = new Map<string, AccountActivity>();
  for (const log of logs) {
    const day = log.created_at.slice(0, 10);
    const entry = dayMap.get(day);
    const isInvite = log.message.startsWith('Инвайт отправлен');
    const isMessage = log.message.startsWith('Сообщение отправлено');
    const isError = log.level === 'error';
    if (entry) {
      if (isInvite) entry.invites++;
      if (isMessage) entry.messages++;
      if (isError) entry.errors++;
    }
    if (!log.account_id) continue;
    let acc = accounts.get(log.account_id);
    if (!acc) {
      acc = { account_id: log.account_id, invites_today: 0, invites: 0, messages: 0, errors: 0, last_action_at: null };
      accounts.set(log.account_id, acc);
    }
    if (isInvite) { acc.invites++; if (day === today) acc.invites_today++; }
    if (isMessage) acc.messages++;
    if (isError) acc.errors++;
    if ((isInvite || isMessage) && (!acc.last_action_at || log.created_at > acc.last_action_at)) acc.last_action_at = log.created_at;
  }
  return { timeline: [...dayMap.values()], accounts: [...accounts.values()] };
}

/** PostgREST отдаёт не больше тысячи строк за запрос — читаем журнал страницами. */
async function fetchLogs(db: SupabaseClient, campaignIds: string[], period: Period): Promise<LogRow[]> {
  const since = `${period.from}T00:00:00.000Z`;
  const until = new Date(Date.parse(period.to) + DAY_MS).toISOString();
  const out: LogRow[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await db
      .from('li_campaign_logs')
      .select('campaign_id, account_id, level, message, created_at')
      .in('campaign_id', campaignIds)
      .gte('created_at', since)
      .lt('created_at', until)
      .or('message.ilike.Инвайт отправлен%,message.ilike.Сообщение отправлено%,level.eq.error')
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as LogRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function visibleInvitesSentToday(campaign: CampaignRow, today: string): number {
  return campaign.last_invite_date?.slice(0, 10) === today ? campaign.invites_sent_today : 0;
}

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.dashboard' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const db = supabaseAdmin;
    const period = parsePeriod(new URL(req.url));
    const inPeriod = (iso: string | null | undefined): boolean => !!iso && iso.slice(0, 10) >= period.from && iso.slice(0, 10) <= period.to;

    // Кампании, лиды и журнал общие для команды: дашборд считает всё, что видно в портале.
    const campaignIdsRes = await db.from('li_campaigns').select('id');
    const campaignIds = (campaignIdsRes.data ?? []).map((c: { id: string }) => c.id);

    const [leadsRes, campaignsRes, campaignLeadsRes] = await Promise.all([
      db.from('li_leads').select('id, company, status'),
      db
        .from('li_campaigns')
        .select('id, name, status, daily_invite_limit, invites_sent_today, last_invite_date, lead_list_id'),
      campaignIds.length > 0
        ? db.from('li_campaign_leads')
            .select('status, user_replied, invite_accepted, created_at, lead_id, campaign_id, invite_sent_at, invite_accepted_at, replied_at, updated_at')
            .in('campaign_id', campaignIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (leadsRes.error) return jsonError(leadsRes.error.message, 500);

    const leads = (leadsRes.data ?? []) as LeadRow[];
    const campaigns = (campaignsRes.data ?? []) as CampaignRow[];
    const campaignLeads = (campaignLeadsRes.data ?? []) as (CampaignLeadRow & { campaign_id: string })[];
    let logs: LogRow[] = [];
    try {
      logs = campaignIds.length > 0 ? await fetchLogs(db, campaignIds, period) : [];
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'Не удалось прочитать журнал', 500);
    }

    // --- Company breakdown ---
    const today = todayStr();
    // Инвайты, отправленные и принятые сегодня, — по лиду (лид может быть в нескольких кампаниях).
    const sentToday = new Set<string>();
    const acceptedToday = new Set<string>();
    for (const cl of campaignLeads) {
      if (cl.invite_sent_at?.slice(0, 10) === today) sentToday.add(cl.lead_id);
      if (cl.invite_accepted_at?.slice(0, 10) === today) acceptedToday.add(cl.lead_id);
    }
    const companyMap = new Map<string, { total: number; new: number; invited: number; connected: number; messaged: number; replied: number; completed: number; error: number; invites_today: number; accepted_today: number }>();
    for (const lead of leads) {
      const company = lead.company?.trim() || '(не указана)';
      let entry = companyMap.get(company);
      if (!entry) {
        entry = { total: 0, new: 0, invited: 0, connected: 0, messaged: 0, replied: 0, completed: 0, error: 0, invites_today: 0, accepted_today: 0 };
        companyMap.set(company, entry);
      }
      if (sentToday.has(lead.id)) entry.invites_today++;
      if (acceptedToday.has(lead.id)) entry.accepted_today++;
      entry.total++;
      const s = lead.status as keyof typeof entry;
      if (s in entry && s !== 'total') (entry[s] as number)++;
    }
    const byCompany = Array.from(companyMap.entries())
      .map(([company, stats]) => ({ company, ...stats }))
      .sort((a, b) => b.total - a.total);

    // --- Global funnel ---
    const funnel: Funnel = { new: 0, invited: 0, already_invited: 0, connected: 0, messaged: 0, replied: 0, completed: 0, error: 0, total: leads.length };
    for (const lead of leads) {
      const s = lead.status as keyof typeof funnel;
      if (s in funnel && s !== 'total') (funnel[s] as number)++;
    }

    // Статус лида по id — для пер-кампанийной воронки. li_leads.status это
    // общий стейдж лида; per-campaign funnel = воронка по лидам конкретной
    // кампании (через li_campaign_leads.lead_id).
    const leadStatusById = new Map<string, string>();
    for (const lead of leads) leadStatusById.set(lead.id, lead.status);

    // --- Per-campaign stats ---
    const campaignStats = campaigns.map((c) => {
      const cls = campaignLeads.filter((cl) => cl.campaign_id === c.id);
      const pending = cls.filter((cl) => cl.status === 'pending').length;
      const inProgress = cls.filter((cl) => cl.status === 'in_progress').length;
      const waiting = cls.filter((cl) => cl.status === 'waiting').length;
      const completed = cls.filter((cl) => cl.status === 'completed').length;
      const errored = cls.filter((cl) => cl.status === 'error').length;
      const skipped = cls.filter((cl) => cl.status === 'skipped').length;
      // Обработано за период: у лида нет времени завершения, берём updated_at (приближение).
      const donePeriod = (status: string) => cls.filter((cl) => cl.status === status && inPeriod(cl.updated_at)).length;
      const completedPeriod = donePeriod('completed');
      const errorPeriod = donePeriod('error');
      const skippedPeriod = donePeriod('skipped');
      // За период: у старых строк точного времени нет — берём updated_at (приближение).
      const replied = cls.filter((cl) => cl.user_replied && inPeriod(cl.replied_at ?? cl.updated_at)).length;
      const accepted = cls.filter((cl) => cl.invite_accepted && inPeriod(cl.invite_accepted_at ?? cl.updated_at)).length;
      // Воронка лидов именно этой кампании.
      const campaignFunnel = emptyFunnel();
      for (const cl of cls) {
        const st = leadStatusById.get(cl.lead_id);
        if (st) addToFunnel(campaignFunnel, st);
      }
      return {
        id: c.id,
        name: c.name,
        funnel: campaignFunnel,
        status: c.status,
        daily_invite_limit: c.daily_invite_limit,
        invites_sent_today: visibleInvitesSentToday(c, today),
        leads_total: cls.length,
        pending,
        in_progress: inProgress,
        waiting,
        completed,
        error: errored,
        skipped,
        completed_period: completedPeriod,
        error_period: errorPeriod,
        skipped_period: skippedPeriod,
        replied,
        accepted,
        activity: buildActivity(logs.filter((l) => l.campaign_id === c.id), today, period),
        reply_rate: cls.length > 0 ? Math.round((replied / cls.length) * 100) : 0,
        accept_rate: cls.length > 0 ? Math.round((accepted / cls.length) * 100) : 0,
      };
    });

    return NextResponse.json({
      funnel,
      by_company: byCompany,
      campaign_stats: campaignStats,
      activity: buildActivity(logs, today, period),
      period,
    });
  });
}
