/**
 * Оффер «Автоматизация аутрича» (automated_outreach_v1), INSTRUCTION_03.
 *
 * Источники: AMO (прошлые лиды и клиенты Polza) и hh.ru (работодатели с двумя и
 * более вакансиями продаж). Правило допуска (§9.1):
 *  - CRM — достаточно одного сильного подтверждения (сама сделка) и общего ICP;
 *  - холодная компания — минимум два независимых средних признака, и среди них
 *    хотя бы один, дающий параллельные сегменты (продукты/регионы/партнёры);
 *  - признаки из одного и того же текста не суммируются: у каждого типа свой
 *    факт, у каждого факта своя цитата.
 * Наличие бюджета, желания масштабироваться и обработчика лидов не
 * утверждается — письмо 3 задаёт это как квалификацию.
 */

import { findOutboundMarker } from '../analyze';
import { companyBrand } from '../company';
import { buildAutomationChain, type AutomationLetterInput } from '../letters/automation';
import { q } from '../letters/common';
import { reject, type Candidate, type ProfileHandler, type RunContext } from '../pipeline';
import { loadAmoCandidates } from '../sources/amo';
import { fetchEmployerSite, fetchVacancyCard } from '../sources/hhCard';
import { loadHhEmployers, SALES_TITLE_PATTERN } from '../sources/hhPool';
import { analyzeSite } from '../sources/siteSignals';
import type { Signal } from '../types';
import { hhCandidate, vacanciesOf } from './sdr';

const MAX_CARDS = 4;
const SEGMENT_TYPES = new Set(['multiple_products', 'multiple_regions', 'partner_program']);

export function createAutomationProfile(): ProfileHandler {
  let pool: Candidate[] = [];
  let cursor = 0;
  const hiringSignal = new Map<string, Signal | null>();

  return {
    async prepare(ctx: RunContext) {
      const sources = ctx.config.sources;
      const out: Candidate[] = [];
      if (sources.includes('crm')) {
        const leads = await loadAmoCandidates(ctx.db);
        for (const lead of leads) {
          if (ctx.config.relationship_filter === 'prior_contact' && !lead.priorContact) continue;
          out.push({
            key: lead.inn ? `inn:${lead.inn}` : `domain:${lead.domain}`,
            sourceType: 'crm',
            sourceRecordId: `amo:${lead.amoId}`,
            sourceUrl: null,
            sourceUrls: [],
            companyName: lead.companyName,
            inn: lead.inn,
            website: lead.website,
            hhEmployerId: null,
            crmLeadId: lead.amoId,
            priorContact: lead.priorContact,
            priorContactDate: lead.priorContactDate,
            crmEmail: lead.contactEmail,
            signals: [],
            payload: { recentlyContacted: lead.recentlyContacted, statusName: lead.statusName },
          });
        }
      }
      // Холодные компании не могут быть prior_contact по определению.
      if (sources.includes('hh_multi') && ctx.config.relationship_filter !== 'prior_contact') {
        const employers = await loadHhEmployers(ctx.db, {
          pattern: SALES_TITLE_PATTERN,
          freshnessDays: ctx.config.freshness_days,
          minVacancies: 2,
        });
        for (const e of employers) out.push(hhCandidate(e, 'hh_multi'));
      }
      pool = out;
      return pool.length;
    },

    nextWave(want) {
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;
      return wave;
    },

    async checkSource(row) {
      if (row.candidate.sourceType === 'crm') {
        if (row.candidate.payload.recentlyContacted) {
          return reject('source_checked', 'CRM_RECENT_CONTACT', String(row.candidate.payload.statusName ?? ''));
        }
        return null;
      }
      // hh_multi: две и более ЖИВЫЕ вакансии с outbound-функцией в тексте.
      const live: Array<{ title: string; url: string; marker: string; publishedAt: string | null }> = [];
      for (const ref of vacanciesOf(row).slice(0, MAX_CARDS)) {
        const res = await fetchVacancyCard(ref.vacancy_id);
        if (!res.ok || res.card.archived) continue;
        const marker = findOutboundMarker(`${res.card.title}\n${res.card.descriptionText}`);
        if (marker) live.push({ title: res.card.title, url: res.card.url, marker, publishedAt: res.card.publishedAt });
        if (live.length >= 2) break;
      }
      hiringSignal.set(
        row.id,
        live.length >= 2
          ? {
              type: 'multiple_sales_vacancies',
              source: 'hh_multi',
              title: live[0].title,
              date: live[0].publishedAt,
              url: live[0].url,
              quote: live[0].marker,
              level: 'A',
              meta: { vacancies: live.map((v) => ({ title: v.title, url: v.url })) },
            }
          : null,
      );
      return null;
    },

    async resolveWebsite(row) {
      return row.candidate.hhEmployerId ? fetchEmployerSite(row.candidate.hhEmployerId) : null;
    },

    async qualify(row, ctx) {
      const c = row.candidate;
      const isCrm = c.sourceType === 'crm';
      const site = await analyzeSite(row.website as string, 'automation', ctx.tagVocabulary);
      const hiring = hiringSignal.get(row.id) ?? null;
      const facts: Signal[] = [...(hiring ? [hiring] : []), ...site.facts];
      const basePatch = {
        signals: facts,
        source_urls: [...c.sourceUrls, ...facts.map((f) => f.url).filter((u): u is string => Boolean(u))],
      };

      if (!site.reachable && !isCrm) return reject('icp_checked', 'SITE_UNREACHABLE', row.website ?? undefined, 'rejected', basePatch);
      if (site.excludedCategory) {
        return reject('icp_checked', site.excludedCategory === 'b2c_only' ? 'NOT_B2B' : 'EXCLUDED_CATEGORY', site.excludedCategory, 'rejected', basePatch);
      }
      // CRM-сделка Polza — уже подтверждение B2B-запроса; холодной нужна цитата с сайта.
      if (!isCrm && !site.isB2b) return reject('icp_checked', 'NOT_B2B', 'нет цитаты о продажах организациям', 'rejected', basePatch);

      const priorContact = isCrm && c.priorContact && ctx.config.relationship_filter !== 'cold';
      const mediumTypes = new Set(facts.map((f) => f.type));
      if (!isCrm) {
        if (mediumTypes.size < 2) {
          return reject('icp_checked', 'AUTOMATION_FIT_TOO_WEAK', `признаков: ${mediumTypes.size}`, 'rejected', basePatch);
        }
        if (![...mediumTypes].some((t) => SEGMENT_TYPES.has(t))) {
          return reject('icp_checked', 'SEGMENTS_NOT_IDENTIFIABLE', undefined, 'rejected', basePatch);
        }
      }

      const best = hiring ?? site.facts.find((f) => f.type === 'partner_program') ?? site.facts[0] ?? null;
      const verifiedSignalBlock = best
        ? best.type === 'multiple_sales_vacancies'
          ? `Увидел, что в ${q(companyBrand(row.candidate.companyName))} сейчас открыто несколько вакансий в продажах, например «${best.title}».`
          : `На вашем сайте указано: «${best.quote}».`
        : null;
      const mode = priorContact ? 'relationship' : best ? 'evidence' : 'generic_fit';

      const input: AutomationLetterInput = { priorContact, verifiedSignalBlock };
      return {
        ok: true,
        patch: {
          ...basePatch,
          prior_contact: priorContact,
          prior_contact_date: priorContact ? c.priorContactDate : null,
          signal_type: best?.type ?? (isCrm ? 'crm_record' : null),
          signal_date: best?.date ?? null,
          signal_title: best?.title ?? null,
          source_url: best?.url ?? c.sourceUrl,
          evidence_quote: best?.quote ?? null,
          evidence_level: best ? best.level : 'NONE',
          market_evidence_quote: site.customerQuote,
          generation_mode: mode,
          fit_reasons: [
            ...(isCrm ? [`AMO: ${c.priorContact ? 'был разговор' : 'сделка без записанного разговора'} (${String(c.payload.statusName ?? '')})`] : []),
            ...(site.b2bQuote ? [`B2B: «${site.b2bQuote}»`] : []),
            ...facts.map((f) => `${f.type}: «${f.quote ?? f.title}»`),
          ],
        },
        letterInput: input,
        allowedFacts: [
          ...(verifiedSignalBlock ? [verifiedSignalBlock] : []),
          ...facts.map((f) => f.quote ?? '').filter(Boolean),
        ],
        tags: site.tags,
      };
    },

    async assemble(_row, letterCtx, letterInput) {
      return buildAutomationChain(letterCtx, letterInput as AutomationLetterInput);
    },

    release(row) {
      hiringSignal.delete(row.id);
    },
  };
}

