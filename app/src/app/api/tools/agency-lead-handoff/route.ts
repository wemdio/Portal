import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadHandoffSettings, parseHandoffSettings } from '@/lib/agencyLeadHandoff/settings';
import { logAudit } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
  const [settings, history] = await Promise.all([
    loadHandoffSettings(supabaseAdmin),
    supabaseAdmin.from('agency_lead_handoffs')
      .select('id, scope, lead_email, status, error, body, cc_emails, sent_at, created_at, updated_at, sender_manual_messages(status, error, sent_at, updated_at)')
      .order('created_at', { ascending: false }).limit(30),
  ]);
  if (history.error) return jsonError(history.error.message, 500);
  return NextResponse.json({ settings, history: history.data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
  let input;
  try { input = parseHandoffSettings(await req.json()); }
  catch (err) { return jsonError(err instanceof Error ? err.message : 'Неверные настройки', 400); }
  const { data: prev, error: readError } = await supabaseAdmin.from('agency_lead_handoff_settings')
    .select('enabled, enabled_at').eq('scope', input.scope).single();
  if (readError) return jsonError(readError.message, 500);
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('agency_lead_handoff_settings').update({
    ...input, enabled_at: input.enabled && !prev.enabled ? now : prev.enabled_at,
    updated_at: now, updated_by: auth.user.id,
  }).eq('scope', input.scope);
  if (error) return jsonError(error.message, 500);
  await logAudit('agency.lead.handoff.settings.updated', `Ответ лиду с копией: ${input.scope}`, {
    scope: input.scope, enabled: input.enabled, ccCount: input.cc_emails.length,
  }, { userId: auth.user.id });
  return NextResponse.json({ ok: true });
}
