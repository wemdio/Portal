import type { LeadCreatePayload } from '@/lib/instantly/types';

export function partitionKnownClientCompanies<T>(
  companies: readonly T[],
  knownClientEmails: ReadonlySet<string>,
  emailsOf: (company: T) => readonly string[],
): { fresh: T[]; duplicates: T[] } {
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const company of companies) {
    const emails = Array.from(new Set(
      emailsOf(company).map((email) => email.trim().toLowerCase()).filter(Boolean),
    ));
    if (emails.length > 0 && emails.every((email) => knownClientEmails.has(email))) {
      duplicates.push(company);
    } else {
      fresh.push(company);
    }
  }
  return { fresh, duplicates };
}

/**
 * Отбирает адреса, которых ещё нет ни в одной кампании этого клиента, и сразу
 * резервирует их для следующих сегментов текущего прогона. Set намеренно
 * передаётся снаружи: один и тот же адрес не должен уйти в две Roistat-кампании.
 */
export function reserveFreshClientLeads<T extends Pick<LeadCreatePayload, 'email'>>(
  leads: readonly T[],
  knownClientEmails: Set<string>,
): T[] {
  const fresh: T[] = [];
  for (const lead of leads) {
    const email = lead.email.trim().toLowerCase();
    if (!email || knownClientEmails.has(email)) continue;
    knownClientEmails.add(email);
    fresh.push(lead);
  }
  return fresh;
}
