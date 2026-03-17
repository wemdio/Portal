import { fetchAndExtract } from '@/lib/enrich/websiteParser';

const OPENROUTER_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY || '';
const MODEL = 'policy/gemini-flash';

export interface DfybPlan {
  analysis: string;
  parsers: DfybParserConfig[];
  personalization_prompt: string;
  ta_brief: string;
}

export interface DfybParserConfig {
  type: 'search' | 'yandex_maps' | 'hh';
  queries?: string[];
  search_urls?: string[];
  hh_config?: { text: string; area?: number };
  expected_results: number;
}

function buildSystemPrompt(targetCount: number): string {
  const rawTarget = Math.ceil(targetCount * 2.5);
  return `Ты — AI-стратег по B2B лидогенерации.

ЗАДАЧА: По брифу компании-заказчика составить план сбора базы контактов (потенциальных клиентов заказчика).

ДОСТУПНЫЕ ПАРСЕРЫ:

1. search — Поисковый парсер (Google/DuckDuckGo).
   - Вход: массив поисковых запросов на русском
   - Выход: ~15-30 компаний на запрос (с расширением из каталогов — до 50)
   - Лучше для: B2B, конкретные отрасли, нишевые рынки
   - Запросы должны искать ЦЕЛЕВУЮ АУДИТОРИЮ заказчика (потенциальных клиентов), а НЕ конкурентов
   - Используй формулировки: "официальный сайт", "контакты", "email", роли ЛПР
   - Разрешены 1-2 "источниковых" запроса (каталоги/реестры)

2. yandex_maps — Парсер Яндекс Карт.
   - Вход: URL-ы поиска (формат: https://yandex.ru/maps/?text=запрос+город)
   - Выход: сотни организаций на запрос
   - Лучше для: локальный бизнес, HoReCa, медицина, ритейл, компании с офисами

3. hh — Парсер HeadHunter.
   - Вход: { "text": "запрос", "area": код_региона } (area=1 Москва, area=2 СПб, без area = вся Россия)
   - Выход: компании с активными вакансиями (индикатор роста)
   - Лучше для: IT, растущие бизнесы

ЦЕЛЕВОЕ КОЛИЧЕСТВО КОНТАКТОВ: ${targetCount}
НЕОБХОДИМО СОБРАТЬ (с запасом на фильтрацию): ~${rawTarget}

ПРАВИЛА:
1. Для search: генерируй от 8 до 30 запросов (чем больше целевое количество — тем больше запросов)
2. Для yandex_maps: генерируй URL-ы в формате https://yandex.ru/maps/?text=...
3. Можно использовать 1-3 парсера в комбинации
4. expected_results — твоя оценка количества контактов от каждого парсера
5. Сумма expected_results должна быть >= ${rawTarget}
6. personalization_prompt: напиши инструкцию для персонализации email-писем от лица компании-заказчика (что писать, в каком стиле)
7. ta_brief: уточни и дополни бриф для оценки ЦА — кто является ИДЕАЛЬНЫМ клиентом заказчика

ФОРМАТ ОТВЕТА — только JSON, без markdown:
{
  "analysis": "краткий анализ: кто заказчик, кто ЦА, стратегия сбора",
  "parsers": [
    { "type": "search", "queries": ["q1", "q2", ...], "expected_results": N },
    { "type": "yandex_maps", "search_urls": ["url1"], "expected_results": N }
  ],
  "personalization_prompt": "инструкция для персонализации...",
  "ta_brief": "уточненный бриф для оценки ЦА..."
}`;
}

export async function generateDfybPlan(
  brief: string,
  companyUrl: string | null,
  targetCount: number,
): Promise<DfybPlan> {
  let companyContext = '';
  if (companyUrl) {
    try {
      companyContext = (await fetchAndExtract(companyUrl)) || '';
    } catch {
      // website fetch failed — proceed without context
    }
  }

  const userMessage = [
    `Бриф клиента:\n${brief.slice(0, 6000)}`,
    companyContext ? `\nТекст с сайта клиента (${companyUrl}):\n${companyContext.slice(0, 4000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - DFYB Planner',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(targetCount) },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.5,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content || '';
    const plan: DfybPlan = JSON.parse(content);

    if (!plan.parsers?.length) throw new Error('Plan has no parsers');
    if (!plan.ta_brief) plan.ta_brief = brief;
    if (!plan.personalization_prompt) {
      plan.personalization_prompt = 'Напиши короткий персонализированный комплимент компании на основе их деятельности.';
    }

    return plan;
  } finally {
    clearTimeout(timeout);
  }
}
