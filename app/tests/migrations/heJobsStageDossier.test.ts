/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('he_jobs stage dossier migration', () => {
  it('recreates he_jobs_stage_check with the full stage list including dossier', () => {
    const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
    const migrationName = fs
      .readdirSync(migrationsDir)
      .find((name) => name.includes('he_jobs_stage_add_dossier'));

    expect(migrationName).toBeDefined();

    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/drop constraint if exists he_jobs_stage_check/i);
    expect(sql).toMatch(/add constraint he_jobs_stage_check/i);
    // Полный список стадий: без 'dossier' каждый insert досье-джобы падает
    // на check-ограничении; остальные стадии обязаны сохраниться.
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
      'template',
      'dossier',
    ]) {
      expect(sql).toContain(`'${stage}'`);
    }
  });
});
