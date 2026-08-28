/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Vertical Engine v2 RU seasonality migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    '../supabase/migrations/20260828_0002_vertical_engine_v2_ru_seasonality.sql',
  );

  it('adds a nullable v2-only hypothesis seasonality snapshot with a shape check', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(
      /alter table public\.ve_hypotheses[\s\S]+add column if not exists seasonality jsonb/i,
    );
    expect(sql).not.toMatch(/seasonality\s+jsonb\s+not null/i);
    expect(sql).toMatch(/jsonb_typeof\s*\(\s*seasonality\s*\)\s*=\s*'object'/i);
    expect(sql).toMatch(/coalesce\s*\(/i);
    expect(sql).toContain("'confidence'");
    expect(sql).toContain("'low'");
    expect(sql).toContain("'medium'");
    expect(sql).toContain("'high'");
    expect(sql).toContain("'seasonal'");
    expect(sql).toContain("'neutral'");
    expect(sql).toContain("'unknown'");
    expect(sql).not.toMatch(/\bhe_/i);
  });
});
