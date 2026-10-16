import fs from 'node:fs';
const tsv = process.argv[2];
const lines = fs.readFileSync(tsv, 'utf8').split('\n').slice(1).filter(l => l.includes('\t'));
const rows = lines.map(l => { const [c, n] = l.split('\t'); return { c, n: Number(n) }; }).filter(r => Number.isFinite(r.n));
const dn = new Intl.DisplayNames(['en'], { type: 'region' });
const norm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/&/g,'and').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g,' ').trim();
const byName = new Map();
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a) + String.fromCharCode(b);
  let name; try { name = dn.of(code); } catch { continue; }
  if (!name || name === code) continue;
  byName.set(norm(name), code.toLowerCase());
}
const miss = []; let mapped = 0;
for (const r of rows) { const k = norm(r.c); if (byName.has(k)) mapped++; else miss.push(`${r.c}\t${r.n}`); }
console.log('rows', rows.length, 'mapped', mapped, 'unmapped', miss.length);
console.log(miss.join('\n'));
