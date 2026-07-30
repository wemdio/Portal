import { NextResponse } from 'next/server';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { substituteHandoffLegend } from '@/lib/instantly/handoffLegend';

export const dynamic = 'force-dynamic';

interface DraftBody {
  qualification_id: string;
  /** Optional per-request override of the handoff legend. */
  framing?: string;
}

/**
 * Превью-драфт передачи лида для ручной пересылки: легенда проекта ДОСЛОВНО
 * (БЕЗ ИИ — спецы полностью контролируют текст; автогенератор убран после
 * жалоб «пишет широко и консультирует»). Ничего не отправляется: UI
 * подставляет текст в поле ответа, спец правит и шлёт сам. Легенда пуста
 * (и override не передан) — вернём пустой драфт, спец напишет руками.
 */
export const POST = withAuth(async (req) => {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { qualification_id, framing } = (await req.json()) as DraftBody;
  if (!qualification_id) return jsonError('qualification_id обязателен', 400);

  const { data: qual, error } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('lead_name, campaign_id')
    .eq('id', qualification_id)
    .single();

  if (error || !qual) return jsonError('Квалификация не найдена', 404);

  // Легенда: per-request override ИЛИ легенда проекта кампании.
  let legend = (framing ?? '').trim();
  if (!legend) {
    const campaignId = (qual.campaign_id as string | null) ?? '';
    if (!campaignId) return NextResponse.json({ draft: '' });
    const { data: periodLinks } = await supabaseInstantly
      .from('project_period_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId);
    const { data: legacyLinks } = await supabaseInstantly
      .from('project_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId);
    const projectIds = [...(periodLinks ?? []), ...(legacyLinks ?? [])]
      .map((l: { project_id?: string | null }) => l.project_id)
      .filter((id): id is string => Boolean(id));
    if (projectIds.length > 0 && supabaseAdmin) {
      const { data: project } = await supabaseAdmin
        .from('projects')
        .select('handoff_legend')
        .in('id', projectIds)
        .limit(1)
        .maybeSingle();
      legend = ((project?.handoff_legend as string | null) ?? '').trim();
    }
  }

  // Пустой драфт (нет легенды) — спец напишет текст руками, как до ИИ-превью.
  const draft = legend
    ? substituteHandoffLegend(legend, (qual.lead_name as string | null) ?? null)
    : '';
  return NextResponse.json({ draft });
});
