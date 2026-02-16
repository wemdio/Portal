
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '@/lib/constants';
import { SEARCH_PARSER_SYSTEM_PROMPT } from '@/lib/aiPrompts';
import { buildSearchQueries } from '@/lib/parsers/searchQueryBuilder';
function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!OPENROUTER_API_KEY) {
    return jsonError('AI API key not configured', 500);
  }

  try {
    const { brief } = await req.json();
    if (!brief || typeof brief !== 'string') {
      return jsonError('Missing brief text', 400);
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://portal.app',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: SEARCH_PARSER_SYSTEM_PROMPT },
          { role: 'user', content: `Бриф клиента:\n${brief.slice(0, 4000)}` }
        ],
        temperature: 0.6,
        max_tokens: 400,
      })
    });

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return jsonError('Empty AI response', 502);
    }

    const queries = buildSearchQueries(content, brief);
    return NextResponse.json({ queries });
  } catch (err) {
    console.error('Generate queries error:', err);
    return jsonError('Failed to generate queries', 500);
  }
}
