import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const OPENROUTER_MODEL = 'google/gemini-2.5-pro';

const META_PROMPT = `Ты — эксперт по настройке AI-ассистентов для телефонных звонков.

ЗАДАЧА:
На основе предоставленного брифа компании-клиента создай системный промпт для AI-ассистента, который будет совершать исходящие звонки от имени этой компании.

ТРЕБОВАНИЯ К ПРОМПТУ:
1. Определи имя персоны (женское имя, типичное для менеджера по продажам)
2. Промпт должен быть на русском языке
3. Укажи цель звонка (фоллоу-ап по email, холодный обзвон, и т.д.)
4. Опиши стиль общения: профессиональный, вежливый, без навязчивости
5. Включи ключевые аргументы и преимущества компании из брифа
6. Добавь сценарий разговора: приветствие → уточнение → предложение → следующий шаг
7. Укажи что делать при отказе (вежливо попрощаться)
8. Фразы должны быть КОРОТКИЕ (1-2 предложения за раз)
9. НИКАКИХ длинных монологов — это телефонный разговор
10. Добавь правила: не повторять информацию, не спорить, не давить

ФОРМАТ ОТВЕТА — верни JSON:
{
  "personaName": "Имя ассистента",
  "systemPrompt": "Полный системный промпт...",
  "firstMessage": "Первая фраза при звонке...",
  "companyName": "Название компании клиента"
}

Верни ТОЛЬКО валидный JSON. Никакого текста до или после.`;

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!OPENROUTER_API_KEY) {
    return NextResponse.json(
      { error: 'OPENROUTER_BRIEF_API_KEY не настроен' },
      { status: 500 },
    );
  }

  // Parse multipart form data
  let briefText = '';
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const text = formData.get('text') as string | null;

    if (file) {
      const buffer = Buffer.from(await file.arrayBuffer());

      if (file.name.endsWith('.pdf')) {
        // pdf-parse v2 API
        if (!globalThis.DOMMatrix) {
          const { default: DOMMatrix } = await import('@thednp/dommatrix');
          globalThis.DOMMatrix = DOMMatrix as unknown as typeof globalThis.DOMMatrix;
        }
        const { PDFParse } = await import('pdf-parse');
        const { getData } = await import('pdf-parse/worker');
        PDFParse.setWorker(getData());
        const parser = new PDFParse({ data: buffer });
        try {
          const result = await parser.getText();
          briefText = result.text?.trim() ?? '';
        } finally {
          await parser.destroy().catch(() => undefined);
        }
      } else if (file.name.endsWith('.txt') || file.name.endsWith('.md')) {
        briefText = buffer.toString('utf-8');
      } else {
        // Try to read as text
        briefText = buffer.toString('utf-8');
      }
    } else if (text) {
      briefText = text;
    }
  } catch {
    return NextResponse.json({ error: 'Не удалось прочитать файл' }, { status: 400 });
  }

  if (!briefText.trim()) {
    return NextResponse.json(
      { error: 'Бриф пустой. Загрузите PDF/TXT файл или введите текст.' },
      { status: 400 },
    );
  }

  // Generate prompt via AI
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - AI Caller Brief',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: META_PROMPT },
          {
            role: 'user',
            content: `БРИФ КОМПАНИИ:\n---\n${briefText.slice(0, 12000)}\n---\n\nСоздай системный промпт для AI-ассистента на основе этого брифа.`,
          },
        ],
        temperature: 0.4,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return NextResponse.json(
        { error: `AI API error: ${response.status} ${errText}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';

    if (!content) {
      return NextResponse.json({ error: 'Пустой ответ от AI' }, { status: 502 });
    }

    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Try to extract JSON from text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return NextResponse.json({ error: 'AI вернул некорректный JSON' }, { status: 502 });
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    return NextResponse.json({
      personaName: parsed.personaName || 'Евгения',
      systemPrompt: parsed.systemPrompt || '',
      firstMessage: parsed.firstMessage || '',
      companyName: parsed.companyName || '',
      briefText: briefText.slice(0, 5000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Ошибка генерации промпта: ${msg}` }, { status: 502 });
  }
}
