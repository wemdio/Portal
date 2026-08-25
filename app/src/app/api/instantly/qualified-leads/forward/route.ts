import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import * as instantly from '@/lib/instantly/client';
import { sendLeadNotification } from '@/lib/instantly/leadNotifier';
import type { LeadNotificationData } from '@/lib/instantly/leadNotifier';
import {
  loadAuthorizedQualification,
  qualifiedLeadAccessErrorResponse,
} from '@/lib/instantly/qualifiedLeadAuthorization';

export const dynamic = 'force-dynamic';

interface ForwardBody {
  qualification_id: string;
  client_user_id?: string | null;
  telegram_chat_id?: number | null;
}

interface ForwardQualification extends Record<string, unknown> {
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  reply_subject: string | null;
  reply_body: string | null;
  last_outbound_preview: string | null;
  reply_timestamp: string | null;
  status: string | null;
  ai_reason: string | null;
}

export const POST = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = (await req.json()) as ForwardBody;
  const { qualification_id, client_user_id, telegram_chat_id } = body;

  if (!qualification_id) {
    return NextResponse.json(
      { error: 'qualification_id is required' },
      { status: 400 },
    );
  }

  if (!client_user_id && !telegram_chat_id) {
    return NextResponse.json(
      { error: 'Укажите client_user_id или telegram_chat_id' },
      { status: 400 },
    );
  }

  const authorization = await loadAuthorizedQualification<ForwardQualification>(
    user.id,
    qualification_id,
  );
  if (!authorization.ok) return qualifiedLeadAccessErrorResponse(authorization);
  const qual = authorization.qualification;
  const campaignId = authorization.campaignId;

  // Deduplication: check by qualification + chat combo (or qualification + client)
  if (telegram_chat_id) {
    const { data: existing } = await supabaseInstantly
      .from('client_forwarded_leads')
      .select('id')
      .eq('qualification_id', qualification_id)
      .eq('telegram_chat_id', telegram_chat_id)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Этот лид уже был передан в этот чат' },
        { status: 409 },
      );
    }
  } else if (client_user_id) {
    const { data: existing } = await supabaseInstantly
      .from('client_forwarded_leads')
      .select('id')
      .eq('qualification_id', qualification_id)
      .eq('client_user_id', client_user_id)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Этот лид уже был передан этому клиенту' },
        { status: 409 },
      );
    }
  }

  let phone: string | null = null;
  let website: string | null = null;
  let linkedinUrl: string | null = null;
  let leadName = qual.lead_name as string | null;
  let companyName = qual.company_name as string | null;

  try {
    const leads = await instantly.getLeadsByEmail({
      email: qual.lead_email,
      campaign_id: campaignId,
    });
    const lead = leads?.[0];
    if (lead) {
      phone = lead.phone ?? null;
      website = lead.website ?? null;
      linkedinUrl = lead.linkedin_url ?? null;
      if (!leadName) {
        leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
      }
      if (!companyName) {
        companyName = lead.company_name ?? null;
      }
    }
  } catch {
    // enrichment is best-effort
  }

  if ((!website || !companyName) && supabaseAdmin) {
    try {
      const { data: synced } = await supabaseAdmin
        .from('client_campaign_leads')
        .select('first_name, last_name, company_name, website, linkedin_url')
        .eq('email', qual.lead_email)
        .eq('campaign_id', campaignId)
        .limit(1)
        .maybeSingle();

      if (synced) {
        if (!website && synced.website) website = synced.website;
        if (!linkedinUrl && synced.linkedin_url) linkedinUrl = synced.linkedin_url;
        if (!leadName && (synced.first_name || synced.last_name)) {
          leadName = [synced.first_name, synced.last_name].filter(Boolean).join(' ') || null;
        }
        if (!companyName && synced.company_name) companyName = synced.company_name;
      }
    } catch {
      // fallback enrichment is best-effort
    }
  }

  const effectiveChatId = telegram_chat_id ?? null;

  const { data: forwarded, error: insErr } = await supabaseInstantly
    .from('client_forwarded_leads')
    .insert({
      qualification_id,
    client_user_id: client_user_id ?? null,
    forwarded_by: user.id,
      campaign_id: qual.campaign_id,
      campaign_name: qual.campaign_name,
      lead_email: qual.lead_email,
      lead_name: leadName,
      company_name: companyName,
      phone,
      website,
      linkedin_url: linkedinUrl,
      reply_subject: qual.reply_subject,
      reply_body: qual.reply_body,
      last_outbound_preview: qual.last_outbound_preview,
      reply_timestamp: qual.reply_timestamp,
      status: qual.status,
      ai_reason: qual.ai_reason,
      telegram_chat_id: effectiveChatId,
    })
    .select()
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      return NextResponse.json(
        { error: 'Этот лид уже был передан этому клиенту' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  let telegramSent = false;
  if (effectiveChatId && forwarded) {
    const notifData: LeadNotificationData = {
      leadEmail: qual.lead_email,
      leadName,
      companyName,
      phone,
      website,
      linkedinUrl,
      campaignName: qual.campaign_name,
      replySubject: qual.reply_subject,
      replyBody: qual.reply_body,
      lastOutboundPreview: qual.last_outbound_preview,
      replyTimestamp: qual.reply_timestamp,
      status: qual.status,
      aiReason: qual.ai_reason,
    };

    const tgResult = await sendLeadNotification(effectiveChatId, notifData);
    if (tgResult.messageId) {
      telegramSent = true;
      await supabaseInstantly
        .from('client_forwarded_leads')
        .update({ telegram_message_id: tgResult.messageId })
        .eq('id', forwarded.id);
    }
  }

  return NextResponse.json({
    ok: true,
    forwarded_lead_id: forwarded?.id,
    telegram_sent: telegramSent,
  });
});
