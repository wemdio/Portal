/**
 * Pure helpers for working with LinkedIn lead data.
 *
 * Kept framework-free and side-effect-free so they can be unit-tested in isolation
 * and reused both in the campaign runner and in import / backfill scripts.
 */

/**
 * Extracts the LinkedIn `public_identifier` (the slug after `/in/`) from a profile URL.
 *
 * Handles the variations we see in imported data:
 *  - http(s):// or no protocol
 *  - www / m subdomains
 *  - trailing slash
 *  - query string (?trk=...) and fragment (#about)
 *  - nested paths like /in/<slug>/details/experience
 *
 * Returns `null` for anything that isn't a `/in/<slug>` profile URL — e.g. company pages,
 * feed URLs, empty / null / random text — so callers can safely chain with `??`.
 */
export function extractPublicIdentifier(profileUrl: string | null | undefined): string | null {
  if (!profileUrl || typeof profileUrl !== 'string') return null;
  const trimmed = profileUrl.trim();
  if (!trimmed) return null;

  // Capture the segment that immediately follows "/in/", up to the next "/", "?", "#" or end.
  // Restrict to LinkedIn hosts (linkedin.com / www.linkedin.com / m.linkedin.com / ru.linkedin.com / …).
  const match = trimmed.match(/(?:^|\/\/|\.)linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!match || !match[1]) return null;

  const slug = match[1].trim();
  return slug.length > 0 ? slug : null;
}


/**
 * Куда в CSV легли имя, компания и ссылка на профиль.
 *
 * Заголовки приходят от людей, а не от системы: выгрузка из Sales Navigator
 * называет колонку `Profile URL`, ручная таблица — `Person` и `Компания`,
 * экспорт портала — `name` и `company`. Раньше импорт понимал ровно одно
 * написание (`name`), и файл с любым другим молча импортировался нулём строк:
 * каждая строка отбраковывалась как «нет имени», а оператор видел «принято 0»
 * без единого намёка, что дело в заголовке.
 *
 * BOM снимаем здесь же: Excel сохраняет CSV в UTF-8 с меткой в начале файла,
 * и первый заголовок превращался в `\uFEFFname`, который не совпадал ни с чем.
 */
export interface LeadCsvColumns {
  name: number;
  firstName: number;
  lastName: number;
  position: number;
  company: number;
  profileUrl: number;
  publicId: number;
  linkedinId: number;
  /** Заголовки как их увидел разбор — для сообщения об ошибке. */
  normalized: string[];
}

const LEAD_CSV_ALIASES: Record<Exclude<keyof LeadCsvColumns, 'normalized'>, string[]> = {
  name: ['name', 'full_name', 'fullname', 'person', 'contact', 'полное_имя', 'фио', 'ф.и.о.', 'контакт'],
  firstName: ['first_name', 'firstname', 'имя'],
  lastName: ['last_name', 'lastname', 'surname', 'фамилия'],
  position: ['position', 'title', 'job_title', 'должность', 'позиция'],
  company: ['company', 'organization', 'company_name', 'компания', 'организация'],
  profileUrl: [
    'profile_url', 'linkedin_url', 'linkedin_profile_url', 'linkedin_profile', 'linkedin',
    'linkedin_link', 'url', 'profile', 'ссылка', 'ссылка_на_профиль', 'профиль',
  ],
  publicId: ['public_identifier', 'public_id', 'linkedin_public_identifier'],
  linkedinId: ['linkedin_id', 'provider_id'],
};

export function resolveLeadCsvColumns(headers: string[]): LeadCsvColumns {
  const normalized = headers.map((h) =>
    (h ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, '_'),
  );
  const find = (aliases: string[]) => {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  return {
    name: find(LEAD_CSV_ALIASES.name),
    firstName: find(LEAD_CSV_ALIASES.firstName),
    lastName: find(LEAD_CSV_ALIASES.lastName),
    position: find(LEAD_CSV_ALIASES.position),
    company: find(LEAD_CSV_ALIASES.company),
    profileUrl: find(LEAD_CSV_ALIASES.profileUrl),
    publicId: find(LEAD_CSV_ALIASES.publicId),
    linkedinId: find(LEAD_CSV_ALIASES.linkedinId),
    normalized,
  };
}
