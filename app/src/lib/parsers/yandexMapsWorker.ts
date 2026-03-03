import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo, logWarn } from '@/lib/loggerServer';
import { decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { normalizeYandexOrgUrls } from '@/lib/parsers/yandexMapsUrlUtils';
import { yandexMapsCollectLinks, yandexMapsHealth, yandexMapsParseOrgs } from '@/lib/parsers/yandexMapsServiceClient';
import { startTrace } from '@/lib/tracer';

type ProxyCreds = { username: string; password: string };

type YandexMapsJobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: unknown;
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

async function setJobPatch(jobId: string, patch: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from('yandex_maps_jobs').update(patch).eq('id', jobId);
}

async function getJob(jobId: string) {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('yandex_maps_jobs')
    .select('id,user_id,status,config,started_at,proxy_enabled,proxy_protocol,proxy_host,proxy_port,proxy_credentials_encrypted')
    .eq('id', jobId)
    .single();
  return (data ?? null) as YandexMapsJobRow | null;
}

function buildProxy(job: YandexMapsJobRow): { enabled: boolean; protocol: 'http' | 'https' | 'socks5'; host: string; port: string; username?: string; password?: string } {
  if (!job.proxy_enabled) return { enabled: false, protocol: 'http', host: '', port: '' };

  const protocol = (job.proxy_protocol ?? 'http') as 'http' | 'https' | 'socks5';
  const proxy: { enabled: boolean; protocol: 'http' | 'https' | 'socks5'; host: string; port: string; username?: string; password?: string } = {
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
    await setJobPatch(jobId, {
      status: 'running',
      progress_stage: 'collecting_links',
      started_at: job.started_at ?? new Date().toISOString(),
      processed_links: 0,
      total_links: 0,
      error_message: null,
    });

    await supabaseAdmin.from('yandex_maps_links').delete().eq('job_id', jobId);
    await supabaseAdmin.from('yandex_maps_organizations').delete().eq('job_id', jobId);

    const cfg = (job.config && typeof job.config === 'object') ? (job.config as Record<string, unknown>) : {};
    const searchUrls = Array.isArray((cfg as { search_urls?: unknown }).search_urls)
      ? ((cfg as { search_urls: unknown[] }).search_urls.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))
      : [];
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

    const serviceHealthy = await yandexMapsHealth();
    if (!serviceHealthy) {
      const msg = 'Сервис yandexmaps недоступен (health check failed). Проверьте, что контейнер yandexmaps запущен.';
      await setJobPatch(jobId, { status: 'failed', error_message: msg });
      await trace?.fail(new Error(msg));
      void logError('parser.yandexmaps.collect.health_failed', new Error(msg), { jobId }, logMeta);
      return;
    }

    void logInfo('parser.yandexmaps.collect.start', 'YandexMaps collect-links started', { jobId, searchUrlsCount: searchUrls.length }, logMeta);

    let allLinks: string[] = [];
    let urlIndex = 0;
    for (const search_url of searchUrls) {
      urlIndex += 1;
      const current = await getJob(jobId);
      if (current?.status === 'failed') {
        await trace?.cancel('Cancelled');
        return;
      }

      const urlSpan = await trace?.startChild({
        name: 'yandexmaps.collect_links.url',
        input: { search_url, index: urlIndex, total: searchUrls.length, max_results: maxResults },
        message: `URL ${urlIndex}/${searchUrls.length}`,
      });

      try {
        const res = await yandexMapsCollectLinks({
          search_url,
          max_results: maxResults,
          headless,
          proxy: buildProxy(job),
        });
        const newLinks = res.links ?? [];
        allLinks = normalizeYandexOrgUrls([...allLinks, ...newLinks]);

        if (newLinks.length > 0) {
          const rows = allLinks.map((link) => ({ job_id: jobId, link }));
          await supabaseAdmin.from('yandex_maps_links').upsert(rows, { onConflict: 'job_id,link' });
        }

        await setJobPatch(jobId, {
          total_links: allLinks.length,
          processed_links: allLinks.length,
          progress_stage: `collecting_links:${urlIndex}/${searchUrls.length}`,
        });
        await urlSpan?.end({ links_collected: newLinks.length, total_unique: allLinks.length });
      } catch (e) {
        await urlSpan?.fail(e);
        void logWarn('parser.yandexmaps.collect.url_failed', 'Collect-links failed for URL', { jobId, search_url }, logMeta);
      }
    }

    await setJobPatch(jobId, {
      total_links: allLinks.length,
      processed_links: allLinks.length,
      progress_stage: 'links_collected',
    });

    await trace?.end({ total_unique_links: allLinks.length });
    void logInfo('parser.yandexmaps.collect.complete', 'YandexMaps collect-links completed', { jobId, totalLinks: allLinks.length }, logMeta);

    if (allLinks.length > 0) {
      void logInfo('parser.yandexmaps.auto_parse', 'Auto-starting parse after collect', { jobId, totalLinks: allLinks.length }, logMeta);
      await runYandexMapsParseOrganizations(jobId);
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
    await setJobPatch(jobId, {
      status: 'running',
      progress_stage: 'parsing_organizations',
      started_at: job.started_at ?? new Date().toISOString(),
      processed_organizations: 0,
      total_organizations: 0,
      error_message: null,
    });

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

    const serviceHealthy = await yandexMapsHealth();
    if (!serviceHealthy) {
      const msg = 'Сервис yandexmaps недоступен (health check failed). Проверьте, что контейнер yandexmaps запущен.';
      await setJobPatch(jobId, { status: 'failed', error_message: msg });
      await trace?.fail(new Error(msg));
      void logError('parser.yandexmaps.parse.health_failed', new Error(msg), { jobId }, logMeta);
      return;
    }

    const chunks = chunk(links, 15);
    await setJobPatch(jobId, { total_organizations: links.length });

    void logInfo('parser.yandexmaps.parse.start', 'YandexMaps parse-orgs started', { jobId, totalLinks: links.length }, logMeta);

    let processed = 0;
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

      try {
        const res = await yandexMapsParseOrgs({ links: part, headless, proxy: buildProxy(job) });
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

        processed += part.length;
        await setJobPatch(jobId, {
          processed_organizations: processed,
          progress_stage: `parsing_organizations:${i + 1}/${chunks.length}`,
        });

        await partSpan?.end({ parsed: orgs.length, processed_links: processed });
      } catch (e) {
        await partSpan?.fail(e);
        void logWarn('parser.yandexmaps.parse.chunk_failed', 'Parse-orgs chunk failed', { jobId, chunk: i + 1 }, logMeta);
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

