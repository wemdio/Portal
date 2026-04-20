import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import * as instantly from '@/lib/instantly/client';

export const dynamic = 'force-dynamic';

interface ForwardEmailBody {
  qualification_id: string;
  client_email?: string;
  reply_text: string;
}

export const POST = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = (await req.json()) as ForwardEmailBody;
  const { qualification_id, client_email, reply_text } = body;

  if (!qualification_id || !reply_text) {
    return NextResponse.json(
      { error: 'qualification_id и reply_text обязательны' },
      { status: 400 },
    );
  }

  if (client_email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(client_email)) {
      return NextResponse.json({ error: 'Некорректный email' }, { status: 400 });
    }
  }

  const { data: qual, error: qualErr } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('*')
    .eq('id', qualification_id)
    .single();

  if (qualErr || !qual) {
    return NextResponse.json({ error: 'Квалификация не найдена' }, { status: 404 });
  }

  const instantlyEmailId = qual.instantly_email_id as string | null;
  if (!instantlyEmailId) {
    return NextResponse.json(
      { error: 'Не найден ID письма в Instantly — невозможно ответить в тред' },
      { status: 400 },
    );
  }

  // Fetch the original email to get the sending account (eaccount)
  let eaccount: string | null = null;
  try {
    const emailData = await instantly.getEmail(instantlyEmailId);
    eaccount = (emailData?.eaccount as string) ?? null;

    // If eaccount not on the reply itself, look at the thread for outbound emails
    if (!eaccount && emailData?.thread_id) {
      const threadEmails = await instantly.listEmails({
        campaign_id: qual.campaign_id as string,
        limit: 50,
      });
      const outbound = (threadEmails.items ?? []).find(
        (e) => e.thread_id === emailData.thread_id && ((e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3) && e.eaccount,
      );
      if (outbound?.eaccount) {
        eaccount = outbound.eaccount;
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: 'Ошибка при загрузке письма из Instantly', details: String(err) },
      { status: 500 },
    );
  }

  if (!eaccount) {
    return NextResponse.json(
      { error: 'Не удалось определить аккаунт отправки (eaccount). Попробуйте ответить из Instantly напрямую.' },
      { status: 400 },
    );
  }

  // Send reply via Instantly API (with client in CC if provided, otherwise direct reply)
  try {
    await instantly.replyToEmail({
      reply_to_uuid: instantlyEmailId,
      eaccount,
      body: { text: reply_text },
      ...(client_email ? { cc_address_email_list: client_email } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Ошибка при отправке письма через Instantly', details: String(err) },
      { status: 500 },
    );
  }

  // Record tracking only when forwarded to client; direct replies don't create forwarded_leads rows
  if (client_email) {
    try {
      await supabaseInstantly
        .from('client_forwarded_leads')
        .insert({
          qualification_id,
          forwarded_by: user.id,
          campaign_id: qual.campaign_id,
          campaign_name: qual.campaign_name,
          lead_email: qual.lead_email,
          lead_name: qual.lead_name,
          company_name: qual.company_name,
          reply_subject: qual.reply_subject,
          reply_body: qual.reply_body,
          last_outbound_preview: qual.last_outbound_preview,
          reply_timestamp: qual.reply_timestamp,
          status: qual.status,
          ai_reason: qual.ai_reason,
          forwarded_via: 'email',
          client_email,
        });
    } catch {
      // tracking is best-effort
    }
  }

  return NextResponse.json({ ok: true, sent_to: client_email ?? qual.lead_email });
});
