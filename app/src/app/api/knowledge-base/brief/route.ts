import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';

export const GET = withKbAuth(async (_req, { supabase }) => {
  const { data, error } = await supabase
    .from('kb_compiled_brief')
    .select('brief, token_count, updated_at')
    .eq('id', 'default')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? { brief: '', token_count: 0, updated_at: null });
});

export const PUT = withKbAuth(async (req, { supabase }) => {
  const { brief } = (await req.json()) as { brief: string };
  const tokenCount = Math.ceil((brief ?? '').length / 4);

  const { error } = await supabase
    .from('kb_compiled_brief')
    .upsert({
      id: 'default',
      brief: brief ?? '',
      token_count: tokenCount,
      updated_at: new Date().toISOString(),
    });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, token_count: tokenCount });
});

export const POST = withKbAuth(async (_req, { supabase }) => {
  const { data: docs } = await supabase
    .from('kb_documents')
    .select('title, category, content_text, token_count')
    .eq('status', 'ready')
    .order('token_count', { ascending: true })
    .limit(100);

  if (!docs || docs.length === 0) {
    return NextResponse.json({ error: 'No documents in knowledge base' }, { status: 400 });
  }

  const categoryOrder = ['product_info', 'sales_script', 'faq', 'chat_export', 'transcript', 'other'];
  docs.sort((a, b) => {
    const ai = categoryOrder.indexOf(a.category);
    const bi = categoryOrder.indexOf(b.category);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const maxInput = 30_000;
  let inputChars = 0;
  const snippets: string[] = [];
  for (const doc of docs) {
    const text = doc.content_text?.trim();
    if (!text) continue;
    const available = maxInput - inputChars;
    if (available <= 100) break;
    const snip = text.length > available ? text.slice(0, available) : text;
    snippets.push(`[${doc.title} | ${doc.category}]\n${snip}`);
    inputChars += snip.length;
  }

  const apiKey = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'LLM API key not configured' }, { status: 500 });

  const systemPrompt = `Ты — аналитик. Тебе даны документы из базы знаний компании: описания продукта, скрипты продаж, FAQ, переписки менеджеров, расшифровки встреч.

Задача: составь краткую ВЫЖИМКУ (бриф) для AI-помощника по продажам.

Бриф должен содержать:
1. Что за компания и чем занимается (2-3 предложения)
2. Ключевые продукты/услуги и их преимущества
3. Целевая аудитория
4. Стиль общения менеджеров (формальный/неформальный, особенности)
5. Частые возражения клиентов и как на них отвечать
6. Ключевые факты: цены, сроки, условия (если есть)

Формат: сжатый текст, без воды. Максимум 800 слов.
Пиши на русском.`;

  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-20250514',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: snippets.join('\n\n---\n\n') },
      ],
      max_tokens: 1500,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `LLM error: ${text.slice(0, 200)}` }, { status: 502 });
  }

  const llmData = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const brief = llmData.choices?.[0]?.message?.content?.trim() ?? '';

  if (!brief) return NextResponse.json({ error: 'LLM returned empty response' }, { status: 502 });

  const tokenCount = Math.ceil(brief.length / 4);

  const { error: upsertErr } = await supabase
    .from('kb_compiled_brief')
    .upsert({
      id: 'default',
      brief,
      token_count: tokenCount,
      updated_at: new Date().toISOString(),
    });

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });

  return NextResponse.json({ brief, token_count: tokenCount });
});
