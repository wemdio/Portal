import { createHash } from 'node:crypto';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { engCountryIso2, normalizeEngCountry } from './engCountries';
import { HE_ENG_CHARITY_COMMISSION_CATEGORIES } from './engCharityCommissionRegistry';
import { HE_ENG_CQC_CATEGORIES } from './engCqcRegistry';
import { HE_ENG_ESMA_MEMBER_STATES } from './engEsmaRegistry';
import { HE_ENG_EU_TRANSPARENCY_CATEGORIES } from './engEuTransparencyRegistry';
import { HE_ENG_GIAS_CATEGORIES } from './engGiasRegistry';
import { HE_ENG_GLEIF_TERMS, HE_ENG_OSM_TAGS } from './engGlobalRegistryCatalog';
import { HE_ENG_IRS_CATEGORIES } from './engIrsRegistry';
import { HE_ENG_NACE_CLASSES, heEngNaceSources } from './engNaceRegistryCatalog';
import { HE_ENG_NCES_CATEGORIES } from './engNcesRegistry';
import { HE_ENG_SEC_SIC_SECTORS, heEngSecSectorsOverlap } from './engSecCompanyRegistry';
import { HE_ENG_WIKIDATA_SECTORS } from './engWikidataRegistry';
import type { HeEngRegistryPlan, HeEngRegistryProvider, HeEngRegistryTask } from './engPublicRegistryTypes';

/** Closed catalogue: a source can only run a reviewed, sector-specific query. */
export const HE_ENG_REGISTRY_CATEGORIES: Readonly<Record<HeEngRegistryProvider, readonly string[]>> = {
  brreg: ['58.29', '62', '64', '65', '66', '86.10', '86.2', '86.23', '49.41', '41', '55.10', '28',
    '69.1', '69.2', '68.31', '71.11', '71.12', '75', '79.1', '78', '73.11', '66.22'],
  france: ['58.29A', '58.29B', '58.29C', '62.01Z', '62.02A', '64.19Z', '65.12Z', '66.19B', '66.30Z', '86.10Z', '86.21Z', '86.23Z', '49.41A', '49.41B', '41.20B', '55.10Z', '28.99B',
    '69.10Z', '69.20Z', '68.31Z', '71.11Z', '71.12B', '75.00Z', '79.11Z', '79.12Z', '78.10Z', '78.20Z', '78.30Z', '73.11Z', '66.22Z'],
  // The professional sectors after 28990 need Companies House parser 3 (engCompaniesHouseCsv.ts).
  companies_house: ['58290', '62012', '62020', '64191', '64192', '65120', '66190', '66300', '86101', '86210', '86230', '49410', '41201', '41202', '55100', '28990',
    '69101', '69102', '69109', '69201', '69202', '69203', '68310', '71111', '71112', '71121', '71122', '71129', '75000', '79110', '79120',
    '78109', '78200', '78300', '73110', '66220'],
  fdic: ['banks'],
  nppes: ['Dentist', 'Clinic/Center', 'General Acute Care Hospital', 'Clinical Medical Laboratory'],
  fmcsa: ['freight_carriers'],
  gleif: Object.keys(HE_ENG_GLEIF_TERMS),
  osm: Object.keys(HE_ENG_OSM_TAGS),
  // Bank of England lists of PRA-authorised firms (engPraRegistry.ts).
  pra: ['insurers', 'banks'],
  // ESMA register of AIF and UCITS managers in the EU/EEA (engEsmaRegistry.ts).
  esma: ['fund_managers'],
  // EBA register of PSD2 payment and e-money institutions in the EU/EEA (engEbaRegistry.ts).
  eba: ['payment_institutions'],
  // National registers filing NACE classes (engNaceRegistryCatalog.ts): Finland, Czechia, Ireland, Estonia, Sweden
  // and Germany's energy market register; a category is a NACE Rev. 2.1 class.
  prh: HE_ENG_NACE_CLASSES, czso: HE_ENG_NACE_CLASSES, cro: HE_ENG_NACE_CLASSES, ariregister: HE_ENG_NACE_CLASSES, scb: HE_ENG_NACE_CLASSES,
  mastr: HE_ENG_NACE_CLASSES,
  // The EU Transparency Register's organisations of any country by registration category (engEuTransparencyRegistry.ts).
  eu_transparency: Object.keys(HE_ENG_EU_TRANSPARENCY_CATEGORIES),
  // Wikidata organisations of a sector in any country (engWikidataRegistry.ts).
  wikidata: Object.keys(HE_ENG_WIKIDATA_SECTORS),
  // US lists: companies filing with the SEC by SIC sector and SEC-registered investment
  // advisers, both in any country (engSecCompanyRegistry.ts, engSecAdviserRegistry.ts);
  // IRS tax-exempt organisations and NCES colleges, school districts and private schools
  // in the US (engIrsRegistry.ts, engNcesRegistry.ts).
  sec_companies: Object.keys(HE_ENG_SEC_SIC_SECTORS), sec_advisers: ['investment_advisers'],
  irs: Object.keys(HE_ENG_IRS_CATEGORIES), nces: HE_ENG_NCES_CATEGORIES,
  // UK lists: charities in England and Wales (Charity Commission), schools, colleges and academy trusts in England
  // (GIAS), health and social care providers in England (CQC); US credit unions (NCUA call reports).
  charity_commission: HE_ENG_CHARITY_COMMISSION_CATEGORIES, gias: HE_ENG_GIAS_CATEGORIES, cqc: HE_ENG_CQC_CATEGORIES, ncua: ['credit_unions'],
};

type NationalProvider = Exclude<HeEngRegistryProvider, 'gleif' | 'osm' | 'esma' | 'eba' | 'wikidata' | 'sec_companies' | 'sec_advisers' | 'eu_transparency'>;
const PROVIDER_ISO: Readonly<Record<NationalProvider, string>> = {
  brreg: 'no', france: 'fr', companies_house: 'gb', fdic: 'us', nppes: 'us', fmcsa: 'us', pra: 'gb',
  prh: 'fi', czso: 'cz', cro: 'ie', ariregister: 'ee', irs: 'us', nces: 'us', charity_commission: 'gb', gias: 'gb', cqc: 'gb', ncua: 'us',
  scb: 'se', mastr: 'de',
};
/** Sources covering many countries: one slice per sector reads all allowed countries. */
export const HE_ENG_GLOBAL_REGISTRY_PROVIDERS: ReadonlySet<HeEngRegistryProvider> = new Set(['gleif', 'osm', 'esma', 'eba', 'wikidata',
  'sec_companies', 'sec_advisers', 'eu_transparency']);
// The EU authorities' registers hold firms of the EU and the EEA only.
const EEA_REGISTRY_PROVIDERS: ReadonlySet<HeEngRegistryProvider> = new Set(['esma', 'eba']);
/** A global source's countries. */
function providerCovers(provider: HeEngRegistryProvider, country: string): boolean {
  return !EEA_REGISTRY_PROVIDERS.has(provider) || Object.hasOwn(HE_ENG_ESMA_MEMBER_STATES, engCountryIso2(country) ?? '');
}
// A plan over this throws and the base cannot start. Each NACE register adds a
// slice per class of the brief for its own country: ten countries and five
// broad hypotheses make about 140 slices; a brief naming every sector in ten or
// twenty countries, with the US, Swedish and German lists, about 390.
const MAX_TASKS = 500;
const MAX_TASK_COUNTRIES = 40;
// An EU register slice is read whole and paged within the 80-page safety limit
// (2 000 firms); ten countries stay under it. ESMA holds about 3 200 managers in
// all 30 member states, EBA 1 242 authorised payment firms (October 2026).
const EEA_MAX_TASK_COUNTRIES = 10;
function maxTaskCountries(provider: HeEngRegistryProvider): number {
  return EEA_REGISTRY_PROVIDERS.has(provider) ? EEA_MAX_TASK_COUNTRIES : MAX_TASK_COUNTRIES;
}
// OpenStreetMap maps premises, mostly small businesses, and never a headcount:
// a scope of 50+ employees would only spend company checks on them.
const OSM_MAX_MIN_EMPLOYEES = 50;
type Sector = { match: RegExp; omit?: RegExp; sources: Partial<Record<HeEngRegistryProvider, readonly string[]>> };
// «K-12 edtech companies», «higher education software vendors», «hedge fund administrators»: sellers to a segment, not the segment.
const SELLERS = String.raw`(?!\s+(?:software|technology|tech|edtech|ed-tech|platforms?|solutions?|vendors?|suppliers?|providers?|service\s+providers?|administrat\w*|marketing|market|apps?|tools?|products?|publishers?|curriculum))`;
// After an education segment, «companies» and «businesses» sell to it too.
const EDUCATION_SELLERS = String.raw`(?!\s+(?:companies|businesses|firms|startups|software|technology|tech|edtech|ed-tech|platforms?|solutions?|vendors?|suppliers?|service\s+providers?|marketing|market|apps?|tools?|products?|publishers?|curriculum|consult\w*))`;
// After a care segment, «providers» and «operators» are the segment itself; software, suppliers and agencies sell to it
// («care home management software», «care home staffing agencies», «GP practice management systems»).
const CARE_SELLERS = String.raw`(?!\s+(?:(?:management|scheduling|rostering|staffing|recruitment|training|booking|planning|monitoring|compliance|payroll|hr|crm|erp|records?|food|catering|cleaning|laundry|medication|pharmacy|nurse\s+call|call|insurance|furniture|it(?:\s+support)?|telecare|transport|legal|accounting)\s+(?:software|systems?|platforms?|solutions?|vendors?|suppliers?|providers?|agenc(?:y|ies)|companies|firms|services|brokers?)|software|technology|tech|platforms?|solutions?|vendors?|suppliers?|marketing|market|apps?|tools?|products?|equipment|consult\w*))`;
const PRIVATE_SCHOOL_KINDS = 'private|independent|boarding|parochial|catholic|christian|religious|montessori|waldorf';
// «Schools» on its own counts at the start of a phrase or after «and»/«or»/a comma; «trade schools», «dental schools» and «schools of nursing» do not.
const BARE_SCHOOLS = String.raw`|(?:^|[,;/&(]\s*|\b(?:and|or)\s+)schools\b(?!\s+of\b)${EDUCATION_SELLERS}`;
// Official classifications: Brreg SN, INSEE NAF rev.2, Companies House condensed
// SIC, CMS taxonomy. These are discovery categories, not evidence of suitability.
const SECTORS: readonly Sector[] = [
  { match: /\b(?:software (?:vendors?|companies|developers?|providers?|products?|publishers?|publishing)|saas|it (?:services?|companies|consultanc(?:y|ies))|cloud (?:platform|software) vendors?)\b/i,
    // Standard software publishers are explicitly outside NAF 62.01Z.
    sources: { brreg: ['58.29', '62'], france: ['58.29A', '58.29B', '58.29C', '62.01Z', '62.02A'], companies_house: ['58290', '62012', '62020'],
      gleif: ['software'], osm: ['software'], wikidata: ['software'], sec_companies: ['software'], ...heEngNaceSources('software') } },
  { match: /\b(?:banks?|banking institutions|credit institutions|building societies)\b/i,
    // Custody specialists do not authorize scanning every retail/commercial bank; food, blood and data banks are not banks.
    omit: /\b(?:custodian|custodial|custody|depositary|depository|food|blood|data|power|memory|sperm|seed|milk|tissue|organ|eye|gene|diaper|baby|clothing|toy|time|piggy)[ -]+banks?\b/gi,
    sources: { brreg: ['64'], france: ['64.19Z'], companies_house: ['64191', '64192'], fdic: ['banks'], gleif: ['banks'], osm: ['banks'], pra: ['banks'], wikidata: ['banks'],
      sec_companies: ['banks'], ncua: ['credit_unions'], ...heEngNaceSources('banks') } },
  { match: /\bcredit unions?\b/i,
    sources: { ncua: ['credit_unions'] } },
  { match: /\b(?:fund (?:services?|administrators?|administration)|custodians?|depositar(?:y|ies)|transfer agents?|investor services?|mancos?)\b/i,
    // Third-party management companies are fund service providers; ESMA lists them.
    sources: { brreg: ['66'], france: ['66.19B', '66.30Z'], companies_house: ['66190', '66300'], gleif: ['fund_services'], esma: ['fund_managers'],
      ...heEngNaceSources('fund_services') } },
  // Hedge fund, private equity and venture capital managers and family offices manage funds too;
  // most American ones are SEC-registered advisers.
  { match: new RegExp(String.raw`\b(?:(?:asset|wealth|investment|fund|portfolio) manag(?:ers?|ement(?: firms| companies)?)|(?:registered )?investment advis(?:e|o)rs?|hedge funds?|private equity (?:firms?|funds?|companies|managers?|houses?)|venture capital (?:firms?|funds?)|vc firms?|family offices?)${SELLERS}\b`, 'i'),
    sources: { brreg: ['66'], france: ['66.30Z'], companies_house: ['66300'], gleif: ['asset_management'], esma: ['fund_managers'],
      wikidata: ['asset_management'], sec_advisers: ['investment_advisers'], sec_companies: ['asset_management'], ...heEngNaceSources('asset_management') } },
  { match: /\b(?:insurers?|reinsurers?|insurance (?:carriers?|companies))\b/i,
    sources: { brreg: ['65'], france: ['65.12Z'], companies_house: ['65120'], gleif: ['insurance'], osm: ['insurance'], pra: ['insurers'], wikidata: ['insurance'],
      sec_companies: ['insurance'], ...heEngNaceSources('insurance') } },
  // Licensed under PSD2: payment and e-money institutions and account information providers.
  { match: /\b(?:payments? (?:institutions?|companies|firms|providers?|processors?|platforms?|gateways?|service providers?|fintechs?)|psps?|e-?money (?:institutions?|issuers?|providers?)|electronic money (?:institutions?|issuers?)|(?:merchant|card|payment) acquir(?:ers?|ing (?:banks?|companies|providers?))|money (?:transfer|remittance) (?:operators?|companies|providers?|services?)|remittance (?:companies|providers?|operators?)|paytech (?:companies|firms|providers?)|account information (?:service )?providers?|open banking (?:providers?|platforms?|companies))\b/i,
    sources: { eba: ['payment_institutions'] } },
  { match: /\b(?:dentists?|dental (?:clinics?|practices?|groups?|offices?))\b/i,
    sources: { brreg: ['86.23'], france: ['86.23Z'], companies_house: ['86230'], nppes: ['Dentist'], osm: ['dental'], wikidata: ['dental'], cqc: ['dental'], ...heEngNaceSources('dental') } },
  { match: /\bhospitals?\b/i,
    sources: { brreg: ['86.10'], france: ['86.10Z'], companies_house: ['86101'], nppes: ['General Acute Care Hospital'],
      gleif: ['hospitals'], osm: ['hospitals'], wikidata: ['hospitals'], irs: ['hospitals'], sec_companies: ['hospitals'], cqc: ['hospitals'],
      ...heEngNaceSources('hospitals') } },
  { match: /\b(?:(?:medical|outpatient|healthcare|primary care) (?:clinics?|cent(?:er|re)s?|practices?)|physician groups)\b/i,
    sources: { brreg: ['86.2'], france: ['86.21Z'], companies_house: ['86210'], nppes: ['Clinic/Center'], osm: ['clinics'], wikidata: ['clinics'], irs: ['clinics'],
      sec_companies: ['clinics'], cqc: ['clinics'], ...heEngNaceSources('clinics') } },
  { match: new RegExp(String.raw`\b(?:gp (?:practices?|surger(?:y|ies))|general (?:medical )?practices?|general practitioners?|doctors'? surger(?:y|ies)|family (?:medicine|practice) (?:practices?|clinics?))${CARE_SELLERS}\b`, 'i'),
    // «General practice» is also a law, accounting or surveying firm's: «general practice (chartered) surveyors», «solicitors in general practice».
    omit: /\b(?:solicitors?|lawyers?|law\s+firms?|attorneys?|accountants?|accounting\s+firms?|cpas?|surveyors?|vets?|veterinar\w*)\s+in\s+general\s+practices?\b|\bgeneral\s+practices?\s+(?:(?!(?:and|or)\b)[a-z]+\s+){0,2}?(?:solicitors?|lawyers?|law|legal|attorneys?|firms?|account\w*|cpas?|surveyors?|veterinar\w*|vets?)\b/gi,
    sources: { cqc: ['gp_practices'] } },
  // Residential and home care: CQC-registered providers in England.
  { match: new RegExp(String.raw`\b(?:care homes?|nursing homes?|residential care (?:homes?|providers?)|home ?care (?:providers?|agenc(?:y|ies)|companies)|domiciliary care|supported living|social care providers?|adult social care|assisted living|elderly care (?:homes?|providers?)|retirement homes?)${CARE_SELLERS}\b`, 'i'),
    sources: { cqc: ['care_homes', 'home_care'] } },
  { match: /\b(?:clinical|medical|diagnostic) laborator(?:y|ies)\b/i,
    sources: { nppes: ['Clinical Medical Laboratory'], gleif: ['laboratories'], osm: ['laboratories'], wikidata: ['laboratories'], sec_companies: ['laboratories'] } },
  { match: /\b(?:trucking|road (?:freight|haulage)|freight carriers?|haulage (?:companies|operators)|truck (?:fleets?|operators?))\b/i,
    sources: { brreg: ['49.41'], france: ['49.41A', '49.41B'], companies_house: ['49410'], fmcsa: ['freight_carriers'],
      gleif: ['trucking'], osm: ['trucking'], wikidata: ['trucking'], sec_companies: ['trucking'], ...heEngNaceSources('trucking') } },
  { match: /\b(?:construction (?:companies|contractors|firms)|building contractors|general contractors)\b/i,
    sources: { brreg: ['41'], france: ['41.20B'], companies_house: ['41201', '41202'], gleif: ['construction'], osm: ['construction'], wikidata: ['construction'],
      sec_companies: ['construction'], ...heEngNaceSources('construction') } },
  { match: /\b(?:hotels?|hotel (?:groups?|chains?|operators?))\b/i,
    sources: { brreg: ['55.10'], france: ['55.10Z'], companies_house: ['55100'], gleif: ['hotels'], osm: ['hotels'], wikidata: ['hotels'],
      sec_companies: ['hotels'], ...heEngNaceSources('hotels') } },
  { match: /\b(?:machinery (?:manufacturers?|companies)|industrial equipment manufacturers?)\b/i,
    sources: { brreg: ['28'], france: ['28.99B'], companies_house: ['28990'], gleif: ['machinery'], wikidata: ['machinery'], sec_companies: ['machinery'], ...heEngNaceSources('machinery') } },
  // Professional and service sectors: OpenStreetMap premises, GLEIF legal names
  // where such firms hold LEIs, and the national registers by activity code
  // (UK SIC, French NAF, Norwegian SN, and NACE in Finland, Czechia, Ireland, Estonia).
  { match: /\binsurance (?:brokers?|broking|brokerages?|agenc(?:y|ies)|agents?)\b/i,
    sources: { brreg: ['66.22'], france: ['66.22Z'], companies_house: ['66220'], gleif: ['insurance_brokers'], osm: ['insurance'],
      wikidata: ['insurance_brokers'], sec_companies: ['insurance_brokers'], ...heEngNaceSources('insurance_brokers') } },
  { match: /\b(?:law (?:firms?|offices?|practices?)|lawyers?|attorneys?|solicitors?|barristers?|legal (?:practices?|firms?))\b/i,
    sources: { brreg: ['69.1'], france: ['69.10Z'], companies_house: ['69101', '69102', '69109'], gleif: ['law_firms'], osm: ['law_firms'],
      wikidata: ['law_firms'], eu_transparency: ['law_firms'], ...heEngNaceSources('law_firms') } },
  { match: /\b(?:accounting (?:firms?|practices?|offices?)|accountants?|accountancy (?:firms?|practices?)|bookkeep(?:ers?|ing (?:firms?|services?))|tax (?:advis(?:ers?|ors?|ory firms?)|consultants?)|audit(?:ing)? firms?|auditors?|cpa firms?)\b/i,
    sources: { brreg: ['69.2'], france: ['69.20Z'], companies_house: ['69201', '69202', '69203'], gleif: ['accounting'], osm: ['accounting'],
      wikidata: ['accounting'], ...heEngNaceSources('accounting') } },
  { match: /\b(?:real estate (?:agenc(?:y|ies)|agents?|brokers?|brokerages?|offices?)|estate agen(?:ts?|cies|cy)|realtors?|letting agen(?:ts?|cies|cy)|property (?:managers?|management (?:companies|firms)))\b/i,
    sources: { brreg: ['68.31'], france: ['68.31Z'], companies_house: ['68310'], osm: ['real_estate_agencies'], wikidata: ['real_estate_agencies'],
      sec_companies: ['real_estate_agencies'], ...heEngNaceSources('real_estate_agencies') } },
  { match: /\b(?:architects?|architecture (?:firms?|practices?|studios?|offices?)|architectural (?:firms?|practices?))\b/i,
    sources: { brreg: ['71.11'], france: ['71.11Z'], companies_house: ['71111', '71112'], osm: ['architects'], wikidata: ['architects'], ...heEngNaceSources('architects') } },
  { match: /\b(?:engineering (?:firms?|consultanc(?:y|ies)|consultants?|offices?)|consulting engineers?)\b/i,
    sources: { brreg: ['71.12'], france: ['71.12B'], companies_house: ['71121', '71122', '71129'], osm: ['engineering'], wikidata: ['engineering'], sec_companies: ['engineering'], ...heEngNaceSources('engineering') } },
  { match: /\b(?:veterinar(?:y|ians?) (?:clinics?|practices?|hospitals?)|veterinarians?|vet (?:clinics?|practices?)|animal (?:clinics?|hospitals?))\b/i,
    sources: { brreg: ['75'], france: ['75.00Z'], companies_house: ['75000'], osm: ['veterinary'], wikidata: ['veterinary'], ...heEngNaceSources('veterinary') } },
  { match: /\b(?:pharmac(?:y|ies)|drugstores?|chemists?)\b/i,
    sources: { osm: ['pharmacies'], wikidata: ['pharmacies'], sec_companies: ['pharmacies'] } },
  { match: /\b(?:(?:car|auto(?:mobile)?|vehicle|motor) dealer(?:s|ships?)?|dealerships?)\b/i,
    sources: { osm: ['car_dealers'], wikidata: ['car_dealers'], sec_companies: ['car_dealers'] } },
  { match: /\b(?:gyms?|fitness (?:clubs?|cent(?:er|re)s?|studios?|chains?)|health clubs?)\b/i,
    sources: { osm: ['fitness'], wikidata: ['fitness'] } },
  { match: /\b(?:beauty (?:salons?|studios?|parlou?rs?|clinics?)|spas?|nail (?:salons?|studios?)|hair (?:salons?|studios?)|hairdressers?|barber(?:s|shops?)?)\b/i,
    sources: { osm: ['beauty'] } },
  { match: /\b(?:restaurants?|caf(?:e|é)s?|bistros?|eateries|coffee shops?)\b/i,
    sources: { osm: ['restaurants'], wikidata: ['restaurants'], sec_companies: ['restaurants'] } },
  { match: /\b(?:travel agen(?:ts?|cies|cy)|tour operators?)\b/i,
    sources: { brreg: ['79.1'], france: ['79.11Z', '79.12Z'], companies_house: ['79110', '79120'], osm: ['travel_agencies'], wikidata: ['travel_agencies'], ...heEngNaceSources('travel_agencies') } },
  { match: /\b(?:recruit(?:ment|ing) (?:agenc(?:y|ies)|firms?|companies)|staffing (?:agenc(?:y|ies)|firms?|companies)|employment agenc(?:y|ies)|headhunt(?:ers?|ing firms?)|executive search firms?)\b/i,
    sources: { brreg: ['78'], france: ['78.10Z', '78.20Z', '78.30Z'], companies_house: ['78109', '78200', '78300'], osm: ['recruitment'], wikidata: ['recruitment'],
      sec_companies: ['recruitment'], ...heEngNaceSources('recruitment') } },
  { match: /\b(?:marketing|advertising|digital|creative|branding|pr|media) agenc(?:y|ies)\b/i,
    sources: { brreg: ['73.11'], france: ['73.11Z'], companies_house: ['73110'], osm: ['marketing_agencies'], wikidata: ['marketing_agencies'],
      sec_companies: ['marketing_agencies'], ...heEngNaceSources('marketing_agencies') } },
  { match: /\b(?:physiotherap(?:y|ists?)|physical therap(?:y|ists?)|physio (?:clinics?|practices?))\b/i,
    sources: { osm: ['physiotherapy'] } },
  { match: /\b(?:opticians?|optometrists?|optical (?:stores?|shops?)|eyewear (?:stores?|shops?))\b/i,
    sources: { osm: ['opticians'] } },
  { match: /\b(?:language schools?|driving schools?)\b/i,
    sources: { osm: ['schools'] } },
  // US lists of whole segments: public companies (SEC), nonprofits and foundations (IRS),
  // colleges and schools (NCES, IRS).
  { match: /\b(?:public(?:ly)?[ -](?:traded|listed|held|quoted) (?:companies|firms|corporations|issuers|businesses)|listed (?:companies|corporations|issuers)|(?:nyse|nasdaq|stock exchange)[ -]listed (?:companies|firms|corporations)|sec[ -](?:registrants|filers|reporting (?:companies|issuers)))\b/i,
    sources: { sec_companies: ['public_companies'] } },
  // The organisations themselves, not «nonprofit hospitals»: their own sector reads them.
  { match: new RegExp(String.raw`\b(?:nonprofits|non-profits|not-for-profits|(?:nonprofit|non-profit|not-for-profit|charitable|voluntary) (?:organi[sz]ations?|sector|groups?)|charities|ngos?)${SELLERS}\b|\b501\(c\)\(3\)(?:s\b|(?!\w))`, 'i'),
    sources: { irs: ['charities'], charity_commission: ['charities'], eu_transparency: ['ngos'] } },
  { match: /\b(?:(?:private|family|charitable|philanthropic|grant-?making|community|corporate) foundations?|grant-?makers?|philanthropic organi[sz]ations?)\b/i,
    sources: { irs: ['foundations'], charity_commission: ['foundations'] } },
  { match: /\b(?:trade (?:associations?|bodies|organi[sz]ations)|industry (?:associations?|bodies)|business (?:associations?|leagues?)|professional (?:associations?|bodies|societies)|membership (?:associations?|organi[sz]ations)|chambers? of commerce)\b/i,
    sources: { irs: ['trade_associations'], eu_transparency: ['trade_associations', 'professional_associations'] } },
  // Organisations of any country that represent interests to the EU (the EU Transparency Register): consultancies,
  // think tanks, public affairs. IT, engineering and tax consultancies have their own sectors.
  { match: new RegExp(String.raw`\b(?:(?:management|strategy|business|public affairs|policy|political|communications?|pr) consult(?:ing|anc(?:y|ies)|ants?)(?: (?:firms?|companies|agencies))?|consulting (?:firms?|companies)|consultanc(?:y|ies) (?:firms?|companies))${SELLERS}\b`, 'i'),
    omit: /\b(?:it|ict|tech|technology|software|engineering|environmental|tax|hr|recruitment|security|cyber(?:security)?|data|cloud|digital|sap|erp|crm)[ -]+consult(?:ing|anc(?:y|ies)|ants?)(?: (?:firms?|companies|agencies))?\b/gi,
    sources: { eu_transparency: ['consultancies'] } },
  // «Market research institutes» sell research; they are not think tanks.
  { match: new RegExp(String.raw`\b(?:think[ -]?tanks?|policy (?:institutes?|research (?:institutes?|cent(?:er|re)s?))|(?<!\b(?:market|opinion|clinical|contract)\s)research institut(?:es?|ions?))${SELLERS}\b`, 'i'),
    sources: { eu_transparency: ['think_tanks'] } },
  // Organisations that lobby, not the consultancies that do it for them (the sector above) or the vendors that sell to them.
  { match: new RegExp(String.raw`\b(?:lobby(?:ing|ists?)(?! (?:firms?|consult\w*|agenc(?:y|ies)))(?: (?:groups?|organi[sz]ations?))?|public affairs(?! (?:consult\w*|agenc(?:y|ies)|firms?|advis\w*))|government (?:relations|affairs)|eu affairs)${SELLERS}\b`, 'i'),
    sources: { eu_transparency: ['companies', 'trade_associations'] } },
  { match: /\blobbying (?:firms?|consult\w*|agenc(?:y|ies))\b/i,
    sources: { eu_transparency: ['consultancies'] } },
  // Plurals and named kinds only: «college graduates» or «university hospitals» are not buyers here.
  { match: new RegExp(String.raw`\b(?:universities|colleges|community colleges?|higher[ -]education(?:\s+(?:institutions?|providers?|organi[sz]ations))?|institutions? of higher (?:education|learning)|(?:private|public|state|liberal arts|technical|research) (?:universit(?:y|ies)|colleges?))${EDUCATION_SELLERS}\b`, 'i'),
    sources: { nces: ['colleges'], irs: ['higher_education'], gias: ['colleges'], eu_transparency: ['academic'] } },
  // Schools: public ones are bought for by their district; a private school buys for itself.
  { match: new RegExp(String.raw`\b(?:k-?12 (?:schools?|school districts?|districts?|education)|school districts?|public schools?|charter schools?|(?:primary|secondary|elementary|middle|high) schools|public (?:and|or|&) private schools|private (?:and|or|&) public schools)${EDUCATION_SELLERS}\b${BARE_SCHOOLS}`, 'i'),
    sources: { nces: ['school_districts'], gias: ['state_schools', 'academy_trusts'] } },
  // English terms: an academy trust runs state schools; in American usage a «state school» is a state university.
  { match: new RegExp(String.raw`\b(?:(?:multi-?)?academy trusts?|state schools)${EDUCATION_SELLERS}\b`, 'i'),
    sources: { gias: ['state_schools', 'academy_trusts'] } },
  { match: new RegExp(String.raw`\b(?:k-?12 (?:schools?(?!\s+districts?)|education)|(?:${PRIVATE_SCHOOL_KINDS})(?:(?:,| and| or| &)\s+(?:${PRIVATE_SCHOOL_KINDS}))* schools?|(?:primary|secondary|elementary|middle|high) schools|public (?:and|or|&) private schools|private (?:and|or|&) public schools)${EDUCATION_SELLERS}\b${BARE_SCHOOLS}`, 'i'),
    sources: { nces: ['private_schools'], irs: ['schools'], gias: ['independent_schools'] } },
  { match: /\b(?:co-?working (?:spaces?|operators?|cent(?:er|re)s?)|shared office (?:spaces?|providers?))\b/i,
    sources: { osm: ['coworking'] } },
  { match: /\bnotar(?:y|ies)\b/i,
    sources: { osm: ['notaries'] } },
];

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function fields(task: HeEngRegistryTask): unknown[] {
  const legacy = [task.provider, task.country, task.category, task.minEmployees ?? null, task.maxEmployees ?? null];
  // Preserve every saved API task ID and plan fingerprint byte-for-byte; only a slice that skips earlier ones adds its list.
  const own = task.countries ? [...legacy, task.transport ?? null, task.countries] : task.transport === undefined ? legacy : [...legacy, task.transport];
  return task.exclude ? [...own, { exclude: task.exclude }] : own;
}
// Registers whose categories share records: a CQC provider gives several kinds of care, every Charity Commission
// grant-maker is a charity, an SEC filer of any sector is a public company.
const OVERLAPPING: Partial<Record<HeEngRegistryProvider, (a: string, b: string) => boolean>> = {
  cqc: () => true, charity_commission: () => true, sec_companies: heEngSecSectorsOverlap,
};
/** Every country one slice may return: its own, or each country of a global slice. */
export function heEngRegistryTaskCountries(task: Pick<HeEngRegistryTask, 'country' | 'countries'>): readonly string[] {
  return task.countries ?? [task.country];
}
function taskId(scopeKey: string, task: HeEngRegistryTask): string { return hash([scopeKey, ...fields(task)]).slice(0, 24); }
function fingerprint(scopeKey: string, tasks: readonly HeEngRegistryTask[]): string {
  // Arrays deliberately survive PostgreSQL JSONB's object-key reordering.
  return hash([1, scopeKey, tasks.map(task => [task.id, ...fields(task)])]);
}
function audienceClause(raw: string | undefined): string {
  const clause = sliceWholeChars(stripUnstorableJsonChars(raw ?? ''), 0, 1000).replace(/https?:\S+|\S+@\S+/gi, ' ')
    .replace(/^(?:these are|targets? (?:are|include)|companies include)\s+/i, '')
    .split(/\b(?:with|where|whose|which|that|serving|serve|helping|help|selling|sold|providing|for|to|using|used|needing|seeking|targeting|supporting|focused)\b|[.;]/i)[0];
  // An exclusion is not another buyer category. Keep affirmative clauses,
  // including "not banks but software companies" and "not only ... but also".
  // For an ambiguous trailing exclusion, ordinary search can recover candidates;
  // never turn its excluded industry into a new registry scan.
  return clause
    .replace(/\(\s*(?:not(?!\s+only\b)|no|without|exclud(?:e[sd]?|ing)|except)\b[^)]*\)/gi, ' ')
    .replace(/\bnon-(?!profits?\b)[a-z]+\b/gi, ' ')
    .split(/\bbut(?:\s+(?:also|instead))?\b/i)
    .map(part => part.split(/\b(?:not(?!\s+only\b)|no|without|exclud(?:e[sd]?|ing)|except|other\s+than|rather\s+than|instead\s+of)\b/i)[0])
    .join(' ');
}

export function createHeEngRegistryPlan(input: {
  scopeKey: string;
  hypotheses: ReadonlyArray<{ title: string; description?: string }>;
  allowedCountries: readonly string[];
  employeeRange?: { min: number; max: number | null };
}): HeEngRegistryPlan {
  if (!input.scopeKey || input.scopeKey.length > 256 || stripUnstorableJsonChars(input.scopeKey) !== input.scopeKey ||
    !input.hypotheses.length || !input.allowedCountries.length) {
    throw new Error('ENG registries require a scope, selected hypotheses and explicit countries.');
  }
  const range = input.employeeRange;
  if (range && (!Number.isSafeInteger(range.min) || range.min < 0 ||
    (range.max !== null && (!Number.isSafeInteger(range.max) || range.max < range.min)))) {
    throw new Error('ENG registry employee range is invalid.');
  }
  const countries = [...new Set(input.allowedCountries.map(raw => {
    const country = normalizeEngCountry(raw);
    if (!country) throw new Error('ENG registry country is unsupported.');
    return country;
  }))].sort();
  const terms = input.hypotheses.slice(0, 20).flatMap(h => [audienceClause(h.title), audienceClause(h.description)]);
  const selections = new Set<string>();
  for (const sector of SECTORS) if (terms.some(term => sector.match.test(sector.omit ? term.replace(sector.omit, '') : term))) {
    for (const [provider, categories] of Object.entries(sector.sources)) {
      for (const category of categories) selections.add(`${provider}:${category}`);
    }
  }
  const tasks: HeEngRegistryTask[] = [];
  const size = range ? { minEmployees: range.min, ...(range.max !== null ? { maxEmployees: range.max } : {}) } : {};
  for (const country of countries) for (const selected of [...selections].sort()) {
    const [provider, category] = selected.split(':') as [HeEngRegistryProvider, string];
    if (HE_ENG_GLOBAL_REGISTRY_PROVIDERS.has(provider) || PROVIDER_ISO[provider as NationalProvider] !== engCountryIso2(country)) continue;
    const task: HeEngRegistryTask = { id: '', provider, country, category,
      ...(provider === 'companies_house' ? { transport: 'csv' as const } : {}), ...size };
    task.id = taskId(input.scopeKey, task);
    tasks.push(task);
  }
  for (const selected of [...selections].sort()) {
    const [provider, category] = selected.split(':') as [HeEngRegistryProvider, string];
    if (!HE_ENG_GLOBAL_REGISTRY_PROVIDERS.has(provider) || (provider === 'osm' && (range?.min ?? 0) >= OSM_MAX_MIN_EMPLOYEES)) continue;
    const covered = countries.filter(country => providerCovers(provider, country));
    const perTask = maxTaskCountries(provider);
    for (let start = 0; start < covered.length; start += perTask) {
      const task: HeEngRegistryTask = { id: '', provider, country: 'global', category,
        countries: covered.slice(start, start + perTask), ...size };
      task.id = taskId(input.scopeKey, task);
      tasks.push(task);
    }
  }
  // A record of overlapping categories goes to the plan's first slice that reads it: one source per company.
  for (const [index, task] of tasks.entries()) {
    const overlaps = OVERLAPPING[task.provider];
    const earlier = overlaps ? [...new Set(tasks.slice(0, index).filter(other => other.provider === task.provider && other.country === task.country &&
      String(other.countries ?? '') === String(task.countries ?? '') && other.category !== task.category && overlaps(other.category, task.category))
      .map(other => other.category))].sort() : [];
    if (earlier.length) { task.exclude = earlier; task.id = taskId(input.scopeKey, task); }
  }
  if (tasks.length > MAX_TASKS) throw new Error('ENG registry plan is too large.');
  const plan: HeEngRegistryPlan = { version: 1, scopeKey: input.scopeKey, fingerprint: fingerprint(input.scopeKey, tasks), tasks };
  validateHeEngRegistryPlan(plan, input.scopeKey);
  return plan;
}

export function validateHeEngRegistryTask(task: HeEngRegistryTask): void {
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
    Object.keys(task).some(key => !['id', 'provider', 'country', 'countries', 'category', 'transport', 'minEmployees', 'maxEmployees', 'exclude'].includes(key)) ||
    (task.exclude !== undefined && (!OVERLAPPING[task.provider] || !Array.isArray(task.exclude) || !task.exclude.length ||
      task.exclude.some((category, index) => typeof category !== 'string' || category === task.category ||
        !HE_ENG_REGISTRY_CATEGORIES[task.provider]?.includes(category) || (index > 0 && task.exclude![index - 1] >= category)))) ||
    typeof task.id !== 'string' || !/^[a-f0-9]{24}$/.test(task.id) ||
    !Object.hasOwn(HE_ENG_REGISTRY_CATEGORIES, task.provider) ||
    !HE_ENG_REGISTRY_CATEGORIES[task.provider].includes(task.category) ||
    (task.transport !== undefined && (task.transport !== 'csv' || task.provider !== 'companies_house')) ||
    (HE_ENG_GLOBAL_REGISTRY_PROVIDERS.has(task.provider)
      ? task.country !== 'global' || !Array.isArray(task.countries) || !task.countries.length || task.countries.length > maxTaskCountries(task.provider) ||
        task.countries.some((country, index) => typeof country !== 'string' || normalizeEngCountry(country) !== country ||
          !engCountryIso2(country) || !providerCovers(task.provider, country) || (index > 0 && task.countries![index - 1] >= country))
      : task.countries !== undefined || normalizeEngCountry(task.country) !== task.country ||
        engCountryIso2(task.country) !== PROVIDER_ISO[task.provider as NationalProvider]) ||
    (task.minEmployees !== undefined && (!Number.isSafeInteger(task.minEmployees) || task.minEmployees < 0)) ||
    (task.maxEmployees !== undefined && (!Number.isSafeInteger(task.maxEmployees) || task.maxEmployees < (task.minEmployees ?? 0)))) {
    throw new Error('ENG registry task is invalid.');
  }
}

export function validateHeEngRegistryPlan(plan: HeEngRegistryPlan, scopeKey: string): void {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== 4 ||
    plan.version !== 1 || plan.scopeKey !== scopeKey || !scopeKey || scopeKey.length > 256 || stripUnstorableJsonChars(scopeKey) !== scopeKey ||
    !Array.isArray(plan.tasks) || plan.tasks.length > MAX_TASKS) throw new Error('ENG registry plan is invalid.');
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    validateHeEngRegistryTask(task);
    if (task.id !== taskId(scopeKey, task) || seen.has(task.id)) throw new Error('ENG registry task identity is invalid.');
    seen.add(task.id);
  }
  if (plan.fingerprint !== fingerprint(scopeKey, plan.tasks)) throw new Error('ENG registry plan fingerprint is invalid.');
}
