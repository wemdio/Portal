/**
 * Streaming splitter for emails-by-campaign.json (too big for JSON.parse).
 * Input: top-level object {"<campaignId>":[<emails>], "<id2>":[...], ...}
 * Output: one file per campaign in .tmp/instantly-cache/emails/<id>.json
 *
 * Uses a hand-rolled state machine that doesn't materialize the whole file
 * (or even one value as a JS object) — just slices the source bytes at the
 * brace boundaries and writes the raw JSON value as-is.
 */
import { createReadStream, writeFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const CACHE_DIR = resolve(REPO_ROOT, '.tmp', 'instantly-cache');

const SRC = join(CACHE_DIR, 'emails-by-campaign.json');
const DST_DIR = join(CACHE_DIR, 'emails');
mkdirSync(DST_DIR, { recursive: true });

const t0 = Date.now();
const size = statSync(SRC).size;
console.log(`Source: ${SRC} (${(size / 1024 / 1024).toFixed(1)} MB)`);

// ─── state machine ──────────────────────────────────────────────────────
// States: SEEK_OPEN → SEEK_KEY_OR_END → IN_KEY → SEEK_COLON → IN_VALUE → DONE
// IN_VALUE tracks brace/bracket depth + string-state to find where the value ends.
const stream = createReadStream(SRC, { encoding: 'utf8', highWaterMark: 1024 * 1024 });

let buf = '';            // accumulated chunk we haven't consumed yet
let state = 'SEEK_OPEN';
let currentKey = '';
let depth = 0;
let inString = false;
let escapeNext = false;
let valueStart = -1;     // index in `buf` where current value starts
let written = 0;
let pendingResume = null;

stream.on('data', (chunk) => {
  buf += chunk;
  process();
});

stream.on('end', () => {
  process(true);
  console.log(`\nDone: ${written} per-campaign files written.`);
  const archive = SRC.replace(/\.json$/, `.SPLIT-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  renameSync(SRC, archive);
  console.log(`Source archived: ${archive}`);
  console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
});

stream.on('error', (e) => { console.error('Stream error:', e); process.exit(1); });

function process(isFinal = false) {
  // We do as many state transitions as possible until we'd need more bytes.
  for (;;) {
    if (state === 'SEEK_OPEN') {
      const i = buf.search(/\S/);
      if (i < 0) { buf = ''; return; }
      if (buf[i] !== '{') {
        throw new Error(`Expected '{' but got ${JSON.stringify(buf[i])} at start`);
      }
      buf = buf.slice(i + 1);
      state = 'SEEK_KEY_OR_END';
      continue;
    }

    if (state === 'SEEK_KEY_OR_END') {
      // Skip whitespace and commas
      let i = 0;
      while (i < buf.length && /[\s,]/.test(buf[i])) i++;
      if (i >= buf.length) { buf = ''; return; }
      if (buf[i] === '}') {
        buf = buf.slice(i + 1);
        state = 'DONE';
        return;
      }
      if (buf[i] !== '"') {
        throw new Error(`Expected '"' or '}' at start of key, got ${JSON.stringify(buf[i])}`);
      }
      buf = buf.slice(i + 1);
      currentKey = '';
      state = 'IN_KEY';
      continue;
    }

    if (state === 'IN_KEY') {
      // Read until unescaped quote
      let i = 0;
      while (i < buf.length) {
        if (escapeNext) { currentKey += buf[i]; escapeNext = false; i++; continue; }
        const ch = buf[i];
        if (ch === '\\') { currentKey += ch; escapeNext = true; i++; continue; }
        if (ch === '"') break;
        currentKey += ch;
        i++;
      }
      if (i >= buf.length) { buf = ''; return; } // need more
      buf = buf.slice(i + 1);
      state = 'SEEK_COLON';
      continue;
    }

    if (state === 'SEEK_COLON') {
      let i = 0;
      while (i < buf.length && /[\s:]/.test(buf[i])) i++;
      if (i >= buf.length) { buf = ''; return; }
      buf = buf.slice(i);
      state = 'IN_VALUE';
      valueStart = 0;
      depth = 0;
      inString = false;
      escapeNext = false;
      continue;
    }

    if (state === 'IN_VALUE') {
      let i = valueStart;
      while (i < buf.length) {
        const ch = buf[i];
        if (inString) {
          if (escapeNext) { escapeNext = false; i++; continue; }
          if (ch === '\\') { escapeNext = true; i++; continue; }
          if (ch === '"') { inString = false; i++; continue; }
          i++; continue;
        }
        if (ch === '"') { inString = true; i++; continue; }
        if (ch === '{' || ch === '[') { depth++; i++; continue; }
        if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            // Found end of top-level value
            const value = buf.slice(0, i + 1);
            writeFileSync(join(DST_DIR, `${currentKey}.json`), value);
            written++;
            if (written % 50 === 0) {
              const sec = (Date.now() - t0) / 1000;
              console.log(`  wrote ${written} files (${(buf.length / 1024 / 1024).toFixed(1)} MB buf, ${sec.toFixed(0)}s)`);
            }
            buf = buf.slice(i + 1);
            state = 'SEEK_KEY_OR_END';
            valueStart = -1;
            i = 0;
            currentKey = '';
            break; // re-enter outer for-loop in new state
          }
          i++; continue;
        }
        // primitives (numbers, booleans, null) — for our data, only objects/arrays/strings appear, but be safe
        i++;
      }
      if (state === 'IN_VALUE') {
        // ran out of buf mid-value; remember progress and wait for more
        valueStart = i;
        if (!isFinal) return;
        // If isFinal and still in value → input is truncated
        throw new Error(`EOF inside value for key ${currentKey} (depth=${depth})`);
      }
      continue;
    }

    if (state === 'DONE') return;
  }
}
