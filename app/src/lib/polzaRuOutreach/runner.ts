/**
 * Раннер «Нашего автоаутрича» (parser_type='polza_ru_outreach').
 *
 * Волны кандидатов идут через общий конвейер, пока не наберётся заказанное
 * число ГОТОВЫХ компаний или не кончится пул (как у английского автоаутрича:
 * оператор заказывает результат, а не размер выборки). Каждая строка журнала
 * проходит этапы:
 *
 *   candidates_loaded → source_checked → company_resolved → deduplicated →
 *   icp_checked / evidence_classified (оффер) → recipient_resolved →
 *   sequence_assembled → qa_checked → ready
 *
 * Отсеянная строка остаётся в журнале с этапом, кодом и пояснением — по ним
 * считается воронка. Ошибка одной строки не валит запуск; сбой источника или
 * библиотек — валит (status=failed), повтор начинается с чистого журнала.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { companyBrand, isSuppressed, loadPreviouslyExported, normalizeDomain, siteUrl, type ExportedIndex } from './company';
import { findRuCompanyEmail, type RuEmailResult } from './findEmail';
import type { LetterContext } from './letters/common';
import { caseTagVocabulary, loadLibraries, pickCase } from './libraries';
import type { Candidate, ProfileHandler, QualifyResult, RowPatch, RunContext, WorkRow } from './pipeline';
import { createAutomationProfile } from './profiles/automation';
import { createSdrProfile } from './profiles/sdr';
import { createSignalsProfile } from './profiles/signals';
import { runQa } from './qa';
import {
  sanitizeRuOutreachConfig,
  STAGES,
  TEMPLATE_VERSION,
  type ProfileCode,
  type RuOutreachConfig,
  type Stage,
} from './types';

const ROW_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.POLZA_RU_OUTREACH_CONCURRENCY ?? '4')));
const MIN_WAVE = 20;
const MAX_WAVE = 200;
const BLIND_YIELD_GUESS = 0.1;
const DB_CHUNK = 100;

class CancelledError extends Error {}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[polza-ru-outreach][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

export function maxCandidatesFor(target: number): number {
  return Math.min(4000, Math.max(300, target * 30));
}

export function nextWaveSize(target: number, totals: { scanned: number; ready: number }): number {
  const missing = Math.max(1, target - totals.ready);
  const rate = totals.scanned > 0 && totals.ready > 0 ? totals.ready / totals.scanned : BLIND_YIELD_GUESS;
  return Math.max(MIN_WAVE, Math.min(MAX_WAVE, Math.ceil(missing / Math.max(0.02, rate))));
}

function profileFor(code: ProfileCode): ProfileHandler {
  if (code === 'automated_outreach_v1') return createAutomationProfile();
  if (code === 'signals_v1') return createSignalsProfile();
  return createSdrProfile();
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

/** Сколько строк дошло до каждого этапа (включительно) — воронка в прогрессе. */
function emptyFunnel(): Record<Stage, number> {
  return Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
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
    const profile = profileFor(config.profile_code);
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

    const libraries = await loadLibraries(db, config.profile_code, config.sender_id);
    if (!libraries.sender) throw new Error('Нет активной подписи отправителя — добавьте её во вкладке «Библиотеки»');
    const sender = libraries.sender;
    const ctx: RunContext = { db, jobId, config, libraries, tagVocabulary: caseTagVocabulary(libraries.cases), log };
    const exported: ExportedIndex = config.include_previously_exported
      ? { domains: new Set(), inns: new Set() }
      : await loadPreviouslyExported(db, jobId);

    const poolSize = await profile.prepare(ctx);
    log('info', `job ${jobId} ${config.profile_code}: pool=${poolSize}, target=${target}`);

    const funnel = emptyFunnel();
    const reasons: Record<string, number> = {};
    const totals = { scanned: 0, ready: 0 };
    const seenKeys = new Set<string>();
    const seenDomains = new Set<string>();
    const seenInns = new Set<string>();
    let waveNo = 0;
    let processed = 0;

    const publish = async (stage: string, extra: Record<string, unknown> = {}) => {
      await setProgress({
        progress_stage: stage,
        progress_percent: Math.min(97, 3 + Math.round(94 * Math.max(totals.ready / target, Math.min(1, totals.scanned / maxScan)))),
        total_found: totals.scanned,
        total_parsed: totals.ready,
        progress_detail: {
          profile_code: config.profile_code,
          wave: waveNo,
          target,
          pool: poolSize,
          scanned: totals.scanned,
          ready: totals.ready,
          funnel,
          reasons,
          offer_version: libraries.offerVersion,
          ...extra,
        },
      });
    };

    const reach = (stage: Stage) => {
      funnel[stage] += 1;
    };

    const finish = async (row: WorkRow, res: Extract<QualifyResult, { ok: false }>) => {
      reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
      await updateRow(row.id, {
        ...(res.patch ?? {}),
        row_status: res.status,
        pipeline_stage: res.stage,
        reason_code: res.reason,
        reason_detail: res.detail ?? null,
      });
    };

    const processRow = async (row: WorkRow) => {
      const c = row.candidate;
      try {
        reach('candidates_loaded');
        // ── источник ──
        const sourceFail = profile.checkSource ? await profile.checkSource(row, ctx) : null;
        if (sourceFail && !sourceFail.ok) return finish(row, sourceFail);
        reach('source_checked');

        // ── компания и домен ──
        let website = c.website;
        let domain = normalizeDomain(website);
        if (!domain && profile.resolveWebsite) {
          website = await profile.resolveWebsite(row, ctx);
          domain = normalizeDomain(website);
        }
        if (!domain) {
          return finish(row, { ok: false, stage: 'company_resolved', status: 'rejected', reason: 'DOMAIN_NOT_FOUND' });
        }
        row.domain = domain;
        row.website = website && /^https?:\/\//i.test(website) ? website : siteUrl(domain);
        await updateRow(row.id, { normalized_domain: domain, company_website: row.website, pipeline_stage: 'company_resolved' });
        reach('company_resolved');

        // ── дедуп: внутри запуска и против прошлых выгрузок любого оффера ──
        if (seenDomains.has(domain) || (c.inn && seenInns.has(c.inn))) {
          return finish(row, { ok: false, stage: 'deduplicated', status: 'rejected', reason: 'DUPLICATE_COMPANY' });
        }
        seenDomains.add(domain);
        if (c.inn) seenInns.add(c.inn);
        if (exported.domains.has(domain) || (c.inn && exported.inns.has(c.inn))) {
          return finish(row, { ok: false, stage: 'deduplicated', status: 'rejected', reason: 'PREVIOUSLY_EXPORTED' });
        }
        reach('deduplicated');

        // ── ICP / fit / сигнал ──
        const q = await profile.qualify(row, ctx);
        if (!q.ok) return finish(row, q);
        reach('icp_checked');
        reach('evidence_classified');
        const patch: RowPatch = { ...q.patch };
        await updateRow(row.id, { ...patch, pipeline_stage: 'evidence_classified' });

        // ── адресат ──
        let email: RuEmailResult;
        if (c.crmEmail) {
          // Человек из сделки AMO: с ним уже говорили, это не общий ящик.
          email = { email: c.crmEmail, emailType: 'person', isRouting: false, recipientRole: 'Контакт из AMO', sourceUrl: null };
        } else {
          email = await findRuCompanyEmail(row.website, domain);
        }
        if (!email.email) {
          return finish(row, { ok: false, stage: 'recipient_resolved', status: 'rejected', reason: 'EMAIL_NOT_FOUND', patch });
        }
        if (await isSuppressed(db, email.email)) {
          return finish(row, { ok: false, stage: 'recipient_resolved', status: 'rejected', reason: 'SUPPRESSED_CONTACT', detail: email.email, patch });
        }
        const gate = profile.gateAfterEmail?.(row, patch, email.emailType, ctx) ?? null;
        if (gate && !gate.ok) return finish(row, { ...gate, patch: { ...patch, ...(gate.patch ?? {}) } });
        await updateRow(row.id, {
          signal_score: patch.signal_score ?? null,
          recipient_email: email.email,
          email_type: email.emailType,
          email_source_url: email.sourceUrl,
          recipient_role: email.recipientRole,
          is_routing: email.isRouting,
          pipeline_stage: 'recipient_resolved',
        });
        reach('recipient_resolved');

        // ── цепочка ──
        const brand = companyBrand(c.companyName);
        const caseRecord = pickCase(libraries.cases, q.tags);
        const letterCtx: LetterContext = {
          brand,
          sender,
          isRouting: email.isRouting,
          caseRecord,
          claims: libraries.claims,
        };
        const chain = await profile.assemble(row, letterCtx, q.letterInput, ctx);
        reach('sequence_assembled');

        // ── QA ──
        const usedClaims = libraries.claims.filter((cl) => chain.claimIds.includes(cl.id));
        const qa = runQa({
          profile: config.profile_code,
          letters: chain.letters,
          sender,
          priorContact: Boolean(patch.prior_contact),
          caseText: caseRecord?.case_text_short.trim() ?? null,
          claimTexts: usedClaims.map((cl) => cl.claim_text),
          allowedFacts: [brand, ...q.allowedFacts],
          targetMarket: patch.target_market ?? null,
          marketQuote: patch.market_evidence_quote ?? null,
          recipientEmail: email.email,
        });
        const base = {
          company_brand: brand,
          letters: chain.letters,
          subject_b: chain.subjectB,
          case_id: chain.caseId,
          offer_version: libraries.offerVersion,
          offer_claim_ids: chain.claimIds,
          sender_id: sender.id,
          template_version: TEMPLATE_VERSION[config.profile_code],
          qa_status: qa.status,
          qa_flags: qa.flags,
        };
        if (qa.status !== 'passed') {
          reasons.QA_FAILED = (reasons.QA_FAILED ?? 0) + 1;
          await updateRow(row.id, {
            ...base,
            row_status: 'manual_review',
            pipeline_stage: 'qa_checked',
            reason_code: qa.flags.some((f) => f.includes('placeholder')) ? 'QA_PLACEHOLDER_LEFT' : qa.flags.some((f) => f.includes('unsupported') || f.includes('false_prior') || f.includes('market_without')) ? 'QA_FACT_UNSUPPORTED' : 'QA_FAILED',
            reason_detail: qa.flags.join('; '),
          });
          return;
        }
        reach('qa_checked');
        // Лимит считает готовые строки: лишняя готовая сверх цели не нужна.
        if (totals.ready >= target) {
          await updateRow(row.id, { ...base, row_status: 'manual_review', pipeline_stage: 'qa_checked', reason_code: 'LIMIT_REACHED', reason_detail: 'лимит готовых компаний уже набран' });
          return;
        }
        totals.ready += 1;
        reach('ready');
        await updateRow(row.id, { ...base, row_status: 'ready', pipeline_stage: 'ready', reason_code: null, reason_detail: null });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        reasons.PROCESSING_ERROR = (reasons.PROCESSING_ERROR ?? 0) + 1;
        await updateRow(row.id, {
          row_status: 'failed',
          reason_code: 'PROCESSING_ERROR',
          reason_detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
        });
      } finally {
        profile.release?.(row);
        processed += 1;
        if (processed % 5 === 0) await publish('processing');
      }
    };

    let exhausted = false;
    while (totals.ready < target && totals.scanned < maxScan && !exhausted) {
      await ensureNotCancelled();
      waveNo += 1;
      const want = Math.min(nextWaveSize(target, totals), maxScan - totals.scanned);
      const raw = profile.nextWave(want);
      if (!raw.length) {
        exhausted = true;
        break;
      }
      const wave: Candidate[] = [];
      for (const cand of raw) {
        if (seenKeys.has(cand.key)) continue;
        seenKeys.add(cand.key);
        wave.push(cand);
      }
      if (!wave.length) continue;

      const ids = new Map<number, string>();
      for (let i = 0; i < wave.length; i += DB_CHUNK) {
        const chunk = wave.slice(i, i + DB_CHUNK);
        const { data, error } = await db
          .from('polza_ru_outreach_companies')
          .insert(
            chunk.map((cand) => ({
              job_id: jobId,
              profile_code: config.profile_code,
              source_type: cand.sourceType,
              source_record_id: cand.sourceRecordId,
              source_url: cand.sourceUrl,
              source_urls: cand.sourceUrls,
              company_name: cand.companyName,
              company_brand: companyBrand(cand.companyName),
              inn: cand.inn,
              hh_employer_id: cand.hhEmployerId,
              crm_lead_id: cand.crmLeadId,
              signals: cand.signals,
              row_status: 'processing',
              pipeline_stage: 'candidates_loaded',
            })),
          )
          .select('id');
        if (error) throw new Error(`journal insert failed: ${error.message}`);
        (data ?? []).forEach((r, j) => ids.set(i + j, String(r.id)));
      }
      const rows: WorkRow[] = wave
        .map((candidate, i) => ({ id: ids.get(i) ?? '', candidate, domain: null, website: null }))
        .filter((r) => r.id);
      totals.scanned += rows.length;
      await publish('processing', { wave_size: rows.length });
      log('info', `wave ${waveNo}: ${rows.length} candidates (ready ${totals.ready}/${target})`);

      // Внутри волны строки независимы; отмену проверяем между строками.
      await runPool(rows, ROW_CONCURRENCY, async (row) => {
        if (totals.ready >= target) {
          await updateRow(row.id, { row_status: 'rejected', reason_code: 'LIMIT_REACHED', reason_detail: 'лимит готовых компаний набран раньше' });
          return;
        }
        await ensureNotCancelled();
        await processRow(row);
      });
    }

    const stopReason = totals.ready >= target ? 'target_reached' : exhausted ? 'pool_exhausted' : 'scan_limit';
    log('info', `job ${jobId} done: scanned=${totals.scanned} ready=${totals.ready}/${target} (${stopReason})`, reasons);
    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totals.scanned,
      total_parsed: totals.ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: {
        profile_code: config.profile_code,
        wave: waveNo,
        target,
        pool: poolSize,
        scanned: totals.scanned,
        ready: totals.ready,
        stop_reason: stopReason,
        funnel,
        reasons,
        offer_version: libraries.offerVersion,
      },
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      log('info', `job ${jobId} cancelled`);
      return;
    }
    log('error', `job ${jobId} failed`, err);
    await db
      .from('parser_jobs')
      .update({
        status: 'failed',
        progress_stage: 'failed',
        completed_at: new Date().toISOString(),
        error_message: err instanceof Error ? err.message : 'Unknown error',
      })
      .eq('id', jobId);
  }
}
