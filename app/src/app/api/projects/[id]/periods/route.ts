import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  checkCampaignProjectOwnershipConflicts,
  releasePeriodCampaignReservations,
  reservePeriodCampaignLinks,
  type CampaignProjectMatchSource,
  type PeriodCampaignReservation,
} from '@/lib/instantly/campaignProjectOwnership';

export const dynamic = 'force-dynamic';

type ProjectRow = {
  id: string;
  budget: string | null;
  margin: string | null;
  payment_date: string | null;
  contacts_obligation: string | null;
  contacts_done: string | null;
  kpi_plan: string | null;
  kpi_fact: string | null;
  deadline: string | null;
  launch_date: string | null;
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
  budget: string | null;
  margin: string | null;
  payment_date: string | null;
  created_at: string;
};

type PeriodCampaignLink = {
  campaignId: string;
  matchSource: CampaignProjectMatchSource;
  baselineContacts: number;
};

const PERIOD_READBACK_COLUMNS = [
  'id',
  'project_id',
  'name',
  'status',
  'period_start',
  'period_end',
  'contacts_obligation',
  'contacts_done',
  'contacts_done_synced_at',
  'kpi_plan',
  'kpi_fact',
  'deadline',
  'budget',
  'margin',
  'payment_date',
  'created_at',
].join(', ');

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

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function hasBodyField<T extends object>(body: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

async function fetchCampaignContacts(ids: string[]): Promise<{
  contactsByCampaign: Map<string, number>;
  error: string | null;
}> {
  const map = new Map<string, number>();
  if (ids.length === 0) return { contactsByCampaign: map, error: null };
  if (!supabaseInstantly) {
    return { contactsByCampaign: map, error: 'Instantly database is unavailable' };
  }
  const { data, error } = await supabaseInstantly
    .from('instantly_campaign_catalog')
    .select('id, new_leads_contacted_count')
    .in('id', ids);
  if (error) return { contactsByCampaign: map, error: error.message };
  for (const row of data ?? []) {
    const n = Number((row as { new_leads_contacted_count?: number | null }).new_leads_contacted_count);
    map.set((row as { id: string }).id, Number.isFinite(n) ? n : 0);
  }
  return { contactsByCampaign: map, error: null };
}

function normalizeMatchSource(value: unknown): CampaignProjectMatchSource {
  return value === 'auto' || value === 'auto-text' || value === 'auto-ai' || value === 'manual'
    ? value
    : 'manual';
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
    budget?: string | null;
    margin?: string | null;
    payment_date?: string | null;
    contacts_obligation?: string | null;
    kpi_plan?: string | null;
    deadline?: string | null;
    carry_campaign_ids?: string[];
  };
  const periodStart = dateOnly(body.period_start) ?? todayIso();

  const { data: project, error: projectErr } = await supabaseAdmin
    .from('projects')
    .select('id, budget, margin, payment_date, contacts_obligation, contacts_done, kpi_plan, kpi_fact, deadline, launch_date, created_at')
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

  // Старт нового периода = граница: предыдущий период закрывается датой
  // `dayBefore(periodStart)`. Если новый старт раньше старта предыдущего
  // периода, у того получится period_end < period_start (отрицательный
  // диапазон) — именно так «сломался» Лайфтранс (Period 2 ввели на 05-13,
  // тогда как Period 1 стартовал 05-18, и его конец вычислился как 05-12).
  // Гард ловит только реальную дату-предшественника; если у проекта нет
  // ни launch/payment/created — валидации нет (старое поведение).
  const priorStart =
    periods.length === 0
      ? dateOnly(currentProject.launch_date) ??
        dateOnly(currentProject.payment_date) ??
        dateOnly(currentProject.created_at)
      : previousActive?.period_start ?? null;
  if (priorStart && periodStart <= priorStart) {
    return jsonError(
      `Старт нового периода (${periodStart}) должен быть позже старта предыдущего (${priorStart})`,
      400,
    );
  }

  const carryCampaignIds = Array.isArray(body.carry_campaign_ids)
    ? [...new Set(body.carry_campaign_ids.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ))]
    : [];
  let legacyLinksToCopy: PeriodCampaignLink[] = [];
  if (periods.length === 0 && supabaseInstantly) {
    const { data: legacyLinks, error: legacyLinksError } = await supabaseInstantly
      .from('project_instantly_campaigns')
      .select('project_id, campaign_id, match_source')
      .eq('project_id', projectId);
    if (legacyLinksError) return jsonError(legacyLinksError.message, 500);
    legacyLinksToCopy = (legacyLinks ?? []).map((link) => ({
      campaignId: String((link as { campaign_id: unknown }).campaign_id),
      matchSource: normalizeMatchSource((link as { match_source?: unknown }).match_source),
      baselineContacts: 0,
    }));
  }

  // Main periods and Instantly ownership live in separate databases. Validate
  // every intended campaign before closing/creating a main-DB period so a
  // known foreign owner cannot leave the project half-mutated.
  if (supabaseInstantly) {
    try {
      const conflicts = await checkCampaignProjectOwnershipConflicts(
        supabaseInstantly,
        projectId,
        [
          ...legacyLinksToCopy.map((link) => link.campaignId),
          ...carryCampaignIds,
        ],
      );
      if (conflicts.length > 0) {
        return jsonError(
          `Campaign ${conflicts[0].campaignId} is already assigned to another project`,
          409,
        );
      }
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : 'Campaign ownership preflight failed',
        500,
      );
    }
  }

  // Reserve every Instantly period link in one transaction before touching
  // the main DB. Pre-generated UUIDs let us compensate the reservation if a
  // later main-DB statement fails.
  const firstPeriodId = periods.length === 0 ? randomUUID() : null;
  const newPeriodId = randomUUID();
  const contactsRead = await fetchCampaignContacts(carryCampaignIds);
  if (contactsRead.error) return jsonError(contactsRead.error, 500);
  const contactsByCampaign = contactsRead.contactsByCampaign;
  const reservations: PeriodCampaignReservation[] = [
    ...legacyLinksToCopy.flatMap((link) => firstPeriodId
      ? [{
          periodId: firstPeriodId,
          campaignId: link.campaignId,
          matchSource: link.matchSource,
          baselineContacts: link.baselineContacts,
        }]
      : []),
    ...carryCampaignIds.map((campaignId) => ({
      periodId: newPeriodId,
      campaignId,
      matchSource: 'manual' as const,
      baselineContacts: contactsByCampaign.get(campaignId) ?? 0,
    })),
  ];
  const reservedPeriodIds = [...new Set(reservations.map((link) => link.periodId))];

  async function releaseReservationsBestEffort(reason: string): Promise<void> {
    if (!supabaseInstantly || reservedPeriodIds.length === 0) return;
    try {
      await releasePeriodCampaignReservations(
        supabaseInstantly,
        projectId,
        reservedPeriodIds,
      );
    } catch (error) {
      console.error(
        `[periods] Instantly reservation cleanup failed after ${reason}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (supabaseInstantly && reservations.length > 0) {
    let reservation: Awaited<ReturnType<typeof reservePeriodCampaignLinks>> | null = null;
    let reservationError: unknown = null;
    for (let attempt = 0; attempt < 2 && !reservation; attempt += 1) {
      try {
        reservation = await reservePeriodCampaignLinks(
          supabaseInstantly,
          projectId,
          reservations,
        );
      } catch (error) {
        reservationError = error;
      }
    }
    if (!reservation) {
      // A lost response does not prove rollback. Replaying the same idempotent
      // reservation is a lock barrier for a still-running first transaction.
      // If both responses are lost, keep the pre-generated reservations: an
      // early cleanup could otherwise race a late commit and detach the period.
      return jsonError(
        reservationError instanceof Error
          ? reservationError.message
          : 'Campaign period reservation state is unknown',
        500,
      );
    }
    if (reservation.status === 'conflict') {
      return jsonError('One or more campaigns are already assigned to another project', 409);
    }
  }

  const transitionParams = {
    p_project_id: projectId,
    p_expected_period_count: periods.length,
    p_expected_active_period_id: previousActive?.id ?? null,
    p_first_period_id: firstPeriodId,
    p_new_period_id: newPeriodId,
    p_period_start: periodStart,
    p_has_contacts_obligation: hasBodyField(body, 'contacts_obligation'),
    p_contacts_obligation: textOrNull(body.contacts_obligation),
    p_has_kpi_plan: hasBodyField(body, 'kpi_plan'),
    p_kpi_plan: textOrNull(body.kpi_plan),
    p_has_deadline: hasBodyField(body, 'deadline'),
    p_deadline: dateOnly(body.deadline),
    p_has_budget: hasBodyField(body, 'budget'),
    p_budget: textOrNull(body.budget),
    p_has_margin: hasBodyField(body, 'margin'),
    p_margin: textOrNull(body.margin),
    p_has_payment_date: hasBodyField(body, 'payment_date'),
    p_payment_date: dateOnly(body.payment_date),
  };

  function parseTransitionPeriod(data: unknown): PeriodRow | null {
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw || typeof raw !== 'object') return null;
    const period = (raw as { period?: unknown }).period;
    if (!period || typeof period !== 'object') return null;
    const row = period as Partial<PeriodRow>;
    if (row.id !== newPeriodId || row.project_id !== projectId) return null;
    return row as PeriodRow;
  }

  async function readBackCommittedPeriod(): Promise<{
    period: PeriodRow | null;
    error: string | null;
  }> {
    try {
      const { data, error } = await supabaseAdmin!
        .from('project_periods')
        .select(PERIOD_READBACK_COLUMNS)
        .eq('id', newPeriodId)
        .eq('project_id', projectId)
        .maybeSingle();
      if (error) return { period: null, error: error.message };
      return { period: (data as PeriodRow | null) ?? null, error: null };
    } catch (error) {
      return {
        period: null,
        error: error instanceof Error ? error.message : 'period read-back failed',
      };
    }
  }

  type TransitionAttempt = {
    period: PeriodRow | null;
    error: { message: string; code?: string } | null;
    ambiguous: boolean;
  };

  async function attemptTransition(): Promise<TransitionAttempt> {
    try {
      const result = await supabaseAdmin!.rpc('transition_project_period', transitionParams);
      if (result.error) {
        const rpcFailure = result.error as { message: string; code?: string };
        return {
          period: null,
          error: rpcFailure,
          // Postgres errors carry a code and prove that the transaction ended.
          // Missing codes and thrown errors are treated as transport ambiguity.
          ambiguous: !rpcFailure.code,
        };
      }
      const period = parseTransitionPeriod(result.data);
      return {
        period,
        error: period ? null : { message: 'Project period transition returned no period' },
        ambiguous: false,
      };
    } catch (error) {
      return {
        period: null,
        error: {
          message: error instanceof Error ? error.message : 'project period transition failed',
        },
        ambiguous: true,
      };
    }
  }

  let transition = await attemptTransition();
  if (transition.period) {
    return NextResponse.json({ ok: true, period: transition.period });
  }
  const hadAmbiguousTransition = transition.ambiguous;

  // Replaying the same idempotency key is also a database lock barrier: if the
  // first call is still committing after a lost response, the retry waits for
  // it and returns that exact period instead of racing compensation against it.
  if (hadAmbiguousTransition) {
    transition = await attemptTransition();
    if (transition.period) {
      return NextResponse.json({ ok: true, period: transition.period });
    }
  }

  // A missing/malformed representation can still accompany a committed row.
  // Read by the pre-generated ID; never delete main rows or replay triggers.
  const readBack = await readBackCommittedPeriod();
  if (readBack.period) {
    return NextResponse.json({ ok: true, period: readBack.period });
  }
  if (readBack.error) {
    console.error('[periods] main transition state is unknown:', readBack.error);
    // Preserve Instantly reservations: without a successful read-back, main
    // non-commit has not been proven.
    return jsonError(transition.error?.message ?? 'Project period transition state is unknown', 500);
  }
  if (hadAmbiguousTransition || transition.ambiguous) {
    // Even an empty read-back is not a barrier after an ambiguous first call.
    // The retry itself may have failed before it entered the SQL function, so
    // any retry error (including one with a PostgREST/Postgres code) leaves the
    // first request capable of a late commit. Preserve reservations.
    return jsonError(transition.error?.message ?? 'Project period transition state is unknown', 500);
  }

  // A definitive RPC response plus a successful empty read-back proves that the
  // main transaction did not commit. Cross-DB reservations can now be released.
  await releaseReservationsBestEffort('definitive main DB non-commit');
  const message = transition.error?.message ?? 'Project period transition returned no period';
  const status = message.includes('project_period_state_changed')
    ? 409
    : message.includes('period_start_must_follow_previous')
      ? 400
      : message.includes('project_not_found')
        ? 404
        : 500;
  return jsonError(message, status);
}
