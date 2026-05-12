#!/usr/bin/env node
/**
 * Скрапер полного классификатора ОКВЭД-2 с regfile.ru.
 *
 * Шаги:
 *   1) Тянет index https://www.regfile.ru/okved2.html — извлекает разделы (A–U)
 *      и номера групп (01, 02 ...) с прямыми ссылками.
 *   2) Для каждой группы скачивает страницу группы и парсит ВСЕ записи вида
 *      `[01.11.1] - Выращивание зерновых ...` (от 3-значных до 5-значных кодов).
 *   3) Восстанавливает иерархию parent_code по правилам:
 *        - две цифры       (XX)          → parent = section_letter (A..U)
 *        - три цифры (XX.X)              → parent = XX
 *        - четыре цифры (XX.XX)          → parent = XX.X
 *        - XX.XX.N                       → parent = XX.XX
 *        - XX.XX.N.N (если встретится)   → parent = XX.XX.N
 *
 * Результат:
 *   - app/scripts/db/okved2.scraped.json
 *
 * Запуск (из app/):
 *   node scripts/db/scrapeOkved2.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_JSON = resolve(__dirname, 'okved2.scraped.json');

const INDEX_URL = 'https://www.regfile.ru/okved2.html';
const ORIGIN = 'https://www.regfile.ru';

const SLEEP_MS = 120;
const MAX_RETRIES = 4;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0 Safari/537.36 PortalOkvedScraper/1.0';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(SLEEP_MS * attempt * 2);
    }
  }
  throw lastErr;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function normalizeText(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

const SECTION_LINK_RE =
  /<a[^>]+href="https?:\/\/[^"\/]+\/okved2\/(razdel-[a-z])\.html"[^>]*>([\s\S]*?)<\/a>/gi;

const DIVISION_LINK_RE =
  /<a[^>]+href="https?:\/\/[^"\/]+\/okved2\/(razdel-[a-z])\/(\d{2})\.html"[^>]*>([\s\S]*?)<\/a>/gi;

function parseIndex(html) {
  const sections = new Map();
  for (const m of html.matchAll(SECTION_LINK_RE)) {
    const slug = m[1];
    const letter = slug.replace('razdel-', '').toUpperCase();
    const name = normalizeText(m[2].replace(/<[^>]+>/g, ''));
    if (!sections.has(letter)) {
      sections.set(letter, { code: letter, name, slug });
    }
  }

  const divisions = [];
  const seen = new Set();
  for (const m of html.matchAll(DIVISION_LINK_RE)) {
    const sectionSlug = m[1];
    const code = m[2];
    const name = normalizeText(m[3].replace(/<[^>]+>/g, ''));
    const letter = sectionSlug.replace('razdel-', '').toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    divisions.push({ section: letter, code, name, sectionSlug });
  }

  return { sections: Array.from(sections.values()), divisions };
}

function parseDivisionPage(html, divisionCode) {
  const cleaned = stripTags(html);
  const entries = new Map();

  const escDiv = divisionCode.replace(/\./g, '\\.');

  // Anchor: <a href="...">CODE</a>...</b> - NAME until end of <p>/<td>/<br>/newline.
  const RE = new RegExp(
    `<a\\s+href="https?:[^"]*?\\/(${escDiv}(?:\\.[0-9]+){0,4})\\.html"[^>]*>\\s*(${escDiv}(?:\\.[0-9]+){0,4})\\s*<\\/a>\\s*(?:<\\/b>)?\\s*[-–—]\\s*([\\s\\S]*?)(?=<\\/p>|<\\/td>|<br|<\\/tr>|<tr[\\s>]|<table|$)`,
    'gi',
  );

  for (const m of cleaned.matchAll(RE)) {
    const codeFromHref = m[1];
    const codeFromText = m[2].trim();
    const code = codeFromText || codeFromHref;
    if (!code) continue;
    let raw = m[3];
    raw = raw.replace(/<[^>]+>/g, ' ');
    let name = normalizeText(raw);
    name = name.replace(/^[-–—\s]+/, '').trim();
    if (!name) continue;
    if (!entries.has(code) || entries.get(code).name.length < name.length) {
      entries.set(code, { code, name });
    }
  }

  return Array.from(entries.values());
}

function parentOf(code) {
  if (/^[A-U]$/.test(code)) return null;
  if (/^\d{2}$/.test(code)) return null;
  let next = code.slice(0, -1);
  if (next.endsWith('.')) next = next.slice(0, -1);
  return next || null;
}

function levelOf(code) {
  if (/^[A-U]$/.test(code)) return 0;
  const digits = code.replace(/[^0-9]/g, '').length;
  if (digits <= 2) return 1;
  return digits - 1;
}

async function main() {
  console.log(`→ Fetch index ${INDEX_URL}`);
  const indexHtml = await fetchText(INDEX_URL);
  const { sections, divisions } = parseIndex(indexHtml);
  console.log(
    `  sections=${sections.length}  divisions=${divisions.length} (expected 88)`,
  );

  const all = [];
  for (const s of sections) {
    all.push({ code: s.code, name: s.name, parent_code: null, section: s.code, level: 0 });
  }

  const divisionParent = new Map();
  for (const d of divisions) {
    divisionParent.set(d.code, d.section);
    all.push({
      code: d.code,
      name: d.name,
      parent_code: d.section,
      section: d.section,
      level: 1,
    });
  }

  let i = 0;
  for (const d of divisions) {
    i++;
    const url = `${ORIGIN}/okved2/${d.sectionSlug}/${d.code}.html`;
    process.stdout.write(`  [${i}/${divisions.length}] ${d.code} ${d.name.slice(0, 40)} … `);
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      console.log('FAIL', err.message);
      continue;
    }
    const entries = parseDivisionPage(html, d.code);
    console.log(`entries=${entries.length}`);
    for (const e of entries) {
      if (e.code === d.code) continue;
      const parent = parentOf(e.code);
      all.push({
        code: e.code,
        name: e.name,
        parent_code: parent,
        section: d.section,
        level: levelOf(e.code),
      });
    }
    await sleep(SLEEP_MS);
  }

  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    if (seen.has(it.code)) continue;
    seen.add(it.code);
    deduped.push(it);
  }
  deduped.sort((a, b) => a.code.localeCompare(b.code, 'ru'));

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(deduped, null, 2), 'utf8');
  console.log(`\n✓ wrote ${deduped.length} entries to ${OUT_JSON}`);

  const byLevel = deduped.reduce((acc, it) => {
    acc[it.level] = (acc[it.level] || 0) + 1;
    return acc;
  }, {});
  console.log('  by level:', byLevel);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
