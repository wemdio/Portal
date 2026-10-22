/**
 * Discovery vocabulary of the two global ENG sources. Like the national
 * activity codes, these only choose candidates; a company is still admitted by
 * its own website, size evidence and the usual company check.
 *
 * GLEIF (https://api.gleif.org) has no activity code, so a slice searches legal
 * names. Its name filter matches whole words (no substrings, no phrases), which
 * is why German compounds such as «Lebensversicherung» are listed on their own.
 * OpenStreetMap slices use the documented map features
 * (https://wiki.openstreetmap.org/wiki/Map_features).
 */

type Language = 'en' | 'de' | 'nl' | 'fr' | 'es' | 'it' | 'pt' | 'da' | 'sv' | 'no' | 'fi' | 'pl';

/**
 * Name words per sector; English is always searched, other languages by
 * country. Single-practice sectors (dentists, medical practices) are absent:
 * their LEIs are mostly personal holding companies, and OpenStreetMap maps the
 * practices themselves.
 */
export const HE_ENG_GLEIF_TERMS: Readonly<Record<string, Partial<Record<Language, readonly string[]>>>> = {
  software: { en: ['software', 'saas'], de: ['softwareentwicklung'], fr: ['logiciels', 'logiciel'], sv: ['programvara'],
    no: ['programvare'], fi: ['ohjelmisto', 'ohjelmistot'], pl: ['oprogramowanie'] },
  banks: { en: ['bank', 'bancorp', 'bankshares'], de: ['sparkasse', 'volksbank', 'raiffeisenbank', 'landesbank', 'kreissparkasse', 'stadtsparkasse'],
    fr: ['banque'], es: ['banco'], it: ['banca'], pt: ['banco', 'caixa'], da: ['sparekasse', 'andelskasse'],
    sv: ['sparbank', 'sparbanken', 'banken'], no: ['sparebank', 'sparebanken', 'banken'], fi: ['pankki', 'osuuspankki', 'säästöpankki'] },
  fund_services: { en: ['depositary', 'custodian', 'custody', 'trustees', 'registrars'], de: ['verwahrstelle', 'depotbank'], fr: ['dépositaire'] },
  asset_management: { en: ['asset', 'wealth'], de: ['kapitalverwaltungsgesellschaft', 'vermögensverwaltung', 'kvg'], nl: ['vermogensbeheer'],
    fr: ['patrimoine'], es: ['sgiic'], it: ['sgr'], da: ['fondsmæglerselskab', 'kapitalforvaltning'], sv: ['fondbolag', 'kapitalförvaltning'],
    no: ['kapitalforvaltning'], fi: ['rahastoyhtiö', 'varainhoito'], pl: ['tfi'] },
  insurance: { en: ['insurance', 'assurance', 'reinsurance', 'insurer'],
    de: ['versicherung', 'versicherungen', 'lebensversicherung', 'krankenversicherung', 'rückversicherung', 'versicherungsverein'],
    nl: ['verzekering', 'verzekeringen', 'verzekeraar'], fr: ['assurances', 'mutuelle', 'réassurance'], es: ['seguros', 'aseguradora'],
    it: ['assicurazioni', 'assicurazione'], pt: ['seguros'], da: ['forsikring', 'forsikringsselskab'], sv: ['försäkring', 'försäkringar', 'försäkringsbolag'],
    no: ['forsikring'], fi: ['vakuutus', 'vakuutusyhtiö'], pl: ['ubezpieczeń', 'ubezpieczenia'] },
  insurance_brokers: { en: ['brokers', 'broking', 'brokerage'], de: ['versicherungsmakler'], nl: ['assurantiën', 'assurantie'], fr: ['courtage'] },
  hospitals: { en: ['hospital', 'hospitals'], de: ['klinikum', 'krankenhaus', 'kliniken'], nl: ['ziekenhuis'], fr: ['hôpital'], it: ['ospedale'],
    da: ['sygehus'], sv: ['sjukhus'], no: ['sykehus'], fi: ['sairaala'], pl: ['szpital'] },
  laboratories: { en: ['laboratory', 'laboratories', 'labs'], de: ['labor', 'laboratorium'], nl: ['laboratorium'], fr: ['laboratoire'],
    es: ['laboratorio'], it: ['laboratorio'], pt: ['laboratório'], da: ['laboratorium'], sv: ['laboratorium'], no: ['laboratorium'],
    fi: ['laboratorio'], pl: ['laboratorium'] },
  trucking: { en: ['logistics', 'transport', 'haulage', 'freight', 'trucking', 'transportation'], de: ['logistik', 'spedition', 'transporte'],
    nl: ['vervoer', 'logistiek'], fr: ['transports', 'logistique'], es: ['transportes', 'logística'], it: ['trasporti', 'logistica'],
    pt: ['transportes'], da: ['vognmand', 'vognmandsforretning'], sv: ['åkeri', 'logistik'], no: ['logistikk'], fi: ['kuljetus', 'logistiikka'],
    pl: ['logistyka'] },
  construction: { en: ['construction', 'builders', 'contractors'], de: ['bau', 'bauunternehmung', 'hochbau', 'tiefbau', 'baugesellschaft'],
    nl: ['bouw', 'bouwbedrijf'], fr: ['bâtiment', 'btp'], es: ['construcciones', 'constructora'], it: ['costruzioni'],
    pt: ['construções', 'construtora'], da: ['byg', 'entreprenør'], sv: ['bygg', 'byggnads'], no: ['bygg', 'entreprenør'],
    fi: ['rakennus', 'rakennusliike'], pl: ['budownictwo', 'budowlane'] },
  hotels: { en: ['hotel', 'hotels', 'resort', 'resorts'], fr: ['hôtel', 'hôtels'], es: ['hoteles'], it: ['alberghi', 'albergo'], pt: ['hotéis'],
    fi: ['hotelli'] },
  machinery: { en: ['machinery', 'machines'], de: ['maschinenbau', 'maschinen', 'maschinenfabrik'], nl: ['machinebouw'], es: ['maquinaria'],
    it: ['macchine'], pt: ['máquinas'], da: ['maskiner', 'maskinfabrik'], sv: ['maskin', 'maskiner'], no: ['maskin'],
    fi: ['koneet', 'konepaja'], pl: ['maszyny'] },
  law_firms: { en: ['solicitors', 'attorneys', 'lawyers'], de: ['rechtsanwälte', 'rechtsanwaltsgesellschaft', 'rechtsanwalt', 'anwaltskanzlei'],
    nl: ['advocaten', 'advocatenkantoor'], fr: ['avocats'], es: ['abogados'], it: ['avvocati'], pt: ['advogados'],
    da: ['advokatfirma', 'advokatfirmaet', 'advokater'], sv: ['advokatbyrå', 'advokatbyrån'], no: ['advokatfirma', 'advokatfirmaet'],
    fi: ['asianajotoimisto'], pl: ['kancelaria'] },
  accounting: { en: ['accountants', 'accounting', 'auditors', 'accountancy'],
    de: ['steuerberatungsgesellschaft', 'wirtschaftsprüfungsgesellschaft', 'steuerberatung', 'wirtschaftsprüfung'],
    nl: ['administratiekantoor'], fr: ['comptable'], es: ['auditores'], it: ['commercialisti'], pt: ['contabilidade'],
    da: ['revisionsfirma', 'revisorer'], sv: ['revisionsbyrå', 'redovisning'], no: ['revisjon', 'regnskap'], fi: ['tilintarkastus', 'tilitoimisto'],
    pl: ['rachunkowe', 'rachunkowość'] },
};

/** Map features per sector: each [key, value] pair is one accepted tag. */
export const HE_ENG_OSM_TAGS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  software: [['office', 'it'], ['office', 'software']],
  banks: [['amenity', 'bank']],
  insurance: [['office', 'insurance']],
  dental: [['amenity', 'dentist'], ['healthcare', 'dentist']],
  hospitals: [['amenity', 'hospital'], ['healthcare', 'hospital']],
  clinics: [['amenity', 'clinic'], ['healthcare', 'clinic'], ['amenity', 'doctors']],
  laboratories: [['healthcare', 'laboratory']],
  trucking: [['office', 'logistics'], ['office', 'moving_company'], ['office', 'courier']],
  construction: [['office', 'construction_company'], ['craft', 'builder']],
  hotels: [['tourism', 'hotel']],
  law_firms: [['office', 'lawyer']],
  accounting: [['office', 'accountant'], ['office', 'tax_advisor']],
  real_estate_agencies: [['office', 'estate_agent']],
  architects: [['office', 'architect']],
  engineering: [['office', 'engineer']],
  veterinary: [['amenity', 'veterinary']],
  pharmacies: [['amenity', 'pharmacy'], ['healthcare', 'pharmacy']],
  car_dealers: [['shop', 'car']],
  fitness: [['leisure', 'fitness_centre']],
  beauty: [['shop', 'beauty'], ['shop', 'hairdresser']],
  restaurants: [['amenity', 'restaurant'], ['amenity', 'cafe']],
  travel_agencies: [['shop', 'travel_agency'], ['office', 'travel_agent']],
  recruitment: [['office', 'employment_agency']],
  marketing_agencies: [['office', 'advertising_agency']],
  physiotherapy: [['healthcare', 'physiotherapist']],
  opticians: [['shop', 'optician']],
  schools: [['amenity', 'language_school'], ['amenity', 'driving_school']],
  coworking: [['office', 'coworking'], ['amenity', 'coworking_space']],
  notaries: [['office', 'notary']],
};

// Official and widely used business languages by ISO 3166-1 alpha-2 code.
const COUNTRY_LANGUAGES: Readonly<Record<string, readonly Language[]>> = {
  de: ['de'], at: ['de'], li: ['de'], ch: ['de', 'fr', 'it'], nl: ['nl'], be: ['nl', 'fr'], lu: ['fr', 'de'], fr: ['fr'], mc: ['fr'],
  es: ['es'], it: ['it'], sm: ['it'], pt: ['pt'], br: ['pt'], dk: ['da'], se: ['sv'], no: ['no'], fi: ['fi', 'sv'], pl: ['pl'],
  mx: ['es'], ar: ['es'], cl: ['es'], co: ['es'], pe: ['es'], ca: ['fr'],
};

/** Up to 40 distinct name words for one GLEIF slice over these countries. */
export function heEngGleifTerms(category: string, iso2: readonly string[]): string[] {
  const terms = HE_ENG_GLEIF_TERMS[category];
  if (!terms) return [];
  const languages = new Set<Language>(['en', ...iso2.flatMap(code => COUNTRY_LANGUAGES[code.toLowerCase()] ?? [])]);
  return [...new Set([...languages].flatMap(language => terms[language] ?? []))].slice(0, 40);
}
