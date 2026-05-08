import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import { type TariffType, SETUP_DAYS } from '@/lib/tariffs';

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

  const { id: targetUserId } = await ctx.params;

  const { data, error } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (error) {
    await logError('admin.tariff.get.failed', error, { targetUserId });
    return jsonError('Failed to load tariff', 500);
  }

  return NextResponse.json({ tariff: data ?? null });
}

const VALID_TYPES = new Set<string>(['standard', 'pro', 'custom']);

type TariffBody = {
  tariff_type?: string;
  max_contacts?: number | null;
  max_rows?: number | null;
  max_chains_per_month?: number | null;
  max_domains?: number | null;
  max_emails?: number | null;
  action?: 'activate' | 'deactivate' | 'finish_setup';
};

function clampInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { user } = auth;
  const { id: targetUserId } = await ctx.params;

  let body: TariffBody;
  try {
    body = (await req.json()) as TariffBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  if (body.action === 'activate') {
    const now = new Date();
    const setupUntil = new Date(now);
    setupUntil.setDate(setupUntil.getDate() + SETUP_DAYS);
    const paidUntil = new Date(setupUntil);
    paidUntil.setMonth(paidUntil.getMonth() + 1);

    const { error } = await supabaseAdmin
      .from('client_tariffs')
      .update({
        is_active: true,
        paid_at: now.toISOString(),
        setup_until: setupUntil.toISOString(),
        paid_until: paidUntil.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('user_id', targetUserId);

    if (error) {
      await logError('admin.tariff.activate.failed', error, { targetUserId });
      return jsonError('Failed to activate subscription', 500);
    }

    await logAudit(
      'admin.tariff.activate',
      'Client subscription activated',
      { targetUserId, setup_until: setupUntil.toISOString(), paid_until: paidUntil.toISOString() },
      { userId: user.id, targetUserId },
    );

    return NextResponse.json({
      ok: true,
      action: 'activate',
      setup_until: setupUntil.toISOString(),
      paid_until: paidUntil.toISOString(),
    });
  }

  if (body.action === 'finish_setup') {
    const now = new Date();
    const paidUntil = new Date(now);
    paidUntil.setMonth(paidUntil.getMonth() + 1);

    const { error } = await supabaseAdmin
      .from('client_tariffs')
      .update({
        setup_until: now.toISOString(),
        paid_until: paidUntil.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('user_id', targetUserId);

    if (error) {
      await logError('admin.tariff.finish_setup.failed', error, { targetUserId });
      return jsonError('Failed to finish setup', 500);
    }

    await logAudit(
      'admin.tariff.finish_setup',
      'Client setup finished early',
      { targetUserId, paid_until: paidUntil.toISOString() },
      { userId: user.id, targetUserId },
    );

    return NextResponse.json({
      ok: true,
      action: 'finish_setup',
      setup_until: now.toISOString(),
      paid_until: paidUntil.toISOString(),
    });
  }

  if (body.action === 'deactivate') {
    const { error } = await supabaseAdmin
      .from('client_tariffs')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', targetUserId);

    if (error) {
      await logError('admin.tariff.deactivate.failed', error, { targetUserId });
      return jsonError('Failed to deactivate subscription', 500);
    }

    await logAudit(
      'admin.tariff.deactivate',
      'Client subscription deactivated',
      { targetUserId },
      { userId: user.id, targetUserId },
    );

    return NextResponse.json({ ok: true, action: 'deactivate' });
  }

  const tariffType = typeof body.tariff_type === 'string' && VALID_TYPES.has(body.tariff_type)
    ? (body.tariff_type as TariffType)
    : 'standard';

  const isCustom = tariffType === 'custom';
  const row = {
    user_id: targetUserId,
    tariff_type: tariffType,
    max_contacts: isCustom ? clampInt(body.max_contacts) : null,
    max_rows: isCustom ? clampInt(body.max_rows) : null,
    max_chains_per_month: isCustom ? clampInt(body.max_chains_per_month) : null,
    max_domains: isCustom ? clampInt(body.max_domains) : null,
    max_emails: isCustom ? clampInt(body.max_emails) : null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from('client_tariffs')
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    await logError('admin.tariff.put.failed', error, { targetUserId });
    return jsonError('Failed to save tariff', 500);
  }

  await logAudit(
    'admin.tariff.put.success',
    'Client tariff updated',
    { tariffType, targetUserId },
    { userId: user.id, targetUserId },
  );

  return NextResponse.json({ ok: true, tariff_type: tariffType });
}
