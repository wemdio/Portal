import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_PERSONALIZATION_API_KEY =
  process.env.OPENROUTER_PERSONALIZATION_API_KEY ?? process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const OPENROUTER_MODEL = 'policy/gemini-flash';
const OPENROUTER_TIMEOUT_MS = 70_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1200;

const SYSTEM_PROMPT = `Ты - помощник для персонализации холодного email-аутрича в B2B.

КЛЮЧЕВАЯ ЗАДАЧА:
- Генерируй короткие персонализированные фразы для email-аутрича на основе ДАННЫХ ИЗ СТОЛБЦА и промпта пользователя.

КРИТИЧЕСКИ ВАЖНО:
1. Используй ТОЛЬКО факты из входных данных. НИЧЕГО не выдумывай.
2. Не добавляй названия компаний, имена, цифры, кейсы, сроки, технологии, если их нет в данных.
3. Если данных мало - пиши нейтрально и обобщенно, без уточнений.
4. Не добавляй приветствия, подписи, темы письма и служебные фразы.

СТИЛЬ:
- Пиши как живой человек, без канцелярита и шаблонов
- СТРОГО соблюдай русскую грамматику, падежи и склонения
- Используй ТОЛЬКО дефис "-", НИКОГДА не используй длинное тире "—"
- 1-3 коротких предложения, конкретно по делу
- Не используй восклицательные знаки в избытке
- Избегай слов: "уникальный", "эксклюзивный", "лучший", "инновационный"
- Фокусируйся на выгоде/ценности для клиента

Ответ: только текст персонализации, без пояснений и нумерации.`;

type RequestBody = {
  sourceData: string;
  userPrompt: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!OPENROUTER_PERSONALIZATION_API_KEY) {
    return jsonError('OPENROUTER_PERSONALIZATION_API_KEY not configured on server', 500);
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const sourceData = typeof body.sourceData === 'string' ? body.sourceData.trim() : '';
  const userPrompt = typeof body.userPrompt === 'string' ? body.userPrompt.trim() : '';

  if (!sourceData) return jsonError('Missing required field: sourceData', 400);
  if (!userPrompt) return jsonError('Missing required field: userPrompt', 400);

  const userMessage = `Данные для персонализации: "${sourceData.slice(0, 4000)}"

Задача от пользователя: ${userPrompt.slice(0, 3000)}

Сгенерируй 1 персонализированное предложение.
Не нумеруй варианты. Пиши только сами предложения без пояснений.`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response: Response;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
      response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_PERSONALIZATION_API_KEY}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Database Personalization',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.7,
          max_tokens: 500,
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
          continue;
        }
        return jsonError('Превышено время ожидания ответа от AI', 504);
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : 'Network error';
      return jsonError(`Ошибка сети при обращении к AI: ${msg}`, 502);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (response.ok) {
      const data = await response.json();
      const proposal = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (!proposal) return jsonError('Пустой ответ от AI', 502);
      return NextResponse.json({ proposal });
    }

    const shouldRetry = [500, 502, 503, 504].includes(response.status);
    if (shouldRetry && attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
      continue;
    }

    let errorMessage = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error?.message || errorMessage;
    } catch {
      // ignore
    }
    return jsonError(errorMessage, response.status >= 500 ? 502 : response.status);
  }

  return jsonError('Не удалось получить ответ от AI после нескольких попыток', 502);
}
