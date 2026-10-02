/**
 * EN-вариант промпта стадии clustering (рынок us): верифицированные гипотезы
 * → чистые вертикали (имена — на английском). Содержание зеркалит
 * prompts/clustering.ts — правки держать синхронными с RU-оригиналом.
 * LLM выносит решения о слиянии (синонимы/близкие сегменты); агрегация
 * процентов и ранжирование происходят детерминированно в pure-функции
 * applyClusteringDecisions (stages/clustering.ts), не на модели.
 *
 * ОДНО расхождение с RU-оригиналом сделано намеренно, синхронизировать его НЕ
 * надо: формат summary. Предложение 1 — КТО ЭТО за компании, без нашего клиента,
 * продукта и покупки; предложение 2 начинается словами «They buy because …» и
 * объясняет мотив. Причина: тот же summary уезжает целью отбора сразу к двум
 * консьюмерам — в relevanceGate.ts (строки готовой базы) и в sliceProbe.ts
 * (проба среза до сбора). Там видно только company/website/category(/vacancy_title),
 * мотив покупки по этим полям не проверяется никак, и с мотивом внутри цели
 * модель вычёркивала подходящие компании — они молча не попадали в запуск. Оба
 * консьюмера режут summary по этому зачину (companyPartOfSummaryEn). Третий,
 * кто режет, — словарь вертикали (stages/vocab.ts, только market='us'). А
 * EN-планировщик источников и проверка базиса размера получают summary
 * ЦЕЛИКОМ, с мотивом: резать ли и там — открытое решение (комментарий в
 * stages/vocab.ts), оно меняет ключ переиспользуемого плана.
 *
 * Почему зачин — живая фраза, а не служебная метка вида «Why they buy: »: тот же
 * summary целиком показывается клиенту в ENG-кабинете (поле в белом списке
 * clientEngProjection.ts), а метки, которую никто не писал как текст для
 * клиента, там быть не должно. «They buy because …» читается как обычное
 * английское предложение и одновременно служит границей для машины.
 *
 * Мотив остаётся ВНУТРИ summary, а не выносится отдельным полем, потому что тот
 * же summary читают промпты писем (prompts/template.ts, prompts/chain.ts) — там
 * мотив нужен; отдельное поле потребовало бы миграции he_verticals и правок всех
 * консьюмеров, включая клиентскую проекцию.
 * RU-промпт шарится с legacy-инструментом /tools/hypothesis-engine — не менять.
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
- name — a short, natural English name (2–4 words), the way a sales director would call it.
- summary — exactly 2 sentences of plain English the client will read as is, in this fixed order. Sentence 1 — WHO THEY ARE: the client company type and the DM class, worded so that one could recognise such a company from its name, industry or website alone; do NOT mention our client, their product or the purchase in this sentence. Sentence 2 — MUST begin with the exact words "They buy because " and finish that thought: why such companies buy the client's product. Write both sentences as normal prose: no labels, no field names, no colons standing in for a heading. If the vertical unites a product use-case rather than an industry (e.g., "outbound for hiring" or "venture deal sourcing"), sentence 1 still describes the COMPANIES, made recognisable by that use-case ("companies that run outbound hiring campaigns"), never the use-case in the abstract.
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
4) every summary is exactly 2 sentences, and its first sentence describes only the company (type + DM class) — no mention of our client, the product or the purchase;
5) the second sentence of every summary begins with the exact words "They buy because ", and neither sentence contains a label or a heading-style prefix.`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
