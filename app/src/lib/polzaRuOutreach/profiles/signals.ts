/**
 * Оффер «По сигналам» (signals_v1) — прочий подтверждённый realtime-сигнал,
 * четыре письма (POLZA_SIGNAL_OUTREACH_SPEC §2–§12).
 *
 * Источники (выбирает оператор): вакансии продаж hh.ru, загруженные выгрузки
 * госконтрактов ЕИС, загруженные каталоги выставок, новости и разделы
 * «Партнёрам/Дилерам» на сайтах. Сигналы одной компании из разных источников
 * склеиваются в одну карточку (ИНН → домен → название): одна компания — одна
 * цепочка, из сигналов выбирается один сильнейший и свежий (§9).
 *
 * Скоринг §10 (0–15), порог из формы (по умолчанию 8):
 *   ICP fit 0–3 · intent 0–3 · бюджет 0–2 · свежесть 0–2 · второй независимый
 *   сигнал 0–2 · качество evidence 0–2 · контакт найден 0–1.
 * Сигнал уровня C не даёт баллов и не разрешает персонализацию.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { analyzeVacancy, findOutboundMarker, type VacancyAnalysis } from '../analyze';
import { companyBrand, companyKey, normalizeDomain } from '../company';
import { buildSegmentsHypothesis, buildSignalsChain, signalSentence, type SignalsLetterInput } from '../letters/signals';
import { reject, type Candidate, type ProfileHandler, type RowPatch, type RunContext, type WorkRow } from '../pipeline';
import { fetchEmployerSite, fetchVacancyCard, type HhVacancyCard } from '../sources/hhCard';
import { loadHhEmployers, SALES_TITLE_PATTERN } from '../sources/hhPool';
import { analyzeSite } from '../sources/siteSignals';
import { loadSignalRows } from '../sources/uploads';
import type { Signal, SignalType, SourceCode } from '../types';
import { hhCandidate, vacanciesOf } from './sdr';

const SITE_UNIVERSE_LIMIT = 2000;
const DAY = 86_400_000;
const LEADERSHIP_TITLE = /(руководител\S* отдела продаж|(^|[^а-яё])роп([^а-яё]|$)|коммерческ\S* директор|директор по продажам|head of sales)/i;

const INTENT: Partial<Record<SignalType, number>> = {
  sales_hiring: 3,
  contract_won: 3,
  trade_show_exhibitor: 2,
  dealer_search: 3,
  partner_program: 2,
  new_region: 2,
  new_office: 2,
  product_launch: 2,
  new_production: 2,
  export_launch: 2,
  new_case: 1,
};

interface Scored {
  primary: Signal;
  score: number;
  parts: Record<string, number>;
}

function mergeKeyOf(c: Candidate): string[] {
  const keys: string[] = [];
  if (c.inn) keys.push(`inn:${c.inn}`);
  const domain = normalizeDomain(c.website);
  if (domain) keys.push(`domain:${domain}`);
  if (c.hhEmployerId) keys.push(`hh:${c.hhEmployerId}`);
  keys.push(`name:${companyKey(c.companyName)}`);
  return keys;
}

function mergeCandidates(list: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const out: Candidate[] = [];
  for (const c of list) {
    const keys = mergeKeyOf(c);
    const existing = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!existing) {
      out.push(c);
      for (const k of keys) byKey.set(k, c);
      continue;
    }
    existing.signals.push(...c.signals);
    existing.sourceUrls = Array.from(new Set([...existing.sourceUrls, ...c.sourceUrls]));
    existing.inn = existing.inn ?? c.inn;
    existing.website = existing.website ?? c.website;
    existing.hhEmployerId = existing.hhEmployerId ?? c.hhEmployerId;
    if (c.payload.vacancies && !existing.payload.vacancies) {
      existing.payload = { ...existing.payload, vacancies: c.payload.vacancies, vacancyCount: c.payload.vacancyCount };
    }
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, existing);
  }
  return out;
}

function latest(signals: Signal[]): number {
  return Math.max(0, ...signals.map((s) => (s.date ? new Date(s.date).getTime() : 0)).filter(Number.isFinite));
}

/** Компании, уже встречавшиеся в прошлых запусках, — вселенная для новостей сайтов. */
async function loadSiteUniverse(db: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await db
    .from('polza_ru_outreach_companies')
    .select('company_name,normalized_domain,company_website,inn')
    .not('normalized_domain', 'is', null)
    .order('created_at', { ascending: false })
    .limit(SITE_UNIVERSE_LIMIT * 3);
  if (error) throw new Error(`site universe load failed: ${error.message}`);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of data ?? []) {
    const domain = String(r.normalized_domain);
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      key: `domain:${domain}`,
      sourceType: 'site_news',
      sourceRecordId: `site:${domain}`,
      sourceUrl: null,
      sourceUrls: [],
      companyName: String(r.company_name),
      inn: r.inn ? String(r.inn) : null,
      website: r.company_website ? String(r.company_website) : `https://${domain}`,
      hhEmployerId: null,
      crmLeadId: null,
      priorContact: false,
      priorContactDate: null,
      crmEmail: null,
      signals: [],
      payload: {},
    });
    if (out.length >= SITE_UNIVERSE_LIMIT) break;
  }
  return out;
}

export function scoreSignals(input: {
  signals: Signal[];
  b2bConfirmed: boolean;
  productKnown: boolean;
  freshnessDays: number;
  contactFound: boolean;
}): Scored | null {
  const usable = input.signals.filter((s) => s.level === 'A' || s.level === 'B');
  if (!usable.length) return null;
  const now = Date.now();
  const ranked = [...usable].sort(
    (a, b) =>
      (INTENT[b.type] ?? 0) - (INTENT[a.type] ?? 0) ||
      (b.level === 'A' ? 1 : 0) - (a.level === 'A' ? 1 : 0) ||
      (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0),
  );
  const primary = ranked[0];
  const sources = new Set<SourceCode>(usable.map((s) => s.source));
  const age = primary.date ? (now - new Date(primary.date).getTime()) / DAY : null;
  const parts = {
    icp: (input.b2bConfirmed ? 2 : 0) + (input.productKnown ? 1 : 0),
    intent: INTENT[primary.type] ?? 1,
    budget: usable.some((s) => s.type === 'contract_won') ? 2 : usable.some((s) => s.type === 'trade_show_exhibitor') ? 1 : 0,
    freshness: age === null ? 0 : age <= 14 ? 2 : age <= input.freshnessDays ? 1 : 0,
    second_signal: sources.size >= 2 ? 2 : 0,
    evidence: primary.level === 'A' ? 2 : 1,
    contact: input.contactFound ? 1 : 0,
  };
  // Выставка в будущем: окно T−90…T−14 — самое сильное, дата события впереди.
  if (primary.type === 'trade_show_exhibitor' && age !== null && age < 0) parts.freshness = 2;
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { primary, score, parts };
}

interface Qualified {
  signals: Signal[];
  b2b: boolean;
  product: boolean;
  marketQuote: string | null;
  productSummary: string | null;
}

export function createSignalsProfile(): ProfileHandler {
  let pool: Candidate[] = [];
  let cursor = 0;
  const cards = new Map<string, HhVacancyCard>();
  const qualified = new Map<string, Qualified>();

  return {
    async prepare(ctx: RunContext) {
      const src = ctx.config.sources;
      const all: Candidate[] = [];
      if (src.includes('hh_sales')) {
        const employers = await loadHhEmployers(ctx.db, { pattern: SALES_TITLE_PATTERN, freshnessDays: ctx.config.freshness_days });
        for (const e of employers) all.push(hhCandidate(e, 'hh_sales'));
      }
      if (src.includes('contracts')) {
        const rows = await loadSignalRows(ctx.db, 'contracts', ctx.config.freshness_days);
        for (const r of rows) {
          const amount = Number(r.details.amount ?? 0);
          if (!(amount >= ctx.config.min_contract_amount)) continue;
          const subject = typeof r.details.subject === 'string' ? r.details.subject : '';
          all.push({
            key: r.inn ? `inn:${r.inn}` : `name:${companyKey(r.company_name)}`,
            sourceType: 'contracts',
            sourceRecordId: `contract:${String(r.details.contract_number ?? r.id)}`,
            sourceUrl: r.record_url,
            sourceUrls: r.record_url ? [r.record_url] : [],
            companyName: r.company_name,
            inn: r.inn,
            website: r.company_website,
            hhEmployerId: null,
            crmLeadId: null,
            priorContact: false,
            priorContactDate: null,
            crmEmail: null,
            signals: [{
              type: 'contract_won',
              source: 'contracts',
              title: subject,
              date: r.record_date,
              url: r.record_url,
              quote: null,
              level: 'B',
              meta: { customer: r.details.customer ?? null, amount, contract_number: r.details.contract_number ?? null },
            }],
            payload: {},
          });
        }
      }
      if (src.includes('exhibitors')) {
        const rows = await loadSignalRows(ctx.db, 'exhibitors', ctx.config.freshness_days);
        for (const r of rows) {
          const url = r.record_url ?? r.upload.official_url;
          all.push({
            key: r.inn ? `inn:${r.inn}` : `name:${companyKey(r.company_name)}`,
            sourceType: 'exhibitors',
            sourceRecordId: `exhibitor:${r.id}`,
            sourceUrl: url,
            sourceUrls: url ? [url] : [],
            companyName: r.company_name,
            inn: r.inn,
            website: r.company_website,
            hhEmployerId: null,
            crmLeadId: null,
            priorContact: false,
            priorContactDate: null,
            crmEmail: null,
            signals: [{
              type: 'trade_show_exhibitor',
              source: 'exhibitors',
              title: r.upload.title,
              date: r.upload.event_start,
              url,
              quote: null,
              level: 'B',
              meta: { event_start: r.upload.event_start, event_end: r.upload.event_end, stand: r.details.stand ?? null },
            }],
            payload: {},
          });
        }
      }
      if (src.includes('site_news')) all.push(...(await loadSiteUniverse(ctx.db)));

      // Сначала компании с несколькими сигналами и самыми свежими — они
      // вероятнее пройдут порог скоринга.
      pool = mergeCandidates(all).sort(
        (a, b) =>
          new Set(b.signals.map((s) => s.source)).size - new Set(a.signals.map((s) => s.source)).size ||
          latest(b.signals) - latest(a.signals),
      );
      return pool.length;
    },

    nextWave(want) {
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;
      return wave;
    },

    async checkSource(row, ctx) {
      const refs = vacanciesOf(row);
      if (!refs.length) return null;
      const since = Date.now() - ctx.config.freshness_days * DAY;
      for (const ref of refs.slice(0, 2)) {
        const res = await fetchVacancyCard(ref.vacancy_id);
        if (!res.ok || res.card.archived) continue;
        const published = res.card.publishedAt ? new Date(res.card.publishedAt).getTime() : NaN;
        if (Number.isFinite(published) && published < since) continue;
        if (res.card.descriptionText.length < 200) continue;
        cards.set(row.id, res.card);
        return null;
      }
      // Вакансия закрылась, но у компании могут быть другие сигналы.
      const others = row.candidate.signals.length > 0 || row.candidate.sourceType !== 'hh_sales';
      return others ? null : reject('source_checked', 'VACANCY_CLOSED', 'нет живой вакансии продаж');
    },

    async resolveWebsite(row) {
      const id = row.candidate.hhEmployerId ?? cards.get(row.id)?.employerId ?? null;
      return id ? fetchEmployerSite(id) : null;
    },

    async qualify(row, ctx) {
      const c = row.candidate;
      const signals: Signal[] = [...c.signals];
      const card = cards.get(row.id) ?? null;
      let vacancy: VacancyAnalysis | null = null;

      if (card) {
        vacancy = await analyzeVacancy({
          title: card.title,
          description: card.descriptionText,
          companyName: c.companyName,
          tagVocabulary: ctx.tagVocabulary,
        });
        if (vacancy.excludedCategory === 'recruitment_agency' || vacancy.excludedCategory === 'leadgen_competitor') {
          return reject('icp_checked', 'EXCLUDED_CATEGORY', vacancy.excludedCategory);
        }
        const marker = findOutboundMarker(`${card.title}\n${card.descriptionText}`);
        const quote = vacancy.sdrQuote ?? marker;
        const vacancyCount = Number(c.payload.vacancyCount ?? 1);
        // Сильный hh-сигнал — SPEC §3.4; иначе вакансия продаж не повод писать.
        const strong =
          Boolean(quote) || Boolean(vacancy.marketQuote) || LEADERSHIP_TITLE.test(card.title) || vacancyCount >= 2;
        if (strong && vacancy.excludedCategory !== 'inbound_retail_only') {
          signals.push({
            type: 'sales_hiring',
            source: 'hh_sales',
            title: card.title,
            date: card.publishedAt,
            url: card.url,
            quote: quote ?? null,
            level: quote ? 'A' : 'B',
            meta: { vacancy_count: vacancyCount },
          });
        }
      }

      const site = row.website
        ? await analyzeSite(row.website, 'signals', ctx.tagVocabulary)
        : null;
      if (site?.excludedCategory) {
        return reject('icp_checked', site.excludedCategory === 'b2c_only' ? 'NOT_B2B' : 'EXCLUDED_CATEGORY', site.excludedCategory);
      }
      const since = Date.now() - ctx.config.freshness_days * DAY;
      for (const f of site?.facts ?? []) {
        const standing = f.type === 'partner_program' || f.type === 'dealer_search';
        const fresh = f.date ? new Date(f.date).getTime() >= since : false;
        if (fresh || standing) signals.push(f);
      }

      const b2b =
        Boolean(site?.isB2b) ||
        Boolean(vacancy?.isB2b && vacancy.b2bQuote) ||
        signals.some((s) => s.type === 'contract_won' || s.type === 'trade_show_exhibitor');
      const basePatch: RowPatch = {
        signals,
        source_urls: Array.from(new Set([...c.sourceUrls, ...signals.map((s) => s.url).filter((u): u is string => Boolean(u))])),
      };
      if (vacancy?.excludedCategory === 'b2c_only' || !b2b) {
        return reject('icp_checked', 'NOT_B2B', undefined, 'rejected', basePatch);
      }
      if (!signals.some((s) => s.level === 'A' || s.level === 'B')) {
        return reject('evidence_classified', 'SIGNAL_EVIDENCE_AMBIGUOUS', 'нет подтверждённого свежего сигнала', 'rejected', basePatch);
      }

      const productSummary = site?.productSummary ?? vacancy?.productSummary ?? null;
      const marketQuote = vacancy?.marketQuote ?? site?.customerQuote ?? null;
      const scored = scoreSignals({
        signals,
        b2bConfirmed: b2b,
        productKnown: Boolean(productSummary),
        freshnessDays: ctx.config.freshness_days,
        contactFound: false,
      }) as Scored;
      qualified.set(row.id, { signals, b2b, product: Boolean(productSummary), marketQuote, productSummary });

      const p = scored.primary;
      const brandSentence = signalSentence(p, companyBrand(c.companyName));
      return {
        ok: true,
        patch: {
          ...basePatch,
          signal_type: p.type,
          signal_date: p.date,
          signal_title: p.title,
          source_url: p.url ?? c.sourceUrl,
          evidence_quote: p.quote,
          evidence_level: p.level,
          market_evidence_quote: marketQuote,
          target_market: vacancy?.targetMarket ?? null,
          signal_score: scored.score,
          generation_mode: 'evidence',
          fit_reasons: [
            ...(site?.b2bQuote ? [`B2B: «${site.b2bQuote}»`] : []),
            ...(productSummary ? [`Продукт: ${productSummary}`] : []),
            `Скоринг: ${Object.entries(scored.parts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          ],
        },
        letterInput: { signal: p, marketQuote, hypothesis: null } satisfies SignalsLetterInput,
        allowedFacts: [
          ...(brandSentence ? [brandSentence] : []),
          ...signals.flatMap((s) => [s.title, s.quote ?? '']).filter(Boolean),
          ...(marketQuote ? [marketQuote] : []),
        ],
        tags: [...(site?.tags ?? []), ...(vacancy?.tags ?? [])],
      };
    },

    gateAfterEmail(row, patch, emailType, ctx) {
      const q = qualified.get(row.id);
      if (!q) return null;
      const scored = scoreSignals({
        signals: q.signals,
        b2bConfirmed: q.b2b,
        productKnown: q.product,
        freshnessDays: ctx.config.freshness_days,
        contactFound: emailType === 'department' || emailType === 'person',
      });
      if (!scored || scored.score < ctx.config.min_signal_score) {
        return reject(
          'evidence_classified',
          'SIGNAL_TOO_WEAK',
          `скоринг ${scored?.score ?? 0} < ${ctx.config.min_signal_score}`,
          'rejected',
          { signal_score: scored?.score ?? 0 },
        );
      }
      patch.signal_score = scored.score;
      return null;
    },

    async assemble(row, letterCtx, letterInput) {
      const input = letterInput as SignalsLetterInput;
      const q = qualified.get(row.id);
      const hypothesis = input.marketQuote
        ? await buildSegmentsHypothesis({
            brand: letterCtx.brand,
            productSummary: q?.productSummary ?? null,
            marketQuote: input.marketQuote,
          }).catch(() => null)
        : null;
      return buildSignalsChain(letterCtx, { ...input, hypothesis });
    },

    release(row: WorkRow) {
      cards.delete(row.id);
      qualified.delete(row.id);
    },
  };
}
