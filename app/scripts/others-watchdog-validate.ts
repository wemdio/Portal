/**
 * Read-only валидация Others-вотчдога на живых данных prod Instantly.
 *
 * Гоняет РЕАЛЬНЫЙ код фильтра из othersWatchdog.ts (screenOthersEmail +
 * атрибуция домен→кампания + matchReplyToCampaign) по вкладке Unibox «Others»
 * за последние N дней и печатает вердикты по каждому кандидату. НИЧЕГО не
 * пишет: ни квалификаций, ни ИИ, ни TG, ни строк в БД. Нужен только чтобы
 * глазами оценить TAKE-список (реальные или warmup?) перед включением флага.
 *
 * Нагрузка (урок 20.07 — общий воркспейс-лимит ~10 RPM ест основной поллер):
 * страницы Others с паузой 3с, пробы 1.5с. Ожидаемая длительность — десятки
 * минут, запускать фоном.
 *
 * Запуск (из app/):
 *   npx esbuild scripts/others-watchdog-validate.ts --bundle --platform=node \
 *     --target=node22 --format=cjs --outfile=.tmp/others-validate.cjs \
 *     --tsconfig=tsconfig.json && node .tmp/others-validate.cjs [--days=3] [--max-pages=200]
 */
import path from 'path';
import fs from 'fs';
import { config as dotenvConfig } from 'dotenv';

for (const p of ['.env', '../.env']) {
  dotenvConfig({ path: path.resolve(process.cwd(), p), override: false });
}

function arg(name: string, fallback: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = m ? Number(m.split('=')[1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const DAYS = arg('days', 3);
const MAX_PAGES = arg('max-pages', 200);
const PAGE_DELAY_MS = arg('page-delay', 3000);
const PROBE_DELAY_MS = arg('probe-delay', 1500);
const PROBE_BUDGET = arg('probe-budget', 500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Сетевые флапы (не 429 — их клиент ретраит сам) — до 5 попыток с паузой 10с. */
async function fetchWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 5) throw err;
      console.warn(
        `[validate] ${label}: transient failure (attempt ${attempt}/5) — retry in 10s: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(10_000);
    }
  }
}

interface Row {
  sender: string;
  eaccount: string | null;
  subject: string | null;
  citedDomain: string;
  ts: string | null;
  verdict: 'TAKE' | 'warmup-no-match' | 'no-campaign' | 'defer';
  campaignId?: string;
  matchedSubject?: string | null;
}

async function main() {
  // Динамический импорт ПОСЛЕ загрузки env: модули читают ключи при инициализации.
  const { screenOthersEmail, _private } = await import('../src/lib/instantly/othersWatchdog');
  const { getBodyText } = await import('../src/lib/instantly/leadQualifier');
  const instantly = await import('../src/lib/instantly/client');

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  console.log(`[validate] window: last ${DAYS} day(s), pages≤${MAX_PAGES}, pageDelay=${PAGE_DELAY_MS}ms, probeDelay=${PROBE_DELAY_MS}ms`);

  console.log('[validate] fetching our accounts (paced)…');
  const { domains, mailboxesByDomain } = await fetchWithRetry(
    () => _private.getOurAccountsInfo(),
    'getOurAccountsInfo',
  );
  console.log(`[validate] ${domains.size} sending domains`);

  // 1. Обход Others назад по времени → локальный скрининг кандидатов.
  const raw: { email: import('../src/lib/instantly/types').Email; citedDomain: string }[] = [];
  const skips: Record<string, number> = {};
  let startingAfter: string | undefined;
  let scanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);
    const res = await fetchWithRetry(
      () =>
        instantly.listEmails({
          email_type: 'received',
          mode: 'emode_others',
          limit: 100,
          starting_after: startingAfter,
        }),
      `page ${page + 1}`,
    );
    const items = res.items ?? [];
    scanned += items.length;
    let reachedCutoff = false;
    for (const email of items) {
      const ts = Date.parse(email.timestamp_email ?? email.timestamp_created ?? '');
      if (Number.isFinite(ts) && ts < cutoff) {
        reachedCutoff = true;
        continue;
      }
      const s = screenOthersEmail(email, domains);
      if (s.verdict === 'candidate' && s.citedDomain) {
        raw.push({ email, citedDomain: s.citedDomain });
      } else {
        skips[s.verdict] = (skips[s.verdict] ?? 0) + 1;
      }
    }
    startingAfter = res.next_starting_after || undefined;
    if ((page + 1) % 10 === 0 || reachedCutoff) {
      console.log(`[validate] page ${page + 1}: scanned=${scanned}, candidates=${raw.length}`);
    }
    if (reachedCutoff || !startingAfter || items.length === 0) break;
  }
  console.log(`[validate] screening done: scanned=${scanned}, candidates=${raw.length}, skips=${JSON.stringify(skips)}`);

  // 2. Дедуп sender+citedDomain → новейшее (как в проде).
  const latest = new Map<string, (typeof raw)[number]>();
  const tsOf = (e: import('../src/lib/instantly/types').Email) =>
    Date.parse(e.timestamp_email ?? e.timestamp_created ?? '') || 0;
  for (const c of raw) {
    const key = `${(c.email.from_address_email ?? '').toLowerCase()}::${c.citedDomain}`;
    const prev = latest.get(key);
    if (!prev || tsOf(c.email) > tsOf(prev.email)) latest.set(key, c);
  }
  const fresh = [...latest.values()];
  console.log(`[validate] unique sender+domain: ${fresh.length} — probing attribution + subject/body match…`);

  // 3. Атрибуция + матч темы/тела РЕАЛЬНЫМ кодом.
  const meter = _private.makeProbeMeter(PROBE_BUDGET, PROBE_DELAY_MS);
  const rows: Row[] = [];
  let n = 0;
  for (const { email, citedDomain } of fresh) {
    n++;
    const sender = (email.from_address_email ?? '').toLowerCase();
    const row: Row = {
      sender,
      eaccount: (email.eaccount ?? '').toLowerCase() || null,
      subject: email.subject ?? null,
      citedDomain,
      ts: email.timestamp_email ?? null,
      verdict: 'warmup-no-match',
    };
    const candidates = await _private.getDomainCampaignCandidates(
      citedDomain,
      mailboxesByDomain,
      meter,
      row.eaccount,
    );
    if (candidates === null) {
      row.verdict = 'defer';
    } else if (candidates.length === 0) {
      row.verdict = 'no-campaign';
    } else {
      for (const cand of candidates.slice(0, 5)) {
        const sent = await _private.fetchCampaignSent(cand.campaignId, cand.accountId, meter);
        if (sent === null) {
          row.verdict = 'defer';
          continue;
        }
        const m = _private.matchReplyToCampaign(email.subject, getBodyText(email.body), sent);
        if (m) {
          row.verdict = 'TAKE';
          row.campaignId = cand.campaignId;
          row.matchedSubject = m.subject ?? null;
          break;
        }
      }
    }
    rows.push(row);
    if (row.verdict === 'TAKE' || n % 10 === 0) {
      console.log(`[validate] ${n}/${fresh.length} ${row.verdict} ${sender} «${row.subject ?? ''}»${row.campaignId ? ` → ${row.campaignId} («${row.matchedSubject ?? ''}»)` : ''}`);
    }
  }

  // 4. Сводка + файл с полными строками для разбора.
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  console.log(`[validate] DONE. verdicts: ${JSON.stringify(counts)}`);
  const takes = rows.filter((r) => r.verdict === 'TAKE');
  console.log(`[validate] TAKE list (${takes.length}) — для глаз:`);
  for (const r of takes) {
    console.log(`  TAKE ${r.ts?.slice(0, 10)} ${r.sender} (→${r.eaccount}) «${r.subject ?? ''}» → ${r.campaignId} «${r.matchedSubject ?? ''}» [${r.citedDomain}]`);
  }
  const outDir = path.resolve(process.cwd(), '../outputs');
  if (fs.existsSync(outDir)) {
    const outFile = path.join(outDir, `others-validate-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ days: DAYS, scanned, skips, counts, rows }, null, 2));
    console.log(`[validate] rows written: ${outFile}`);
  }
}

main().catch((err) => {
  console.error('[validate] FATAL', err);
  process.exit(1);
});
