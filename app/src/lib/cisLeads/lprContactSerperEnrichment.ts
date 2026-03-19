import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sanitizeContactEmail } from '@/lib/cisLeads/contactEmailPolicy';

const PERSONAL_LIMIT = 50;
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
    email: sanitizeContactEmail(typeof row.email === 'string' ? row.email : null),
    linkedin: typeof row.linkedin === 'string' ? row.linkedin.trim() || null : null,
  };
}

async function findContactChannels(personName: string, companyName: string, title?: string | null): Promise<ContactChannels> {
  const key = getLprKey();
  if (!key) return { phone: null, email: null, linkedin: null };

  const titleHint = title ? `, должность: ${title}` : '';
  const prompt = `Найди контактные данные: ${personName}${titleHint}, компания "${companyName}" (Россия).

Где искать (проверь ВСЕ источники):
1. Сайт компании "${companyName}" — раздел "Контакты", "Команда", "О нас"
2. rusprofile.ru — карточка компании, раздел руководство
3. list-org.com — страница компании
4. hh.ru — вакансии компании (контакты HR, иногда указан телефон приёмной)
5. LinkedIn — профиль "${personName}"
6. sbis.ru, checko.ru — карточка компании
7. 2gis.ru, yandex.ru/maps — контакты организации

ВАЖНО: если личный контакт не найден, верни общий телефон/email компании.

Верни ТОЛЬКО JSON:
{"phone": "+7XXXXXXXXXX или null", "email": "email или null", "linkedin": "url или null"}

Без пояснений.`;

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
    .select('id, company_id, full_name, title, source_details')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .is('channel_phone', null)
    .is('channel_email', null)
    .order('score', { ascending: false })
    .limit(PERSONAL_LIMIT * 2);

  if (!contactsWithoutChannels?.length) return { processed: 0, contactsUpdated: 0 };

  const companyIdSet = new Set(companyIds);
  const byCompany = new Map<string, Array<{ id: string; company_id: string; full_name: string; title: string | null; source_details: Record<string, string> | null }>>();
  for (const c of contactsWithoutChannels as Array<{ id: string; company_id: string; full_name: string; title: string | null; source_details: Record<string, string> | null }>) {
    if (!companyIdSet.has(c.company_id)) continue;
    const list = byCompany.get(c.company_id) ?? [];
    if (list.length < 3) list.push(c);
    byCompany.set(c.company_id, list);
  }

  const toEnrich: Array<{ id: string; company_id: string; full_name: string; title: string | null; source_details: Record<string, string> | null }> = [];
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
      const channels = await findContactChannels(contact.full_name, companyName, contact.title);
      const update: Record<string, unknown> = {};
      const existingDetails = (contact.source_details && typeof contact.source_details === 'object' ? contact.source_details : {}) as Record<string, string>;
      const mergedDetails = { ...existingDetails };
      if (channels.phone) { update.channel_phone = channels.phone; mergedDetails.phone = 'Perplexity персональный поиск'; }
      if (channels.email) { update.channel_email = channels.email; mergedDetails.email = 'Perplexity персональный поиск'; }
      if (channels.linkedin) { mergedDetails.linkedin = 'Perplexity персональный поиск'; }
      if (Object.keys(update).length === 0) continue;
      update.source_details = mergedDetails;

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
