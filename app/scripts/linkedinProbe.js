/**
 * Пробегается по первому импорту FDlugZWw.xlsx, берёт 30 первых компаний
 * и ищет LinkedIn для их контактов. Сначала LinkFinder AI (если задан ключ),
 * затем Serper.
 *
 * Запуск: cd app && node --env-file=../.env scripts/linkedinProbe.js
 *
 * Требует: SERPER_API_KEY или LINKFINDER_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const SERPER_API_URL = 'https://google.serper.dev/search';
const TRANSLIT_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(text) {
  return text.toLowerCase().split('').map((ch) => TRANSLIT_MAP[ch] ?? ch).join('');
}

function buildLinkedInQueries(name, company, title) {
  const parts = name.split(/\s+/).filter((p) => p.length > 1);
  const latinParts = parts.map(transliterate).join(' ');
  const hasCyrillic = /[а-яё]/i.test(name);
  const queries = [];

  if (hasCyrillic && latinParts.trim()) {
    queries.push(`site:linkedin.com/in ("${name}" OR "${latinParts}") "${company}"`);
  } else {
    queries.push(`site:linkedin.com/in "${name}" "${company}"`);
  }
  if (hasCyrillic && latinParts.trim()) {
    queries.push(`site:linkedin.com "${latinParts}" "${company}"`);
  }
  queries.push(`site:linkedin.com "${name}"`);
  if (title) {
    const titleShort = (title.split(/[,;]/)[0] || '').trim();
    if (titleShort.length > 3) {
      queries.push(`site:linkedin.com "${name}" "${titleShort}"`);
    }
  }
  return queries;
}

function extractLinkedInUrl(items) {
  for (const item of items) {
    const link = (item.link || '').trim();
    if (!link) continue;
    try {
      const url = new URL(link);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (!host.endsWith('linkedin.com') || !url.pathname.startsWith('/in/')) continue;
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch (_) {}
  }
  return null;
}

function snippetMatchesContext(items, personName, companyName, title) {
  const nameParts = personName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
  const translitParts = nameParts.map(transliterate).filter((p) => p.length > 2);
  const companyWords = companyName.toLowerCase().split(/[\s"«»()]+/).filter((w) => w.length > 2);
  const titleWords = ((title || '').toLowerCase()).split(/[\s,;/]+/).filter((w) => w.length > 3);

  for (const item of items) {
    const text = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
    const nameHit = nameParts.some((p) => text.includes(p)) || translitParts.some((p) => text.includes(p));
    if (!nameHit) continue;
    if (companyWords.some((w) => text.includes(w))) return true;
    if (titleWords.some((w) => text.includes(w))) return true;
  }
  return false;
}

async function serperSearch(query) {
  const apiKey = (process.env.SERPER_API_KEY || '').trim();
  if (!apiKey) return [];

  const res = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, gl: 'ru', hl: 'ru' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Serper ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.organic || []).filter((i) => i && typeof i.link === 'string');
}

async function findLinkedInViaLinkFinder(personName, companyName) {
  const apiKey = (process.env.LINKFINDER_API_KEY || '').trim();
  if (!apiKey) return null;

  const inputData = `${personName} ${companyName}`;
  try {
    const res = await fetch('https://api.linkfinderai.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ type: 'lead_full_name_to_linkedin_url', input_data: inputData }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success' || !data.result) return null;
    const url = String(data.result).trim();
    if (!url) return null;
    const parsed = new URL(url);
    if (!parsed.hostname.replace(/^www\./, '').toLowerCase().endsWith('linkedin.com')) return null;
    if (!parsed.pathname.startsWith('/in/')) return null;
    return url;
  } catch (_) {
    return null;
  }
}

async function findLinkedInProfile(personName, companyName, title) {
  const linkFinderUrl = await findLinkedInViaLinkFinder(personName, companyName);
  if (linkFinderUrl) return { url: linkFinderUrl, source: 'LinkFinder' };

  const queries = buildLinkedInQueries(personName, companyName, title);
  for (const query of queries) {
    try {
      const items = await serperSearch(query);
      if (items.length === 0) continue;
      const url = extractLinkedInUrl(items);
      if (!url) continue;
      if (snippetMatchesContext(items, personName, companyName, title)) return { url, source: 'Serper' };
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : '';
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function getProviderLabel() {
  if ((process.env.LINKFINDER_API_KEY || '').trim()) return 'LinkFinder + Serper';
  return 'Serper';
}

function getContactLimit() {
  const raw = Number(process.env.LINKEDIN_PROBE_CONTACTS || '100');
  if (!Number.isFinite(raw)) return 100;
  return Math.max(1, Math.min(1000, Math.trunc(raw)));
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const serperKey = (process.env.SERPER_API_KEY || '').trim();
  const linkFinderKey = (process.env.LINKFINDER_API_KEY || '').trim();

  if (!supabaseUrl || !supabaseKey) {
    console.error('Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!serperKey && !linkFinderKey) {
    console.error('Нужен SERPER_API_KEY или LINKFINDER_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: job, error: jobErr } = await supabase
    .from('lead_import_jobs')
    .select('id, user_id, source_filename')
    .eq('source_filename', 'FDlugZWw.xlsx')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (jobErr || !job) {
    console.error('Импорт FDlugZWw.xlsx не найден:', jobErr?.message || '');
    process.exit(1);
  }

  const contactLimit = getContactLimit();

  console.log(`\nИмпорт: ${job.source_filename} (job ${job.id})`);
  console.log(`Провайдер: ${getProviderLabel()}`);
  console.log(`Лимит контактов: ${contactLimit}`);
  console.log('Берём первые 30 компаний...\n');

  const { data: leadRows } = await supabase
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', job.id)
    .not('company_id', 'is', null)
    .limit(5000);

  const companyIds = [...new Set((leadRows || []).map((r) => r.company_id).filter(Boolean))].slice(0, 30);

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, short_name')
    .in('id', companyIds);

  const companyMap = new Map((companies || []).map((c) => [c.id, c]));

  const { data: contacts } = await supabase
    .from('company_contacts')
    .select('id, company_id, full_name, title, profile_links')
    .eq('user_id', job.user_id)
    .in('company_id', companyIds)
    .order('score', { ascending: false });

  const withoutLinkedIn = (contacts || []).filter((c) => {
    const pl = c.profile_links;
    return !pl || !pl.linkedin || !String(pl.linkedin).trim();
  });
  const contactsToCheck = withoutLinkedIn.slice(0, contactLimit);

  console.log(`Компаний: ${companyIds.length}, контактов без LinkedIn: ${withoutLinkedIn.length}, проверяем: ${contactsToCheck.length}\n`);

  let found = 0;
  let tried = 0;

  for (const c of contactsToCheck) {
    const company = companyMap.get(c.company_id);
    const companyName = (company?.short_name || company?.name || '').trim();
    const name = String(c.full_name || '').trim();
    if (!companyName || !name || name.length < 4) continue;

    tried++;
    const queries = buildLinkedInQueries(name, companyName, c.title);
    console.log(`[${tried}] ${name} @ ${companyName}`);
    console.log(`    Запрос: ${queries[0]}`);

    try {
      const result = await findLinkedInProfile(name, companyName, c.title);
      if (result) {
        found++;
        console.log(`    ✓ LinkedIn (${result.source}): ${result.url}`);
      } else {
        console.log(`    ✗ не найден`);
      }
    } catch (e) {
      console.log(`    ✗ ошибка: ${(e && e.message) || e}`);
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n--- Итог: найдено ${found} из ${tried} контактов ---\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
