import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdminAuth(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }

  return { user };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { id: targetUserId } = await ctx.params;

  const { data: rows, error } = await supabaseInstantly
    .from('client_instantly_access')
    .select('id, resource_type, resource_id, instantly_account_id, created_at')
    .eq('client_user_id', targetUserId)
    .order('created_at', { ascending: false });

  if (error) {
    await logError('admin.client-access.get.failed', error, { targetUserId });
    return jsonError('Failed to load client access', 500);
  }

  return NextResponse.json({ rows: rows ?? [] });
}

type SetAccessBody = {
  campaigns?: unknown;
  baselineCampaigns?: unknown;
};

type ExistingCampaignAccess = {
  resource_id: string;
  instantly_account_id: string | null;
};

type CampaignCatalogRow = {
  id: string;
  instantly_account_id: string | null;
};

function parseCampaignIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return null;
  }
  return [...new Set((value as string[]).map((campaignId) => campaignId.trim()))];
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { user } = auth;
  const { id: targetUserId } = await ctx.params;
  const logMeta = { userId: user.id, targetUserId };

  let body: SetAccessBody;
  try {
    body = (await req.json()) as SetAccessBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const campaigns = parseCampaignIds(body.campaigns);
  if (!campaigns) {
    return jsonError('campaigns must contain non-empty strings', 400);
  }

  const baselineCampaigns = parseCampaignIds(body.baselineCampaigns);
  if (!baselineCampaigns) {
    return jsonError('baselineCampaigns must contain non-empty strings', 400);
  }

  const { data: existingData, error: readErr } = await supabaseInstantly
    .from('client_instantly_access')
    .select('resource_id, instantly_account_id')
    .eq('client_user_id', targetUserId)
    .eq('resource_type', 'campaign');

  if (readErr) {
    await logError('admin.client-access.put.read.failed', readErr, {}, logMeta);
    return jsonError('Failed to update client access', 500);
  }

  const existingRows = (existingData ?? []) as ExistingCampaignAccess[];
  const existingIds = new Set(existingRows.map((row) => row.resource_id));
  const baselineIds = new Set(baselineCampaigns);
  const baselineMatches =
    existingIds.size === baselineIds.size
    && [...existingIds].every((campaignId) => baselineIds.has(campaignId));
  if (!baselineMatches) {
    await logAudit(
      'admin.client-access.put.conflict',
      'Client access changed after the admin form was loaded',
      { current: existingIds.size, baseline: baselineIds.size },
      logMeta,
    );
    return jsonError('Campaign access changed; reload and try again', 409);
  }

  const desiredIds = new Set(campaigns);
  const idsToAdd = campaigns.filter((campaignId) => !existingIds.has(campaignId));
  const idsToRemove = existingRows
    .map((row) => row.resource_id)
    .filter((campaignId) => !desiredIds.has(campaignId));

  let rowsToAdd: Array<{
    client_user_id: string;
    resource_type: 'campaign';
    resource_id: string;
    instantly_account_id: string;
    created_by: string;
  }> = [];

  if (idsToAdd.length > 0) {
    const { data: catalogData, error: catalogErr } = await supabaseInstantly
      .from('instantly_campaign_catalog')
      .select('id, instantly_account_id')
      .in('id', idsToAdd);

    if (catalogErr) {
      await logError(
        'admin.client-access.put.catalog.failed',
        catalogErr,
        { count: idsToAdd.length },
        logMeta,
      );
      return jsonError('Failed to validate campaigns', 500);
    }

    const catalogById = new Map(
      ((catalogData ?? []) as CampaignCatalogRow[]).map((row) => [row.id, row]),
    );
    const invalidIds = idsToAdd.filter((campaignId) => {
      const accountId = catalogById.get(campaignId)?.instantly_account_id;
      return typeof accountId !== 'string' || accountId.trim().length === 0;
    });
    if (invalidIds.length > 0) {
      await logError(
        'admin.client-access.put.catalog.missing',
        new Error('Campaigns are missing from the Instantly catalog'),
        { count: invalidIds.length },
        logMeta,
      );
      return jsonError('One or more campaigns are unavailable', 400);
    }

    rowsToAdd = idsToAdd.map((campaignId) => ({
      client_user_id: targetUserId,
      resource_type: 'campaign' as const,
      resource_id: campaignId,
      instantly_account_id: catalogById.get(campaignId)!.instantly_account_id!.trim(),
      created_by: user.id,
    }));
  }

  if (rowsToAdd.length > 0) {
    const { error: insErr } = await supabaseInstantly
      .from('client_instantly_access')
      .insert(rowsToAdd);

    if (insErr) {
      await logError(
        'admin.client-access.put.insert.failed',
        insErr,
        { count: rowsToAdd.length },
        logMeta,
      );
      return jsonError('Failed to save client access', 500);
    }
  }

  if (idsToRemove.length > 0) {
    const { error: delErr } = await supabaseInstantly
      .from('client_instantly_access')
      .delete()
      .eq('client_user_id', targetUserId)
      .eq('resource_type', 'campaign')
      .in('resource_id', idsToRemove);

    if (delErr) {
      let rollbackError: unknown = null;
      if (idsToAdd.length > 0) {
        const { error } = await supabaseInstantly
          .from('client_instantly_access')
          .delete()
          .eq('client_user_id', targetUserId)
          .eq('resource_type', 'campaign')
          .in('resource_id', idsToAdd);
        rollbackError = error;
      }

      await logError(
        'admin.client-access.put.delete.failed',
        delErr,
        { count: idsToRemove.length, rollbackFailed: Boolean(rollbackError) },
        logMeta,
      );
      if (rollbackError) {
        await logError(
          'admin.client-access.put.rollback.failed',
          rollbackError,
          { count: idsToAdd.length },
          logMeta,
        );
      }
      return jsonError('Failed to update client access', 500);
    }
  }

  await logAudit(
    'admin.client-access.put.success',
    'Client access updated',
    { campaigns: campaigns.length, added: idsToAdd.length, removed: idsToRemove.length },
    logMeta,
  );

  return NextResponse.json({
    ok: true,
    campaigns: campaigns.length,
    added: idsToAdd.length,
    removed: idsToRemove.length,
  });
}
