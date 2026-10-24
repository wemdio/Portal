/**
 * Ежемесячное обновление лицензий ФНС для сбора VE2 (companies_directory_licences).
 *
 * Реестр МСП выходит 10-го числа. Раз в FNS_LICENCES_TICK_MS (по умолчанию
 * 6 часов) воркер читает страницу набора на nalog.gov.ru и сравнивает новейший
 * файл со снимком в таблице. Файл новее — ZIP (около 2,3 ГБ) читается потоком,
 * без записи на диск; лицензии разбираются и заменяют снимок одной транзакцией
 * (lib/companiesDirectory/licenceLoad.ts). Файл старше снимка и снимок, слишком
 * непохожий на прежний, отклоняются.
 *
 * Попытки пишутся в companies_directory_licence_loads, по ним воркер решает,
 * пробовать ли файл снова (журнал переживает пересоздание контейнера на
 * деплое):
 *  - отказ проверок снимка окончателен для этого файла — его грузят руками
 *    (scripts/fns-sme-licences.ts);
 *  - сбой сети или базы повторяется не раньше чем через сутки;
 *  - попытка, не дошедшая до конца за 6 часов (перезапуск, нехватка памяти),
 *    считается сбоем и повторяется сразу.
 *
 * Итог обновления — сообщение в канал health-check бота, отказ и сбой — алерт.
 * Снимок старше 45 дней — алерт раз в сутки: месяц пропущен, а на 120-й день
 * VE2 сам перестанет предлагать фильтр по лицензии (licenceSnapshotReady).
 *
 * Деплой: сервис portal-worker-fns-licences в docker-compose.prod.yml
 * (command: node /app/workers/fnsLicencesCron.js), restart: unless-stopped.
 * Бандл собирается в Dockerfile.worker (esbuild).
 */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { Client } from 'pg';

import { createWorkerLogger, setupGracefulShutdown, sleep } from './_shared';
import {
  FNS_SME_DATASET_PAGE,
  latestFnsSmeRelease,
  parseFnsSmeLicencesZip,
  type FnsSmeRelease,
} from '@/lib/companiesDirectory/fnsSmeLicences';
import {
  applyLicenceSnapshot,
  isLicenceSnapshotRefusal,
  licenceRowCollector,
  licenceSnapshotDate,
  type LicenceLoadResult,
  type LicenceRow,
} from '@/lib/companiesDirectory/licenceLoad';
import { LICENCE_GROUPS } from '@/lib/companiesDirectory/licences';
import { escapeTelegramHtml, sendWorkerAlert, sendWorkerNotice } from '@/lib/telegram/workerAlert';

const WORKER_ID = 'fns-licences-cron';
const TICK_MS = Number(process.env.FNS_LICENCES_TICK_MS ?? '21600000'); // 6 ч
const PAGE_TIMEOUT_MS = 60_000;
/** Файл скачивается вместе с разбором: скорость задаёт процессор контейнера. */
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Сбой сети или базы: тот же файл пробуется снова не раньше чем через сутки. */
const RETRY_FAILED_MS = DAY_MS;
/** Попытка в статусе running дольше этого прервалась: перезапуск или нехватка памяти. */
const RUNNING_ABANDONED_MS = 6 * 60 * 60 * 1000;
/** Реестр выходит 10-го: снимок старше 45 дней значит, что месяц пропущен. */
const STALE_SNAPSHOT_DAYS = 45;

type Log = ReturnType<typeof createWorkerLogger>;
type LoadStatus = 'running' | 'loaded' | 'refused' | 'failed' | 'stale';
interface LoadRow { id: string; status: LoadStatus; started_at: Date }

/** Алерты, которые некуда записать (база недоступна): не чаще раза в сутки на тему. */
const lastAlertAt = new Map<string, number>();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function databaseUrl(): string {
  const url = (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || '').trim();
  if (!url) throw new Error('DATABASE_URL / SUPABASE_DB_URL is required');
  return url;
}

function useSsl(connectionString: string): boolean {
  const explicit = (process.env.DB_SSL || process.env.PGSSLMODE || '').toLowerCase();
  if (['require', 'true', '1'].includes(explicit)) return true;
  try {
    const url = new URL(connectionString);
    return url.searchParams.get('sslmode') === 'require' || url.hostname.endsWith('supabase.co');
  } catch {
    return false;
  }
}

/** Короткое соединение на каждый шаг: скачивание и разбор идут без открытой сессии БД. */
async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const connectionString = databaseUrl();
  const db = new Client({
    connectionString,
    application_name: 'portal-fns-licences',
    ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  // pg шлёт 'error' при обрыве соединения даже посреди запроса: без слушателя
  // процесс падал бы раньше, чем запрос вернёт ошибку в catch.
  db.on('error', (error) => console.warn(`[worker][${WORKER_ID}][WARN] соединение с БД: ${error.message}`));
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => undefined);
  }
}

async function alertOncePerDay(log: Log, subject: string, error: unknown): Promise<void> {
  log('error', `${subject}: ${message(error)}`);
  if (Date.now() - (lastAlertAt.get(subject) ?? 0) < DAY_MS) return;
  if (await sendWorkerAlert({ workerId: WORKER_ID, subject, error })) lastAlertAt.set(subject, Date.now());
}

async function warnIfStale(log: Log, current: string | null, fileName: string): Promise<void> {
  if (!current) return;
  const days = Math.floor((Date.now() - Date.parse(current)) / DAY_MS);
  if (days <= STALE_SNAPSHOT_DAYS) return;
  const text = `снимку ${current} уже ${days} дней, нового загруженного файла нет; `
    + 'на 120-й день VE2 перестанет предлагать фильтр по лицензии';
  log('warn', text);
  const sentToday = await withDb(async (db) => (await db.query(
    `SELECT 1 FROM public.companies_directory_licence_loads
      WHERE status = 'stale' AND started_at > now() - interval '1 day' LIMIT 1`)).rowCount);
  if (sentToday) return;
  if (!(await sendWorkerAlert({ workerId: WORKER_ID, subject: 'снимок лицензий ФНС устарел', error: text }))) return;
  await withDb((db) => db.query(
    `INSERT INTO public.companies_directory_licence_loads (file_name, status, finished_at, error)
     VALUES ($1, 'stale', now(), $2)`, [fileName, text]));
}

async function findRelease(): Promise<FnsSmeRelease> {
  const response = await fetch(FNS_SME_DATASET_PAGE, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`страница набора: HTTP ${response.status}`);
  const release = latestFnsSmeRelease(await response.text());
  if (!release) throw new Error('на странице набора нет ссылки на файл реестра');
  return release;
}

async function readRelease(release: FnsSmeRelease): Promise<{ rows: LicenceRow[]; snapshot: string }> {
  const response = await fetch(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`${release.name}: HTTP ${response.status}`);
  const collector = licenceRowCollector();
  const scan = await parseFnsSmeLicencesZip({
    input: Readable.fromWeb(response.body as unknown as WebReadableStream),
    onRecord: (record) => collector.add(record),
  });
  if (!scan.registryDate) throw new Error(`${release.name}: в файле нет даты реестра`);
  return { rows: collector.rows(), snapshot: licenceSnapshotDate(scan.registryDate) };
}

/** Пробовать ли файл сейчас — по последней записи журнала о нём. */
function nextStep(last: LoadRow | null, now: number): 'load' | 'retry_abandoned' | 'loaded' | 'refused' | 'failed_recently' | 'running' {
  if (!last) return 'load';
  const age = now - last.started_at.getTime();
  if (last.status === 'loaded' || last.status === 'refused') return last.status;
  if (last.status === 'failed') return age < RETRY_FAILED_MS ? 'failed_recently' : 'load';
  if (last.status === 'running') return age < RUNNING_ABANDONED_MS ? 'running' : 'retry_abandoned';
  return 'load';
}

const SKIP_REASON = {
  loaded: 'уже загружен',
  refused: 'отклонён проверками снимка, ждёт ручной загрузки',
  failed_recently: 'не загрузился, повтор через сутки после сбоя',
  running: 'загружается другой попыткой',
} as const;

const fmt = (value: number) => value.toLocaleString('ru-RU');
const ruDate = (iso: string) => iso.split('-').reverse().join('.');

function summaryHtml(previous: string | null, snapshot: string, result: LicenceLoadResult,
  before: Map<string, number>, rows: readonly LicenceRow[]): string {
  const after = new Map<string, number>();
  for (const row of rows) for (const group of row.groups) after.set(group, (after.get(group) ?? 0) + 1);
  const changed = LICENCE_GROUPS
    .map((group) => ({ code: group.code, was: before.get(group.code) ?? 0, now: after.get(group.code) ?? 0 }))
    .filter(({ was, now }) => Math.abs(now - was) >= Math.max(50, was * 0.05))
    .map(({ code, was, now }) => `${code}: ${fmt(was)} → ${fmt(now)}`);
  return [
    `<b>Лицензии ФНС обновлены</b>: снимок ${ruDate(snapshot)}${previous && previous !== snapshot ? ` вместо ${ruDate(previous)}` : ''}.`,
    escapeTelegramHtml(`Юрлиц с лицензией: ${fmt(result.rowsInFile)} (новых ${fmt(result.inserted)}, обновлено ${fmt(result.updated)}, `
      + `удалено ${fmt(result.deleted)}); в «базе баз» — ${fmt(result.inCompaniesDirectory)}.`),
    escapeTelegramHtml(changed.length ? `Заметно изменились группы: ${changed.join('; ')}.` : 'Группы изменились меньше чем на 5%.'),
  ].join('\n');
}

async function loadRelease(log: Log, release: FnsSmeRelease, current: string | null): Promise<void> {
  const id = await withDb(async (db) => (await db.query<{ id: string }>(
    'INSERT INTO public.companies_directory_licence_loads (file_name) VALUES ($1) RETURNING id', [release.name])).rows[0].id);
  const finish = (status: LoadStatus, snapshot: string | null, result: LicenceLoadResult | null, error: string | null) =>
    withDb((db) => db.query(
      `UPDATE public.companies_directory_licence_loads
          SET status = $2, snapshot_date = $3, result = $4::jsonb, error = $5, finished_at = now()
        WHERE id = $1`, [id, status, snapshot, result ? JSON.stringify(result) : null, error]));
  const startedAt = Date.now();
  log('info', `Новый файл ${release.name}, снимок в таблице ${current ?? 'пуст'}: загружаю`);
  let snapshot: string | null = null;
  try {
    const read = await readRelease(release);
    snapshot = read.snapshot;
    const { before, result } = await withDb(async (db) => {
      const counts = await db.query<{ g: string; n: string }>(
        'SELECT g, count(*) AS n FROM public.companies_directory_licences, unnest(groups) g GROUP BY g');
      return {
        before: new Map(counts.rows.map((row) => [row.g, Number(row.n)])),
        result: await applyLicenceSnapshot(db, read.rows, read.snapshot),
      };
    });
    await finish('loaded', snapshot, result, null);
    log('info', `Снимок ${snapshot} загружен за ${Math.round((Date.now() - startedAt) / 60_000)} мин: ${JSON.stringify(result)}`);
    await sendWorkerNotice(summaryHtml(current, snapshot, result, before, read.rows));
  } catch (error) {
    // Отказ проверок снимка окончателен для файла: данные в нём не изменятся.
    // Сбой сети или базы повторится через сутки.
    const refused = isLicenceSnapshotRefusal(error);
    log('error', `${release.name}: ${message(error)}`);
    await finish(refused ? 'refused' : 'failed', snapshot, null, message(error))
      .catch((journalError) => log('error', `журнал загрузок: ${message(journalError)}`));
    await sendWorkerAlert({
      workerId: WORKER_ID,
      subject: refused ? 'снимок лицензий ФНС отклонён проверками' : 'обновление лицензий ФНС не прошло',
      error,
      context: {
        file: release.name,
        snapshot_in_table: current ?? 'пуст',
        next: refused
          ? 'сам не загрузится: проверить файл и загрузить вручную (scripts/fns-sme-licences.ts, --allow-big-change)'
          : 'повтор через сутки',
      },
    });
  }
}

async function tickOnce(log: Log): Promise<void> {
  const current = await withDb(async (db) => (await db.query<{ snapshot: string | null }>(
    'SELECT max(snapshot_date)::text AS snapshot FROM public.companies_directory_licences')).rows[0]?.snapshot ?? null);

  let release: FnsSmeRelease;
  try {
    release = await findRelease();
  } catch (error) {
    // Сайт ФНС бывает недоступен часами: один пропущенный тик не авария.
    log('warn', `Не удалось прочитать страницу набора: ${message(error)}`);
    await warnIfStale(log, current, 'страница набора недоступна');
    return;
  }

  if (current && release.date <= current) {
    log('info', `Снимок ${current} актуален, новейший файл ${release.name}`);
    await warnIfStale(log, current, release.name);
    return;
  }

  const last = await withDb(async (db) => (await db.query<LoadRow>(
    `SELECT id, status, started_at FROM public.companies_directory_licence_loads
      WHERE file_name = $1 AND status <> 'stale' ORDER BY started_at DESC LIMIT 1`, [release.name])).rows[0] ?? null);
  const step = nextStep(last, Date.now());
  if (step === 'retry_abandoned' && last) {
    const note = `попытка с ${last.started_at.toISOString()} не дошла до конца: перезапуск воркера или нехватка памяти`;
    await withDb((db) => db.query(
      `UPDATE public.companies_directory_licence_loads SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [last.id, note]));
    await sendWorkerAlert({ workerId: WORKER_ID, subject: 'обновление лицензий ФНС прервалось', error: note,
      context: { file: release.name, next: 'пробую снова сейчас' } });
  } else if (step !== 'load' && step !== 'retry_abandoned') {
    log('info', `${release.name}: ${SKIP_REASON[step]}`);
    await warnIfStale(log, current, release.name);
    return;
  }
  await loadRelease(log, release, current);
}

async function main(): Promise<void> {
  const log = createWorkerLogger(WORKER_ID);
  const shouldStop = setupGracefulShutdown(log);

  log('info', `Starting FNS licences worker. TICK_MS=${TICK_MS} (${Math.round(TICK_MS / 60_000)} min)`);

  while (!shouldStop()) {
    try {
      await tickOnce(log);
    } catch (error) {
      await alertOncePerDay(log, 'проверка лицензий ФНС упала', error);
    }
    // Между тиками — короткие сны, чтобы SIGTERM перехватывался быстро.
    const stopAt = Date.now() + TICK_MS;
    while (Date.now() < stopAt && !shouldStop()) {
      await sleep(Math.min(5_000, stopAt - Date.now()));
    }
  }

  log('info', 'Stopped.');
}

void main().catch((err) => {
  console.error('[worker][fns-licences-cron][FATAL]', err);
  process.exit(1);
});
