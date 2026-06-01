import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { getResourceInstantlyAccountId, isResourceAllowed } from '@/lib/clientAccess';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  getCampaign,
  getCampaignAnalytics,
  getCampaignAnalyticsSteps,
  updateCampaign,
} from '@/lib/instantly/client';
import { cached, invalidate } from '@/lib/clientCache';
import {
  clientLaunchStepsToCampaignSequences,
  hasUsableCampaignSequences,
} from '@/lib/clientLaunch/campaignSequences';
import { normalizeClientLaunchSequenceSteps } from '@/lib/clientLaunch/requestParsing';
import { toInstantlyHtmlBody, sequenceHasMarkdownLink } from '@/lib/clientLaunch/buildCampaignPayload';
import { validateClientLaunchSequence } from '@/lib/clientLaunch/validateLaunchInput';
import {
  buildCampaignSchedule,
  validateScheduleOverride,
} from '@/lib/clientLaunch/scheduleMapping';
import type { ClientLaunchScheduleOverride, ClientLaunchSequence } from '@/lib/clientLaunch/types';
import type { CampaignUpdatePayload } from '@/lib/instantly/types';
import { logAudit, logError } from '@/lib/loggerServer';
import { upsertInstantlyCatalogFromCampaign } from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';

const DETAIL_TTL = 15 * 60 * 1000;

interface CampaignPatchBody {
  campaign_name?: unknown;
  sequence_steps?: unknown;
  /**
   * Optional per-edit schedule override. When present, validated and pushed
   * to Instantly as campaign_schedule. Shape mirrors ClientLaunchScheduleOverride.
   * Omit to leave the campaign's current schedule untouched.
   */
  schedule?: unknown;
}

/**
 * Parse the optional `schedule` field from the PATCH body into a
 * ClientLaunchScheduleOverride, or undefined if absent/malformed. Strict
 * validation (HH:MM, days, to>from) happens after via validateScheduleOverride.
 */
function parseScheduleFromBody(raw: unknown): ClientLaunchScheduleOverride | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const from = typeof obj.from === 'string' ? obj.from : undefined;
  const to = typeof obj.to === 'string' ? obj.to : undefined;
  const timezone = typeof obj.timezone === 'string' ? obj.timezone : undefined;
  const days = Array.isArray(obj.days)
    ? obj.days.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6)
    : undefined;
  // Require all four fields — a partial schedule is meaningless for Instantly
  // (it replaces the whole campaign_schedule block).
  if (from === undefined || to === undefined || timezone === undefined || days === undefined) {
    return undefined;
  }
  return { from, to, days, timezone };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
  const { userId, accessRows } = result.auth;

  const { id: campaignId } = await ctx.params;

  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }
  const instantlyRequestOptions = {
    accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
  };

  try {
    const [campaign, analyticsData, stepsData] = await Promise.all([
      cached(`instantly:${instantlyRequestOptions.accountId}:campaign:${campaignId}`, () => getCampaign(campaignId, instantlyRequestOptions), DETAIL_TTL),
      cached(
        `instantly:${instantlyRequestOptions.accountId}:analytics:${campaignId}`,
        () => getCampaignAnalytics({ campaign_id: campaignId }, instantlyRequestOptions).catch(() => []),
        DETAIL_TTL,
      ),
      cached(
        `instantly:${instantlyRequestOptions.accountId}:steps:${campaignId}`,
        () => getCampaignAnalyticsSteps({ campaign_id: campaignId }, instantlyRequestOptions).catch(() => []),
        DETAIL_TTL,
      ),
    ]);

    const analyticsArr = Array.isArray(analyticsData) ? analyticsData : [];
    const analytics = analyticsArr.find(
      (a) => a.campaign_id === campaignId || (a as Record<string, unknown>).id === campaignId,
    ) ?? null;

    const stepsArr = Array.isArray(stepsData) ? stepsData : [];
    const steps = stepsArr
      .filter((item) => {
        const stepVal = String(item.step ?? '');
        return stepVal !== '\\N' && stepVal !== 'null' && stepVal !== '';
      })
      .map((item) => ({
        ...item,
        step: Number(item.step) || 0,
        variant: Number(item.variant) || 0,
      }))
      .sort((a, b) => a.step - b.step || a.variant - b.variant);

    let campaignForResponse = campaign;
    if (!hasUsableCampaignSequences(campaign.sequences)) {
      const { data: launchRow } = await supabaseInstantly
        .from('client_campaign_launches')
        .select('sequence_steps')
        .eq('client_user_id', userId)
        .eq('instantly_campaign_id', campaignId)
        .maybeSingle();

      const fallbackSequences = clientLaunchStepsToCampaignSequences(
        (launchRow as { sequence_steps?: unknown } | null)?.sequence_steps,
      );
      if (fallbackSequences) {
        campaignForResponse = { ...campaign, sequences: fallbackSequences };
      }
    }

    return NextResponse.json({ campaign: campaignForResponse, analytics, steps });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка загрузки';
    return jsonError(message, 500);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
  const { userId, accessRows } = result.auth;

  const { id: campaignId } = await ctx.params;

  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  let body: CampaignPatchBody;
  try {
    body = (await req.json()) as CampaignPatchBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const sequence: ClientLaunchSequence = {
    name: typeof body.campaign_name === 'string' ? body.campaign_name : '',
    steps: normalizeClientLaunchSequenceSteps(body.sequence_steps),
  };

  const validation = validateClientLaunchSequence(sequence);
  if (!validation.ok) return jsonError(validation.error, 400);

  const sequences = clientLaunchStepsToCampaignSequences(sequence.steps, {
    bodyFormatter: toInstantlyHtmlBody,
  });
  if (!sequences) {
    return jsonError('Добавьте хотя бы один шаг в цепочку писем.', 400);
  }

  // Optional schedule edit. If present in the body, validate it (HH:MM,
  // to>from, ≥1 day) and build Instantly's campaign_schedule. Absent →
  // we don't touch the campaign's current schedule.
  const scheduleOverride = parseScheduleFromBody(body.schedule);
  if (scheduleOverride) {
    const scheduleValidation = validateScheduleOverride(scheduleOverride);
    if (!scheduleValidation.ok) return jsonError(scheduleValidation.error, 400);
  }

  const instantlyRequestOptions = {
    accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
  };
  const campaignName = sequence.name.trim();

  try {
    const { data: launchRow, error: launchErr } = await supabaseInstantly
      .from('client_campaign_launches')
      .select('id')
      .eq('client_user_id', userId)
      .eq('instantly_campaign_id', campaignId)
      .maybeSingle();

    if (launchErr) {
      await logError('client.campaign.patch.launch_load_failed', launchErr, { campaignId }, { userId });
      return jsonError('Не удалось загрузить запуск кампании', 500);
    }

    const launchId = (launchRow as { id?: string } | null)?.id;
    if (!launchId) {
      return jsonError('Кампания не найдена или доступ запрещён', 404);
    }

    const updatePayload: CampaignUpdatePayload = {
      name: campaignName,
      sequences,
      // Mirror the create path: a body with a hidden link → HTML email
      // (text_only false) so the <a> survives; otherwise plain text. Editing
      // a campaign re-derives this from the (possibly changed) body.
      text_only: !sequenceHasMarkdownLink(sequence.steps),
    };
    if (scheduleOverride) {
      updatePayload.campaign_schedule = buildCampaignSchedule(scheduleOverride);
    }
    const updatedCampaign = await updateCampaign(
      campaignId,
      updatePayload,
      instantlyRequestOptions,
    );

    const { error: updateErr } = await supabaseInstantly
      .from('client_campaign_launches')
      .update({
        campaign_name: campaignName,
        sequence_steps: sequence.steps,
      })
      .eq('id', launchId);

    if (updateErr) {
      await logError('client.campaign.patch.launch_update_failed', updateErr, { campaignId, launchId }, { userId });
      return jsonError('Не удалось сохранить изменения запуска', 500);
    }

    invalidate(`instantly:${instantlyRequestOptions.accountId}:campaign:${campaignId}`);
    invalidate(`instantly:${instantlyRequestOptions.accountId}:steps:${campaignId}`);
    await upsertInstantlyCatalogFromCampaign(updatedCampaign, instantlyRequestOptions.accountId);
    await logAudit('client.campaign.patch', 'Client edited campaign launch', { campaignId, launchId }, { userId });

    const baseCampaignForResponse = hasUsableCampaignSequences(updatedCampaign.sequences)
      ? updatedCampaign
      : { ...updatedCampaign, name: campaignName, sequences };

    // If we just changed the schedule, guarantee the response reflects it —
    // so when the client re-opens edit mode it sees the value it just set,
    // even if Instantly's PATCH response omitted/staled campaign_schedule.
    const campaignForResponse = scheduleOverride
      ? { ...baseCampaignForResponse, campaign_schedule: buildCampaignSchedule(scheduleOverride) }
      : baseCampaignForResponse;

    return NextResponse.json({
      campaign: campaignForResponse,
      launch: {
        id: launchId,
        campaign_name: campaignName,
        sequence_steps: sequence.steps,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось сохранить кампанию';
    await logError('client.campaign.patch.failed', err, { campaignId }, { userId });
    return jsonError(message, 500);
  }
}
