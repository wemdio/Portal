import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';
import { encryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getClientTariffUsage, isClientToolAccessAllowed, isAwaitingFirstPayment, TOOL_ACCESS_DENIED_MESSAGE, AWAITING_PAYMENT_MESSAGE } from '@/lib/tariffs';
import {
  CATALOG_INLINE_LIMIT,
  fillJobFromYandexMapsCatalog,
  normalizeYandexMapsCatalogFilters,
} from '@/lib/parsers/yandexMapsCatalog';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: jobs, error } = await supabase
    .from('yandex_maps_jobs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  try {
    const body = await req.json();
    const search_urls = Array.isArray(body?.search_urls) ? body.search_urls.filter((x: unknown) => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean) : [];
    const catalog_filters = normalizeYandexMapsCatalogFilters(body?.catalog_filters);
    if (!search_urls.length && !catalog_filters) return jsonError('Missing search URLs or catalog filters', 400);

    // Поиск по своей базе — один SELECT, а не тысячи заходов в Яндекс, поэтому
    // потолка выдачи у него нет вовсе: `null` означает «забрать всё, что
    // нашлось». Число приходит только из кабинета клиента, где объём списывается
    // с тарифа. У живого парсинга потолок остаётся — там каждая строка это заход
    // в выдачу Яндекса.
    const requested_max_results = Number(body?.max_results);
    const has_requested_max = Number.isFinite(requested_max_results) && requested_max_results > 0;
    const max_results: number | null = catalog_filters
      ? (has_requested_max ? Math.floor(requested_max_results) : null)
      : Math.max(1, Math.min(5000, has_requested_max ? Math.floor(requested_max_results) : 5000));
    const headless = body?.headless !== false;

    let effective_max_results = max_results;
    let tariffUsage: Awaited<ReturnType<typeof getClientTariffUsage>> | null = null;
    if (supabaseAdmin) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (profile?.role === 'client') {
        tariffUsage = await getClientTariffUsage(user.id);
        if (!isClientToolAccessAllowed(tariffUsage.status)) {
          return jsonError(TOOL_ACCESS_DENIED_MESSAGE, 403);
        }
        if (isAwaitingFirstPayment(tariffUsage)) {
          return jsonError(AWAITING_PAYMENT_MESSAGE, 403);
        }
        // «Забрать всё» — это про оператора. У клиента объём списывается с
        // тарифа, поэтому безлимит здесь превращается в остаток по тарифу, а не
        // в отсутствие потолка.
        if (effective_max_results === null) {
          effective_max_results = tariffUsage.usage.max_rows.remaining;
        }
        if (effective_max_results > tariffUsage.usage.max_rows.remaining) {
          return jsonError(
            `Осталось ${tariffUsage.usage.max_rows.remaining.toLocaleString('ru-RU')} запросов по вашему тарифу. Уменьшите максимум результатов.`,
            400,
          );
        }
      }
    }

    // Поиск по каталогу — один запрос к соседней таблице той же базы, и обычно
    // его быстрее выполнить прямо здесь, чем гонять через очередь. Но «здесь» —
    // это внутри HTTP-запроса, а Kong рвёт соединение через 60 секунд.
    //
    // Решаем по запрошенному объёму, ничего предварительно не считая: сбор
    // с `limit N` останавливается, набрав N строк, поэтому небольшое N всегда
    // быстрое. А когда потолка нет, объём заранее неизвестен — там может быть и
    // миллион организаций, и закладываться на HTTP-запрос нельзя.
    if (catalog_filters) {
      const inline = effective_max_results !== null && effective_max_results <= CATALOG_INLINE_LIMIT;

      if (!inline) {
        // Задача встаёт в очередь; воркер вызовет ту же функцию и допишет
        // результаты. Форма покажет её в истории как выполняющуюся. Воркер
        // ходит в Postgres напрямую, поэтому шестьдесят секунд шлюза его не
        // ограничивают — в отличие от нас здесь.
        const { data: queued, error: queueError } = await supabase
          .from('yandex_maps_jobs')
          .insert({
            user_id: user.id,
            status: 'pending',
            config: { search_urls: [], catalog_filters, max_results: effective_max_results, headless },
            progress_stage: 'pending',
          })
          .select()
          .single();
        if (queueError || !queued) throw new Error(queueError?.message || 'Failed to create job');
        return NextResponse.json({ job: queued, tariff_usage: tariffUsage, queued: true });
      }

      const { data: job, error } = await supabase
        .from('yandex_maps_jobs')
        .insert({
          user_id: user.id,
          status: 'running',
          config: { search_urls: [], catalog_filters, max_results: effective_max_results, headless },
          progress_stage: 'catalog_search',
          started_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error || !job) throw new Error(error?.message || 'Failed to create job');

      try {
        const filled = await fillJobFromYandexMapsCatalog(job.id, catalog_filters, effective_max_results);
        const { data: completed } = await supabase
          .from('yandex_maps_jobs')
          .update({
            status: 'completed',
            progress_stage: filled.organizations ? 'catalog_completed' : 'catalog_empty',
            completed_at: new Date().toISOString(),
            total_links: filled.links,
            processed_links: filled.links,
            total_organizations: filled.organizations,
            processed_organizations: filled.organizations,
            error_message: null,
          })
          .eq('id', job.id)
          .select()
          .single();
        return NextResponse.json({ job: completed ?? job, tariff_usage: tariffUsage });
      } catch (e) {
        // Задача остаётся в истории с причиной: молча удалять её хуже — человек
        // не поймёт, почему запуск исчез.
        const message = e instanceof Error ? e.message : 'Поиск по каталогу не удался';
        await supabase
          .from('yandex_maps_jobs')
          .update({ status: 'failed', error_message: message, completed_at: new Date().toISOString() })
          .eq('id', job.id);
        console.error('Yandex maps catalog search error:', e);
        return jsonError(message, 500);
      }
    }

    const proxy = body?.proxy ?? null;
    const proxy_enabled = Boolean(proxy?.enabled);
    const proxy_protocol = (proxy?.protocol ?? 'http') as string;
    const proxy_host = typeof proxy?.host === 'string' ? proxy.host.trim() : '';
    const proxy_port = typeof proxy?.port === 'string' || typeof proxy?.port === 'number' ? String(proxy.port).trim() : '';

    let proxy_credentials_encrypted: string | null = null;
    if (proxy_enabled && proxy?.username && proxy?.password) {
      const key = (process.env.YANDEXMAPS_PROXY_ENCRYPTION_KEY ?? '').trim();
      if (!key) return jsonError('Proxy encryption key not configured', 500);
      proxy_credentials_encrypted = encryptJsonAes256Gcm({ username: String(proxy.username), password: String(proxy.password) }, key);
    }

    const { data: job, error } = await supabase
      .from('yandex_maps_jobs')
      .insert({
        user_id: user.id,
        status: 'pending',
        config: { search_urls, catalog_filters, max_results: effective_max_results, headless },
        progress_stage: 'pending',
        proxy_enabled,
        proxy_protocol: proxy_enabled ? proxy_protocol : null,
        proxy_host: proxy_enabled ? proxy_host : null,
        proxy_port: proxy_enabled ? proxy_port : null,
        proxy_credentials_encrypted,
      })
      .select()
      .single();

    if (error || !job) throw new Error(error?.message || 'Failed to create job');
    return NextResponse.json({ job, tariff_usage: tariffUsage });
  } catch (e) {
    console.error('Create yandexmaps job error:', e);
    return jsonError('Internal Server Error', 500);
  }
}

