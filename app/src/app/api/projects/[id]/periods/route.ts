import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

type ProjectRow = {
  id: string;
  contacts_obligation: string | null;
  contacts_done: string | null;
  kpi_plan: string | null;
  kpi_fact: string | null;
  deadline: string | null;
  launch_date: string | null;
  payment_date: string | null;
  created_at: string | null;
};

type PeriodRow = {
  id: string;
  project_id: string;
  name: string | null;
  status: 'active' | 'closed';
  period_start: string;
  period_end: string | null;
  contacts_obligation: string | null;
  contacts_done: string | null;
  contacts_done_synced_at: string | null;
  kpi_plan: string | null;
  kpi_fact: string | null;
  deadline: string | null;
  created_at: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchCampaignContacts(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!supabaseInstantly || ids.length === 0) return map;
  const { data } = await supabaseInstantly
    .from('instantly_campaign_catalog')
    .select('id, new_leads_contacted_count')
    .in('id', ids);
  for (const row of data ?? []) {
    const n = Number((row as { new_leads_contacted_count?: number | null }).new_leads_contacted_count);
    map.set((row as { id: string }).id, Number.isFinite(n) ? n : 0);
  }
  return map;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data, error } = await supabaseAdmin
    .from('project_periods')
    .select('*')
    .eq('project_id', projectId)
    .order('period_start', { ascending: false });

  if (error) return jsonError(error.message, 500);

  const items = (data ?? []) as PeriodRow[];
  return NextResponse.json({
    items,
    active: items.find((p) => p.status === 'active') ?? null,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const body = await req.json().catch(() => ({})) as {
    period_start?: string;
    contacts_obligation?: string | null;
    kpi_plan?: string | null;
    deadline?: string | null;
    carry_campaign_ids?: string[];
  };
  const periodStart = dateOnly(body.period_start) ?? todayIso();

  const { data: project, error: projectErr } = await supabaseAdmin
    .from('projects')
    .select('id, contacts_obligation, contacts_done, kpi_plan, kpi_fact, deadline, launch_date, payment_date, created_at')
    .eq('id', projectId)
    .maybeSingle();
  if (projectErr) return jsonError(projectErr.message, 500);
  if (!project) return jsonError('Project not found', 404);
  const currentProject = project as ProjectRow;

  const { data: existingPeriods, error: periodsErr } = await supabaseAdmin
    .from('project_periods')
    .select('*')
    .eq('project_id', projectId)
    .order('period_start', { ascending: true });
  if (periodsErr) return jsonError(periodsErr.message, 500);

  const periods = (existingPeriods ?? []) as PeriodRow[];
  const previousActive = periods.find((p) => p.status === 'active') ?? null;
  const nextNumber = periods.length + (periods.length === 0 ? 2 : 1);
  const previousEnd = dayBefore(periodStart);

  if (periods.length === 0) {
    const firstStart =
      dateOnly(currentProject.launch_date) ??
      dateOnly(currentProject.payment_date) ??
      dateOnly(currentProject.created_at) ??
      periodStart;
    const { data: firstPeriod, error: firstErr } = await supabaseAdmin
      .from('project_periods')
      .insert({
        project_id: projectId,
        name: 'Period 1',
        status: 'closed',
        period_start: firstStart,
        period_end: previousEnd,
        contacts_obligation: currentProject.contacts_obligation,
        contacts_done: currentProject.contacts_done,
        kpi_plan: currentProject.kpi_plan,
        kpi_fact: currentProject.kpi_fact,
        deadline: currentProject.deadline,
      })
      .select('id')
      .maybeSingle();
    if (firstErr) return jsonError(firstErr.message, 500);

    if (supabaseInstantly && firstPeriod?.id) {
      const { data: legacyLinks } = await supabaseInstantly
        .from('project_instantly_campaigns')
        .select('project_id, campaign_id, match_source')
        .eq('project_id', projectId);
      const rows = (legacyLinks ?? []).map((link) => ({
        project_id: projectId,
        period_id: firstPeriod.id,
        campaign_id: (link as { campaign_id: string }).campaign_id,
        match_source: (link as { match_source?: string }).match_source ?? 'manual',
        baseline_contacts: 0,
      }));
      if (rows.length > 0) {
        await supabaseInstantly
          .from('project_period_instantly_campaigns')
          .upsert(rows, { onConflict: 'period_id,campaign_id', ignoreDuplicates: true });
      }
    }
  } else if (previousActive) {
    const { error: closeErr } = await supabaseAdmin
      .from('project_periods')
      .update({ status: 'closed', period_end: previousEnd, updated_at: new Date().toISOString() })
      .eq('id', previousActive.id);
    if (closeErr) return jsonError(closeErr.message, 500);
  }

  const newPeriodPayload = {
    project_id: projectId,
    name: `Period ${nextNumber}`,
    status: 'active',
    period_start: periodStart,
    period_end: null,
    contacts_obligation: body.contacts_obligation ?? currentProject.contacts_obligation,
    contacts_done: '0',
    kpi_plan: body.kpi_plan ?? currentProject.kpi_plan,
    kpi_fact: '0',
    deadline: body.deadline ?? currentProject.deadline,
  };

  const { data: newPeriod, error: newErr } = await supabaseAdmin
    .from('project_periods')
    .insert(newPeriodPayload)
    .select('*')
    .maybeSingle();
  if (newErr) return jsonError(newErr.message, 500);

  const carryCampaignIds = Array.isArray(body.carry_campaign_ids)
    ? body.carry_campaign_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (supabaseInstantly && newPeriod?.id && carryCampaignIds.length > 0) {
    const contactsByCampaign = await fetchCampaignContacts(carryCampaignIds);
    const rows = carryCampaignIds.map((campaignId) => ({
      project_id: projectId,
      period_id: newPeriod.id,
      campaign_id: campaignId,
      match_source: 'manual',
      baseline_contacts: contactsByCampaign.get(campaignId) ?? 0,
    }));
    await supabaseInstantly
      .from('project_period_instantly_campaigns')
      .upsert(rows, { onConflict: 'period_id,campaign_id', ignoreDuplicates: true });
  }

  const { error: updateProjectErr } = await supabaseAdmin
    .from('projects')
    .update({
      contacts_obligation: newPeriodPayload.contacts_obligation,
      contacts_done: '0',
      contacts_done_synced_at: null,
      kpi_plan: newPeriodPayload.kpi_plan,
      kpi_fact: '0',
      deadline: newPeriodPayload.deadline,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);
  if (updateProjectErr) return jsonError(updateProjectErr.message, 500);

  return NextResponse.json({ ok: true, period: newPeriod });
}
