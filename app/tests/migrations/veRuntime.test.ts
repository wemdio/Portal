/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Vertical Engine v2 runtime migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('vertical_engine_v2_runtime'));

  function sql(): string {
    expect(migrationName).toBeDefined();
    return fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
  }

  it('creates isolated runtime tables for the specialist copy', () => {
    const text = sql();
    for (const table of [
      've_jobs',
      've_hypotheses',
      've_verticals',
      've_chains',
      've_vocab',
      've_bases',
      've_templates',
      've_vertical_dossiers',
      've_cases',
    ]) {
      expect(text).toMatch(new RegExp(`create table if not exists public\\.${table}`, 'i'));
    }
  });

  it('lets ve_projects leave draft and run research without ENG columns', () => {
    const text = sql();
    expect(text).toMatch(/check \(status in \('draft','researching','researched','failed'\)\)/i);
    expect(text).toMatch(/add column if not exists brief jsonb/i);
    expect(text).not.toMatch(/add column if not exists autopilot/i);
    expect(text).not.toMatch(/ve_auto_pipeline/i);
  });

  it('closes the parallel auto-collect race like he_bases does', () => {
    expect(sql()).toMatch(
      /create unique index if not exists ve_bases_one_collecting_per_vertical\s+on public\.ve_bases \(vertical_id\)\s+where source = 'auto' and status = 'collecting'/i,
    );
  });

  it('does not alter or foreign-key ENG-owned he_* tables', () => {
    const text = sql();
    expect(text).not.toMatch(/alter table public\.he_/i);
    expect(text).not.toMatch(/references public\.he_/i);
  });
});
