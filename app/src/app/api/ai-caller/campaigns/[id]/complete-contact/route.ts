import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { getCall } from '@/lib/ai-caller-provider';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST — пометить контакт как завершённый (после окончания звонка) */
export async function POST(req: NextRequest, ctx: Ctx) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const provider = resolveAiCallerProvider(req);

  const { id: campaignId } = await ctx.params;
  const { data: campaignForProvider } = await supabase
    .from('ai_campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('provider', provider)
    .maybeSingle();

  if (!campaignForProvider) {
    return NextResponse.json({ error: 'Кампания не найдена' }, { status: 404 });
  }

  let body: { contactId?: string; callId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.contactId || !body.callId) {
    return NextResponse.json({ error: 'contactId and callId required' }, { status: 400 });
  }

  // Fetch call details from Vapi
  let callData: Record<string, unknown> | null = null;
  try {
    callData = await getCall(body.callId, provider) as Record<string, unknown>;
  } catch {
    // Call details unavailable
  }

  const duration = callData?.startedAt && callData?.endedAt
    ? Math.round((new Date(callData.endedAt as string).getTime() - new Date(callData.startedAt as string).getTime()) / 1000)
    : null;

  const endedReason = (callData?.endedReason as string) || null;
  const hasTranscript = !!((callData?.transcript as string)?.trim());
  const isSuccessful = hasTranscript && (duration ?? 0) > 15;

  // Update contact
  await supabase
    .from('ai_campaign_contacts')
    .update({
      status: 'completed',
      call_duration: duration,
      call_ended_reason: endedReason,
    })
    .eq('id', body.contactId);

  // Инкремент — в самой базе (col = col + 1). Прежнее чтение-изменение-запись
  // из уже прочитанной строки теряло инкремент, если параллельно счётчик двигал
  // воркер обзвона. p_run_token = null — у ручного пути аренды нет.
  if (isSuccessful) {
    await supabase.rpc('ai_campaign_bump_counters', {
      p_campaign_id: campaignId,
      p_called: 0,
      p_successful: 1,
      p_run_token: null,
    });
  }

  return NextResponse.json({ ok: true, duration, endedReason, isSuccessful });
}
