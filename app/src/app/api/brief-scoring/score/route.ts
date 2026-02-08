import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const OPENROUTER_MODEL = 'google/gemini-3-flash-preview';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const SYSTEM_PROMPT = `Ты — эксперт по B2B лидогенерации и квалификации компаний для email-аутрича.

ЗАДАЧА:
Оценить релевантность каждой компании как потенциального клиента (целевой аудитории) для email-аутрича на основе брифа от заказчика.

ПРАВИЛА ОЦЕНКИ (0-10 баллов):
- 9-10: Идеальное совпадение — компания полностью соответствует описанию ЦА из брифа (отрасль, размер, потребности, география — всё совпадает)
- 7-8: Сильное совпадение — большинство критериев из брифа выполнены
- 5-6: Среднее совпадение — часть критериев совпадает, но есть существенные несоответствия
- 3-4: Слабое совпадение — мало пересечений с критериями из брифа
- 1-2: Очень слабое совпадение — почти ничего общего
- 0: Полное несовпадение или данных недостаточно для оценки

БУДЬ СТРОГИМ И ОБЪЕКТИВНЫМ:
- Не завышай оценки. Большинство компаний в типичной базе — 3-6 баллов.
- Оценка 9-10 только если компания ИДЕАЛЬНО подходит.
- Учитывай ВСЕ доступные данные о компании (название, описание, отрасль, сайт, вакансии и т.д.)
- Если данных о компании мало — ставь оценку ниже (максимум 5 при недостатке информации)

ФОРМАТ ОТВЕТА:
Верни ТОЛЬКО валидный JSON массив. Никакого текста до или после.
Каждый элемент: {"idx": <индекс компании из запроса>, "score": <0-10>, "reason": "<краткое обоснование на русском, 1 предложение>"}`;

type CompanyRow = {
  idx: number;
  data: Record<string, string>;
};

type RequestBody = {
  briefText: string;
  companies: CompanyRow[];
};

type ScoringResult = {
  idx: number;
  score: number;
  reason: string;
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

export async function POST(req: NextRequest) {
  // --- Auth ---
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  // --- Check API key ---
  if (!OPENROUTER_BRIEF_API_KEY) {
    return jsonError('OPENROUTER_BRIEF_API_KEY not configured on server', 500);
  }

  // --- Parse body ---
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { briefText, companies } = body;
  if (!briefText || typeof briefText !== 'string') {
    return jsonError('Missing required field: briefText', 400);
  }
  if (!Array.isArray(companies) || companies.length === 0) {
    return jsonError('Missing required field: companies (non-empty array)', 400);
  }

  // --- Build company descriptions ---
  const companySummaries = companies.map((c) => {
    const fields = Object.entries(c.data)
      .filter(([, v]) => v && v.trim().length > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    return `[Компания #${c.idx}]\n${fields}`;
  }).join('\n\n---\n\n');

  const userMessage = `БРИФ ОТ ЗАКАЗЧИКА:
---
${briefText.slice(0, 8000)}
---

КОМПАНИИ ДЛЯ ОЦЕНКИ:
${companySummaries}

Оцени каждую компанию от 0 до 10. Верни JSON массив.`;

  // --- Call OpenRouter with retries ---
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;

    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_BRIEF_API_KEY}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Brief Scoring',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.2,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        }),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : 'Network error';
      return jsonError(`Ошибка сети при обращении к AI: ${msg}`, 502);
    }

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';

      if (!content) {
        return jsonError('Пустой ответ от AI', 502);
      }

      // Parse the JSON response
      try {
        let parsed = JSON.parse(content);

        // Handle cases where AI wraps array in an object
        if (parsed && !Array.isArray(parsed)) {
          const keys = Object.keys(parsed);
          for (const key of keys) {
            if (Array.isArray(parsed[key])) {
              parsed = parsed[key];
              break;
            }
          }
        }

        if (!Array.isArray(parsed)) {
          return jsonError('AI вернул некорректный формат (ожидался массив)', 502);
        }

        const scores: ScoringResult[] = parsed.map((item: Record<string, unknown>) => ({
          idx: typeof item.idx === 'number' ? item.idx : 0,
          score: Math.max(0, Math.min(10, typeof item.score === 'number' ? Math.round(item.score) : 0)),
          reason: typeof item.reason === 'string' ? item.reason : '',
        }));

        return NextResponse.json({ scores });
      } catch {
        // If JSON parsing fails, try to extract JSON from text
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const arr = JSON.parse(jsonMatch[0]);
            const scores: ScoringResult[] = arr.map((item: Record<string, unknown>) => ({
              idx: typeof item.idx === 'number' ? item.idx : 0,
              score: Math.max(0, Math.min(10, typeof item.score === 'number' ? Math.round(item.score) : 0)),
              reason: typeof item.reason === 'string' ? item.reason : '',
            }));
            return NextResponse.json({ scores });
          } catch {
            return jsonError('Не удалось распарсить ответ AI', 502);
          }
        }
        return jsonError('AI вернул некорректный JSON', 502);
      }
    }

    const shouldRetry = [429, 502, 503, 504].includes(response.status);
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
