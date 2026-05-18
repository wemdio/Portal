/** OGRN/DaData-based age, HH-based hiring signal, company-size tiering. */

import type { DirectoryCompany, DetectedSignals, EventSignal, EventTier } from './types';
import { normalizeCompanyName } from './hhEventParser';

const CURRENT_YEAR = new Date().getFullYear();

/** Round-date milestones (years) that count as an anniversary. */
const MILESTONES = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 75, 80, 90, 100]);

/** A milestone is "hot" only if it falls within this many days ahead — enough
 *  lead time to write, warm up, and book before the date. */
export const ANNIVERSARY_WINDOW_DAYS = 60;

const LARGE_COMPANY_EMPLOYEES = 500;
const MID_COMPANY_EMPLOYEES = 100;

/**
 * OGRN digits 2-3 hold the 2-digit year the registry record was created.
 * Companies registered before EGRUL (2002) carry a 2002+ year, so age is
 * undercounted for very old companies — use only for the coarse candidate
 * filter, not for the final anniversary decision.
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

/**
 * Coarse, free pre-filter: could this company plausibly have a milestone
 * anniversary soon? Only these get the (paid) DaData date lookup.
 * Errs toward inclusion — unknown OGRN and the 2002 EGRUL cluster always pass,
 * since their real age can't be told from OGRN.
 */
export function isAnniversaryCandidate(ogrn: string | null): boolean {
  const year = ogrnRegistrationYear(ogrn);
  if (year === null) return true;
  if (year <= 2002) return true;
  const age = CURRENT_YEAR - year;
  return MILESTONES.has(age) || MILESTONES.has(age + 1);
}

export interface AnniversaryResult {
  registrationDate: string | null; // ISO yyyy-mm-dd
  currentAge: number | null;
  anniversaryDate: string | null; // ISO date of the upcoming milestone (null if not a milestone)
  daysToAnniversary: number | null;
  isAnniversary: boolean; // milestone within ANNIVERSARY_WINDOW_DAYS
}

const EMPTY_ANNIVERSARY: AnniversaryResult = {
  registrationDate: null,
  currentAge: null,
  anniversaryDate: null,
  daysToAnniversary: null,
  isAnniversary: false,
};

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Given an exact registration date, works out the next round-number
 * anniversary and whether it lands inside the outreach window.
 */
export function computeAnniversary(
  regDate: Date | null,
  today: Date = new Date(),
): AnniversaryResult {
  if (!regDate || Number.isNaN(regDate.getTime())) return { ...EMPTY_ANNIVERSARY };

  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const regY = regDate.getFullYear();
  const regM = regDate.getMonth();
  const regD = regDate.getDate();

  // Next anniversary on or after today.
  let annivYear = t0.getFullYear();
  let anniv = new Date(annivYear, regM, regD);
  if (anniv.getTime() < t0.getTime()) {
    annivYear += 1;
    anniv = new Date(annivYear, regM, regD);
  }

  // Age the company turns at that anniversary, and its age right now.
  const ageAtAnniversary = annivYear - regY;
  const currentAge = ageAtAnniversary - (anniv.getTime() > t0.getTime() ? 1 : 0);

  const isMilestone = MILESTONES.has(ageAtAnniversary);
  const days = Math.round((anniv.getTime() - t0.getTime()) / 86_400_000);

  return {
    registrationDate: isoDate(regDate),
    currentAge,
    anniversaryDate: isMilestone ? isoDate(anniv) : null,
    daysToAnniversary: isMilestone ? days : null,
    isAnniversary: isMilestone && days >= 0 && days <= ANNIVERSARY_WINDOW_DAYS,
  };
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

/** Runs all signal detection for a single company. */
export function detectSignals(
  company: DirectoryCompany,
  hhEmployers: Map<string, number>,
  anniversary: AnniversaryResult,
): DetectedSignals {
  const signals: EventSignal[] = [];

  // Anniversary — from the exact DaData date (computeAnniversary). Falls back
  // to the OGRN-year age only for display; the signal needs the exact date.
  if (anniversary.isAnniversary) signals.push('anniversary');
  const ogrnYear = ogrnRegistrationYear(company.ogrn);
  const companyAge =
    anniversary.currentAge ?? (ogrnYear === null ? null : CURRENT_YEAR - ogrnYear);

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

  // Tier: a "hot" signal points at a concrete event need in the near term.
  let tier: EventTier = 'cold';
  if (anniversary.isAnniversary || seekingEventManager) {
    tier = 'hot';
  } else if (signals.includes('large_company') || signals.includes('mid_company')) {
    tier = 'warm';
  }

  return {
    company_age: companyAge,
    registration_date: anniversary.registrationDate,
    is_anniversary: anniversary.isAnniversary,
    anniversary_date: anniversary.anniversaryDate,
    days_to_anniversary: anniversary.daysToAnniversary,
    hh_vacancies_count: hhCount,
    seeking_event_manager: seekingEventManager,
    detected_signals: signals,
    tier,
  };
}
