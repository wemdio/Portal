/**
 * One-shot migrator: takes the giant emails-by-campaign.json / leads-by-campaign.json
 * and explodes them into per-campaign files under .tmp/instantly-cache/<entity>/<id>.json.
 *
 * Needs --max-old-space-size=8192 because the source files can be 600 MB+.
 *
 *   node --max-old-space-size=8192 scripts/instantly-dataset/migrate-cache-to-per-campaign-files.mjs <entity>
 *
 * On success, archives the source file with .OLD suffix (doesn't delete) so we
 * can fall back if needed.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const CACHE_DIR = resolve(REPO_ROOT, '.tmp', 'instantly-cache');

const entity = process.argv[2];
if (!entity || !['emails', 'leads'].includes(entity)) {
  console.error('Usage: ... migrate-cache-to-per-campaign-files.mjs <emails|leads>');
  process.exit(1);
}

const SRC = join(CACHE_DIR, `${entity}-by-campaign.json`);
const DST_DIR = join(CACHE_DIR, entity);
mkdirSync(DST_DIR, { recursive: true });

const t0 = Date.now();
const sz = statSync(SRC).size;
console.log(`Source: ${SRC} (${(sz / 1024 / 1024).toFixed(1)} MB)`);
console.log('Reading…');

let raw;
try {
  raw = readFileSync(SRC, 'utf8');
  console.log(`  read ${(raw.length / 1024 / 1024).toFixed(1)} MB as string`);
} catch (e) {
  console.error(`FAIL on read: ${e.message}`);
  console.error('File too large for utf8 readFileSync. Need stream-json. Bailing.');
  process.exit(2);
}

console.log('Parsing…');
let map;
try {
  map = JSON.parse(raw);
} catch (e) {
  console.error(`FAIL on parse: ${e.message}`);
  process.exit(3);
}
raw = null; // free memory

const ids = Object.keys(map);
console.log(`Parsed: ${ids.length} campaigns`);

let written = 0;
let totalItems = 0;
let errors = 0;
for (const id of ids) {
  const data = map[id];
  if (data && typeof data === 'object' && data.__error) { errors++; continue; }
  const arr = Array.isArray(data) ? data : (data ?? []);
  totalItems += arr.length;
  writeFileSync(join(DST_DIR, `${id}.json`), JSON.stringify(arr));
  written++;
  if (written % 100 === 0) console.log(`  wrote ${written}/${ids.length} (${totalItems} items so far)`);
}
console.log(`Done: ${written} per-campaign files, ${totalItems} items, ${errors} errored entries skipped`);

// Archive source so puller doesn't try to read it again
const archive = SRC.replace(/\.json$/, `.SPLIT-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
renameSync(SRC, archive);
console.log(`Source archived: ${archive}`);
console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
