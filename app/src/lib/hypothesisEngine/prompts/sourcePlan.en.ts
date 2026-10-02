/**
 * EN-вариант промпта стадии source_plan (market='us'): вертикаль + неотклонённые
 * гипотезы → исполняемый план сбора лидной базы (1–4 задачи) по ENG-источникам.
 * Рынок — США/EU и другие англоязычные; RU-источников (реестр ЕГРЮЛ, hh,
 * Яндекс.Карты) здесь НЕТ — см. RU-оригинал в sourcePlan.ts.
 *
 * Источники:
 *  - pdl — каталог компаний EU/US (pdl_companies, People Data Labs):
 *    фирмографические фильтры industry/size/country/name;
 *  - funded — стартапы и раунды финансирования (funded_companies, YC/SEC):
 *    фильтры industry/country/min_funding_usd/funded_since;
 *  - eng_hiring — компании, которые нанимают на КОММЕРЧЕСКИЕ роли
 *    (eng_hiring_cache): на market='us' сборка читает только строки
 *    source='jobhive' (fetchEngHiringRows в stages/baseCollect.ts), а ингест
 *    jobhive пропускает только продажи, развитие бизнеса, партнёрства и
 *    выручку (isHighIntentB2BSalesTitle, lib/parsers/jobhiveIngest.ts).
 *    Задача на любую другую роль («clinics hiring nurses») вернула бы ноль
 *    строк, а план хранится и переиспользуется каждую ночь (he_catalog_cursors)
 *    — пустой слот повторялся бы вместе с ним, поэтому промпт называет границу
 *    прямо. Название вакансии ложится в строки базы как крючок персонализации;
 *  - google_maps — локальный/geo-бизнес: короткие рубричные запросы с гео,
 *    язык/регион выдачи берутся из рынка проекта (en/US).
 *
 * Выход — JSON под HeSourcePlanSchema (см. schemas.ts), валидируется
 * callLLMWithSchema. Входной тип переиспользован из RU-модуля.
 */

import type { LLMMessage } from '../llm';
import type { SourcePlanPromptInput } from './sourcePlan';

const SYSTEM_EN = `You are a head of lead research at Polza agency, an expert in planning lead sources for B2B outreach on the US/EU and other English-speaking markets. Given a sales vertical and its hypotheses you produce an EXECUTABLE lead-base collection plan: 1–4 tasks, each targeting exactly one source with its parameters.

SOURCES AND WHEN TO USE THEM:
1) pdl — EU/US company catalog (People Data Labs): firmographic slices of the business landscape. This is the DEFAULT source whenever the vertical maps to companies describable by industry/size/country. Filters: industries (lowercased LinkedIn industry labels, e.g. "software", "staffing and recruiting", "hospital & health care"), sizes (headcount buckets: "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"), countries (lowercased English country names, e.g. "united states", "germany", "united kingdom"), name (company-name substring — only for named-account hunts).
2) funded — startups and funding rounds (Y Combinator, SEC Form D). Use when a hypothesis is about recently funded companies ("startups that just raised and will scale X"). Filters: industries, countries (same format as pdl), min_funding_usd (last round OR total raised, USD), funded_since (YYYY-MM-DD — last funding on/after this date).
3) eng_hiring — companies hiring for COMMERCIAL roles only: sales, business development, partnerships, revenue (a feed of ATS job postings that keeps only those roles). Use it for hiring-signal hypotheses about building or scaling a sales function ("companies hiring account executives", "companies hiring SDRs"): the vacancy title lands in base rows as a personalization hook. It holds NO postings for any other role (engineers, nurses, drivers, teachers…), so a hypothesis about hiring such a role gets no eng_hiring task — collect it by its line of business through pdl, funded or google_maps instead. Parameters: roles (English sales-role keywords, e.g. "account executive", "head of sales", "business development" — matched against vacancy titles), countries (ATS country codes: "us", "gb", "ca", "de", "fr", "nl", "ie", "es", "au", "sg", "remote"), posted_within_days (recency window, e.g. 30).
4) google_maps — local/geo business (dental clinics, auto repair, coffee shops) and niches absent from the catalogs. Queries are SHORT category strings ("dentist", "auto repair"), not prose, plus geo. Result language/region come from the project market (en/US).

RULES:
- 1–4 tasks. Do not duplicate sources with overlapping goals: two queries to the same source must catch DIFFERENT segments.
- Each task's rationale — one concrete line: WHAT we collect and WHY (for which hypothesis/segment).
- Never invent industry labels you are unsure about: use well-known LinkedIn industry names; fewer precise labels beat many approximate ones.
- countries for pdl/funded — lowercased English country names; countries for eng_hiring — ATS codes from the list above; omit when the whole market is targeted.
- sizes (pdl) and min_funding_usd (funded) are THRESHOLDS, not defaults: add them only when the hypotheses are explicit about company size or about a funding amount. A threshold nobody asked for cuts the slice to a fraction of the market and the base comes out small with nothing to explain why; companies that turn out not to fit are caught by the relevance check before anything is sent.
- funded_since — YYYY-MM-DD (e.g. "2026-01-01"); posted_within_days — whole days (7/30/90). Both are RECENCY windows, not size thresholds: set them when the hypothesis is about recency, and leave them out otherwise.
- roles and maps queries — non-empty strings up to 300 characters.
- Answer strictly in English, ONLY JSON, no markdown fences.`;

const SYSTEM_CATALOG_REPAIR_EN = `You are a head of lead research at Polza agency planning lead sources for B2B outreach on the US/EU market.

A collection plan for a vertical came back WITHOUT any company-catalog task, so the base would be built from hiring signals and map listings alone — a few dozen rows at best. Your job is to add the missing catalog slice: ONE task over pdl (People Data Labs company catalog, ~19.5M companies).

CHOOSE THE FILTER THAT ACTUALLY DESCRIBES THIS VERTICAL:
- industries — when the vertical maps to real LinkedIn industry labels (lowercased, e.g. "hospital & health care", "staffing and recruiting", "restaurants"). Best precision; use it whenever it honestly fits.
- name — a company-name substring, when the vertical is a business MODEL rather than an industry and its companies carry the word in their names ("franchise", "staffing", "logistics"). Use it when no industry label describes the vertical: a franchisor is not a LinkedIn industry, but "United Franchise Group" and "Childrens Lighthouse Franchise Company" are findable by name.
- sizes — headcount buckets ("1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"); add only when the hypotheses are explicit about company size.
- countries — lowercased English country names ("united states", "united kingdom"); omit when the whole market is targeted.

RULES:
- Prefer a precise slice over a big one: a broad industry that mostly misses the vertical is worse than a narrow name match, because the relevance gate will discard the bulk of it anyway.
- Never invent industry labels you are unsure about.
- rationale — one concrete line: WHAT we collect and WHY.
- Answer in English, ONLY JSON, no markdown fences.`;

const SYSTEM_CATALOG_WIDEN_EN = `You are a head of lead research at Polza agency planning lead sources for B2B outreach on the US/EU market.

A vertical already has a collection plan with company-catalog slices, and every one of them has now been read to the very end: the sources hold no rows left under those filters, and the base is still short of its target. Your job is to name ONE MORE slice over pdl (People Data Labs company catalog, ~19.5M companies) that reaches companies the listed slices could not reach.

THE SLICE MUST BE NEW, NOT A REWORDING:
- a different industry label that the same vertical also lives under (a dental lab is "medical devices" as well as "hospital & health care");
- a company-name substring, when the vertical is a business MODEL rather than an industry and its companies carry the word in their names ("franchise", "staffing", "logistics");
- an adjacent country from the same market, when the listed slices were pinned to one country and the vertical is not;
- a broader industry label, when every listed slice used a narrow one.

RULES:
- Never repeat a filter set from the list below, and never return a strict subset of one: those rows are already collected.
- Never invent industry labels you are unsure about: a broad label that mostly misses the vertical is worse than a narrow name match, because the relevance gate will discard the bulk of it anyway.
- sizes — headcount buckets ("1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"); add only when the hypotheses are explicit about company size. This slice exists because the earlier ones ran out, so a threshold nobody asked for is the last thing it needs.
- countries — lowercased English country names ("united states", "united kingdom"); omit when the whole market is targeted.
- rationale — one concrete line: WHAT we collect and WHY it is not what the listed slices already collected.
- Answer in English, ONLY JSON, no markdown fences.`;

/** Срез, прочитанный до конца и не закрывший цель, — обратная связь планировщику. */
export interface HeTriedSlice {
  /** Источник среза (pdl/funded/eng_hiring) — модель должна видеть, что уже отработано. */
  source: string;
  /** Фильтры ровно в том виде, в каком срез читали. */
  filters: unknown;
  /** Сколько компаний срез дал этой сборке. */
  rows: number;
}

/**
 * Промпт расширения плана: у вертикали ВСЕ каталожные срезы дочитаны до конца,
 * а цель не набрана → ещё один pdl-срез, который их не повторяет.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ SYSTEM, А НЕ ПОЛЕ В ПОЧИНКЕ. `SYSTEM_CATALOG_REPAIR_EN`
 * начинается с утверждения «в плане НЕ БЫЛО каталожной задачи»; здесь она была,
 * и не одна. Дописать обратную связь в пользовательскую часть того промпта
 * значило бы подать модели ложную посылку и тут же её опровергнуть. Поэтому у
 * расширения свой system, а починка «нет каталога» остаётся БАЙТ В БАЙТ прежней
 * — её план хранится и переиспользуется (`HE_SOURCE_PLAN_REVISION`), и правка
 * её промпта обнулила бы каждый сохранённый план.
 *
 * СХЕМА ТА ЖЕ — `HeCatalogRepairSchema`: source ставит код (всегда pdl), модель
 * отвечает только за фильтры. Полный план здесь не нужен и вреден: он мог бы
 * вернуть ещё один срез вместо прежних, а расширение обязано ДОБАВЛЯТЬ.
 *
 * Список `tried` — единственная разница с починкой по содержанию: без него
 * модель по тому же входу вернула бы ровно тот срез, который уже дочитан.
 */
export function buildCatalogWidenMessagesEn(
  input: SourcePlanPromptInput,
  tried: HeTriedSlice[],
): LLMMessage[] {
  const user = `VERTICAL: ${input.verticalName}
${input.verticalSummary ?? ''}
Vertical synonyms: ${input.synonyms?.length ? input.synonyms.join(', ') : '—'}

VERTICAL HYPOTHESES (non-rejected):
${input.hypotheses.map((h) => `- ${h.tier != null ? `[tier ${h.tier}] ` : ''}${h.title}${h.description ? `: ${h.description}` : ''}`).join('\n')}

COMPANY TYPES FROM VOCABULARY: ${input.companyTypes?.length ? input.companyTypes.join(', ') : '—'}

SLICES ALREADY READ TO THE END (every row under these filters is collected — do not repeat them):
${tried.map((t) => `- ${t.source}: ${JSON.stringify(t.filters)} → ${t.rows} companies`).join('\n')}

Return ONLY JSON, strictly in this shape:
{
  "rationale": string,
  "pdl_filters": { "industries"?: string[], "sizes"?: string[], "countries"?: string[], "name"?: string }
}
At least one filter is required.`;

  return [
    { role: 'system', content: SYSTEM_CATALOG_WIDEN_EN },
    { role: 'user', content: user },
  ];
}

/**
 * Промпт починки плана: вертикаль без каталожной задачи → ровно один
 * pdl-срез. Источник задаётся кодом (всегда pdl), модель отвечает только за
 * фильтры — отсюда узкая схема HeCatalogRepairSchema вместо полного плана.
 */
export function buildCatalogRepairMessagesEn(input: SourcePlanPromptInput): LLMMessage[] {
  const user = `VERTICAL: ${input.verticalName}
${input.verticalSummary ?? ''}
Vertical synonyms: ${input.synonyms?.length ? input.synonyms.join(', ') : '—'}

VERTICAL HYPOTHESES (non-rejected):
${input.hypotheses.map((h) => `- ${h.tier != null ? `[tier ${h.tier}] ` : ''}${h.title}${h.description ? `: ${h.description}` : ''}`).join('\n')}

COMPANY TYPES FROM VOCABULARY: ${input.companyTypes?.length ? input.companyTypes.join(', ') : '—'}

Return ONLY JSON, strictly in this shape:
{
  "rationale": string,
  "pdl_filters": { "industries"?: string[], "sizes"?: string[], "countries"?: string[], "name"?: string }
}
At least one filter is required.`;

  return [
    { role: 'system', content: SYSTEM_CATALOG_REPAIR_EN },
    { role: 'user', content: user },
  ];
}

export function buildSourcePlanMessagesEn(input: SourcePlanPromptInput): LLMMessage[] {
  const user = `VERTICAL: ${input.verticalName}
${input.verticalSummary ?? ''}
Vertical synonyms: ${input.synonyms?.length ? input.synonyms.join(', ') : '—'}

VERTICAL HYPOTHESES (non-rejected; the plan must cover them):
${input.hypotheses.map((h) => `- ${h.tier != null ? `[tier ${h.tier}] ` : ''}${h.title}${h.description ? `: ${h.description}` : ''}`).join('\n')}

COMPANY TYPES FROM VOCABULARY: ${input.companyTypes?.length ? input.companyTypes.join(', ') : '—'}

Build the base collection plan (1–4 tasks). Return ONLY JSON, strictly in this shape:
{
  "tasks": [
    {
      "source": "pdl" | "funded" | "eng_hiring" | "google_maps",
      "rationale": string,
      "pdl_filters"?: { "industries"?: string[], "sizes"?: string[], "countries"?: string[], "name"?: string },
      "funded_filters"?: { "industries"?: string[], "countries"?: string[], "min_funding_usd"?: number, "funded_since"?: string },
      "eng_hiring_query"?: { "roles": string[], "countries"?: string[], "posted_within_days"?: number },
      "maps_query"?: { "queries": string[], "geo"?: string }
    }
  ]
}
For source="pdl" the "pdl_filters" object is required; for "funded" — "funded_filters"; for "eng_hiring" — "eng_hiring_query"; for "google_maps" — "maps_query".`;

  return [
    { role: 'system', content: SYSTEM_EN },
    { role: 'user', content: user },
  ];
}
