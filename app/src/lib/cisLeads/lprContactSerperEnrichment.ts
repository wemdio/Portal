import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

const PERSONAL_LIMIT = 25;
const ROUTER_URL = 'https://router.requesty.ai/v1/chat/completions';
const PERPLEXITY_MODEL = 'perplexity/sonar-pro';

function getLprKey(): string {
  return (process.env.OPENROUTER_LPR_VERIFY_API_KEY ?? '').trim();
}

interface ContactChannels {
  phone: string | null;
  email: string | null;
  linkedin: string | null;
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

function parseChannels(text: string): ContactChannels {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') return { phone: null, email: null, linkedin: null };
  const row = parsed as Record<string, unknown>;
  return {
    phone: typeof row.phone === 'string' ? row.phone.replace(/[\s()-]/g, '').trim() || null : null,
    email: typeof row.email === 'string' ? row.email.trim().toLowerCase() || null : null,
    linkedin: typeof row.linkedin === 'string' ? row.linkedin.trim() || null : null,
  };
}

async function findContactChannels(personName: string, companyName: string): Promise<ContactChannels> {
  const key = getLprKey();
  if (!key) return { phone: null, email: null, linkedin: null };

  const prompt = `Найди контактные данные человека: ${personName}, компания "${companyName}".

Ищи в открытых источниках: сайт компании, ЕГРЮЛ, hh.ru, LinkedIn, справочники, Rusprofile, Контур.Фокус.
Если личный телефон не найден — подойдёт общий телефон компании или приёмной.
Если личный email не найден — подойдёт общий email компании (info@, office@).

Верни ТОЛЬКО валидный JSON-объект:
{"phone": "+7XXXXXXXXXX или null", "email": "email или null", "linkedin": "url или null"}

Без пояснений. Если ничего не найдено — {"phone": null, "email": null, "linkedin": null}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - LPR Contact Enrich - Perplexity',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    return parseChannels(text);
  } catch (e) {
    console.error(`[cis-leads] perplexity contact enrich failed for ${personName}:`, e instanceof Error ? e.message : e);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runLprContactSerperEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; contactsUpdated: number }> {
  if (!supabaseAdmin || !getLprKey()) return { processed: 0, contactsUpdated: 0 };

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
  if (companyIds.length === 0) return { processed: 0, contactsUpdated: 0 };

  const { data: contactsWithoutChannels } = await supabaseAdmin
    .from('company_contacts')
    .select('id, company_id, full_name')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .is('channel_phone', null)
    .is('channel_email', null)
    .order('score', { ascending: false })
    .limit(PERSONAL_LIMIT * 2);

  if (!contactsWithoutChannels?.length) return { processed: 0, contactsUpdated: 0 };

  const companyIdSet = new Set(companyIds);
  const byCompany = new Map<string, Array<{ id: string; company_id: string; full_name: string }>>();
  for (const c of contactsWithoutChannels as Array<{ id: string; company_id: string; full_name: string }>) {
    if (!companyIdSet.has(c.company_id)) continue;
    const list = byCompany.get(c.company_id) ?? [];
    if (list.length < 2) list.push(c);
    byCompany.set(c.company_id, list);
  }

  const toEnrich: Array<{ id: string; company_id: string; full_name: string }> = [];
  for (const list of byCompany.values()) {
    toEnrich.push(...list);
    if (toEnrich.length >= PERSONAL_LIMIT) break;
  }

  const { data: companies } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name')
    .in('id', [...new Set(toEnrich.map((c) => c.company_id))]);

  const companyMap = new Map(
    (companies ?? []).map((c) => [
      String((c as { id?: unknown }).id),
      (c as { id: string; name: string; short_name: string | null }),
    ]),
  );

  let contactsUpdated = 0;

  for (const contact of toEnrich) {
    const company = companyMap.get(contact.company_id);
    const companyName = company?.short_name || company?.name || '';
    if (!companyName.trim()) continue;

    try {
      const channels = await findContactChannels(contact.full_name, companyName);
      const update: Record<string, string | null> = {};
      if (channels.phone) update.channel_phone = channels.phone;
      if (channels.email) update.channel_email = channels.email;
      if (Object.keys(update).length === 0) continue;

      const { error } = await supabaseAdmin
        .from('company_contacts')
        .update(update)
        .eq('id', contact.id)
        .eq('user_id', userId);

      if (!error) {
        contactsUpdated++;
        console.log(`[cis-leads] perplexity contact enrich: ${contact.full_name} → phone=${channels.phone ?? '-'} email=${channels.email ?? '-'}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429') || msg.includes('blocked')) {
        console.warn('[cis-leads] perplexity contact enrich: blocked/rate-limited, stopping');
        break;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { processed: toEnrich.length, contactsUpdated };
}
