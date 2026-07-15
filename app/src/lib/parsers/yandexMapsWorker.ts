import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo, logWarn } from '@/lib/loggerServer';
import { decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { normalizeYandexOrgUrls } from '@/lib/parsers/yandexMapsUrlUtils';
import { YandexMapsBlockedError, yandexMapsCollectLinksStream, yandexMapsHealth, yandexMapsParseOrgs, yandexMapsProxyCheck } from '@/lib/parsers/yandexMapsServiceClient';
import { startTrace } from '@/lib/tracer';

type ProxyCreds = { username: string; password: string };

type YandexMapsJobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: unknown;
  progress_stage: string | null;
  started_at: string | null;
  proxy_enabled: boolean;
  proxy_protocol: string | null;
  proxy_host: string | null;
  proxy_port: string | null;
  proxy_credentials_encrypted: string | null;
};

function getEncryptionKey() {
  return (process.env.YANDEXMAPS_PROXY_ENCRYPTION_KEY ?? '').trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ждёт готовности yandexmaps сервиса. Нужно, потому что при деплое воркер
 * стартует секунд на 10 раньше, чем uvicorn поднимает Python-сервис —
 * первая проверка возвращает false, но через минуту всё готово. Раньше
 * одна неудача сразу помечала job как failed («health check failed»), из-за
 * чего свежие задачи после деплоя приходилось перезапускать вручную.
 */
async function waitForYandexMapsHealth(attempts = 6, delayMs = 10_000): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await yandexMapsHealth()) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

async function setJobPatch(jobId: string, patch: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from('yandex_maps_jobs').update(patch).eq('id', jobId);
}

async function getJob(jobId: string) {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .select('id,user_id,status,config,progress_stage,started_at,proxy_enabled,proxy_protocol,proxy_host,proxy_port,proxy_credentials_encrypted')
    .eq('id', jobId)
    .single();
  return (data ?? null) as YandexMapsJobRow | null;
}

type ResolvedProxy = { enabled: boolean; protocol: 'http' | 'https' | 'socks5'; host: string; port: string; username?: string; password?: string };

const NO_PROXY: ResolvedProxy = { enabled: false, protocol: 'http', host: '', port: '' };

function buildProxy(job: YandexMapsJobRow): ResolvedProxy {
  if (!job.proxy_enabled) return NO_PROXY;

  const protocol = (job.proxy_protocol ?? 'http') as 'http' | 'https' | 'socks5';
  const proxy: ResolvedProxy = {
    enabled: true,
    protocol,
    host: String(job.proxy_host ?? ''),
    port: String(job.proxy_port ?? ''),
  };

  if (job.proxy_credentials_encrypted) {
    const key = getEncryptionKey();
    if (!key) {
      throw new Error('YANDEXMAPS_PROXY_ENCRYPTION_KEY не настроен');
    }
    const creds = decryptJsonAes256Gcm<ProxyCreds>(job.proxy_credentials_encrypted, key);
    proxy.username = creds.username;
    proxy.password = creds.password;
  }

  return proxy;
}

/** Разбирает строку прокси вида `http://user:pass@host:port` в структуру. */
function parseProxyUrl(raw: string): ResolvedProxy | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const proto = u.protocol.replace(/:$/, '').toLowerCase();
    const protocol: 'http' | 'https' | 'socks5' =
      proto === 'https' ? 'https' : proto === 'socks5' || proto === 'socks' ? 'socks5' : 'http';
    if (!u.hostname || !u.port) return null;
    const proxy: ResolvedProxy = { enabled: true, protocol, host: u.hostname, port: u.port };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return null;
  }
}

/**
 * Пул прокси для Яндекс.Карт из env. Источник — YANDEXMAPS_PROXY_URLS, иначе
 * общий PROXY_URLS (JSON-массив строк, либо адреса через запятую/пробел).
 * Кэшируется на процесс — env не меняется в рантайме.
 */
let cachedProxyPool: ResolvedProxy[] | null = null;
function getYandexMapsProxyPool(): ResolvedProxy[] {
  if (cachedProxyPool) return cachedProxyPool;
  const raw = (process.env.YANDEXMAPS_PROXY_URLS ?? process.env.PROXY_URLS ?? '').trim();
  if (!raw) {
    cachedProxyPool = [];
    return cachedProxyPool;
  }
  let entries: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    entries = raw.split(/[\s,]+/).filter(Boolean);
  }
  cachedProxyPool = entries.map(parseProxyUrl).filter((p): p is ResolvedProxy => p !== null);
  return cachedProxyPool;
}

/** Детерминированный сдвиг старта ротации по jobId — чтобы разные задачи начинали с разных прокси. */
function jobProxyOffset(jobId: string): number {
  let h = 0;
  for (let i = 0; i < jobId.length; i += 1) h = (h * 31 + jobId.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Выбор прокси для конкретной единицы работы (URL сбора / чанк парсинга).
 * Приоритет — прокси, заданный в самой задаче; иначе round-robin по пулу
 * (poolOverride — уже отфильтрованный по скорости пул, см. probeProxyPool);
 * иначе прямое соединение (как раньше).
 */
function pickProxy(job: YandexMapsJobRow, index: number, poolOverride?: ResolvedProxy[]): ResolvedProxy {
  if (job.proxy_enabled) return buildProxy(job);
  const pool = poolOverride ?? getYandexMapsProxyPool();
  if (pool.length === 0) return NO_PROXY;
  const pos = (jobProxyOffset(job.id) + index) % pool.length;
  return pool[pos]!;
}

// Минимальная скорость прокси, чтобы страница Карт (~2-4 МБ) успевала
// загрузиться в 90-секундный goto-таймаут. 50 КБ/с — нижняя граница:
// медленнее = гарантированный page_load_timeout и пустая задача.
const PROXY_MIN_BPS = Number(process.env.YANDEXMAPS_PROXY_MIN_BPS ?? '50000');

/**
 * Прогоняет пул прокси из env через /proxy-check сервиса и оставляет только
 * те, что реально тянут (>= PROXY_MIN_BPS). Инцидент 14.07.2026: shared
 * LTE-прокси просели до 2.7-11 КБ/с, но ротация продолжала гонять через них
 * 2/3 URL — все впустую. Возвращает:
 * - filtered: пул живых прокси (может быть пустым — тогда вызывающий код
 *   честно фейлит задачу);
 * - report: строка со скоростями для сообщения пользователю;
 * - checked: false, если сервис не поддерживает /proxy-check (старый образ)
 *   или все чеки упали по сети — фильтровать нечем, используем весь пул.
 */
async function probeProxyPool(
  jobId: string,
  logMeta: Record<string, unknown>,
): Promise<{ filtered: ResolvedProxy[]; report: string; checked: boolean }> {
  const pool = getYandexMapsProxyPool();
  if (!pool.length) return { filtered: pool, report: '', checked: false };

  const checks = await Promise.all(pool.map((p) => yandexMapsProxyCheck(p)));
  if (checks.every((c) => c === null)) {
    void logWarn('parser.yandexmaps.proxy_check.unavailable', 'proxy-check недоступен, используем весь пул без фильтра', { jobId, poolSize: pool.length }, logMeta);
    return { filtered: pool, report: '', checked: false };
  }

  const filtered: ResolvedProxy[] = [];
  const parts: string[] = [];
  pool.forEach((p, i) => {
    const c = checks[i];
    const kbps = c && c.ok ? Math.round(c.speed_bps / 1024) : 0;
    const good = !!c && c.ok && c.speed_bps >= PROXY_MIN_BPS;
    parts.push(`${p.host}:${p.port} — ${c && c.ok ? `${kbps} КБ/с` : 'не отвечает'}${good ? '' : ' ✗'}`);
    if (good) filtered.push(p);
  });
  const report = parts.join('; ');
  void logInfo(
    'parser.yandexmaps.proxy_check.result',
    'Proxy pool probe',
    { jobId, total: pool.length, healthy: filtered.length, minBps: PROXY_MIN_BPS, report },
    logMeta,
  );
  return { filtered, report, checked: true };
}

/** Сообщение для задачи, когда ни один прокси из пула не прошёл проверку скорости. */
function slowProxyMessage(report: string): string {
  return (
    `Все прокси сейчас слишком медленные для Яндекс.Карт (нужно от ${Math.round(PROXY_MIN_BPS / 1024)} КБ/с). ` +
    `Замер: ${report}. Shared-канал у прокси-провайдера перегружен — подождите 10-15 минут и нажмите ` +
    `«Продолжить парсинг», либо возьмите более быстрые прокси (приватные или тариф выше 1.6 Мбит/с).`
  );
}

export async function runYandexMapsCollectLinks(jobId: string) {
  if (!supabaseAdmin) {
    console.error('supabaseAdmin not configured');
    return;
  }

  const job = await getJob(jobId);
  if (!job) return;

  if (job.status === 'completed') return;

  const requestId = crypto.randomUUID();
  const logMeta = { userId: job.user_id, requestId, route: 'yandex_maps_collect_links' };

  const trace = await startTrace({
    name: 'yandexmaps.collect_links',
    input: { jobId, requestId, userId: job.user_id },
    message: 'Яндекс.Карты: сбор ссылок',
    userId: job.user_id,
  });

  try {
    const progressStage = String(job.progress_stage ?? 'pending');
    const isResumeCollect = progressStage.startsWith('collecting_links') || progressStage === 'links_collected';

    if (!isResumeCollect) {
      await supabaseAdmin.from('yandex_maps_links').delete().eq('job_id', jobId);
      await supabaseAdmin.from('yandex_maps_organizations').delete().eq('job_id', jobId);
    }

    const { data: existingLinksRows, error: existingLinksError } = await supabaseAdmin
      .from('yandex_maps_links')
      .select('link')
      .eq('job_id', jobId);
    if (existingLinksError) throw new Error(existingLinksError.message);
    const existingLinks = normalizeYandexOrgUrls(
      (existingLinksRows ?? [])
        .map((r) => String((r as { link?: unknown }).link ?? ''))
        .filter(Boolean),
    );
    const allLinksSet = new Set(existingLinks);
    const allLinks: string[] = [...allLinksSet];

    await setJobPatch(jobId, {
      status: 'running',
      progress_stage: 'collecting_links',
      started_at: job.started_at ?? new Date().toISOString(),
      processed_links: allLinks.length,
      total_links: allLinks.length,
      error_message: null,
    });

    const cfg = (job.config && typeof job.config === 'object') ? (job.config as Record<string, unknown>) : {};
    const MAX_SEARCH_URLS = 500;
    const searchUrls = (Array.isArray((cfg as { search_urls?: unknown }).search_urls)
      ? ((cfg as { search_urls: unknown[] }).search_urls.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))
      : []).slice(0, MAX_SEARCH_URLS);
    const maxResultsRaw = (cfg as { max_results?: unknown }).max_results;
    const maxResults = typeof maxResultsRaw === 'number' || typeof maxResultsRaw === 'string'
      ? (Number(maxResultsRaw) || 5000)
      : 5000;
    const headless = (cfg as { headless?: unknown }).headless !== false;

    if (!searchUrls.length) {
      await setJobPatch(jobId, { status: 'failed', error_message: 'Нет URL для поиска' });
      await trace?.fail(new Error('Missing search_urls'));
      return;
    }

    const serviceHealthy = await waitForYandexMapsHealth();
    if (!serviceHealthy) {
      const msg = 'Сервис yandexmaps недоступен (не поднялся за минуту). Проверьте, что контейнер yandexmaps запущен.';
      await setJobPatch(jobId, { status: 'failed', error_message: msg });
      await trace?.fail(new Error(msg));
      void logError('parser.yandexmaps.collect.health_failed', new Error(msg), { jobId }, logMeta);
      return;
    }

    void logInfo('parser.yandexmaps.collect.start', 'YandexMaps collect-links started', { jobId, searchUrlsCount: searchUrls.length }, logMeta);

    // Отфильтровываем задушенные прокси до старта — иначе ротация гоняет
    // URL через каналы, которые физически не загрузят страницу Карт.
    let activePool: ResolvedProxy[] | undefined;
    if (!job.proxy_enabled && getYandexMapsProxyPool().length > 0) {
      const probe = await probeProxyPool(jobId, logMeta);
      if (probe.checked && probe.filtered.length === 0) {
        const msg = slowProxyMessage(probe.report);
        await setJobPatch(jobId, {
          status: 'failed',
          error_message: msg,
          progress_stage: 'proxy_too_slow',
          completed_at: new Date().toISOString(),
        });
        await trace?.fail(new Error(msg));
        void logWarn('parser.yandexmaps.collect.proxy_too_slow', 'All proxies below speed threshold', { jobId, report: probe.report }, logMeta);
        return;
      }
      activePool = probe.checked ? probe.filtered : undefined;
    }

    const collectConcurrency = Number(process.env.YANDEXMAPS_COLLECT_CONCURRENCY ?? '2');
    let completedUrls = 0;
    let blockedUrls = 0;
    let failedUrls = 0;
    let intlRedirectUrls = 0;
    const proxyPoolSize = job.proxy_enabled ? 1 : (activePool ?? getYandexMapsProxyPool()).length;
    void logInfo('parser.yandexmaps.collect.proxy', 'YandexMaps collect proxy pool', { jobId, proxyPoolSize }, logMeta);

    const urlBatches = chunk(
      searchUrls.map((url, i) => ({ url, index: i + 1 })),
      collectConcurrency,
    );

    for (const batch of urlBatches) {
      const current = await getJob(jobId);
      if (current?.status === 'failed') {
        await trace?.cancel('Cancelled');
        return;
      }

      await Promise.all(batch.map(async ({ url: search_url, index: urlIndex }) => {
        const urlSpan = await trace?.startChild({
          name: 'yandexmaps.collect_links.url',
          input: { search_url, index: urlIndex, total: searchUrls.length, max_results: maxResults },
          message: `URL ${urlIndex}/${searchUrls.length}`,
        });

        const collectStreamCallback = async (ch: { links: string[] }) => {
          if (ch.links.length > 0) {
            const normalized = normalizeYandexOrgUrls(ch.links);
            for (const link of normalized) {
              if (!allLinksSet.has(link)) {
                allLinksSet.add(link);
                allLinks.push(link);
              }
            }
            const rows = normalized.map((link) => ({ job_id: jobId, link }));
            await supabaseAdmin!.from('yandex_maps_links').upsert(rows, { onConflict: 'job_id,link' });
          }
          await setJobPatch(jobId, {
            total_links: allLinks.length,
            processed_links: allLinks.length,
            progress_stage: `collecting_links:${completedUrls + batch.length}/${searchUrls.length}`,
          });
        };

        // Ретрай URL через разные прокси — на ЛЮБУЮ ошибку, не только
        // yandex_blocked. Обрыв стрима (TypeError: terminated), 500 сервиса,
        // умерший прокси — всё это лечится следующим IP из пула, а уже
        // собранные порции ссылок не теряются (collectStreamCallback пишет
        // их в БД инкрементально). Пул + 1 запас.
        const maxProxyRetries = Math.max(1, proxyPoolSize) + 1;
        let success = false;
        let lastTotal = 0;
        let urlIntlRedirect = false;
        let lastBlockedError: YandexMapsBlockedError | null = null;
        let lastGenericError: unknown = null;
        for (let attempt = 0; attempt < maxProxyRetries; attempt++) {
          try {
            const { total, intlRedirect } = await yandexMapsCollectLinksStream(
              { search_url, max_results: maxResults, headless, proxy: pickProxy(job, urlIndex - 1 + attempt, activePool) },
              collectStreamCallback,
            );
            lastTotal = total;
            urlIntlRedirect = intlRedirect;
            success = true;
            break;
          } catch (e) {
            if (e instanceof YandexMapsBlockedError) {
              lastBlockedError = e;
              void logWarn(
                'parser.yandexmaps.collect.url_blocked_retry',
                `Yandex заблокировал URL ${urlIndex}, пробуем следующий прокси`,
                { jobId, search_url, attempt: attempt + 1, maxRetries: maxProxyRetries },
                logMeta,
              );
              continue;
            }
            lastGenericError = e;
            void logWarn(
              'parser.yandexmaps.collect.url_error_retry',
              `URL ${urlIndex} упал (${e instanceof Error ? e.message : String(e)}), пробуем следующий прокси`,
              { jobId, search_url, attempt: attempt + 1, maxRetries: maxProxyRetries },
              logMeta,
            );
            continue;
          }
        }

        if (success) {
          if (urlIntlRedirect) {
            intlRedirectUrls += 1;
            void logWarn(
              'parser.yandexmaps.collect.intl_redirect',
              `Яндекс перенаправил URL ${urlIndex} на международную версию (yandex.com) — выдача урезана до первого экрана. Нужны российские прокси.`,
              { jobId, search_url, links_collected: lastTotal },
              logMeta,
            );
          }
          await urlSpan?.end({ links_collected: lastTotal, total_unique: allLinks.length, intl_redirect: urlIntlRedirect });
        } else if (lastBlockedError) {
          blockedUrls += 1;
          void logWarn(
            'parser.yandexmaps.collect.url_blocked',
            'Collect-links blocked across all proxies',
            { jobId, search_url, poolSize: proxyPoolSize },
            logMeta,
          );
          await urlSpan?.fail(lastBlockedError);
        } else if (lastGenericError) {
          failedUrls += 1;
          void logWarn(
            'parser.yandexmaps.collect.url_failed',
            'Collect-links failed for URL',
            { jobId, search_url, error: String(lastGenericError) },
            logMeta,
          );
          await urlSpan?.fail(lastGenericError);
        }
      }));

      completedUrls += batch.length;
    }

    await setJobPatch(jobId, {
      total_links: allLinks.length,
      processed_links: allLinks.length,
      progress_stage: 'links_collected',
    });

    if (intlRedirectUrls > 0) {
      // Сигнал «собрали 2% возможного»: зарубежные прокси -> yandex.com ->
      // только первый экран выдачи. Задача формально завершится, но лечится
      // это только сменой прокси на российские (см. инцидент 15.07.2026).
      void logWarn(
        'parser.yandexmaps.collect.intl_redirect_summary',
        `Международная выдача yandex.com на ${intlRedirectUrls} из ${searchUrls.length} запросов — собрано только по первому экрану (~${Math.round(allLinks.length / Math.max(searchUrls.length, 1))} ссылок/запрос). Для полной выдачи нужны российские прокси.`,
        { jobId, intlRedirectUrls, totalUrls: searchUrls.length, totalLinks: allLinks.length },
        logMeta,
      );
    }
    await trace?.end({ total_unique_links: allLinks.length, intl_redirect_urls: intlRedirectUrls });
    void logInfo('parser.yandexmaps.collect.complete', 'YandexMaps collect-links completed', { jobId, totalLinks: allLinks.length, intlRedirectUrls }, logMeta);

    if (allLinks.length > 0) {
      void logInfo('parser.yandexmaps.auto_parse', 'Auto-starting parse after collect', { jobId, totalLinks: allLinks.length }, logMeta);
      await runYandexMapsParseOrganizations(jobId);
    } else if (blockedUrls > 0) {
      // 0 ссылок и была блокировка => это не «пустая выдача», а капча/антибот.
      // Пишем честную причину вместо вводящего в заблуждение «Завершено».
      const msg =
        `Яндекс временно заблокировал наши прокси на этапе поиска ` +
        `(${blockedUrls} из ${searchUrls.length} запросов не прошли). ` +
        `Подождите 15–20 минут (IP прокси меняются каждые 2 минуты) и нажмите «Продолжить парсинг» — попробуем те же запросы через свежие IP.`;
      await setJobPatch(jobId, {
        status: 'failed',
        error_message: msg,
        progress_stage: 'yandex_blocked',
        completed_at: new Date().toISOString(),
      });
      void logWarn('parser.yandexmaps.collect.all_blocked', 'Collect finished with 0 links due to blocking', { jobId, blockedUrls, totalUrls: searchUrls.length }, logMeta);
    } else if (failedUrls > 0) {
      // 0 ссылок и все (или часть) URL упали с не-блокировочной ошибкой —
      // прокси не тянет страницу / сервис недоступен. Раньше такая задача
      // помечалась «Завершено» с 0 ссылок, и было непонятно, что сломано.
      const msg =
        `Не удалось собрать ссылки: ${failedUrls} из ${searchUrls.length} поисковых запросов ` +
        `упали с ошибкой загрузки страницы (прокси не отвечает или слишком медленный). ` +
        `Проверьте прокси и нажмите «Продолжить парсинг».`;
      await setJobPatch(jobId, {
        status: 'failed',
        error_message: msg,
        progress_stage: 'collect_failed',
        completed_at: new Date().toISOString(),
      });
      void logWarn('parser.yandexmaps.collect.all_failed', 'Collect finished with 0 links due to URL errors', { jobId, failedUrls, totalUrls: searchUrls.length }, logMeta);
    } else {
      await setJobPatch(jobId, {
        status: 'completed',
        progress_stage: 'completed',
        completed_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    await setJobPatch(jobId, { status: 'failed', error_message: e instanceof Error ? e.message : 'Ошибка' });
    await trace?.fail(e);
    void logError('parser.yandexmaps.collect.failed', e, { jobId }, logMeta);
  }
}

export async function runYandexMapsParseOrganizations(jobId: string) {
  if (!supabaseAdmin) {
    console.error('supabaseAdmin not configured');
    return;
  }

  const job = await getJob(jobId);
  if (!job) return;

  if (job.status === 'completed') return;

  const isCancelled = job.status === 'failed';
  if (isCancelled) return;

  const requestId = crypto.randomUUID();
  const logMeta = { userId: job.user_id, requestId, route: 'yandex_maps_parse_orgs' };

  const trace = await startTrace({
    name: 'yandexmaps.parse_orgs',
    input: { jobId, requestId, userId: job.user_id },
    message: 'Яндекс.Карты: парсинг организаций',
    userId: job.user_id,
  });

  try {
    const cfg = job.config ?? {};
    const headless = (cfg as { headless?: unknown }).headless !== false;

    const { data: linkRows, error: linksError } = await supabaseAdmin
      .from('yandex_maps_links')
      .select('link')
      .eq('job_id', jobId);

    if (linksError) throw new Error(linksError.message);

    const links = normalizeYandexOrgUrls((linkRows ?? []).map((r) => String((r as { link?: unknown }).link ?? '')).filter(Boolean));
    if (!links.length) {
      await setJobPatch(jobId, { status: 'failed', error_message: 'Нет ссылок организаций (сначала соберите ссылки)' });
      await trace?.fail(new Error('Missing links'));
      return;
    }

    const { data: existingOrgRows, error: existingOrgError } = await supabaseAdmin
      .from('yandex_maps_organizations')
      .select('card_url')
      .eq('job_id', jobId);
    if (existingOrgError) throw new Error(existingOrgError.message);

    const parsedCardUrls = new Set(
      (existingOrgRows ?? [])
        .map((row) => String((row as { card_url?: unknown }).card_url ?? '').trim())
        .filter(Boolean),
    );
    const remainingLinks = links.filter((link) => !parsedCardUrls.has(link));

    await setJobPatch(jobId, {
      status: 'running',
      progress_stage: 'parsing_organizations',
      started_at: job.started_at ?? new Date().toISOString(),
      processed_organizations: parsedCardUrls.size,
      total_organizations: links.length,
      error_message: null,
    });

    const serviceHealthy = await waitForYandexMapsHealth();
    if (!serviceHealthy) {
      const msg = 'Сервис yandexmaps недоступен (не поднялся за минуту). Проверьте, что контейнер yandexmaps запущен.';
      await setJobPatch(jobId, { status: 'failed', error_message: msg });
      await trace?.fail(new Error(msg));
      void logError('parser.yandexmaps.parse.health_failed', new Error(msg), { jobId }, logMeta);
      return;
    }

    const chunks = chunk(remainingLinks, 15);

    // Тот же фильтр по скорости, что и на сборе ссылок: карточки организаций
    // легче поисковой страницы, но через 2.7 КБ/с не грузятся и они.
    let activePool: ResolvedProxy[] | undefined;
    if (!job.proxy_enabled && getYandexMapsProxyPool().length > 0) {
      const probe = await probeProxyPool(jobId, logMeta);
      if (probe.checked && probe.filtered.length === 0) {
        const msg = slowProxyMessage(probe.report);
        await setJobPatch(jobId, {
          status: 'failed',
          error_message: msg,
          progress_stage: 'proxy_too_slow',
          processed_organizations: parsedCardUrls.size,
          completed_at: new Date().toISOString(),
        });
        await trace?.fail(new Error(msg));
        void logWarn('parser.yandexmaps.parse.proxy_too_slow', 'All proxies below speed threshold', { jobId, report: probe.report }, logMeta);
        return;
      }
      activePool = probe.checked ? probe.filtered : undefined;
    }

    const parseProxyPoolSize = job.proxy_enabled ? 1 : (activePool ?? getYandexMapsProxyPool()).length;
    void logInfo(
      'parser.yandexmaps.parse.start',
      'YandexMaps parse-orgs started',
      { jobId, totalLinks: links.length, alreadyParsed: parsedCardUrls.size, remaining: remainingLinks.length, proxyPoolSize: parseProxyPoolSize },
      logMeta,
    );

    // Лимит проксей, через которые пробуем тот же чанк если ловим yandex_blocked.
    // Даём +1 попытку сверху пула — вдруг первый попал под кратковременный бан,
    // но следующие уже норм. Максимум N попыток на чанк = пул + 1 запас.
    const maxProxyRetries = Math.max(1, parseProxyPoolSize) + 1;

    let processed = parsedCardUrls.size;
    let consecutiveBlockedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      const current = await getJob(jobId);
      if (current?.status === 'failed') {
        await trace?.cancel('Cancelled');
        return;
      }

      const part = chunks[i]!;
      const partSpan = await trace?.startChild({
        name: 'yandexmaps.parse_orgs.chunk',
        input: { chunk_index: i + 1, chunks_total: chunks.length, chunk_size: part.length },
        message: `Чанк ${i + 1}/${chunks.length}`,
      });

      // Ретраим тот же чанк через разные прокси — pickProxy сдвигает индекс
      // на attempt, каждая попытка идёт через следующий IP из пула. Если
      // все попробованные прокси заблокировались — тогда уже фейлим.
      let success = false;
      let lastBlockedError: YandexMapsBlockedError | null = null;
      for (let attempt = 0; attempt < maxProxyRetries; attempt++) {
        try {
          const res = await yandexMapsParseOrgs({ links: part, headless, proxy: pickProxy(job, i + attempt, activePool) });
          const orgs = res.organizations ?? [];
          const rows = orgs.map((o) => ({
            job_id: jobId,
            name: o.name || null,
            country: o.country || null,
            city: o.city || null,
            address: o.address || null,
            rating: o.rating || null,
            reviews_count: o.reviews_count || null,
            website: o.website || null,
            email: o.email || null,
            phone: o.phone || null,
            telegram: o.telegram || null,
            vk: o.vk || null,
            instagram: o.instagram || null,
            whatsapp: o.whatsapp || null,
            card_url: o.card_url || null,
            working_hours: o.working_hours || null,
            categories: o.categories || null,
          }));

          if (rows.length) {
            await supabaseAdmin.from('yandex_maps_organizations').upsert(rows, { onConflict: 'job_id,card_url' });
          }

          processed += rows.length;
          await setJobPatch(jobId, {
            processed_organizations: processed,
            progress_stage: `parsing_organizations:${i + 1}/${chunks.length}`,
          });

          await partSpan?.end({ parsed: orgs.length, processed_links: processed, proxy_retries: attempt });
          success = true;
          break;
        } catch (e) {
          if (e instanceof YandexMapsBlockedError) {
            lastBlockedError = e;
            void logWarn(
              'parser.yandexmaps.parse.chunk_blocked_retry',
              `Yandex заблокировал чанк ${i + 1}, пробуем следующий прокси`,
              { jobId, chunk: i + 1, attempt: attempt + 1, maxRetries: maxProxyRetries },
              logMeta,
            );
            continue;
          }
          // Не-блокировочная ошибка — не смысла ретраить, пропускаем чанк.
          void logWarn('parser.yandexmaps.parse.chunk_failed', 'Parse-orgs chunk failed', { jobId, chunk: i + 1, error: String(e) }, logMeta);
          await partSpan?.fail(e);
          break;
        }
      }

      if (success) {
        consecutiveBlockedChunks = 0;
      } else if (lastBlockedError) {
        // Все прокси в пуле не смогли пропарсить этот чанк.
        consecutiveBlockedChunks += 1;
        await partSpan?.fail(lastBlockedError);
        // Если 3 чанка подряд не проходят ни через один прокси — реально
        // Яндекс банит нас во всём пуле, задачу останавливаем.
        if (consecutiveBlockedChunks >= 3) {
          const totalOrgs = links.length;
          const msg =
            `Яндекс временно заблокировал наши прокси. ` +
            `Уже сохранено ${processed} из ${totalOrgs} организаций — они никуда не денутся. ` +
            `Подождите 15–20 минут (IP прокси меняются каждые 2 минуты) и нажмите «Продолжить парсинг» — работа возобновится с того же места.`;
          await setJobPatch(jobId, {
            status: 'failed',
            error_message: msg,
            progress_stage: 'yandex_blocked',
            processed_organizations: processed,
            completed_at: new Date().toISOString(),
          });
          void logWarn(
            'parser.yandexmaps.parse.blocked',
            'Yandex banned all proxies in pool',
            { jobId, chunk: i + 1, processed, poolSize: parseProxyPoolSize },
            logMeta,
          );
          await trace?.fail(lastBlockedError);
          return;
        }
        // Один-два чанка мимо — но остальные продолжаем.
      }
    }

    await setJobPatch(jobId, {
      status: 'completed',
      progress_stage: 'completed',
      completed_at: new Date().toISOString(),
      processed_organizations: processed,
    });
    await trace?.end({ processed_links: processed });
    void logInfo('parser.yandexmaps.parse.complete', 'YandexMaps parse-orgs completed', { jobId }, logMeta);
  } catch (e) {
    await setJobPatch(jobId, { status: 'failed', error_message: e instanceof Error ? e.message : 'Ошибка' });
    await trace?.fail(e);
    void logError('parser.yandexmaps.parse.failed', e, { jobId }, logMeta);
  }
}

