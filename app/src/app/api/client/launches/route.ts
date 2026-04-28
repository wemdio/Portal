import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { validateClientLaunchInput } from '@/lib/clientLaunch/validateLaunchInput';
import { mapCsvRowsToLeads } from '@/lib/clientLaunch/mapRowsToLeads';
import type {
  ClientCampaignPreset,
  ClientLaunchColumnMapping,
  ClientLaunchSequence,
} from '@/lib/clientLaunch/types';
import { activateCampaign, createCampaign, createLeads } from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface LaunchBody {
  campaign_name?: unknown;
  sequence_steps?: unknown;
  mapping?: unknown;
  headers?: unknown;
  rows?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data: rows, error } = await supabaseInstantly
    .from('client_campaign_launches')
    .select('id, campaign_name, instantly_campaign_id, status, uploaded_rows, accepted_rows, skipped_rows, error_message, created_at')
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    await logError('client.launches.list.failed', error, { userId });
    return jsonError('Не удалось загрузить историю запусков', 500);
  }

  return NextResponse.json({ launches: rows ?? [] });
}

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const logMeta = { userId };

  let body: LaunchBody;
  try {
    body = (await req.json()) as LaunchBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const campaignName = typeof body.campaign_name === 'string' ? body.campaign_name : '';
  const sequenceSteps = Array.isArray(body.sequence_steps) ? body.sequence_steps : [];
  const mapping = (body.mapping ?? {}) as ClientLaunchColumnMapping;
  const headers = isStringArray(body.headers) ? body.headers : [];
  const rawRows = Array.isArray(body.rows) ? body.rows : [];

  const rows: string[][] = rawRows.map((r) =>
    Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [],
  );

  const sequence: ClientLaunchSequence = {
    name: campaignName,
    steps: sequenceSteps.map((s) => {
      const step = (s ?? {}) as Record<string, unknown>;
      return {
        subject: typeof step.subject === 'string' ? step.subject : '',
        body: typeof step.body === 'string' ? step.body : '',
        wait_days: Number.isFinite(Number(step.wait_days)) ? Math.max(0, Math.floor(Number(step.wait_days))) : 0,
      };
    }),
  };

  const { data: presetRow, error: presetErr } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('*')
    .eq('client_user_id', userId)
    .maybeSingle();

  if (presetErr) {
    await logError('client.launches.post.preset_load_failed', presetErr, {}, logMeta);
    return jsonError('Не удалось загрузить пресет', 500);
  }

  const preset = presetRow as ClientCampaignPreset | null;

  const validation = validateClientLaunchInput({
    preset,
    sequence,
    mapping,
    rowCount: rows.length,
  });

  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }

  const leads = mapCsvRowsToLeads({ headers, rows, mapping });
  if (leads.length === 0) {
    return jsonError('В файле нет валидных email-адресов', 400);
  }

  const { data: launchRow, error: insertErr } = await supabaseInstantly
    .from('client_campaign_launches')
    .insert({
      client_user_id: userId,
      preset_id: preset!.id,
      campaign_name: sequence.name.trim(),
      sequence_steps: sequence.steps,
      column_mapping: mapping,
      uploaded_rows: rows.length,
      accepted_rows: 0,
      skipped_rows: 0,
      status: 'uploading',
    })
    .select()
    .single();

  if (insertErr || !launchRow) {
    await logError('client.launches.post.insert_failed', insertErr, {}, logMeta);
    return jsonError('Не удалось создать запись запуска', 500);
  }

  const launchId = (launchRow as { id: string }).id;

  let instantlyCampaignId: string | null = null;

  try {
    const payload = buildCampaignPayloadFromPreset({ preset: preset!, sequence });
    const created = await createCampaign(payload);
    instantlyCampaignId = (created as { id?: string }).id ?? null;
    if (!instantlyCampaignId) throw new Error('Instantly returned campaign without id');

    await supabaseInstantly
      .from('client_campaign_launches')
      .update({ instantly_campaign_id: instantlyCampaignId })
      .eq('id', launchId);

    const leadResult = await createLeads(leads, {
      campaign_id: instantlyCampaignId,
      skip_if_in_workspace: true,
      skip_if_in_campaign: true,
    });

    const accepted = Number((leadResult as { uploaded?: number; created?: number; total_uploaded?: number }).uploaded ??
      (leadResult as { created?: number }).created ??
      (leadResult as { total_uploaded?: number }).total_uploaded ??
      leads.length);
    const skipped = leads.length - accepted;

    await activateCampaign(instantlyCampaignId);

    await supabaseInstantly.from('client_instantly_access').upsert(
      {
        client_user_id: userId,
        resource_type: 'campaign',
        resource_id: instantlyCampaignId,
        created_by: userId,
      },
      { onConflict: 'client_user_id,resource_type,resource_id' },
    );

    await supabaseInstantly
      .from('client_campaign_launches')
      .update({
        status: 'active',
        accepted_rows: accepted,
        skipped_rows: skipped < 0 ? 0 : skipped,
      })
      .eq('id', launchId);

    await logAudit(
      'client.launches.post.success',
      'Client launched campaign',
      { instantlyCampaignId, accepted, skipped, totalLeads: leads.length, steps: sequence.steps.length },
      logMeta,
    );

    return NextResponse.json({
      launch: {
        id: launchId,
        instantly_campaign_id: instantlyCampaignId,
        campaign_name: sequence.name.trim(),
        status: 'active',
        uploaded_rows: rows.length,
        accepted_rows: accepted,
        skipped_rows: skipped < 0 ? 0 : skipped,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось запустить кампанию';
    await logError('client.launches.post.launch_failed', err, { instantlyCampaignId }, logMeta);
    await supabaseInstantly
      .from('client_campaign_launches')
      .update({ status: 'failed', error_message: message.slice(0, 500) })
      .eq('id', launchId);
    return jsonError(message, 500);
  }
}
