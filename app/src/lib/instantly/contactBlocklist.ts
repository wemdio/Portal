import { createBlockListEntry, listBlockListEntries } from './client';

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

/** The workspace comes from the campaign, never from a browser-supplied account id. */
export async function blockContact(email: string, accountId: string): Promise<void> {
  const address = normalize(email);
  if (await isContactBlocked(address, accountId)) return;
  try {
    const entry = await createBlockListEntry({ value: address }, {
      accountId, requestPriority: 'interactive', consumer: 'personalization_blocklist',
    });
    if (normalize(entry.value) !== address) throw new Error('Instantly не подтвердил блокировку адреса');
  } catch (error) {
    // Concurrent clicks / an ambiguous POST may have already added this address.
    if (await isContactBlocked(address, accountId)) return;
    throw error;
  }
}
