/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const sqlPath = path.join(
  process.cwd(),
  '..',
  'supabase',
  'migrations',
  '20260811_0001_outreachos_gis_topup.sql',
);

describe('20260811_0001_outreachos_gis_topup.sql', () => {
  const sql = fs.readFileSync(sqlPath, 'utf8').toLowerCase();

  it('добавляет колонки конфига top-up с безопасными дефолтами', () => {
    const configAlter = sql.match(
      /alter table public\.outreachos_pipeline_config([\s\S]*?);/,
    )?.[1] ?? '';
    expect(configAlter).toContain('gis_topup_enabled boolean not null default false');
    expect(configAlter).toContain('gis_topup_target_appended int not null default 200');
    expect(configAlter).toContain("gis_topup_rubric_groups jsonb not null default '[]'::jsonb");
    expect(configAlter).toContain('gis_topup_daily_cap int not null default 500');
    expect(configAlter).toContain('gis_topup_measure_only boolean not null default true');
  });

  it('добавляет колонки телеметрии в outreachos_pipeline_runs', () => {
    const runsAlter = sql.match(
      /alter table public\.outreachos_pipeline_runs([\s\S]*?);/,
    )?.[1] ?? '';
    for (const col of [
      'gis_pulled',
      'gis_after_dedup',
      'gis_valid_contacts',
      'gis_llm_kept',
      'gis_appended',
    ]) {
      expect(runsAlter).toContain(`${col} int`);
    }
  });

  it('seen_employers: PRIMARY KEY заменяется UNIQUE-индексом (hh_employer_id nullable)', () => {
    expect(sql).toContain('drop constraint if exists outreachos_seen_employers_pkey');
    expect(sql).toMatch(
      /create unique index if not exists outreachos_seen_employers_hh_employer_id_key\s+on public\.outreachos_seen_employers \(hh_employer_id\)/,
    );
    // Индекс по domain обязателен (дедуп GIS-компаний идёт по домену).
    expect(sql).toMatch(
      /create index if not exists idx_outreachos_seen_domain\s+on public\.outreachos_seen_employers \(domain\)/,
    );
    // Нового PRIMARY KEY не вводится — NULL hh_employer_id для GIS-строк.
    expect(sql).not.toMatch(/add (constraint \w+ )?primary key/);
  });

  it('PostgREST просит перечитать схему', () => {
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
