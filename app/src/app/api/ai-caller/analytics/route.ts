import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { getCall, parseProvider } from '@/lib/ai-caller-provider';

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

const PAGE_SIZE = 100;
const IN_CHUNK_SIZE = 80;
const MAX_GLOBAL_ANALYSES = 2000;

type SupabaseClient = ReturnType<typeof createAuthedSupabaseClient>;
type AnalysisRow = Record<string, unknown> & { analyzed_at?: string; vapi_call_id?: string };

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sortByAnalyzedAtDesc(rows: AnalysisRow[]): AnalysisRow[] {
  return rows.sort((a, b) => {
    const aTs = new Date(String(a.analyzed_at ?? '')).getTime() || 0;
    const bTs = new Date(String(b.analyzed_at ?? '')).getTime() || 0;
    return bTs - aTs;
  });
}

async function fetchCampaignCallIds(supabase: SupabaseClient, campaignId: string): Promise<string[]> {
  const callIds: string[] = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('ai_campaign_contacts')
      .select('vapi_call_id')
      .eq('campaign_id', campaignId)
      .not('vapi_call_id', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.vapi_call_id) callIds.push(row.vapi_call_id);
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return Array.from(new Set(callIds));
}

async function fetchExistingAnalysisIdsByCallIds(
  supabase: SupabaseClient,
  callIds: string[],
): Promise<Set<string>> {
  const existingIds = new Set<string>();

  for (const idsChunk of chunkArray(callIds, IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('ai_call_analyses')
      .select('vapi_call_id')
      .in('vapi_call_id', idsChunk);

    if (error) throw error;
    for (const row of data ?? []) {
      if (row.vapi_call_id) existingIds.add(row.vapi_call_id);
    }
  }

  return existingIds;
}

async function fetchAnalysesByCallIds(
  supabase: SupabaseClient,
  callIds: string[],
): Promise<AnalysisRow[]> {
  if (callIds.length === 0) return [];

  const analyses: AnalysisRow[] = [];
  for (const idsChunk of chunkArray(callIds, IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('ai_call_analyses')
      .select('*')
      .in('vapi_call_id', idsChunk);

    if (error) throw error;
    analyses.push(...((data ?? []) as AnalysisRow[]));
  }

  return sortByAnalyzedAtDesc(analyses);
}

async function fetchAnalysesByCampaignId(
  supabase: SupabaseClient,
  campaignId: string,
  outcome?: string | null,
): Promise<AnalysisRow[]> {
  const analyses: AnalysisRow[] = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    let query = supabase
      .from('ai_call_analyses')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('analyzed_at', { ascending: false })
      .range(from, to);

    if (outcome) query = query.eq('outcome', outcome);

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    analyses.push(...(data as AnalysisRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return analyses;
}

async function fetchLatestAnalyses(
  supabase: SupabaseClient,
  outcome?: string | null,
): Promise<AnalysisRow[]> {
  const analyses: AnalysisRow[] = [];
  let from = 0;

  while (analyses.length < MAX_GLOBAL_ANALYSES) {
    const to = from + PAGE_SIZE - 1;
    let query = supabase
      .from('ai_call_analyses')
      .select('*')
      .order('analyzed_at', { ascending: false })
      .range(from, to);

    if (outcome) query = query.eq('outcome', outcome);

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    analyses.push(...(data as AnalysisRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return analyses;
}

/** POST — анализировать звонки (массово или по одному, с привязкой к кампании) */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const provider = parseProvider(req.headers.get('x-ai-caller-provider'));

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
    try {
      callIds = await fetchCampaignCallIds(supabase, campaignId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось загрузить звонки кампании';
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  callIds = Array.from(new Set(callIds));

  if (!callIds.length) {
    return NextResponse.json({ error: 'callIds required or campaignId with calls' }, { status: 400 });
  }

  // Check which calls are already analyzed
  let existingIds: Set<string>;
  try {
    existingIds = await fetchExistingAnalysisIdsByCallIds(supabase, callIds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Не удалось проверить существующие анализы';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // If campaignId provided, update existing analyses that are missing campaign_id
  if (campaignId && existingIds.size > 0) {
    const callIdsToUpdate = Array.from(existingIds);
    for (const idsChunk of chunkArray(callIdsToUpdate, IN_CHUNK_SIZE)) {
      await supabase
        .from('ai_call_analyses')
        .update({ campaign_id: campaignId })
        .in('vapi_call_id', idsChunk)
        .is('campaign_id', null);
    }
  }

  const newCallIds = callIds.filter((id) => !existingIds.has(id));

  if (newCallIds.length === 0) {
    try {
      const analyses = await fetchAnalysesByCallIds(supabase, callIds);
      return NextResponse.json({ analyses });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось загрузить анализы';
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // Fetch call details and analyze in parallel batches
  const results: Record<string, unknown>[] = [];
  const BATCH_SIZE = 10;

  async function analyzeOne(callId: string) {
    const callData = (await getCall(callId, provider)) as Record<string, unknown>;
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
      return analysis;
    }

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

    if (!aiRes.ok) return null;

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
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
    return analysis;
  }

  for (let i = 0; i < newCallIds.length; i += BATCH_SIZE) {
    const batch = newCallIds.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(analyzeOne));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
  }

  // Return all analyses for requested callIds
  try {
    const allAnalyses = await fetchAnalysesByCallIds(supabase, callIds);
    return NextResponse.json({ analyses: allAnalyses, newlyAnalyzed: results.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Не удалось загрузить анализы после обработки';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
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

  let analyses: AnalysisRow[] = [];

  try {
    if (campaignId) {
      // Try direct campaign_id match first
      const directMatch = await fetchAnalysesByCampaignId(supabase, campaignId);
      if (directMatch.length > 0) {
        analyses = directMatch;
      } else {
        // Fallback: find analyses by vapi_call_id from campaign contacts
        const vapiCallIds = await fetchCampaignCallIds(supabase, campaignId);
        if (vapiCallIds.length > 0) {
          analyses = await fetchAnalysesByCallIds(supabase, vapiCallIds);

          // Backfill campaign_id for these analyses
          if (analyses.length > 0) {
            for (const idsChunk of chunkArray(vapiCallIds, IN_CHUNK_SIZE)) {
              await supabase
                .from('ai_call_analyses')
                .update({ campaign_id: campaignId })
                .in('vapi_call_id', idsChunk)
                .is('campaign_id', null);
            }
          }
        }
      }
    } else {
      analyses = await fetchLatestAnalyses(supabase, outcome);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Не удалось получить анализы';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (outcome && campaignId) {
    analyses = analyses.filter((a) => a.outcome === outcome);
  }

  // Enrich with campaign contact info (company, name, email)
  const customerNumbers = analyses
    .map((a) => (typeof a.customer_number === 'string' ? a.customer_number : null))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const uniqueCustomerNumbers = Array.from(new Set(customerNumbers));

  const contactMap: Record<
    string,
    {
      company_name: string | null;
      contact_name: string | null;
      email: string | null;
      extra_data: Record<string, string> | null;
    }
  > = {};

  if (uniqueCustomerNumbers.length > 0) {
    for (const numbersChunk of chunkArray(uniqueCustomerNumbers, IN_CHUNK_SIZE)) {
      const { data: contacts } = await supabase
        .from('ai_campaign_contacts')
        .select('phone_number, company_name, contact_name, email, extra_data')
        .in('phone_number', numbersChunk);

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
  }

  const enriched = analyses.map((a) => {
    const customerNumber = typeof a.customer_number === 'string' ? a.customer_number : null;
    const analysisCompanyName = typeof a.company_name === 'string' ? a.company_name : null;
    const contact = customerNumber ? contactMap[customerNumber] : null;
    return {
      ...a,
      contact_company: contact?.company_name ?? analysisCompanyName ?? null,
      contact_name: contact?.contact_name ?? null,
      contact_email: contact?.email ?? null,
      contact_extra: contact?.extra_data ?? null,
    };
  });

  return NextResponse.json({ analyses: enriched });
}
