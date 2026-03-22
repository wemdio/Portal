import 'dotenv/config';

const key = (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();
if (!key) { console.error('No API key found'); process.exit(1); }

console.log('Fetching campaigns from Instantly API...');
const BASE = 'https://api.instantly.ai/api/v2';
const all = [];
let after;
let page = 0;

while (true) {
  const url = new URL(`${BASE}/campaigns`);
  url.searchParams.set('limit', '100');
  if (after) url.searchParams.set('starting_after', after);

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${key}` },
  });

  if (!res.ok) {
    console.error(`API error ${res.status}:`, await res.text());
    break;
  }

  const data = await res.json();
  const items = data.items ?? [];
  all.push(...items);
  after = data.next_starting_after;
  page++;

  if (page % 5 === 0) process.stdout.write(`  ...page ${page}, ${all.length} campaigns\n`);
  if (!after) break;
}

console.log(`\nTotal campaigns: ${all.length}\n`);

const counts = {};
for (const c of all) {
  const s = String(c.status ?? 'unknown');
  counts[s] = (counts[s] || 0) + 1;
}

const labels = {
  '0': 'Draft (Черновик)',
  '1': 'Active (Активна)',
  '2': 'Paused (На паузе)',
  '3': 'Completed (Завершена)',
  '4': 'Running Subsequences',
  '-99': 'Account Suspended',
  '-1': 'Accounts Unhealthy',
  '-2': 'Bounce Protect',
};

const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) {
  console.log(`  ${labels[k] || 'Status ' + k}: ${v}`);
}
