import * as cheerio from 'cheerio';

const FETCH_TIMEOUT = 12_000;
const LLM_URL = 'https://router.requesty.ai/v1/chat/completions';
const MODEL = 'policy/gemini-flash';
const MAX_TEXT_LENGTH = 4000;

function getApiKey(): string {
  return (
    process.env.OPENROUTER_BUGOR_API_KEY ??
    process.env.OPENROUTER_BRIEF_API_KEY ??
    ''
  ).trim();
}

async function fetchPageText(url: string): Promise<string> {
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const res = await fetch(fullUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!res.ok) return '';
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer, iframe, noscript, svg, [role="navigation"], .cookie-banner, .popup').remove();

  const metaDesc = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const ogDesc = $('meta[property="og:description"]').attr('content')?.trim() ?? '';
  const h1 = $('h1').first().text().trim();
  const title = $('title').text().trim();

  const bodyText = $('main, [role="main"], article, .hero, .content, #content, .about')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  const fallbackBody = bodyText || $('body').text().replace(/\s+/g, ' ').trim();

  const parts = [
    title && `Title: ${title}`,
    h1 && h1 !== title && `H1: ${h1}`,
    metaDesc && `Meta: ${metaDesc}`,
    ogDesc && ogDesc !== metaDesc && `OG: ${ogDesc}`,
    fallbackBody && `Body: ${fallbackBody.slice(0, MAX_TEXT_LENGTH)}`,
  ].filter(Boolean);

  return parts.join('\n');
}

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function summarizeWithLLM(pageText: string, companyName: string): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey || !pageText) return null;

  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: `Based on this website content for "${companyName}", answer in 2-4 concise sentences:
1. What does this company do? What is their main product/service?
2. Who are their target customers (industry, company size, job titles)?
3. What problem do they solve?

Website content:
${pageText.slice(0, 3000)}

Reply in English. Be specific about the product, not generic. If the content is unclear or not enough, say "unclear".`,
        },
      ],
      max_tokens: 300,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as LLMResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content || content.toLowerCase().includes('unclear')) return null;
  return content;
}

/**
 * Scrapes the company website and returns a concise LLM-generated summary
 * of what the company does, their product, and target customers.
 */
export async function scrapeCompanyContext(
  website: string | null,
  companyName: string,
): Promise<string | null> {
  if (!website) return null;

  try {
    const pageText = await fetchPageText(website);
    if (!pageText || pageText.length < 50) return null;

    return await summarizeWithLLM(pageText, companyName);
  } catch (err) {
    console.warn(`[bugor-context] Failed to scrape ${website}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
