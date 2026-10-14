#!/usr/bin/env node
// Exercise the migration's actual SELECT body on PostgreSQL with synthetic
// CTEs only. No production table reads, function creation, DDL or data writes.
// Network execution requires the explicit --ssh-read-only flag.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..');
const args = process.argv.slice(2);
let migration = join(projectRoot, 'supabase/migrations/20261010_0001_client_no_email_retry_live_email_counts.sql');
let sshReadOnly = false;
let printSql = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--migration') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--migration needs a path');
    migration = resolve(args[++i]);
  } else if (args[i] === '--ssh-read-only') {
    sshReadOnly = true;
  } else if (args[i] === '--print-sql') {
    printSql = true;
  } else if (args[i] === '--help') {
    process.stdout.write('Usage: node verify-reporting-sql.mjs [--migration path] [--ssh-read-only | --print-sql]\n'
      + 'Without --ssh-read-only, this command makes no network requests.\n');
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
}
if (printSql && sshReadOnly) throw new Error('Choose --print-sql or --ssh-read-only, not both');

const source = readFileSync(migration, 'utf8');
const declaration = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.client_report_no_email_retry_delta\s*\(/gi;
const declarations = [...source.matchAll(declaration)];
if (declarations.length !== 1) throw new Error('Expected exactly one retry-delta function declaration');
const functionSource = source.slice(declarations[0].index);
const bodyMatch = functionSource.match(/\bAS\s+(\$[a-zA-Z0-9_]*\$)([\s\S]*?)\1\s*;/i);
if (!bodyMatch || !/\bLANGUAGE\s+sql\b/i.test(functionSource.slice(0, bodyMatch.index))) {
  throw new Error('Expected a dollar-quoted LANGUAGE sql function body');
}
let body = bodyMatch[2].replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/;\s*$/, '');
if (!/^WITH\s+retry_facts\s+AS\s*\(/i.test(body) || body.includes(';')) {
  throw new Error('Expected a single WITH retry_facts SELECT, without extra statements');
}
for (const [table, fixture] of [
  ['client_pipeline_domain_snapshots', 'fixture_snapshots'],
  ['client_manual_score_rows', 'fixture_rows'],
  ['client_manual_score_runs', 'fixture_runs'],
]) {
  const pattern = new RegExp(`\\bpublic\\.${table}\\b`, 'g');
  if (!pattern.test(body)) throw new Error(`Expected migration reference to ${table}`);
  body = body.replace(pattern, fixture);
}
// Score classification is supplied as a fixture constant, so the regression
// does not depend on any installed production function or table.
const scoreCall = /public\.client_report_score_code\(m\.score\)/g;
if ([...body.matchAll(scoreCall)].length !== 1) throw new Error('Unexpected score-classifier expression');
body = body.replace(scoreCall, 'm.fixture_score_code');
if (/\bpublic\s*\.|\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COPY|CALL|EXECUTE|DO)\b/i.test(body)) {
  throw new Error('Unsafe or unexpected non-SELECT SQL in extracted body');
}
const allowedRelations = new Set(['fixture_snapshots', 'fixture_rows', 'fixture_runs', 'retry_facts', 'LATERAL']);
for (const match of body.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)) {
  if (!allowedRelations.has(match[1])) throw new Error(`Unexpected relation: ${match[1]}`);
}

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-10T12:00:00Z';
const FROM = '2026-10-01T00:00:00Z';
const TO = '2026-11-01T00:00:00Z';
const fields = ['scored_companies', 'working_score_companies', 'email_found_companies', 'validated_emails'];
const run = (changes = {}) => ({ id: RUN, client_user_id: CLIENT, source_filename: 'fixture.csv', is_no_email_retry: true, ...changes });
const row = (changes = {}) => ({
  id: 1, run_id: RUN, domain: 'fixture.invalid', score: 2000, fixture_score_code: 'C',
  email: null, email_validation_status: null, email2: null, email2_validation_status: null,
  processed_at: AT, bucket: 'medium', error_message: null, ...changes,
});
const snapshot = (changes = {}) => ({
  client_user_id: CLIENT, source_kind: 'manual_scoring', source_run_id: RUN, source_row_id: '1',
  legacy_inferred: false, scored_at: AT, score_code: 'C', email_found_count: 1, email_validated_count: 1,
  metadata: { is_no_email_retry: true }, ...changes,
});
const cases = [];
function add(name, expected, changes = {}) {
  cases.push({ name, expected: Object.fromEntries(fields.map((field, i) => [field, expected[i]])),
    runs: [run()], rows: [row()], snapshots: [], scoreFilter: null, ...changes });
}
for (const status of ['valid', 'role_address', 'free_provider', 'catch_all']) {
  add(`single-primary-${status}`, [1, 1, 1, 1], { rows: [row({ email: 'team@fixture.invalid', email_validation_status: status })] });
  add(`single-secondary-${status}`, [1, 1, 1, 1], { rows: [row({ email2: 'team@fixture.invalid', email2_validation_status: status })] });
}
add('no-addresses-null-statuses', [1, 1, 0, 0]);
add('address-null-status', [1, 1, 1, 0], { rows: [row({ email: 'team@fixture.invalid' })] });
add('address-unready-status', [1, 1, 1, 0], { rows: [row({ email: 'team@fixture.invalid', email_validation_status: 'invalid' })] });
add('two-unready-addresses', [1, 1, 1, 0], { rows: [row({ email: 'one@fixture.invalid', email_validation_status: 'invalid', email2: 'two@fixture.invalid', email2_validation_status: 'unknown' })] });
add('ready-status-without-address', [1, 1, 0, 0], { rows: [row({ email_validation_status: 'valid', email2_validation_status: 'catch_all' })] });
add('empty-addresses', [1, 1, 0, 0], { rows: [row({ email: '', email_validation_status: 'valid', email2: '', email2_validation_status: 'valid' })] });
add('blank-addresses', [1, 1, 0, 0], { rows: [row({ email: '  ', email_validation_status: 'valid', email2: '   ', email2_validation_status: 'valid' })] });
add('normalized-duplicate-two-ready', [1, 1, 1, 1], { rows: [row({ email: ' Team@Fixture.Invalid ', email_validation_status: 'valid', email2: 'team@fixture.invalid', email2_validation_status: 'catch_all' })] });
add('normalized-duplicate-mixed-status', [1, 1, 1, 1], { rows: [row({ email: ' Team@Fixture.Invalid ', email_validation_status: null, email2: 'team@fixture.invalid', email2_validation_status: 'valid' })] });
add('two-distinct-ready', [1, 1, 1, 2], { rows: [row({ email: 'one@fixture.invalid', email_validation_status: 'valid', email2: 'two@fixture.invalid', email2_validation_status: 'role_address' })] });
add('non-retry-run', [0, 0, 0, 0], { runs: [run({ is_no_email_retry: false })], rows: [row({ email: 'team@fixture.invalid', email_validation_status: 'valid' })] });
add('legacy-retry-filename', [1, 1, 1, 1], { runs: [run({ is_no_email_retry: false, source_filename: 'no-email-retry-fixture.txt' })], rows: [row({ email: 'team@fixture.invalid', email_validation_status: 'valid' })] });
add('foreign-client-run', [0, 0, 0, 0], { runs: [run({ client_user_id: OTHER_CLIENT })] });
add('null-domain', [0, 0, 0, 0], { rows: [row({ domain: null })] });
add('blank-domain', [0, 0, 0, 0], { rows: [row({ domain: '  ' })] });
add('unprocessed-row', [0, 0, 0, 0], { rows: [row({ bucket: null, error_message: null })] });
add('processed-error-row', [1, 1, 0, 0], { rows: [row({ bucket: null, error_message: 'fixture error' })] });
add('live-before-period', [0, 0, 0, 0], { rows: [row({ processed_at: '2026-09-30T23:59:59Z' })] });
add('live-at-exclusive-end', [0, 0, 0, 0], { rows: [row({ processed_at: TO })] });
add('live-at-inclusive-start', [1, 1, 0, 0], { rows: [row({ processed_at: FROM })] });
add('snapshot-live-dedup', [1, 1, 1, 1], { rows: [row({ email: 'team@fixture.invalid', email_validation_status: 'valid' })], snapshots: [snapshot()] });
add('durable-marker-after-run-cleanup', [1, 1, 1, 1], { runs: [], rows: [], snapshots: [snapshot()] });
add('durable-filename-after-run-cleanup', [1, 1, 1, 2], { runs: [], rows: [], snapshots: [snapshot({ email_found_count: 2, email_validated_count: 2, metadata: { source_filename: 'no-email-retry-fixture.txt' } })] });
add('snapshot-live-run-marker', [1, 1, 1, 1], { rows: [], snapshots: [snapshot({ metadata: {} })] });
add('snapshot-not-retry', [0, 0, 0, 0], { runs: [run({ is_no_email_retry: false })], rows: [], snapshots: [snapshot({ metadata: {} })] });
add('snapshot-foreign-client', [0, 0, 0, 0], { runs: [], rows: [], snapshots: [snapshot({ client_user_id: OTHER_CLIENT })] });
add('snapshot-wrong-source', [0, 0, 0, 0], { rows: [], snapshots: [snapshot({ source_kind: 'auto_pipeline' })] });
add('snapshot-legacy-inferred', [0, 0, 0, 0], { runs: [], rows: [], snapshots: [snapshot({ legacy_inferred: true })] });
add('snapshot-before-period', [0, 0, 0, 0], { runs: [], rows: [], snapshots: [snapshot({ scored_at: '2026-09-30T23:59:59Z' })] });
add('snapshot-at-exclusive-end', [0, 0, 0, 0], { runs: [], rows: [], snapshots: [snapshot({ scored_at: TO })] });

const scores = [['A', 1000001], ['B', 15001], ['C', 1001], ['rejected', 1000], ['error', null]];
const scoredRows = scores.map(([code, score], i) => row({ id: i + 1, score, fixture_score_code: code, email: `score${i}@fixture.invalid`, email_validation_status: 'valid' }));
add('mixed-score-codes', [5, 3, 3, 3], { rows: scoredRows });
for (const filter of ['A', 'B', ' c ']) add(`score-filter-${filter.trim()}`, [1, 1, 1, 1], { rows: scoredRows, scoreFilter: filter });
add('score-filter-no-match', [0, 0, 0, 0], { rows: scoredRows, scoreFilter: 'D' });
add('snapshot-score-filter', [1, 1, 1, 1], { runs: [], rows: [], scoreFilter: 'A', snapshots: [snapshot({ score_code: 'A' }), snapshot({ source_row_id: '2', score_code: 'C' })] });

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
function literal(value, type) {
  if (value === null || value === undefined) return `NULL::${type}`;
  if (type === 'jsonb') return `${quote(JSON.stringify(value))}::jsonb`;
  return `${quote(value)}::${type}`;
}
const runSchema = { id: 'uuid', client_user_id: 'uuid', source_filename: 'text', is_no_email_retry: 'boolean' };
const rowSchema = { id: 'bigint', run_id: 'uuid', domain: 'text', score: 'numeric', fixture_score_code: 'text', email: 'text', email_validation_status: 'text', email2: 'text', email2_validation_status: 'text', processed_at: 'timestamptz', bucket: 'text', error_message: 'text' };
const snapshotSchema = { client_user_id: 'uuid', source_kind: 'text', source_run_id: 'text', source_row_id: 'text', legacy_inferred: 'boolean', scored_at: 'timestamptz', score_code: 'text', email_found_count: 'integer', email_validated_count: 'integer', metadata: 'jsonb' };
function fixtureCte(name, schema, rows) {
  const columns = Object.keys(schema);
  const values = rows.length
    ? 'VALUES ' + rows.map((value) => '(' + columns.map((column) => literal(value[column], schema[column])).join(',') + ')').join(',')
    : 'SELECT ' + columns.map((column) => `NULL::${schema[column]}`).join(',') + ' WHERE false';
  return `${name} (${columns.join(',')}) AS (${values})`;
}
function query(test) {
  let select = body;
  for (const [parameter, value] of Object.entries({
    p_client_user_id: literal(CLIENT, 'uuid'), p_from: literal(FROM, 'timestamptz'),
    p_to: literal(TO, 'timestamptz'), p_score_code: literal(test.scoreFilter, 'text'),
  })) select = select.replace(new RegExp(`\\b${parameter}\\b`, 'g'), value);
  if (/\bp_(?:client_user_id|from|to|score_code)\b/.test(select)) throw new Error('Unsubstituted function parameter');
  return 'WITH ' + [
    fixtureCte('fixture_runs', runSchema, test.runs), fixtureCte('fixture_rows', rowSchema, test.rows),
    fixtureCte('fixture_snapshots', snapshotSchema, test.snapshots),
    `actual (${fields.join(',')}) AS (${select})`,
  ].join(',\n') + `\nSELECT json_build_object('name',${quote(test.name)},'actual',row_to_json(actual)) FROM actual;`;
}
const sql = ['BEGIN READ ONLY;', "SET LOCAL statement_timeout = '30s';", ...cases.map(query), 'COMMIT;'].join('\n');
if (printSql) {
  process.stdout.write(sql + '\n');
  process.exit(0);
}
if (!sshReadOnly) {
  process.stdout.write(JSON.stringify({ mode: 'prepared-no-network', migration, cases: cases.length, note: 'Use --ssh-read-only to run synthetic SELECT fixtures on PostgreSQL.' }) + '\n');
  process.exit(0);
}

const ssh = spawn('ssh', [
  '-i', '/Users/cybermart/.ssh/portal_hostkey_mac_ed25519',
  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
  'root@139.60.162.24', 'docker exec -i main-postgres psql -X -U postgres -d postgres -At -v ON_ERROR_STOP=1',
], { stdio: ['pipe', 'pipe', 'pipe'] });
ssh.stdin.end(sql);
let stdout = '';
let stderr = '';
ssh.stdout.setEncoding('utf8');
ssh.stderr.setEncoding('utf8');
ssh.stdout.on('data', (chunk) => { stdout += chunk; });
ssh.stderr.on('data', (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolveExit, reject) => {
  ssh.on('error', reject);
  ssh.on('close', resolveExit);
});
if (exitCode !== 0) throw new Error(`Read-only PostgreSQL fixture execution failed: ${stderr.trim()}`);
const results = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
if (results.length !== cases.length) throw new Error(`Expected ${cases.length} results, got ${results.length}`);
const failures = [];
for (let i = 0; i < cases.length; i += 1) {
  const test = cases[i];
  const result = results[i];
  if (result.name !== test.name || fields.some((field) => result.actual?.[field] !== test.expected[field])) {
    failures.push({ name: test.name, expected: test.expected, actual: result.actual });
  }
}
process.stdout.write(JSON.stringify({ mode: 'ssh-read-only-synthetic-fixtures', migration, cases: cases.length,
  passed: cases.length - failures.length, failed: failures.length, failures }) + '\n');
if (failures.length) process.exitCode = 1;
