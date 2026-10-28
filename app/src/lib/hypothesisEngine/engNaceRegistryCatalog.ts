/**
 * Activity classes for the national business registers that file NACE codes:
 * Finland (TOL 2025), Czechia (CZ-NACE 2025), Ireland (NACE Rev. 2, older
 * companies NACE Rev. 1.1), Estonia (EMTAK 2025 and 2008), Sweden (SNI 2025)
 * and Germany's energy market register (NACE groups, engMastrRegistry.ts). One closed list
 * per sector in NACE Rev. 2.1 classes; a register on an older revision reads
 * the classes they replaced. Like every registry category, a class only chooses
 * candidates; the company is admitted by its own site, size and company check.
 */
export const HE_ENG_NACE_SECTOR_CLASSES: Readonly<Record<string, readonly string[]>> = {
  software: ['58.29', '62.10', '62.20', '62.90'],
  banks: ['64.19'],
  fund_services: ['66.19', '66.30'],
  asset_management: ['66.30'],
  insurance: ['65.11', '65.12', '65.20'],
  insurance_brokers: ['66.22'],
  dental: ['86.23'],
  hospitals: ['86.10'],
  clinics: ['86.21', '86.22'],
  trucking: ['49.41'],
  construction: ['41.00'],
  hotels: ['55.10'],
  machinery: ['28.29', '28.99'],
  law_firms: ['69.10'],
  accounting: ['69.20'],
  real_estate_agencies: ['68.31'],
  architects: ['71.11'],
  engineering: ['71.12'],
  veterinary: ['75.00'],
  travel_agencies: ['79.11', '79.12'],
  recruitment: ['78.10', '78.20'],
  marketing_agencies: ['73.11'],
};
export const HE_ENG_NACE_CLASSES: readonly string[] = [...new Set(Object.values(HE_ENG_NACE_SECTOR_CLASSES).flat())].sort();

// Rev. 2 classes behind a Rev. 2.1 class where the two differ (Eurostat correspondence table).
const REV2: Readonly<Record<string, readonly string[]>> = {
  '62.10': ['62.01'], '62.20': ['62.02', '62.03'], '62.90': ['62.09'], '41.00': ['41.20'], '78.20': ['78.20', '78.30'],
};
// Rev. 1.1 classes: Irish companies registered before Rev. 2 carry only these.
const REV11: Readonly<Record<string, readonly string[]>> = {
  '58.29': ['72.21'], '62.10': ['72.20', '72.22'], '62.20': ['72.10'], '62.90': ['72.60'], '64.19': ['65.12'],
  '65.11': ['66.01'], '65.12': ['66.03'], '66.19': ['67.13'], '66.30': ['67.12'], '66.22': ['67.20'], '86.23': ['85.13'],
  '86.10': ['85.11'], '86.21': ['85.12'], '86.22': ['85.12'], '49.41': ['60.24'], '41.00': ['45.21'], '55.10': ['55.10'],
  '28.29': ['29.24'], '28.99': ['29.56'], '69.10': ['74.11'], '69.20': ['74.12'], '68.31': ['70.31'], '71.11': ['74.20'],
  '71.12': ['74.20'], '75.00': ['85.20'], '79.11': ['63.30'], '79.12': ['63.30'], '78.10': ['74.50'], '78.20': ['74.50'],
  '73.11': ['74.40'],
};
export function heEngNaceRev2Classes(code: string): readonly string[] { return REV2[code] ?? [code]; }
export function heEngNaceRev11Classes(code: string): readonly string[] { return REV11[code] ?? []; }
/** The registry categories of one sector, for each NACE register. */
export function heEngNaceSources(sector: string): Record<'prh' | 'czso' | 'cro' | 'ariregister' | 'scb' | 'mastr', readonly string[]> {
  const classes = HE_ENG_NACE_SECTOR_CLASSES[sector] ?? [];
  return { prh: classes, czso: classes, cro: classes, ariregister: classes, scb: classes, mastr: classes };
}
