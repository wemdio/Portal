import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { isResourceAllowed } from '@/lib/clientAccess';
import { getEmail, markThreadAsRead } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readCampaignAnalyticsFromDb } from '@/lib/tools/instantlyCampaignCatalog';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SyncedLeadRow = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
};

async function readCampaignName(campaignId: string): Promise<string | null> {
  try {
    const { campaigns } = await readCampaignAnalyticsFromDb([campaignId]);
    return (campaigns[0]?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function readSyncedLead(userId: string, email: string): Promise<SyncedLeadRow | null> {
  if (!supabaseAdmin || !email) return null;

  const { data } = await supabaseAdmin
    .from('client_campaign_leads')
    .select('email, first_name, last_name, company_name, website, linkedin_url')
    .eq('client_user_id', userId)
    .eq('email', email)
    .maybeSingle();

  return (data as SyncedLeadRow | null) ?? null;
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; emailId: string }> },
) {
  const result = await requireClientAuth(_req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) {
    return NextResponse.json({ ok: true, already_marked: true, demo: true });
  }
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId, accessRows } = result.auth;
  const { id: campaignId, emailId } = await ctx.params;

  if (!isResourceAllowed(campaignId, accessRows, 'campaign')) {
    return jsonError('Кампания не найдена или доступ запрещён', 404);
  }

  try {
    const original = await getEmail(emailId);
    if (!original || original.campaign_id !== campaignId) {
      return jsonError('Письмо не относится к кампании', 404);
    }

    const reply = mapInstantlyEmailToReply(original);
    const leadEmail = reply.from_email?.trim();
    if (!leadEmail) return jsonError('У ответа нет email лида', 400);

    const markRead = async () => {
      if (!original.thread_id) return;
      try {
        await markThreadAsRead(original.thread_id);
      } catch (err) {
        await logError('client.replies.mark_lead.mark_read_failed', err, {
          campaignId,
          emailId,
          threadId: original.thread_id,
          userId,
        });
      }
    };

    const replyTimestamp = reply.timestamp ?? original.timestamp_created ?? new Date().toISOString();
    const existingQuery = supabaseInstantly
      .from('client_forwarded_leads')
      .select('*')
      .eq('client_user_id', userId)
      .eq('campaign_id', campaignId)
      .eq('lead_email', leadEmail)
      .maybeSingle();

    const { data: existing, error: existingError } = await existingQuery;
    if (existingError) throw new Error(existingError.message);
    if (existing) {
      await markRead();
      return NextResponse.json({ ok: true, lead: existing, already_marked: true });
    }

    const [campaignName, syncedLead] = await Promise.all([
      readCampaignName(campaignId),
      readSyncedLead(userId, leadEmail),
    ]);

    const syncedName = syncedLead && (syncedLead.first_name || syncedLead.last_name)
      ? [syncedLead.first_name, syncedLead.last_name].filter(Boolean).join(' ')
      : null;

    const { data: lead, error } = await supabaseInstantly
      .from('client_forwarded_leads')
      .insert({
        qualification_id: null,
        client_user_id: userId,
        forwarded_by: userId,
        campaign_id: campaignId,
        campaign_name: campaignName,
        lead_email: leadEmail,
        lead_name: reply.from_name ?? syncedName,
        company_name: syncedLead?.company_name ?? null,
        phone: null,
        website: syncedLead?.website ?? null,
        linkedin_url: syncedLead?.linkedin_url ?? null,
        reply_subject: reply.subject,
        reply_body: reply.body_text,
        last_outbound_preview: null,
        reply_timestamp: replyTimestamp,
        status: 'lead',
        ai_reason: 'Пользователь пометил диалог как лид в клиентском портале.',
        forwarded_via: 'portal',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    await markRead();

    void logAudit('client.replies.mark_lead.created', 'Client marked reply thread as lead', {
      campaignId,
      emailId,
      leadEmail,
      userId,
    });

    return NextResponse.json({ ok: true, lead, already_marked: false }, { status: 201 });
  } catch (err) {
    await logError('client.replies.mark_lead.failed', err, { campaignId, emailId, userId });
    return jsonError(err instanceof Error ? err.message : 'Не удалось пометить как лид', 502);
  }
}
