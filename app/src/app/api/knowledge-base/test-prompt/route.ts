import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';
import { searchChunks } from '@/lib/knowledgeBase/contextRetriever';
import { DEFAULT_REACTIVE_PROMPT } from '@/lib/salesCopilot/types';

const SAMPLE_CONVERSATION = [
  { role: 'user', content: 'Добрый день! Увидел вашу услугу, интересно узнать подробнее' },
  { role: 'assistant', content: 'Здравствуйте! Конечно, расскажу. Что именно интересует?' },
  { role: 'user', content: 'Сколько стоит и какие сроки? И есть ли какие-то гарантии?' },
];

export const POST = withKbAuth(async (req, { supabase }) => {
  const body = await req.json().catch(() => ({}));
  const messages: { role: string; content: string }[] =
    Array.isArray(body.messages) && body.messages.length > 0
      ? body.messages
      : SAMPLE_CONVERSATION;
  const generateDraft = body.generate === true;

  const steps: Record<string, unknown> = {};

  // Step 1: Load compiled brief
  const { data: briefRow } = await supabase
    .from('kb_compiled_brief')
    .select('brief, token_count, updated_at')
    .eq('id', 'default')
    .single();

  const brief = briefRow?.brief?.trim() ?? '';
  steps['1_brief'] = {
    loaded: !!brief,
    token_count: briefRow?.token_count ?? 0,
    updated_at: briefRow?.updated_at,
    preview: brief ? brief.slice(0, 300) + (brief.length > 300 ? '…' : '') : '(пусто)',
  };

  // Step 2: Search relevant details
  const keywords = messages
    .slice(-4)
    .map(m => m.content)
    .join(' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 6);

  let detailsText = '';
  let searchResults: unknown[] = [];
  try {
    const { chunks } = await searchChunks(supabase, keywords.join(' '), { limit: 3 });
    searchResults = chunks.map(c => ({
      document_title: c.document_title,
      category: c.category,
      rank: c.rank,
      content_preview: c.content.slice(0, 200) + (c.content.length > 200 ? '…' : ''),
    }));
    detailsText = chunks.map(c => `[${c.document_title}]\n${c.content}`).join('\n\n');
  } catch (e) {
    steps['2_search_error'] = e instanceof Error ? e.message : String(e);
  }

  steps['2_search'] = {
    keywords_used: keywords,
    chunks_found: searchResults.length,
    results: searchResults,
    details_tokens: Math.ceil(detailsText.length / 4),
  };

  // Step 3: Build full prompt
  const parts: string[] = [];
  if (brief) parts.push(`## Общие знания о компании\n${brief}`);
  if (detailsText) parts.push(`## Детали по теме разговора\n${detailsText}`);
  const kbBlock = parts.length > 0
    ? `\n\n[БАЗА ЗНАНИЙ КОМПАНИИ]\n${parts.join('\n\n')}\n[/БАЗА ЗНАНИЙ КОМПАНИИ]`
    : '';

  const systemPrompt = (body.system_prompt || DEFAULT_REACTIVE_PROMPT) + kbBlock;

  steps['3_prompt'] = {
    system_prompt_tokens: Math.ceil(systemPrompt.length / 4),
    conversation_tokens: Math.ceil(messages.map(m => m.content).join('').length / 4),
    total_input_tokens: Math.ceil((systemPrompt.length + messages.map(m => m.content).join('').length) / 4),
    kb_overhead_tokens: Math.ceil(kbBlock.length / 4),
    full_system_prompt: systemPrompt,
  };

  // Step 4: Optionally generate draft
  if (generateDraft) {
    const apiKey = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
    if (!apiKey) {
      steps['4_draft'] = { error: 'OPENROUTER_TG_OUTREACH_API_KEY not set' };
    } else {
      try {
        const llmMessages = [
          { role: 'system', content: systemPrompt },
          ...messages,
        ];

        const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: body.model || 'openai/gpt-4o-mini',
            messages: llmMessages,
            max_tokens: 512,
          }),
        });

        const data = await res.json() as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };

        steps['4_draft'] = {
          generated_text: data.choices?.[0]?.message?.content?.trim() ?? null,
          usage: data.usage ?? null,
        };
      } catch (e) {
        steps['4_draft'] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  return NextResponse.json({
    test_conversation: messages,
    steps,
    summary: {
      brief_loaded: !!brief,
      details_found: searchResults.length,
      total_kb_tokens: Math.ceil(kbBlock.length / 4),
      ready: !!brief || searchResults.length > 0,
    },
  });
});
