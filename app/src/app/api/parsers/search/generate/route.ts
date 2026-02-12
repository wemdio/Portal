
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_API_KEY = process.env.OPENROUTER_SEARCH_PARSER_API_KEY || '';
const OPENROUTER_MODEL = 'google/gemini-3-flash-preview';

const SYSTEM_PROMPT = `Ты - эксперт по поиску B2B лидов и OSINT.
Твоя задача: на основе описания компании или брифа составить список эффективных поисковых запросов для Google/Yandex, чтобы найти потенциальных клиентов или целевые компании.

Правила:
1. Используй продвинутые операторы поиска (site:, intitle:, inurl:, filetype:pdf, filetype:xls и др.).
2. Цель: найти списки компаний, каталоги, профильные ассоциации, участников выставок, контакты ЛПР.
3. Составь от 5 до 10 запросов.
4. Ответ верни СТРОГО в формате JSON: { "queries": ["query1", "query2", ...] }. Без лишнего текста.
5. Запросы должны быть на языке целевой аудитории (русский для РФ/СНГ).
`;

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
          { role: 'system', content: SYSTEM_PROMPT },
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
    
    let parsed: { queries: string[] };
    try {
      parsed = JSON.parse(content);
    } catch {
       // Fallback if AI didn't return strict JSON
       const queries = content
         .split('\n')
         .map((line: string) => line.replace(/^[\s*\-•\d.]+/, '').trim())
         .filter((line: string) => line.length > 5)
         .slice(0, 10);
       parsed = { queries };
    }

    return NextResponse.json({ queries: parsed.queries || [] });
  } catch (err) {
    console.error('Generate queries error:', err);
    return jsonError('Failed to generate queries', 500);
  }
}
