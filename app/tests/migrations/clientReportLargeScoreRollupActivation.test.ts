/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260813_0001_client_report_large_score_rollup_activation.sql',
);
const rawSql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();

function functionSql(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = start === -1 ? -1 : sql.indexOf('$$;', start);
  return start === -1 || end === -1 ? '' : sql.slice(start, end + 3);
}

describe('large-score client-report rollup activation migration', () => {
  it('is a forward-only additive cutover and keeps both report RPCs intact', () => {
    expect(rawSql).not.toBe('');
    expect(sql).not.toContain(
      'create or replace function public.client_report_pipeline_summary(',
    );
    expect(sql).not.toContain(
      'drop function if exists public.client_report_pipeline_summary(',
    );
    expect(sql).not.toContain(
      'drop function if exists public.client_report_pipeline_summary_shadow(',
    );
  });

  it('guards every direct bucket/checkpoint mutation by a building parent run', () => {
    const guard = functionSql('guard_client_report_large_score_rollup_child');
    expect(guard).toContain("tg_op = 'insert'");
    expect(guard).toContain("tg_op = 'update'");
    expect(guard).toContain("tg_op = 'delete'");
    expect(guard).toContain('public.client_report_large_score_rollup_runs');
    expect(guard).toContain("run.status = 'building'");
    expect(guard).toContain('old.rollup_run_id');
    expect(guard).toContain('new.rollup_run_id');
    expect(guard).toContain("raise exception 'large-score rollup children are writable only while building'");

    for (const table of [
      'client_report_large_score_rollup_buckets',
      'client_report_large_score_rollup_checkpoints',
    ]) {
      expect(sql).toMatch(new RegExp(
        `create trigger trg_guard_${table} before insert or update or delete on public\\.${table}`,
      ));
    }
  });

  it('revokes untriggerable truncate rights left by the original service grant', () => {
    for (const table of [
      'client_report_large_score_rollup_buckets',
      'client_report_large_score_rollup_checkpoints',
    ]) {
      expect(sql).toContain(
        `revoke truncate on table public.${table} from service_role`,
      );
    }
  });

  it('keeps parent deletion safe: terminal runs are immutable and building cascades are explicit', () => {
    const parentGuard = functionSql('guard_client_report_large_score_rollup_run');
    expect(parentGuard).toContain("tg_op = 'delete'");
    expect(parentGuard).toContain("old.status <> 'building'");
    expect(parentGuard).toContain(
      'delete from public.client_report_large_score_rollup_checkpoints',
    );
    expect(parentGuard).toContain(
      'delete from public.client_report_large_score_rollup_buckets',
    );
    expect(parentGuard).toContain('return old');
  });

  it('stores one tenant-owned active generation with a restrictive composite foreign key', () => {
    expect(sql).toContain(
      'create table if not exists public.client_report_large_score_rollup_activations',
    );
    expect(sql).toMatch(
      /primary key \(client_user_id\)/,
    );
    expect(sql).toMatch(
      /foreign key \(rollup_run_id, client_user_id\) references public\.client_report_large_score_rollup_runs \(id, client_user_id\) on delete restrict/,
    );
    expect(sql).toContain(
      'alter table public.client_report_large_score_rollup_activations enable row level security',
    );
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toMatch(new RegExp(
        `revoke all on (table )?public\\.client_report_large_score_rollup_activations from ${role}`,
      ));
    }
    expect(sql).toMatch(
      /revoke all on (table )?public\.client_report_large_score_rollup_activations from service_role/,
    );
    expect(sql).not.toMatch(
      /grant (all|select|insert|update|delete)[^;]*client_report_large_score_rollup_activations[^;]*service_role/,
    );
  });

  it('activates only a ready owned run with persisted complete verification evidence', () => {
    const activate = functionSql('activate_client_report_large_score_rollup');
    expect(activate).toContain('p_client_user_id uuid');
    expect(activate).toContain('p_rollup_run_id uuid');
    expect(activate).toContain('run.id = p_rollup_run_id');
    expect(activate).toContain('run.client_user_id = p_client_user_id');
    expect(activate).toContain("run.status = 'ready'");
    for (const evidence of [
      'validated_at', 'sourcerows', 'rolluprows', 'baselinesourcerows',
      'sourcewatermarkatstart', 'sourcewatermarkatverify', 'rollupwatermark',
      'sourcefingerprintatstart', 'sourcefingerprintatverify',
      'sourcebuckets', 'rollupbuckets', 'runstatus',
      'expectedjobdays', 'checkpointjobdays', 'baselinejobdays',
      'invalidcheckpointrows',
      'duplicatebucketkeys', 'mismatchedbucketkeys',
      'checkpoint_count', 'source_rows', 'bucket_rows',
    ]) {
      expect(activate).toContain(`'${evidence}'`);
    }
    expect(activate).toContain(') is not true then');
    expect(activate).toContain(
      "jsonb_typeof(v_validation->'sourcebuckets') = 'object'",
    );
    expect(activate).toContain(
      "jsonb_typeof(v_validation->'rollupbuckets') = 'object'",
    );
    expect(activate).toContain(
      "(v_validation->>'sourcewatermarkatstart')::timestamptz = v_run.source_watermark",
    );
    expect(activate).toContain(
      "raise exception 'verified ready rollup run not found for client'",
    );
    expect(activate).toContain(
      'insert into public.client_report_large_score_rollup_activations',
    );
    expect(activate).toContain('on conflict (client_user_id) do update');
  });

  it('supports immediate rollback by removing only the selector row', () => {
    const deactivate = functionSql('deactivate_client_report_large_score_rollup');
    expect(deactivate).toContain(
      'delete from public.client_report_large_score_rollup_activations',
    );
    expect(deactivate).toContain('where client_user_id = p_client_user_id');
    expect(deactivate).not.toContain(
      'delete from public.client_report_large_score_rollup_runs',
    );
    expect(deactivate).not.toContain(
      'delete from public.client_report_large_score_rollup_buckets',
    );
  });

  it('uses definer rights only for guarded selector writes', () => {
    const activate = functionSql('activate_client_report_large_score_rollup');
    const deactivate = functionSql('deactivate_client_report_large_score_rollup');
    const lookup = functionSql('client_report_large_score_rollup_active_run');
    expect(activate).toContain('security definer');
    expect(deactivate).toContain('security definer');
    expect(lookup).toContain('security definer');
  });

  it('resolves an active run only for the exact client and only while it remains ready', () => {
    const lookup = functionSql('client_report_large_score_rollup_active_run');
    expect(lookup).toContain('activation.client_user_id = p_client_user_id');
    expect(lookup).toContain('run.id = activation.rollup_run_id');
    expect(lookup).toContain('run.client_user_id = activation.client_user_id');
    expect(lookup).toContain("run.status = 'ready'");
  });

  it('exposes activation functions only to service_role', () => {
    const ownerOnly = [
      'activate_client_report_large_score_rollup\\(uuid, uuid\\)',
      'deactivate_client_report_large_score_rollup\\(uuid\\)',
    ];
    const selector = 'client_report_large_score_rollup_active_run\\(uuid\\)';
    for (const signature of [...ownerOnly, selector]) {
      for (const role of ['public', 'anon', 'authenticated']) {
        expect(sql).toMatch(new RegExp(
          `revoke all on function public\\.${signature} from ${role}`,
        ));
      }
    }
    for (const signature of ownerOnly) {
      expect(sql).toMatch(new RegExp(
        `revoke all on function public\\.${signature} from service_role`,
      ));
      expect(sql).not.toMatch(new RegExp(
        `grant execute on function public\\.${signature} to service_role`,
      ));
    }
    expect(sql).toMatch(new RegExp(
      `grant execute on function public\\.${selector} to service_role`,
    ));
  });
});
