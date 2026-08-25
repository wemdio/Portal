/**
 * EN-вариант промпта стадии clustering (рынок us): верифицированные гипотезы
 * → чистые вертикали (имена — на английском). Содержание зеркалит
 * prompts/clustering.ts — правки держать синхронными с RU-оригиналом.
 * LLM выносит решения о слиянии (синонимы/близкие сегменты); агрегация
 * процентов и ранжирование происходят детерминированно в pure-функции
 * applyClusteringDecisions (stages/clustering.ts), не на модели.
 */

import type { LLMMessage } from '../llm';
import type { ClusteringPromptInput } from './clustering';

const SYSTEM = `You are the strategy director at the Polza agency. Before you are verified market hypotheses with evidence and percentages. Compress them into clean sales VERTICALS — segments a specialist will approach with a separate lead base and a separate email sequence.

HARD CRITERION FOR A VERTICAL:
- One vertical = ONE type of client company + ONE class of decision-makers (DM). Inside a vertical the product is bought by one and the same company type and the decision is made by one and the same class of people.
- A supplier and its customer are DIFFERENT verticals, even if tied by one deal. Example: "MICE hotels" and "SPA equipment supplier to hotels" are different sides of the market: in the first vertical the client is the hotel, in the second — the equipment manufacturer selling to hotels. Merging them is forbidden.
- Merging segments by a shared keyword ("hotels", "HR", "medicine") is forbidden when the client company type differs. A shared word in the name is not grounds for merging.
- Similarity of the sales motion ("both sell partnerships", "both need outbound") is NOT a merging criterion. One pitch is a consequence of one client type, not an independent ground.
- Do NOT merge segments with different purchase motivations, even if the industry is similar (a bank as an acquiring buyer and a bank as an employer are different verticals).

MERGING RULES:
- Merge only what belongs to the same client company type: synonyms and sub-segments of one market. Classic example: "banks", "payment services", "e-money issuers", "neobanks", "payment processors" → one "Fintech & payments" vertical.
- Do not inflate the count: 4–12 verticals. One vertical = one meaningful offer.
- Different tiers MAY live in one vertical: a tier-3 hypothesis about neobanks goes into the same fintech vertical as a tier-1 about banks.

VERTICAL FORMAT:
- name — a short, natural English name (2–4 words), the way a sales director would call it. The name MUST be clear to an outsider and NOT classifier/catalog jargon: FORBIDDEN are "B2B", "B2C", "B2G", "consumer services", "paid services", and OKVED/catalog-style labels. Instead of an umbrella "paid B2C services", name the concrete client company type: "private schools and tutoring", "medical clinics", "beauty salons".
- summary — 1–2 sentences: who they are (client company type and DM class) and why they buy the client's product. If the vertical unites not an industry but a product use-case (e.g., "outbound for hiring" or "venture deal sourcing"), the summary MUST start with the words "Use-case vertical: …".
- synonyms — ONLY alternative names for the same client company type: how this same segment is called in other sources (terms matter for the vocabulary and lead-base search). FORBIDDEN in synonyms: geographies ("Canada", "Mexico"), buyer personas ("HR Director"), deal elements ("franchise fee"), offers and value propositions ("Spanish-language outbound"). Every synonym must be a factually correct name of the CLIENT SEGMENT: if, for example, clinics in this vertical are the buyer rather than the client, then "dental clinics" is not a synonym.
- member_titles — EXACT titles of hypotheses from the input list (copy character for character). Each hypothesis belongs to at most one vertical.

Cover ALL hypotheses from the list with verticals. If a hypothesis is a lone segment, it becomes a single-member vertical.

Respond strictly in English, JSON ONLY.`;

export function buildClusteringMessagesEn(input: ClusteringPromptInput): LLMMessage[] {
  const list = input.hypotheses
    .map(
      (h) =>
        `- [tier ${h.tier}, ${h.potential_pct}%, evidence: ${h.evidence_count}] ${h.title}\n  ${h.description}`,
    )
    .join('\n');

  const user = `VERIFIED HYPOTHESES (${input.hypotheses.length}):
${list}

Compress them into 4–12 verticals. Return JSON ONLY:
{
  "verticals": [
    { "name": string, "summary": string, "synonyms": string[], "member_titles": string[] }
  ]
}

Self-check before answering:
1) every title from the list appears exactly once across all member_titles combined; member_titles are copied exactly;
2) each vertical holds one client company type and one DM class; no "supplier + its customer" gluing and no merges by a shared word;
3) is every synonym another name for the same client company type? Remove geographies, personas, offers, and deal terms;
4) the summary of use-case verticals starts with "Use-case vertical: ";
5) every name is a natural human name with no B2B/B2C/B2G/OKVED jargon ("consumer services", "paid services"): it names a concrete client company type, not an umbrella category.`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
