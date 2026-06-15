// Экспорт неразмеченных пар (campaign, lead) в батчи для разметки Claude-субагентами.
// .tmp/label-batches/batch-NNN.jsonl, по 800 пар, свежие первыми.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dirname, '../../../.env'), 'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });
const OUT = resolve(__dirname, '../../../.tmp/label-batches');

function cleanBody(t) {
  if (!t) return '';
  const lines = String(t).split('\n');
  const cut = lines.findIndex(l =>
    /^\s*>/.test(l) || /^\s*(From|Sent|От кого|Кому|Дата|Date):/i.test(l) ||
    /-{3,}.*(Original|Пересылаемое|исходное)/i.test(l) || /^On .{6,80} wrote:/.test(l) ||
    /^\s*\d{1,2} [а-я]+\. \d{4} г\./.test(l));
  const head = (cut > 0 ? lines.slice(0, cut) : lines).join('\n');
  return head.replace(/\s+/g, ' ').trim().slice(0, 900);
}

(async () => {
  await db.connect();
  const rows = (await db.query(`
    WITH best AS (
      SELECT DISTINCT ON (campaign_id, lead_id)
        campaign_id, lead_id, body_text, md5(coalesce(body_text,'')) AS body_hash,
        first_value(timestamp_email) OVER (PARTITION BY campaign_id, lead_id ORDER BY timestamp_email) AS first_at
      FROM raw_emails
      WHERE ue_type = 2 AND lead_id IS NOT NULL AND campaign_id IS NOT NULL
        AND timestamp_email BETWEEN '2025-07-01' AND now() + interval '1 day'
      ORDER BY campaign_id, lead_id, length(coalesce(body_text,'')) DESC
    )
    SELECT b.campaign_id, b.lead_id, b.body_text, b.body_hash, b.first_at FROM best b
    LEFT JOIN reply_outcome_labels l ON l.campaign_id = b.campaign_id AND l.lead_id = b.lead_id
    WHERE l.campaign_id IS NULL
    ORDER BY b.first_at DESC`)).rows;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const SIZE = 800;
  let nFiles = 0, skipped = 0;
  for (let i = 0; i < rows.length; i += SIZE) {
    const batch = rows.slice(i, i + SIZE).map(r => {
      const b = cleanBody(r.body_text);
      if (b.length < 3) { skipped++; return { c: r.campaign_id, l: r.lead_id, h: r.body_hash, b: '(пусто)' }; }
      return { c: r.campaign_id, l: r.lead_id, h: r.body_hash, b };
    });
    writeFileSync(resolve(OUT, `batch-${String(++nFiles).padStart(3, '0')}.jsonl`), batch.map(x => JSON.stringify(x)).join('\n'));
  }
  console.log(`exported ${rows.length} pairs into ${nFiles} files (${OUT}); near-empty bodies: ${skipped}`);
  await db.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
