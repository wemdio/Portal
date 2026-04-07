import type { RawSignalItem, EnrichedLead } from './types';

const LLM_URL = 'https://router.requesty.ai/v1/chat/completions';
const MODEL = 'policy/gemini-flash';
const CHUNK_SIZE = 15;

function getApiKey(): string {
  return (
    process.env.OPENROUTER_BUGOR_API_KEY ??
    process.env.OPENROUTER_BRIEF_API_KEY ??
    ''
  ).trim();
}

const SYSTEM_PROMPT = `Ты эксперт по signal-based продажам для B2B аутрич-агентства в России.
Агентство продаёт услугу холодного email-аутрича российским B2B-компаниям.

Ты получаешь сырые сигналы: новости, вакансии, статьи. Для каждого:
1. Определи — это российская B2B-компания, которая МОЖЕТ БЫТЬ КЛИЕНТОМ аутрич-агентства?
2. Если НЕ подходит — пропусти (см. HARD SKIP).
3. Для подходящих — извлеки структурированные данные.

=== ИДЕАЛЬНЫЙ КЛИЕНТ (ICP) ===

- Российская B2B-компания (или работающая на российском рынке)
- 5-200 человек
- Продают другим бизнесам (не физлицам)
- НЕ имеют развитого отдела продаж или нуждаются в дополнительном pipeline
- Ниши: SaaS, IT-услуги, маркетинг, HR Tech, Fintech, EdTech, логистика, производство (B2B)

=== HARD SKIP (всегда исключай) ===

- Госкомпании, госкорпорации (Ростех, Сбер, ВТБ, Газпром, РЖД, etc.)
- Крупный бизнес (500+ человек, выручка 10+ млрд руб)
- Розница (B2C магазины, рестораны, салоны красоты)
- Криптовалюты, гемблинг, микрозаймы
- Не-российские компании без российского офиса
- Новости без конкретной компании (аналитика рынка, обзоры)

=== СИГНАЛЬНАЯ ТАКСОНОМИЯ ===

TIER 1 — Высший приоритет:
- Компания нанимает менеджеров по продажам / SDR / BDR → нужен pipeline прямо сейчас
- Компания нанимает руководителя отдела продаж / коммерческого директора → строят продажи с нуля
- Привлечение инвестиций (seed, раунд A) + нет отдела продаж → деньги есть, продажи нужны

TIER 2 — Сильный сигнал:
- Наём маркетолога / Head of Marketing → инвестируют в рост
- Запуск нового продукта / направления → нужны первые клиенты
- Расширение на новый рынок / регион → нужны лиды в новой гео
- Рост выручки / milestone → готовы масштабировать

TIER 3 — Умеренный:
- Публикация на Habr (B2B компания активна в маркетинге) → в режиме роста
- Партнёрство / интеграция → расширение каналов
- Награда / рейтинг → momentum

=== СКОРИНГ (0-200) ===

Базовые баллы:
- Наём продажников = 130-170 (ЛУЧШИЙ лид)
- Наём руководителя продаж = 120-160
- Инвестиции seed/A = 100-140
- Наём маркетолога = 90-120
- Запуск продукта = 70-100
- Рост/расширение = 60-90
- Публикация Habr = 40-70

Бонус за размер (МЕНЬШЕ = ЛУЧШЕ):
- <20 человек: +20
- 20-50 человек: +10
- 50-100: +0
- 100-200: -20
- 200+: SKIP

Мульти-сигнал: 2+ сигнала = +30-50 бонус.

Приоритет: RED_HOT (140+) | HOT (90-139) | WARM (50-89)

=== OUTREACH ANGLE (на русском) ===

По сигналу:
- Наём продажников: "Видим, что вы ищете [роль]. Пока позиция открыта — мы можем запустить outbound от вашего имени, чтобы pipeline был готов к приходу нового менеджера."
- Наём руководителя продаж: "Строите отдел продаж — отличный момент, чтобы подключить внешний outbound. Мы за неделю запустим email-кампании и приведём первые лиды."
- Инвестиции: "Поздравляем с раундом! После привлечения инвестиций первая задача — наполнить воронку. Мы помогаем стартапам запустить outbound за 5 дней."
- Запуск продукта: "Видим запуск [продукт]. Чтобы найти первых B2B-клиентов — cold email самый быстрый и дешёвый канал."
- Рост: "Впечатляющий рост! Когда founder-led sales упирается в потолок — outbound-агентство следующий логичный шаг."

АДАПТИРУЙ шаблон под конкретную компанию. 2-3 предложения, на русском.

=== ФОРМАТ ВЫВОДА ===

Верни ТОЛЬКО JSON-массив (без markdown, без пояснений). Каждый элемент:
{
  "company_name": "string",
  "website": "string or null — сайт компании (без http:// если не уверен, оставь null)",
  "city": "string or null — город (Москва, СПб, etc.)",
  "employee_count": "string or null — примерное количество сотрудников если известно",
  "description": "string — 1-2 предложения что делает компания, на русском",
  "niche": "string — IT, SaaS, Финтех, HR Tech, EdTech, Маркетинг, Логистика, etc.",
  "signal_type": "string — Hiring_Sales | Hiring_Marketing | Funding | Product_Launch | Expansion | Growth | Content_Active",
  "signal_detail": "string — конкретика сигнала, напр. 'Ищет 2 менеджеров по продажам B2B в Москве'",
  "intent_score": "number 0-200",
  "priority": "RED_HOT | HOT | WARM",
  "outreach_angle": "string — персонализированный питч, 2-3 предложения, на русском",
  "source_url": "string — URL источника",
  "hh_employer_id": "string or null — ID работодателя на HH.ru если источник HH",
  "hh_vacancy_name": "string or null — название вакансии если источник HH"
}

ПРАВИЛА КАЧЕСТВА:
- Только российские B2B-компании, подходящие под ICP.
- HARD SKIP: госкомпании, крупняк, B2C, крипта, гемблинг.
- Если не уверен что компания российская B2B — пропусти.
- Верни [] если ничего не подходит.
- Вывод — ТОЛЬКО валидный JSON-массив.`;

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function callLLM(items: RawSignalItem[]): Promise<EnrichedLead[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No LLM API key configured');

  const userContent = items
    .map((item, i) => {
      let text = `[${i + 1}] Title: ${item.title}\nDescription: ${item.description}\nURL: ${item.url}\nSource: ${item.source}`;
      if (item.hh) {
        text += `\nHH Employer ID: ${item.hh.employer_id}\nHH Company: ${item.hh.company_name}\nHH Area: ${item.hh.area ?? 'unknown'}\nHH Vacancy: ${item.hh.vacancy_name}`;
        if (item.hh.company_site_url) text += `\nHH Company Site: ${item.hh.company_site_url}`;
      }
      return text;
    })
    .join('\n\n---\n\n');

  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Проанализируй эти ${items.length} сигналов и верни обогащённые лиды:\n\n${userContent}` },
      ],
      max_tokens: 8192,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as LLMResponse;
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '[]';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item: Record<string, unknown>) =>
          typeof item.company_name === 'string' && item.company_name.length > 0,
      )
      .map((item: Record<string, unknown>) => ({
        company_name: String(item.company_name ?? ''),
        website: typeof item.website === 'string' ? item.website : null,
        city: typeof item.city === 'string' ? item.city : null,
        employee_count: typeof item.employee_count === 'string' ? item.employee_count : null,
        description: String(item.description ?? ''),
        niche: String(item.niche ?? ''),
        signal_type: String(item.signal_type ?? 'Unknown'),
        signal_detail: String(item.signal_detail ?? ''),
        intent_score: Number(item.intent_score ?? 0),
        priority: (['RED_HOT', 'HOT', 'WARM'].includes(String(item.priority)) ? item.priority : 'WARM') as EnrichedLead['priority'],
        outreach_angle: String(item.outreach_angle ?? ''),
        source_url: String(item.source_url ?? ''),
        hh_employer_id: typeof item.hh_employer_id === 'string' ? item.hh_employer_id : null,
        hh_vacancy_name: typeof item.hh_vacancy_name === 'string' ? item.hh_vacancy_name : null,
      }));
  } catch {
    return [];
  }
}

export async function enrichRawSignals(items: RawSignalItem[]): Promise<EnrichedLead[]> {
  if (items.length === 0) return [];

  const chunks: RawSignalItem[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }

  const results: EnrichedLead[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      console.log(`[nash-enrich] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} items)...`);
      const leads = await callLLM(chunks[i]);
      console.log(`[nash-enrich] Chunk ${i + 1} returned ${leads.length} leads`);
      results.push(...leads);
    } catch (err) {
      console.error(`[nash-enrich] Chunk ${i + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }

  const seen = new Set<string>();
  return results.filter((lead) => {
    const key = lead.company_name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
