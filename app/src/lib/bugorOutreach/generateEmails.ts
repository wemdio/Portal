import type { BugorLead, EmailStep, SenderConfig } from './types';

const LLM_URL = 'https://router.requesty.ai/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4';
const CONCURRENCY = 3;

function getApiKey(): string {
  return (
    process.env.OPENROUTER_BUGOR_API_KEY ??
    process.env.OPENROUTER_BRIEF_API_KEY ??
    ''
  ).trim();
}

function buildSystemPrompt(sender: SenderConfig): string {
  return `You are an expert cold email copywriter for a B2B lead generation agency. You write highly personalized, signal-based outreach emails that achieve 25-35% reply rates.

SENDER IDENTITY:
- Name: ${sender.sender_name}
- Agency: ${sender.sender_website}
- Booking link: ${sender.sender_calendly}

YOUR STYLE (study these reference emails carefully — match their tone, structure, brevity):

--- REFERENCE EMAIL 1 (opener) ---
Hi!
I reviewed your project.
As a founder, it's crucial to constantly find new partners, investors, or early enterprise clients. This consumes the lion's share of your time.
We specialize in targeted outreach for projects. We help find and warm up the exact contacts critical for your growth. I can show you how it works in 15 minutes using examples from your niche.
We're also flexible in how we work - including performance-based models like pay-per-MQL and booked calls.
I suggest we consider and discuss both options: lead generation for you or building partnerships. Do you have a slot this week?
Best Regards,
${sender.sender_name}
${sender.sender_calendly}

--- REFERENCE EMAIL 2 (follow-up) ---
I wrote to you last week about your project and our lead generation approach.
The core idea: we don't spam. We build a bridge between your complex product and an audience already prepared to understand it. For example, for a DeFi protocol, we find fund managers or traders; for an infrastructure project — developers in large companies.
We've developed our own AI dialer and AI outreach for Telegram, email, and LinkedIn. Let us bring leads to your clients.
Pricing is flexible as well, with performance-based options like pay-per-MQL and booked calls.
Even if it's not a priority right now, I can send a couple of examples of our emails for projects in your stack. Interested?
Best Regards,
${sender.sender_name}
${sender.sender_calendly}

--- REFERENCE EMAIL 3 (final touch) ---
Hi!
One more thought I wanted to share.
Our hypothesis for you: we can systematically help find contacts in specific segment. This would allow your client's team to focus on product development.
If the hypothesis resonates — we'd be glad to have a short call this week.
By the way, we are ready to work on a pay-per-lead basis. Both with you and for your clients.
We're also open to performance-based cooperation, including pay-per-MQL and booked calls.
Best Regards,
${sender.sender_name}
${sender.sender_calendly}

RULES:
1. Write in ENGLISH only.
2. Each email: short paragraphs (1-3 sentences each), casual but professional tone.
3. Step 1 (Day 0): Reference the SPECIFIC signal in words (never paste URLs/links to articles). Mention why NOW is the right time. Clear CTA for a short call.
4. Step 2 (Day 3): Add value — explain HOW your outreach process works for their niche (AI dialer, Telegram/email/LinkedIn, targeted list building). Mention flexible pricing (pay-per-MQL, booked calls). Don't repeat Step 1. NEVER invent case studies, statistics, or client results.
5. Step 3 (Day 7): Final touch with a NEW angle. Offer a hypothesis about how you can help. NEVER announce it's the last email, never ask to reply "not interested"/"not now", never promise to stop writing, never apologize for bothering — that's the #1 mass-spam marker. Low-pressure CTA.
6. Always end with: "Best Regards,\\n${sender.sender_name}\\n${sender.sender_calendly}"
7. Subject lines: short (3-7 words), lowercase-friendly, no clickbait. Different for each step.
8. DO NOT include links to news articles, press releases, or any source URLs in the email body.
9. Personalize heavily — use company name, signal details, niche, and founder name when available. If "Company Context" is provided, reference their SPECIFIC product/service and how outreach can help THEIR particular use case. Mention what they do or who their customers are to show you've done your homework.
10. NEVER invent case studies, client names, statistics, or specific results (e.g. "we helped X book 40 calls"). You don't have this data. Instead, describe your process and offer to show examples on a call.
11. When Company Context is available, tailor your outreach angle to their specific product. For example: if they sell a DevOps tool, mention reaching engineering leaders; if they sell HR software, mention reaching HR directors at mid-market companies. Be specific about WHO you can help them reach.

OUTPUT: Return ONLY a JSON array of 3 objects (no markdown, no explanation):
[
  { "subject": "...", "body": "..." },
  { "subject": "...", "body": "..." },
  { "subject": "...", "body": "..." }
]`;
}

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function generateForOne(lead: BugorLead, sender: SenderConfig, companyContext?: string | null): Promise<EmailStep[] | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const contextBlock = companyContext
    ? `\nCompany Context (from their website — use this to personalize!):\n${companyContext}`
    : '';

  const userPrompt = `Generate a 3-email sequence for this lead:

Company: ${lead.company_name}
Website: ${lead.website ?? 'unknown'}
Founder: ${lead.founder_name ?? 'unknown'}
Description: ${lead.description}
Niche: ${lead.niche}
Signal Type: ${lead.signal_type}
Signal Detail: ${lead.signal_detail}
Intent Score: ${lead.intent_score}
Priority: ${lead.priority}
Timing: ${lead.timing}${contextBlock}`;

  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: [{ type: 'text', text: buildSystemPrompt(sender), cache_control: { type: 'ephemeral' } }] },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[bugor-genEmails] LLM error ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as LLMResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '[]';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length < 3) return null;

    return parsed.slice(0, 3).map((step: Record<string, unknown>) => ({
      subject: String(step.subject ?? ''),
      body: String(step.body ?? ''),
    }));
  } catch (err) {
    console.error(`[bugor-genEmails] Failed for ${lead.company_name}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface GenerateResult {
  id: string;
  sequence: EmailStep[] | null;
}

export async function generateEmailSequences(
  leads: BugorLead[],
  sender: SenderConfig,
  companyContexts?: Map<string, string>,
): Promise<GenerateResult[]> {
  const results: GenerateResult[] = [];
  let generated = 0;
  let failed = 0;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (lead) => {
        const ctx = companyContexts?.get(lead.id) ?? null;
        console.log(`[bugor-genEmails] Generating for ${lead.company_name}${ctx ? ' (with context)' : ''}...`);
        const sequence = await generateForOne(lead, sender, ctx);
        return { id: lead.id, sequence };
      }),
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
        if (r.value.sequence) generated++;
        else failed++;
      } else {
        failed++;
      }
    }
  }

  console.log(`[bugor-genEmails] Generated=${generated}, Failed=${failed}`);
  return results;
}
