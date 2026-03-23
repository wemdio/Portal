import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sanitizeContactEmail } from '@/lib/cisLeads/contactEmailPolicy';
import { isLegalEntityName } from '@/lib/cisLeads/lprRole';

const BATCH_LIMIT = 50;
const ROUTER_URL = 'https://router.requesty.ai/v1/chat/completions';
const PERPLEXITY_MODEL = 'perplexity/sonar-pro';

function getLprKey(): string {
  return (process.env.OPENROUTER_LPR_VERIFY_API_KEY ?? '').trim();
}

interface PerplexityContact {
  full_name: string;
  title: string | null;
  role: string;
  phone: string | null;
  email: string | null;
  linkedin: string | null;
  confidence: number;
}

interface PerplexityLprResult {
  website: string | null;
  contacts: PerplexityContact[];
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
  const a1 = raw.indexOf('['), a2 = raw.lastIndexOf(']');
  if (a1 !== -1 && a2 > a1) {
    try { return JSON.parse(raw.slice(a1, a2 + 1)); } catch { /* */ }
  }
  return null;
}

function parseContactsArray(arr: unknown[]): PerplexityContact[] {
  const out: PerplexityContact[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = String(row.full_name ?? row.name ?? '').trim();
    if (!name || name.length < 4) continue;
    if (isLegalEntityName(name)) continue;
    out.push({
      full_name: name,
      title: typeof row.title === 'string' ? row.title.trim() || null : null,
      role: String(row.role ?? 'director'),
      phone: typeof row.phone === 'string' ? row.phone.replace(/[\s()-]/g, '').trim() || null : null,
      email: sanitizeContactEmail(typeof row.email === 'string' ? row.email : null),
      linkedin: typeof row.linkedin === 'string' ? row.linkedin.trim() || null : null,
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.6) || 0.6)),
    });
  }
  return out;
}

function parseLprResult(text: string): PerplexityLprResult {
  const parsed = extractJson(text);

  if (Array.isArray(parsed)) {
    return { website: null, contacts: parseContactsArray(parsed) };
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const website = typeof obj.website === 'string' && obj.website.startsWith('http') ? obj.website.trim() : null;
    const contacts = Array.isArray(obj.contacts) ? parseContactsArray(obj.contacts) : [];
    return { website, contacts };
  }

  return { website: null, contacts: [] };
}

async function searchLprWithPerplexity(companyName: string, inn?: string | null): Promise<PerplexityLprResult> {
  const key = getLprKey();
  if (!key) return { website: null, contacts: [] };

  const innHint = inn ? ` (ИНН ${inn})` : '';
  const prompt = `Найди руководителей и ЛПР (лиц, принимающих решения) российской IT-компании "${companyName}"${innHint}.

Мне нужно найти МАКСИМУМ людей. Ищи на:
- rusprofile.ru, list-org.com, sbis.ru — директора, учредители
- Сайт компании (раздел "Команда", "О нас", "Контакты") — все руководители
- hh.ru — HR-контакты, иногда директора в описании компании
- LinkedIn, VK — профили сотрудников
- ЕГРЮЛ/ЕГРИП — юридические данные

Нужны ВСЕ найденные руководители и ключевые сотрудники (до 12 человек):
- Генеральный директор / CEO
- Учредители / собственники
- Коммерческий директор / директор по продажам
- Руководитель отдела продаж / Head of Sales
- Технический директор / CTO
- Директор по маркетингу / CMO
- HR-директор / руководитель отдела кадров
- Финансовый директор / CFO / Главный бухгалтер
- Руководитель отдела закупок / снабжения
- Юрист / руководитель юридического отдела
- Другие директора и руководители отделов

КРИТИЧНО:
- Для каждого человека ищи ТОЛЬКО РЕАЛЬНЫЕ ЛИЧНЫЕ контакты, которые ты НАШЁЛ на конкретных веб-страницах.
- Рабочий телефон и email (сайт компании, rusprofile, справочники)
- НЕ дублируй общий телефон приёмной или info@/sales@/office@ email компании для разных людей.
- НИКОГДА не выдумывай и не угадывай email-адреса. Если личный email не найден на реальной странице — верни null.
- НЕ генерируй email по шаблону имя@домен. Только реально найденные адреса.

Также найди ОФИЦИАЛЬНЫЙ САЙТ компании (основной домен, не rusprofile/list-org).

Верни JSON-объект:
{
  "website": "https://example.com или null",
  "contacts": [
    {
      "full_name": "Фамилия Имя Отчество",
      "title": "должность",
      "role": "owner/ceo/commercial/director/sales/marketing/it/ops/hr/finance/procurement/legal/other",
      "phone": "+7XXXXXXXXXX или null",
      "email": "email или null",
      "linkedin": "url или null",
      "confidence": 0.0-1.0
    }
  ]
}

Ответь ТОЛЬКО валидным JSON без пояснений. Если никого не найдено — {"website": null, "contacts": []}.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);

  try {
    const res = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - LPR Search - Perplexity',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 3500,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    return parseLprResult(text);
  } catch (e) {
    console.error(`[cis-leads] perplexity LPR search failed for ${companyName}:`, e instanceof Error ? e.message : e);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSerperLprEnrichment(jobId: string, userId: string): Promise<{ processed: number; contactsFound: number }> {
  if (!supabaseAdmin || !getLprKey()) return { processed: 0, contactsFound: 0 };

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
  if (companyIds.length === 0) return { processed: 0, contactsFound: 0 };

  const { data: companiesData } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name, inn')
    .in('id', companyIds)
    .limit(BATCH_LIMIT);

  if (!companiesData?.length) return { processed: 0, contactsFound: 0 };

  const { data: existingContacts } = await supabaseAdmin
    .from('company_contacts')
    .select('company_id, channel_phone, channel_email')
    .eq('user_id', userId)
    .in('company_id', companyIds);

  const contactCountWithChannels = new Map<string, number>();
  const totalContactCount = new Map<string, number>();
  for (const c of existingContacts ?? []) {
    const row = c as { company_id?: string; channel_phone?: string; channel_email?: string };
    const cid = row.company_id ?? '';
    totalContactCount.set(cid, (totalContactCount.get(cid) ?? 0) + 1);
    if (row.channel_phone || row.channel_email) {
      contactCountWithChannels.set(cid, (contactCountWithChannels.get(cid) ?? 0) + 1);
    }
  }

  const MIN_CONTACTS_TO_SKIP = 3;
  const toEnrich = (companiesData as Array<{ id: string; name: string; short_name: string | null; inn: string | null }>)
    .filter((c) => {
      const withChannels = contactCountWithChannels.get(c.id) ?? 0;
      return withChannels < MIN_CONTACTS_TO_SKIP;
    });

  if (toEnrich.length === 0) return { processed: 0, contactsFound: 0 };

  let processed = 0;
  let contactsFound = 0;

  for (const company of toEnrich.slice(0, BATCH_LIMIT)) {
    const searchName = company.short_name || company.name;

    try {
      const result = await searchLprWithPerplexity(searchName, company.inn);

      if (result.website) {
        await supabaseAdmin
          .from('companies')
          .update({ site: result.website })
          .eq('id', company.id)
          .is('site', null);
      }

      for (const contact of result.contacts.slice(0, 10)) {
        const scoreBase = contact.role === 'owner' ? 80 : contact.role === 'ceo' ? 75 : contact.role === 'commercial' ? 65 : 55;
        const score = Math.round(scoreBase + contact.confidence * 10);

        const profileLinks: Record<string, string> = {};
        if (contact.linkedin) profileLinks.linkedin = contact.linkedin;

        const sourceDetails: Record<string, string> = {};
        sourceDetails.name = 'Perplexity поиск';
        if (contact.title) sourceDetails.title = 'Perplexity поиск';
        if (contact.phone) sourceDetails.phone = 'Perplexity поиск';
        if (contact.email) sourceDetails.email = 'Perplexity поиск';
        if (contact.linkedin) sourceDetails.linkedin = 'Perplexity поиск';

        const { error } = await supabaseAdmin
          .from('company_contacts')
          .upsert(
            {
              user_id: userId,
              company_id: company.id,
              source: 'perplexity_search',
              full_name: contact.full_name,
              first_name: null,
              last_name: null,
              title: contact.title,
              role_guess: contact.role,
              channel_phone: contact.phone,
              channel_tg_username: null,
              channel_email: contact.email,
              source_url: null,
              score,
              confidence: contact.confidence,
              source_details: sourceDetails,
              ...(Object.keys(profileLinks).length > 0 ? { profile_links: profileLinks } : {}),
            },
            { onConflict: 'user_id,company_id,full_name' },
          );
        if (!error) contactsFound++;
      }

      processed++;
      console.log(`[cis-leads] perplexity LPR: ${searchName} → ${result.contacts.length} contacts, site=${result.website ?? '-'}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cis-leads] perplexity LPR failed for ${searchName}:`, msg);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429') || msg.includes('quota') || msg.includes('blocked')) {
        console.warn('[cis-leads] perplexity: blocked/rate-limited, stopping batch');
        break;
      }
    }

    if (processed < toEnrich.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { processed, contactsFound };
}
