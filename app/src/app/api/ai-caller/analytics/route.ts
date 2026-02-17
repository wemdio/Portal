import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { getCall } from '@/lib/vapi';

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

/** POST — анализировать звонки (массово или по одному, с привязкой к кампании) */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!OPENROUTER_API_KEY) {
    return NextResponse.json({ error: 'OPENROUTER_BRIEF_API_KEY не настроен' }, { status: 500 });
  }

  let body: { callIds?: string[]; campaignId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const campaignId = body.campaignId ?? null;
  let callIds = body.callIds ?? [];

  // If campaignId provided but no callIds — auto-collect from campaign contacts
  if (campaignId && callIds.length === 0) {
    const { data: contacts } = await supabase
      .from('ai_campaign_contacts')
      .select('vapi_call_id')
      .eq('campaign_id', campaignId)
      .not('vapi_call_id', 'is', null);

    callIds = (contacts ?? []).map((c) => c.vapi_call_id).filter(Boolean) as string[];
  }

  if (!callIds.length) {
    return NextResponse.json({ error: 'callIds required or campaignId with calls' }, { status: 400 });
  }

  // Check which calls are already analyzed
  const { data: existing } = await supabase
    .from('ai_call_analyses')
    .select('vapi_call_id')
    .in('vapi_call_id', callIds);

  const existingIds = new Set(existing?.map((e) => e.vapi_call_id) ?? []);

  // If campaignId provided, update existing analyses that are missing campaign_id
  if (campaignId && existing && existing.length > 0) {
    const callIdsToUpdate = existing.map((e) => e.vapi_call_id);
    await supabase
      .from('ai_call_analyses')
      .update({ campaign_id: campaignId })
      .in('vapi_call_id', callIdsToUpdate)
      .is('campaign_id', null);
  }

  const newCallIds = callIds.filter((id) => !existingIds.has(id));

  if (newCallIds.length === 0) {
    const { data: analyses } = await supabase
      .from('ai_call_analyses')
      .select('*')
      .in('vapi_call_id', callIds)
      .order('analyzed_at', { ascending: false });

    return NextResponse.json({ analyses: analyses ?? [] });
  }

  // Fetch call details and analyze
  const results = [];

  for (const callId of newCallIds.slice(0, 50)) {
    try {
      const callData = (await getCall(callId)) as Record<string, unknown>;
      const transcript = (callData.transcript as string) || '';
      const customerNumber = (callData.customer as Record<string, string>)?.number || '';
      const assistantName = (callData.assistant as Record<string, string>)?.name || '';

      if (!transcript || transcript.trim().length < 20) {
        const analysis = {
          vapi_call_id: callId,
          assistant_name: assistantName,
          customer_number: customerNumber,
          campaign_id: campaignId,
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
        campaign_id: campaignId,
        outcome: parsed.outcome as string || 'other',
        interest_level: Math.max(0, Math.min(10, Number(parsed.interest_level) || 0)),
        summary: (parsed.summary as string) || '',
        next_action: (parsed.next_action as string) || '',
        key_points: Array.isArray(parsed.key_points) ? parsed.key_points as string[] : [],
        transcript_snippet: transcript.slice(0, 2000),
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
    .in('vapi_call_id', callIds)
    .order('analyzed_at', { ascending: false });

  return NextResponse.json({ analyses: allAnalyses ?? [], newlyAnalyzed: results.length });
}

/** GET — получить все анализы (с фильтрацией) + данные контактов из кампаний */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const outcome = searchParams.get('outcome');
  const campaignId = searchParams.get('campaignId');

  let analyses: Record<string, unknown>[] = [];

  if (campaignId) {
    // Try direct campaign_id match first
    const { data: directMatch } = await supabase
      .from('ai_call_analyses')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('analyzed_at', { ascending: false })
      .limit(100);

    if (directMatch && directMatch.length > 0) {
      analyses = directMatch;
    } else {
      // Fallback: find analyses by vapi_call_id from campaign contacts
      const { data: contacts } = await supabase
        .from('ai_campaign_contacts')
        .select('vapi_call_id')
        .eq('campaign_id', campaignId)
        .not('vapi_call_id', 'is', null);

      const vapiCallIds = (contacts ?? []).map((c) => c.vapi_call_id).filter(Boolean) as string[];

      if (vapiCallIds.length > 0) {
        const { data: matchedAnalyses } = await supabase
          .from('ai_call_analyses')
          .select('*')
          .in('vapi_call_id', vapiCallIds)
          .order('analyzed_at', { ascending: false })
          .limit(100);

        analyses = matchedAnalyses ?? [];

        // Backfill campaign_id for these analyses
        if (analyses.length > 0) {
          await supabase
            .from('ai_call_analyses')
            .update({ campaign_id: campaignId })
            .in('vapi_call_id', vapiCallIds)
            .is('campaign_id', null);
        }
      }
    }
  } else {
    let query = supabase
      .from('ai_call_analyses')
      .select('*')
      .order('analyzed_at', { ascending: false })
      .limit(100);

    if (outcome) query = query.eq('outcome', outcome);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    analyses = data ?? [];
  }

  if (outcome && campaignId) {
    analyses = analyses.filter((a) => a.outcome === outcome);
  }

  // Enrich with campaign contact info (company, name, email)
  const customerNumbers = analyses
    .map((a) => a.customer_number)
    .filter(Boolean) as string[];

  const contactMap: Record<
    string,
    {
      company_name: string | null;
      contact_name: string | null;
      email: string | null;
      extra_data: Record<string, string> | null;
    }
  > = {};

  if (customerNumbers.length > 0) {
    const { data: contacts } = await supabase
      .from('ai_campaign_contacts')
      .select('phone_number, company_name, contact_name, email, extra_data')
      .in('phone_number', customerNumbers);

    if (contacts) {
      for (const c of contacts) {
        contactMap[c.phone_number] = {
          company_name: c.company_name,
          contact_name: c.contact_name,
          email: c.email,
          extra_data: c.extra_data,
        };
      }
    }
  }

  const enriched = analyses.map((a) => {
    const contact = a.customer_number ? contactMap[a.customer_number] : null;
    return {
      ...a,
      contact_company: contact?.company_name ?? a.company_name ?? null,
      contact_name: contact?.contact_name ?? null,
      contact_email: contact?.email ?? null,
      contact_extra: contact?.extra_data ?? null,
    };
  });

  return NextResponse.json({ analyses: enriched });
}
