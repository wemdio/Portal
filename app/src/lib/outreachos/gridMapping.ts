/**
 * Маппинг между HH-работодателями, сеткой конструктора баз и лидами Instantly.
 *
 * Чистые функции, без внешних вызовов и без Mailganer.
 */

import type { HhEmployer } from '@/lib/jobs/hhAutoParser';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  detectEmailColumns,
  extractEmail,
  findColumnIndex,
  findPreferredSiteColumnIndexes,
} from '@/lib/tools/dfybUtils';
import { isOutreachOsExcludedEmail } from './excludeLocalParts';

/** Заголовки сетки, которую кормим конструктору баз. */
export const GRID_HEADER = ['Компания', 'Сайт', 'Город', 'Email'] as const;

/**
 * HhEmployer[] → сетка string[][] для base_constructor_jobs.data.
 *
 * ВАЖНО: в колонку «Сайт» кладём e.siteUrl (реальный домен компании из
 * /employers), НЕ e.hhUrl — иначе find_emails/check_sites/enrich наткнутся на
 * hh.ru и через isNonScrapeableHost молча ничего не найдут (это в точности баг
 * из памяти «Base Constructor scraped wrong column»). Работодателей без siteUrl
 * сюда не передаём — findNewHhEmployers их и так отбрасывает.
 *
 * Колонка «Email» создаётся пустой, чтобы шаги, требующие email-колонку,
 * видели её с самого начала; find_emails заполнит её скрейпом.
 */
export function employersToGrid(employers: HhEmployer[]): string[][] {
  const header = [...GRID_HEADER];
  const rows = employers.map((e) => [
    e.name ?? '',
    e.siteUrl ?? '',
    e.area ?? '',
    '',
  ]);
  return [header, ...rows];
}

/**
 * Финальная сетка конструктора баз → лиды Instantly.
 *
 * После прогона остаются только строки с валидной почтой (validate_emails
 * отсеивает невалид), по одной на уникальный email (split_emails + dedup_email).
 * Берём email / company_name / website, дедупим по email на всякий случай.
 */
export function gridToLeadPayloads(grid: string[][]): LeadCreatePayload[] {
  if (!grid || grid.length < 2) return [];
  const header = grid[0];

  // Точный матч заголовка email-колонки: findColumnIndex по равенству не цепляет
  // 'Email Статус'/'Email Провайдер' (их добавляет validate_emails), в отличие от
  // detectEmailColumns с unanchored-regex. detectEmailColumns — fallback.
  const primaryEmailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const emailCols = primaryEmailIdx >= 0 ? [primaryEmailIdx] : detectEmailColumns(grid);
  const companyIdx = findColumnIndex(
    header,
    'компания',
    'company',
    'company_name',
    'name',
    'название',
    'наименование',
    'организация',
    'фирма',
  );
  const siteIdxs = findPreferredSiteColumnIndexes(header);
  const siteIdx =
    siteIdxs[0] ??
    findColumnIndex(header, 'сайт', 'site', 'website', 'домен', 'domain', 'url');

  const leads: LeadCreatePayload[] = [];
  const seenEmails = new Set<string>();

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    let email: string | null = null;
    for (const col of emailCols) {
      email = extractEmail(row[col] ?? '');
      if (email) break;
    }
    if (!email || seenEmails.has(email)) continue;
    // HR/recruiting-ящики в лиды не идут (мы продаём аутрич — HR не покупатель).
    // Отсев только в нашем пайплайне, общий конструктор оставляет hr@ как есть.
    if (isOutreachOsExcludedEmail(email)) continue;
    seenEmails.add(email);

    const company = companyIdx >= 0 ? (row[companyIdx] ?? '').trim() : '';
    const website = siteIdx >= 0 ? (row[siteIdx] ?? '').trim() : '';

    const lead: LeadCreatePayload = { email };
    if (company) lead.company_name = company;
    if (website) lead.website = website;
    leads.push(lead);
  }

  return leads;
}
