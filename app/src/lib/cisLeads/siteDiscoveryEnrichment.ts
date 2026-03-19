import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

const BATCH_LIMIT = 40;
const ROUTER_URL = 'https://router.requesty.ai/v1/chat/completions';
const PERPLEXITY_MODEL = 'perplexity/sonar';

function getLprKey(): string {
  return (process.env.OPENROUTER_LPR_VERIFY_API_KEY ?? '').trim();
}

function extractJson(text: string): unknown | null {
  const raw = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try { return JSON.parse(raw); } catch { /* */ }
  const o1 = raw.indexOf('{'), o2 = raw.lastIndexOf('}');
  if (o1 !== -1 && o2 > o1) {
    try { return JSON.parse(raw.slice(o1, o2 + 1)); } catch { /* */ }
  }
  return null;
}

const BLACKLISTED_DOMAINS = new Set([
  'rusprofile.ru', 'list-org.com', 'sbis.ru', 'checko.ru',
  'kartoteka.ru', 'egrul.nalog.ru', 'focus.kontur.ru',
  'hh.ru', 'linkedin.com', 'vk.com', 'facebook.com',
  'instagram.com', 'twitter.com', 'x.com', 'ok.ru',
  'wikipedia.org', 'ru.wikipedia.org', 'youtube.com',
  'habr.com', 'vc.ru', 'spark-interfax.ru',
]);

function isCompanyDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return !BLACKLISTED_DOMAINS.has(host);
  } catch {
    return false;
  }
}

interface SiteBatchResult {
  [companyKey: string]: string | null;
}

async function discoverSitesBatch(
  companies: Array<{ key: string; name: string; inn: string | null }>,
): Promise<SiteBatchResult> {
  const key = getLprKey();
  if (!key) return {};

  const list = companies.map((c) => {
    const innHint = c.inn ? ` (ИНН ${c.inn})` : '';
    return `- "${c.name}"${innHint} → key: "${c.key}"`;
  }).join('\n');

  const prompt = `Найди официальные сайты следующих российских IT-компаний.
Нужен ОСНОВНОЙ сайт компании (НЕ rusprofile, НЕ list-org, НЕ hh.ru, НЕ соцсети).

${list}

Верни JSON-объект, где ключ — key компании, значение — URL сайта или null:
{"key1": "https://example.com", "key2": null, ...}

ТОЛЬКО валидный JSON, без пояснений.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Site Discovery - Perplexity',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') return {};

    const result: SiteBatchResult = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith('http') && isCompanyDomain(v)) {
        result[k] = v.trim();
      }
    }
    return result;
  } catch (e) {
    console.error('[cis-leads] siteDiscovery batch failed:', e instanceof Error ? e.message : e);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSiteDiscoveryEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; sitesFound: number }> {
  if (!supabaseAdmin || !getLprKey()) return { processed: 0, sitesFound: 0 };

  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(new Set(
    (leads ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean),
  ));
  if (companyIds.length === 0) return { processed: 0, sitesFound: 0 };

  const { data: companiesWithoutSite } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name, inn')
    .in('id', companyIds)
    .is('site', null)
    .limit(BATCH_LIMIT * 2);

  if (!companiesWithoutSite?.length) return { processed: 0, sitesFound: 0 };

  const companies = (companiesWithoutSite as Array<{ id: string; name: string; short_name: string | null; inn: string | null }>)
    .slice(0, BATCH_LIMIT);

  const CHUNK_SIZE = 10;
  let sitesFound = 0;

  for (let i = 0; i < companies.length; i += CHUNK_SIZE) {
    const chunk = companies.slice(i, i + CHUNK_SIZE);
    const input = chunk.map((c) => ({
      key: c.id,
      name: c.short_name || c.name,
      inn: c.inn,
    }));

    try {
      const result = await discoverSitesBatch(input);

      for (const company of chunk) {
        const site = result[company.id];
        if (!site) continue;

        const { error } = await supabaseAdmin
          .from('companies')
          .update({ site })
          .eq('id', company.id)
          .is('site', null);

        if (!error) {
          sitesFound++;
          console.log(`[cis-leads] siteDiscovery: ${company.short_name || company.name} → ${site}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429') || msg.includes('blocked')) {
        console.warn('[cis-leads] siteDiscovery: blocked/rate-limited, stopping');
        break;
      }
    }

    if (i + CHUNK_SIZE < companies.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { processed: companies.length, sitesFound };
}
