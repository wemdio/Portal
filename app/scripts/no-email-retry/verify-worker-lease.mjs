/**
 * Offline behavioral verification for the manual-scoring worker lease SQL.
 *
 * Runs the actual migration against an in-memory PGlite database. It never
 * reads Portal environment variables and never connects to a remote database.
 *
 * Usage:
 *   node app/scripts/no-email-retry/verify-worker-lease.mjs \
 *     --pglite /absolute/path/to/@electric-sql/pglite/dist/index.js
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleFlag = process.argv.indexOf('--pglite');
const modulePath = moduleFlag >= 0 ? process.argv[moduleFlag + 1] : null;
if (!modulePath) {
  throw new Error('Usage: verify-worker-lease.mjs --pglite /absolute/path/to/@electric-sql/pglite/dist/index.js');
}

const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationPath = resolve(
  repoRoot,
  'supabase/migrations/20261013_0001_manual_scoring_worker_lease.sql',
);
const db = new PGlite();
const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let passed = 0;
const failures = [];

async function rows(sql, args = []) {
  return (await db.query(sql, args)).rows;
}

async function result(sql, args = []) {
  return (await rows(sql, args))[0]?.result;
}

async function test(name, run) {
  await db.exec('begin');
  try {
    await run();
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL', name, error instanceof Error ? error.message : error);
  } finally {
    await db.exec('rollback');
  }
}

async function rejected(run, pattern) {
  await db.exec('savepoint expected_rejection');
  try {
    await assert.rejects(run, pattern);
  } finally {
    await db.exec('rollback to savepoint expected_rejection');
    await db.exec('release savepoint expected_rejection');
  }
}

async function insertRun({
  id = randomUUID(),
  status = 'pending',
  startedAt = '2026-10-13T00:00:00Z',
  token = null,
  leaseUntil = null,
  phase = null,
  uniqueCount = 0,
} = {}) {
  await rows(
    `insert into public.client_manual_score_runs(
      id, client_user_id, source_filename, status, started_at,
      worker_token, worker_lease_until, worker_phase, unique_count
    ) values ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz, $8, $9)`,
    [id, clientId, `fixture-${id}.txt`, status, startedAt, token, leaseUntil, phase, uniqueCount],
  );
  return id;
}

async function insertRow(runId, {
  id,
  domain = 'fixture.invalid',
  bucket = null,
  score = null,
  processedAt = '2026-10-13T00:00:00Z',
  email = null,
  email2 = null,
  scrapedName = null,
} = {}) {
  const inserted = await rows(
    `insert into public.client_manual_score_rows(
      id, run_id, raw_input, domain, score, rating, spf, email,
      email_validation_status, email2, email2_validation_status, bucket,
      error_message, scraped_name, processed_at
    ) values (
      coalesce($1::bigint, nextval('client_manual_score_rows_id_seq')), $2,
      $3, $3, $4, 'fixture-rating', 'fixture-spf', $5,
      null, $6, null, $7, null, $8, $9::timestamptz
    ) returning id`,
    [id ?? null, runId, domain, score, email, email2, bucket, scrapedName, processedAt],
  );
  return inserted[0].id;
}

async function claim(token) {
  return result('select public.claim_manual_score_run($1::uuid) result', [token]);
}

async function action(runId, token, actionName, patch = {}) {
  return result(
    'select public.manual_score_lease_action($1::uuid, $2::uuid, $3, $4::jsonb) result',
    [runId, token, actionName, JSON.stringify(patch)],
  );
}

async function save(runId, token, rowId, payload) {
  return result(
    'select public.save_manual_score_row($1::uuid, $2::uuid, $3::bigint, $4::jsonb) result',
    [runId, token, rowId, JSON.stringify(payload)],
  );
}

function rowPayload(overrides = {}) {
  return {
    domain: 'saved.invalid',
    score: 4242,
    rating: 'B',
    spf: 'ok',
    email: 'first@example.invalid',
    email_validation_status: 'valid',
    email2: 'second@example.invalid',
    email2_validation_status: 'catch_all',
    bucket: 'medium',
    error_message: null,
    scraped_name: 'Saved Fixture',
    processed_at: '2026-10-13T01:02:03.456Z',
    ...overrides,
  };
}

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    create table public.profiles(id uuid primary key);
    create table public.client_manual_score_runs (
      id uuid primary key,
      client_user_id uuid not null references public.profiles(id),
      source_filename text,
      uploaded_count integer not null default 0,
      unique_count integer not null default 0,
      status text not null default 'pending'
        check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
      processed_count integer not null default 0,
      bucket_storage_count integer,
      bucket_medium_count integer,
      bucket_high_count integer,
      bucket_top_count integer,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      error_message text,
      expires_at timestamptz not null default now() + interval '30 days',
      route_to_instantly boolean not null default false,
      is_no_email_retry boolean not null default false
    );
    create index idx_manual_runs_pending on public.client_manual_score_runs(status, started_at)
      where status = 'pending';

    create table public.client_manual_score_rows (
      id bigserial primary key,
      run_id uuid not null references public.client_manual_score_runs(id) on delete cascade,
      raw_input text,
      domain text,
      score numeric,
      rating text,
      spf text,
      email text,
      email_validation_status text,
      email2 text,
      email2_validation_status text,
      bucket text check (bucket in ('invalid', 'storage', 'medium', 'high', 'top')),
      error_message text,
      scraped_name text,
      processed_at timestamptz not null default now()
    );
    insert into public.profiles(id) values ('${clientId}');
  `);
  await db.exec(readFileSync(migrationPath, 'utf8'));

  await test('pending claim is token-idempotent and blocks a second live claimant', async () => {
    const runId = await insertRun({ uniqueCount: 1 });
    await insertRow(runId);
    const owner = randomUUID();
    const contender = randomUUID();

    const first = await claim(owner);
    assert.equal(first.id, runId);
    assert.equal(first.status, 'processing');
    assert.equal(first.worker_token, owner);
    assert.equal(first.worker_phase, 'scoring');
    assert.ok(new Date(first.worker_lease_until).getTime() > Date.now());

    const retry = await claim(owner);
    assert.equal(retry.id, runId);
    assert.equal(retry.worker_token, owner);
    assert.equal(await claim(contender), null);
    assert.equal(
      (await rows("select count(*)::int n from client_manual_score_runs where status='processing'"))[0].n,
      1,
    );
  });

  await test('a pending run is not claimable until all uploaded rows exist', async () => {
    const runId = await insertRun({ uniqueCount: 2 });
    await insertRow(runId, { domain: 'first.invalid' });
    const owner = randomUUID();

    assert.equal(await claim(owner), null);
    await insertRow(runId, { domain: 'second.invalid' });
    assert.equal((await claim(owner)).id, runId);
  });

  await test('only service_role can execute the SECURITY DEFINER lease API', async () => {
    const runId = await insertRun({ uniqueCount: 1 });
    await insertRow(runId);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`savepoint ${role}_rpc_denied`);
      await db.exec(`set local role ${role}`);
      await assert.rejects(() => claim(randomUUID()), /permission denied/i);
      await db.exec(`rollback to savepoint ${role}_rpc_denied`);
      await db.exec(`release savepoint ${role}_rpc_denied`);
    }

    await db.exec('set local role service_role');
    assert.equal((await claim(randomUUID())).id, runId);
    await db.exec('savepoint service_table_denied');
    await assert.rejects(
      () => rows('select id from public.client_manual_score_runs limit 1'),
      /permission denied/i,
    );
    await db.exec('rollback to savepoint service_table_denied');
    await db.exec('release savepoint service_table_denied');
    await db.exec('reset role');
  });

  await test('only an expired token-owned scoring run is reclaimed', async () => {
    const legacy = await insertRun({ status: 'processing', startedAt: '2026-10-13T00:00:00Z' });
    const failed = await insertRun({ status: 'failed', startedAt: '2026-10-13T00:00:01Z' });
    const oldOwner = randomUUID();
    const expired = await insertRun({
      status: 'processing',
      startedAt: '2026-10-13T00:00:02Z',
      token: oldOwner,
      leaseUntil: '2000-01-01T00:00:00Z',
      phase: 'scoring',
    });
    const newOwner = randomUUID();

    const reclaimed = await claim(newOwner);
    assert.equal(reclaimed.id, expired);
    assert.equal(reclaimed.worker_token, newOwner);
    assert.equal(reclaimed.worker_phase, 'scoring');
    assert.deepEqual(
      await rows(
        `select id, status, worker_token from client_manual_score_runs
         where id = any($1::uuid[]) order by id`,
        [[legacy, failed]],
      ),
      [
        { id: failed, status: 'failed', worker_token: null },
        { id: legacy, status: 'processing', worker_token: null },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  await test('a reclaimed run fences every write from its old token', async () => {
    const oldOwner = randomUUID();
    const newOwner = randomUUID();
    const runId = await insertRun({
      status: 'processing',
      token: oldOwner,
      leaseUntil: '2000-01-01T00:00:00Z',
      phase: 'scoring',
    });
    const rowId = await insertRow(runId);
    assert.equal((await claim(newOwner)).id, runId);

    await rejected(() => save(runId, oldOwner, rowId, rowPayload()), /Manual scoring lease lost/);
    await rejected(
      () => action(runId, oldOwner, 'update', { processed_count: 99 }),
      /Manual scoring lease lost/,
    );
    const [unchanged] = await rows(
      'select bucket, score, processed_at::text, error_message from client_manual_score_rows where id=$1',
      [rowId],
    );
    assert.equal(unchanged.bucket, null);
    assert.equal(unchanged.score, null);
    assert.equal(
      (await rows('select processed_count from client_manual_score_runs where id=$1', [runId]))[0]
        .processed_count,
      0,
    );
  });

  await test('row CAS preserves the first durable payload and timestamp', async () => {
    const runId = await insertRun({ uniqueCount: 1 });
    const owner = randomUUID();
    const rowId = await insertRow(runId);
    await claim(owner);
    const firstPayload = rowPayload();
    const first = await save(runId, owner, rowId, firstPayload);
    assert.equal(first.bucket, 'medium');
    assert.equal(first.email2, 'second@example.invalid');
    assert.equal(first.scraped_name, 'Saved Fixture');

    const replay = await save(runId, owner, rowId, rowPayload({
      domain: 'overwrite.invalid',
      score: 999999,
      bucket: 'high',
      email: 'overwrite@example.invalid',
      processed_at: '2030-01-01T00:00:00Z',
    }));
    assert.deepEqual(replay, first);

    const [stored] = await rows(
      `select domain, score::text, bucket, email, email2, scraped_name,
        processed_at::text from client_manual_score_rows where id=$1`,
      [rowId],
    );
    assert.equal(stored.domain, firstPayload.domain);
    assert.equal(stored.score, String(firstPayload.score));
    assert.equal(stored.bucket, firstPayload.bucket);
    assert.equal(stored.email, firstPayload.email);
    assert.equal(stored.email2, firstPayload.email2);
    assert.equal(stored.scraped_name, firstPayload.scraped_name);
    assert.equal(new Date(stored.processed_at).toISOString(), firstPayload.processed_at);
  });

  await test('release is token-fenced and allowed only from scoring', async () => {
    const runId = await insertRun({ uniqueCount: 1 });
    const owner = randomUUID();
    const rowId = await insertRow(runId);
    await claim(owner);
    await rejected(() => action(runId, randomUUID(), 'release'), /Manual scoring lease lost/);

    const released = await action(runId, owner, 'release');
    assert.equal(released.status, 'pending');
    assert.equal(released.worker_token, null);
    assert.equal(released.worker_lease_until, null);
    assert.equal(released.worker_phase, null);

    const routingRun = await insertRun({
      startedAt: '2026-10-13T00:00:01Z',
      uniqueCount: 1,
    });
    await insertRow(routingRun);
    const routingOwner = randomUUID();
    assert.equal((await claim(routingOwner)).id, runId);
    // The released first run is deliberately oldest. Finish it so the second
    // claim below exercises the routing release guard on routingRun.
    await save(runId, routingOwner, rowId, rowPayload());
    await action(runId, routingOwner, 'update', { status: 'completed' });
    assert.equal((await claim(routingOwner)).id, routingRun);
    await action(routingRun, routingOwner, 'routing');
    await rejected(
      () => action(routingRun, routingOwner, 'release'),
      /Cannot requeue an uncertain routing phase/,
    );
  });

  await test('even an expired routing lease blocks automatic reclaim', async () => {
    const routingRun = await insertRun({
      status: 'processing',
      token: randomUUID(),
      leaseUntil: '2000-01-01T00:00:00Z',
      phase: 'routing',
    });
    const pendingRun = await insertRun({
      startedAt: '2026-10-13T00:00:01Z',
      uniqueCount: 1,
    });
    await insertRow(pendingRun);
    assert.equal(await claim(randomUUID()), null);
    assert.deepEqual(
      await rows(
        'select id, status, worker_phase from client_manual_score_runs order by started_at, id',
      ),
      [
        { id: routingRun, status: 'processing', worker_phase: 'routing' },
        { id: pendingRun, status: 'pending', worker_phase: null },
      ],
    );
  });

  await test('completion is rejected until every row is durably saved', async () => {
    const runId = await insertRun({ uniqueCount: 1 });
    const owner = randomUUID();
    const rowId = await insertRow(runId);
    await claim(owner);

    await rows('delete from client_manual_score_rows where id=$1', [rowId]);
    await rejected(
      () => action(runId, owner, 'update', {
        status: 'completed',
        finished_at: '2026-10-13T01:05:00Z',
      }),
      /Cannot complete a manual run with missing or unsaved rows/,
    );
    await insertRow(runId, { id: rowId });

    await rejected(
      () => action(runId, owner, 'update', {
        status: 'completed',
        finished_at: '2026-10-13T01:05:00Z',
      }),
      /Cannot complete a manual run with missing or unsaved rows/,
    );
    await save(runId, owner, rowId, rowPayload());
    const completed = await action(runId, owner, 'update', {
      status: 'completed',
      processed_count: 1,
      finished_at: '2026-10-13T01:05:00Z',
      bucket_medium_count: 1,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.worker_token, null);
    assert.equal(completed.worker_lease_until, null);
    assert.equal(completed.worker_phase, null);
    assert.equal(completed.processed_count, 1);
    assert.equal(completed.bucket_medium_count, 1);
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length} worker-lease behavioral check(s) failed`);
  }
  console.log(`PASS worker lease migration: ${passed} behavioral checks`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
