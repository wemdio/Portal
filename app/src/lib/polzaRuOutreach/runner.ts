/**
 * Раннер «Нашего автоаутрича» (parser_type='polza_ru_outreach').
 *
 * Поток (RU_OUTREACH_HANDOFF §6): компания из источников → AMO и стоп-лист →
 * сайт и сигналы → тип цепочки → кейс → скоринг → почта → 4 письма → QA → выгрузка.
 *
 * Волна идёт в две фазы — это и есть pre-LPR rerank CEO:
 *  1. все кандидаты волны проходят проверки, разбор сайта и скоринг;
 *  2. почту ищем только у прошедших порог, начиная с самых сильных, и
 *     останавливаемся, как только набрано заказанное число готовых компаний.
 *
 * Отсеянная строка остаётся в журнале с этапом, кодом и пояснением — по ним
 * считается воронка. Ошибка одной строки не валит запуск.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { analyzeVacancy, findOutboundMarker, type VacancyAnalysis } from './analyze';
import { collectCandidates, type Candidate } from './collect';
import { companyBrand, isSuppressed, loadPreviouslyExported, normalizeDomain, siteUrl, type ExportedIndex } from './company';
import { findRuCompanyEmail } from './findEmail';
import { buildChain, buildSegmentsHypothesis, openingSentence, type ChainInput } from './letters/chains';
import type { LetterContext } from './letters/common';
import { loadLibraries, type CaseRecord } from './libraries';
import { runQa } from './qa';
import { decide, routeCase, routeChain, scoreCompany, type Route, type Score } from './router';
import { amoLookup, loadAmoIndex, type AmoIndex, type AmoRecord } from './sources/amo';
import { loadSizeByInn } from './sources/directory';
import { fetchEmployerSite, fetchVacancyCard } from './sources/hhCard';
import { analyzeSite, EMPTY_SITE, type SiteAnalysis } from './sources/siteSignals';
import {
  sanitizeRuOutreachConfig,
  STAGES,
  TEMPLATE_VERSION,
  type RuOutreachConfig,
  type Signal,
  type Stage,
} from './types';

const ENRICH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.POLZA_RU_OUTREACH_CONCURRENCY ?? '4')));
const EMAIL_CONCURRENCY = 4;
const MIN_WAVE = 20;
const MAX_WAVE = 200;
const BLIND_YIELD_GUESS = 0.08;
const DB_CHUNK = 100;
const DAY = 86_400_000;
const LEADERSHIP_TITLE = /(руководител\S* отдела продаж|(^|[^а-яё])роп([^а-яё]|$)|коммерческ\S* директор|директор по продажам|head of sales)/i;

class CancelledError extends Error {}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[polza-ru-outreach][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

export function maxCandidatesFor(target: number): number {
  return Math.min(5000, Math.max(300, target * 40));
}

export function nextWaveSize(target: number, totals: { scanned: number; ready: number }): number {
  const missing = Math.max(1, target - totals.ready);
  const rate = totals.scanned > 0 && totals.ready > 0 ? totals.ready / totals.scanned : BLIND_YIELD_GUESS;
  return Math.max(MIN_WAVE, Math.min(MAX_WAVE, Math.ceil(missing / Math.max(0.02, rate))));
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await worker(item);
      }
    }),
  );
}

interface Rejection {
  stage: Stage;
  status: 'rejected' | 'manual_review' | 'failed';
  reason: string;
  detail?: string;
}

/** Всё, что известно о компании после фазы 1. */
interface Qualified {
  id: string;
  candidate: Candidate;
  domain: string;
  website: string;
  brand: string;
  amo: AmoRecord | null;
  site: SiteAnalysis;
  vacancy: VacancyAnalysis | null;
  signals: Signal[];
  route: Route;
  caseHit: { record: CaseRecord; reason: string } | null;
  score: Score;
  marketQuote: string | null;
}

export async function runRuOutreachJob(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    log('error', 'supabaseAdmin not configured');
    return;
  }

  const setProgress = async (patch: Record<string, unknown>) => {
    const { error } = await db.from('parser_jobs').update(patch).eq('id', jobId);
    if (error) log('warn', `progress update failed for ${jobId}`, error);
  };
  const ensureNotCancelled = async () => {
    const { data } = await db.from('parser_jobs').select('status').eq('id', jobId).single();
    if (!data || data.status !== 'running') throw new CancelledError();
  };
  const updateRow = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await db
      .from('polza_ru_outreach_companies')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) log('warn', `row update failed (${id})`, error);
  };

  try {
    const { data: job, error: jobErr } = await db.from('parser_jobs').select('config').eq('id', jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');
    const config: RuOutreachConfig = sanitizeRuOutreachConfig((job.config ?? {}) as Partial<RuOutreachConfig>);
    const target = config.limit;
    const maxScan = maxCandidatesFor(target);

    await setProgress({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'loading_sources',
      progress_percent: 1,
      total_found: 0,
      total_parsed: 0,
    });
    // Повтор после падения воркера — с чистого журнала, иначе дубли в воронке.
    await db.from('polza_ru_outreach_companies').delete().eq('job_id', jobId);

    const libraries = await loadLibraries(db, config.sender_id);
    if (!libraries.sender) throw new Error('Нет активной подписи отправителя — добавьте её во вкладке «Библиотеки»');
    const sender = libraries.sender;
    const amo: AmoIndex = await loadAmoIndex(db);
    const exported: ExportedIndex = config.include_previously_exported
      ? { domains: new Set(), inns: new Set() }
      : await loadPreviouslyExported(db, jobId);
    const pool = await collectCandidates(db, config, amo, maxScan);
    log('info', `job ${jobId}: pool=${pool.length}, target=${target}, sources=${config.sources.join(',')}`);

    const funnel = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    const reasons: Record<string, number> = {};
    const chains: Record<string, number> = {};
    const totals = { scanned: 0, ready: 0 };
    const seenDomains = new Set<string>();
    const seenInns = new Set<string>();
    let cursor = 0;
    let waveNo = 0;
    let processed = 0;

    const publish = async (stage: string, extra: Record<string, unknown> = {}) => {
      await setProgress({
        progress_stage: stage,
        progress_percent: Math.min(97, 3 + Math.round(94 * Math.max(totals.ready / target, Math.min(1, totals.scanned / maxScan)))),
        total_found: totals.scanned,
        total_parsed: totals.ready,
        progress_detail: { wave: waveNo, target, pool: pool.length, scanned: totals.scanned, ready: totals.ready, funnel, reasons, chains, offer_version: libraries.offerVersion, ...extra },
      });
    };
    const reach = (...stages: Stage[]) => {
      for (const s of stages) funnel[s] += 1;
    };
    const finish = async (id: string, r: Rejection, patch: Record<string, unknown> = {}) => {
      reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      await updateRow(id, { ...patch, row_status: r.status, pipeline_stage: r.stage, reason_code: r.reason, reason_detail: r.detail ?? null });
    };

    // ── Фаза 1: проверки, сайт, сигналы, цепочка, скоринг ──
    const qualify = async (id: string, c: Candidate, size: Map<string, { revenue: number | null; employees: number | null }>): Promise<Qualified | null> => {
      reach('candidates_loaded');
      const amoByInn = c.inn ? amoLookup(amo, null, c.inn) : null;
      if (amoByInn && (amoByInn.status === 'open_deal' || amoByInn.status === 'client')) {
        await finish(id, { stage: 'amo_checked', status: 'rejected', reason: amoByInn.status === 'client' ? 'AMO_CLIENT' : 'AMO_OPEN_DEAL', detail: amoByInn.statusName }, { amo_status: amoByInn.status });
        return null;
      }

      // Вакансии hh: живая карточка и цитата функции продаж.
      let vacancy: VacancyAnalysis | null = null;
      const signals: Signal[] = [...c.signals];
      let employerIdFromCard: string | null = null;
      if (c.vacancies.length) {
        for (const ref of c.vacancies.slice(0, 2)) {
          const res = await fetchVacancyCard(ref.vacancy_id);
          if (!res.ok || res.card.archived || res.card.descriptionText.length < 200) continue;
          const published = res.card.publishedAt ? new Date(res.card.publishedAt).getTime() : NaN;
          if (Number.isFinite(published) && published < Date.now() - config.freshness_days * DAY) continue;
          vacancy = await analyzeVacancy({ title: res.card.title, description: res.card.descriptionText, companyName: c.companyName });
          if (vacancy.excludedCategory === 'recruitment_agency' || vacancy.excludedCategory === 'leadgen_competitor') {
            await finish(id, { stage: 'enriched', status: 'rejected', reason: 'EXCLUDED_CATEGORY', detail: vacancy.excludedCategory });
            return null;
          }
          const quote = vacancy.sdrQuote ?? findOutboundMarker(`${res.card.title}\n${res.card.descriptionText}`);
          const strong = Boolean(quote) || Boolean(vacancy.marketQuote) || LEADERSHIP_TITLE.test(res.card.title) || c.vacancyCount >= 2;
          if (strong && vacancy.excludedCategory !== 'inbound_retail_only') {
            signals.push({ type: 'sales_hiring', source: 'hh', title: res.card.title, date: res.card.publishedAt, url: res.card.url, quote: quote ?? null, level: quote ? 'A' : 'B', meta: { vacancy_count: c.vacancyCount } });
          }
          if (res.card.employerId && !c.hhEmployerId) employerIdFromCard = res.card.employerId;
          break;
        }
      }
      reach('amo_checked');

      // Домен.
      let website = c.website;
      let domain = normalizeDomain(website);
      const employerId = c.hhEmployerId ?? employerIdFromCard;
      if (!domain && employerId) {
        website = await fetchEmployerSite(employerId);
        domain = normalizeDomain(website);
      }
      if (!domain) {
        await finish(id, { stage: 'company_resolved', status: 'rejected', reason: 'DOMAIN_NOT_FOUND' }, { signals });
        return null;
      }
      const site_url = website && /^https?:\/\//i.test(website) ? website : siteUrl(domain);
      await updateRow(id, { normalized_domain: domain, company_website: site_url, pipeline_stage: 'company_resolved' });

      // AMO по домену: клиент, открытая сделка, свежий отказ — не пишем.
      const amoRec = amoLookup(amo, domain, c.inn) ?? c.amo;
      if (amoRec && amoRec.status !== 'lost' && amoRec.status !== 'none') {
        const reason = amoRec.status === 'client' ? 'AMO_CLIENT' : amoRec.status === 'open_deal' ? 'AMO_OPEN_DEAL' : 'CRM_RECENT_CONTACT';
        await finish(id, { stage: 'amo_checked', status: 'rejected', reason, detail: amoRec.statusName }, { amo_status: amoRec.status });
        return null;
      }
      reach('company_resolved');

      if (seenDomains.has(domain) || (c.inn && seenInns.has(c.inn))) {
        await finish(id, { stage: 'deduplicated', status: 'rejected', reason: 'DUPLICATE_COMPANY' });
        return null;
      }
      seenDomains.add(domain);
      if (c.inn) seenInns.add(c.inn);
      if (exported.domains.has(domain) || (c.inn && exported.inns.has(c.inn))) {
        await finish(id, { stage: 'deduplicated', status: 'rejected', reason: 'PREVIOUSLY_EXPORTED' });
        return null;
      }
      reach('deduplicated');

      // Сайт: один обход, один разбор.
      const site = await analyzeSite(site_url).catch((err) => {
        log('warn', `site analysis failed for ${domain}`, err instanceof Error ? err.message : err);
        return EMPTY_SITE;
      });
      if (!site.reachable) {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'SITE_UNREACHABLE', detail: site_url }, { signals });
        return null;
      }
      if (site.excludedCategory) {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: site.excludedCategory === 'b2c_only' ? 'NOT_B2B' : 'EXCLUDED_CATEGORY', detail: site.excludedCategory });
        return null;
      }
      const since = Date.now() - config.freshness_days * DAY;
      for (const f of site.facts) {
        const standing = f.type === 'partner_program' || f.type === 'dealer_search';
        if (standing || (f.date && new Date(f.date).getTime() >= since)) signals.push(f);
      }
      const isB2b = site.isB2b || Boolean(vacancy?.isB2b && vacancy.b2bQuote) || signals.some((s) => s.type === 'contract_won' || s.type === 'trade_show_exhibitor');
      if (!isB2b || vacancy?.excludedCategory === 'b2c_only') {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'NOT_B2B' }, { signals, ta_score: site.taScore, ta_reason: site.taReason });
        return null;
      }
      // Бренд: у кандидата из Директа есть только домен — название берём со страницы.
      const onlyDomainName = c.companyName === domain;
      const brand = site.brand ?? (onlyDomainName ? null : companyBrand(c.companyName));
      if (!brand) {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'COMPANY_AMBIGUOUS' }, { signals });
        return null;
      }
      reach('enriched');

      const reactivation = Boolean(amoRec && amoRec.status === 'lost' && amoRec.priorContact);
      const route = routeChain({ signals, reactivation, taScore: site.taScore });
      const marketQuote = vacancy?.marketQuote ?? site.customerQuote ?? null;
      const known = c.inn ? size.get(c.inn) : undefined;
      const base = {
        company_brand: brand,
        signals,
        amo_status: amoRec?.status ?? 'none',
        prior_contact: reactivation,
        prior_contact_date: reactivation ? amoRec?.lastContactAt ?? null : null,
        ta_score: site.taScore,
        ta_reason: site.taReason,
        market_evidence_quote: marketQuote,
        target_market: vacancy?.targetMarket ?? null,
        fit_reasons: [
          ...(site.b2bQuote ? [`B2B: «${site.b2bQuote}»`] : []),
          ...(site.productSummary ? [`Продукт: ${site.productSummary}`] : []),
          ...(site.industryGroup ? [`Отрасль: ${site.industryGroup}`] : []),
          ...(site.hasAdPixel ? ['На сайте стоят рекламные счётчики'] : []),
        ],
      };
      if (!route) {
        await finish(id, { stage: 'scored', status: 'rejected', reason: 'NO_CHAIN', detail: `ЦА ${site.taScore}/10` }, base);
        return null;
      }
      const caseHit = routeCase(libraries.cases, site.industryGroup, route.chain);
      const score = scoreCompany({
        chain: route.chain,
        primary: route.primary,
        freshnessDays: config.freshness_days,
        taScore: site.taScore,
        isB2b,
        revenue: c.revenue ?? known?.revenue ?? null,
        employees: c.employees ?? known?.employees ?? null,
        hasAdPixel: site.hasAdPixel,
        siteReachable: true,
        hasCase: Boolean(caseHit),
        // Скоринг до поиска почты — оптимистичный: почту ищем только у прошедших.
        emailFound: true,
      });
      chains[route.chain] = (chains[route.chain] ?? 0) + 1;
      const p = route.primary;
      const patch = {
        ...base,
        chain_type: route.chain,
        signal_type: p?.type ?? null,
        signal_date: p?.date ?? null,
        signal_title: p?.title ?? null,
        source_url: p?.url ?? c.sourceUrls[0] ?? null,
        evidence_quote: p?.quote ?? null,
        evidence_level: p ? p.level : 'NONE',
        generation_mode: route.chain,
        case_id: caseHit?.record.case_id ?? null,
        case_match_reason: caseHit?.reason ?? null,
        priority_score: score.total,
        signal_score: score.total,
        fit_reasons: [...base.fit_reasons, `Скоринг: ${Object.entries(score.parts).map(([k, v]) => `${k}=${v}`).join(', ')}`],
      };
      const decision = decide(score.total, config.write_threshold);
      if (decision === 'skip') {
        await finish(id, { stage: 'scored', status: 'rejected', reason: 'SCORE_TOO_LOW', detail: `${score.total}/100` }, patch);
        return null;
      }
      await updateRow(id, { ...patch, pipeline_stage: 'scored' });
      reach('scored');
      return { id, candidate: c, domain, website: site_url, brand, amo: amoRec, site, vacancy, signals, route, caseHit, score, marketQuote };
    };

    // ── Фаза 2: почта, письма, QA ──
    const finalize = async (q: Qualified) => {
      if (totals.ready >= target) {
        await updateRow(q.id, { row_status: 'manual_review', reason_code: 'LIMIT_REACHED', reason_detail: 'лимит готовых компаний уже набран' });
        return;
      }
      const email = q.route.chain === 'reactivation' && q.amo?.contactEmail
        ? { email: q.amo.contactEmail, emailType: 'person' as const, isRouting: false, recipientRole: 'Контакт из AMO', sourceUrl: null }
        : await findRuCompanyEmail(q.website, q.domain);
      if (!email.email) {
        await finish(q.id, { stage: 'recipient_resolved', status: 'rejected', reason: 'EMAIL_NOT_FOUND' });
        return;
      }
      if (await isSuppressed(db, email.email)) {
        await finish(q.id, { stage: 'recipient_resolved', status: 'rejected', reason: 'SUPPRESSED_CONTACT', detail: email.email });
        return;
      }
      await updateRow(q.id, {
        recipient_email: email.email,
        email_type: email.emailType,
        email_verification: q.route.chain === 'reactivation' && q.amo?.contactEmail ? 'crm_contact' : 'found_on_site',
        email_source_url: email.sourceUrl,
        recipient_role: email.recipientRole,
        is_routing: email.isRouting,
        pipeline_stage: 'recipient_resolved',
      });
      reach('recipient_resolved');

      const chainInput: ChainInput = {
        chain: q.route.chain,
        signal: q.route.primary,
        priorContact: q.route.chain === 'reactivation',
        marketQuote: q.marketQuote,
        productSummary: q.site.productSummary,
      };
      const letterCtx: LetterContext = {
        brand: q.brand,
        sender,
        isRouting: email.isRouting,
        caseRecord: q.caseHit?.record ?? null,
        claims: libraries.claims.filter((cl) => cl.chain_type === 'all' || cl.chain_type === q.route.chain),
      };
      const hypothesis = !q.caseHit && q.marketQuote
        ? await buildSegmentsHypothesis({ brand: q.brand, productSummary: q.site.productSummary, marketQuote: q.marketQuote }).catch(() => null)
        : null;
      const chain = buildChain(letterCtx, chainInput, hypothesis);
      reach('sequence_assembled');

      const opening = openingSentence(chainInput, q.brand);
      const usedClaims = libraries.claims.filter((cl) => chain.claimIds.includes(cl.id));
      const qa = runQa({
        letters: chain.letters,
        amoStatus: q.amo?.status ?? null,
        sender,
        priorContact: chainInput.priorContact,
        caseText: q.caseHit?.record.case_text_short.trim() ?? null,
        claimTexts: usedClaims.map((cl) => cl.claim_text),
        allowedFacts: [
          q.brand,
          ...(opening ? [opening] : []),
          ...q.signals.flatMap((s) => [s.title, s.quote ?? '']).filter(Boolean),
          ...(q.marketQuote ? [q.marketQuote] : []),
        ],
        targetMarket: q.vacancy?.targetMarket ?? null,
        marketQuote: q.marketQuote,
        recipientEmail: email.email,
      });
      const base = {
        letters: chain.letters,
        subject_b: chain.subjectB,
        case_id: chain.caseId,
        campaign_hypothesis: chain.campaignHypothesis,
        offer_version: libraries.offerVersion,
        offer_claim_ids: chain.claimIds,
        sender_id: sender.id,
        template_version: TEMPLATE_VERSION,
        qa_status: qa.status,
        qa_flags: qa.flags,
      };
      if (qa.status !== 'passed') {
        const reason = qa.flags.some((f) => f.includes('placeholder'))
          ? 'QA_PLACEHOLDER_LEFT'
          : qa.flags.some((f) => /unsupported|false_prior|market_without/.test(f))
            ? 'QA_FACT_UNSUPPORTED'
            : 'QA_FAILED';
        await finish(q.id, { stage: 'qa_checked', status: 'manual_review', reason, detail: qa.flags.join('; ') }, base);
        return;
      }
      reach('qa_checked');
      if (totals.ready >= target) {
        await updateRow(q.id, { ...base, row_status: 'manual_review', pipeline_stage: 'qa_checked', reason_code: 'LIMIT_REACHED', reason_detail: 'лимит готовых компаний уже набран' });
        return;
      }
      totals.ready += 1;
      reach('ready');
      await updateRow(q.id, { ...base, row_status: 'ready', pipeline_stage: 'ready', reason_code: null, reason_detail: null });
    };

    const safe = async (id: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        reasons.PROCESSING_ERROR = (reasons.PROCESSING_ERROR ?? 0) + 1;
        await updateRow(id, { row_status: 'failed', reason_code: 'PROCESSING_ERROR', reason_detail: err instanceof Error ? err.message.slice(0, 500) : String(err) });
      } finally {
        processed += 1;
        if (processed % 5 === 0) await publish('processing');
      }
    };

    while (totals.ready < target && totals.scanned < maxScan && cursor < pool.length) {
      await ensureNotCancelled();
      waveNo += 1;
      const want = Math.min(nextWaveSize(target, totals), maxScan - totals.scanned);
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;

      const ids: string[] = [];
      for (let i = 0; i < wave.length; i += DB_CHUNK) {
        const chunk = wave.slice(i, i + DB_CHUNK);
        const { data, error } = await db
          .from('polza_ru_outreach_companies')
          .insert(
            chunk.map((c) => ({
              job_id: jobId,
              source_type: c.sources.join('+'),
              source_record_id: c.sourceRecordId,
              source_url: c.sourceUrls[0] ?? null,
              source_urls: c.sourceUrls,
              company_name: c.companyName,
              inn: c.inn,
              hh_employer_id: c.hhEmployerId,
              crm_lead_id: c.amo?.amoId ?? null,
              signals: c.signals,
              row_status: 'processing',
              pipeline_stage: 'candidates_loaded',
            })),
          )
          .select('id');
        if (error) throw new Error(`journal insert failed: ${error.message}`);
        for (const r of data ?? []) ids.push(String(r.id));
      }
      totals.scanned += wave.length;
      const size = await loadSizeByInn(db, wave.map((c) => c.inn).filter((x): x is string => Boolean(x)));
      await publish('enriching', { wave_size: wave.length });
      log('info', `wave ${waveNo}: ${wave.length} candidates (ready ${totals.ready}/${target})`);

      const qualified: Qualified[] = [];
      await runPool(wave.map((c, i) => ({ c, id: ids[i] })).filter((x) => x.id), ENRICH_CONCURRENCY, async ({ c, id }) => {
        await ensureNotCancelled();
        await safe(id, async () => {
          const q = await qualify(id, c, size);
          if (q) qualified.push(q);
        });
      });

      // Pre-LPR rerank: почту ищем от самых сильных к слабым.
      qualified.sort((a, b) => b.score.total - a.score.total);
      await publish('finding_emails', { qualified: qualified.length });
      await runPool(qualified, EMAIL_CONCURRENCY, async (q) => {
        await ensureNotCancelled();
        await safe(q.id, () => finalize(q));
      });
    }

    const stopReason = totals.ready >= target ? 'target_reached' : cursor >= pool.length ? 'pool_exhausted' : 'scan_limit';
    log('info', `job ${jobId} done: scanned=${totals.scanned} ready=${totals.ready}/${target} (${stopReason})`, { reasons, chains });
    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totals.scanned,
      total_parsed: totals.ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: { wave: waveNo, target, pool: pool.length, scanned: totals.scanned, ready: totals.ready, stop_reason: stopReason, funnel, reasons, chains, offer_version: libraries.offerVersion },
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      log('info', `job ${jobId} cancelled`);
      return;
    }
    log('error', `job ${jobId} failed`, err);
    await db
      .from('parser_jobs')
      .update({ status: 'failed', progress_stage: 'failed', completed_at: new Date().toISOString(), error_message: err instanceof Error ? err.message : 'Unknown error' })
      .eq('id', jobId);
  }
}
