/**
 * S3 — дешёвый ICP-фильтр (до LLM, чтобы не платить за заведомо мусорные строки).
 * Исключения (en-outreach-flow-improvements §2 шаг 3): конкуренты-лидгенщики,
 * стаффинг/RPO/HR-агентства/джоб-борды, generic digital marketing,
 * B2C/образование/маркетплейсы, размер вне 3–200 (по умолчанию), дубль домена.
 * Исключение «11–50» снято 23.09.2026: у CEO это одна из лучших групп.
 *
 * Правила намеренно консервативные: срабатывание = исключение компании,
 * поэтому паттерны требуют явного отраслевого маркера, а не слова из
 * описания обязанностей SDR (там «outbound» и «leads» — норма, не признак агентства).
 */

// Прямые конкуренты: лидген / appointment setting / outbound-агентства.
const COMPETITOR_NAME_RE =
  /\b(lead\s*gen|leadgen|lead\s*generation|appointment\s*setting|demand\s*gen|outbound|outreach|cold\s*email|sdr\s*as\s*a\s*service|sales\s*as\s*a\s*service|b2b\s*leads?|getleads?|leadmarket)\b/i;

// Лидген-агентство, опознанное по САМООПИСАНИЮ (вакансия/профиль), а не по
// обязанностям SDR: «we are a lead generation agency».
const COMPETITOR_SELF_RE =
  /\b(?:we\s+(?:are|'re)|our\s+(?:company|team|agency)|join(?:ing)?)[^.]{0,60}?\b(?:lead\s*gen(?:eration)?|appointment[-\s]?setting|outbound|demand\s*generation|b2b\s*outreach)\s+(?:agency|agencies|company|companies|firm|partner|provider|services?)\b/i;

const STAFFING_NAME_RE =
  /\b(staffing|recruitment|recruiting|recruiter|headhunt|employment\s+agency|hr\s+agency|rpo|job\s*board|talent\s+acquisition\s+(?:agency|firm|partner))\b/i;

const MARKETING_NAME_RE =
  /\b(digital\s+marketing|marketing\s+agency|creative\s+agency|advertising\s+agency|media\s+agency|\bseo\b|\bppc\b|performance\s+marketing\s+agency|growth\s+marketing\s+agency)\b/i;

const B2C_EDUCATION_NAME_RE =
  /\b(school|academy|university|college|institute\s+of\s+technology|e-?learning|education|courses?|bootcamp|marketplace|classifieds|directory)\b/i;

export type IcpExclusionReason =
  | 'competitor'
  | 'staffing_agency'
  | 'generic_marketing'
  | 'b2c_or_education'
  | 'size_out_of_range'
  | 'duplicate_domain';

export interface IcpFilterInput {
  companyName: string;
  companyDescription: string | null;
  vacancyDescription: string | null;
  normalizedDomain: string | null;
  /** Оценка штата: команда YC или середина корзины PDL; null — неизвестно. */
  employees: number | null;
  minEmployees: number;
  maxEmployees: number;
}

export interface IcpFilterResult {
  exclude: boolean;
  reason: IcpExclusionReason | null;
}

export function icpFilter(input: IcpFilterInput, seenDomains: Set<string>): IcpFilterResult {
  const name = input.companyName ?? '';
  const description = `${input.companyDescription ?? ''}\n${input.vacancyDescription ?? ''}`;

  if (COMPETITOR_NAME_RE.test(name) || COMPETITOR_SELF_RE.test(description)) {
    return { exclude: true, reason: 'competitor' };
  }
  if (STAFFING_NAME_RE.test(name)) {
    return { exclude: true, reason: 'staffing_agency' };
  }
  if (MARKETING_NAME_RE.test(name)) {
    return { exclude: true, reason: 'generic_marketing' };
  }
  if (B2C_EDUCATION_NAME_RE.test(name)) {
    return { exclude: true, reason: 'b2c_or_education' };
  }
  if (input.employees != null && (input.employees < input.minEmployees || input.employees > input.maxEmployees)) {
    return { exclude: true, reason: 'size_out_of_range' };
  }
  if (input.normalizedDomain) {
    if (seenDomains.has(input.normalizedDomain)) {
      return { exclude: true, reason: 'duplicate_domain' };
    }
    seenDomains.add(input.normalizedDomain);
  }
  return { exclude: false, reason: null };
}
