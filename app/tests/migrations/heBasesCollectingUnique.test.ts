/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('he_bases one collecting auto-base per vertical migration', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    '../supabase/migrations/20260730_0005_he_bases_collecting_unique.sql',
  );

  it('exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('creates an idempotent partial unique index on he_bases(vertical_id)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(
      /create unique index if not exists he_bases_one_collecting_per_vertical/i,
    );
    expect(sql).toMatch(/on public\.he_bases \(vertical_id\)/i);
    // Только собирающиеся auto-базы: failed/analyzed и ручные upload-базы
    // параллельно существовать могут, индекс их не блокирует.
    expect(sql).toMatch(/where source = 'auto' and status = 'collecting'/i);
  });
});
