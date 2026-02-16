import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { listCalls, getCall } from '@/lib/vapi';

export const dynamic = 'force-dynamic';

const OPENROUTER_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';

const ANALYSIS_PROMPT = `Ты — аналитик звонков. Проанализируй транскрипт телефонного разговора AI-ассистента с клиентом.

ЗАДАЧА: Определить исход звонка и рекомендовать следующее действие.

КЛАССИФИКАЦИЯ (outcome):
- "interested" — клиент проявил интерес, готов к следующему шагу
- "callback" — клиент просит перезвонить, занят, или нужно связаться позже
- "not_interested" — клиент отказался, не заинтересован
- "no_answer" — звонок без ответа или сразу сброшен
- "voicemail" — автоответчик
- "other" — непонятный исход

УРОВЕНЬ ИНТЕРЕСА (interest_level, 0-10):
- 8-10: Высокий интерес, готов к действию
- 5-7: Средний интерес, нужно дожать
- 2-4: Низкий интерес
- 0-1: Нет интереса

ФОРМАТ — верни ТОЛЬКО JSON:
{
  "outcome": "interested|not_interested|callback|no_answer|voicemail|other",
  "interest_level": 0-10,
  "summary": "Краткое резюме разговора, 1-2 предложения",
  "next_action": "Рекомендуемое следующее действие",
  "key_points": ["ключевой момент 1", "ключевой момент 2"]
}`;

/** POST — анализировать звонки (массово или по одному) */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!OPENROUTER_API_KEY) {
    return NextResponse.json({ error: 'OPENROUTER_BRIEF_API_KEY не настроен' }, { status: 500 });
  }

  let body: { callIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.callIds?.length) {
    return NextResponse.json({ error: 'callIds required' }, { status: 400 });
  }

  // Check which calls are already analyzed
  const { data: existing } = await supabase
    .from('ai_call_analyses')
    .select('vapi_call_id')
    .in('vapi_call_id', body.callIds);

  const existingIds = new Set(existing?.map((e) => e.vapi_call_id) ?? []);
  const newCallIds = body.callIds.filter((id) => !existingIds.has(id));

  if (newCallIds.length === 0) {
    const { data: analyses } = await supabase
      .from('ai_call_analyses')
      .select('*')
      .in('vapi_call_id', body.callIds)
      .order('analyzed_at', { ascending: false });

    return NextResponse.json({ analyses: analyses ?? [] });
  }

  // Fetch call details and analyze
  const results = [];

  for (const callId of newCallIds.slice(0, 10)) {
    try {
      const callData = (await getCall(callId)) as Record<string, unknown>;
      const transcript = (callData.transcript as string) || '';
      const customerNumber = (callData.customer as Record<string, string>)?.number || '';
      const assistantName = (callData.assistant as Record<string, string>)?.name || '';

      if (!transcript || transcript.trim().length < 20) {
        // No meaningful transcript — skip analysis, mark as no_answer
        const analysis = {
          vapi_call_id: callId,
          assistant_name: assistantName,
          customer_number: customerNumber,
          outcome: 'no_answer',
          interest_level: 0,
          summary: 'Разговор не состоялся или транскрипт отсутствует',
          next_action: 'Перезвонить позже',
          key_points: [],
          transcript_snippet: transcript.slice(0, 200),
        };

        await supabase.from('ai_call_analyses').upsert(analysis, { onConflict: 'vapi_call_id' });
        results.push(analysis);
        continue;
      }

      // Call AI to analyze
      const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Call Analytics',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: ANALYSIS_PROMPT },
            { role: 'user', content: `ТРАНСКРИПТ:\n${transcript.slice(0, 3000)}` },
          ],
          temperature: 0.2,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        }),
      });

      if (!aiRes.ok) continue;

      const aiData = await aiRes.json();
      const content = aiData.choices?.[0]?.message?.content?.trim() ?? '';
      if (!content) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) continue;
        parsed = JSON.parse(match[0]);
      }

      const analysis = {
        vapi_call_id: callId,
        assistant_name: assistantName,
        customer_number: customerNumber,
        outcome: parsed.outcome as string || 'other',
        interest_level: Math.max(0, Math.min(10, Number(parsed.interest_level) || 0)),
        summary: (parsed.summary as string) || '',
        next_action: (parsed.next_action as string) || '',
        key_points: Array.isArray(parsed.key_points) ? parsed.key_points as string[] : [],
        transcript_snippet: transcript.slice(0, 300),
      };

      await supabase.from('ai_call_analyses').upsert(analysis, { onConflict: 'vapi_call_id' });
      results.push(analysis);
    } catch {
      // Skip failed analyses
    }
  }

  // Return all analyses for requested callIds
  const { data: allAnalyses } = await supabase
    .from('ai_call_analyses')
    .select('*')
    .in('vapi_call_id', body.callIds)
    .order('analyzed_at', { ascending: false });

  return NextResponse.json({ analyses: allAnalyses ?? [], newlyAnalyzed: results.length });
}

/** GET — получить все анализы (с фильтрацией) */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const outcome = searchParams.get('outcome');
  const campaignId = searchParams.get('campaignId');

  let query = supabase
    .from('ai_call_analyses')
    .select('*')
    .order('analyzed_at', { ascending: false })
    .limit(100);

  if (outcome) query = query.eq('outcome', outcome);
  if (campaignId) query = query.eq('campaign_id', campaignId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ analyses: data ?? [] });
}
