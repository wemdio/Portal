import { NextRequest, NextResponse } from 'next/server';
import { logAudit } from '@/lib/loggerServer';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import {
  loadOwnReplySettings,
  ownReplySettingsDto,
  ownReplySettingsPatch,
  parseOwnReplySettingsInput,
} from '@/lib/ownReplyLeads/settings';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.ownReplyLeads.settings.get' }, async () => {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    return NextResponse.json(ownReplySettingsDto(await loadOwnReplySettings(supabaseAdmin)));
  });
}

/** PUT — вкл/выкл и правило. Воркер перечитывает каждый круг (раз в минуту). */
export async function PUT(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.ownReplyLeads.settings.update' }, async () => {
    const auth = await requireAdmin(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const parsed = parseOwnReplySettingsInput(await req.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const prev = await loadOwnReplySettings(supabaseAdmin);
    const { error } = await supabaseAdmin
      .from('own_reply_lead_settings')
      .update(ownReplySettingsPatch(prev, parsed.value, new Date().toISOString(), auth.user.id))
      .eq('id', 1);
    if (error) return jsonError(error.message, 500);

    // Включение заводит сделки в AMO — кто и когда, должно быть в журнале.
    await logAudit(
      'own.reply.leads.settings.updated',
      `Наши кампании: квалификация и сделки в AMO ${parsed.value.enabled ? 'включены' : 'выключены'}`,
      { enabled: parsed.value.enabled },
      { userId: auth.user.id },
    );
    return NextResponse.json(ownReplySettingsDto(await loadOwnReplySettings(supabaseAdmin)));
  });
}
