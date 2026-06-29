import { NextResponse } from 'next/server';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { generateHandoffReply } from '@/lib/instantly/handoffGenerator';

export const dynamic = 'force-dynamic';

interface DraftBody {
  qualification_id: string;
  /** Optional per-request override of the handoff legend. */
  framing?: string;
}

const API_KEY = () =>
  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  '';

/**
 * Generates a context-aware handoff reply for a qualified lead — the text a
 * specialist would otherwise type by hand before forwarding to the client.
 * Pure generation: nothing is sent. The incoming-leads UI calls this to
 * pre-fill the reply field; the specialist still reviews and sends.
 */
export const POST = withAuth(async (req) => {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const apiKey = API_KEY();
  if (!apiKey) return jsonError('AI ключ не настроен (OPENROUTER_INSTANTLY_LEAD_API_KEY)', 500);

  const { qualification_id, framing } = (await req.json()) as DraftBody;
  if (!qualification_id) return jsonError('qualification_id обязателен', 400);

  const { data: qual, error } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('lead_name, reply_body, reply_preview, last_outbound_preview')
    .eq('id', qualification_id)
    .single();

  if (error || !qual) return jsonError('Квалификация не найдена', 404);

  const leadReplyText =
    (qual.reply_body as string | null) || (qual.reply_preview as string | null) || '';
  if (!leadReplyText.trim()) {
    return jsonError('У ответа лида нет текста — нечего обрабатывать', 400);
  }

  const draft = await generateHandoffReply(
    {
      leadReplyText,
      lastOutboundText: (qual.last_outbound_preview as string | null) ?? null,
      leadName: (qual.lead_name as string | null) ?? null,
      framing: framing ?? null,
    },
    { apiKey },
  );

  return NextResponse.json({ draft });
});
