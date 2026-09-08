import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { generatePersonalizationCompletion, PersonalizationCancelledError, PersonalizationError } from '@/lib/tools/personalizationCompletion';

export const dynamic = 'force-dynamic';

const OPENROUTER_PERSONALIZATION_API_KEY =
  process.env.OPENROUTER_PERSONALIZATION_API_KEY ?? process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const OPENROUTER_MODEL = 'policy/gemini-flash';

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

  try {
    const proposal = await generatePersonalizationCompletion({
      apiKey: OPENROUTER_PERSONALIZATION_API_KEY,
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      title: 'Portal - Database Personalization',
      signal: req.signal,
    });
    return NextResponse.json({ proposal });
  } catch (error) {
    const message = error instanceof PersonalizationError || error instanceof PersonalizationCancelledError
      ? error.message : 'Не удалось получить персонализацию. Повторите генерацию этой строки';
    const status = error instanceof PersonalizationError ? error.status
      : error instanceof PersonalizationCancelledError ? 499 : 502;
    // The server already exhausted its bounded retries. The browser must not
    // repeat another full four-attempt cycle for this same failed row.
    return NextResponse.json({ error: message, retryable: false }, { status });
  }
}
