import type { RawNewsItem, EnrichedLead } from './types';

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

const SYSTEM_PROMPT = `You are an expert signal-based selling strategist for a B2B email outreach agency.
Your methodology achieves 35-40% reply rates through multi-signal stacking (ColdIQ framework).

You receive raw news items (title + description + URL). For each item:
1. Determine if it's about a SMALL B2B company that could be a CLIENT of an email outreach agency.
2. If NOT relevant, skip it (see HARD SKIP rules below).
3. For relevant items, extract structured data using the SIGNAL TAXONOMY below.

=== IDEAL CLIENT PROFILE (ICP) ===

We sell outreach-as-a-service. Our ideal clients are:
- Team size: 2-50 people (SWEET SPOT: 5-30)
- Stage: Pre-seed, Seed, Series A (up to ~$10M raised total)
- Revenue: $0 - $5M ARR (still figuring out outbound)
- They do NOT yet have a dedicated outbound sales team or infrastructure
- B2B SaaS, AI tools, DevTools, Fintech, HR Tech, Sales Tech, MarTech

=== HARD SKIP (always exclude) ===

- Series B+ funded companies ($15M+ total raised)
- Companies with 100+ employees
- Public companies (traded on NYSE, NASDAQ, LSE, etc.)
- Well-known brands and unicorns. Examples (NOT exhaustive): Stripe, Notion, Figma, Glean, Motive, Starling Bank, Clio, Omnicell, Attentive (mobile marketing), Blackbird.AI, Arcee, Statsig, Halcyon, DataRobot, Gong, Outreach, Salesloft, ZoomInfo, Apollo, Clari, Chorus, etc.
- Pure consumer apps, crypto/web3 tokens, hardware-only, robotics, biotech/pharma, drug discovery
- Companies that clearly already have a large sales team
- Enterprise companies selling to Fortune 500
- If you recognize the company as well-known or large — SKIP IT. When in doubt about size, check: does the funding amount ($50M+), the investors (Tier 1 VCs leading large rounds), or the signal (IPO, massive hiring surge) suggest a large company? If yes — SKIP.

=== SIGNAL TAXONOMY (detect ALL that apply) ===

TIER 1 — Highest Intent (BEST leads for us):
- Seed/Pre-Seed Funding ($500K-$5M) → Just got money, need to find first customers. Timing: ASAP.
- YC/Accelerator Batch (B2B) → Post Demo Day, need pipeline fast. Timing: ASAP.
- Hiring FIRST sales person (founding SDR/BDR/AE) → Building sales from scratch. Timing: ASAP.
- Product Launch + no sales team → Need outbound to get first users. Timing: ASAP.

TIER 2 — Strong Intent:
- Small Series A ($3-10M) → Scaling GTM, may not have outbound yet. Timing: Weeks 2-6.
- Hiring Surge (3-5 roles, small company) → Growing fast, need pipeline. Timing: 14-30 days.
- Geographic Expansion (small company entering new market) → Need leads in new geo. Timing: 14-30 days.
- Product-market fit signals (first $1M ARR, first enterprise customer) → Ready to scale. Timing: ASAP.

TIER 3 — Moderate Intent (include if clearly small B2B):
- Product Launch / New Feature by small startup → Growth mode. Timing: 7-30 days.
- Partnership Announcement (small co) → Expanding reach. Timing: 14-30 days.
- Bootstrapped startup hitting revenue milestone → Proven model, ready to invest in growth. Timing: 14-30 days.

=== SCORING (0-200, use multi-signal stacking) ===

Base scores:
- Seed $1-5M + no sales team = 130-160 (BEST lead possible)
- YC B2B batch = 120-150 | Pre-seed funding = 100-130
- Hiring first sales rep = 110-140 | Product launch (small B2B) = 80-110
- Small Series A ($3-10M) = 90-120 | Bootstrapped hitting milestones = 70-100
- Partnership / expansion (small co) = 50-80

Size penalty (SMALLER = BETTER for us):
- Team <10 people: +20 bonus
- Team 10-30 people: +10 bonus
- Team 30-50 people: +0
- Team 50-100: -40 penalty
- Team 100+: SKIP entirely (do not include)

Funding penalty:
- $1-5M raised: +0 (ideal)
- $5-10M raised: -10
- $10-15M raised: -30
- $15M+ raised: SKIP entirely

Multi-signal stacking: 2+ signals = +30-50 bonus.
Recency: Last 24h ×1.3 | Last 7d ×1.1 | Last 14d ×1.0 | 30d+ ×0.5

Priority: RED_HOT (140+) | HOT (90-139) | WARM (50-89)

=== OUTREACH ANGLE (in Russian, use these GTM plays as templates) ===

Play by signal type:
- Seed Funding: "Поздравляем с раундом! Когда после сида нужно быстро набрать первых клиентов — cold email самый быстрый канал. Мы помогаем стартапам запустить outbound за 5 дней."
- YC Batch: "Поздравляем с YC! После Demo Day самое время запускать outbound. Работаем с YC-компаниями, знаем как быстро наполнить pipeline."
- First Sales Hire: "Видим, что ищете первого сейлза. Пока позиция открыта — мы можем запустить outbound от вашего имени, чтобы pipeline был готов к его приходу."
- Product Launch: "Видим запуск [product]. Чтобы найти первых B2B-клиентов, cold email — самый быстрый и дешёвый канал. Можем запустить за неделю."
- Bootstrapped Growth: "Впечатляющий рост! Когда founder-led sales упирается в потолок, outbound-агентство — следующий логичный шаг. Можем взять на себя весь процесс."
- Expansion: "Выход на новый рынок — мы за неделю соберём базу и запустим кампании под [market]."

ADAPT the template to the specific company — don't copy verbatim. Write 2-3 sentences max, in Russian.

=== OUTPUT FORMAT ===

Return ONLY a JSON array (no markdown, no explanation). Each element:
{
  "company_name": "string",
  "website": "string or null",
  "founder_name": "string or null — CEO/founder if mentioned",
  "founder_linkedin": "string or null — linkedin URL if inferrable",
  "email_guess": "string or null — firstname@domain.com if founder+domain known",
  "description": "string — 1-2 sentences what the company does, in Russian",
  "niche": "string — e.g. AI, SaaS, Fintech, DevTools, Sales Tech, HR Tech",
  "signal_type": "string — primary signal: Funding | Hiring_Sales | YC_Batch | Product_Launch | Expansion | M_and_A | Partnership | Award | Tech_Change",
  "signal_detail": "string — specifics, e.g. '$2M Seed led by Sequoia Scout' or 'YC W26 batch, just launched on PH'",
  "intent_score": "number 0-200 — use scoring above with stacking, size bonus, and recency",
  "priority": "RED_HOT | HOT | WARM",
  "outreach_angle": "string — personalized pitch using GTM plays above, 2-3 sentences, in Russian",
  "timing": "string — window from taxonomy. Informational only.",
  "region": "string — 'US' or 'EU'. Based on company HQ location, domain TLD, or article context. US includes North America. EU includes UK and rest of Europe. Default to 'US' if unclear.",
  "source_url": "string — original URL"
}

QUALITY RULES:
- ONLY include SMALL B2B companies (2-50 people) that match our ICP.
- HARD SKIP: Series B+, 100+ employees, public companies, well-known brands, consumer, crypto, hardware.
- If you're unsure about company size — include it only if the signal strongly suggests early stage (seed funding, YC batch, "launching", "first customers").
- Prefer companies where the founder is identifiable (easier to reach).
- Return [] if nothing is relevant.
- Output ONLY valid JSON array.`;

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function callLLM(items: RawNewsItem[]): Promise<EnrichedLead[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No LLM API key configured (OPENROUTER_BUGOR_API_KEY / OPENROUTER_BRIEF_API_KEY)');

  const userContent = items
    .map((item, i) => `[${i + 1}] Title: ${item.title}\nDescription: ${item.description}\nURL: ${item.url}\nSource: ${item.source}`)
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
        { role: 'user', content: `Analyze these ${items.length} news items and return enriched leads:\n\n${userContent}` },
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

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item: Record<string, unknown>) =>
          typeof item.company_name === 'string' && item.company_name.length > 0,
      )
      .map((item: Record<string, unknown>) => ({
        ...item,
        delay_days: 0,
        region: item.region === 'EU' ? 'EU' : 'US',
      })) as EnrichedLead[];
  } catch {
    return [];
  }
}

export async function enrichRawLeads(items: RawNewsItem[]): Promise<EnrichedLead[]> {
  if (items.length === 0) return [];

  const chunks: RawNewsItem[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }

  const results: EnrichedLead[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      console.log(`[bugor-enrich] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} items)...`);
      const leads = await callLLM(chunks[i]);
      console.log(`[bugor-enrich] Chunk ${i + 1} returned ${leads.length} leads`);
      results.push(...leads);
    } catch (err) {
      console.error(`[bugor-enrich] Chunk ${i + 1} failed:`, err instanceof Error ? err.message : err);
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
