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

  it('seen_employers: PRIMARY KEY заменяется UNIQUE-индексом', () => {
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

/**
 * Отдельный страж: hh_employer_id должен быть РЕАЛЬНО nullable.
 *
 * Прежняя версия этого файла проверяла только текст «drop constraint … pkey» и
 * в названии кейса уже утверждала «hh_employer_id nullable» — то есть закрепила
 * ошибочное допущение вместо того, чтобы его поймать. Postgres держит NOT NULL
 * на колонках первичного ключа отдельным свойством колонки, и снятие PK его не
 * убирает. На проде осталось NOT NULL, GIS-строки (hh_employer_id = NULL) не
 * вставлялись, и прогоны 14–15.08 падали в markSeen — а он стоит перед заливкой,
 * так что три дня подряд в Instantly не ушло ничего.
 *
 * Поэтому проверяем не формулировку одной миграции, а результат по всему дереву:
 * где-то должен быть явный `drop not null`, и после него никто не возвращает
 * ни NOT NULL, ни PRIMARY KEY на эту колонку.
 */
describe('outreachos_seen_employers.hh_employer_id действительно nullable', () => {
  const migrationsDir = path.join(process.cwd(), '..', 'supabase', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8').toLowerCase(),
    }));

  const seenStatements = files.flatMap(({ name, sql }) =>
    [...sql.matchAll(/alter table (?:only )?public\.outreachos_seen_employers([\s\S]*?);/g)].map(
      (m) => ({ name, body: m[1] }),
    ),
  );

  it('в дереве миграций есть явный drop not null', () => {
    const dropping = seenStatements.filter((s) =>
      /alter column\s+hh_employer_id\s+drop not null/.test(s.body),
    );
    expect(dropping.length).toBeGreaterThan(0);
  });

  it('никто не возвращает NOT NULL или PRIMARY KEY обратно', () => {
    const dropIndex = seenStatements.findIndex((s) =>
      /alter column\s+hh_employer_id\s+drop not null/.test(s.body),
    );
    const after = seenStatements.slice(dropIndex + 1);
    for (const s of after) {
      expect(s.body).not.toMatch(/alter column\s+hh_employer_id\s+set not null/);
      expect(s.body).not.toMatch(/add (constraint \w+ )?primary key[^;]*hh_employer_id/);
    }
  });
});
