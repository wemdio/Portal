export type BriefScoringCompany = {
  idx: number;
  data: Record<string, string>;
};

export type BriefScoringResult = {
  idx: number;
  score: number;
  reason: string;
};

type ScoreBriefCompaniesOptions = {
  apiKey: string;
  briefText: string;
  companies: BriefScoringCompany[];
  model?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export const DEFAULT_BRIEF_SCORING_MODEL = 'policy/gemini-flash';

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBriefScoringItem(item: Record<string, unknown>): BriefScoringResult {
  const idx = typeof item.idx === 'number' && Number.isFinite(item.idx) ? item.idx : 0;
  const scoreRaw = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
  const score = Math.max(0, Math.min(10, Math.round(scoreRaw)));
  const reason = typeof item.reason === 'string' ? item.reason : '';
  return { idx, score, reason };
}

function extractArrayCandidate(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;

  const objectValue = parsed as Record<string, unknown>;
  for (const key of Object.keys(objectValue)) {
    const value = objectValue[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

export function parseBriefScoringContent(content: string): BriefScoringResult[] {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Пустой ответ от AI');

  const tryParse = (raw: string): unknown => JSON.parse(raw);
  let parsed: unknown;
  try {
    parsed = tryParse(trimmed);
  } catch {
    const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('AI вернул некорректный JSON');
    }
    parsed = tryParse(jsonMatch[0]);
  }

  const arrayCandidate = extractArrayCandidate(parsed);
  if (!arrayCandidate) {
    throw new Error('AI вернул некорректный формат (ожидался массив)');
  }

  return arrayCandidate.map((item) => normalizeBriefScoringItem((item ?? {}) as Record<string, unknown>));
}

function buildUserMessage(briefText: string, companies: BriefScoringCompany[]): string {
  const companySummaries = companies
    .map((company) => {
      const fields = Object.entries(company.data)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      return `[Компания #${company.idx}]\n${fields}`;
    })
    .join('\n\n---\n\n');

  return `БРИФ ОТ ЗАКАЗЧИКА:
---
${briefText.slice(0, 8000)}
---

КОМПАНИИ ДЛЯ ОЦЕНКИ:
${companySummaries}

Оцени каждую компанию от 0 до 10. Верни JSON массив.`;
}

export async function scoreBriefCompanies(options: ScoreBriefCompaniesOptions): Promise<BriefScoringResult[]> {
  const {
    apiKey,
    briefText,
    companies,
    model = DEFAULT_BRIEF_SCORING_MODEL,
    maxRetries = 3,
    retryBaseDelayMs = 1500,
    fetchImpl = fetch,
    signal,
  } = options;

  if (!apiKey) throw new Error('OPENROUTER_BRIEF_API_KEY not configured on server');
  if (!briefText || typeof briefText !== 'string') throw new Error('Missing required field: briefText');
  if (!Array.isArray(companies) || companies.length === 0) {
    throw new Error('Missing required field: companies (non-empty array)');
  }

  const userMessage = buildUserMessage(briefText, companies);
  const shouldRetryStatus = (status: number) => [502, 503, 504].includes(status);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;

    try {
      response = await fetchImpl('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Brief Scoring',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.2,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        }),
        signal,
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(retryBaseDelayMs * Math.pow(2, attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : 'Network error';
      throw new Error(`Ошибка сети при обращении к AI: ${msg}`);
    }

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      return parseBriefScoringContent(content);
    }

    let errorMessage = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error?.message || errorMessage;
    } catch {
      // ignore parsing errors
    }

    if (shouldRetryStatus(response.status) && attempt < maxRetries) {
      await sleep(retryBaseDelayMs * Math.pow(2, attempt));
      continue;
    }

    throw new Error(errorMessage);
  }

  throw new Error('Не удалось получить ответ от AI после нескольких попыток');
}

