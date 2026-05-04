import { callOpenRouterChat } from '@/lib/openrouter/client';

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
    // Try extracting from markdown code block
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cleaned = codeBlock ? codeBlock[1].trim() : trimmed;
    try {
      parsed = tryParse(cleaned);
    } catch {
      // Try finding JSON array anywhere in the text
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Last resort: try finding JSON object with array inside
        const objMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!objMatch) {
          throw new Error('AI вернул некорректный JSON');
        }
        parsed = tryParse(objMatch[0]);
      } else {
        parsed = tryParse(jsonMatch[0]);
      }
    }
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
    fetchImpl,
    signal,
  } = options;

  if (!apiKey) throw new Error('OPENROUTER_BRIEF_API_KEY not configured on server');
  if (!briefText || typeof briefText !== 'string') throw new Error('Missing required field: briefText');
  if (!Array.isArray(companies) || companies.length === 0) {
    throw new Error('Missing required field: companies (non-empty array)');
  }

  const userMessage = buildUserMessage(briefText, companies);

  const content = await callOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.2,
    maxTokens: 4000,
    responseFormat: { type: 'json_object' },
    signal,
    fetchImpl,
    maxRetries,
    retryBaseDelayMs,
    title: 'Portal - Brief Scoring',
  });

  return parseBriefScoringContent(content);
}

