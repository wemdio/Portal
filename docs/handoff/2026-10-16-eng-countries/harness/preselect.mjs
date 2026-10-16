import { TABLE } from './table.mjs';
// Copy of browserTimezoneIn (EngStepLaunch.tsx:136-175) with `own` injected.
function tzOffsetMinutes(timeZone, at) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return Number.isFinite(asUtc) ? Math.round((asUtc - at.getTime()) / 60_000) : null;
  } catch { return null; }
}
function browserTimezoneIn(options, own) {
  if (options.some((o) => o.value === own)) return own;
  const year = new Date().getUTCFullYear();
  const probes = [new Date(Date.UTC(year, 0, 15, 12)), new Date(Date.UTC(year, 6, 15, 12))];
  const mine = probes.map((d) => tzOffsetMinutes(own, d));
  if (mine.some((m) => m === null)) return null;
  return options.find((o) => probes.every((d, i) => tzOffsetMinutes(o.value, d) === mine[i]))?.value ?? null;
}
const all = TABLE.map(([value, label, group, suggest]) => ({ value, label, group, suggest: !!suggest }));
const today = all.filter((o) => o.suggest);
const suggestable = all.some((o) => o.suggest) ? all.filter((o) => o.suggest) : all;
const browsers = ['America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'America/Denver', 'Pacific/Honolulu', 'America/Chicago', 'Etc/UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Luxembourg', 'Europe/Moscow', 'Asia/Kolkata', 'America/Mexico_City'];
console.log('browser zone | today (8) | proposed (suggest filter) | if full list used');
for (const b of browsers) console.log([b, browserTimezoneIn(today, b), browserTimezoneIn(suggestable, b), browserTimezoneIn(all, b)].join(' | '));
