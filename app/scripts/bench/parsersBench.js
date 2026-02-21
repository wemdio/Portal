function mustEnv(name) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {
    pollMs: 2000,
    timeoutMinutes: 180,
    hh: 2,
    search: 2,
    yandex: 1,
    yandexMaxResults: 250,
    yandexHeadless: true,
    hhFetchEmployers: true,
    hhTexts: [],
    hhUrls: [],
    searchQuerySets: [],
    yandexSearchUrls: [],
    // If not provided, we'll try to guess from recent jobs.
    userId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!a) continue;

    const readNum = (fallback) => {
      const n = Number(next);
      if (!Number.isFinite(n)) return fallback;
      i += 1;
      return n;
    };

    const readStr = () => {
      if (next == null) return null;
      i += 1;
      return String(next).trim();
    };

    if (a === '--poll-ms') out.pollMs = Math.max(250, Math.floor(readNum(out.pollMs)));
    else if (a === '--timeout-min') out.timeoutMinutes = Math.max(1, Math.floor(readNum(out.timeoutMinutes)));
    else if (a === '--hh') out.hh = Math.max(0, Math.floor(readNum(out.hh)));
    else if (a === '--search') out.search = Math.max(0, Math.floor(readNum(out.search)));
    else if (a === '--yandex') out.yandex = Math.max(0, Math.floor(readNum(out.yandex)));
    else if (a === '--yandex-max-results') out.yandexMaxResults = Math.max(1, Math.min(5000, Math.floor(readNum(out.yandexMaxResults))));
    else if (a === '--yandex-headed') out.yandexHeadless = false;
    else if (a === '--hh-no-employers') out.hhFetchEmployers = false;
    else if (a === '--hh-text') {
      const s = readStr();
      if (s) out.hhTexts.push(s);
    } else if (a === '--hh-url') {
      const s = readStr();
      if (s) out.hhUrls.push(s);
    } else if (a === '--search-queries') {
      const s = readStr();
      if (s) out.searchQuerySets.push(s);
    } else if (a === '--yandex-url') {
      const s = readStr();
      if (s) out.yandexSearchUrls.push(s);
    }
    else if (a === '--user-id') out.userId = readStr();
  }
  return out;
}

function parseStringList(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];

  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v ?? '').trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }

  return s
    .split(/\r?\n|[;]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function msToHuman(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m < 60) return `${m}m ${ss}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

async function guessUserId(admin) {
  // Best-effort: take the most recent user_id from any parser table.
  const candidates = [
    { table: 'parser_jobs', field: 'user_id' },
    { table: 'search_parser_jobs', field: 'user_id' },
    { table: 'yandex_maps_jobs', field: 'user_id' },
  ];

  for (const c of candidates) {
    const { data } = await admin.from(c.table).select(`${c.field}, created_at`).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const userId = data?.[c.field];
    if (typeof userId === 'string' && userId.trim()) return userId.trim();
  }
  return null;
}

async function createHhJob(admin, userId, config) {
  const { data, error } = await admin
    .from('parser_jobs')
    .insert({
      user_id: userId,
      parser_type: 'hh_vacancies',
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config,
      total_found: null,
      total_parsed: null,
      started_at: null,
      completed_at: null,
      error_message: null,
    })
    .select('id, created_at, status')
    .single();

  if (error) throw new Error(`Failed to create HH job: ${error.message}`);
  return data;
}

async function createSearchJob(admin, userId, config) {
  const totalQueries = Array.isArray(config?.queries) ? config.queries.length : 0;
  const { data, error } = await admin
    .from('search_parser_jobs')
    .insert({
      user_id: userId,
      status: 'pending',
      config,
      total_queries: totalQueries,
    })
    .select('id, created_at, status')
    .single();

  if (error) throw new Error(`Failed to create Search job: ${error.message}`);
  return data;
}

async function createYandexMapsJob(admin, userId, config) {
  const { data, error } = await admin
    .from('yandex_maps_jobs')
    .insert({
      user_id: userId,
      status: 'pending',
      config,
      progress_stage: 'pending',
      proxy_enabled: false,
      proxy_protocol: null,
      proxy_host: null,
      proxy_port: null,
      proxy_credentials_encrypted: null,
      error_message: null,
    })
    .select('id, created_at, status, progress_stage')
    .single();

  if (error) throw new Error(`Failed to create YandexMaps job: ${error.message}`);
  return data;
}

async function fetchRow(admin, table, id, fields) {
  const { data, error } = await admin.from(table).select(fields).eq('id', id).maybeSingle();
  if (error) throw new Error(`${table} fetch failed: ${error.message}`);
  if (!data) throw new Error(`${table} row not found: ${id}`);
  return data;
}

async function waitForStatus(admin, table, id, opts) {
  const timeoutAt = Date.now() + opts.timeoutMs;
  let last = null;

  while (Date.now() < timeoutAt) {
    const row = await fetchRow(admin, table, id, opts.fields);
    last = row;
    if (opts.isDone(row)) return row;
    await sleep(opts.pollMs);
  }

  const suffix = last ? ` (last status=${last.status ?? 'n/a'} stage=${last.progress_stage ?? 'n/a'})` : '';
  throw new Error(`Timeout waiting for ${table}:${id}${suffix}`);
}

async function runYandexTwoStep(admin, jobId, opts) {
  const startedAt = Date.now();

  // Step 1: collect-links
  const collectRow = await waitForStatus(admin, 'yandex_maps_jobs', jobId, {
    fields: 'id,status,progress_stage,started_at,completed_at,error_message',
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    isDone: (r) => r.status === 'failed' || (r.status === 'pending' && r.progress_stage === 'links_collected'),
  });

  if (collectRow.status === 'failed') {
    return { ok: false, stage: 'collect', row: collectRow, elapsedMs: Date.now() - startedAt };
  }

  // Collect step can finish with 0 links (e.g. blocked/changed markup). Do not run parse in that case.
  const { count: linksCount, error: linksCountErr } = await admin
    .from('yandex_maps_links')
    .select('link', { count: 'exact', head: true })
    .eq('job_id', jobId);
  if (linksCountErr) throw new Error(`Failed to count yandex maps links: ${linksCountErr.message}`);

  if (!linksCount || linksCount <= 0) {
    const msg = 'Нет ссылок организаций (этап collect-links вернул 0). Проверьте блокировки/прокси/стабильность Selenium.';
    const { error: failErr } = await admin
      .from('yandex_maps_jobs')
      .update({ status: 'failed', progress_stage: 'failed', error_message: msg, completed_at: nowIso() })
      .eq('id', jobId);
    if (failErr) throw new Error(`Failed to mark yandex job failed: ${failErr.message}`);

    const row = await fetchRow(admin, 'yandex_maps_jobs', jobId, 'id,status,progress_stage,started_at,completed_at,error_message');
    return { ok: false, stage: 'collect', row, elapsedMs: Date.now() - startedAt };
  }

  // Step 2: trigger parse-orgs (same logic as API route)
  const { error: triggerErr } = await admin
    .from('yandex_maps_jobs')
    .update({ status: 'pending', progress_stage: 'ready_to_parse', error_message: null })
    .eq('id', jobId);
  if (triggerErr) throw new Error(`Failed to trigger yandex parse step: ${triggerErr.message}`);

  const parseRow = await waitForStatus(admin, 'yandex_maps_jobs', jobId, {
    fields: 'id,status,progress_stage,started_at,completed_at,error_message',
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    isDone: (r) => r.status === 'completed' || r.status === 'failed',
  });

  return {
    ok: parseRow.status === 'completed',
    stage: parseRow.status === 'completed' ? 'completed' : 'failed',
    row: parseRow,
    elapsedMs: Date.now() - startedAt,
  };
}

async function run() {
  const { createClient } = await import('@supabase/supabase-js');
  const args = parseArgs(process.argv.slice(2));

  const SUPABASE_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
  const SERVICE_KEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const userId = args.userId || (await guessUserId(admin));
  if (!userId) {
    throw new Error('Cannot determine user id. Pass --user-id <uuid> or create at least one parser job first.');
  }

  console.log(`[bench] starting at ${nowIso()}`);
  console.log(`[bench] user_id=${userId}`);
  console.log(`[bench] plan: HH=${args.hh}, Search=${args.search}, YandexMaps=${args.yandex}`);

  const createdAt = Date.now();
  const jobs = [];

  // HH configs: use small-ish defaults; adjust as needed.
  for (let i = 0; i < args.hh; i += 1) {
    const url = args.hhUrls[i] || args.hhUrls[0];
    const text = args.hhTexts[i] || args.hhTexts[0] || (i === 0 ? 'менеджер по продажам' : 'инженер проектировщик');
    jobs.push(
      createHhJob(admin, userId, {
        ...(url ? { url } : { text }),
        per_page: 50,
        // fetching employer details makes HH much slower; keep enabled by default to be “realistic”
        fetch_employers: Boolean(args.hhFetchEmployers),
      }).then((job) => ({ kind: 'hh', id: job.id, created_at: job.created_at })),
    );
  }

  // Search configs: explicit queries gives stable runtime; avoid LLM-based brief generation.
  for (let i = 0; i < args.search; i += 1) {
    const raw = args.searchQuerySets[i] || args.searchQuerySets[0] || '';
    const parsed = raw ? parseStringList(raw) : [];
    const queries = parsed.length
      ? parsed
      : i === 0
        ? ['производство металлоконструкций москва сайт', 'логистическая компания спб сайт', 'строительная компания казань контакты']
        : ['ремонт спецтехники екатеринбург сайт', 'поставка оборудования для пищевой промышленности сайт', 'инжиниринговая компания новосибирск сайт'];
    jobs.push(
      createSearchJob(admin, userId, { queries }).then((job) => ({ kind: 'search', id: job.id, created_at: job.created_at })),
    );
  }

  for (let i = 0; i < args.yandex; i += 1) {
    const url = args.yandexSearchUrls[i] || args.yandexSearchUrls[0] || 'https://yandex.ru/maps/?text=кофейня%20москва';
    jobs.push(
      createYandexMapsJob(admin, userId, {
        search_urls: [url],
        max_results: args.yandexMaxResults,
        headless: args.yandexHeadless,
      }).then((job) => ({ kind: 'yandexmaps', id: job.id, created_at: job.created_at })),
    );
  }

  const created = await Promise.all(jobs);
  console.log(`[bench] created ${created.length} job(s) in ${msToHuman(Date.now() - createdAt)}`);
  for (const j of created) {
    console.log(`[bench] + ${j.kind} ${j.id}`);
  }

  const timeoutMs = args.timeoutMinutes * 60 * 1000;

  const waits = created.map(async (j) => {
    const startedAt = Date.now();
    if (j.kind === 'hh') {
      const row = await waitForStatus(admin, 'parser_jobs', j.id, {
        fields: 'id,status,started_at,completed_at,error_message,progress_stage,total_found,total_parsed',
        pollMs: args.pollMs,
        timeoutMs,
        isDone: (r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled',
      });
      return { ...j, ok: row.status === 'completed', status: row.status, stage: row.progress_stage, error: row.error_message, elapsedMs: Date.now() - startedAt };
    }

    if (j.kind === 'search') {
      const row = await waitForStatus(admin, 'search_parser_jobs', j.id, {
        fields: 'id,status,started_at,completed_at,error_message,progress_stage,total_results,total_queries,processed_queries',
        pollMs: args.pollMs,
        timeoutMs,
        isDone: (r) => r.status === 'completed' || r.status === 'failed',
      });
      return { ...j, ok: row.status === 'completed', status: row.status, stage: row.progress_stage, error: row.error_message, elapsedMs: Date.now() - startedAt };
    }

    const out = await runYandexTwoStep(admin, j.id, { pollMs: args.pollMs, timeoutMs });
    return { ...j, ok: out.ok, status: out.row.status, stage: out.row.progress_stage, error: out.row.error_message, elapsedMs: out.elapsedMs };
  });

  const results = await Promise.all(waits);
  const totalElapsed = Date.now() - createdAt;

  console.log('');
  console.log(`[bench] finished in ${msToHuman(totalElapsed)}`);
  const summary = results
    .map((r) => ({
      kind: r.kind,
      ok: r.ok,
      status: r.status,
      stage: r.stage ?? null,
      elapsed: msToHuman(r.elapsedMs),
      id: r.id,
      error: r.ok ? '' : String(r.error ?? '').slice(0, 160),
    }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1));
  console.table(summary);
}

run().catch((err) => {
  console.error('[bench] failed:', err);
  process.exit(1);
});

