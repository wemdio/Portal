/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('he auto-collect migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('he_auto_collect'));

  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('adds he_bases.source (upload|auto, default upload) and collect_info', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/add column if not exists source text not null default 'upload'/i);
    expect(sql).toMatch(/check \(source in \('upload','auto'\)\)/i);
    expect(sql).toMatch(/add column if not exists collect_info jsonb/i);
  });

  it('recreates he_bases_status_check with collecting plus the full status list', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/drop constraint if exists he_bases_status_check/i);
    expect(sql).toMatch(/add constraint he_bases_status_check/i);
    // Полный список: без 'collecting' база авто-сборки не вставляется;
    // остальные статусы обязаны сохраниться.
    for (const status of ['uploaded', 'collecting', 'analyzing', 'analyzed', 'failed']) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it('recreates he_jobs_stage_check with base_collect plus all current stages', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
    expect(sql).toMatch(/drop constraint if exists he_jobs_stage_check/i);
    expect(sql).toMatch(/add constraint he_jobs_stage_check/i);
    // Полный список стадий: без 'base_collect' каждый insert джобы авто-сборки
    // падает на check-ограничении; остальные стадии обязаны сохраниться.
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
      'base_collect',
    ]) {
      expect(sql).toContain(`'${stage}'`);
    }
  });
});
