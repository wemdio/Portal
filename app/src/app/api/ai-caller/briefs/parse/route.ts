import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { inflateSync } from 'zlib';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPENROUTER_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const OPENROUTER_MODEL = 'google/gemini-2.5-pro';

import {
  VOICEMAIL_DETECTION_BLOCK,
  CAMPAIGN_PRESETS,
  fillTemplate,
  getPresetTemplatesForProvider,
} from '@/lib/ai-caller-prompts';

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
11. ОБЯЗАТЕЛЬНО включи в конце промпта следующий блок (дословно):
${VOICEMAIL_DETECTION_BLOCK}

ФОРМАТ ОТВЕТА — верни JSON:
{
  "personaName": "Имя ассистента",
  "systemPrompt": "Полный системный промпт...",
  "firstMessage": "Первая фраза при звонке...",
  "companyName": "Название компании клиента"
}

Верни ТОЛЬКО валидный JSON. Никакого текста до или после.`;

function sanitizeOfferSummaryForSpeech(raw: string): string {
  const fallback = 'мы отправляли короткое предложение по сотрудничеству';
  if (!raw || !raw.trim()) return fallback;

  let text = raw;
  const replacements: Array<[RegExp, string]> = [
    [/\be-?mail\b/gi, 'почта'],
    [/\bcrm\b/gi, 'система работы с клиентами'],
    [/\bsaas\b/gi, 'онлайн сервис'],
    [/\bapi\b/gi, 'интеграция'],
    [/\bkpi\b/gi, 'показатели'],
    [/\broi\b/gi, 'окупаемость'],
    [/\berp\b/gi, 'учетная система'],
  ];
  for (const [pattern, value] of replacements) {
    text = text.replace(pattern, value);
  }

  text = text
    .replace(/[^А-Яа-яЁё\s,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const firstSentence = text.split(/[.!?]/)[0]?.trim() ?? '';
  const compact = (firstSentence || text).replace(/\s+/g, ' ').trim();
  const short = compact.slice(0, 120).trim().replace(/[,. -]+$/g, '');

  return short || fallback;
}

function sanitizeCompanyForSpeech(raw: string): string {
  if (!raw || !raw.trim()) return '';
  const translit: Array<[RegExp, string]> = [
    [/\bonline\b/gi, 'онлайн'],
    [/\bagency\b/gi, 'эйдженси'],
    [/\bgroup\b/gi, 'групп'],
    [/\btech\b/gi, 'тех'],
    [/\bdigital\b/gi, 'диджитал'],
    [/\bsolutions\b/gi, 'солюшнс'],
  ];

  let text = raw;
  for (const [pattern, value] of translit) {
    text = text.replace(pattern, value);
  }

  text = text
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^A-Za-zА-Яа-яЁё0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function extractTextFromPdfBuffer(buffer: Buffer): string {
  const binary = buffer.toString('binary');
  const textParts: string[] = [];

  const decodePdfString = (s: string) =>
    s
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\([()])/g, '$1');

  const extractTjText = (content: string) => {
    const tj = /\(([^)]*)\)\s*Tj/g;
    let m: RegExpExecArray | null;
    while ((m = tj.exec(content)) !== null) textParts.push(decodePdfString(m[1]));

    const tjArr = /\[([^\]]+)\]\s*TJ/gi;
    while ((m = tjArr.exec(content)) !== null) {
      const inner = /\(([^)]*)\)/g;
      let im: RegExpExecArray | null;
      while ((im = inner.exec(m[1])) !== null) textParts.push(decodePdfString(im[1]));
    }
  };

  // Decompress FlateDecode streams and extract text operators
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm: RegExpExecArray | null;
  while ((sm = streamRe.exec(binary)) !== null) {
    try {
      const decompressed = inflateSync(Buffer.from(sm[1], 'binary')).toString('utf-8');
      extractTjText(decompressed);
    } catch {
      extractTjText(sm[1]);
    }
  }

  extractTjText(binary);

  return textParts.join(' ').replace(/\s+/g, ' ').trim();
}

export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('[briefs/parse] unhandled error:', err);
    return NextResponse.json({ error: `Ошибка сервера: ${msg}` }, { status: 500 });
  }
}

async function handlePost(req: NextRequest) {
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

  const provider = resolveAiCallerProvider(req);

  let briefText = '';
  let presetId = '';
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const text = formData.get('text') as string | null;
    presetId = (formData.get('presetId') as string | null) ?? '';

    if (file) {
      const buffer = Buffer.from(await file.arrayBuffer());

      if (file.name.toLowerCase().endsWith('.pdf')) {
        briefText = extractTextFromPdfBuffer(buffer);
        if (!briefText || briefText.length < 20) {
          // Fallback: strip non-printable chars from raw binary
          const raw = buffer.toString('utf-8');
          briefText = raw.replace(/[^\x20-\x7EА-Яа-яЁё\s]/g, ' ').replace(/\s+/g, ' ').trim();
        }
      } else {
        briefText = buffer.toString('utf-8');
      }
    } else if (text) {
      briefText = text;
    }
  } catch (err) {
    console.error('[briefs/parse] file read error:', err);
    return NextResponse.json({ error: 'Не удалось прочитать файл' }, { status: 400 });
  }

  if (!briefText.trim()) {
    return NextResponse.json(
      { error: 'Бриф пустой. Загрузите PDF/TXT файл или введите текст.' },
      { status: 400 },
    );
  }

  const preset = presetId ? CAMPAIGN_PRESETS.find((p) => p.id === presetId) : null;

  // If preset provided, use AI to extract variables from brief, then fill template
  const presetMetaPrompt = preset
    ? `Ты — эксперт по настройке AI-ассистентов для телефонных звонков.

На основе брифа компании извлеки следующую информацию и верни JSON:
{
  "persona_name": "Женское имя менеджера (придумай подходящее, типичное для менеджера по продажам)",
  "company_from": "Название компании-отправителя (от чьего имени звоним)",
  "offer_summary": "Одно очень короткое предложение для озвучки по телефону (до 12 слов, только русский язык, без английских слов, без цифр, без спецсимволов)",
  "companyName": "Название компании-отправителя"
}

Верни ТОЛЬКО валидный JSON. Никакого текста до или после.`
    : null;

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
          { role: 'system', content: presetMetaPrompt ?? META_PROMPT },
          {
            role: 'user',
            content: `БРИФ КОМПАНИИ:\n---\n${briefText.slice(0, 12000)}\n---\n\n${
              preset
                ? 'Извлеки информацию из этого брифа.'
                : 'Создай системный промпт для AI-ассистента на основе этого брифа.'
            }`,
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
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return NextResponse.json({ error: 'AI вернул некорректный JSON' }, { status: 502 });
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (preset) {
      const templates = getPresetTemplatesForProvider(preset, provider);
      const offerSummary = sanitizeOfferSummaryForSpeech(parsed.offer_summary || '');
      const companyFromRaw = parsed.company_from || parsed.companyName || '';
      const companyFromSpeech = sanitizeCompanyForSpeech(companyFromRaw);
      const vars: Record<string, string> = {
        persona_name: parsed.persona_name || 'Евгения',
        company_from: companyFromSpeech || companyFromRaw,
        offer_summary: offerSummary,
        contact_name: '{{contact_name}}',
        company_name: '{{company_name}}',
        contact_greeting: '{{contact_greeting}}',
        email: '{{email}}',
      };

      return NextResponse.json({
        personaName: vars.persona_name,
        systemPrompt: fillTemplate(templates.promptTemplate, vars),
        firstMessage: fillTemplate(templates.firstMessageTemplate, vars),
        companyName: companyFromRaw,
        briefText: briefText.slice(0, 5000),
        presetId: preset.id,
      });
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
