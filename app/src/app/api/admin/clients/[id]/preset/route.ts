import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { getClientTariffRow, resolveEffectiveLimits } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';

interface PresetBody {
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

  return NextResponse.json({ preset: preset ?? null });
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

  return NextResponse.json({ preset });
}
