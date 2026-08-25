import fs from 'fs';
import path from 'path';

describe('Instantly campaign ownership invariant migration', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../../supabase/instantly-migrations/20260824_0001_campaign_project_ownership.sql',
  );

  it('serializes ownership claims and only permits replacing automatic owners', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('claim_project_instantly_campaign');
    expect(sql).toContain("match_source = 'manual'");
    expect(sql).toContain('p_replace_automatic');
    expect(sql).toContain("p_match_source <> 'auto-text'");
    expect(sql).toContain('project_instantly_campaigns');
    expect(sql).toContain('project_period_instantly_campaigns');
  });

  it('installs the same-project-only guard on both ownership tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain('enforce_instantly_campaign_single_project');
    expect(sql).toContain('new.project_id');
    expect(sql).toContain('project_id <> new.project_id');
    expect(sql).toMatch(/create trigger[\s\S]*?on public\.project_instantly_campaigns/);
    expect(sql).toMatch(/create trigger[\s\S]*?on public\.project_period_instantly_campaigns/);
  });

  it('normalizes existing automatic conflicts before enabling the ownership guard', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();
    const cleanupAt = sql.indexOf("'migration_resolved_automatic_conflict'");
    const triggerAt = sql.indexOf('create trigger trg_project_campaign_single_project');

    expect(sql).toContain('manual_campaign_project_ownership_conflict');
    expect(sql).toContain('count(distinct project_id) > 1');
    expect(sql).toMatch(
      /lock table public\.project_instantly_campaigns,\s+public\.project_period_instantly_campaigns/,
    );
    expect(sql).toContain('in share row exclusive mode');
    expect(sql).toContain("'migration_resolved_automatic_conflict'");
    expect(sql).toMatch(
      /insert into public\.campaign_project_ownership_archive[\s\S]*?'migration_resolved_automatic_conflict'[\s\S]*?delete from public\.project_instantly_campaigns/,
    );
    expect(sql).toMatch(
      /insert into public\.campaign_project_ownership_archive[\s\S]*?'migration_resolved_automatic_conflict'[\s\S]*?delete from public\.project_period_instantly_campaigns/,
    );
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(triggerAt).toBeGreaterThan(cleanupAt);
  });

  it('provides a cross-table batch preflight for period mutations', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain('check_project_instantly_campaign_ownership');
    expect(sql).toContain('p_campaign_ids text[]');
    expect(sql).toContain('from public.project_instantly_campaigns');
    expect(sql).toContain('from public.project_period_instantly_campaigns');
    expect(sql).toContain("'conflicts'");
  });

  it('archives stale automatic links before replacement instead of hard-deleting history', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain('create table if not exists public.campaign_project_ownership_archive');
    expect(sql).toContain("'replaced_stale_automatic_owner'");
    expect(sql).toMatch(/insert into public\.campaign_project_ownership_archive[\s\S]*?delete from public\.project_instantly_campaigns/);
    expect(sql).toMatch(/insert into public\.campaign_project_ownership_archive[\s\S]*?delete from public\.project_period_instantly_campaigns/);
  });

  it('archives the period baseline needed to restore a replaced period link', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();
    const archiveInserts = [...sql.matchAll(
      /insert into public\.campaign_project_ownership_archive \(([\s\S]*?)\)\s*select([\s\S]*?)\s+from public\.(project(?:_period)?_instantly_campaigns)/g,
    )];
    const periodArchiveInsert = archiveInserts.find(
      (match) => match[3] === 'project_period_instantly_campaigns',
    );

    expect(sql).toMatch(
      /create table if not exists public\.campaign_project_ownership_archive \([\s\S]*?baseline_contacts integer/,
    );
    expect(periodArchiveInsert).toBeDefined();
    expect(periodArchiveInsert?.[1]).toContain('baseline_contacts');
    expect(periodArchiveInsert?.[2]).toContain('baseline_contacts');
  });

  it('reserves a whole period campaign set atomically and provides saga cleanup', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain('reserve_project_period_instantly_campaigns');
    expect(sql).toContain('p_links jsonb');
    expect(sql).toContain('for v_campaign_id in');
    expect(sql).toContain('release_project_period_campaign_reservations');
    expect(sql).toContain('p_period_ids uuid[]');
  });
});
