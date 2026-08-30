import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { CampaignStatus } from '@/lib/instantly/types';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import {
  evaluateLaunchActivationHeads,
  evaluateLaunchCapacity,
  type VeLaunchActivationQueueItem,
  type VeLaunchCapacityBundleScope,
  type VeLaunchPortfolioStatus,
} from '@/lib/verticalEngineV2/launchPortfolio';
import {
  refreshRuLaunchPortfolioTiming,
  VeLaunchTimingRefreshError,
} from '@/lib/verticalEngineV2/launchPortfolioTiming';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

type Row = Record<string, unknown>;
type RankableRow = Row & VeLaunchActivationQueueItem;

const SLOT_HOLDER_STATUSES = new Set(['activating', 'active', 'uncertain']);
const QUEUE_PAGE_SIZE = 200;
const MAX_QUEUE_ITEMS = 10_000;
const RELATED_ID_CHUNK_SIZE = 200;
const RELATED_ROWS_PAGE_SIZE = 200;
const PORTFOLIO_STATUSES = new Set<VeLaunchPortfolioStatus>([
  'prepared',
  'queued',
  'activating',
  'active',
  'uncertain',
  'released',
  'skipped',
  'cancelled',
]);

function jsonError(error: string, status: number, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function byId(rows: Row[]): Map<string, Row> {
  return new Map(
    rows
      .filter((row) => typeof row.id === 'string')
      .map((row) => [row.id as string, row]),
  );
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function remoteStatusLabel(value: unknown): string | null {
  if (value === CampaignStatus.Draft) return 'draft';
  if (value === CampaignStatus.Active) return 'active';
  if (value === CampaignStatus.Paused) return 'paused';
  if (value === CampaignStatus.Completed) return 'completed';
  if (value === CampaignStatus.RunningSubsequences) return 'running_subsequences';
  if (value === CampaignStatus.AccountSuspended) return 'account_suspended';
  if (value === CampaignStatus.AccountsUnhealthy) return 'accounts_unhealthy';
  if (value === CampaignStatus.BounceProtect) return 'bounce_protect';
  return null;
}

function capacityScope(row: Row): VeLaunchCapacityBundleScope | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.instantly_account_id !== 'string' ||
    typeof row.status !== 'string' ||
    !PORTFOLIO_STATUSES.has(row.status as VeLaunchPortfolioStatus)
  ) {
    return null;
  }
  return {
    id: row.id,
    instantly_account_id: row.instantly_account_id,
    mailbox_ids: row.mailbox_ids,
    status: row.status as VeLaunchPortfolioStatus,
  };
}

async function readRowsByIds(
  db: NonNullable<typeof supabaseAdmin>,
  input: {
    table: string;
    columns: string;
    idColumn: string;
    ids: readonly string[];
  },
): Promise<{ data: Row[]; error: { message: string } | null }> {
  const rows: Row[] = [];
  for (let offset = 0; offset < input.ids.length; offset += RELATED_ID_CHUNK_SIZE) {
    const ids = input.ids.slice(offset, offset + RELATED_ID_CHUNK_SIZE);
    let pageOffset = 0;
    let total: number | null = null;
    while (total === null || pageOffset < total) {
      const { data, error, count } = await db
        .from(input.table)
        .select(input.columns, { count: 'exact' })
        .in(input.idColumn, ids)
        .order('id', { ascending: true })
        .range(pageOffset, pageOffset + RELATED_ROWS_PAGE_SIZE - 1);
      if (error) return { data: [], error };
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        return {
          data: [],
          error: { message: `Could not verify complete ${input.table} result` },
        };
      }
      if (total === null) total = count;
      else if (count !== total) {
        return {
          data: [],
          error: { message: `${input.table} changed during pagination` },
        };
      }
      const page = (data ?? []) as unknown as Row[];
      if (page.length === 0 && pageOffset < total) {
        return {
          data: [],
          error: { message: `${input.table} pagination stopped before completion` },
        };
      }
      rows.push(...page);
      pageOffset += page.length;
    }
  }
  return { data: rows, error: null };
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.launch-portfolio.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500, 'SERVER_MISCONFIGURED');

      const requestedMarket = new URL(req.url).searchParams.get('market')?.trim().toLowerCase();
      const market = requestedMarket === 'us' ? 'us' : 'ru';
      const requestNow = new Date();

      if (market === 'ru') {
        try {
          await refreshRuLaunchPortfolioTiming({ db: supabaseAdmin, now: requestNow });
        } catch (error) {
          const code = error instanceof VeLaunchTimingRefreshError
            ? error.code
            : 'VE_LAUNCH_TIMING_REFRESH_FAILED';
          const message = error instanceof Error ? error.message : 'Launch timing refresh failed';
          return jsonError(message, 500, code);
        }
      }

      const settingsResult = await supabaseAdmin
        .from('ve_launch_portfolio_settings')
        .select('market, max_active_bundles, timezone, mode, default_slot_days, plan_version')
        .eq('market', market)
        .maybeSingle();
      if (settingsResult.error) {
        return jsonError(settingsResult.error.message, 500, 'VE_LAUNCH_SETTINGS_READ_FAILED');
      }

      const rawItems: Row[] = [];
      let queueOffset = 0;
      let queueTotal: number | null = null;
      while (queueTotal === null || queueOffset < queueTotal) {
        const itemsResult = await supabaseAdmin
          .from('ve_launch_queue_items')
          .select(
            'id, project_id, vertical_id, hypothesis_id, base_id, template_id, instantly_account_id, mailbox_ids, status, manual_order, not_before, latest_activation_at, seasonality_confidence, seasonality_snapshot, potential_pct, estimated_run_days, priority_snapshot, plan_version, priority_override_decision, priority_override_reason, priority_overridden_by, priority_overridden_at, activation_error, activation_started_at, ever_active_at, created_at, updated_at',
            { count: 'exact' },
          )
          .eq('portfolio_id', market)
          .order('id', { ascending: true })
          .range(queueOffset, queueOffset + QUEUE_PAGE_SIZE - 1);
        if (itemsResult.error) {
          return jsonError(itemsResult.error.message, 500, 'VE_LAUNCH_QUEUE_READ_FAILED');
        }
        if (
          typeof itemsResult.count !== 'number'
          || !Number.isSafeInteger(itemsResult.count)
          || itemsResult.count < 0
        ) {
          return jsonError(
            'Launch queue completeness could not be verified',
            500,
            'VE_LAUNCH_QUEUE_INCOMPLETE',
          );
        }
        if (queueTotal === null) queueTotal = itemsResult.count;
        else if (queueTotal !== itemsResult.count) {
          return jsonError(
            'Launch queue changed during pagination',
            409,
            'VE_LAUNCH_QUEUE_CHANGED',
          );
        }
        if (queueTotal > MAX_QUEUE_ITEMS) {
          return jsonError(
            `Launch queue exceeds the safe ${MAX_QUEUE_ITEMS}-item limit`,
            409,
            'VE_LAUNCH_QUEUE_TOO_LARGE',
          );
        }
        const page = (itemsResult.data ?? []) as Row[];
        if (page.length === 0 && queueOffset < queueTotal) {
          return jsonError(
            'Launch queue pagination stopped before completion',
            500,
            'VE_LAUNCH_QUEUE_INCOMPLETE',
          );
        }
        rawItems.push(...page);
        queueOffset += page.length;
      }
      const projectIds = [...new Set(
        rawItems
          .map((row) => row.project_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      )];
      const projectsResult = await readRowsByIds(supabaseAdmin, {
        table: 've_projects',
        columns: 'id, name, website_url, market',
        idColumn: 'id',
        ids: projectIds,
      });
      if (projectsResult.error) {
        return jsonError(projectsResult.error.message, 500, 'VE_LAUNCH_PROJECTS_READ_FAILED');
      }

      const projects = (projectsResult.data ?? []) as Row[];
      const projectMap = byId(projects);
      const marketItems = rawItems.filter((item) => {
        const project = typeof item.project_id === 'string' ? projectMap.get(item.project_id) : null;
        const projectMarket = typeof project?.market === 'string' ? project.market : 'ru';
        return project != null && projectMarket === market;
      });

      const itemIds = marketItems.map((row) => row.id).filter((id): id is string => typeof id === 'string');
      const verticalIds = [...new Set(
        marketItems.map((row) => row.vertical_id).filter((id): id is string => typeof id === 'string'),
      )];
      const hypothesisIds = [...new Set(
        marketItems.map((row) => row.hypothesis_id).filter((id): id is string => typeof id === 'string'),
      )];

      const [campaignsResult, verticalsResult, hypothesesResult] = await Promise.all([
        readRowsByIds(supabaseAdmin, {
          table: 've_launch_queue_campaigns',
          columns:
            'id, item_id, campaign_id, campaign_name, campaign_url, segment, leads_count, remote_status, status_observed_at, created_at, updated_at',
          idColumn: 'item_id',
          ids: itemIds,
        }),
        readRowsByIds(supabaseAdmin, {
          table: 've_verticals',
          columns: 'id, name',
          idColumn: 'id',
          ids: verticalIds,
        }),
        readRowsByIds(supabaseAdmin, {
          table: 've_hypotheses',
          columns: 'id, title',
          idColumn: 'id',
          ids: hypothesisIds,
        }),
      ]);
      const relatedError = campaignsResult.error ?? verticalsResult.error ?? hypothesesResult.error;
      if (relatedError) {
        return jsonError(relatedError.message, 500, 'VE_LAUNCH_RELATED_DATA_READ_FAILED');
      }

      const campaigns = (campaignsResult.data ?? []) as Row[];
      const campaignsByItem = new Map<string, Row[]>();
      for (const campaign of campaigns) {
        if (typeof campaign.item_id !== 'string') continue;
        const group = campaignsByItem.get(campaign.item_id) ?? [];
        group.push(campaign);
        campaignsByItem.set(campaign.item_id, group);
      }
      const verticalMap = byId((verticalsResult.data ?? []) as Row[]);
      const hypothesisMap = byId((hypothesesResult.data ?? []) as Row[]);

      const rankableItems: RankableRow[] = marketItems.map((item) => ({
          ...item,
          id: String(item.id ?? ''),
          manual_order: typeof item.manual_order === 'number' ? item.manual_order : null,
          latest_activation_at:
            typeof item.latest_activation_at === 'string' ? item.latest_activation_at : null,
          seasonality_confidence:
            item.seasonality_confidence === 'low' ||
            item.seasonality_confidence === 'medium' ||
            item.seasonality_confidence === 'high'
              ? item.seasonality_confidence
              : null,
          potential_pct: finiteNumber(item.potential_pct),
          created_at: typeof item.created_at === 'string' ? item.created_at : '',
          instantly_account_id: item.instantly_account_id,
          mailbox_ids: item.mailbox_ids,
          status: item.status,
          not_before: item.not_before,
          priority_snapshot: item.priority_snapshot,
          priority_override_decision: item.priority_override_decision,
          priority_override_reason: item.priority_override_reason,
          priority_overridden_by: item.priority_overridden_by,
          priority_overridden_at: item.priority_overridden_at,
        }));
      const settings = settingsResult.data as Row | null;
      const mode = settings?.mode === 'enforced' ? 'enforced' : 'advisory';
      const { ranked, marks: activationHeadMarks } = evaluateLaunchActivationHeads(
        rankableItems,
        { as_of: requestNow.toISOString(), mode },
      );

      const maxActiveBundles = Math.max(1, Math.trunc(finiteNumber(settings?.max_active_bundles, 1)));
      const planVersion = Math.max(1, Math.trunc(finiteNumber(settings?.plan_version, 1)));
      const capacityScopes = marketItems
        .map(capacityScope)
        .filter((scope): scope is VeLaunchCapacityBundleScope => scope !== null);
      const items: Row[] = ranked.map((item, index) => {
        const project = typeof item.project_id === 'string' ? projectMap.get(item.project_id) : null;
        const vertical = typeof item.vertical_id === 'string' ? verticalMap.get(item.vertical_id) : null;
        const hypothesis = typeof item.hypothesis_id === 'string'
          ? hypothesisMap.get(item.hypothesis_id)
          : null;
        const rawPriority = item.priority_snapshot &&
          typeof item.priority_snapshot === 'object' &&
          !Array.isArray(item.priority_snapshot)
          ? item.priority_snapshot as Row
          : {};
        const candidateScope = capacityScope(item);
        const capacity = candidateScope
          ? evaluateLaunchCapacity({
              candidate: candidateScope,
              holders: capacityScopes,
              max_active_bundles: maxActiveBundles,
            })
          : null;
        const activationHead = activationHeadMarks.get(item.id) ?? {
          activation_admissible: false,
          is_activation_head: false,
          activation_head_id: null,
        };
        return {
          ...item,
          rank: index + 1,
          ...activationHead,
          project_name: typeof project?.name === 'string' ? project.name : null,
          project_website_url:
            typeof project?.website_url === 'string' ? project.website_url : null,
          vertical_name: typeof vertical?.name === 'string' ? vertical.name : null,
          hypothesis_title: typeof hypothesis?.title === 'string' ? hypothesis.title : null,
          seasonality:
            item.seasonality_snapshot && typeof item.seasonality_snapshot === 'object'
              ? item.seasonality_snapshot
              : null,
          priority_snapshot: {
            ...rawPriority,
            confidence: item.seasonality_confidence ?? rawPriority.confidence ?? null,
            potential_pct: finiteNumber(item.potential_pct),
            manual_order: typeof item.manual_order === 'number' ? item.manual_order : null,
          },
          capacity: {
            max_active_bundles: maxActiveBundles,
            occupied_bundles: capacity?.occupied_slots ?? 0,
            slot_available: capacity?.allowed ?? false,
            blocking_bundle_ids: capacity?.blocking_bundle_ids ?? [],
          },
          campaigns: (campaignsByItem.get(item.id) ?? []).map((campaign) => ({
            ...campaign,
            status: remoteStatusLabel(campaign.remote_status),
          })),
        };
      });

      const activeItems = items.filter(
        (item) => typeof item.status === 'string' && SLOT_HOLDER_STATUSES.has(item.status),
      );
      const estimatedReleaseTimes = activeItems
        .map((item) => {
          const started = typeof item.ever_active_at === 'string'
            ? item.ever_active_at
            : typeof item.activation_started_at === 'string'
              ? item.activation_started_at
              : null;
          const days = finiteNumber(item.estimated_run_days, 0);
          const startedMs = started ? Date.parse(started) : Number.NaN;
          return Number.isFinite(startedMs) && days > 0
            ? startedMs + days * 24 * 60 * 60 * 1000
            : null;
        })
        .filter((value): value is number => value !== null);
      const nextEstimatedReleaseAt = estimatedReleaseTimes.length > 0
        ? new Date(Math.min(...estimatedReleaseTimes)).toISOString()
        : null;
      const asOf = requestNow.toISOString();

      return NextResponse.json({
        market,
        as_of: asOf,
        timezone: typeof settings?.timezone === 'string' ? settings.timezone : 'Europe/Moscow',
        mode,
        plan_version: planVersion,
        capacity: {
          max_active_bundles: maxActiveBundles,
          occupied_bundles: activeItems.length,
          active_bundles: activeItems.length,
          next_estimated_release_at: nextEstimatedReleaseAt,
        },
        items,
      });
    },
  );
}
