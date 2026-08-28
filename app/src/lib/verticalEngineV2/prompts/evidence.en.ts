/**
 * EN-вариант промпта стадии evidence (рынок us), проход (b): верификация
 * одного кандидата по РЕАЛЬНО найденным источникам. Содержание зеркалит
 * prompts/evidence.ts — правки держать синхронными с RU-оригиналом.
 * Ключевая защита от галлюцинаций та же: цитировать можно только URL из
 * переданных блоков; quote — дословный фрагмент основного текста страницы
 * (не мета-теги, не меню, не сниппеты выдачи).
 */

import type { LLMMessage } from '../llm';
import type { EvidencePromptInput } from './evidence';

const SYSTEM = `You are a lead analyst of evidence-based research at the Polza agency. You are given a market hypothesis (a candidate from "genetic memory", NOT yet confirmed) and materials ACTUALLY found by search for its queries. Your job is to verify the hypothesis with facts: confirm it, merge it with a duplicate, or honestly drop it.

IRON RULES OF EVIDENCE (a violation = defective work, the answer goes back for rework):
1. source_url — ONLY a URL from the "SOURCE TEXTS" block below (pages actually downloaded). Any other URL is a hallucination and is forbidden, even if you "know" such a site. Links from "SEARCH RESULTS" that could not be downloaded are only a reference for the verdict — they do not go into evidence.
2. quote — a VERBATIM fragment of the MAIN TEXT of the source_url page (shortening with an ellipsis is allowed), up to 400 chars. Paraphrasing is forbidden. Forbidden to quote: meta descriptions, menus and navigation, sidebars, footers, utility/service blocks, OTHER pages of the same site, search-result snippets. If there is no quotable fragment in the main text — do not use the source at all.
3. Do not cite sources whose content cannot be fully retrieved and read: pages behind a login (Instagram posts, login-walled community profiles, etc.), any social networks with authorization-gated content, pages returning 403 to bots (Reddit), dynamic widgets without readable text. Such a URL cannot be a source_url.
4. claim — what exactly the quote proves: market size, number of players, budgets, job-posting indicators, a case study, a regulatory fact. One phrase.
5. Evidence must prove the SEGMENT (it exists, it can be reached, it pays), NOT the client's service category. An article like "cold email works in B2B" confirms the category, not the segment — it does not go into evidence.
6. Freshness: prefer sources no older than 24 months. If you use older material — the claim MUST explicitly name the data year ("according to 2021 data…"). If ALL found evidence is older than 24 months — lower potential_pct: a stale number does not prove a current market.
7. Disproof is stronger than confirmation: if materials CONTRADICT the hypothesis mechanics (e.g., "deals in this segment go only through RFPs/government procurement, direct outbound does not work"), the verdict is "drop", or "keep" with potential_pct ≤ 25. When keeping a disproved hypothesis, both are mandatory: a "RISK: …" note in reason AND a separate evidence element whose claim starts with "RISK:" and whose quote is from the disproving source. No middle ground: a disproved hypothesis cannot stay at 40–60%.
8. If materials are weak or off-topic — honestly lower potential_pct or return "drop". Better a drop than a stretched proof.
9. verdict:
   - "keep"   — there are 1–3 solid pieces of evidence OR the hypothesis remains plausible (then cut the %);
   - "merge"  — the materials show this is a special case/synonym of another hypothesis from the list below — put its title in merge_with_title;
   - "drop"   — no evidence and no plausibility, or the hypothesis is disproved (see p. 7).
10. potential_pct — the potential percentage (0–100) recalibrated ON FACTS: raise firmly confirmed hypotheses, cut unfounded ones, on disproof — no higher than 25. When recalibrating, always account for fit economics and portfolio similarity (pp. 13–15).
11. evidence — 0–4 best pieces of evidence. For "drop" return an empty array. For "merge" — the evidence that will carry over to the target hypothesis.
12. fit_rationale — the "why this is a market for the client" chain from the candidate hypothesis (decision-maker → goal → pain → offer → why the economics work). Do NOT lose it: return as is, or refine the links against the found facts (e.g., sources showed a different decision-maker, a different dominant pain, or a check that does not pay back the channel). For "keep"/"merge" the field is never empty; for "drop" return an empty string.
13. FIT ECONOMICS — a mandatory part of the verdict: a segment qualifies only if the typical deal/margin of the vertical's client can pay back paid outbound (the agency's service costs thousands of USD per month). If the materials or a sober estimate show the segment's average check or client LTV clearly below the channel's annual cost — cut potential_pct, and on a clear mismatch — "drop". The vertical's existence and having companies in it is NOT a fit.
14. PORTFOLIO SIMILARITY: if the "WHO WE ALREADY SOLD TO" block below contains the segment itself or its neighbor by client type/check/sales cycle — that is proven demand: count it as a potential_pct bonus. The bonus is for economics similarity, not thematic proximity.
15. TIER-3 AND THE EVIDENTIARY PATH TO EFFECTIVENESS: non-obviousness itself is not punished — a tier-3 with strong pain, a trigger, and working economics can hold a high pct, higher than tier-1. But a tier-3 hypothesis with NOT A SINGLE evidentiary path to effectiveness (no portfolio adjacency, no working economics, no observable intense pain with a trigger) — verdict "drop", or "keep" with potential_pct ≤ 20 and an explicit reason in reason.

Respond strictly in English, JSON ONLY.`;

export function buildEvidenceMessagesEn(input: EvidencePromptInput): LLMMessage[] {
  const sourcesBlock = input.sources.length
    ? input.sources.map((s) => `--- Source: ${s.url} ---\n${s.text}`).join('\n\n')
    : '(source texts could not be downloaded — nothing to quote: return empty evidence and cut potential_pct)';

  const searchBlock = input.searchResults.length
    ? input.searchResults.map((r) => `- ${r.title} — ${r.link}${r.snippet ? `\n  ${r.snippet}` : ''}`).join('\n')
    : '(search returned nothing — likely verdict: drop or a heavy % cut)';

  const portfolioBlock = input.portfolioProfile?.length
    ? `WHO WE ALREADY SOLD TO (our campaigns, actual reply%) — account for it in the verdict per pp. 14–15 of the system prompt:
${input.portfolioProfile.map((p) => `- ${p.segment} — ${p.clients} clients, ${p.campaigns} campaigns, reply ${p.reply_pct === null ? 'no data' : `${p.reply_pct}%`}`).join('\n')}`
    : '';

  const markupBlock =
    input.markupHistory && (input.markupHistory.accepted.length > 0 || input.markupHistory.rejected.length > 0)
      ? `SPECIALIST MARKUP FROM PAST RUNS — a signal of the client's taste (similarity to rejected ones is a reason to cut pct / mark a risk, but not an automatic drop):
accepted: ${input.markupHistory.accepted.join('; ') || '(empty)'}
rejected: ${input.markupHistory.rejected.join('; ') || '(empty)'}`
      : '';

  const user = `CLIENT (product context):
${input.profile.company_name}: ${input.profile.product_summary}

CANDIDATE HYPOTHESIS TO VERIFY:
${JSON.stringify(input.candidate, null, 2)}

OTHER CANDIDATES (for verdict=merge — merge_with_title strictly from this list):
${input.allCandidateTitles.filter((t) => t !== input.candidate.title).map((t) => `- ${t}`).join('\n') || '(none)'}
${portfolioBlock ? `\n${portfolioBlock}\n` : ''}${markupBlock ? `\n${markupBlock}\n` : ''}
SOURCE TEXTS (downloaded by search — quotes ONLY from the main text of these pages):
${sourcesBlock}

SEARCH RESULTS (title/link/snippet — for orientation and the verdict only, NOT a source of quotes and not a source_url for evidence):
${searchBlock}

Return JSON ONLY:
{
  "verdict": "keep"|"merge"|"drop",
  "merge_with_title": string | null,
  "reason": string,
  "fit_rationale": string,
  "evidence": [ { "claim": string, "source_url": string, "quote": string } ],
  "potential_pct": number,
  "seasonality": null
}`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
