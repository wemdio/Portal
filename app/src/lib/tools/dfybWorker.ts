import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { generateDfybPlan, type DfybPlan, type DfybParserConfig } from './dfybPlanner';
import {
  removeEmptyRowsAndCols,
  deduplicateRows,
  deduplicateByEmail,
  findColumnIndex,
  processInPool,
  sleep,
  extractEmail,
} from './dfybUtils';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { runSearchParserJob } from '@/lib/parsers/searchParserWorker';

/* ═══════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════ */

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY || '';
const OPENROUTER_PERSONALIZATION_API_KEY =
  process.env.OPENROUTER_PERSONALIZATION_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY || '';
const OPENROUTER_CLEANUP_API_KEY = process.env.OPENROUTER_CLEANUP_API_KEY || '';
const OPENROUTER_CLEANUP_MODELS = (
  process.env.OPENROUTER_CLEANUP_MODELS ??
  process.env.OPENROUTER_CLEANUP_MODEL ??
  'x-ai/grok-4.1-fast,google/gemini-3-flash-preview'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const AI_MODEL = 'google/gemini-3-flash-preview';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SITE_CHECK_TIMEOUT = 12_000;

const TA_BATCH = 10;
const CLEANUP_BATCH = 100;
const PERSONALIZATION_BATCH = 5;
const SITE_CHECK_BATCH = 50;
const EMAIL_CONCURRENCY = 5;
const ENRICH_CONCURRENCY = 5;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

const STEPS: { num: number; name: string; status: 'planning' | 'parsing' | 'processing' }[] = [
  { num: 1, name: 'Анализ брифа и планирование', status: 'planning' },
  { num: 2, name: 'Сбор контактов (парсинг)', status: 'parsing' },
  { num: 3, name: 'Нормализация данных', status: 'processing' },
  { num: 4, name: 'Удаление пустых строк', status: 'processing' },
  { num: 5, name: 'Удаление полных дубликатов', status: 'processing' },
  { num: 6, name: 'Поиск email-адресов', status: 'processing' },
  { num: 7, name: 'Удаление дубликатов по email', status: 'processing' },
  { num: 8, name: 'Проверка доступности сайтов', status: 'processing' },
  { num: 9, name: 'Обогащение описаниями', status: 'processing' },
  { num: 10, name: 'Оценка целевой аудитории', status: 'processing' },
  { num: 11, name: 'Очистка названий компаний', status: 'processing' },
  { num: 12, name: 'Персонализация', status: 'processing' },
];

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

const admin = supabaseAdmin!;

async function updateProgress(
  jobId: string,
  step: number,
  progress: number,
  extra?: Record<string, unknown>,
) {
  const s = STEPS[step - 1];
  await admin
    .from('dfyb_jobs')
    .update({
      current_step: step,
      current_step_name: s?.name ?? `Шаг ${step}`,
      current_step_progress: Math.min(100, Math.max(0, Math.round(progress))),
      status: s?.status ?? 'processing',
      ...extra,
    })
    .eq('id', jobId);
}

async function isCancelled(jobId: string): Promise<boolean> {
  const { data } = await admin.from('dfyb_jobs').select('status').eq('id', jobId).single();
  return data?.status === 'cancelled';
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number; json?: boolean; title?: string } = {},
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': opts.title ?? 'Portal - DFYB',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.max_tokens ?? 4000,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = await res.json();
        return json.choices?.[0]?.message?.content || '';
      }
      if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * 2 ** attempt);
        continue;
      }
      throw new Error(`OpenRouter ${res.status}`);
    } catch (err) {
      clearTimeout(timeout);
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY * 2 ** attempt);
    }
  }
  throw new Error('OpenRouter max retries exceeded');
}

/* ═══════════════════════════════════════════
   STEP 1: PLANNING
   ═══════════════════════════════════════════ */

async function stepPlan(
  jobId: string,
  brief: string,
  companyUrl: string | null,
  targetCount: number,
): Promise<DfybPlan> {
  await updateProgress(jobId, 1, 10);
  const plan = await generateDfybPlan(brief, companyUrl, targetCount);
  await updateProgress(jobId, 1, 100, { plan: plan as unknown as Record<string, unknown> });
  return plan;
}

/* ═══════════════════════════════════════════
   STEP 2: PARSING
   ═══════════════════════════════════════════ */

const STD_HEADER = ['Компания', 'Сайт', 'Email', 'Телефон', 'Описание', 'Город', 'Категории'];

async function runSearchParsing(queries: string[], userId: string): Promise<string[][]> {
  const { data: job, error } = await admin
    .from('search_parser_jobs')
    .insert({ user_id: userId, status: 'pending', config: { queries }, total_queries: queries.length })
    .select()
    .single();
  if (error || !job) throw new Error(`Failed to create search job: ${error?.message}`);

  await runSearchParserJob(job.id);

  const { data: results } = await admin
    .from('search_results')
    .select('company_name, site, description, email')
    .eq('job_id', job.id);

  return (results || []).map((r) => [
    r.company_name || '',
    r.site || '',
    r.email || '',
    '',
    r.description || '',
    '',
    '',
  ]);
}

async function runYandexMapsParsing(searchUrls: string[], userId: string): Promise<string[][]> {
  const { runYandexMapsCollectLinks, runYandexMapsParseOrganizations } = await import(
    '@/lib/parsers/yandexMapsWorker'
  );

  const { data: job, error } = await admin
    .from('yandex_maps_jobs')
    .insert({ user_id: userId, status: 'pending', config: { search_urls: searchUrls } })
    .select()
    .single();
  if (error || !job) throw new Error(`Failed to create yandex maps job: ${error?.message}`);

  await runYandexMapsCollectLinks(job.id);
  await runYandexMapsParseOrganizations(job.id);

  const { data: results } = await admin
    .from('yandex_maps_organizations')
    .select('name, website, email, phone, address, city, categories')
    .eq('job_id', job.id);

  return (results || []).map((r) => [
    r.name || '',
    r.website || '',
    r.email || '',
    r.phone || '',
    '',
    r.city || '',
    r.categories || '',
  ]);
}

async function runHHParsing(config: { text: string; area?: number }): Promise<string[][]> {
  const { fetchVacancies } = await import('@/lib/parsers/hhParser');
  const hhConfig = { text: config.text, area: config.area ? String(config.area) : undefined, fetch_employers: true };
  const { vacancies } = await fetchVacancies(hhConfig);

  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const v of vacancies) {
    const key = (v.company_name || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push([
      v.company_name || '',
      v.company_site_url || v.company_url || '',
      '',
      '',
      v.company_description || '',
      v.area || '',
      (v.industries || []).join(', '),
    ]);
  }
  return rows;
}

async function stepParse(
  jobId: string,
  plan: DfybPlan,
  userId: string,
): Promise<string[][]> {
  const allRows: string[][] = [];
  const parsers = plan.parsers;

  for (let i = 0; i < parsers.length; i++) {
    const p = parsers[i];
    const baseProgress = Math.round((i / parsers.length) * 100);
    await updateProgress(jobId, 2, baseProgress);

    try {
      let rows: string[][] = [];
      if (p.type === 'search' && p.queries?.length) {
        rows = await runSearchParsing(p.queries, userId);
      } else if (p.type === 'yandex_maps' && p.search_urls?.length) {
        rows = await runYandexMapsParsing(p.search_urls, userId);
      } else if (p.type === 'hh' && p.hh_config) {
        rows = await runHHParsing(p.hh_config);
      }
      allRows.push(...rows);
    } catch (err) {
      console.error(`[dfyb] Parser ${p.type} failed:`, err);
    }
  }

  if (allRows.length === 0) throw new Error('Ни один парсер не вернул результатов');
  await updateProgress(jobId, 2, 100);
  return [STD_HEADER, ...allRows];
}

/* ═══════════════════════════════════════════
   STEPS 3-5: NORMALIZE & DEDUP
   ═══════════════════════════════════════════ */

async function stepNormalize(jobId: string, data: string[][]): Promise<string[][]> {
  await updateProgress(jobId, 3, 50);
  const colCount = STD_HEADER.length;
  const normalized = data.map((row) => {
    const padded = [...row];
    while (padded.length < colCount) padded.push('');
    return padded.slice(0, colCount);
  });
  await updateProgress(jobId, 3, 100);
  return normalized;
}

async function stepRemoveEmpty(jobId: string, data: string[][]): Promise<string[][]> {
  await updateProgress(jobId, 4, 50);
  const result = removeEmptyRowsAndCols(data);
  await updateProgress(jobId, 4, 100);
  return result;
}

async function stepFullDedup(jobId: string, data: string[][]): Promise<string[][]> {
  await updateProgress(jobId, 5, 50);
  const result = deduplicateRows(data);
  await updateProgress(jobId, 5, 100);
  return result;
}

/* ═══════════════════════════════════════════
   STEP 6: FIND EMAILS
   ═══════════════════════════════════════════ */

async function stepFindEmails(jobId: string, data: string[][]): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const emailIdx = findColumnIndex(header, 'email');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website');
  if (emailIdx < 0 || siteIdx < 0) return data;

  const toProcess = body
    .map((row, i) => ({ row, i, url: (row[siteIdx] || '').trim() }))
    .filter((r) => r.url && !extractEmail(r.row[emailIdx] || ''));

  if (toProcess.length === 0) {
    await updateProgress(jobId, 6, 100);
    return data;
  }

  let done = 0;
  await processInPool(toProcess, EMAIL_CONCURRENCY, async (item) => {
    try {
      const { emails } = await scrapeEmails(item.url, { timeout: 15_000, maxPages: 5 });
      if (emails.length > 0) body[item.i][emailIdx] = emails[0];
    } catch {
      // skip
    }
    done++;
    if (done % 10 === 0 || done === toProcess.length) {
      await updateProgress(jobId, 6, Math.round((done / toProcess.length) * 100));
    }
  });

  await updateProgress(jobId, 6, 100);
  return [header, ...body];
}

/* ═══════════════════════════════════════════
   STEP 7: EMAIL DEDUP
   ═══════════════════════════════════════════ */

async function stepEmailDedup(jobId: string, data: string[][]): Promise<string[][]> {
  await updateProgress(jobId, 7, 50);
  const result = deduplicateByEmail(data);
  await updateProgress(jobId, 7, 100);
  return result;
}

/* ═══════════════════════════════════════════
   STEP 8: SITE CHECK
   ═══════════════════════════════════════════ */

async function checkSite(url: string): Promise<boolean> {
  let normalized = url;
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITE_CHECK_TIMEOUT);
  try {
    const res = await fetch(normalized, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function stepSiteCheck(jobId: string, data: string[][]): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website');
  if (siteIdx < 0) {
    await updateProgress(jobId, 8, 100);
    return data;
  }

  const keep: boolean[] = new Array(body.length).fill(true);
  const toCheck = body
    .map((row, i) => ({ url: (row[siteIdx] || '').trim(), i }))
    .filter((r) => r.url);

  for (let batch = 0; batch < toCheck.length; batch += SITE_CHECK_BATCH) {
    const chunk = toCheck.slice(batch, batch + SITE_CHECK_BATCH);
    const results = await Promise.all(chunk.map(async (item) => ({ i: item.i, ok: await checkSite(item.url) })));
    for (const r of results) {
      if (!r.ok) keep[r.i] = false;
    }
    await updateProgress(jobId, 8, Math.round(((batch + chunk.length) / toCheck.length) * 100));
  }

  const filtered = body.filter((_, i) => keep[i]);
  await updateProgress(jobId, 8, 100);
  return [header, ...filtered];
}

/* ═══════════════════════════════════════════
   STEP 9: ENRICH DESCRIPTIONS
   ═══════════════════════════════════════════ */

async function stepEnrich(jobId: string, data: string[][]): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const descIdx = findColumnIndex(header, 'описание', 'description');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website');
  if (descIdx < 0 || siteIdx < 0) {
    await updateProgress(jobId, 9, 100);
    return data;
  }

  const toProcess = body
    .map((row, i) => ({ row, i, url: (row[siteIdx] || '').trim() }))
    .filter((r) => r.url && !(r.row[descIdx] || '').trim());

  if (toProcess.length === 0) {
    await updateProgress(jobId, 9, 100);
    return data;
  }

  let done = 0;
  await processInPool(toProcess, ENRICH_CONCURRENCY, async (item) => {
    try {
      const text = await fetchAndExtract(item.url, { timeout: 15_000 });
      if (text) body[item.i][descIdx] = text.slice(0, 2000);
    } catch {
      // skip
    }
    done++;
    if (done % 10 === 0 || done === toProcess.length) {
      await updateProgress(jobId, 9, Math.round((done / toProcess.length) * 100));
    }
  });

  await updateProgress(jobId, 9, 100);
  return [header, ...body];
}

/* ═══════════════════════════════════════════
   STEP 10: TA SCORING
   ═══════════════════════════════════════════ */

const TA_SYSTEM_PROMPT = `Ты — эксперт по B2B лидогенерации и квалификации компаний для email-аутрича.

ЗАДАЧА: Оценить релевантность каждой компании как потенциального клиента на основе брифа.

ПРАВИЛА ОЦЕНКИ (0-10):
- 9-10: Идеальное совпадение с ЦА
- 7-8: Сильное совпадение
- 5-6: Среднее совпадение
- 3-4: Слабое совпадение
- 1-2: Очень слабое
- 0: Полное несовпадение или недостаточно данных

БУДЬ СТРОГИМ. Большинство компаний — 3-6 баллов. 9-10 только при идеальном совпадении.
При малом количестве данных — максимум 5.

ФОРМАТ ОТВЕТА: Только JSON массив, без пояснений.
[{"idx": 0, "score": 7, "reason": "краткое обоснование на русском"}]`;

async function stepTAScore(jobId: string, data: string[][], taBrief: string): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);

  const scoreIdx = header.length;
  const reasonIdx = header.length + 1;
  const newHeader = [...header, 'ЦА Балл', 'ЦА Причина'];
  const scored: string[][] = [];

  for (let batch = 0; batch < body.length; batch += TA_BATCH) {
    if (await isCancelled(jobId)) throw new Error('Отменено');
    const chunk = body.slice(batch, batch + TA_BATCH);
    const companies = chunk.map((row, bIdx) => {
      const obj: Record<string, string> = {};
      header.forEach((h, c) => { obj[h] = row[c] || ''; });
      return { idx: bIdx, data: obj };
    });

    const userMsg = `Бриф:\n${taBrief.slice(0, 4000)}\n\nКомпании:\n${JSON.stringify(companies)}`;
    try {
      const content = await callOpenRouter(OPENROUTER_BRIEF_API_KEY, AI_MODEL, [
        { role: 'system', content: TA_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ], { temperature: 0.2, json: true, title: 'Portal - DFYB TA Scoring' });

      const scores: { idx: number; score: number; reason: string }[] = JSON.parse(content);
      const scoreMap = new Map(scores.map((s) => [s.idx, s]));

      for (let i = 0; i < chunk.length; i++) {
        const s = scoreMap.get(i);
        scored.push([...chunk[i], String(s?.score ?? 0), s?.reason ?? '']);
      }
    } catch {
      for (const row of chunk) scored.push([...row, '5', 'Ошибка оценки']);
    }

    await updateProgress(jobId, 10, Math.round(((batch + chunk.length) / body.length) * 100));
  }

  const filtered = scored.filter((row) => parseInt(row[scoreIdx], 10) >= 5);
  await updateProgress(jobId, 10, 100);
  return [newHeader, ...filtered];
}

/* ═══════════════════════════════════════════
   STEP 11: NAME CLEANUP
   ═══════════════════════════════════════════ */

const CLEANUP_SYSTEM_PROMPT = `Ты очищаешь названия компаний для использования в персонализированных email-письмах.

Правила:
1. Оставь только само название (2-3 слова максимум)
2. Удали: Inc, Ltd, Corp, LLC, ООО, ИП, АО, ЗАО, GmbH и т.п.
3. Удали текст после: -, |, /, ,, :
4. Удали текст в скобках
5. Удали символы: ®, ™, ©, #, !, ?
6. Если >3 слов — сделай аббревиатуру (если уместно)
7. Если всё КАПСОМ (6+ букв) — преобразуй в Title Case
8. Результат должен красиво звучать в предложении: "Я заметил что КОМПАНИЯ..."

ФОРМАТ: Только очищенные названия, каждое на новой строке, без нумерации.
Количество строк = количеству входных компаний. Порядок тот же.`;

async function stepNameCleanup(jobId: string, data: string[][]): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const nameIdx = findColumnIndex(header, 'компания', 'company', 'name', 'название');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website');
  if (nameIdx < 0) {
    await updateProgress(jobId, 11, 100);
    return data;
  }

  for (let batch = 0; batch < body.length; batch += CLEANUP_BATCH) {
    if (await isCancelled(jobId)) throw new Error('Отменено');
    const chunk = body.slice(batch, batch + CLEANUP_BATCH);
    const input = chunk
      .map((row) => {
        const name = row[nameIdx] || '';
        const domain = siteIdx >= 0 ? row[siteIdx] || '' : '';
        return domain ? `${name} Домен: ${domain}` : name;
      })
      .join('\n');

    let cleaned: string[] | null = null;
    for (const model of OPENROUTER_CLEANUP_MODELS) {
      try {
        const content = await callOpenRouter(OPENROUTER_CLEANUP_API_KEY, model, [
          { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ], { temperature: 0.1, title: 'Portal - DFYB Cleanup' });
        cleaned = content.split('\n').map((l) => l.trim()).filter(Boolean);
        if (cleaned.length > 0) break;
      } catch {
        continue;
      }
    }

    if (cleaned) {
      for (let i = 0; i < chunk.length && i < cleaned.length; i++) {
        const idx = batch + i;
        if (cleaned[i]) body[idx][nameIdx] = cleaned[i];
      }
    }

    await updateProgress(jobId, 11, Math.round(((batch + chunk.length) / body.length) * 100));
  }

  await updateProgress(jobId, 11, 100);
  return [header, ...body];
}

/* ═══════════════════════════════════════════
   STEP 12: PERSONALIZATION
   ═══════════════════════════════════════════ */

const PERSONALIZATION_SYSTEM_PROMPT = `Ты — помощник для персонализации холодного email-аутрича в B2B.

ПРАВИЛА:
1. Используй ТОЛЬКО факты из входных данных. Ничего не выдумывай.
2. Не добавляй названия, имена, цифры, кейсы, если их нет в данных.
3. Если данных мало — пиши нейтрально и обобщенно.
4. Не добавляй приветствия, подписи, темы письма.

СТИЛЬ:
- Пиши как живой человек, без канцелярита
- Строго соблюдай русскую грамматику
- Используй только дефис "-", не тире "—"
- 1-3 коротких предложения
- Избегай: "уникальный", "эксклюзивный", "лучший", "инновационный"
- Фокус на выгоде для клиента

Ответ: только текст персонализации.`;

async function stepPersonalize(
  jobId: string,
  data: string[][],
  prompt: string,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const persIdx = header.length;
  const newHeader = [...header, 'Персонализация'];

  const result: string[][] = [];

  for (let batch = 0; batch < body.length; batch += PERSONALIZATION_BATCH) {
    if (await isCancelled(jobId)) throw new Error('Отменено');
    const chunk = body.slice(batch, batch + PERSONALIZATION_BATCH);

    const promises = chunk.map(async (row) => {
      const obj: Record<string, string> = {};
      header.forEach((h, c) => { obj[h] = row[c] || ''; });
      const sourceData = Object.entries(obj)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      const userMsg = `Данные: "${sourceData.slice(0, 3000)}"\n\nЗадача: ${prompt.slice(0, 2000)}\n\nСгенерируй 1 персонализированное предложение.`;
      try {
        const content = await callOpenRouter(OPENROUTER_PERSONALIZATION_API_KEY, AI_MODEL, [
          { role: 'system', content: PERSONALIZATION_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ], { temperature: 0.7, max_tokens: 500, title: 'Portal - DFYB Personalization' });
        return [...row, content.trim()];
      } catch {
        return [...row, ''];
      }
    });

    const batchResults = await Promise.all(promises);
    result.push(...batchResults);

    await updateProgress(jobId, 12, Math.round(((batch + chunk.length) / body.length) * 100));
  }

  await updateProgress(jobId, 12, 100);
  return [newHeader, ...result];
}

/* ═══════════════════════════════════════════
   MAIN ORCHESTRATOR
   ═══════════════════════════════════════════ */

export async function runDfybJob(jobId: string): Promise<void> {
  try {
    const { data: job, error } = await admin
      .from('dfyb_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !job) throw new Error(`Job not found: ${error?.message}`);

    const { brief, company_url, target_count, user_id, personalization_prompt: userPrompt } = job;

    await admin.from('dfyb_jobs').update({ started_at: new Date().toISOString() }).eq('id', jobId);

    // Step 1: Plan
    const plan = await stepPlan(jobId, brief, company_url, target_count);
    if (await isCancelled(jobId)) return;

    // Step 2: Parse
    let data = await stepParse(jobId, plan, user_id);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 3: Normalize
    data = await stepNormalize(jobId, data);
    if (await isCancelled(jobId)) return;

    // Step 4: Remove empty
    data = await stepRemoveEmpty(jobId, data);
    if (await isCancelled(jobId)) return;

    // Step 5: Full dedup
    data = await stepFullDedup(jobId, data);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 6: Find emails
    data = await stepFindEmails(jobId, data);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 7: Email dedup
    data = await stepEmailDedup(jobId, data);
    if (await isCancelled(jobId)) return;

    // Step 8: Site check
    data = await stepSiteCheck(jobId, data);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 9: Enrich
    data = await stepEnrich(jobId, data);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 10: TA Score
    data = await stepTAScore(jobId, data, plan.ta_brief);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 11: Name cleanup
    data = await stepNameCleanup(jobId, data);
    if (await isCancelled(jobId)) return;
    await admin.from('dfyb_jobs').update({ data }).eq('id', jobId);

    // Step 12: Personalization
    const persPrompt = userPrompt || plan.personalization_prompt;
    data = await stepPersonalize(jobId, data, persPrompt);

    // Compute stats
    const header = data[0];
    const body = data.slice(1);
    const emailIdx = findColumnIndex(header, 'email');
    const scoreIdx = findColumnIndex(header, 'ца балл', 'цабалл');
    const emailsFound = emailIdx >= 0 ? body.filter((r) => extractEmail(r[emailIdx] || '')).length : 0;
    const avgScore =
      scoreIdx >= 0
        ? body.reduce((s, r) => s + (parseInt(r[scoreIdx], 10) || 0), 0) / (body.length || 1)
        : 0;

    await admin
      .from('dfyb_jobs')
      .update({
        data,
        status: 'completed',
        completed_at: new Date().toISOString(),
        current_step: 12,
        current_step_name: 'Готово',
        current_step_progress: 100,
        result_stats: {
          total_contacts: body.length,
          emails_found: emailsFound,
          avg_ta_score: Math.round(avgScore * 10) / 10,
        },
      })
      .eq('id', jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[dfyb] Job ${jobId} failed:`, message);
    await admin
      .from('dfyb_jobs')
      .update({
        status: 'failed',
        error_message: message.slice(0, 500),
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}
