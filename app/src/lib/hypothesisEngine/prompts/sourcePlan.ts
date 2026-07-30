/**
 * Промпт стадии source_plan: вертикаль + неотклонённые гипотезы → исполняемый
 * план сбора лидной базы (1–4 задачи по источникам). Рынок — ТОЛЬКО Россия/СНГ.
 *
 * Источники:
 *  - companies_directory — реестр компаний (ЕГРЮЛ-подобный справочник):
 *    строки уже содержат email/телефоны, фильтры по ОКВЭД/региону/выручке/штату;
 *  - hh_live — живой поиск вакансий hh.ru: работодатели с сигналом найма,
 *    название вакансии ложится в строки базы как крючок персонализации;
 *  - yandex_maps / google_maps — локальный/geo-бизнес и ниши вне таксономии
 *    реестра: короткие рубричные запросы с гео.
 *
 * Выход — JSON под HeSourcePlanSchema (см. schemas.ts), валидируется
 * callLLMWithSchema.
 */

import type { LLMMessage } from '../llm';

export interface HeCollectTask {
  source: 'companies_directory' | 'hh_live' | 'yandex_maps' | 'google_maps';
  /** Что и зачем собираем, 1 строка. */
  rationale: string;
  directory_filters?: {
    okvedCodes?: string[];
    regionCodes?: string[];
    revenueFrom?: number;
    revenueTo?: number;
    employeesFrom?: number;
    employeesTo?: number;
    hasEmail?: boolean;
    includeIp?: boolean;
  };
  hh_query?: { text: string; area?: string; date_from?: string; date_to?: string };
  maps_query?: { queries: string[]; geo?: string };
}

export interface HeSourcePlan {
  tasks: HeCollectTask[];
}

const SYSTEM = `Ты — head of lead research в агентстве Polza, эксперт по планированию источников лидов для B2B-аутрича на рынке России и СНГ. По вертикали продаж и её гипотезам ты составляешь ИСПОЛНЯЕМЫЙ план сбора лидной базы: 1–4 задачи, каждая — ровно один источник с параметрами.

ИСТОЧНИКИ И КОГДА ИХ БРАТЬ:
1) companies_directory — реестр компаний; строки уже содержат email и телефоны. Это источник ПО УМОЛЧАНИЮ: бери его всегда, когда вертикаль маппится на бизнесы, классифицируемые по ОКВЭД. Фильтры: okvedCodes, regionCodes, revenueFrom/revenueTo, employeesFrom/employeesTo, hasEmail, includeIp.
2) hh_live — живой поиск вакансий hh.ru. Бери, когда гипотеза про работодателей и сигналы найма («компании, нанимающие роль X»): название вакансии ляжет в строки базы как крючок персонализации. Параметры: text (строка поиска вакансий), area, date_from/date_to.
3) yandex_maps / google_maps — локальный/geo-бизнес (стоматологии, автосервисы, кофейни) и ниши, которых нет в таксономии реестра. Запросы — КОРОТКИЕ рубричные строки («стоматология», «автосервис»), не прозаические фразы, плюс geo.

ПРАВИЛА:
- 1–4 задачи. Не дублируй источники с пересекающимися целями: два запроса к одному источнику должны ловить РАЗНЫЕ сегменты.
- rationale каждой задачи — конкретная одна строка: ЧТО собираем и ЗАЧЕМ (под какую гипотезу/сегмент).
- ОКВЭД: НИКОГДА не выдумывай коды, в которых не уверен. Только класс XX или группа XX.X (например «62», «62.0»). Меньше точных кодов лучше, чем много приблизительных. Самопроверка: назови официальное название каждого кода; не уверен — не включай.
- regionCodes — двузначные коды регионов РФ («77» Москва, «78» Санкт-Петербург, «50» Московская область); не указывай, если вся Россия.
- revenueFrom/revenueTo — в рублях в год.
- Для реестра hasEmail=true ставь ТОЛЬКО когда email важнее покрытия (помни: фильтр hasEmail сильно сужает выдачу). includeIp=false по умолчанию для B2B.
- hh area — числовой id региона hh.ru (113 — Россия, 1 — Москва, 2 — СПб); не указывай, если вся Россия.
- date_from/date_to — формат YYYY-MM-DD (например «2026-07-01»).
- Запросы (hh text, maps queries) — непустые строки до 300 символов.
- Отвечай строго на русском, ТОЛЬКО JSON, без markdown-обёрток.`;

export interface SourcePlanPromptInput {
  verticalName: string;
  verticalSummary?: string | null;
  synonyms?: string[];
  /** Неотклонённые гипотезы вертикали (rejected сюда не попадают). */
  hypotheses: Array<{ title: string; description?: string | null; tier?: number | null }>;
  /** Вокабуляр типов компаний из стадии vocab (опционально). */
  companyTypes?: string[];
}

export function buildSourcePlanMessages(input: SourcePlanPromptInput): LLMMessage[] {
  const user = `ВЕРТИКАЛЬ: ${input.verticalName}
${input.verticalSummary ?? ''}
Синонимы вертикали: ${input.synonyms?.length ? input.synonyms.join(', ') : '—'}

ГИПОТЕЗЫ ВЕРТИКАЛИ (неотклонённые; план обязан их покрывать):
${input.hypotheses.map((h) => `- ${h.tier != null ? `[tier ${h.tier}] ` : ''}${h.title}${h.description ? `: ${h.description}` : ''}`).join('\n')}

ТИПЫ КОМПАНИЙ ИЗ ВОКАБУЛЯРА: ${input.companyTypes?.length ? input.companyTypes.join(', ') : '—'}

Составь план сбора базы (1–4 задачи). Верни ТОЛЬКО JSON, строго по схеме:
{
  "tasks": [
    {
      "source": "companies_directory" | "hh_live" | "yandex_maps" | "google_maps",
      "rationale": string,
      "directory_filters"?: { "okvedCodes"?: string[], "regionCodes"?: string[], "revenueFrom"?: number, "revenueTo"?: number, "employeesFrom"?: number, "employeesTo"?: number, "hasEmail"?: boolean, "includeIp"?: boolean },
      "hh_query"?: { "text": string, "area"?: string, "date_from"?: string, "date_to"?: string },
      "maps_query"?: { "queries": string[], "geo"?: string }
    }
  ]
}
Для source="companies_directory" обязателен "directory_filters"; для "hh_live" — "hh_query"; для "yandex_maps"/"google_maps" — "maps_query".`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
