#!/usr/bin/env node
/**
 * load-agent-wiki.mjs — грузит вики специалиста из wiki/*.md в таблицу agent_wiki датасета.
 *
 * Источник правды = app/scripts/instantly-dataset/wiki/*.md (версионируется в репо).
 * slug = имя файла без .md; title = первая строка вида "# ..."; body = весь файл.
 * Обновление вики для всех специалистов: правишь .md → `node load-agent-wiki.mjs`.
 * Раздаваемую папку при этом НЕ трогаем (там только коннектор + тонкий CLAUDE.md).
 *
 * Применяет DDL из 017_agent_wiki.sql (идемпотентно), затем upsert всех доков.
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const env = Object.fromEntries(
  readFileSync(resolve(REPO_ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const url = env.INSTANTLY_DATASET_DB_URL;
if (!url) { console.error('FATAL: INSTANTLY_DATASET_DB_URL missing in .env'); process.exit(1); }

const ddl = readFileSync(resolve(__dirname, '017_agent_wiki.sql'), 'utf8');
const wikiDir = resolve(__dirname, 'wiki');
const files = readdirSync(wikiDir).filter((f) => f.endsWith('.md')).sort();

const c = new Client({ connectionString: url, statement_timeout: 60_000 });
await c.connect();
try {
  await c.query(ddl); // CREATE TABLE IF NOT EXISTS + GRANT (идемпотентно)
  const slugsLoaded = [];
  for (const f of files) {
    const body = readFileSync(resolve(wikiDir, f), 'utf8');
    const slug = basename(f, '.md');
    const h1 = body.split('\n').find((l) => l.startsWith('# '));
    const title = h1 ? h1.replace(/^#\s+/, '').trim() : slug;
    await c.query(
      `INSERT INTO agent_wiki (slug, title, body, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, updated_at=now()`,
      [slug, title, body],
    );
    slugsLoaded.push(slug);
  }
  // подчистить доки, которых больше нет в репо (переименование/удаление)
  const del = await c.query(`DELETE FROM agent_wiki WHERE slug <> ALL($1::text[])`, [slugsLoaded]);
  console.log(`agent_wiki: загружено ${slugsLoaded.length} (${slugsLoaded.join(', ')}); удалено лишних ${del.rowCount}.`);
} finally { await c.end(); }
