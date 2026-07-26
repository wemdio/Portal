/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const sqlPath = path.join(process.cwd(), 'scripts', '2gis-dataset', '001_schema.sql');

describe('2GIS dataset schema', () => {
  const sql = fs.readFileSync(sqlPath, 'utf8').toLowerCase();
  const cardsBody = sql.match(
    /create table if not exists public\.cards\s*\(([\s\S]*?)\n\);/,
  )?.[1] ?? '';

  it('creates an isolated cards table with the 14 source fields', () => {
    expect(cardsBody).not.toBe('');
    expect(cardsBody).toMatch(/\bid\s+text\s+primary key/);
    expect(cardsBody).toMatch(/check\s*\(btrim\(id\)\s*<>\s*''\)/);
    for (const column of [
      'name',
      'city_name',
      'geometry_name',
      'post_code',
      'phone',
      'email',
      'website',
      'vkontakte',
      'instagram',
      'lon',
      'lat',
      'category',
      'subcategory',
    ]) {
      expect(cardsBody).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sql).not.toMatch(/references\s+public\.(projects|companies_directory|profiles)/);
  });

  it('adds contact flags, lookup indexes and import audit tables', () => {
    expect(sql).toMatch(/current_database\(\)\s*<>\s*'2gis_dataset'/);
    for (const flag of [
      'has_phone',
      'has_email',
      'has_website',
      'has_vkontakte',
      'has_instagram',
    ]) {
      expect(sql).toContain(flag);
    }
    expect(sql).toMatch(/create index[^;]*city_name/);
    expect(sql).toMatch(/create index[^;]*category/);
    expect(sql).toMatch(/create index[^;]*card_subcategories/);
    expect(sql).toContain('dataset_snapshots');
    expect(sql).toContain('import_rejects');
    expect(sql).toMatch(
      /create table if not exists public\.card_subcategories[\s\S]*card_id\s+text\s+not null\s+references public\.cards/,
    );
    expect(sql).toMatch(
      /create index[^;]*card_subcategories[^;]*\(value,\s*card_id\)/,
    );
    expect(sql).toMatch(
      /create table if not exists public\.export_tickets[\s\S]*snapshot_id\s+bigint\s+not null\s+references public\.dataset_snapshots/,
    );
  });
});
