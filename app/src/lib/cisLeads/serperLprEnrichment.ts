import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { serperSearchDetailed } from '@/lib/parsers/serperSearch';
import { guessLprRoleFromPost } from '@/lib/cisLeads/lprRole';
import { hasFioStructure } from '@/lib/cisLeads/fioStructure';

const SERPER_BATCH_LIMIT = 20;

function hasSerperKey(): boolean {
  return (process.env.SERPER_API_KEY ?? '').trim().length > 0;
}

interface ExtractedContact {
  full_name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  context: string;
}

const PHONE_PATTERN = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** «Фамилия Имя» — key for dedup; strips patronymic */
function nameDedupeKey(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]!.toLowerCase()} ${parts[1]!.toLowerCase()}`;
  }
  return fullName.toLowerCase();
}

type AiLprDecision = {
  name: string;
  is_lpr: boolean;
  role: string;
  title: string | null;
  confidence: number;
};

function hasLprAiKey(): boolean {
  return (process.env.OPENROUTER_LPR_VERIFY_API_KEY_V2 ?? process.env.OPENROUTER_EMAIL_SEQUENCE_API_KEY ?? '').trim().length > 0;
}

async function decideLprWithAI(candidates: Array<{ name: string; context: string }>): Promise<Map<string, AiLprDecision>> {
  const key = (process.env.OPENROUTER_LPR_VERIFY_API_KEY_V2 ?? process.env.OPENROUTER_EMAIL_SEQUENCE_API_KEY ?? '').trim();
  const out = new Map<string, AiLprDecision>();
  if (!key || candidates.length === 0) return out;

  const extractJson = (text: string): unknown | null => {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    // Strip fenced code blocks like ```json ... ``` or ``` ... ```
    const unfenced = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    // Try direct parse first
    try {
      return JSON.parse(unfenced);
    } catch {
      // fallthrough
    }

    // Try to locate a JSON array/object inside the text.
    const firstArray = unfenced.indexOf('[');
    const lastArray = unfenced.lastIndexOf(']');
    if (firstArray !== -1 && lastArray !== -1 && lastArray > firstArray) {
      const slice = unfenced.slice(firstArray, lastArray + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // ignore
      }
    }

    const firstObj = unfenced.indexOf('{');
    const lastObj = unfenced.lastIndexOf('}');
    if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
      const slice = unfenced.slice(firstObj, lastObj + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // ignore
      }
    }

    return null;
  };

  const payload = candidates.slice(0, 12).map((c, idx) => ({
    id: idx + 1,
    name: c.name,
    context: c.context.slice(0, 280),
  }));

  const prompt = `Ты помогаешь CRM найти ЛПР (лицо, принимающее решение) по компании по фрагментам текста из поиска.
Для каждого кандидата реши, является ли это человек-ЛПР/руководитель/владелец или релевантное руководство, а не случайное упоминание/лауреат/организация.

Верни ТОЛЬКО валидный JSON-массив, без пояснений. Формат элемента:
{"name": string, "is_lpr": boolean, "role": "owner|ceo|commercial|director|it|hr|sales|marketing|ops|other", "title": string|null, "confidence": number}

Правила:
- name — как во входе
- confidence 0..1
- title — должность (если можно извлечь из контекста), иначе null

Вход:
${JSON.stringify(payload, null, 2)}`;

  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://portal.local',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 700,
        temperature: 0,
      }),
      signal: (() => {
        const c = new AbortController();
        setTimeout(() => c.abort(), 20000);
        return c.signal;
      })(),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    const parsedAny = extractJson(text);
    const parsed = Array.isArray(parsedAny) ? (parsedAny as AiLprDecision[]) : null;
    if (!parsed) return out;
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const name = String((row as { name?: unknown }).name ?? '').trim();
      if (!name) continue;
      out.set(name, {
        name,
        is_lpr: Boolean((row as { is_lpr?: unknown }).is_lpr),
        role: String((row as { role?: unknown }).role ?? 'other'),
        title: typeof (row as { title?: unknown }).title === 'string' ? String((row as { title?: unknown }).title).trim() : null,
        confidence: Math.max(0, Math.min(1, Number((row as { confidence?: unknown }).confidence ?? 0.5) || 0.5)),
      });
    }
    return out;
  } catch (e) {
    console.warn('[cis-leads] AI LPR decision failed:', e instanceof Error ? e.message : e);
    return out;
  }
}

/**
 * Универсальная AI-проверка: только ФИО, без чёрных списков.
 * LLM решает, что является именем человека.
 */
async function filterPersonNamesWithAI(candidates: string[]): Promise<Set<string>> {
  const key = (process.env.OPENROUTER_LPR_VERIFY_API_KEY_V2 ?? process.env.OPENROUTER_EMAIL_SEQUENCE_API_KEY ?? '').trim();
  if (!key || candidates.length === 0) return new Set(candidates);

  const list = candidates.slice(0, 20).join('\n');
  const prompt = `Задача: из списка выбери ТОЛЬКО полные ФИО людей (Фамилия Имя Отчество или Фамилия Имя).
Критерий: это должно быть имя конкретного человека, а не компания, организация, город, должность, бренд.

Список:
${list}

Ответь ТОЛЬКО через запятую те строки, которые являются ФИО человека. Без пояснений. Если подходящих нет — ответь "нет".`;

  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://portal.local',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0,
      }),
      signal: (() => {
        const c = new AbortController();
        setTimeout(() => c.abort(), 15000);
        return c.signal;
      })(),
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    if (/^нет\b/i.test(text) || !text) return new Set();
    const approvedLower = new Set(
      text.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 5),
    );
    const kept = new Set<string>();
    for (const c of candidates) {
      const cl = c.trim().toLowerCase();
      if (approvedLower.has(cl)) kept.add(c);
      else {
        const match = [...approvedLower].find((a) => a.includes(cl) || cl.includes(a));
        if (match && Math.abs(match.length - cl.length) < 15) kept.add(c);
      }
    }
    return kept;
  } catch (e) {
    console.warn('[cis-leads] AI LPR verification failed:', e instanceof Error ? e.message : e);
    return new Set();
  }
}

/**
 * Extract person names from snippets (no static title keyword lists).
 * AI later decides if they're an LPR and which role.
 */
function extractContactsFromSnippets(snippets: string[]): ExtractedContact[] {
  const byKey = new Map<string, ExtractedContact>();

  for (const snippet of snippets) {
    const text = snippet.replace(/\s+/g, ' ');
    const phones = text.match(PHONE_PATTERN) ?? [];
    const emails = text.match(EMAIL_PATTERN) ?? [];

    const RU_NAME_PATTERN = /([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/g;
    let match: RegExpExecArray | null;
    while ((match = RU_NAME_PATTERN.exec(text)) !== null) {
      const trimmed = match[1]!.trim();
      if (trimmed.length < 5 || !hasFioStructure(trimmed)) continue;

      const namePos = match.index;
      const key = nameDedupeKey(trimmed);
      const existing = byKey.get(key);
      const context = text.slice(Math.max(0, namePos - 90), Math.min(text.length, namePos + trimmed.length + 140)).trim();

      const phone = phones[0]?.replace(/[\s()-]/g, '') ?? null;
      const email = emails[0]?.toLowerCase() ?? null;

      if (existing) {
        if (trimmed.length > existing.full_name.length) existing.full_name = trimmed;
        if (!existing.context && context) existing.context = context;
        if (!existing.phone && phone) existing.phone = phone;
        if (!existing.email && email) existing.email = email;
      } else {
        byKey.set(key, { full_name: trimmed, title: null, phone, email, context });
      }
    }
  }

  return Array.from(byKey.values());
}

export async function runSerperLprEnrichment(jobId: string, userId: string): Promise<{ processed: number; contactsFound: number }> {
  if (!supabaseAdmin || !hasSerperKey()) return { processed: 0, contactsFound: 0 };

  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(new Set((leads ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)));
  if (companyIds.length === 0) return { processed: 0, contactsFound: 0 };

  const { data: companiesWithoutContacts } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name, inn')
    .in('id', companyIds)
    .limit(SERPER_BATCH_LIMIT);

  if (!companiesWithoutContacts?.length) return { processed: 0, contactsFound: 0 };

  const { data: existingContacts } = await supabaseAdmin
    .from('company_contacts')
    .select('company_id, channel_phone, channel_email')
    .eq('user_id', userId)
    .in('company_id', companyIds);

  const companiesWithChannels = new Set<string>();
  for (const c of existingContacts ?? []) {
    const row = c as { company_id?: string; channel_phone?: string; channel_email?: string };
    if (row.channel_phone || row.channel_email) {
      companiesWithChannels.add(row.company_id ?? '');
    }
  }

  const toEnrich = (companiesWithoutContacts as Array<{ id: string; name: string; short_name: string | null; inn: string | null }>)
    .filter((c) => !companiesWithChannels.has(c.id));

  if (toEnrich.length === 0) return { processed: 0, contactsFound: 0 };

  let processed = 0;
  let contactsFound = 0;

  for (const company of toEnrich.slice(0, SERPER_BATCH_LIMIT)) {
    const searchName = company.short_name || company.name;
    const query = `"${searchName}" руководство контакты телефон email`;

    try {
      const { results } = await serperSearchDetailed(query, { num: 10, gl: 'ru', hl: 'ru' });
      const snippets = results.map((r) => `${r.title} ${r.snippet}`).filter(Boolean);
      let extracted = extractContactsFromSnippets(snippets);

      const names = extracted.map((c) => c.full_name);
      if (names.length > 0) {
        const approved = await filterPersonNamesWithAI(names);
        extracted = extracted.filter((c) => approved.has(c.full_name));
      }

      const aiMap = hasLprAiKey()
        ? await decideLprWithAI(extracted.map((c) => ({ name: c.full_name, context: c.context })))
        : new Map<string, AiLprDecision>();

      for (const contact of extracted.slice(0, 8)) {
        const ai = aiMap.get(contact.full_name) ?? null;
        if (ai && !ai.is_lpr) continue;

        const role = ai?.role
          ? ai.role
          : guessLprRoleFromPost(contact.title);
        const title = (ai?.title ?? contact.title) || null;
        const confidence = ai?.confidence ?? 0.5;
        const baseScore = role === 'owner' ? 80 : role === 'ceo' ? 75 : role === 'commercial' ? 65 : role === 'director' ? 55 : 45;
        const score = Math.round(baseScore + confidence * 10);

        const { error } = await supabaseAdmin
          .from('company_contacts')
          .upsert(
            {
              user_id: userId,
              company_id: company.id,
              source: 'serper_search',
              full_name: contact.full_name,
              first_name: null,
              last_name: null,
              title,
              role_guess: role,
              channel_phone: contact.phone,
              channel_tg_username: null,
              channel_email: contact.email,
              source_url: results[0]?.link ?? null,
              score,
              confidence,
            },
            { onConflict: 'user_id,company_id,full_name' },
          );
        if (!error) contactsFound++;
      }

      processed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cis-leads] serperLprEnrichment failed for ${searchName}:`, msg);
      if (msg.includes('Not enough credits') || msg.includes('401') || msg.includes('403')) {
        console.warn('[cis-leads] serperLprEnrichment: API credits exhausted, stopping batch');
        break;
      }
    }

    if (processed < toEnrich.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return { processed, contactsFound };
}
