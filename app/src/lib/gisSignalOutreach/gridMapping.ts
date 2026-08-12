/**
 * Маппинг gisSignalOutreach: квалифицированные компании + результаты
 * 6-сигнальной проверки → сетка string[][] для base_constructor_jobs, и
 * финальная сетка конструктора → лиды Instantly.
 *
 * Заголовок сетки ТОЧНО повторяет референсный CSV ручной выгрузки:
 *   id,компания,city_name,phone,email,сайт,category,subcategory,
 *   <8 пар «сигнал»/«сигнал — уточнение»>, score, grade, Проверка — примечание
 *
 * Сигнальные колонки — 'Да'/'Нет'; уточнение — evidence, а когда сигнал не
 * сработал — 'Not found on checked pages' (конвенция референсного CSV).
 * score/grade заполнены только у сегментов со скоринг-профилем (legal).
 *
 * Колонка email на входе чаще всего пустая (у 2GIS-карточек с сайтом почты
 * редки) — её заполняет find_emails конструктора (step_config.find_emails_target
 * = 'same', см. pipelineRunner). Колонка id = twogis_id: конструктор её не
 * переписывает, поэтому по ней раннер раскладывает финальную сетку обратно
 * по сегментам (строки конструктор может ВЫКИДЫВАТЬ — позиционный маппинг
 * невозможен).
 *
 * Чистые функции, без внешних вызовов.
 */

import { extractEmail, findColumnIndex } from '@/lib/tools/dfybUtils';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { SIGNAL_COLUMNS, type OutreachSignalsResult } from './signals';
import type { SegmentCandidate } from './segments';

/** Текст уточнения для несработавшего сигнала (конвенция референсного CSV). */
export const CLARIFICATION_NOT_FOUND = 'Not found on checked pages';

const BASE_HEADER = ['id', 'компания', 'city_name', 'phone', 'email', 'сайт', 'category', 'subcategory'] as const;
const SCORE_HEADER = 'score';
const GRADE_HEADER = 'grade';
const NOTE_HEADER = 'Проверка — примечание';

/** Заголовок сетки, которую кормим конструктору баз (точный, не переупорядочивать). */
export const GRID_HEADER: string[] = [
  ...BASE_HEADER,
  ...SIGNAL_COLUMNS.flatMap((c) => [c.title, c.clarification]),
  SCORE_HEADER,
  GRADE_HEADER,
  NOTE_HEADER,
];

export interface QualifiedCompany {
  candidate: SegmentCandidate;
  signals: OutreachSignalsResult;
  /** Взвешенный скор/грейд — только у сегментов со скоринг-профилем (legal). */
  score?: number | null;
  grade?: string | null;
}

/**
 * Квалифицированные компании одного/нескольких сегментов → сетка для
 * base_constructor_jobs.data. Первая строка — GRID_HEADER.
 */
export function companiesToGrid(companies: QualifiedCompany[]): string[][] {
  const rows = companies.map(({ candidate, signals, score, grade }) => {
    const signalCells = SIGNAL_COLUMNS.flatMap((col) => {
      const verdict = signals.signals[col.key];
      return [
        verdict.hit ? 'Да' : 'Нет',
        verdict.hit ? verdict.evidence : CLARIFICATION_NOT_FOUND,
      ];
    });
    return [
      candidate.twogisId,
      candidate.name,
      candidate.cityName,
      candidate.phone,
      candidate.email,
      candidate.site,
      candidate.category,
      candidate.subcategory,
      ...signalCells,
      // Скор/грейд — только scored-сегменты; у остальных ячейки пустые.
      typeof score === 'number' ? String(score) : '',
      grade ?? '',
      signals.note,
    ];
  });
  return [[...GRID_HEADER], ...rows];
}

/**
 * Финальная сетка конструктора → лиды Instantly для кампании сегмента.
 *
 * После прогона остаются строки с валидной почтой (validate_emails отсекает
 * невалид), дедуп по email на всякий случай. Кастомные переменные несут всё,
 * что нужно шаблонам писем: company/city/site/phone/segment, список сработавших
 * сигналов (русские заголовки через запятую) и email_status от validate_emails.
 */
export function gridToLeadPayloads(grid: string[][], segmentKey: string): LeadCreatePayload[] {
  if (!grid || grid.length < 2) return [];
  const header = grid[0];

  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const companyIdx = findColumnIndex(header, 'компания', 'company', 'company_name', 'название');
  const cityIdx = findColumnIndex(header, 'city_name', 'город', 'city');
  const phoneIdx = findColumnIndex(header, 'phone', 'телефон');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website', 'домен', 'domain', 'url');
  // Колонка «Email Статус» от validate_emails (точный матч; fallback — любой
  // заголовок на «статус»). -1 = валидация не гонялась → статус пустой.
  const statusIdx = ((): number => {
    const exact = findColumnIndex(header, 'email статус', 'email status');
    if (exact >= 0) return exact;
    return header.findIndex((h) => (h ?? '').trim().toLowerCase().endsWith('статус'));
  })();
  const signalTitleIdxs = SIGNAL_COLUMNS.map((col) =>
    header.findIndex((h) => (h ?? '').trim() === col.title),
  );
  // Колонки скоринга (есть только у scored-сегментов; -1 → переменные не пишем).
  const scoreIdx = header.findIndex((h) => (h ?? '').trim().toLowerCase() === 'score');
  const gradeIdx = header.findIndex((h) => (h ?? '').trim().toLowerCase() === 'grade');

  const leads: LeadCreatePayload[] = [];
  const seenEmails = new Set<string>();

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const email = emailIdx >= 0 ? extractEmail(row[emailIdx] ?? '') : null;
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);

    const company = companyIdx >= 0 ? (row[companyIdx] ?? '').trim() : '';
    const city = cityIdx >= 0 ? (row[cityIdx] ?? '').trim() : '';
    const phone = phoneIdx >= 0 ? (row[phoneIdx] ?? '').trim() : '';
    const site = siteIdx >= 0 ? (row[siteIdx] ?? '').trim() : '';
    const emailStatus = statusIdx >= 0 ? (row[statusIdx] ?? '').trim() : '';
    const hitSignals = SIGNAL_COLUMNS
      .filter((_, i) => signalTitleIdxs[i] >= 0 && (row[signalTitleIdxs[i]] ?? '').trim() === 'Да')
      .map((col) => col.title)
      .join(', ');

    const lead: LeadCreatePayload = { email };
    if (company) lead.company_name = company;
    if (site) lead.website = site;
    if (phone) lead.phone = phone;
    lead.custom_variables = {
      company,
      city,
      site,
      phone,
      segment: segmentKey,
      signals: hitSignals,
      email_status: emailStatus,
    };
    // Скоринг: score/grade прокидываем в шаблоны писем только когда они есть
    // (scored-сегменты, напр. legal); у остальных переменных нет вообще.
    const score = scoreIdx >= 0 ? (row[scoreIdx] ?? '').trim() : '';
    const grade = gradeIdx >= 0 ? (row[gradeIdx] ?? '').trim() : '';
    if (score) lead.custom_variables.score = score;
    if (grade) lead.custom_variables.grade = grade;
    leads.push(lead);
  }

  return leads;
}
