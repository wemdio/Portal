/**
 * Промпт стадии base_analyze: колонки + сэмпл строк загруженной базы →
 * профиль базы (гео/индустрии/типы компаний/должности + сегменты + углы).
 * Результат — основа 15% сегментной дописки финального шаблона.
 */

import type { LLMMessage } from '../llm';

const SYSTEM = `Ты — senior data analyst агентства Polza. Тебе дана выгрузка лид-базы (названия колонок + сэмпл строк) под конкретную вертикаль продаж. Твоя задача — построить точный профиль базы: из кого она реально состоит.

Правила:
- Опирайся ТОЛЬКО на данные ниже. Если какой-то разрез невозможно построить (нет колонки) — верни пустой массив, не выдумывай распределение.
- share_pct — доля строк с значением (0–100), округляй до целых; считай по сэмплу, не по фантазии. Топ-5 значений на разрез, хвост схлопывай в «Прочее».
- notable_segments — 2–6 содержательных наблюдений: что реально бросается в глаза в данных (например, «40% — микробизнес без сайта», «доминируют e-commerce из Москвы», «половина ЛПР — founders»). Если в базе есть сезонные отрасли (образование → сентябрь, начало учебного года; ритейл → предновогодний пик) — отметь приближающийся сезон относительно даты СЕГОДНЯ.
- data_quality_notes — честно: каких колонок не хватает, какие поля грязные, что помешает персонализации. Личные email ЛПР в РФ юридически недоступны (152-ФЗ): их отсутствие в базе — норма, а не ошибка сбора; формулируй это как ожидаемое ограничение, не как дефект базы.
- recommended_angles — 3–6 углов подачи под ИМЕННО эту базу: примеры, формулировки, акценты, которые зайдут её сегментам (гео-специфика, отраслевые кейсы, роль ЛПР). Если актуально по дате СЕГОДНЯ — добавь сезонный угол (пик сезона отрасли как повод и тайминг оффера). Это основа сегментной дописки шаблона — делай углы конкретными, не «пишите про пользу».
- Отвечай строго на русском, ТОЛЬКО JSON.`;

export interface BaseAnalyzePromptInput {
  filename: string;
  rowCount: number;
  columns: string[];
  /** Сэмпл строк, предобрезанный стадией (макс ~30 строк, значения урезаны). */
  sampleRows: Array<Record<string, unknown>>;
  verticalName: string;
  /** Текущая дата (YYYY-MM-DD) — ориентир для сезонности в углах/наблюдениях. */
  today: string;
}

export function buildBaseAnalysisMessages(input: BaseAnalyzePromptInput): LLMMessage[] {
  const rows = input.sampleRows
    .map((r, i) => `${i + 1}. ${JSON.stringify(r)}`)
    .join('\n');

  const user = `БАЗА: ${input.filename} — ${input.rowCount} строк (сэмпл ниже)
ВЕРТИКАЛЬ ПРОДАЖ: ${input.verticalName}
СЕГОДНЯ: ${input.today}

КОЛОНКИ (${input.columns.length}):
${input.columns.map((c) => `- ${c}`).join('\n')}

СЭМПЛ СТРОК (${input.sampleRows.length}):
${rows || '(пусто)'}

Верни ТОЛЬКО JSON:
{
  "geo_distribution":        [ { "value": string, "share_pct": number } ],
  "industry_distribution":   [ { "value": string, "share_pct": number } ],
  "company_type_distribution":[ { "value": string, "share_pct": number } ],
  "title_distribution":      [ { "value": string, "share_pct": number } ],
  "notable_segments": string[],
  "data_quality_notes": string,
  "recommended_angles": string[]
}`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
