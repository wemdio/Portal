import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { chunkForInFilter } from '@/lib/sender/inFilter';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Какой список показать: общий, кампаний или оба вместе. */
type Scope = 'global' | 'campaign' | 'all';

function campaignIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_RE.test(raw.trim()) ? raw.trim() : null;
}

/**
 * Стоп-лист (задача 5.3 хендоффа фич): посмотреть, найти, добавить руками,
 * снять адрес. Два списка: общий (sender_suppressions — пополняется и сам:
 * отбойники, отказы SMTP, «стоп» в ответе) и стоп-лист отдельной кампании
 * (sender_campaign_suppressions). Экран читает оба через sender_suppressions_all.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.suppressions.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const search = (url.searchParams.get('search') ?? '').trim().replace(/[(),]/g, '').slice(0, 200);
    const rawScope = url.searchParams.get('scope');
    const scope: Scope = rawScope === 'global' || rawScope === 'campaign' ? rawScope : 'all';

    let query = supabaseAdmin
      .from('sender_suppressions_all')
      .select('email, reason, note, created_at, campaign_id, campaign_name', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (scope === 'global') query = query.is('campaign_id', null);
    if (scope === 'campaign') query = query.not('campaign_id', 'is', null);
    if (search) query = query.ilike('email', `%${search}%`);

    const { data, error, count } = await query;
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ suppressions: data ?? [], total: count ?? 0, pageSize: PAGE_SIZE });
  });
}

/**
 * Не дать кампании написать адресам, которые только что поставили в её
 * стоп-лист. Планировщик сам остановит их перед следующим письмом, но письмо,
 * уже стоящее в очереди, ушло бы. Отменяем только «ждёт отправки»: письмо
 * «отправляется» уже в руках воркера.
 */
async function stopInCampaign(campaignId: string, emails: string[]): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const nowIso = new Date().toISOString();
  for (const part of chunkForInFilter(emails)) {
    const { data: recipients } = await db
      .from('sender_recipients')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('status', 'active')
      .in('email', part);
    const ids = (recipients ?? []).map((row) => String(row.id));
    if (!ids.length) continue;
    await db.from('sender_messages').update({ status: 'canceled' }).in('recipient_id', ids).eq('status', 'scheduled');
    await db
      .from('sender_recipients')
      .update({ status: 'stopped', next_step_at: null, updated_at: nowIso })
      .in('id', ids)
      .eq('status', 'active');
  }
}

/**
 * POST — добавить адреса руками или списком. campaignId — в стоп-лист этой
 * кампании, без него — в общий.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.suppressions.add' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as
      | { email?: unknown; emails?: unknown; note?: unknown; campaignId?: unknown }
      | null;

    const raw = typeof body?.email === 'string'
      ? [body.email]
      : Array.isArray(body?.emails)
        ? body.emails.filter((e): e is string => typeof e === 'string')
        : [];
    const emails = [...new Set(raw.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
    if (!emails.length) return jsonError('Укажите хотя бы один корректный адрес', 400);

    const campaignId = body?.campaignId == null ? null : campaignIdOf(body.campaignId);
    if (body?.campaignId != null && !campaignId) return jsonError('Кампания указана неверно', 400);
    if (campaignId) {
      const { data: campaign } = await supabaseAdmin
        .from('sender_campaigns').select('id').eq('id', campaignId).maybeSingle();
      if (!campaign) return jsonError('Кампания не найдена', 404);
    }

    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    const chunkSize = 500;
    let imported = 0;
    for (let i = 0; i < emails.length; i += chunkSize) {
      const part = emails.slice(i, i + chunkSize);
      // Уже стоящие в стоп-листе не трогаем: автоматическая причина (отбойник,
      // отписка) информативнее ручной «на всякий случай».
      const { data, error: upsertError } = campaignId
        ? await supabaseAdmin
          .from('sender_campaign_suppressions')
          .upsert(
            part.map((email) => ({ campaign_id: campaignId, email, reason: 'manual', note })),
            { onConflict: 'campaign_id,email', ignoreDuplicates: true },
          )
          .select('email')
        : await supabaseAdmin
          .from('sender_suppressions')
          .upsert(part.map((email) => ({ email, reason: 'manual', note })), { onConflict: 'email', ignoreDuplicates: true })
          .select('email');
      if (upsertError) return jsonError(upsertError.message, 500);
      imported += data?.length ?? 0;
    }

    if (campaignId) await stopInCampaign(campaignId, emails);

    return NextResponse.json({ imported, skippedExisting: emails.length - imported });
  });
}

/** DELETE — снять адрес со стоп-листа (?email=...; &campaignId=... — со стоп-листа кампании). */
export async function DELETE(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.suppressions.remove' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return jsonError('Укажите корректный адрес', 400);
    const rawCampaign = url.searchParams.get('campaignId');
    const campaignId = rawCampaign ? campaignIdOf(rawCampaign) : null;
    if (rawCampaign && !campaignId) return jsonError('Кампания указана неверно', 400);

    const { error } = campaignId
      ? await supabaseAdmin
        .from('sender_campaign_suppressions')
        .delete()
        .eq('campaign_id', campaignId)
        .eq('email', email)
      : await supabaseAdmin.from('sender_suppressions').delete().eq('email', email);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
