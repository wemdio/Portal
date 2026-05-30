/**
 * Auto-pipeline orchestrator.
 *
 * Раз в сутки cron-эндпоинт /api/cron/auto-hh-pipeline вызывает эту функцию
 * для каждого клиента, у которого profiles.auto_pipeline_enabled = true и
 * client_auto_pipeline_configs.enabled = true.
 *
 * Логика прогона:
 *
 *   1. Загрузить config + tariff остаток. Если квота исчерпана / тариф не
 *      active — записать пустой run со skip-причиной и выйти.
 *
 *   2. Через hhAutoParser.findNewHhEmployers получить работодателей с HH
 *      за последние N часов (config.hh_date_window_hours, default 24).
 *
 *   3. Дедуп против client_auto_pipeline_seen_employers: оставляем только
 *      hh_employer_id, которых нет в журнале для этого клиента.
 *
 *   4. Для каждого нового employer параллельно (concurrency 5):
 *        [a] scrapeEmails(siteUrl) → emails[]   — наша scrape-логика
 *        [b] fetchScoreForDomain(domain)        → { spf, score }
 *
 *   5. Роутинг (см. decideRoute):
 *        — нет email ИЛИ score=null              → status=skipped
 *        — score попал в bucket с пустой sequence → status=stored
 *          (сохраняем в seen_employers, но в Instantly не шлём)
 *        — score попал в bucket с непустой seq   → status=routed → группа i
 *        — не попал ни в один bucket              → status=skipped
 *
 *   6. Для каждой группы routed: appendLeadsToClientCampaign в кампанию
 *      bucket.instantly_campaign_id. Если у bucket нет campaign_id (не
 *      сделан bootstrap) — fail весь bucket с понятным сообщением.
 *
 *   7. Upsert каждого employer в seen_employers с финальным статусом.
 *
 *   8. Записать метрики в client_auto_pipeline_runs.
 *
 * Ошибки:
 *   - Ошибка одного employer (scrape/endpoint) → status=skipped, прогон
 *     продолжается.
 *   - Ошибка одного bucket (appendLeads) → всех в этом bucket пометить
 *     status=failed, остальные buckets продолжают.
 *   - Фатальная ошибка (нет config / нет супабейза) → run.status=failed.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { findNewHhEmployers, deriveDomain, type HhEmployer } from './hhAutoParser';
import { fetchScoreForDomain } from './clientEndpointClient';
import { getOrFetchScore, emptyCacheStats } from './mailganerScoreCache';
import { validateEmailForAutoPipeline, type AutoPipelineEmailValidation } from './autoPipelineEmailValidation';
import { calcPacing } from './autoPipelinePacing';
import { fetchTopUpFromBaseOfBases } from './baseOfBasesSource';
import { fetchTopUpFromCache } from './baseOfBasesFromCache';
import { cleanCompanyNames } from '@/lib/companyNameCleanupBatch';
import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import type { ClientLaunchSequence } from '@/lib/clientLaunch/types';
import type { LeadCreatePayload } from '@/lib/instantly/types';

// ── Types ────────────────────────────────────────────────────────────────

export interface ScoreBucket {
  /** Stable id within the config (uuid). Used to mark seen_employers. */
  id: string;
  /** Human label for UI/audit. */
  label: string;
  /** Inclusive min score. */
  score_min: number;
  /** Inclusive max. null = no upper bound. */
  score_max: number | null;
  /** Instantly campaign id created via bootstrap. null = bucket not yet bootstrapped. */
  instantly_campaign_id: string | null;
  /** Sequence used when the bucket gets bootstrapped. */
  sequence: ClientLaunchSequence;
}

export interface AutoPipelineConfig {
  id: string;
  client_user_id: string;
  enabled: boolean;
  /**
   * Dry-run mode. Когда true — оркестратор делает enrichment (HH + scoring +
   * email scrape + validation), но НЕ создаёт лидов в Instantly и не требует
   * чтобы bucket'ы были bootstrap'нуты. Используется для измерения «воронки»
   * перед запуском реальной рассылки.
   */
  dry_run: boolean;
  endpoint_url: string | null;
  endpoint_api_key: string | null;
  endpoint_auth_scheme: string | null;
  endpoint_timeout_ms: number;
  score_buckets: ScoreBucket[];
  daily_limit: number | null;
  hh_date_window_hours: number;
  hh_extra_exclude_patterns: string[];
  /**
   * HH top-level industry id'ы для itrate отдельными запросами. Пустой массив —
   * один общий запрос без industry-фильтра (старое поведение). 30 индустрий
   * → +10-15× уникальных компаний в дневной выборке.
   */
  industries: string[];
  /**
   * Добирать недостающие компании из «базы баз» (companies_directory) когда HH
   * дал меньше чем daily_target_employers. Это путь к стабильным 670 ready/день
   * (~20k/мес).
   */
  base_of_bases_enabled: boolean;
  /** Минимальный годовой оборот компании для top-up из BoB. В рублях. */
  base_of_bases_revenue_from: number;
  /**
   * Разрешить live-добор из «базы баз» прямо в cron-прогоне (легаси-путь:
   * берём сырые домены и скорим их Mailganer'ом на лету). По умолчанию ВЫКЛ.
   *
   * Зачем выкл: ~94.6% доменов базы получают score=0 (нет SPF) → их НЕ
   * скрейпят, но они раздувают new_count и жгут Mailganer-вызовы. Фоновый
   * скорер теперь наполняет кэш активными доменами 24/7, а cron берёт
   * готовые score>0 из кэша (fetchTopUpFromCache). Live-путь оставлен как
   * аварийный fallback под флагом.
   */
  base_of_bases_live_fallback?: boolean;
  /**
   * Целевое количество компаний на enrichment. HH парсит сколько может, BoB
   * добирает до этого числа. При конверсии 6.3% (parsed → ready) 10 000 target
   * даёт ~630 ready/день ≈ 19k/мес.
   */
  daily_target_employers: number;
  last_run_at: string | null;
  /**
   * Распределение нагрузки. 'burst' — старый поведение (один прогон ~35 мин).
   * 'nightly' — растягиваем enrichment на окно [parse_window_start_utc..end].
   * 'continuous' — резерв.
   */
  parse_pacing: 'burst' | 'nightly' | 'continuous';
  parse_window_start_utc: number;
  parse_window_end_utc: number;
}

export interface AutoPipelineRunResult {
  runId: string;
  status: 'completed' | 'failed';
  parsed: number;
  new: number;
  /** Сколько HH employers имели site_url (без сайта Mailganer/scrape невозможны). */
  withSite: number;
  /** Сколько успешно получили score от Mailganer endpoint. */
  withScore: number;
  /** Сколько успешно отскрейпили хотя бы один email. */
  withEmail: number;
  /** Сколько прошли DNS+MX+SMTP-валидацию. Это «готовые контакты». */
  emailValid: number;
  routed: number;
  stored: number;
  skipped: number;
  failed: number;
  wasDryRun: boolean;
  error?: string;
}

// ── Built-in excludes ────────────────────────────────────────────────────
//
// Жирные федеральные бренды, которым нельзя слать холодные письма ни одному
// клиенту. Можно расширить через config.hh_extra_exclude_patterns.

const BUILT_IN_EXCLUDE_PATTERNS: RegExp[] = [
  /сбер/i, /тинькофф/i, /т-банк/i, /альфа.?банк/i, /втб/i, /газпром/i,
  /яндекс/i, /мтс\b/i, /мегафон/i, /билайн/i, /ростелеком/i,
  /магнит/i, /пятёрочка|пятерочка/i, /x5|перекр(е|ё)сток/i,
  /wildberries/i, /ozon\b/i, /авито|avito/i,
];

export function buildExcludePatterns(extras: string[]): RegExp[] {
  const compiled = [...BUILT_IN_EXCLUDE_PATTERNS];
  for (const raw of extras) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    try {
      compiled.push(new RegExp(trimmed, 'i'));
    } catch {
      // Невалидный regex — игнорируем, не падаем.
    }
  }
  return compiled;
}

// ── DB helpers ───────────────────────────────────────────────────────────

async function loadConfig(clientUserId: string): Promise<AutoPipelineConfig | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('*')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  if (error || !data) return null;
  return data as AutoPipelineConfig;
}

async function loadSeenEmployerIds(clientUserId: string): Promise<Set<string>> {
  if (!supabaseAdmin) return new Set();
  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select('hh_employer_id')
    .eq('client_user_id', clientUserId);
  if (error || !data) return new Set();
  return new Set(data.map((r) => (r as { hh_employer_id: string }).hh_employer_id));
}

/**
 * Domain-set всех уже виденных компаний — для dedup top-up из BoB. HH-парсер
 * dedup'ится по hh_employer_id (числовой), BoB-домены другие. Поэтому BoB
 * нуждается в separate domain-based dedup.
 */
async function loadSeenDomains(clientUserId: string): Promise<Set<string>> {
  if (!supabaseAdmin) return new Set();
  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select('domain')
    .eq('client_user_id', clientUserId)
    // dry-run прогоны НЕ «жгут» кэш: их домены не попадают в дедуп, чтобы
    // боевой запуск (или повторный замер) мог их обработать заново. В дедуп
    // идут только реально обработанные (routed/stored/skipped/failed).
    .neq('status', 'dry_run')
    .not('domain', 'is', null);
  if (error || !data) return new Set();
  const set = new Set<string>();
  for (const r of data) {
    const d = (r as { domain: string | null }).domain;
    if (d) set.add(d.toLowerCase());
  }
  return set;
}

/**
 * Закрывает «протухшие» running-прогоны клиента перед стартом нового.
 *
 * Зачем: если прогон убили на полпути (редеплой пересоздал контейнер, OOM,
 * SIGKILL) — finishRunRow не вызывается, и запись навечно висит в running.
 * Дашборд тогда видит «сейчас идёт прогон» от мёртвого процесса, а сами
 * zombie засоряют журнал.
 *
 * Burst-прогон укладывается в ~2 часа, поэтому порог 4 часа гарантированно
 * не заденет легитимный текущий прогон, но поймает любой брошенный.
 * Вызывается в начале runAutoPipelineForClient (до startRunRow).
 */
async function closeStaleRuns(clientUserId: string, maxAgeHours = 4): Promise<void> {
  if (!supabaseAdmin) return;
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from('client_auto_pipeline_runs')
    .update({
      status: 'failed',
      error_message: 'stale — auto-closed (процесс был прерван, finishRunRow не вызван)',
      finished_at: new Date().toISOString(),
    })
    .eq('client_user_id', clientUserId)
    .eq('status', 'running')
    .lt('started_at', cutoff);
}

/**
 * Результат попытки начать прогон.
 *   started        — создали running-запись, можно работать.
 *   already_running — у клиента уже есть активный (не протухший) прогон;
 *                     это НЕ ошибка — параллельный запуск (крон + ручной),
 *                     просто пропускаем (lock через partial unique index).
 *   error          — не смогли создать запись (БД недоступна и т.п.).
 */
type StartRunResult =
  | { kind: 'started'; runId: string }
  | { kind: 'already_running' }
  | { kind: 'error' };

async function startRunRow(clientUserId: string): Promise<StartRunResult> {
  if (!supabaseAdmin) return { kind: 'error' };
  // Сначала подчищаем брошенные running-записи — чтобы дашборд не показывал
  // вечный «идёт прогон» от убитого процесса И чтобы lock ниже не считал
  // зомби активным прогоном.
  await closeStaleRuns(clientUserId);
  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_runs')
    .insert({ client_user_id: clientUserId, status: 'running' })
    .select('id')
    .single();
  if (error) {
    // 23505 = unique_violation: partial unique index (client_user_id) WHERE
    // status='running' не дал вставить вторую running-запись → уже идёт
    // прогон этого клиента. Атомарный lock — гонки check-then-insert нет.
    if ((error as { code?: string }).code === '23505') return { kind: 'already_running' };
    return { kind: 'error' };
  }
  if (!data) return { kind: 'error' };
  return { kind: 'started', runId: (data as { id: string }).id };
}

async function finishRunRow(runId: string, patch: Record<string, unknown>): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('client_auto_pipeline_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', runId);
}

async function updateConfigLastRun(
  clientUserId: string,
  status: 'completed' | 'failed',
): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      updated_at: new Date().toISOString(),
    })
    .eq('client_user_id', clientUserId);
}

// ── Enrichment ───────────────────────────────────────────────────────────

/**
 * Сколько адресов берём с одного домена → столько лидов на компанию.
 * Клиент выбрал «до 2»: если на сайте несколько почт, берём 2 (напр. info@
 * + sales@). Скрейпер в среднем находит ~3/домен, остальные отбрасываем.
 */
const MAX_EMAILS_PER_DOMAIN = 2;

export interface EnrichmentResult {
  employer: HhEmployer;
  domain: string | null;
  /** Первичный адрес (первый найденный) — пишется в seen как resolved_email. */
  email: string | null;
  /** Результат DNS+MX+SMTP-валидации первичного email. null если email не нашли. */
  emailValidation: AutoPipelineEmailValidation | null;
  /**
   * Доп. адреса свыше первого (до MAX_EMAILS_PER_DOMAIN-1 штук). Каждый
   * становится отдельным лидом в той же кампании. Пусто, если найден ≤1 адрес.
   */
  additionalEmails: { address: string; validation: AutoPipelineEmailValidation | null }[];
  score: number | null;
  spf: string | null;
  endpointRaw: Record<string, unknown> | null;
  enrichError: string | null;
}

/**
 * Параллельно по списку employer'ов: для каждого делаем scrapeEmails + endpoint.
 * Возвращает массив в том же порядке, что и вход.
 */
async function enrichEmployers(
  employers: HhEmployer[],
  endpointBase: { url: string; apiKey: string; authScheme: string; timeoutMs: number },
  /**
   * Bucket'ы клиента — нужны чтобы решить, делать ли scrape+SMTP для каждого
   * employer'а после получения score. Пустой массив = свежий клиент в dry-run,
   * fallback на score>0.
   */
  scoreBuckets: ScoreBucket[],
  concurrency = 5,
  /**
   * Пауза в миллисекундах ПОСЛЕ обогащения каждого employer'а (внутри worker).
   * При burst-режиме = 0. При nightly — autoPipelinePacing.calcPacing решает
   * сколько именно, чтобы прогон вписался в окно [start..end] UTC.
   */
  perItemPauseMs = 0,
  /**
   * Per-domain кэш статистика (передаётся снаружи чтобы вернуть hit-rate
   * в финальный лог прогона).
   */
  mailganerStats?: import('./mailganerScoreCache').MailganerCacheStats,
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = new Array(employers.length);
  let cursor = 0;
  // Shared MX cache по всему прогону — domains часто повторяются между
  // employers одного score-bucket'а, не хотим резолвить MX для google.com
  // несколько раз.
  const domainCache = new Map<string, import('@/lib/emailValidation/shared').DomainInfo>();

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= employers.length) return;
      const emp = employers[i];
      const domain = deriveDomain(emp.siteUrl);
      try {
        // Шаг 1: получаем score. Сначала смотрим в БД-кэш — если домен
        // скорили в любом прошлом прогоне, возьмём оттуда мгновенно (один
        // SELECT, ~5ms). Если нет — getOrFetchScore сам дёрнет Mailganer и
        // сохранит результат для следующих прогонов.
        const endpoint = domain
          ? await getOrFetchScore(
              domain,
              {
                url: endpointBase.url,
                apiKey: endpointBase.apiKey,
                authScheme: endpointBase.authScheme,
                timeoutMs: endpointBase.timeoutMs,
              },
              'cron',
              mailganerStats,
            )
          : { score: null, spf: null, raw: null, ok: false as const, error: 'no domain' as const };

        // Шаг 2: scrape + SMTP — только если employer попал бы в активный
        // bucket (с непустой sequence). Иначе всё равно пойдёт в `stored`
        // или `skipped`, и email нам не нужен.
        let email: string | null = null;
        let emailValidation: AutoPipelineEmailValidation | null = null;
        const additionalEmails: { address: string; validation: AutoPipelineEmailValidation | null }[] = [];
        if (shouldDoEmailWork(endpoint.score, scoreBuckets) && emp.siteUrl) {
          const scrape = await scrapeEmails(emp.siteUrl, {
            timeout: 12_000,
            maxPages: 5,
          }).catch(() => ({ emails: [] as string[] }));
          // Берём до MAX_EMAILS_PER_DOMAIN адресов — первый primary, остальные
          // как доп. лиды. Валидируем каждый (domainCache переиспользует MX).
          const candidates = scrape.emails.slice(0, MAX_EMAILS_PER_DOMAIN);
          for (let c = 0; c < candidates.length; c++) {
            const validation = await validateEmailForAutoPipeline(candidates[c], domainCache);
            if (c === 0) {
              email = candidates[0];
              emailValidation = validation;
            } else {
              additionalEmails.push({ address: candidates[c], validation });
            }
          }
        }

        results[i] = {
          employer: emp,
          domain,
          email,
          emailValidation,
          additionalEmails,
          score: endpoint.score,
          spf: endpoint.spf,
          endpointRaw: endpoint.raw,
          enrichError: endpoint.ok ? null : (endpoint.error ?? 'endpoint failed'),
        };
      } catch (err) {
        results[i] = {
          employer: emp,
          domain,
          email: null,
          emailValidation: null,
          additionalEmails: [],
          score: null,
          spf: null,
          endpointRaw: null,
          enrichError: err instanceof Error ? err.message : 'enrich error',
        };
      }
      // Nightly-pacing: каждый worker spit'нул один item — паузим, чтобы
      // распределить общий поток по окну [start..end] UTC. При burst=0 этот
      // sleep no-op.
      if (perItemPauseMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, perItemPauseMs));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, employers.length) }, worker),
  );
  return results;
}

// ── Routing ──────────────────────────────────────────────────────────────

export type RoutingDecision =
  | { kind: 'routed'; bucket: ScoreBucket }
  | { kind: 'stored'; bucket: ScoreBucket }
  | { kind: 'skipped'; reason: string };

/**
 * Решает, что делать с обогащённым employer'ом.
 *
 * Правила:
 *   1. Нет email или score=null → skipped.
 *   2. Score попал в bucket с пустой sequence → stored (лида сохраняем
 *      в seen_employers, но в Instantly не отправляем). Это «не пишем»-режим
 *      для диапазонов, где клиент решил не писать (например, score ≤ 1000).
 *   3. Score попал в bucket с непустой sequence → routed.
 *   4. Не попал ни в один bucket → skipped с reason='score_out_of_buckets'.
 *
 * Соответствие диапазона: score_min ≤ score ≤ score_max (или ≥ score_min,
 * если score_max=null — означает «и выше»).
 */
/**
 * Стоит ли тратить scrape+SMTP-валидацию на employer'а с этим score?
 *
 * Раньше enrichment делал scrape+endpoint параллельно для ВСЕХ 815 employers —
 * включая 684 со score=0, которые всё равно пойдут в `stored` без отправки.
 * Это растягивало прогон до 38 минут (scrape медленный, 12s timeout на сайт)
 * и съедало 80% бюджета SMTP-проверок впустую.
 *
 * Теперь сначала вызываем Mailganer (~1s), и scrape+SMTP делаем ТОЛЬКО если
 * employer попал бы в bucket с непустой sequence. Score=0 / out-of-buckets /
 * storage-only — пропускаем дальше, не теряя время на email.
 *
 * Edge case — buckets ещё не настроены (свежий клиент в dry-run): fallback
 * на «score > 0 значит интересно», чтобы первые замеры воронки имели смысл
 * без необходимости заранее настраивать sequence'ы.
 */
export function shouldDoEmailWork(
  score: number | null,
  buckets: ScoreBucket[],
): boolean {
  if (score === null) return false;
  if (buckets.length === 0) {
    // Fallback для свежего клиента без настроенных bucket'ов — считаем
    // что score > 0 = «потенциально активный» (это и есть наш дефолтный
    // critерий, который Mailganer как раз использует для определения 0).
    return score > 0;
  }
  for (const bucket of buckets) {
    const inRange =
      score >= bucket.score_min &&
      (bucket.score_max === null || score <= bucket.score_max);
    if (!inRange) continue;
    return Array.isArray(bucket.sequence?.steps) && bucket.sequence.steps.length > 0;
  }
  return false;
}

export function decideRoute(
  enrichment: EnrichmentResult,
  config: Pick<AutoPipelineConfig, 'score_buckets'>,
): RoutingDecision {
  if (!enrichment.email) return { kind: 'skipped', reason: 'no_email' };
  if (enrichment.score === null) {
    return { kind: 'skipped', reason: enrichment.enrichError || 'no_score' };
  }
  for (const bucket of config.score_buckets) {
    const inRange =
      enrichment.score >= bucket.score_min &&
      (bucket.score_max === null || enrichment.score <= bucket.score_max);
    if (!inRange) continue;
    const hasSteps =
      Array.isArray(bucket.sequence?.steps) && bucket.sequence.steps.length > 0;
    return hasSteps ? { kind: 'routed', bucket } : { kind: 'stored', bucket };
  }
  return { kind: 'skipped', reason: 'score_out_of_buckets' };
}

// ── Seen employers upsert ────────────────────────────────────────────────

interface SeenEmployerUpsert {
  client_user_id: string;
  hh_employer_id: string;
  hh_employer_name: string;
  domain: string | null;
  site_url: string | null;
  endpoint_score: number | null;
  endpoint_spf: string | null;
  endpoint_raw: Record<string, unknown> | null;
  resolved_email: string | null;
  /** Что нашёл scraper. Может отличаться от resolved_email если в будущем
   *  добавим post-processing (выбор лучшего из нескольких найденных). */
  email_found: string | null;
  email_validation_status: string | null;
  email_validation_details: Record<string, unknown> | null;
  routed_bucket_id: string | null;
  routed_campaign_id: string | null;
  status: 'routed' | 'stored' | 'skipped' | 'failed' | 'dry_run';
  /** Какой источник дал нам этого employer'а — для аналитики «эффект BoB». */
  source: 'hh' | 'base_of_bases';
  skip_reason: string | null;
  error_message: string | null;
  processed_at: string;
}

/** Источник employer'а по id-префиксу. BoB-id мы выпускаем как «bob:<inn>». */
function detectSource(employerId: string): 'hh' | 'base_of_bases' {
  return employerId.startsWith('bob:') ? 'base_of_bases' : 'hh';
}

async function upsertSeenEmployers(rows: SeenEmployerUpsert[]): Promise<void> {
  if (!supabaseAdmin || rows.length === 0) return;
  // Чанками по 500, чтобы не упереться в payload limit.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await supabaseAdmin
      .from('client_auto_pipeline_seen_employers')
      .upsert(slice, { onConflict: 'client_user_id,hh_employer_id' });
  }
}

/**
 * Помечает уже записанные seen-строки bucket'а как failed.
 *
 * При батчевой обработке seen-строки upsert'ятся со status='routed' ПО ЧАНКАМ,
 * до того как leads реально отправлены в Instantly. Если append лидов в
 * кампанию падает — нужно откатить статус этих строк на 'failed' прямо в БД
 * (массива в памяти уже нет). Матчим по routed_bucket_id + processed_at
 * (метка текущего прогона), чтобы не задеть строки прошлых прогонов.
 */
async function markRoutedBucketFailed(
  clientUserId: string,
  bucketId: string,
  processedAt: string,
  errorMessage: string,
): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .update({ status: 'failed', error_message: errorMessage })
    .eq('client_user_id', clientUserId)
    .eq('routed_bucket_id', bucketId)
    .eq('processed_at', processedAt)
    .eq('status', 'routed');
}

// ── Main entry ───────────────────────────────────────────────────────────

export async function runAutoPipelineForClient(
  clientUserId: string,
): Promise<AutoPipelineRunResult> {
  const logCtx = { clientUserId };
  const emptyResult = (
    runId: string,
    error?: string,
  ): AutoPipelineRunResult => ({
    runId,
    status: error ? 'failed' : 'completed',
    parsed: 0,
    new: 0,
    withSite: 0,
    withScore: 0,
    withEmail: 0,
    emailValid: 0,
    routed: 0,
    stored: 0,
    skipped: 0,
    failed: 0,
    wasDryRun: false,
    error,
  });

  // 0. Start run row early — фиксируем сам факт прогона. Lock: если у клиента
  //    уже идёт прогон (крон + ручной запуск пересеклись), пропускаем —
  //    параллельные прогоны конкурируют за HH/scrape/Mailganer и тормозят
  //    друг друга.
  const start = await startRunRow(clientUserId);
  if (start.kind === 'already_running') {
    await logAudit(
      'auto-pipeline.skip.concurrent',
      'Пропуск: у клиента уже идёт активный прогон (lock)',
      logCtx,
    );
    return emptyResult('');
  }
  if (start.kind === 'error') {
    await logError('auto-pipeline.run_row.failed', null, logCtx);
    return { ...emptyResult(''), status: 'failed', error: 'Не удалось создать запись прогона' };
  }
  const runId = start.runId;

  try {
    // 1. Конфиг.
    const config = await loadConfig(clientUserId);
    if (!config || !config.enabled) {
      await finishRunRow(runId, { status: 'failed', error_message: 'Config disabled' });
      return { ...emptyResult(runId), status: 'failed', error: 'Config disabled' };
    }
    if (!config.endpoint_url) {
      await finishRunRow(runId, { status: 'failed', error_message: 'No endpoint configured' });
      return { ...emptyResult(runId), status: 'failed', error: 'No endpoint configured' };
    }
    // Фиксируем was_dry_run в run row сразу после загрузки конфига, не дожидаясь
    // finishRunRow — иначе при обрыве (timeout, crash) zombie row висит со
    // status='running' и was_dry_run=false, что обманывает дашборд («какой
    // режим был у прерванного прогона?»).
    if (supabaseAdmin) {
      await supabaseAdmin
        .from('client_auto_pipeline_runs')
        .update({ was_dry_run: config.dry_run })
        .eq('id', runId);
    }
    // В dry-run режиме bucket'ы вообще не обязательны — мы делаем замер
    // воронки (HH → score → email → validate), но не роутим лидов в кампании.
    // Поэтому пропускаем оба check'а ниже.
    if (!config.dry_run) {
      if (!Array.isArray(config.score_buckets) || config.score_buckets.length === 0) {
        await finishRunRow(runId, { status: 'failed', error_message: 'No score buckets configured' });
        return { ...emptyResult(runId), status: 'failed', error: 'No score buckets configured' };
      }

      // Проверка: все ли buckets bootstrap'нуты в Instantly.
      const unbootstrappedBuckets = config.score_buckets.filter((b) => !b.instantly_campaign_id);
      if (unbootstrappedBuckets.length > 0) {
        const msg = `Buckets без instantly_campaign_id: ${unbootstrappedBuckets
          .map((b) => b.label)
          .join(', ')}`;
        await finishRunRow(runId, { status: 'failed', error_message: msg });
        return { ...emptyResult(runId), status: 'failed', error: msg };
      }
    }

    // 2. HH parse.
    const since = new Date(Date.now() - config.hh_date_window_hours * 60 * 60 * 1000);
    const excludePatterns = buildExcludePatterns(config.hh_extra_exclude_patterns ?? []);

    const employers = await findNewHhEmployers({
      since,
      excludePatterns,
      // Если в конфиге заданы industries — делаем по запросу на каждую (даёт
      // ×10-15 объём выборки). Пустой массив = один общий запрос (legacy
      // поведение). Парсер сам обрабатывает оба случая через единый
      // queries-loop.
      industries: config.industries.length > 0 ? config.industries : undefined,
      limit: config.daily_limit ?? 1000,
      log: (m) => void logAudit('auto-pipeline.hh', m, logCtx),
    });

    // 3. Дедуп HH-результатов по hh_employer_id.
    const seen = await loadSeenEmployerIds(clientUserId);
    const freshFromHh = employers.filter((e) => !seen.has(e.id));

    await logAudit(
      'auto-pipeline.parsed',
      'Parsed HH employers',
      { ...logCtx, parsed: employers.length, new: freshFromHh.length, seen: seen.size },
    );

    // 3.5. Top-up из «базы баз», если HH дал меньше daily_target_employers.
    //      BoB-domain ≠ HH employer.id, поэтому dedup-set для BoB — отдельный,
    //      по domain. Кроме исторических seen-domains добавляем домены
    //      сегодняшних HH-результатов, чтобы один и тот же сайт не попал
    //      и из HH, и из BoB в одном прогоне.
    let fresh: HhEmployer[] = freshFromHh;
    if (
      config.base_of_bases_enabled &&
      freshFromHh.length < config.daily_target_employers
    ) {
      const seenDomains = await loadSeenDomains(clientUserId);
      for (const e of freshFromHh) {
        const d = deriveDomain(e.siteUrl);
        if (d) seenDomains.add(d);
      }
      const neededFromBob = config.daily_target_employers - freshFromHh.length;

      // 1. Сначала пробуем взять готовые активные домены из кэша
      //    (mailganer_domain_scores). Они уже scored через background
      //    scorer → ни одного Mailganer-вызова в cron'е. Сильно экономит
      //    время прогона (с 2.5h до 10-15 мин когда кэш покрывает большую
      //    часть BoB).
      const cacheResult = await fetchTopUpFromCache({
        neededCount: neededFromBob,
        seenDomains,
        excludePatterns,
        log: (m) => void logAudit('auto-pipeline.bob-cache', m, logCtx),
      });

      // 2. Если кэш не дал достаточно — ТОЛЬКО при включённом флаге
      //    base_of_bases_live_fallback идём в прямой BoB. По умолчанию ВЫКЛ:
      //    этот путь тянет сырые домены, ~94.6% из которых score=0 (их не
      //    скрейпят) — они лишь раздувают new_count и жгут Mailganer-вызовы.
      //    Фоновый скорер наполняет кэш активными доменами 24/7, поэтому cron
      //    полагается на кэш, а не доскоривает сырьё на лету.
      const stillNeeded = neededFromBob - cacheResult.employers.length;
      let bobLiveResult: Awaited<ReturnType<typeof fetchTopUpFromBaseOfBases>> | null = null;
      if (config.base_of_bases_live_fallback === true && stillNeeded > 0) {
        bobLiveResult = await fetchTopUpFromBaseOfBases({
          neededCount: stillNeeded,
          revenueFrom: config.base_of_bases_revenue_from,
          seenDomains,
          excludePatterns,
          log: (m) => void logAudit('auto-pipeline.bob-live', m, logCtx),
        });
      }

      fresh = [
        ...freshFromHh,
        ...cacheResult.employers,
        ...(bobLiveResult?.employers ?? []),
      ];

      await logAudit(
        'auto-pipeline.top-up.bob',
        'Topped up from base of bases (cache + live)',
        {
          ...logCtx,
          hhCount: freshFromHh.length,
          bobFromCache: cacheResult.employers.length,
          bobFromLive: bobLiveResult?.employers.length ?? 0,
          cacheScanned: cacheResult.scanned,
          bobLiveScanned: bobLiveResult?.scanned ?? 0,
          totalFresh: fresh.length,
        },
      );
    }

    if (fresh.length === 0) {
      await finishRunRow(runId, {
        status: 'completed',
        parsed_count: employers.length,
        new_count: 0,
      });
      await updateConfigLastRun(clientUserId, 'completed');
      return { ...emptyResult(runId), parsed: employers.length };
    }

    // 4. Pacing — nightly растягивает enrichment на окно [start..end] UTC,
    //    burst прогоняет прямо сейчас.
    const ENRICH_CONCURRENCY = 5;
    const pacing = calcPacing({
      pacing: config.parse_pacing,
      window: {
        startHourUtc: config.parse_window_start_utc,
        endHourUtc: config.parse_window_end_utc,
      },
      itemCount: fresh.length,
      concurrency: ENRICH_CONCURRENCY,
    });
    if (!pacing.inWindow) {
      // Cron запустили вне окна (например, ручной debug-вызов в полдень).
      // Не парсим — иначе размажемся на 23 часа до следующего конца окна.
      await logAudit(
        'auto-pipeline.skip.outside_window',
        'Outside nightly window — skipping enrichment',
        {
          ...logCtx,
          pacing: config.parse_pacing,
          windowStart: config.parse_window_start_utc,
          windowEnd: config.parse_window_end_utc,
        },
      );
      await finishRunRow(runId, { ...emptyResult(runId), parsed: employers.length, status: 'completed' });
      await updateConfigLastRun(clientUserId, 'completed');
      return { ...emptyResult(runId), parsed: employers.length };
    }
    if (pacing.perItemPauseMs > 0) {
      await logAudit(
        'auto-pipeline.pacing.nightly',
        `Nightly pacing: ${pacing.perItemPauseMs}ms per item, finishes ~${pacing.windowEndsAt}`,
        { ...logCtx, perItemPauseMs: pacing.perItemPauseMs, windowEndsAt: pacing.windowEndsAt },
      );
    }

    // 5. Enrich + route + upsert БАТЧАМИ по CHUNK_SIZE.
    //
    // Раньше держали все ~11k EnrichmentResult + ~11k SeenUpsert в памяти
    // разом до финального bulk-upsert'а → OOM (SIGKILL 137) на больших
    // прогонах (employer-объекты + endpoint_raw JSON + scrape-результаты +
    // MX-cache). Теперь обрабатываем чанками: enrich → route → upsert seen →
    // следующий чанк (ссылки выходят из scope, GC освобождает). В памяти
    // одновременно максимум 1 чанк + накопленный groupedLeads (только routed —
    // их кратно меньше, в dry-run вообще пусто).
    const mailganerStats = emptyCacheStats();
    const groupedLeads = new Map<string, { bucket: ScoreBucket; leads: LeadCreatePayload[] }>();
    const now = new Date().toISOString();

    let routedCount = 0;
    let storedCount = 0;
    let skippedCount = 0;
    let withSiteCount = 0;
    let withScoreCount = 0;
    let withEmailCount = 0;
    let emailValidCount = 0;

    const CHUNK_SIZE = 500;
    for (let chunkStart = 0; chunkStart < fresh.length; chunkStart += CHUNK_SIZE) {
      const chunk = fresh.slice(chunkStart, chunkStart + CHUNK_SIZE);

      const enrichments = await enrichEmployers(
        chunk,
        {
          url: config.endpoint_url,
          apiKey: config.endpoint_api_key ?? '',
          authScheme: config.endpoint_auth_scheme ?? 'Bearer',
          timeoutMs: config.endpoint_timeout_ms,
        },
        config.score_buckets,
        ENRICH_CONCURRENCY,
        pacing.perItemPauseMs,
        mailganerStats,
      );

      const seenUpserts: SeenEmployerUpsert[] = [];

      for (const enr of enrichments) {
        // Воронка — считаем по каждому enrichment независимо от routing'а.
        if (enr.employer.siteUrl) withSiteCount++;
        if (enr.score !== null) withScoreCount++;
        if (enr.email) withEmailCount++;
        // «Готовых контактов» = валидные адреса (до 2 на домен), т.к. каждый
        // станет отдельным лидом. with_email остаётся «доменов с ≥1 почтой».
        if (enr.emailValidation?.isValid) emailValidCount++;
        for (const extra of enr.additionalEmails) {
          if (extra.validation?.isValid) emailValidCount++;
        }

        const decision = decideRoute(enr, config);
        const base: Omit<SeenEmployerUpsert, 'status' | 'skip_reason' | 'error_message' | 'routed_bucket_id' | 'routed_campaign_id'> = {
          client_user_id: clientUserId,
          hh_employer_id: enr.employer.id,
          hh_employer_name: enr.employer.name,
          domain: enr.domain,
          site_url: enr.employer.siteUrl,
          endpoint_score: enr.score,
          endpoint_spf: enr.spf,
          endpoint_raw: enr.endpointRaw,
          resolved_email: enr.email,
          email_found: enr.email,
          email_validation_status: enr.emailValidation?.status ?? null,
          email_validation_details: enr.emailValidation?.details ?? null,
          source: detectSource(enr.employer.id),
          processed_at: now,
        };

        // Dry-run shortcut — пишем всё как 'dry_run' и не идём ни в routing,
        // ни в Instantly. Это даёт «измерительный» прогон без побочных эффектов.
        if (config.dry_run) {
          seenUpserts.push({
            ...base,
            status: 'dry_run',
            skip_reason: null,
            error_message: null,
            routed_bucket_id: null,
            routed_campaign_id: null,
          });
          continue;
        }

        if (decision.kind === 'skipped') {
          seenUpserts.push({
            ...base,
            status: 'skipped',
            skip_reason: decision.reason,
            error_message: null,
            routed_bucket_id: null,
            routed_campaign_id: null,
          });
          skippedCount++;
        } else if (decision.kind === 'stored') {
          // Stored = score попал в bucket, но bucket с пустой sequence
          // (клиент решил не отправлять). Записываем routed_bucket_id, чтобы
          // в журнале было видно — попал в этот диапазон, просто не отправили.
          seenUpserts.push({
            ...base,
            status: 'stored',
            skip_reason: null,
            error_message: null,
            routed_bucket_id: decision.bucket.id,
            routed_campaign_id: null,
          });
          storedCount++;
        } else {
          const bucket = decision.bucket;
          const customVars = {
            hh_employer_id: enr.employer.id,
            hh_url: enr.employer.hhUrl ?? '',
            score: String(enr.score),
            spf: enr.spf ?? '',
          };
          // До MAX_EMAILS_PER_DOMAIN лидов на компанию: primary + доп. адреса
          // (напр. info@ и sales@) — отдельными лидами в той же кампании.
          const leadEmails = [enr.email!, ...enr.additionalEmails.map((a) => a.address)];

          let group = groupedLeads.get(bucket.id);
          if (!group) {
            group = { bucket, leads: [] };
            groupedLeads.set(bucket.id, group);
          }
          for (const addr of leadEmails) {
            group.leads.push({
              email: addr,
              company_name: enr.employer.name,
              website: enr.employer.siteUrl ?? undefined,
              custom_variables: customVars,
            });
          }

          // seen — одна строка на домен (resolved_email = primary). Статус
          // routed фиксируем ПОСЛЕ успешного append. routedCount считает
          // ЛИДЫ (адреса), а не домены — это «добавлено в работу».
          seenUpserts.push({
            ...base,
            status: 'routed',
            skip_reason: null,
            error_message: null,
            routed_bucket_id: bucket.id,
            routed_campaign_id: bucket.instantly_campaign_id,
          });
          routedCount += leadEmails.length;
        }
      } // конец for (enr of enrichments)

      // Upsert seen ЭТОГО чанка сразу — освобождаем память перед следующим.
      // chunk + enrichments + seenUpserts выходят из scope на следующей
      // итерации, GC их собирает. Это и есть фикс OOM.
      await upsertSeenEmployers(seenUpserts);
    } // конец for (chunkStart) — chunk loop

    await logAudit(
      'auto-pipeline.mailganer-cache',
      `Mailganer cache: ${mailganerStats.hits} hits, ${mailganerStats.misses} misses, ${mailganerStats.errors} errors`,
      { ...logCtx, ...mailganerStats },
    );

    // 5.5. Чистка названий routed-лидов — ТЕМ ЖЕ AI, что кнопка «Очистить
    //      названия» (cleanCompanyNames → stepNameCleanup, батчи по 100).
    //      В dry-run groupedLeads пуст — шаг сам собой пропускается.
    const leadsToClean = [...groupedLeads.values()].flatMap((g) => g.leads);
    if (leadsToClean.length > 0) {
      const cleanedNames = await cleanCompanyNames(
        leadsToClean.map((l) => ({ name: l.company_name, domain: l.website })),
      );
      leadsToClean.forEach((l, i) => {
        if (cleanedNames[i]) l.company_name = cleanedNames[i];
      });
      await logAudit('auto-pipeline.names-cleaned', `Очищено названий лидов: ${leadsToClean.length}`, logCtx);
    }

    // 6. Append leads per bucket. В dry-run шаг пропускаем целиком —
    // groupedLeads пуст (routing-блок делает continue ещё ДО groupedLeads.set).
    // Финальная гарантия полей: у КАЖДОГО лида должны быть email + название +
    // сайт. Неполные отбрасываем с логом — в Instantly не уходят.
    let failedCount = 0;
    let droppedIncomplete = 0;
    for (const group of groupedLeads.values()) {
      const readyLeads = group.leads.filter((l) => l.email && l.company_name && l.website);
      droppedIncomplete += group.leads.length - readyLeads.length;
      if (readyLeads.length === 0) continue;
      try {
        await appendLeadsToClientCampaign({
          userId: clientUserId,
          campaignId: group.bucket.instantly_campaign_id!,
          leads: readyLeads,
          contextLabel: group.bucket.label,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'append failed';
        await logError(
          'auto-pipeline.append.failed',
          err,
          { ...logCtx, bucket: group.bucket.label, leadCount: readyLeads.length },
        );
        // seen уже записаны по чанкам со status='routed' — обновляем их в БД
        // на 'failed' (массива seenUpserts в памяти больше нет).
        await markRoutedBucketFailed(clientUserId, group.bucket.id, now, msg.slice(0, 500));
        failedCount += readyLeads.length;
        routedCount -= readyLeads.length;
      }
    }
    if (droppedIncomplete > 0) {
      routedCount -= droppedIncomplete;
      await logAudit(
        'auto-pipeline.dropped-incomplete',
        `Отброшено неполных лидов (нет email/названия/сайта): ${droppedIncomplete}`,
        logCtx,
      );
    }

    // Разбивка new_count по источникам — для дашборда (HH vs база баз).
    // BoB-employers имеют id с префиксом 'bob:' (см. detectSource).
    const newFromBob = fresh.filter((e) => detectSource(e.id) === 'base_of_bases').length;
    const newFromHh = fresh.length - newFromBob;

    // 8. Finalize run row.
    await finishRunRow(runId, {
      status: 'completed',
      parsed_count: employers.length,
      new_count: fresh.length,
      new_from_hh: newFromHh,
      new_from_bob: newFromBob,
      with_site: withSiteCount,
      with_score: withScoreCount,
      with_email: withEmailCount,
      email_valid: emailValidCount,
      routed_count: routedCount,
      stored_count: storedCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      was_dry_run: config.dry_run,
    });
    await updateConfigLastRun(clientUserId, 'completed');

    await logAudit(
      'auto-pipeline.completed',
      'Auto pipeline run completed',
      {
        ...logCtx,
        runId,
        dryRun: config.dry_run,
        parsed: employers.length,
        new: fresh.length,
        withSite: withSiteCount,
        withScore: withScoreCount,
        withEmail: withEmailCount,
        emailValid: emailValidCount,
        routed: routedCount,
        stored: storedCount,
        skipped: skippedCount,
        failed: failedCount,
      },
    );

    return {
      runId,
      status: 'completed',
      parsed: employers.length,
      new: fresh.length,
      withSite: withSiteCount,
      withScore: withScoreCount,
      withEmail: withEmailCount,
      emailValid: emailValidCount,
      routed: routedCount,
      stored: storedCount,
      skipped: skippedCount,
      failed: failedCount,
      wasDryRun: config.dry_run,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    await logError('auto-pipeline.fatal', err, logCtx);
    await finishRunRow(runId, { status: 'failed', error_message: msg.slice(0, 500) });
    await updateConfigLastRun(clientUserId, 'failed');
    return { ...emptyResult(runId), status: 'failed', error: msg };
  }
}
