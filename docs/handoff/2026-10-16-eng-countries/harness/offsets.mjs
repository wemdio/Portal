import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const m = src.match(/INSTANTLY_VALID_TIMEZONES[^=]*=\s*\[([\s\S]*?)\]\s*as const/);
const ids = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
function off(tz, at) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
    const g = (t) => Number(p.find((x) => x.type === t)?.value);
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - at.getTime()) / 60000);
  } catch (e) { return 'ERR'; }
}
const fmt = (m) => m === 'ERR' ? 'ERR' : `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
const jan = new Date(Date.UTC(2026, 0, 15, 12)), jul = new Date(Date.UTC(2026, 6, 15, 12));
let canon = (tz) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch { return 'ERR'; } };
console.log('node', process.version, 'icu tz', process.versions.tz, 'icu', process.versions.icu);
ids.forEach((id, i) => console.log([i + 1, id, canon(id), fmt(off(id, jan)), fmt(off(id, jul))].join('\t')));
