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
}

const PHONE_PATTERN = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const TITLE_KEYWORDS = [
  'директор', 'руководитель', 'генеральный', 'коммерческий', 'основатель',
  'владелец', 'собственник', 'president', 'ceo', 'coo', 'cfo', 'cto',
  'founder', 'owner', 'director', 'head',
];

const JOB_TITLE_PREFIX = new Set([
  'директор', 'руководитель', 'генеральный', 'коммерческий', 'основатель',
  'владелец', 'собственник', 'президент', 'учредитель', 'менеджер',
]);

function stripJobTitleFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  while (parts.length >= 2 && JOB_TITLE_PREFIX.has(parts[0]!.toLowerCase())) {
    parts.shift();
  }
  return parts.join(' ').trim();
}

/** «Фамилия Имя» — key for dedup; strips patronymic */
function nameDedupeKey(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]!.toLowerCase()} ${parts[1]!.toLowerCase()}`;
  }
  return fullName.toLowerCase();
}

/**
 * Универсальная AI-проверка: только ФИО, без чёрных списков.
 * LLM решает, что является именем человека.
 */
async function filterPersonNamesWithAI(candidates: string[]): Promise<Set<string>> {
  const key = (process.env.OPENROUTER_LPR_VERIFY_API_KEY ?? process.env.OPENROUTER_EMAIL_SEQUENCE_API_KEY ?? '').trim();
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
 * Only extract names that appear within ±60 chars of a title keyword.
 * Requires explicit mention of job title nearby.
 */
function extractContactsFromSnippets(snippets: string[]): ExtractedContact[] {
  const byKey = new Map<string, ExtractedContact>();

  for (const snippet of snippets) {
    const text = snippet.replace(/\s+/g, ' ');
    const phones = text.match(PHONE_PATTERN) ?? [];
    const emails = text.match(EMAIL_PATTERN) ?? [];
    const lower = text.toLowerCase();

    const titlePositions: Array<{ pos: number; keyword: string }> = [];
    for (const kw of TITLE_KEYWORDS) {
      let idx = lower.indexOf(kw);
      while (idx !== -1) {
        titlePositions.push({ pos: idx, keyword: kw });
        idx = lower.indexOf(kw, idx + kw.length);
      }
    }
    if (titlePositions.length === 0) continue;

    const RU_NAME_PATTERN = /([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/g;
    let match: RegExpExecArray | null;
    while ((match = RU_NAME_PATTERN.exec(text)) !== null) {
      let trimmed = match[1]!.trim();
      trimmed = stripJobTitleFromName(trimmed);
      if (trimmed.length < 5 || !hasFioStructure(trimmed)) continue;

      const namePos = match.index;
      const nearTitle = titlePositions.some(
        (t) => Math.abs(t.pos - namePos) < 60,
      );
      if (!nearTitle) continue;

      const key = nameDedupeKey(trimmed);
      const existing = byKey.get(key);

      let title: string | null = null;
      const closest = titlePositions.reduce((best, t) =>
        Math.abs(t.pos - namePos) < Math.abs(best.pos - namePos) ? t : best,
      );
      let rawTitle = text.slice(closest.pos, closest.pos + closest.keyword.length + 35).trim();
      rawTitle = rawTitle.replace(/\s*[-–—]\s*.*$/, '').trim();
      rawTitle = rawTitle.replace(/[.,;:].*$/, '').trim();
      title = rawTitle.length > 2 && rawTitle.length < 80 ? rawTitle : null;

      const phone = phones[0]?.replace(/[\s()-]/g, '') ?? null;
      const email = emails[0]?.toLowerCase() ?? null;

      if (existing) {
        if (trimmed.length > existing.full_name.length) existing.full_name = trimmed;
        if (!existing.title && title) existing.title = title;
        if (!existing.phone && phone) existing.phone = phone;
        if (!existing.email && email) existing.email = email;
      } else {
        byKey.set(key, { full_name: trimmed, title, phone, email });
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

      for (const contact of extracted.slice(0, 5)) {
        const role = guessLprRoleFromPost(contact.title);
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
              title: contact.title,
              role_guess: role,
              channel_phone: contact.phone,
              channel_tg_username: null,
              channel_email: contact.email,
              source_url: results[0]?.link ?? null,
              score: 55,
              confidence: 0.5,
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
