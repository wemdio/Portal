/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Vertical Engine v2 project launch-preset binding migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    '../supabase/migrations/20260831_0001_vertical_engine_v2_launch_preset_binding.sql',
  );

  function sql(): string {
    expect(fs.existsSync(migrationPath)).toBe(true);
    return fs.readFileSync(migrationPath, 'utf8');
  }

  it('adds a nullable all-or-none preset/workspace binding to ve_projects', () => {
    const text = sql();

    expect(text).toMatch(/alter table public\.ve_projects/i);
    expect(text).toMatch(/add column if not exists launch_preset_id\s+uuid/i);
    expect(text).toMatch(/add column if not exists launch_instantly_account_id\s+text/i);
    expect(text).toMatch(/add column if not exists launch_preset_bound_at\s+timestamptz/i);
    expect(text).toMatch(/add column if not exists launch_preset_bound_by\s+uuid/i);
    expect(text).toMatch(
      /launch_preset_id\s+is null[\s\S]+launch_instantly_account_id\s+is null[\s\S]+launch_preset_bound_at\s+is null[\s\S]+launch_preset_bound_by\s+is null/i,
    );
    expect(text).toMatch(
      /launch_preset_id\s+is not null[\s\S]+launch_instantly_account_id\s+is not null[\s\S]+launch_preset_bound_at\s+is not null[\s\S]+launch_preset_bound_by\s+is not null/i,
    );
    expect(text).toMatch(/nullif\s*\(\s*btrim\s*\(\s*launch_instantly_account_id\s*\)\s*,\s*''\s*\)\s+is not null/i);
  });

  it('leaves legacy projects unbound and does not invent cross-database integrity', () => {
    const text = sql();

    expect(text).not.toMatch(/\bdefault\s+'?main'?/i);
    expect(text).not.toMatch(/\bupdate\s+public\.ve_projects\b/i);
    expect(text).not.toMatch(/\breferences\b/i);
    expect(text).not.toMatch(/\bhe_/i);
    expect(text).not.toMatch(/client_campaign_presets/i);
  });
});
