import { listBlockListEntries } from './client';

const normalize = (value: string) => value.trim().toLowerCase();

/** Provider search is a substring search: only an exact email/domain match blocks. */
async function contains(value: string, accountId: string, domainsOnly = false): Promise<boolean> {
  let startingAfter: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = await listBlockListEntries(
      { search: value, limit: 100, starting_after: startingAfter, ...(domainsOnly ? { domains_only: true } : {}) },
      { accountId, requestPriority: 'interactive', consumer: 'personalization_blocklist' },
    );
    if (result.items.some((entry) => normalize(entry.value) === value)) return true;
    const next = result.next_starting_after;
    if (!next) return false;
    if (seen.has(next)) break;
    seen.add(next);
    startingAfter = next;
  }
  // Never turn an incomplete provider read into permission to send.
  throw new Error('Не удалось полностью проверить стоп-лист Instantly. Повторите попытку.');
}

export async function isContactBlocked(email: string, accountId: string): Promise<boolean> {
  const address = normalize(email);
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address)) {
    throw new Error('Не удалось определить email контакта');
  }
  if (await contains(address, accountId)) return true;
  return contains(address.slice(address.lastIndexOf('@') + 1), accountId, true);
}
