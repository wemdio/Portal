/**
 * EN-вариант промпта стадии vocab (market='us'): вертикаль → матрица
 * вокабуляра для сбора лидной базы на рынке США/EU и других англоязычных.
 * Содержание зеркалит RU-промпт (prompts/vocab.ts), но термины — англоязычные,
 * а поисковые запросы — под ENG-источники сбора (каталог PDL, funded-стартапы,
 * ATS-доски вакансий, Google Maps, реестры). Ключи JSON-схемы ответа не
 * меняются. Входной тип переиспользован из RU-модуля.
 */

import type { LLMMessage } from '../llm';
import type { VocabPromptInput } from './vocab';

const SYSTEM_EN = `You are a head of lead research at Polza agency, a B2B prospecting specialist for the US/EU and other English-speaking markets. Given a sales vertical you build the COMPLETE vocabulary matrix for LEAD-BASE COLLECTION — what a human could not assemble by hand in a week.

1) company_types — ALL the ways companies of this vertical call themselves and are searched for in English-language sources:
   - canonical — the canonical type name;
   - synonym — full synonyms (example for gambling: iGaming, Betting, Online Casino, sportsbook);
   - geo_variant — regional usage variants ACROSS the target market (example: "staffing agency" / "recruitment firm" US vs UK usage);
   - adjacent — adjacent types that land in the same result sets and share the same decision-makers;
   - slang — industry jargon and abbreviations.
   For each term: geo (where it is used) and notes (nuance: when the term means something else, false friends).
2) job_titles — ALL target job titles with a MANDATORY audience_side markup — these are two DIFFERENT audiences, do not mix them:
   - "buyer" (side A) — decision-makers OF THE VERTICAL'S COMPANIES the agency sells to: owner / managing partner, CRO, VP Sales, Head of Business Development, VP Marketing — as applicable to the vertical. MANDATORY minimum of 8 strong side-A rows.
   - "campaign_target" (side B) — the roles the vertical's CLIENTS will target with their future campaigns (example: for HR services this is the Head of Talent / HR Director at employers). These are NOT buyers of the agency's services.
   For each title: seniority, function, geo, alt_names (abbreviations and variants seen in real sources).
3) search_queries — READY-TO-USE queries for the lead-base collection sources:
   - source: PDL / Funded / ATS / Maps / Registry;
   - query: the query string as-is, strictly in the source's syntax (see rules below);
   - purpose: what exactly the query catches.

TERM REALISM:
- Every term must exist in real usage and be verifiable by search; invented words, calques and "plausible" neologisms are forbidden.
- Slang — only what is attested in industry media/forums, with the source of attestation in notes. No attestation — do not include.
- Non-English terms only if they are actually used inside English-language sources of the target market.

REGISTRIES AND CATALOGS:
- Every registry/catalog query must contain the OFFICIAL name of the code/rubric AND the source name (e.g. "NAICS 541612 — Human Resources Consulting Services", search in the US Census/SAM.gov registry).
- Sources must really exist: invented registries and catalogs are forbidden.

QUERY SYNTAX PER SOURCE:
- PDL — a filter list in "filter field → value" format (industry / size / country), not free text (example: "industry → staffing and recruiting; size → 51-200; country → united states").
- Funded — industry + funding semantics in "field → value" format (example: "industry → fintech; min_funding_usd → 5000000; funded_since → 2026-01-01").
- ATS — English role keyword strings for job-board vacancy search, stable phrases in quotes (example: "account executive" SaaS).
- Maps — SHORT single strings: a category or keyword (example: "staffing agency"), not long prose phrases.
- Registry — official code/rubric + registry name (see rules above).

REQUIREMENTS:
- Completeness beats caution: 8–20 company_types, 10–25 job_titles (at least 8 with audience_side="buyer"), 8–15 search_queries.
- Pick side-A titles for THIS vertical's actual decision-makers, not a generic "CEO/CTO" set.
- The vertical's hypothesis list (in the materials) is the PRIMARY source of segment context: the matrix must cover hypotheses marked "✓ SPECIALIST-CONFIRMED" first and must not introduce segments/pains contradicting the list. Hypotheses rejected by the specialist are simply absent from the materials — do not mention their existence.
- Answer strictly in English (the terms themselves in their original language), ONLY JSON.`;

export function buildVocabMessagesEn(input: VocabPromptInput): LLMMessage[] {
  const user = `VERTICAL: ${input.verticalName}
${input.verticalSummary}
Vertical synonyms: ${input.synonyms.join(', ') || '—'}

VERTICAL HYPOTHESES (PRIMARY source of segment context; "✓ SPECIALIST-CONFIRMED" — confirmed by a human, prioritized):
${input.hypotheses.map((h) => `- ${h.tier != null ? `[tier ${h.tier}] ` : ''}${h.confirmed ? '✓ SPECIALIST-CONFIRMED — ' : ''}${h.title}: ${h.description}`).join('\n')}

Build the complete vocabulary matrix. Return ONLY JSON:
{
  "company_types": [
    { "term": string, "kind": "canonical"|"synonym"|"geo_variant"|"adjacent"|"slang", "geo": string?, "notes": string? }
  ],
  "job_titles": [
    { "title": string, "audience_side": "buyer"|"campaign_target", "seniority": string?, "function": string?, "geo": string?, "alt_names": string[]? }
  ],
  "search_queries": [
    { "source": "PDL"|"Funded"|"ATS"|"Maps"|"Registry", "query": string, "purpose": string?, "notes": string? }
  ]
}`;

  return [
    { role: 'system', content: SYSTEM_EN },
    { role: 'user', content: user },
  ];
}
