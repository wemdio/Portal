import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

const SOCIAL_LIMIT = 30;
const ROUTER_URL = 'https://router.requesty.ai/v1/chat/completions';
const PERPLEXITY_MODEL = 'perplexity/sonar-pro';

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

type SocialLinks = Record<string, string>;

function parseSocialLinks(text: string): SocialLinks {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') return {};
  const row = parsed as Record<string, unknown>;
  const out: SocialLinks = {};
  for (const key of ['linkedin', 'vk', 'telegram', 'facebook', 'twitter', 'instagram', 'ok']) {
    const val = row[key];
    if (typeof val === 'string' && val.startsWith('http')) {
      out[key] = val.trim();
    }
  }
  return out;
}

async function findSocialProfiles(personName: string, companyName: string): Promise<SocialLinks> {
  const key = getLprKey();
  if (!key) return {};

  const prompt = `Найди профили в соцсетях для: ${personName}, компания "${companyName}".

Ищи в: LinkedIn, VK, Telegram (t.me), Facebook, Twitter/X, Instagram, OK.ru.

Верни ТОЛЬКО JSON-объект с найденными ссылками:
{"linkedin": "url или null", "vk": "url или null", "telegram": "url или null", "facebook": "url или null", "twitter": "url или null", "instagram": "url или null", "ok": "url или null"}

Без пояснений. Если профиль не найден — null.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - LPR Social Profiles - Perplexity',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    return parseSocialLinks(text);
  } catch (e) {
    console.error(`[cis-leads] perplexity social profiles failed for ${personName}:`, e instanceof Error ? e.message : e);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSocialProfileEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; linksFound: number }> {
  if (!supabaseAdmin || !getLprKey()) return { processed: 0, linksFound: 0 };

  const { data: leadRows } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(
    new Set((leadRows ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)),
  );
  if (companyIds.length === 0) return { processed: 0, linksFound: 0 };

  const { data: contacts } = await supabaseAdmin
    .from('company_contacts')
    .select('id, company_id, full_name, profile_links, source_details')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .order('score', { ascending: false })
    .limit(SOCIAL_LIMIT * 2);

  if (!contacts?.length) return { processed: 0, linksFound: 0 };

  const withoutProfiles = (contacts as Array<{ id: string; company_id: string; full_name: string; profile_links: Record<string, string> | null; source_details: Record<string, string> | null }>)
    .filter((c) => !c.profile_links || Object.keys(c.profile_links).length === 0)
    .slice(0, SOCIAL_LIMIT);

  if (withoutProfiles.length === 0) return { processed: 0, linksFound: 0 };

  const { data: companies } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name')
    .in('id', [...new Set(withoutProfiles.map((c) => c.company_id))]);

  const companyMap = new Map(
    (companies ?? []).map((c) => [
      String((c as { id?: unknown }).id),
      (c as { id: string; name: string; short_name: string | null }),
    ]),
  );

  let linksFound = 0;

  for (const contact of withoutProfiles) {
    const company = companyMap.get(contact.company_id);
    const companyName = company?.short_name || company?.name || '';
    if (!companyName.trim()) continue;

    try {
      const links = await findSocialProfiles(contact.full_name, companyName);
      if (Object.keys(links).length === 0) continue;

      const existing = (contact.profile_links && typeof contact.profile_links === 'object' ? contact.profile_links : {}) as Record<string, string>;
      const existingDetails = (contact.source_details && typeof contact.source_details === 'object' ? contact.source_details : {}) as Record<string, string>;
      const merged = { ...existing };
      const mergedDetails = { ...existingDetails };
      for (const [k, v] of Object.entries(links)) {
        if (v && !merged[k]) {
          merged[k] = v;
          mergedDetails[k] = 'Perplexity соцсети';
          linksFound++;
        }
      }

      await supabaseAdmin
        .from('company_contacts')
        .update({ profile_links: merged, source_details: mergedDetails })
        .eq('id', contact.id)
        .eq('user_id', userId);

      console.log(`[cis-leads] perplexity social: ${contact.full_name} → ${Object.keys(links).join(', ')}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429') || msg.includes('blocked')) {
        console.warn('[cis-leads] perplexity social: blocked/rate-limited, stopping');
        break;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { processed: withoutProfiles.length, linksFound };
}
