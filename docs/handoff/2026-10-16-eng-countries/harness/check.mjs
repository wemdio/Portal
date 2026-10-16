import fs from 'node:fs';
import { TABLE } from './table.mjs';
const [tzFile, lwFile] = process.argv.slice(2);
const src = fs.readFileSync(tzFile, 'utf8');
const wl = [...src.match(/INSTANTLY_VALID_TIMEZONES[^=]*=\s*\[([\s\S]*?)\]\s*as const/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
const lw = fs.readFileSync(lwFile, 'utf8');
const cur = [...lw.match(/TIMEZONE_CANDIDATES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/value: '([^']+)',\s*label:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]);
function off(tz, at) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const g = (t) => Number(p.find((x) => x.type === t)?.value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - at.getTime()) / 60000);
}
const parseOff = (s) => { const m = s.match(/^UTC([+-])(\d+)(?::(\d\d))?$/); return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)); };
let errors = 0; const err = (...a) => { errors++; console.log('ERR', ...a); };
const vals = TABLE.map((r) => r[0]);
if (new Set(vals).size !== vals.length) err('duplicate values');
const labels = TABLE.map((r) => r[1]);
if (new Set(labels).size !== labels.length) err('duplicate labels');
for (const v of wl) if (!vals.includes(v)) err('missing from table', v);
for (const v of vals) if (!wl.includes(v)) err('not in whitelist', v);
for (const [v, l] of cur) { const r = TABLE.find((x) => x[0] === v); if (!r || r[1] !== l || !r[3]) err('original entry changed', v); }
for (const r of TABLE) if (r[3] && !cur.some(([v]) => v === r[0])) err('suggest on non-original', r[0]);
const yrs = [2026, 2027];
for (const [v, l] of TABLE) {
  for (const y of yrs) {
    const jan = off(v, new Date(Date.UTC(y, 0, 15, 12))), jul = off(v, new Date(Date.UTC(y, 6, 15, 12)));
    const m = l.match(/\((UTC[+-]\d+(?::\d\d)?)(?:, (UTC[+-]\d+(?::\d\d)?) (?:in summer|during Ramadan))?\)$/);
    if (!m) { if (y === 2026) console.log('no-offset label (US originals):', v, '| jan', jan, 'jul', jul); continue; }
    const a = parseOff(m[1]); const b = m[2] ? parseOff(m[2]) : null;
    if (/Ramadan/.test(l)) { if (jan !== a || jul !== a) err('ramadan zone', v, jan, jul); continue; }
    if (b === null) { if (jan !== a || jul !== a) err('fixed label wrong', v, l, jan, jul); }
    else { const lo = Math.min(jan, jul), hi = Math.max(jan, jul); if (lo !== a || hi !== b) err('dst label wrong', v, l, jan, jul); }
  }
}
const groups = [...new Set(TABLE.map((r) => r[2]))].map((g) => `${g}: ${TABLE.filter((r) => r[2] === g).length}`);
console.log('whitelist', wl.length, 'table', TABLE.length, 'suggest', TABLE.filter((r) => r[3]).length);
console.log('groups', groups.join(' | '));
console.log('max label length', Math.max(...TABLE.filter((r) => !r[3]).map((r) => r[1].length)));
console.log(errors ? `FAILED ${errors}` : 'ALL CHECKS PASS');
