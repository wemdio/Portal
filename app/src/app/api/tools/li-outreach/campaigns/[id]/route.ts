import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { collectUnknownPlaceholders, unknownPlaceholderError } from '@/lib/liOutreach/campaignTextCheck';
import { normalizeTimezoneOffset, normalizeWorkingHours } from '@/lib/liOutreach/schedule';
import { saveCampaignAccounts } from '@/lib/liOutreach/campaignAccounts';
import { logCampaignEvent } from '@/lib/liOutreach/campaignLog';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** Поля настроек кампании, изменение которых пишется в журнал. */
const SETTING_LABELS: Record<string, string> = {
  name: 'название',
  steps: 'шаги цепочки',
  use_ai: 'ИИ-персонализация',
  ai_prompt_invite: 'промпт инвайта',
  ai_prompt_chat: 'промпт сообщений',
  stop_on_reply: 'остановка при ответе',
  min_delay: 'пауза между людьми',
  max_delay: 'пауза между людьми',
  daily_invite_limit: 'дневной лимит инвайтов',
  welcome_message: 'приветственное сообщение',
  message_existing_connections: 'сообщения существующим контактам',
  use_ai_welcome: 'ИИ в приветствии',
  use_ai_followup: 'ИИ в фоллоу-апах',
  ai_model: 'модель ИИ',
  use_custom_invites: 'персональные инвайты',
  working_hours: 'рабочие часы',
  timezone_offset: 'часовой пояс',
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.getOne' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    // Cross-specialist visibility (view-only): any specialist can open any
    // campaign's detail. Mutations below (PUT/DELETE) still scope by user_id,
    // so a viewer can read a foreign launch but not change it.
    const { data, error } = await supabaseAdmin
      .from('li_campaigns')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return jsonError('Campaign not found', 404);
    return NextResponse.json({ campaign: data });
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    // Any authenticated team member can PUT a campaign (see migration
    // 20260708_0002). Ownership is still tracked on the row via user_id for
    // audit; only DELETE stays owner-only. We drop the previous
    // `userOwnsAccount` guard on `account_id` too — under team-edit the whole
    // team is trusted to attach any account to any campaign (previously a
    // viewer might accidentally save an unchanged foreign account_id and
    // hit a 403).
    const { data: existing } = await supabaseAdmin
      .from('li_campaigns')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return jsonError('Campaign not found', 404);

    const body = (await req.json()) as Record<string, unknown>;
    const allowed = [
      'name', 'account_id', 'lead_list_id', 'steps', 'use_ai', 'ai_prompt_invite', 'ai_prompt_chat',
      'stop_on_reply', 'min_delay', 'max_delay', 'daily_invite_limit', 'welcome_message',
      'message_existing_connections', 'use_ai_welcome', 'use_ai_followup', 'ai_model',
      'use_custom_invites',
    ];
    // Only the texts actually being submitted are checked — an edit that
    // doesn't touch welcome/steps can't be blocked by them.
    const unknownVars = collectUnknownPlaceholders(body);
    if (unknownVars.length > 0) return jsonError(unknownPlaceholderError(unknownVars), 400);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) { if (key in body) patch[key] = body[key]; }
    // Архив: запущенную кампанию не убираем из списка, пока она рассылает.
    if (typeof body.archived === 'boolean') {
      if (body.archived && existing.status === 'running') return jsonError('Сначала остановите кампанию', 409);
      patch.archived_at = body.archived ? new Date().toISOString() : null;
    }
    // working_hours / timezone_offset go through the shared normalizers so
    // garbage values can't reach the DB (the runner regex-matches each entry).
    if ('working_hours' in body) {
      const hours = normalizeWorkingHours(body.working_hours);
      if (hours !== null) patch.working_hours = hours;
    }
    if ('timezone_offset' in body) {
      patch.timezone_offset = normalizeTimezoneOffset(body.timezone_offset);
    }

    // Список аккаунтов сохраняется отдельно (и сам выставляет основной).
    const accountIds = Array.isArray(body.account_ids)
      ? (body.account_ids as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
      : null;
    if (accountIds) {
      delete patch.account_id;
      const accError = await saveCampaignAccounts(supabaseAdmin, id, accountIds);
      if (accError) return jsonError(accError, 409);
    }

    const { error } = await supabaseAdmin
      .from('li_campaigns')
      .update(patch)
      .eq('id', id);
    if (error) return jsonError(error.message, 500);

    const actor = auth.user.email ?? null;
    if (typeof body.archived === 'boolean') {
      await logCampaignEvent(supabaseAdmin, id, 'info', body.archived ? 'Кампания отправлена в архив' : 'Кампания возвращена из архива', actor);
    }
    if (typeof body.lead_list_id === 'string' && body.lead_list_id) {
      const { data: list } = await supabaseAdmin.from('li_lead_lists').select('name').eq('id', body.lead_list_id).maybeSingle();
      await logCampaignEvent(supabaseAdmin, id, 'info', `Рассылаемая база выбрана вручную: «${list?.name ?? body.lead_list_id}»`, actor);
    }
    if (accountIds) {
      const { data: accs } = await supabaseAdmin.from('li_accounts').select('name, unipile_account_id').in('id', accountIds);
      const names = (accs ?? []).map((a) => (a.name as string | null) || (a.unipile_account_id as string)).join(', ');
      await logCampaignEvent(supabaseAdmin, id, 'info', `Аккаунты кампании: ${names || 'не выбраны'}`, actor);
    }
    const changed = [...new Set(Object.keys(body).filter((key) => SETTING_LABELS[key]).map((key) => SETTING_LABELS[key]))];
    if (changed.length > 0) {
      await logCampaignEvent(supabaseAdmin, id, 'info', `Настройки изменены: ${changed.join(', ')}`, actor);
    }
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    // Удалять может любой специалист: кампании общие, как и редактирование.
    const { data: existing } = await supabaseAdmin.from('li_campaigns').select('id').eq('id', id).maybeSingle();
    if (!existing) return jsonError('Campaign not found', 404);

    const { error } = await supabaseAdmin
      .from('li_campaigns')
      .delete()
      .eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
