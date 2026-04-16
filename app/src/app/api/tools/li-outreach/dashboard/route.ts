import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type LeadRow = { company: string | null; status: string };
type CampaignLeadRow = {
  status: string;
  user_replied: boolean;
  invite_accepted: boolean;
  created_at: string;
  lead_id: string;
};
type CampaignRow = {
  id: string;
  name: string;
  status: string;
  daily_invite_limit: number;
  invites_sent_today: number;
  lead_list_id: string | null;
};
type LogRow = { campaign_id: string; level: string; created_at: string };

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.dashboard' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const db = supabaseAdmin;

    const campaignIdsRes = await db.from('li_campaigns').select('id');
    const campaignIds = (campaignIdsRes.data ?? []).map((c: { id: string }) => c.id);

    const [leadsRes, campaignsRes, campaignLeadsRes, logsRes] = await Promise.all([
      db.from('li_leads').select('company, status'),
      db.from('li_campaigns').select('id, name, status, daily_invite_limit, invites_sent_today, lead_list_id'),
      campaignIds.length > 0
        ? db.from('li_campaign_leads')
            .select('status, user_replied, invite_accepted, created_at, lead_id, campaign_id')
            .in('campaign_id', campaignIds)
        : Promise.resolve({ data: [], error: null }),
      campaignIds.length > 0
        ? db.from('li_campaign_logs')
            .select('campaign_id, level, created_at')
            .in('campaign_id', campaignIds)
            .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
            .order('created_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (leadsRes.error) return jsonError(leadsRes.error.message, 500);

    const leads = (leadsRes.data ?? []) as LeadRow[];
    const campaigns = (campaignsRes.data ?? []) as CampaignRow[];
    const campaignLeads = (campaignLeadsRes.data ?? []) as (CampaignLeadRow & { campaign_id: string })[];
    const logs = (logsRes.data ?? []) as LogRow[];

    // --- Company breakdown ---
    const companyMap = new Map<string, { total: number; new: number; invited: number; connected: number; messaged: number; replied: number; completed: number; error: number }>();
    for (const lead of leads) {
      const company = lead.company?.trim() || '(не указана)';
      let entry = companyMap.get(company);
      if (!entry) {
        entry = { total: 0, new: 0, invited: 0, connected: 0, messaged: 0, replied: 0, completed: 0, error: 0 };
        companyMap.set(company, entry);
      }
      entry.total++;
      const s = lead.status as keyof typeof entry;
      if (s in entry && s !== 'total') (entry[s] as number)++;
    }
    const byCompany = Array.from(companyMap.entries())
      .map(([company, stats]) => ({ company, ...stats }))
      .sort((a, b) => b.total - a.total);

    // --- Global funnel ---
    const funnel = { new: 0, invited: 0, connected: 0, messaged: 0, replied: 0, completed: 0, error: 0, total: leads.length };
    for (const lead of leads) {
      const s = lead.status as keyof typeof funnel;
      if (s in funnel && s !== 'total') (funnel[s] as number)++;
    }

    // --- Per-campaign stats ---
    const campaignStats = campaigns.map((c) => {
      const cls = campaignLeads.filter((cl) => cl.campaign_id === c.id);
      const pending = cls.filter((cl) => cl.status === 'pending').length;
      const inProgress = cls.filter((cl) => cl.status === 'in_progress').length;
      const waiting = cls.filter((cl) => cl.status === 'waiting').length;
      const completed = cls.filter((cl) => cl.status === 'completed').length;
      const errored = cls.filter((cl) => cl.status === 'error').length;
      const skipped = cls.filter((cl) => cl.status === 'skipped').length;
      const replied = cls.filter((cl) => cl.user_replied).length;
      const accepted = cls.filter((cl) => cl.invite_accepted).length;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        daily_invite_limit: c.daily_invite_limit,
        invites_sent_today: c.invites_sent_today,
        leads_total: cls.length,
        pending,
        in_progress: inProgress,
        waiting,
        completed,
        error: errored,
        skipped,
        replied,
        accepted,
        reply_rate: cls.length > 0 ? Math.round((replied / cls.length) * 100) : 0,
        accept_rate: cls.length > 0 ? Math.round((accepted / cls.length) * 100) : 0,
      };
    });

    // --- Activity timeline (last 30 days, daily) ---
    const timeline: { date: string; actions: number; errors: number }[] = [];
    const dayMap = new Map<string, { actions: number; errors: number }>();
    for (const log of logs) {
      const day = log.created_at.slice(0, 10);
      let entry = dayMap.get(day);
      if (!entry) { entry = { actions: 0, errors: 0 }; dayMap.set(day, entry); }
      entry.actions++;
      if (log.level === 'error') entry.errors++;
    }
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const entry = dayMap.get(key) ?? { actions: 0, errors: 0 };
      timeline.push({ date: key, ...entry });
    }

    return NextResponse.json({
      funnel,
      by_company: byCompany,
      campaign_stats: campaignStats,
      timeline,
    });
  });
}
