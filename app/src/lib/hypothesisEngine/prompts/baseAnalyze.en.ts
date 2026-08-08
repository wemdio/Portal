/**
 * EN-вариант промпта стадии base_analyze (рынок us): колонки + сэмпл строк
 * загруженной базы → профиль базы (гео/индустрии/типы компаний/должности +
 * сегменты + углы). Содержание зеркалит prompts/baseAnalyze.ts — правки
 * держать синхронными с RU-оригиналом. Результат — основа 15% сегментной
 * дописки финального шаблона, поэтому для us-проектов анализ пишется
 * по-английски (иначе EN-шаблон получал RU-вставки).
 */

import type { LLMMessage } from '../llm';
import type { BaseAnalyzePromptInput } from './baseAnalyze';

const SYSTEM = `You are a senior data analyst at the Polza agency. You are given a lead-list export (column names + sample rows) for a specific sales vertical. Your task is to build a precise profile of the list: who it actually consists of.

Rules:
- Rely ONLY on the data below. If a breakdown cannot be built (the column is missing) — return an empty array, do not invent a distribution.
- share_pct — the share of rows holding the value (0–100), rounded to whole numbers; compute it from the sample, not from imagination. Top-5 values per breakdown, collapse the tail into "Other".
- notable_segments — 2–6 meaningful observations: what genuinely stands out in the data (e.g. "40% are micro-businesses with no website", "e-commerce from New York dominates", "half of the decision-makers are founders").
- data_quality_notes — be honest: which columns are missing, which fields are dirty, what will hinder personalization.
- recommended_angles — 3–6 messaging angles for THIS specific list: examples, phrasings, and emphases that will land with its segments (geo specifics, industry case studies, decision-maker roles). This is the basis for the template's segment-level tailoring — make the angles concrete, not "write about the benefits".
- Respond strictly in English, JSON ONLY.`;

export function buildBaseAnalysisMessagesEn(input: BaseAnalyzePromptInput): LLMMessage[] {
  const rows = input.sampleRows
    .map((r, i) => `${i + 1}. ${JSON.stringify(r)}`)
    .join('\n');

  const user = `LIST: ${input.filename} — ${input.rowCount} rows (sample below)
SALES VERTICAL: ${input.verticalName}

COLUMNS (${input.columns.length}):
${input.columns.map((c) => `- ${c}`).join('\n')}

SAMPLE ROWS (${input.sampleRows.length}):
${rows || '(empty)'}

Return JSON ONLY:
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
