/** OGRN-based age, HH-based hiring signal, company-size tiering. */

import type { DirectoryCompany, DetectedSignals, EventSignal, EventTier } from './types';
import { normalizeCompanyName } from './hhEventParser';

const CURRENT_YEAR = new Date().getFullYear();

/** Round-date milestones (years) that count as an anniversary. */
const MILESTONES = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 75, 80, 90, 100]);

const LARGE_COMPANY_EMPLOYEES = 500;
const MID_COMPANY_EMPLOYEES = 100;

/**
 * OGRN digits 2-3 hold the 2-digit year the registry record was created.
 * Companies registered before EGRUL (2002) carry a 2002+ year, so age is
 * undercounted for very old companies — acceptable for anniversary targeting.
 */
export function ogrnRegistrationYear(ogrn: string | null): number | null {
  if (!ogrn) return null;
  const digits = ogrn.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 15) return null;
  const yy = Number(digits.slice(1, 3));
  if (Number.isNaN(yy)) return null;
  const year = yy <= CURRENT_YEAR % 100 ? 2000 + yy : 1900 + yy;
  if (year < 1991 || year > CURRENT_YEAR) return null;
  return year;
}

/** Maps an OKVED code (any format) to a coarse industry name for pain-point lookup. */
export function okvedToIndustry(okved: string | null): string {
  if (!okved) return 'Другое';
  const division = Number(okved.replace(/\D/g, '').slice(0, 2));
  if (!division) return 'Другое';
  if (division >= 1 && division <= 3) return 'Сельское хозяйство';
  if ((division >= 5 && division <= 9) || (division >= 19 && division <= 33)) return 'Промышленность';
  if (division === 10 || division === 11) return 'Пищевое производство';
  if (division >= 41 && division <= 43) return 'Строительство';
  if (division >= 45 && division <= 47) return 'Торговля';
  if (division >= 49 && division <= 53) return 'Логистика';
  if (division === 55 || division === 56) return 'HoReCa';
  if ((division >= 58 && division <= 60) || (division >= 62 && division <= 63)) return 'IT';
  if (division >= 64 && division <= 66) return 'Финансы';
  if (division === 68) return 'Недвижимость';
  if (division >= 69 && division <= 75) return 'Профессиональные услуги';
  if (division === 85) return 'Образование';
  if (division === 86 || division === 87 || division === 88) return 'Медицина';
  return 'Другое';
}

/** Runs all signal detection for a single company against the HH employer map. */
export function detectSignals(
  company: DirectoryCompany,
  hhEmployers: Map<string, number>,
): DetectedSignals {
  const signals: EventSignal[] = [];

  // Anniversary from OGRN.
  const regYear = ogrnRegistrationYear(company.ogrn);
  const age = regYear === null ? null : CURRENT_YEAR - regYear;
  let isAnniversary = false;
  let anniversaryYear: number | null = null;
  if (age !== null) {
    if (MILESTONES.has(age)) {
      isAnniversary = true;
      anniversaryYear = CURRENT_YEAR;
    } else if (MILESTONES.has(age + 1)) {
      isAnniversary = true;
      anniversaryYear = CURRENT_YEAR + 1;
    }
  }
  if (isAnniversary) signals.push('anniversary');

  // Hiring an event manager (HH match by normalized name).
  const hhCount = hhEmployers.get(normalizeCompanyName(company.name)) ?? 0;
  const seekingEventManager = hhCount > 0;
  if (seekingEventManager) signals.push('seeking_event_manager');

  // Company size.
  const employees = company.employees_count ?? 0;
  if (employees >= LARGE_COMPANY_EMPLOYEES) {
    signals.push('large_company');
  } else if (employees >= MID_COMPANY_EMPLOYEES) {
    signals.push('mid_company');
  }

  // Tier: a "hot" signal is one that points at a concrete event need now.
  let tier: EventTier = 'cold';
  if (isAnniversary || seekingEventManager) {
    tier = 'hot';
  } else if (signals.includes('large_company') || signals.includes('mid_company')) {
    tier = 'warm';
  }

  return {
    company_age: age,
    is_anniversary: isAnniversary,
    anniversary_year: anniversaryYear,
    hh_vacancies_count: hhCount,
    seeking_event_manager: seekingEventManager,
    detected_signals: signals,
    tier,
  };
}
