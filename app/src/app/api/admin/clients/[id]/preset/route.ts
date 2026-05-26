import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { getClientTariffRow, resolveEffectiveLimits } from '@/lib/tariffs';
import { listInstantlyAccounts, resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { updateCampaign } from '@/lib/instantly/client';
import {
  PRESET_KEYS_THAT_SYNC_TO_CAMPAIGN,
  buildCampaignPresetUpdatePayload,
} from '@/lib/clientLaunch/buildCampaignPayload';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';

export const dynamic = 'force-dynamic';

interface PresetBody {
  instantly_account_id?: unknown;
  email_account_ids?: unknown;
  daily_limit?: unknown;
  daily_max_leads?: unknown;
  email_gap_minutes?: unknown;
  open_tracking?: unknown;
  link_tracking?: unknown;
  stop_on_reply?: unknown;
  text_only?: unknown;
  schedule_from?: unknown;
  schedule_to?: unknown;
  schedule_days?: unknown;
  schedule_timezone?: unknown;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitizeBody(body: PresetBody): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};

  if (body.instantly_account_id !== undefined) {
    const accountId = resolveInstantlyAccountId(String(body.instantly_account_id));
    const allowed = new Set(listInstantlyAccounts().map((a) => a.id));
    if (!allowed.has(accountId)) {
      return { ok: false, error: 'instantly_account_id is not configured' };
    }
    data.instantly_account_id = accountId;
  }

  if (body.email_account_ids !== undefined) {
    if (!Array.isArray(body.email_account_ids) || body.email_account_ids.some((s) => typeof s !== 'string')) {
      return { ok: false, error: 'email_account_ids must be string[]' };
    }
    data.email_account_ids = body.email_account_ids
      .map((s) => (s as string).trim())
      .filter((s) => s.length > 0);
  }

  for (const numField of ['daily_limit', 'daily_max_leads', 'email_gap_minutes'] as const) {
    if (body[numField] !== undefined) {
      const v = Number(body[numField]);
      if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${numField} must be a non-negative number` };
      data[numField] = Math.floor(v);
    }
  }

  for (const boolField of ['open_tracking', 'link_tracking', 'stop_on_reply', 'text_only'] as const) {
    if (body[boolField] !== undefined) {
      data[boolField] = Boolean(body[boolField]);
    }
  }

  for (const timeField of ['schedule_from', 'schedule_to'] as const) {
    if (body[timeField] !== undefined) {
      const v = String(body[timeField]);
      if (!HHMM_RE.test(v)) return { ok: false, error: `${timeField} must be HH:MM` };
      data[timeField] = v;
    }
  }

  if (body.schedule_days !== undefined) {
    if (!Array.isArray(body.schedule_days)) return { ok: false, error: 'schedule_days must be number[]' };
    const days = body.schedule_days
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    data.schedule_days = Array.from(new Set(days));
  }

  if (body.schedule_timezone !== undefined) {
    const tz = String(body.schedule_timezone).trim();
    if (!tz) return { ok: false, error: 'schedule_timezone must be non-empty' };
    data.schedule_timezone = tz;
  }

  return { ok: true, data };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { id: clientUserId } = await ctx.params;

  const { data: preset, error } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('*')
    .eq('client_user_id', clientUserId)
    .maybeSingle();

  if (error) {
    await logError('admin.client-preset.get.failed', error, { clientUserId });
    return jsonError('Failed to load preset', 500);
  }

  return NextResponse.json({
    preset: preset ?? null,
    instantly_accounts: listInstantlyAccounts(),
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { user } = auth.auth;
  const { id: clientUserId } = await ctx.params;
  const logMeta = { userId: user.id, targetUserId: clientUserId };

  let body: PresetBody;
  try {
    body = (await req.json()) as PresetBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const sanitized = sanitizeBody(body);
  if (!sanitized.ok) return jsonError(sanitized.error, 400);

  if (Array.isArray(sanitized.data.email_account_ids)) {
    const tariffRow = await getClientTariffRow(clientUserId);
    const limits = resolveEffectiveLimits(tariffRow);
    const count = (sanitized.data.email_account_ids as string[]).length;
    if (count > limits.max_emails) {
      return jsonError(
        `Лимит почт для клиента: ${limits.max_emails}. Попытка назначить: ${count}.`,
        400,
      );
    }
  }

  const upsertRow = {
    client_user_id: clientUserId,
    created_by: user.id,
    ...sanitized.data,
  };

  const { data: preset, error } = await supabaseInstantly
    .from('client_campaign_presets')
    .upsert(upsertRow, { onConflict: 'client_user_id' })
    .select()
    .single();

  if (error) {
    await logError('admin.client-preset.put.failed', error, {}, logMeta);
    return jsonError('Failed to save preset', 500);
  }

  await logAudit(
    'admin.client-preset.put.success',
    'Client preset saved',
    { fields: Object.keys(sanitized.data), accounts: (preset?.email_account_ids ?? []).length },
    logMeta,
  );

  // Sync preset changes to already-running Instantly campaigns. Without this,
  // the preset row in Supabase updates but live campaigns keep the values
  // they were created with — admin edits the preset and nothing happens.
  // Best-effort: per-campaign failures are logged but don't fail the PUT.
  const sync = await syncPresetToRunningCampaigns({
    preset: preset as ClientCampaignPreset,
    changedPresetKeys: new Set(Object.keys(sanitized.data)),
    logMeta,
  });

  return NextResponse.json({ preset, sync });
}

interface SyncPresetInput {
  preset: ClientCampaignPreset;
  changedPresetKeys: Set<string>;
  logMeta: { userId: string; targetUserId: string };
}

interface SyncPresetResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /** True when the admin didn't touch any preset field that propagates to campaigns. */
  skipped: boolean;
}

async function syncPresetToRunningCampaigns(input: SyncPresetInput): Promise<SyncPresetResult> {
  const { preset, changedPresetKeys, logMeta } = input;

  // If admin only touched fields that don't propagate (e.g. text_only,
  // instantly_account_id), there's nothing to sync.
  const hasSyncableChange = PRESET_KEYS_THAT_SYNC_TO_CAMPAIGN.some((k) => changedPresetKeys.has(k));
  if (!hasSyncableChange) {
    return { attempted: 0, succeeded: 0, failed: 0, skipped: true };
  }

  if (!supabaseInstantly) {
    return { attempted: 0, succeeded: 0, failed: 0, skipped: true };
  }

  // Find every live campaign this client has. Skip 'failed' and 'completed' —
  // syncing those would either fail (deleted campaign) or be pointless.
  // Also pull email_account_ids: when a launch has a per-launch mailbox
  // override, we must NOT push the preset's new email_list — that would
  // silently overwrite the client's explicit per-campaign mailbox choice.
  const { data: launches, error } = await supabaseInstantly
    .from('client_campaign_launches')
    .select('id, instantly_campaign_id, instantly_account_id, status, email_account_ids')
    .eq('client_user_id', preset.client_user_id)
    .in('status', ['uploading', 'active', 'paused'])
    .not('instantly_campaign_id', 'is', null);

  if (error) {
    await logError('admin.client-preset.sync.list_failed', error, {}, logMeta);
    return { attempted: 0, succeeded: 0, failed: 0, skipped: false };
  }

  const rows = (launches ?? []) as Array<{
    id: string;
    instantly_campaign_id: string;
    instantly_account_id: string;
    status: string;
    email_account_ids: string[] | null;
  }>;

  if (rows.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, skipped: false };
  }

  const basePayload = buildCampaignPresetUpdatePayload({ preset, changedPresetKeys });

  // Defensive: if for some reason the payload came out empty (e.g. only
  // schedule keys touched but they all matched the existing values…
  // shouldn't happen, but just in case), bail without making API calls.
  if (Object.keys(basePayload).length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, skipped: true };
  }

  let succeeded = 0;
  let failed = 0;
  let skippedDueToOverride = 0;

  for (const row of rows) {
    // Per-launch payload: copy of basePayload, but strip `email_list` if
    // this launch has a per-launch mailbox override. The override is the
    // client's explicit choice; admin's preset edit must not silently
    // change which mailboxes a running campaign sends from.
    const perLaunchPayload = { ...basePayload };
    if (row.email_account_ids !== null && 'email_list' in perLaunchPayload) {
      delete perLaunchPayload.email_list;
    }

    // If everything got stripped (admin only changed mailbox pool AND
    // this launch has an override), there's nothing left to push for
    // this campaign — skip the API call entirely.
    if (Object.keys(perLaunchPayload).length === 0) {
      skippedDueToOverride += 1;
      continue;
    }

    try {
      await updateCampaign(row.instantly_campaign_id, perLaunchPayload, {
        accountId: resolveInstantlyAccountId(row.instantly_account_id),
      });
      succeeded += 1;
    } catch (err) {
      failed += 1;
      await logError(
        'admin.client-preset.sync.campaign_failed',
        err,
        {
          launchId: row.id,
          instantlyCampaignId: row.instantly_campaign_id,
          instantlyAccountId: row.instantly_account_id,
        },
        logMeta,
      );
    }
  }

  await logAudit(
    'admin.client-preset.sync.done',
    'Synced preset changes to running campaigns',
    {
      attempted: rows.length,
      succeeded,
      failed,
      skippedDueToOverride,
      fields: Object.keys(basePayload),
    },
    logMeta,
  );

  return { attempted: rows.length, succeeded, failed, skipped: false };
}
