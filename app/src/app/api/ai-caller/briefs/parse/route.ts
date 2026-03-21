import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPENROUTER_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const OPENROUTER_MODEL = 'policy/gemini-flash';

import {
  VOICEMAIL_DETECTION_BLOCK,
  CAMPAIGN_PRESETS,
  fillTemplate,
  getPresetTemplatesForProvider,
} from '@/lib/ai-caller-prompts';

const META_PROMPT = `Ты — эксперт по настройке AI-ассистентов для телефонных звонков.

ЗАДАЧА:
На основе предоставленного брифа компании-клиента создай системный промпт для AI-ассистента, который будет совершать исходящие звонки от имени этой компании.

ИЗВЛЕЧЕНИЕ ДАННЫХ ИЗ БРИФА (КРИТИЧЕСКИ ВАЖНО):
- Найди в брифе раздел "ОТ ЧЬЕГО ЛИЦА ВЕДЕМ ДИАЛОГ" или аналогичный — используй ОДНО из указанных имён (первое подходящее). Если указано несколько, выбери первое.
- Если в брифе НЕ указаны имена — используй имя "Евгения".
- Найди название компании (раздел "ОПИСАНИЕ КОМПАНИИ", сайт, домен, или другое упоминание). Используй ТОЧНОЕ название из брифа, НЕ придумывай.
- НЕ ВЫДУМЫВАЙ имена и названия компаний. Бери ТОЛЬКО из брифа.

ТРЕБОВАНИЯ К ПРОМПТУ:
1. Промпт должен быть на русском языке
2. Укажи цель звонка (фоллоу-ап по email, холодный обзвон, и т.д.)
3. Опиши стиль общения: профессиональный, вежливый, без навязчивости
4. Включи ключевые аргументы и преимущества компании из брифа
5. Добавь сценарий разговора: приветствие → уточнение → предложение → следующий шаг
6. Укажи что делать при отказе (вежливо попрощаться)
7. Фразы должны быть КОРОТКИЕ (1-2 предложения за раз)
8. НИКАКИХ длинных монологов — это телефонный разговор
9. Добавь правила: не повторять информацию, не спорить, не давить
10. ОБЯЗАТЕЛЬНО включи в конце промпта следующий блок (дословно):
${VOICEMAIL_DETECTION_BLOCK}

ФОРМАТ ОТВЕТА — верни JSON:
{
  "personaName": "Имя ассистента (из брифа, НЕ выдуманное)",
  "systemPrompt": "Полный системный промпт...",
  "firstMessage": "Первая фраза при звонке...",
  "companyName": "Название компании из брифа (НЕ выдуманное)"
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

function normalizeExtractedBriefText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default;
  const result = await pdfParse(buffer);
  return normalizeExtractedBriefText(result.text?.trim() ?? '');
}

async function extractTextFromDocxBuffer(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return normalizeExtractedBriefText(result.value ?? '');
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
    const contentType = req.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = await req.json();
      briefText = (body.text as string) ?? '';
      presetId = (body.presetId as string) ?? '';
      const fileName = String(body.fileName ?? '').toLowerCase();

      if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        return NextResponse.json(
          { error: 'DOCX/DOC нужно загружать файлом. Обновите страницу и попробуйте снова.' },
          { status: 400 },
        );
      }

      if (fileName.endsWith('.pdf') && briefText) {
        briefText = briefText.replace(/[^\x20-\x7EА-Яа-яЁё\s]/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } else {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const text = formData.get('text') as string | null;
      presetId = (formData.get('presetId') as string | null) ?? '';

      if (file) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const lowerFileName = file.name.toLowerCase();

        if (lowerFileName.endsWith('.pdf')) {
          briefText = await extractTextFromPdfBuffer(buffer);
        } else if (lowerFileName.endsWith('.docx')) {
          briefText = await extractTextFromDocxBuffer(buffer);
        } else if (lowerFileName.endsWith('.doc')) {
          return NextResponse.json(
            { error: 'Формат .doc пока не поддерживается. Сохраните файл как .docx, .pdf или .txt.' },
            { status: 400 },
          );
        } else {
          briefText = normalizeExtractedBriefText(buffer.toString('utf-8'));
        }
      } else if (text) {
        briefText = text;
      }
    }
  } catch (err) {
    console.error('[briefs/parse] file read error:', err);
    return NextResponse.json({ error: 'Не удалось прочитать файл' }, { status: 400 });
  }

  console.log('[briefs/parse] extracted text length:', briefText.length, '| first 200 chars:', briefText.slice(0, 200));

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

КРИТИЧЕСКИ ВАЖНО — извлекай данные ТОЛЬКО из брифа, НЕ выдумывай:
- Найди раздел "ОТ ЧЬЕГО ЛИЦА ВЕДЕМ ДИАЛОГ" или аналогичный — используй ОДНО из указанных имён (первое подходящее). Если имён нет — используй "Евгения".
- Найди название компании (раздел "ОПИСАНИЕ КОМПАНИИ", сайт, домен). Используй ТОЧНОЕ название из брифа.

На основе брифа компании извлеки следующую информацию и верни JSON:
{
  "persona_name": "Имя менеджера ИЗ БРИФА (раздел 'от чьего лица', первое подходящее имя), НЕ выдуманное",
  "company_from": "Название компании-отправителя ИЗ БРИФА, НЕ выдуманное",
  "offer_summary": "Одно очень короткое предложение для озвучки по телефону (до 12 слов, только русский язык, без английских слов, без цифр, без спецсимволов)",
  "companyName": "Название компании-отправителя ИЗ БРИФА"
}

Верни ТОЛЬКО валидный JSON. Никакого текста до или после.`
    : null;

  // Generate prompt via AI
  try {
    const response = await fetch('https://router.requesty.ai/v1/chat/completions', {
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
        temperature: 0.2,
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

    console.log('[briefs/parse] AI extracted:', JSON.stringify(parsed).slice(0, 500));

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
