import 'server-only';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import {
  partialAppendOutcome,
  selectAcceptedItems,
  type ExactAppendOutcome,
} from '@/lib/clientReports/appendOutcome';
import type { LeadCreatePayload } from '@/lib/instantly/types';

/**
 * Промоут «резерва» (dry-run строк) в уже созданные Instantly-кампании по score.
 *
 * Берёт готовые dry-run строки (валидная почта + почищенное имя + сайт),
 * раскладывает по бакетам клиента (score → campaign), строит лиды (primary +
 * 2-я почта = до 2 лидов на домен), зовёт appendLeadsToClientCampaign (тариф/
 * лимит/аккаунт внутри) и помечает строки status='routed' — чтобы они вышли из
 * dry-run-резерва и попали в дедуп. БЕЗ повторного 3-4ч прогона.
 *
 * custom_variables идентичны авто-раннеру: { score, source, domain }.
 *
 * opts: limit/minScore/maxScore — для контрольного теста (напр. 50 из chain3:
 * { limit:50, minScore:1000001 }).
 */

const READY = ['valid', 'role_address', 'free_provider', 'catch_all'];

interface CfgBucket {
  id: string;
  label: string;
  score_min: number;
  score_max: number | null;
  instantly_campaign_id: string | null;
  hasSteps: boolean;
}

interface SeenRow {
  hh_employer_id: string;
  company_name: string | null;
  site_url: string | null;
  domain: string | null;
  endpoint_score: number | null;
  source: string;
  resolved_email: string | null;
  email_validation_status: string | null;
  email2: string | null;
  email2_validation_status: string | null;
}

export function buildReservePromotionRunId(
  clientUserId: string,
  campaignId: string,
  sourceRowIds: readonly string[],
): string {
  const canonicalRows = [...new Set(sourceRowIds)].sort();
  const digest = createHash('sha256')
    .update(JSON.stringify([clientUserId, campaignId, canonicalRows]))
    .digest('hex')
    .slice(0, 32);
  return `reserve:${digest}`;
}

function acceptedReserveRowIds(
  leadRowIds: readonly string[],
  outcome: ExactAppendOutcome,
): string[] {
  const accepted = selectAcceptedItems(leadRowIds, outcome);
  if (accepted === null) {
    if (outcome.accepted === 0) return [];
    throw new Error('Reserve append returned accepted contacts without exact identities');
  }
  return [...new Set(accepted)];
}

async function markReserveRowsRouted(input: {
  clientUserId: string;
  bucketId: string;
  campaignId: string;
  rowIds: readonly string[];
}): Promise<void> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');
  for (let i = 0; i < input.rowIds.length; i += 200) {
    const slice = input.rowIds.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from('client_auto_pipeline_seen_employers')
      .update({
        status: 'routed',
        routed_bucket_id: input.bucketId,
        routed_campaign_id: input.campaignId,
      })
      .eq('client_user_id', input.clientUserId)
      .in('hh_employer_id', slice);
    if (error) throw new Error(`Failed to persist promoted reserve rows: ${error.message}`);
  }
}

export async function runPromoteReserve(
  clientUserId: string,
  opts: { limit?: number; minScore?: number; maxScore?: number } = {},
): Promise<{
  totalRows: number;
  results: Array<{ label: string; campaign: string; domains: number; leads: number; accepted: number }>;
  skippedNoBucket: number;
}> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');

  // 1. Бакеты клиента (id, диапазон, campaign, есть ли шаги).
  const { data: cfg, error: cfgErr } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('score_buckets')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  if (cfgErr) throw cfgErr;
  const rawBuckets = (cfg?.score_buckets ?? []) as Array<Record<string, unknown>>;
  const buckets: CfgBucket[] = rawBuckets.map((b) => ({
    id: String(b.id ?? ''),
    label: String(b.label ?? ''),
    score_min: Number(b.score_min),
    score_max: b.score_max == null ? null : Number(b.score_max),
    instantly_campaign_id: (b.instantly_campaign_id as string | null) ?? null,
    hasSteps:
      Array.isArray((b.sequence as { steps?: unknown[] })?.steps) &&
      ((b.sequence as { steps: unknown[] }).steps.length > 0),
  }));
  const pickBucket = (score: number | null): CfgBucket | null => {
    if (score == null) return null;
    for (const b of buckets) {
      if (score < b.score_min) continue;
      if (b.score_max != null && score > b.score_max) continue;
      return b;
    }
    return null;
  };

  // 2. Готовые dry-run строки (порядок по score desc — лучшие первыми).
  let q = supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select(
      'hh_employer_id, company_name, site_url, domain, endpoint_score, source, resolved_email, email_validation_status, email2, email2_validation_status',
    )
    .eq('client_user_id', clientUserId)
    .eq('status', 'dry_run')
    .in('email_validation_status', READY)
    .not('company_name', 'is', null)
    .not('site_url', 'is', null)
    .order('endpoint_score', { ascending: false });
  if (opts.minScore != null) q = q.gte('endpoint_score', opts.minScore);
  if (opts.maxScore != null) q = q.lte('endpoint_score', opts.maxScore);
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as SeenRow[];
  console.log(`[promote] ${rows.length} готовых dry-run строк к промоуту`);

  // A reserve promotion is not a new scoring cohort. Reuse the immutable
  // snapshot provenance created by the original auto run so accepted contacts
  // join that cohort instead of being counted as an unattributed legacy route.
  const snapshotByRowId = new Map<string, {
    id: string;
    sourceKind: string;
    sourceRunId: string | null;
    sourceJobId: string | null;
  }>();
  const rowIds = [...new Set(rows.map((row) => row.hh_employer_id))];
  for (let offset = 0; offset < rowIds.length; offset += 500) {
    const { data: snapshots, error: snapshotsError } = await supabaseAdmin
      .from('client_pipeline_domain_snapshots')
      .select('id, source_kind, source_run_id, source_job_id, source_row_id, scored_at')
      .eq('client_user_id', clientUserId)
      .eq('source_kind', 'auto_pipeline')
      .eq('legacy_inferred', false)
      .in('source_row_id', rowIds.slice(offset, offset + 500))
      .order('scored_at', { ascending: false });
    if (snapshotsError) throw new Error(`Failed to load reserve provenance: ${snapshotsError.message}`);
    for (const snapshot of (snapshots ?? []) as Array<{
      id: string;
      source_kind: string;
      source_run_id: string | null;
      source_job_id: string | null;
      source_row_id: string | null;
    }>) {
      if (!snapshot.source_row_id || snapshotByRowId.has(snapshot.source_row_id)) continue;
      snapshotByRowId.set(snapshot.source_row_id, {
        id: snapshot.id,
        sourceKind: snapshot.source_kind,
        sourceRunId: snapshot.source_run_id,
        sourceJobId: snapshot.source_job_id,
      });
    }
  }

  // 3. Группируем лиды по кампании.
  const byCampaign = new Map<string, {
    bucket: CfgBucket;
    leads: LeadCreatePayload[];
    leadRowIds: string[];
    rowIds: string[];
  }>();
  let skippedNoBucket = 0;
  for (const r of rows) {
    const b = pickBucket(r.endpoint_score);
    if (!b || !b.hasSteps || !b.instantly_campaign_id) {
      skippedNoBucket++;
      continue;
    }
    const snapshot = snapshotByRowId.get(r.hh_employer_id);
    const cv = {
      score: String(r.endpoint_score ?? ''),
      source: r.source,
      domain: r.domain ?? '',
      source_row_id: r.hh_employer_id,
      ...(snapshot ? {
        domain_snapshot_id: snapshot.id,
        source_kind: snapshot.sourceKind,
        ...(snapshot.sourceRunId ? { source_run_id: snapshot.sourceRunId } : {}),
        ...(snapshot.sourceJobId ? { source_job_id: snapshot.sourceJobId } : {}),
      } : {}),
    };
    const leads: LeadCreatePayload[] = [];
    if (r.resolved_email && READY.includes(r.email_validation_status ?? '')) {
      leads.push({ email: r.resolved_email, company_name: r.company_name!, website: r.site_url ?? undefined, custom_variables: cv });
    }
    if (r.email2 && r.email2 !== '' && READY.includes(r.email2_validation_status ?? '')) {
      leads.push({ email: r.email2, company_name: r.company_name!, website: r.site_url ?? undefined, custom_variables: cv });
    }
    if (leads.length === 0) continue;
    let g = byCampaign.get(b.instantly_campaign_id);
    if (!g) {
      g = { bucket: b, leads: [], leadRowIds: [], rowIds: [] };
      byCampaign.set(b.instantly_campaign_id, g);
    }
    g.leads.push(...leads);
    g.leadRowIds.push(...leads.map(() => r.hh_employer_id));
    g.rowIds.push(r.hh_employer_id);
  }

  // 4. Заливаем по кампаниям + помечаем routed ТОЛЬКО после успеха.
  const results: Array<{ label: string; campaign: string; domains: number; leads: number; accepted: number }> = [];
  for (const [campaignId, g] of byCampaign) {
    console.log(`[promote] → ${g.bucket.label}: ${g.leads.length} лидов (${g.rowIds.length} доменов) в ${campaignId}`);
    const runId = buildReservePromotionRunId(clientUserId, campaignId, g.rowIds);
    let res: Awaited<ReturnType<typeof appendLeadsToClientCampaign>>;
    try {
      res = await appendLeadsToClientCampaign({
        userId: clientUserId,
        campaignId,
        leads: g.leads,
        contextLabel: `promote:${g.bucket.label}`,
        ledgerSource: {
          kind: 'auto_pipeline',
          runId,
          campaignName: g.bucket.label,
        },
      });
    } catch (error) {
      const partial = partialAppendOutcome(error);
      if (partial) {
        await markReserveRowsRouted({
          clientUserId,
          bucketId: g.bucket.id,
          campaignId,
          rowIds: acceptedReserveRowIds(g.leadRowIds, partial),
        });
      }
      throw error;
    }
    // mark routed чанками (in() имеет лимит длины URL).
    await markReserveRowsRouted({
      clientUserId,
      bucketId: g.bucket.id,
      campaignId,
      rowIds: acceptedReserveRowIds(g.leadRowIds, res),
    });
    results.push({ label: g.bucket.label, campaign: campaignId, domains: g.rowIds.length, leads: g.leads.length, accepted: res.accepted });
  }

  console.log(`[promote] ГОТОВО: ${results.map((r) => `${r.label}=${r.accepted}/${r.leads}`).join(', ')} | skippedNoBucket=${skippedNoBucket}`);
  return { totalRows: rows.length, results, skippedNoBucket };
}
