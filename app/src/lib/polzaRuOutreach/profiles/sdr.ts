/**
 * Оффер «Найм SDR» (sdr_hiring_v1), INSTRUCTION_02.
 *
 * Кандидаты — работодатели hh.ru со свежими вакансиями по SDR-словарю.
 * Допуск только при буквальной цитате функции холодного поиска / лидогенерации /
 * привлечения новых B2B-клиентов в полном тексте вакансии. Проверяем до трёх
 * свежих вакансий работодателя и берём сильнейшую цитату: одна компания — одна
 * цепочка. Рынок без отдельной цитаты остаётся unknown (generic_market).
 */

import { analyzeVacancy, type VacancyAnalysis } from '../analyze';
import { companyKey } from '../company';
import { buildSdrChain, type SdrLetterInput } from '../letters/sdr';
import { reject, type Candidate, type ProfileHandler, type QualifyResult, type RunContext, type WorkRow } from '../pipeline';
import { fetchEmployerSite, fetchVacancyCard, type HhVacancyCard } from '../sources/hhCard';
import { loadHhEmployers, SDR_TITLE_PATTERN, type HhEmployerCandidate, type HhVacancyRef } from '../sources/hhPool';

const MAX_VACANCIES_PER_COMPANY = 3;

interface Checked {
  card: HhVacancyCard;
  analysis: VacancyAnalysis;
}

export function hhCandidate(e: HhEmployerCandidate, sourceType: Candidate['sourceType']): Candidate {
  const freshest = e.vacancies[0];
  return {
    key: e.employerId ? `hh:${e.employerId}` : `name:${companyKey(e.companyName)}`,
    sourceType,
    sourceRecordId: freshest ? `hh:${freshest.vacancy_id}` : null,
    sourceUrl: freshest?.url ?? null,
    sourceUrls: e.vacancies.map((v) => v.url).filter((u): u is string => Boolean(u)),
    companyName: e.companyName,
    inn: null,
    website: e.companySiteUrl,
    hhEmployerId: e.employerId,
    crmLeadId: null,
    priorContact: false,
    priorContactDate: null,
    crmEmail: null,
    signals: [],
    payload: { vacancies: e.vacancies, vacancyCount: e.vacancyCount },
  };
}

export function vacanciesOf(row: WorkRow): HhVacancyRef[] {
  return (row.candidate.payload.vacancies as HhVacancyRef[] | undefined) ?? [];
}

export function createSdrProfile(): ProfileHandler {
  let pool: Candidate[] = [];
  let cursor = 0;
  const liveCards = new Map<string, HhVacancyCard[]>();

  return {
    async prepare(ctx: RunContext) {
      const employers = await loadHhEmployers(ctx.db, {
        pattern: SDR_TITLE_PATTERN,
        freshnessDays: ctx.config.freshness_days,
      });
      pool = employers.map((e) => hhCandidate(e, 'hh'));
      return pool.length;
    },

    nextWave(want) {
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;
      return wave;
    },

    async checkSource(row, ctx) {
      const cards: HhVacancyCard[] = [];
      let lastFailure: QualifyResult | null = null;
      const since = Date.now() - ctx.config.freshness_days * 86_400_000;
      for (const ref of vacanciesOf(row).slice(0, MAX_VACANCIES_PER_COMPANY)) {
        const res = await fetchVacancyCard(ref.vacancy_id);
        if (!res.ok) {
          lastFailure = res.reason === 'closed'
            ? reject('source_checked', 'VACANCY_CLOSED', res.detail)
            : reject('source_checked', 'VACANCY_INVALID', res.detail, 'failed');
          continue;
        }
        if (res.card.archived) {
          lastFailure = reject('source_checked', 'VACANCY_CLOSED', 'вакансия в архиве hh');
          continue;
        }
        const published = res.card.publishedAt ? new Date(res.card.publishedAt).getTime() : NaN;
        if (Number.isFinite(published) && published < since) {
          lastFailure = reject('source_checked', 'VACANCY_STALE', res.card.publishedAt ?? undefined);
          continue;
        }
        if (res.card.descriptionText.length < 200) {
          lastFailure = reject('source_checked', 'VACANCY_INVALID', 'нет полного текста вакансии');
          continue;
        }
        cards.push(res.card);
      }
      if (!cards.length) return lastFailure ?? reject('source_checked', 'VACANCY_INVALID', 'нет доступных вакансий');
      liveCards.set(row.id, cards);
      return null;
    },

    async resolveWebsite(row) {
      const employerId = row.candidate.hhEmployerId ?? liveCards.get(row.id)?.[0]?.employerId ?? null;
      return employerId ? fetchEmployerSite(employerId) : null;
    },

    async qualify(row, ctx) {
      const cards = liveCards.get(row.id) ?? [];
      let best: Checked | null = null;
      let excluded: VacancyAnalysis['excludedCategory'] = null;
      for (const card of cards) {
        const analysis = await analyzeVacancy({
          title: card.title,
          description: card.descriptionText,
          companyName: row.candidate.companyName,
          tagVocabulary: ctx.tagVocabulary,
        });
        if (analysis.excludedCategory === 'recruitment_agency' || analysis.excludedCategory === 'leadgen_competitor') {
          excluded = analysis.excludedCategory;
          break;
        }
        if (analysis.excludedCategory) {
          excluded = excluded ?? analysis.excludedCategory;
          continue;
        }
        if (!analysis.sdrQuote) continue;
        // Сильнейшая цитата: с подтверждённым рынком лучше, чем без.
        if (!best || (!best.analysis.marketQuote && analysis.marketQuote)) best = { card, analysis };
        if (best.analysis.marketQuote) break;
      }
      liveCards.delete(row.id);

      const base = { source_urls: cards.map((c) => c.url) };
      if (excluded === 'recruitment_agency' || excluded === 'leadgen_competitor') {
        return reject('icp_checked', 'EXCLUDED_CATEGORY', excluded, 'rejected', base);
      }
      if (!best) {
        return excluded
          ? reject('icp_checked', excluded === 'b2c_only' ? 'NOT_B2B' : 'JOB_FUNCTION_NOT_SDR', excluded, 'rejected', base)
          : reject('evidence_classified', 'SDR_EVIDENCE_MISSING', undefined, 'rejected', base);
      }
      const { card, analysis } = best;
      const input: SdrLetterInput = {
        jobTitle: card.title,
        sdrQuote: analysis.sdrQuote as string,
        marketQuote: analysis.marketQuote,
      };
      return {
        ok: true,
        patch: {
          ...base,
          source_url: card.url,
          signal_type: 'sdr_hiring',
          signal_date: card.publishedAt,
          signal_title: card.title,
          evidence_quote: analysis.sdrQuote,
          evidence_level: 'A',
          market_evidence_quote: analysis.marketQuote,
          target_market: analysis.targetMarket,
          generation_mode: analysis.marketQuote ? 'evidence' : 'generic_market',
          fit_reasons: [
            'SDR-функция подтверждена цитатой',
            ...(analysis.b2bQuote ? [`B2B: «${analysis.b2bQuote}»`] : []),
            ...(analysis.productSummary ? [`Продукт: ${analysis.productSummary}`] : []),
          ],
          signals: [
            {
              type: 'sdr_hiring',
              source: 'hh',
              title: card.title,
              date: card.publishedAt,
              url: card.url,
              quote: analysis.sdrQuote,
              level: 'A',
            },
          ],
        },
        letterInput: input,
        allowedFacts: [card.title, analysis.sdrQuote as string, ...(analysis.marketQuote ? [analysis.marketQuote] : [])],
        tags: analysis.tags,
      };
    },

    async assemble(_row, letterCtx, letterInput) {
      return buildSdrChain(letterCtx, letterInput as SdrLetterInput);
    },

    release(row) {
      liveCards.delete(row.id);
    },
  };
}
