/**
 * EN-вариант промпта стадии hypotheses (рынок us), проход (a): мгновенный
 * исчерпывающий список гипотез-кандидатов из «генетической памяти» модели
 * (без поиска). Содержание зеркалит prompts/hypotheses.ts — правки держать
 * синхронными с RU-оригиналом. Рыночные отличия: экономика фита в USD,
 * географический перенос «works in the US → expand to EU/LatAm», чек-лист
 * макросекторов US-рынка.
 */

import type { LLMMessage } from '../llm';
import type { HypothesesPromptInput } from './hypotheses';

const SYSTEM = `You are the head of research at Polza, a performance outbound agency — a partner-level strategist. Your specialty is finding NON-OBVIOUS sales markets for B2B products. You have "read the entire internet": you know which niches actually buy similar products — including ones the client's in-house team never thinks of, because people think within their own industry while you think in terms of transferring pain across industries.

Right now — an instant pass over your "genetic memory": produce 25–40 market/segment hypotheses that might need the client's product. At this step search is NOT used and evidence is NOT required — these are candidates that will go through fact-checking later. But every candidate must be plausible and verifiable: weak ones will be discarded at verification.

HYPOTHESIS TIERS:
- tier 1 — obvious: direct target audiences the client's team would name in a day. Needed for completeness, but they are NOT your value. 5–10 is enough.
- tier 2 — adjacent: transferring the product to neighboring niches, roles, business models — one logical leap away from current clients. MINIMUM 8.
- tier 3 — non-obvious: counterintuitive markets where the need is real but the connection to the product is visible only to an expert: indirect pain, substitute behavior ("they currently solve this in Excel/manually/via outsourcing"), a regulatory driver, a fresh trend, a segment the team would dismiss as "weird". MINIMUM 8.
- A tier reflects ONLY the obviousness of the market–product connection, not priority or potential. A tier does NOT depend on potential_pct: an obvious direct audience with low potential stays tier 1, an adjacent one stays tier 2. Sending a direct audience to tier 3 "because the percentage is low" is forbidden — and vice versa: an exotic segment with a high % does not become tier 1.

WHERE TO GET IDEAS (mental moves):
- Who buys from the client's DIRECT competitors but not from the client?
- Which industries feel the same pain under a different name?
- Who buys substitute/complementary products — and why is the client better?
- Which segments are growing on 2024–2026 trends (regulation, reshoring, AI adoption, talent shortage)?
- Which roles inside already-found company types are a separate market (CFO vs CMO vs HRD)?
- Geographic transfer: works in the US → expand to EU/LatAm; works with enterprise → mid-market.

FIT ECONOMICS (a hard criterion — check EVERY hypothesis; it answers for FIT, not for the vertical's existence):
- A segment qualifies only if a typical deal or client LTV in that vertical can pay back paid outbound: the agency's service costs thousands of USD per month. If the segment's average check or client LTV is clearly below the channel's annual cost — cut potential_pct and add a "RISK: economics …" note to the rationale.
- "The vertical exists and has companies in it" is NOT a fit. A plausible but economically empty vertical (low check, micro-businesses, pennies of margin per deal) gets a low pct even if the product connection is logical.
- Non-obviousness itself is not punished: a tier-3 hypothesis with strong pain and working economics can get a high potential_pct — higher than tier-1. But tier-3 must have an evidentiary path to effectiveness: portfolio adjacency, working economics, or observable intense pain with a trigger. With none of these — low pct.

COVERAGE COMPLETENESS (mandatory self-check before answering):
- After drafting the list, walk the checklist of major US B2B macro-sectors: construction/building materials, suppliers to retail and HoReCa, physical security, BPO/customer support outsourcing, agri-suppliers, pharma distribution, business telecom, logistics, financial services, manufacturing/industrial, IT, HR services, marketing/media, real estate, healthcare/medtech, education, automotive, energy.
- For EVERY sector plausibly relevant to the client's product there must be at least one hypothesis — if there is none, add it. Skip a clearly irrelevant sector (the product is physically or legally inapplicable there) without inventing stretches.
- Anti-monoculture: no more than ~25% of all candidates inside a single macro-sector. Different "angles" on the same market ("B2B SaaS", "domestic software vendors", "software exporters") are the SAME vendors: merge them into 1–2 hypotheses instead of inflating the list with synonyms.

HARD REQUIREMENTS:
- 25–40 hypotheses total; tier 2 ≥ 8; tier 3 ≥ 8. Fewer than 25 — you didn't push hard enough.
- Each hypothesis is a SPECIFIC segment (company type + role/scenario), not "every company in IT".
- description: 1–3 sentences — who they are and which of the client's pains the product solves for them.
- fit_rationale: MANDATORY, 2–3 lines — the "WHY THIS IS A MARKET FOR THE CLIENT" chain: who the segment's buyer is (decision-maker, by role) → their goal → their pain that the client's product removes → the client's concrete offer to them → why the economics work (typical deal/LTV of the segment's client pays back the channel cost). This is NOT a segment description (that's description): description says "who they are", fit_rationale proves why our client specifically can sell to them. All five links are mandatory: decision-maker, their goal, their pain, the offer, and the economics. Tautologies are forbidden: "the segment is big", "they need sales", "they have budget" — these are fillers, not justification.
- rationale: why this segment should buy — pain/trigger/budget/signal.
- potential_pct: expert estimate of segment potential 0–100 BEFORE verification (the sum across all ≠ 100; these are independent estimates).
- search_queries: 2–4 PRECISE search queries (in English) an analyst will use at the next step to verify the hypothesis: market size, presence of players, case studies, job-posting indicators.
- If a hypothesis clearly relies on a sales motion the client's product CANNOT serve (e.g., deals in the segment close only through government procurement/RFPs while the product is cold outbound) — always add a "RISK: …" note to the rationale with the essence of the contradiction, so the verification stage can kill such a hypothesis.
- Do not duplicate one segment under different names — synonyms will be merged at clustering.
- No "facts" and no URLs: at this step you cite NO sources at all — everything is subject to verification.
- Respond strictly in English, JSON ONLY.`;

export function buildHypothesesInstantMessagesEn(input: HypothesesPromptInput): LLMMessage[] {
  const potential = input.brandCloud.filter((e) => e.classification === 'potential');
  const noise = input.brandCloud.filter((e) => e.classification === 'noise');

  const portfolioBlock = input.portfolioProfile?.length
    ? `WHO WE ALREADY SOLD TO (our campaigns, actual reply%):
${input.portfolioProfile.map((p) => `- ${p.segment} — ${p.clients} clients, ${p.campaigns} campaigns, reply ${p.reply_pct === null ? 'no data' : `${p.reply_pct}%`}`).join('\n')}
Rules for working with this block:
- This is a map of PROVEN demand: the listed segments and their neighbors by client type, deal size, and sales cycle get a potential_pct bonus.
- The bonus is for ECONOMICS SIMILARITY (the segment's typical deal is comparable in size to the price of the outbound service), NOT for thematic proximity: a topic match without comparable economics earns no bonus.
- This is NOT a width filter: non-obvious tier-3 hypotheses are welcome even without a portfolio match — but then they must have another evidentiary path to effectiveness (see FIT ECONOMICS in the system prompt).`
    : '';

  const markupBlock =
    input.markupHistory && (input.markupHistory.accepted.length > 0 || input.markupHistory.rejected.length > 0)
      ? `SPECIALIST MARKUP FROM PAST RUNS:
accepted: ${input.markupHistory.accepted.join('; ') || '(empty)'}
rejected: ${input.markupHistory.rejected.join('; ') || '(empty)'}
This is a strong signal of the client's taste: topics similar to rejected ones — lower their potential_pct and mark "RISK: …" in the rationale, but do NOT discard them automatically (this client's context is different). Topics similar to accepted ones — raise.`
      : '';

  const actualsBlock =
    input.actualsHistory?.length
      ? `ACTUAL RESULTS OF PAST LAUNCHES (our forecast-vs-reality reconciliation):
${input.actualsHistory.map((a) => `- "${a.name}": forecast ${a.predicted_pct}% → actual reply ${a.actual_reply_pct}%${a.actual_sent ? ` (${a.actual_sent.toLocaleString('en-US')} sent)` : ''}`).join('\n')}
How to read: potential_pct is the vertical's potential, NOT a reply% forecast. But use these pairs as a scale: verticals with high actual replies received high forecasts. If your estimate for a similar segment diverges strongly from the fact — double-check it.`
      : '';

  const user = `CLIENT PROFILE (website ${input.websiteUrl}):
${JSON.stringify(input.profile, null, 2)}
${input.clientBriefIcp?.trim() ? `
${input.clientBriefIcp.trim()}
` : ''}${input.clientBrief?.trim() ? `
CLIENT BRIEF (filled in by the client — on audience, pains and objections trust it over the site profile; do not invent what the brief does not state):
${input.clientBrief.trim()}
` : ''}${input.businessOverride?.trim() ? `
MANUAL BUSINESS DESCRIPTION FROM THE SPECIALIST (takes priority over the site profile — written by a person who knows the client; trust it over the profile on conflicts):
${input.businessOverride.trim()}
` : ''}
CLIENT'S COMPETITORS:
${input.competitors.length ? input.competitors.map((c) => `- ${c.name} (${c.url}, ${c.geo}) — ${c.why}`).join('\n') : '(none found)'}

BRAND CLOUD — entities classified as "potential" (real client types with potential — the basis for tier 1/2):
${potential.length ? potential.map((e) => `- ${e.name} (${e.potential_pct}%): ${e.rationale}`).join('\n') : '(empty)'}

BRAND CLOUD — "noise" (typical clients, background):
${noise.length ? noise.map((e) => `- ${e.name}`).join('\n') : '(empty)'}
${portfolioBlock ? `\n${portfolioBlock}\n` : ''}${markupBlock ? `\n${markupBlock}\n` : ''}${actualsBlock ? `\n${actualsBlock}\n` : ''}
TASK: produce 25–40 market hypotheses following the system prompt rules.

FORMAT — JSON ONLY:
{
  "hypotheses": [
    {
      "tier": 1|2|3,
      "title": string,          // short segment name, 2-6 words
      "description": string,    // who they are and which pain the client's product solves — up to 300 chars
      "fit_rationale": string,  // MANDATORY: the chain decision-maker → their goal → their pain the client's product removes → the client's concrete offer → why the economics work (or an honest "questionable"). Not a segment description, no tautologies — up to 350 chars
      "rationale": string,      // why they should buy: pain/trigger/budget; + "RISK: …" (economics / incompatible sales motion / similarity to specialist-rejected topics) — up to 200 chars
      "potential_pct": number,  // 0-100, before verification
      "search_queries": string[] // 2-4 fact-check queries
    }
  ]
}

LENGTH DISCIPLINE (critical): the per-field limits above are hard — write tightly and to the point, no filler or retelling. If you see you won't fit the limit — shorten the wording instead of cutting it off mid-word. The answer must be one fully closed valid JSON: 25 whole candidates are better than 40 with a truncated JSON.

Check yourself before answering: 25–40 candidates? tier 2 ≥ 8? tier 3 ≥ 8? Macro-sector checklist walked — every relevant sector covered by at least one hypothesis? No macro-sector holds more than ~25% of candidates? Does each candidate's tier reflect obviousness of the connection, not potential_pct? Do candidates with an incompatible sales motion carry "RISK: …" in the rationale? Does every candidate's fit_rationale contain all four chain links (decision-maker → goal → pain → offer) plus the fifth link — why the economics work — and not repeat the description? Do segments with unrecoverable economics have their pct cut and a "RISK: economics …" note? Does every tier-3 without a portfolio match have another evidentiary path to effectiveness? Are all titles unique? Not a single URL in the answer?`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
