/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const ANYA_ID = '9e2c53fe-4b86-40b1-b464-757ffe0944dd';
const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260818_0002_payment_request_control.sql',
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) return '';
  return fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase();
}

function functionSql(sql: string, functionName: string): string {
  const start = sql.indexOf(`create or replace function public.${functionName}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 3);
}

function createTableSql(sql: string, tableName: string): string {
  const start = sql.indexOf(`create table if not exists public.${tableName}`);
  if (start < 0) return '';
  const end = sql.indexOf(');', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 2);
}

function readonlyColumns(sql: string, tableName: string): string[] {
  const match = sql.match(
    new RegExp(`grant select\\s*\\(([^)]+)\\)\\s*on(?: table)? public\\.${tableName}\\s+to readonly`),
  );
  return (match?.[1] ?? '')
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

describe('payment request control migration', () => {
  it('exists as a forward-only migration', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('adds a closed lifecycle, payment provenance and bounded request metadata', () => {
    const sql = readMigration();

    for (const column of [
      'expense_type',
      'expected_payment_on',
      'urgency',
      'document_url',
      'approval_reason',
      'paid_on',
      'paid_on_source',
      'paid_by',
      'paid_at',
      'updated_at',
      'idempotency_key',
      'submission_fingerprint',
    ]) {
      expect(sql).toMatch(new RegExp(`add column if not exists ${column}\\b`));
    }

    expect(sql).toMatch(/expense_type\s+in\s*\(\s*'one_time'\s*,\s*'planned'\s*,\s*'legacy_unclassified'\s*\)/);
    expect(sql).toMatch(/urgency\s+in\s*\(\s*'normal'\s*,\s*'urgent'\s*,\s*'critical'\s*\)/);
    expect(sql).toMatch(/status\s+in\s*\(\s*'pending'\s*,\s*'approved'\s*,\s*'paid'\s*,\s*'rejected'\s*\)/);
    expect(sql).toMatch(/approval_reason\s+in\s*\(\s*'planned'\s*,\s*'limit_exceeded'\s*\)/);
    expect(sql).toMatch(/paid_on_source\s+in\s*\(\s*'entered'\s*,\s*'legacy_created_at'\s*\)/);
    expect(sql).toContain('foreign key (paid_by) references public.profiles(id) on delete set null');
    expect(sql).toMatch(/document_url is null or char_length\(document_url\) <= 2000/);
  });

  it('backfills every old row as paid legacy data on its Moscow creation date', () => {
    const sql = readMigration();
    const backfill = sql.match(/update public\.payment_requests set [^;]+where expense_type is null;/)?.[0] ?? '';
    expect(sql.indexOf('drop constraint if exists payment_requests_status_check')).toBeLessThan(
      sql.indexOf('update public.payment_requests set'),
    );

    expect(backfill).toContain("expense_type = 'legacy_unclassified'");
    expect(backfill).toContain("status = 'paid'");
    expect(backfill).toMatch(/expected_payment_on\s*=\s*\(created_at at time zone 'europe\/moscow'\)::date/);
    expect(backfill).toMatch(/paid_on\s*=\s*\(created_at at time zone 'europe\/moscow'\)::date/);
    expect(backfill).toContain("paid_on_source = 'legacy_created_at'");
    expect(backfill).toMatch(/paid_by\s*=\s*null/);
    expect(sql).toContain("'legacy_backfilled'");
    expect(sql).toMatch(/payment_request_events[^;]+not exists/);
  });

  it('preserves requester identity and audit history when an employee profile is hard-deleted', () => {
    const sql = readMigration();
    const serializer = functionSql(sql, 'payment_request_api_record');
    const list = functionSql(sql, 'list_payment_requests');
    const submit = functionSql(sql, 'submit_payment_request');

    expect(sql).toMatch(/add column if not exists requester_user_id uuid\b/);
    expect(sql).toMatch(/add column if not exists requester_name text\b/);
    expect(sql).toMatch(
      /update public\.payment_requests[^;]+requester_user_id\s*=\s*request\.user_id[^;]+requester_name[^;]+from public\.profiles\s+requester[^;]+requester\.id\s*=\s*request\.user_id/,
    );
    expect(sql.indexOf('update public.payment_requests')).toBeLessThan(
      sql.indexOf('alter column requester_user_id set not null'),
    );
    expect(sql.indexOf('update public.payment_requests')).toBeLessThan(
      sql.indexOf('alter column requester_name set not null'),
    );

    expect(sql).toContain('drop constraint if exists payment_requests_user_id_fkey');
    expect(sql).toContain('alter column user_id drop not null');
    expect(sql).toMatch(
      /foreign key\s*\(\s*user_id\s*\)\s*references public\.profiles\s*\(\s*id\s*\)\s*on delete set null/,
    );
    expect(sql).toMatch(
      /payment_request_id uuid not null[^;]+references public\.payment_requests\s*\(\s*id\s*\) on delete restrict/,
    );

    expect(serializer).toContain("'user_id', request.requester_user_id");
    expect(serializer).toContain("'requester_name', request.requester_name");
    expect(serializer).not.toMatch(/join public\.profiles requester/);
    expect(serializer).toMatch(/auth\.uid\(\)\s*=\s*request\.user_id/);

    expect(list).toMatch(/select request\.id,\s*request\.requester_user_id,\s*request\.requester_name/);
    expect(list).not.toMatch(/join public\.profiles requester/);
    expect(list).toMatch(/auth\.uid\(\)\s*=\s*request\.user_id/);

    expect(submit).toMatch(/select[^;]+full_name[^;]+into v_actor_name[^;]+from public\.profiles/);
    expect(submit).toMatch(
      /insert into public\.payment_requests[^;]+user_id[^;]+requester_user_id[^;]+requester_name/,
    );
    expect(submit).toMatch(/values\s*\([^;]+v_actor_id[^;]+v_actor_id[^;]+v_actor_name/);
  });

  it('stores only Anya in a sealed manager capability table', () => {
    const sql = readMigration();
    const table = createTableSql(sql, 'payment_request_managers');

    expect(table).toMatch(/user_id uuid(?: not null)? primary key/);
    expect(table).toMatch(/references public\.profiles\s*\(\s*id\s*\) on delete cascade/);
    expect(table).toMatch(
      /granted_at (?:timestamptz|timestamp with time zone) not null default now\(\)/,
    );
    expect(table).toContain('granted_by uuid');
    expect(table).not.toContain('granted_by uuid not null');

    const seedStart = sql.indexOf('insert into public.payment_request_managers');
    const seedEnd = seedStart < 0 ? -1 : sql.indexOf(';', seedStart);
    const seed = seedStart < 0
      ? ''
      : sql.slice(seedStart, seedEnd < 0 ? undefined : seedEnd + 1);
    expect(seed).toContain(`'${ANYA_ID}'::uuid`);
    expect(seed.match(/[0-9a-f]{8}-[0-9a-f-]{27}/g)).toEqual([ANYA_ID]);
    expect(seed).toMatch(/select\s+[^;]*id\s+from public\.profiles\s+where id\s*=\s*'[^']+'::uuid/);
    expect(seed).not.toMatch(/\b(?:email|full_name|role|is_hr)\b/);

    expect(sql).not.toContain('add column if not exists can_manage_payment_requests');
    expect(sql).not.toContain('prevent_profile_privilege_escalation');
    expect(sql).toContain('alter table public.payment_request_managers enable row level security');
    expect(sql).toContain('alter table public.payment_request_managers force row level security');
    for (const role of ['public', 'anon', 'authenticated', 'readonly']) {
      expect(sql).toMatch(
        new RegExp(`revoke all on(?: table)? public\\.payment_request_managers from ${role}`),
      );
    }
    expect(sql).toMatch(
      /grant all(?: privileges)? on(?: table)? public\.payment_request_managers to [^;]*service_role/,
    );
    expect(sql).toMatch(
      /grant all(?: privileges)? on(?: table)? public\.payment_request_managers to [^;]*postgres/,
    );
  });

  it('keeps staff access and manager access fail-closed and capability based', () => {
    const sql = readMigration();
    const canUse = functionSql(sql, 'can_use_payment_requests');
    const canManage = functionSql(sql, 'can_manage_payment_requests');

    for (const predicate of [canUse, canManage]) {
      expect(predicate).toContain('security definer');
      expect(predicate).toContain("set search_path = ''");
      expect(predicate).toContain('actor.id = auth.uid()');
      expect(predicate).toContain('coalesce(actor.is_demo, false) = false');
      expect(predicate).toContain(
        "actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')",
      );
      expect(predicate).not.toMatch(/actor\.role\s*=\s*'client'/);
      expect(predicate).not.toMatch(/\b(?:email|full_name)\b/);
    }
    expect(canManage).toContain('from public.payment_request_managers');
    expect(canManage).toMatch(
      /(?:\b\w+\.user_id\s*=\s*actor\.id|actor\.id\s*=\s*\w+\.user_id)/,
    );
    expect(canManage).not.toContain(ANYA_ID);

    for (const fn of ['can_use_payment_requests', 'can_manage_payment_requests']) {
      expect(sql).toContain(`revoke all on function public.${fn}() from public`);
      expect(sql).toContain(`revoke all on function public.${fn}() from anon`);
      expect(sql).toContain(`revoke all on function public.${fn}() from authenticated`);
      expect(sql).toContain(`grant execute on function public.${fn}() to authenticated`);
    }
  });

  it('uses one global Moscow-month limit: 40k in Jan/May/Dec and 75k otherwise', () => {
    const sql = readMigration();
    const limit = functionSql(sql, 'payment_request_month_limit');

    expect(limit).toContain('returns numeric');
    expect(limit).toMatch(/extract\(month from p_month\)/);
    expect(limit).toMatch(/in\s*\(\s*1\s*,\s*5\s*,\s*12\s*\)/);
    expect(limit).toContain('40000');
    expect(limit).toContain('75000');
    expect(limit).not.toMatch(/department|user_id|project_id/);
  });

  it('defines one shared, deterministically ordered advisory-lock helper for budget mutations', () => {
    const sql = readMigration();
    const lock = functionSql(sql, 'lock_payment_request_months');

    expect(lock).toContain('pg_advisory_xact_lock');
    expect(lock).toContain('unnest(p_months)');
    expect(lock).toContain('select distinct');
    expect(lock).toContain('order by');
    expect(lock).toMatch(/payment_request|payment_requests/);
  });

  it('computes one-time usage from paid fact or approved reserve without counting pending/planned twice', () => {
    const sql = readMigration();
    const summary = functionSql(sql, 'payment_request_month_summary');

    expect(summary).toContain('payment_request_month_limit');
    expect(summary).toContain("expense_type in ('one_time', 'legacy_unclassified')");
    expect(summary).toMatch(/status\s*=\s*'paid'[^;]+paid_on/);
    expect(summary).toMatch(/status\s*=\s*'approved'[^;]+expected_payment_on/);
    expect(summary).not.toMatch(/status\s*=\s*'pending'[^;]+(?:paid_one_time|reserved_one_time)/);
    expect(summary).toContain('greatest');
    expect(summary).toMatch(/remaining/);
    expect(summary).toMatch(/overage/);
    expect(summary).toMatch(/legacy_count|legacycount/);
    expect(summary).toMatch(/paid_all|paidall/);
  });

  it('lists only the selected-month read model and redacts document URLs from other staff', () => {
    const sql = readMigration();
    const list = functionSql(sql, 'list_payment_requests');

    expect(list).toContain('public.can_use_payment_requests()');
    expect(list).toMatch(/expected_payment_on[^;]+p_month/);
    expect(list).toMatch(/paid_on[^;]+p_month/);
    expect(list).toMatch(/expected_payment_on[^;]+v_month[^;]+or[^;]+paid_on[^;]+v_month/);
    expect(list).toMatch(/case when[^;]+auth\.uid\(\)[^;]+user_id[^;]+can_manage_payment_requests\(\)[^;]+document_url[^;]+else null/);
    expect(list).toContain('from public.payment_requests');
    expect(list).not.toMatch(/requester_email|\.email\b/);
  });

  it('submits through one atomic RPC and never accepts legacy as new input', () => {
    const sql = readMigration();
    const submit = functionSql(sql, 'submit_payment_request');

    expect(submit).toContain('security definer');
    expect(submit).toContain("set search_path = ''");
    expect(submit).toContain('public.can_use_payment_requests()');
    expect(submit).toContain("p_expense_type in ('one_time', 'planned')");
    expect(submit).toMatch(/p_department is null[^;]+p_expense_type is null[^;]+p_urgency is null/);
    expect(submit).toMatch(/p_amount[^;]+round\(p_amount,\s*2\)/);
    expect(submit).not.toMatch(/p_expense_type\s*=\s*'legacy_unclassified'/);
    expect(submit).toContain('public.lock_payment_request_months');
    expect(submit).toContain('public.payment_request_month_summary');
    expect(submit.indexOf('public.lock_payment_request_months')).toBeLessThan(
      submit.indexOf('public.payment_request_month_summary'),
    );
    expect(submit.indexOf('public.lock_payment_request_months')).toBeLessThan(
      submit.indexOf('insert into public.payment_requests'),
    );
    expect(submit.lastIndexOf('public.payment_request_month_summary')).toBeGreaterThan(
      submit.indexOf('insert into public.payment_requests'),
    );
    expect(submit).toContain("p_expense_type = 'planned'");
    expect(submit).toMatch(/p_amount\s*<=\s*(?:v_remaining|v_available)/);
    expect(submit).toContain("'limit_exceeded'");
    expect(submit).toContain("'auto_approved'");
    expect(submit).toContain("'approval_required'");
    expect(submit).toContain('auth.uid()');
    expect(submit).toContain('payment_request_project_not_found');
    expect(submit).toMatch(/p_project_id is not null[^;]+from public\.projects[^;]+p_project_id/);
    expect(submit).toContain('insert into public.payment_request_events');
  });

  it('makes submission idempotent per JWT actor and canonical immutable payload', () => {
    const sql = readMigration();
    const submit = functionSql(sql, 'submit_payment_request');
    const idempotencyLock = functionSql(sql, 'lock_payment_request_submission');

    expect(sql).toMatch(/add column if not exists idempotency_key uuid\b/);
    expect(sql).toMatch(/add column if not exists submission_fingerprint text\b/);
    expect(sql).not.toMatch(/add column if not exists idempotency_key uuid not null/);
    expect(sql).not.toMatch(/add column if not exists submission_fingerprint text not null/);
    expect(sql).toMatch(
      /check\s*\(\s*\(idempotency_key is null\)\s*=\s*\(submission_fingerprint is null\)\s*\)/,
    );
    expect(sql).toMatch(
      /check\s*\(\s*submission_fingerprint is null\s+or\s+char_length\(submission_fingerprint\)\s*=\s*64\s*\)/,
    );
    expect(sql).toMatch(
      /create unique index[^;]+on public\.payment_requests\s*\(\s*requester_user_id\s*,\s*idempotency_key\s*\)[^;]+where idempotency_key is not null/,
    );

    expect(idempotencyLock).toContain('returns void');
    expect(idempotencyLock).toContain('pg_advisory_xact_lock');
    expect(idempotencyLock).toContain('p_actor_id');
    expect(idempotencyLock).toContain('p_idempotency_key');
    expect(idempotencyLock).toMatch(/payment_request[^']*idempotency/);

    expect(submit).toMatch(/p_idempotency_key uuid/);
    expect(submit).toMatch(/p_idempotency_key is null[^;]+payment_request_invalid_input/);
    expect(submit).toContain('public.lock_payment_request_submission');
    expect(submit).toContain('sha256');
    expect(submit).toContain('submission_fingerprint');
    for (const field of [
      'department',
      'description',
      'amount',
      'project_id',
      'comment',
      'expense_type',
      'expected_payment_on',
      'urgency',
      'document_url',
    ]) {
      expect(submit).toContain(`'${field}'`);
    }
    expect(submit).toMatch(
      /where[^;]+requester_user_id\s*=\s*v_actor_id[^;]+idempotency_key\s*=\s*p_idempotency_key/,
    );
    expect(submit).toContain('payment_request_idempotency_conflict');
    expect(submit).toMatch(/submission_fingerprint is distinct from v_submission_fingerprint/);
    expect(submit).toMatch(/insert into public\.payment_requests[^;]+idempotency_key[^;]+submission_fingerprint/);

    const idempotencyLockAt = submit.indexOf('public.lock_payment_request_submission');
    const existingLookupAt = submit.indexOf('idempotency_key = p_idempotency_key');
    const budgetLockAt = submit.indexOf('public.lock_payment_request_months');
    const insertAt = submit.indexOf('insert into public.payment_requests');
    const replayReturnAt = submit.indexOf('return jsonb_build_object', existingLookupAt);
    expect(idempotencyLockAt).toBeGreaterThanOrEqual(0);
    expect(idempotencyLockAt).toBeLessThan(existingLookupAt);
    expect(existingLookupAt).toBeLessThan(budgetLockAt);
    expect(existingLookupAt).toBeLessThan(replayReturnAt);
    expect(replayReturnAt).toBeLessThan(insertAt);

    expect(submit).toContain('v_actor_id uuid := auth.uid()');
    expect(submit).not.toMatch(/p_(?:actor|user)_id/);
    for (const privateColumn of ['idempotency_key', 'submission_fingerprint']) {
      expect(readonlyColumns(sql, 'payment_requests')).not.toContain(privateColumn);
    }
  });

  it('transitions only by Anya with row locking, CAS and closed lifecycle rules', () => {
    const sql = readMigration();
    const transition = functionSql(sql, 'transition_payment_request');

    expect(transition).toContain('security definer');
    expect(transition).toContain("set search_path = ''");
    expect(transition).toContain('public.can_manage_payment_requests()');
    expect(transition).toMatch(/p_action is null[^;]+not in\s*\(\s*'approve'/);
    expect(transition).toContain('for update');
    expect(transition).toMatch(/updated_at\s*(?:<>|!=|is distinct from)\s*p_expected_updated_at/);
    expect(transition).toContain('public.lock_payment_request_months');
    for (const action of ['approve', 'reject', 'mark_paid', 'classify_legacy']) {
      expect(transition).toContain(`'${action}'`);
    }
    expect(transition).toMatch(/p_action\s*=\s*'mark_paid'[^;]+status[^;]+approved/);
    expect(transition).toMatch(/p_action\s*=\s*'classify_legacy'[^;]+legacy_unclassified/);
    expect(transition).toMatch(/p_action\s*=\s*'classify_legacy'[^;]+status[^;]+paid/);
    expect(transition).toMatch(/p_expense_type[^;]+in\s*\(\s*'one_time'\s*,\s*'planned'\s*\)/);
    expect(transition).toMatch(/p_action\s*=\s*'classify_legacy'[^;]+p_paid_on\s+is\s+null[^;]+raise exception/);
    expect(transition).toMatch(/expected_payment_on\s*=\s*p_paid_on/);
    expect(transition).toContain('paid_by = auth.uid()');
    expect(transition).toContain("paid_on_source = 'entered'");
    expect(transition).toContain('insert into public.payment_request_events');
    expect(transition).toContain('affected_months');
    expect(transition).toContain('public.payment_request_month_summary');
    expect(transition).toMatch(/p_action\s*=\s*'reject'[^;]+status[^;]+in\s*\(\s*'pending'\s*,\s*'approved'\s*\)/);
    expect(transition).not.toContain('to_jsonb(v_request)');
    expect(transition).not.toContain('to_jsonb(v_updated)');
    expect(transition).not.toMatch(/metadata[^;]+(?:description|comment|document_url)/);
    expect(transition).toMatch(/metadata[^;]+(?:expense_type|expected_payment_on|paid_on|amount)/);
  });

  it('stores an append-only audit event for every server-side state change', () => {
    const sql = readMigration();
    const table = createTableSql(sql, 'payment_request_events');
    const submit = functionSql(sql, 'submit_payment_request');
    const transition = functionSql(sql, 'transition_payment_request');

    expect(sql).toContain('create table if not exists public.payment_request_events');
    expect(sql).toContain('payment_request_id uuid not null');
    expect(sql).toContain('actor_user_id uuid');
    expect(table).toMatch(/actor_user_id uuid[^;]+references public\.profiles\s*\(\s*id\s*\) on delete set null/);
    expect(table).toContain('actor_name text not null');
    expect(sql).toContain('event_type text not null');
    expect(sql).toContain('from_status text');
    expect(sql).toContain('to_status text');
    expect(sql).toContain('metadata jsonb not null default');
    expect(sql).toContain('created_at timestamptz not null default now()');
    expect(sql).toContain('alter table public.payment_request_events enable row level security');
    expect(sql).toContain('alter table public.payment_request_events force row level security');
    expect(sql).toContain('revoke all on public.payment_request_events from anon');
    expect(sql).toContain('revoke all on public.payment_request_events from authenticated');
    expect(sql).toContain('revoke all on public.payment_request_events from readonly');
    expect(sql).not.toMatch(/create policy [^;]+payment_request_events[^;]+for (?:insert|update|delete)/);

    const legacyEventStart = sql.indexOf('insert into public.payment_request_events');
    const legacyEventEnd = sql.indexOf(';', legacyEventStart);
    const legacyEvent = sql.slice(legacyEventStart, legacyEventEnd + 1);
    expect(legacyEvent).toContain('actor_name');
    expect(legacyEvent).toContain("'система'");

    for (const mutation of [submit, transition]) {
      expect(mutation).toMatch(/select[^;]+full_name[^;]+into v_actor_name[^;]+from public\.profiles/);
      expect(mutation).toMatch(/insert into public\.payment_request_events[^;]+actor_name/);
      expect(mutation).toMatch(/values\s*\([^;]+v_actor_id[^;]+v_actor_name/);
      expect(mutation).not.toMatch(/update public\.payment_request_events|delete from public\.payment_request_events/);
    }
  });

  it('keeps the internal row serializer explicit and free of emails or future columns', () => {
    const sql = readMigration();
    const serializer = functionSql(sql, 'payment_request_api_record');

    expect(serializer).toContain('jsonb_build_object');
    expect(serializer).not.toContain('to_jsonb(request)');
    expect(serializer).not.toMatch(/requester_email|\.email\b/);
    expect(serializer).not.toMatch(/idempotency_key|submission_fingerprint/);
    for (const field of ['user_id', 'expense_type', 'expected_payment_on', 'document_url', 'updated_at']) {
      expect(serializer).toContain(`'${field}'`);
    }
  });

  it('removes unsafe browser table access and exposes only hardened RPC entry points', () => {
    const sql = readMigration();

    for (const policy of [
      'payment_requests_select_all',
      'payment_requests_insert_own',
      'payment_requests_update_all',
    ]) {
      expect(sql).toContain(`drop policy if exists ${policy} on public.payment_requests`);
    }
    expect(sql).toContain('alter table public.payment_requests enable row level security');
    expect(sql).toContain('alter table public.payment_requests force row level security');
    expect(sql).toContain('revoke all on public.payment_requests from anon');
    expect(sql).toContain('revoke all on public.payment_requests from authenticated');
    expect(sql).toContain('grant all on public.payment_requests to service_role');
    expect(sql).not.toMatch(/create policy [^;]+payment_requests[^;]+using\s*\(\s*true\s*\)/);
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)[^;]+payment_requests[^;]+to authenticated/);

    expect(sql).toMatch(
      /revoke (?:all|select) on(?: table)? public\.payment_requests from readonly/,
    );
    expect(readonlyColumns(sql, 'payment_requests').sort()).toEqual([
      'amount',
      'approval_reason',
      'comment',
      'created_at',
      'decided_at',
      'decided_by',
      'decision_comment',
      'department',
      'description',
      'expense_type',
      'expected_payment_on',
      'id',
      'paid_at',
      'paid_by',
      'paid_on',
      'paid_on_source',
      'project_id',
      'status',
      'updated_at',
      'urgency',
      'user_id',
    ].sort());
    expect(sql).not.toMatch(/grant select on(?: table)? public\.payment_requests to readonly/);
    expect(readonlyColumns(sql, 'payment_requests')).not.toContain('document_url');

    for (const fn of [
      'list_payment_requests',
      'payment_request_month_summary',
      'submit_payment_request',
      'transition_payment_request',
    ]) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^;]+from public`));
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^;]+from anon`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^;]+to authenticated`));
    }
  });
});
