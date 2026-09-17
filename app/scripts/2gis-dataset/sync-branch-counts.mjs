/**
 * sync-branch-counts.mjs — дотягивает «количество филиалов» из Places API 2GIS
 * в таблицу public.card_branch_counts базы 2gis_dataset.
 *
 * Зачем: в закупленной выгрузке 2GIS этого поля нет — она приходит 14
 * колонками, блока org среди них нет (проверено на боевой базе, в том числе
 * отдельно по гостиницам). Настоящее число живёт в API: items.org.branch_count,
 * «численность филиалов». Считать его самим по названию и домену не вышло —
 * на сетевой рознице выходит сносно, а на отелях разваливается: у каждого отеля
 * сети свой поддомен, зато агрегаторы вроде clck.ru и t.me склеивают тысячу
 * несвязанных мотелей в одну «сеть».
 *
 * Экономика прогона (тарифы 2GIS на 17.09.2026):
 *   - один запрос /3.0/items/byid принимает ДО 100 id — это и есть единица
 *     тарификации, а не карточка;
 *   - вся база 4,28 млн карточек = ~43 000 запросов;
 *   - лимит скорости 600 запросов/мин фиксирован и не поднимается, значит
 *     полный проход упирается в ~1,2 часа, а не в сутки;
 *   - демо-ключ даёт 1 000 запросов всего (= 100 000 карточек), пакет на
 *     50 000 запросов стоит 20 000 ₽ за платёжный месяц.
 * Поэтому ограничитель здесь — оплаченный пакет, и --budget существует, чтобы
 * случайный перезапуск не сжёг его за час.
 *
 * Режимы:
 *   fill    (по умолчанию) — карточки, которые ещё ни разу не спрашивали;
 *   refresh — самые давно обновлённые (число филиалов меняется медленно,
 *             гонять весь объём заново каждую ночь смысла нет).
 *
 * Прогон переживает обрыв: результат каждой пачки пишется сразу, курсор —
 * это сами данные, повторный запуск продолжает с того места.
 *
 * Usage:
 *   node sync-branch-counts.mjs                     # fill, бюджет из env
 *   node sync-branch-counts.mjs --budget=200        # не больше 200 запросов
 *   node sync-branch-counts.mjs --mode=refresh      # обновить самые старые
 *   node sync-branch-counts.mjs --only-subcategory="Гостиницы"
 *   node sync-branch-counts.mjs --rpm=300           # темп (потолок 2GIS — 600)
 *   node sync-branch-counts.mjs --dry-run           # ничего не писать в БД
 *
 * Требует в окружении: TWOGIS_DATASET_DB_URL (запись), TWOGIS_API_KEY.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

// ─── env ─────────────────────────────────────────────────────────────────
function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}
const env = { ...loadEnv(resolve(REPO_ROOT, '.env')), ...process.env };

const KEY = env.TWOGIS_API_KEY;
const DB_URL = env.TWOGIS_DATASET_DB_URL;
if (!KEY) { console.error('FATAL: no TWOGIS_API_KEY in env'); process.exit(1); }
if (!DB_URL) { console.error('FATAL: no TWOGIS_DATASET_DB_URL in env'); process.exit(1); }

// ─── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  if (a === `--${name}`) return true;
  return a.slice(name.length + 3);
}
const MODE = String(flag('mode', 'fill'));
if (MODE !== 'fill' && MODE !== 'refresh') {
  console.error('FATAL: --mode must be fill or refresh');
  process.exit(1);
}
// 0 — без собственного ограничения: прогон идёт, пока есть что спрашивать или
// пока 2GIS не скажет, что пакет кончился.
const BUDGET = Number(flag('budget', env.TWOGIS_API_DAILY_REQUESTS || 0));
// 600/мин — жёсткий потолок сервиса, он общий на все ключи подписки, поэтому
// по умолчанию держим половину: параллельный вызов из другого места не должен
// ронять оба.
const RPM = Math.min(Number(flag('rpm', env.TWOGIS_API_RPM || 300)), 600);
const ONLY_SUBCATEGORY = flag('only-subcategory', '');
const DRY = !!flag('dry-run', false);

const IDS_PER_REQUEST = 100;
const API_URL = 'https://catalog.api.2gis.com/3.0/items/byid';

function log(...m) { console.log(`[${new Date().toISOString()}]`, ...m); }

// ─── ограничитель темпа ──────────────────────────────────────────────────
const MIN_INTERVAL_MS = Math.round(60_000 / RPM);
let chain = Promise.resolve();
function rateLimit() {
  const next = chain.then(() => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)));
  chain = next.catch(() => undefined);
  return next;
}

/** Исчерпание оплаченного пакета — прогон надо закончить, а не долбиться. */
class QuotaExhaustedError extends Error {}

/**
 * Один запрос на пачку id. Возвращает массив items.
 * 2GIS кладёт настоящий код ответа в meta.code, а не только в HTTP-статус,
 * поэтому смотрим оба.
 */
async function fetchBatch(ids, attempt = 0) {
  await rateLimit();
  const url = new URL(API_URL);
  url.searchParams.set('key', KEY);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('fields', 'items.org');
  url.searchParams.set('locale', 'ru_RU');

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = 2 ** attempt * 1000;
    log(`сеть молчит (${err.message}), повтор через ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchBatch(ids, attempt + 1);
  }

  // 429 — превышен лимит в минуту, он общий на подписку: ждём и повторяем.
  if (response.status === 429) {
    if (attempt >= 5) throw new Error('2GIS: 429 не отпускает после 5 попыток');
    const wait = 2 ** attempt * 2000;
    log(`2GIS: 429, пауза ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchBatch(ids, attempt + 1);
  }
  if (response.status >= 500) {
    if (attempt >= 4) throw new Error(`2GIS: ${response.status} после 5 попыток`);
    const wait = 2 ** attempt * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return fetchBatch(ids, attempt + 1);
  }

  const body = await response.json().catch(() => null);
  const code = body?.meta?.code ?? response.status;

  // Месячный пакет кончился либо ключ заблокирован — дальше идти бессмысленно.
  if (code === 403 || code === 402) {
    throw new QuotaExhaustedError(
      `2GIS отказал (code ${code}): ${body?.meta?.error?.message ?? 'лимит подписки исчерпан или ключ не разрешает Places API'}`,
    );
  }
  // 404 на всю пачку — ни одного из этих id 2GIS не знает. Это нормальный
  // ответ, а не сбой: карточки закрываются, а срез у нас от июля.
  if (code === 404) return [];
  if (code !== 200) {
    throw new Error(`2GIS вернул code ${code}: ${body?.meta?.error?.message ?? 'без объяснения'}`);
  }
  return body?.result?.items ?? [];
}

/**
 * id в ответе может прийти с хвостом статистики (`id_hash`) — отрезаем,
 * иначе пачка не сойдётся с тем, что мы спрашивали.
 */
function plainId(value) {
  return String(value ?? '').split('_')[0];
}

async function main() {
  const db = new Client({ connectionString: DB_URL, application_name: 'portal-2gis-branch-sync' });
  await db.connect();

  const guard = await db.query('SELECT current_database() AS db');
  if (guard.rows[0]?.db !== '2gis_dataset') {
    throw new Error(`Refusing to write: expected database 2gis_dataset, got ${guard.rows[0]?.db}`);
  }

  const runStart = Date.now();
  let runId = null;
  if (!DRY) {
    const run = await db.query(
      'INSERT INTO public.branch_sync_runs (mode) VALUES ($1) RETURNING id',
      [MODE],
    );
    runId = run.rows[0].id;
  }

  let requests = 0;
  let synced = 0;
  let status = 'completed';
  let note = null;

  // Курсор внутри прогона: без него каждая следующая выборка заново
  // перелопачивает уже обработанное начало таблицы.
  let cursor = '';

  try {
    for (;;) {
      if (BUDGET > 0 && requests >= BUDGET) {
        status = 'budget_spent';
        note = `бюджет ${BUDGET} запросов израсходован`;
        break;
      }

      const batch = MODE === 'fill'
        ? await db.query(
            `SELECT cards.id
             FROM public.cards AS cards
             LEFT JOIN public.card_branch_counts AS synced
               ON synced.card_id = cards.id
             ${ONLY_SUBCATEGORY ? `JOIN public.card_subcategories AS pick
               ON pick.card_id = cards.id AND pick.value = $3` : ''}
             WHERE synced.card_id IS NULL
               AND cards.id > $2
             ORDER BY cards.id
             LIMIT $1`,
            ONLY_SUBCATEGORY
              ? [IDS_PER_REQUEST, cursor, ONLY_SUBCATEGORY]
              : [IDS_PER_REQUEST, cursor],
          )
        : await db.query(
            // Отсечка по времени старта: без неё прогон, обновив запись,
            // делает её «самой свежей», доходит до конца таблицы и начинает
            // круг заново — бесконечно, за деньги.
            `SELECT card_id AS id
             FROM public.card_branch_counts
             WHERE synced_at < $2
             ORDER BY synced_at ASC
             LIMIT $1`,
            [IDS_PER_REQUEST, new Date(runStart).toISOString()],
          );

      const ids = batch.rows.map((row) => row.id);
      if (ids.length === 0) break;
      if (MODE === 'fill') cursor = ids[ids.length - 1];

      const items = await fetchBatch(ids);
      requests += 1;

      const byId = new Map();
      for (const item of items) byId.set(plainId(item.id), item);

      // Спрошенные, но не вернувшиеся id — тоже результат: помечаем
      // not_found, иначе прогон будет вечно возвращаться к ним и жечь пакет.
      const rows = ids.map((id) => {
        const item = byId.get(id);
        if (!item) return { id, orgId: null, branches: null, state: 'not_found' };
        const org = item.org;
        if (!org || typeof org.branch_count !== 'number') {
          return { id, orgId: org?.id ?? null, branches: null, state: 'no_org' };
        }
        return { id, orgId: org.id ?? null, branches: org.branch_count, state: 'ok' };
      });

      if (!DRY) {
        await db.query(
          `INSERT INTO public.card_branch_counts (card_id, org_id, branch_count, status, synced_at)
           SELECT fetched.card_id, fetched.org_id, fetched.branch_count, fetched.status, now()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::text[])
             AS fetched(card_id, org_id, branch_count, status)
           ON CONFLICT (card_id) DO UPDATE
             SET org_id = EXCLUDED.org_id,
                 branch_count = EXCLUDED.branch_count,
                 status = EXCLUDED.status,
                 synced_at = EXCLUDED.synced_at`,
          [
            rows.map((r) => r.id),
            rows.map((r) => r.orgId),
            rows.map((r) => r.branches),
            rows.map((r) => r.state),
          ],
        );
      }
      synced += rows.length;

      if (requests % 25 === 0) {
        const found = rows.filter((r) => r.state === 'ok').length;
        log(`запросов ${requests}, карточек ${synced} (в последней пачке с организацией: ${found}/${rows.length})`);
      }
    }
  } catch (err) {
    status = err instanceof QuotaExhaustedError ? 'quota_exhausted' : 'failed';
    note = err.message;
    log(`ОСТАНОВ: ${err.message}`);
  } finally {
    if (!DRY && runId !== null) {
      await db.query(
        `UPDATE public.branch_sync_runs
         SET finished_at = now(), requests = $2, cards_synced = $3, status = $4, note = $5
         WHERE id = $1`,
        [runId, requests, synced, status, note],
      );
    }

    const progress = await db.query('SELECT * FROM public.branch_sync_progress');
    const p = progress.rows[0] ?? {};
    log(
      `${status}: запросов ${requests}, карточек ${synced}, `
      + `за ${Math.round((Date.now() - runStart) / 1000)}с. `
      + `Осталось карточек ${p.cards_pending} (~${p.requests_to_finish} запросов).`,
    );
    await db.end().catch(() => undefined);
  }

  if (status === 'failed') process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
