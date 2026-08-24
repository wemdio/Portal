import { NextResponse } from 'next/server';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildHandoffDraft } from '@/lib/instantly/handoffLegend';
import { resolveCampaignProjectOwner } from '@/lib/instantly/campaignProjectOwnerResolver';

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
 * Превью-драфт передачи лида для ручной пересылки. Ничего не отправляется: UI
 * подставляет текст в поле ответа, спец правит и шлёт сам.
 * Режим по тумблеру проекта (handoff_ai_adapt): OFF (дефолт) — легенда проекта
 * ДОСЛОВНО (+ подстановка имени); ON — ИИ адаптирует легенду под ответ лида.
 * Легенды нет (и override не передан) — пустой драфт, спец пишет руками.
 */
export const POST = withAuth(async (req, user) => {
  if (!supabaseInstantly || !supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { qualification_id, framing } = (await req.json()) as DraftBody;
  if (!qualification_id) return jsonError('qualification_id обязателен', 400);

  const { data: qual, error } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('lead_name, campaign_id, reply_body, reply_preview, last_outbound_preview')
    .eq('id', qualification_id)
    .single();

  if (error || !qual) return jsonError('Квалификация не найдена', 404);

  const campaignId = (qual.campaign_id as string | null) ?? '';
  if (!campaignId) return jsonError('У квалификации не указана кампания', 409);

  const owner = await resolveCampaignProjectOwner(supabaseInstantly, campaignId);
  if (owner.status === 'ambiguous') {
    return jsonError('Не удалось однозначно определить проект кампании', 409);
  }
  if (owner.status === 'none') {
    return jsonError('Проект кампании не найден', 404);
  }

  const { data: project, error: projectError } = await supabaseAdmin
    .from('projects')
    .select('handoff_legend, handoff_ai_adapt, specialist_user_id')
    .eq('id', owner.projectId)
    .single();
  if (projectError || !project) {
    return jsonError('Проект кампании не найден', 404);
  }
  if ((project.specialist_user_id as string | null) !== user.id) {
    return jsonError('Доступ к лиду запрещён', 403);
  }

  // Легенда: per-request override ИЛИ легенда проекта кампании.
  let legend = (framing ?? '').trim();
  let aiAdapt = false;
  if (!legend) {
    legend = ((project.handoff_legend as string | null) ?? '').trim();
    aiAdapt = Boolean(project.handoff_ai_adapt);
  }

  // Пустой драфт (нет легенды) — спец напишет текст руками, как до ИИ-превью.
  if (!legend) return NextResponse.json({ draft: '' });

  // Тумблер проекта: OFF — легенда дословно (+ подстановка имени); ON — ИИ
  // адаптирует легенду под ответ лида (старое поведение).
  const leadReplyText =
    (qual.reply_body as string | null) || (qual.reply_preview as string | null) || '';
  const draft = await buildHandoffDraft({
    aiAdapt,
    legend,
    leadName: (qual.lead_name as string | null) ?? null,
    leadReplyText,
    lastOutboundText: (qual.last_outbound_preview as string | null) ?? null,
    apiKey: API_KEY(),
  });
  return NextResponse.json({ draft });
});
