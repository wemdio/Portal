import fs from 'fs';
import path from 'path';

describe('qualification project owner snapshot migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    '..',
    'supabase',
    'instantly-migrations',
    '20260825_0001_qualification_project_owner_snapshot.sql',
  );

  it('adds the immutable project snapshot without guessing an owner for historical rows', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('qualified_project_id uuid');
    expect(sql).toContain('qualified_project_owner_proven boolean');
    expect(sql).toContain('alter column qualified_project_owner_proven set default false');
    expect(sql).not.toContain('update public.instantly_lead_qualifications');
    expect(sql).toContain('qualification_project_ownership_changed');
    expect(sql).toContain('old.qualified_project_owner_proven is true');
    expect(sql).toContain(
      'new.qualified_project_id is distinct from old.qualified_project_id',
    );
    expect(sql).toContain('qualification_project_snapshot_immutable');
  });

  it('serializes qualification persistence with campaign ownership changes', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("'instantly-campaign:' || new.campaign_id");
    expect(sql).toContain('count(distinct owner.project_id)');
    expect(sql).toContain('new.qualified_project_id');
  });

  it('atomically distinguishes a proven self-serve campaign from an unresolved retry', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const retryCheck = sql.indexOf('if v_is_generated_retry then');
    const selfServeProof = sql.indexOf('if v_owner_count = 0 then');

    expect(sql).toContain('new.qualified_project_owner_proven');
    expect(retryCheck).toBeGreaterThan(-1);
    expect(selfServeProof).toBeGreaterThan(retryCheck);
    expect(sql).toContain("new.status in ('pending', 'processing', 'needs_review', 'error')");
    expect(sql).toContain('v_owner_count = 0');
    expect(sql).toContain('qualification_self_serve_ownership_changed');
    expect(sql).toContain('qualification_project_snapshot_required');
    expect(sql).toContain('503');
  });

  it('never lets a terminal verdict bypass the proven-owner requirement via AI reason text', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /v_is_generated_retry :=\s+new\.status in \('pending', 'processing', 'needs_review', 'error'\)[\s\S]*?ilike 'Автоматическая повторная квалификация:%'/,
    );
    expect(sql).toContain('qualification_project_snapshot_required: retryable 503');
  });

  it('serializes ownership deletion and campaign-id moves with qualification persistence', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('old.campaign_id');
    expect(sql).toContain('before delete');
    expect(sql).toContain('trg_project_campaign_owner_delete_lock');
    expect(sql).toContain('trg_project_period_campaign_owner_delete_lock');
  });

  it('keeps a proven historical snapshot editable after the campaign is reassigned', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /qualification_project_snapshot_immutable';[\s\S]{0,500}?return new;\s+end if;/,
    );
  });

  it('locks bulk period releases in stable campaign order', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain(
      'create or replace function public.release_project_period_campaign_reservations',
    );
    expect(sql).toMatch(/order by (?:reservation\.)?campaign_id/);
  });
});
