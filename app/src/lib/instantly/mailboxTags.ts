function normalizeTagName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Reserve-pool tags describe mailbox inventory, never project ownership. */
export function isReservedMailboxPoolTag(name: string): boolean {
  const normalized = normalizeTagName(name);
  return normalized === 'неименные' || normalized.startsWith('неименные ');
}
