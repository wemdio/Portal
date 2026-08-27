/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Vertical Engine v2 segmentation audit migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    '../supabase/migrations/20260828_0001_vertical_engine_v2_segmentation_audits.sql',
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('creates isolated persisted audit snapshots with a single active audit per template', () => {
    expect(sql).toMatch(/create table if not exists public\.ve_segmentation_audits/i);
    for (const column of [
      'project_id',
      'template_id',
      'base_id',
      'input_hash',
      'segment_keys',
      'summary',
      'assignments',
      'completed_at',
      'launch_status',
      'launch_reservation_id',
      'launch_preset_id',
      'launch_heartbeat_at',
      'launch_resolution_id',
      'launch_resolved_by',
      'launch_resolved_at',
      'launch_started_at',
      'launch_completed_at',
      'launch_error',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`, 'i'));
    }
    for (const status of ['pending', 'running', 'ready', 'failed', 'cancelled']) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toMatch(/input_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'/i);
    expect(sql).toMatch(/unique index[\s\S]+status in \('pending','running'\)/i);
    expect(sql).toMatch(
      /unique index if not exists ve_segmentation_audits_one_launch_reservation[\s\S]+launch_status in \('running','uncertain'\)/i,
    );
    for (const launchStatus of ['idle', 'running', 'succeeded', 'failed', 'uncertain']) {
      expect(sql).toContain(`'${launchStatus}'`);
    }
    expect(sql).toMatch(/alter table public\.ve_segmentation_audits enable row level security/i);
    expect(sql).not.toMatch(/(?:alter|create|insert|update|delete)\s+(?:table\s+)?public\.he_/i);
  });

  it('recreates ve_jobs_stage_check with segmentation_audit and every existing v2 stage', () => {
    expect(sql).toMatch(/drop constraint if exists ve_jobs_stage_check/i);
    expect(sql).toMatch(/add constraint ve_jobs_stage_check/i);
    expect(sql).toMatch(/unique index if not exists ve_jobs_one_active_segmentation_audit/i);
    for (const stage of [
      'site_profile',
      'competitors',
      'brand_cloud',
      'hypotheses',
      'evidence',
      'clustering',
      'chain',
      'vocab',
      'base_analyze',
      'base_collect',
      'template',
      'dossier',
      'segmentation_audit',
    ]) {
      expect(sql).toContain(`'${stage}'`);
    }
  });

  it('creates transactional enqueue and cancellation boundaries for audit jobs', () => {
    expect(sql).toMatch(/create or replace function public\.ve_enqueue_segmentation_audit/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(
      /insert into public\.ve_segmentation_audits[\s\S]+insert into public\.ve_jobs/i,
    );
    expect(sql).toMatch(/create or replace function public\.ve_cancel_segmentation_audits/i);
    expect(sql).toMatch(
      /with cancelled_jobs as \([\s\S]+cancelled_audits as \([\s\S]+jsonb_build_object/i,
    );
    expect(sql).toMatch(/or a\.launch_status in \('running','uncertain'\)/i);
    expect(sql).toMatch(
      /launch_status\s*=\s*case[\s\S]+when a\.launch_status = 'running' then 'uncertain'/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.ve_enqueue_segmentation_audit[\s\S]+from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.ve_cancel_segmentation_audits[\s\S]+to service_role, postgres/i,
    );
    expect(sql).toMatch(/create or replace function public\.ve_finalize_template_launch/i);
    expect(sql).toMatch(/create or replace function public\.ve_resolve_template_launch/i);
    expect(sql).toMatch(
      /ve_finalize_template_launch[\s\S]+pg_advisory_xact_lock[\s\S]+update public\.ve_templates[\s\S]+update public\.ve_segmentation_audits/i,
    );
    expect(sql).toMatch(
      /ve_finalize_template_launch[\s\S]+a\.status\s*=\s*'ready'[\s\S]+a\.launch_status\s*=\s*'running'/i,
    );
    expect(sql).toMatch(
      /ve_resolve_template_launch[\s\S]+launch_reservation_id\s*=\s*p_launch_reservation_id/i,
    );
    expect(sql.match(/pg_advisory_xact_lock\(hashtextextended\(p_project_id::text/gi)?.length).toBeGreaterThanOrEqual(2);
  });
});
