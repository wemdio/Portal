/**
 * Detects "role" / generic mailbox addresses (support@, info@, sales@, zakaz@…)
 * as opposed to a specific person's address. Used by the base-constructor
 * «Убрать почты поддержки» step to drop rows whose only email is a generic inbox.
 *
 * Pure + dependency-free → safe to import anywhere (client UI, worker, tests).
 */

// Base local-parts (the part before @). The matcher also flags these when
// followed by a separator or digit — support.team / info-msk / sales2 / zakaz_spb —
// but NOT when they're merely a prefix of a longer word (saleshouse, infomir,
// supportive don't match).
const ROLE_LOCALPARTS = new Set<string>([
  // EN — generic / department / functional inboxes
  'info', 'support', 'help', 'helpdesk', 'sales', 'contact', 'contacts',
  'hello', 'hi', 'team', 'office', 'admin', 'administrator', 'mail', 'email',
  'noreply', 'postmaster', 'webmaster', 'hostmaster', 'abuse', 'billing',
  'accounts', 'accounting', 'finance', 'marketing', 'press', 'pr', 'media',
  'hr', 'jobs', 'job', 'career', 'careers', 'vacancy', 'vacancies', 'feedback',
  'service', 'enquiries', 'enquiry', 'inquiry', 'inquiries', 'general',
  'partners', 'partnership', 'reception', 'secretary', 'order', 'orders',
  'shop', 'store', 'booking', 'reservations',
  // RU (translit) — частые ролевые ящики у русскоязычных компаний
  'zakaz', 'zakazy', 'zakazat', 'zayavka', 'zayavki', 'reklama', 'buh',
  'buhgalteria', 'bukhgalteria', 'sekretar', 'priemnaya', 'ofis', 'podderzhka',
  'pochta', 'sklad', 'opt', 'prodazhi', 'prodaji', 'dostavka', 'magazin',
  'klient', 'klienty',
]);

// Role addresses that aren't a single [a-z]+ token (hyphen/underscore variants).
const ROLE_LOCALPARTS_EXACT = new Set<string>([
  'no-reply', 'no_reply', 'do-not-reply', 'donotreply', 'do_not_reply',
]);

/** Lower-cased local part → is it a generic/role mailbox? */
export function isRoleLocalPart(localRaw: string): boolean {
  const local = localRaw.trim().toLowerCase();
  if (!local) return false;
  if (ROLE_LOCALPARTS.has(local) || ROLE_LOCALPARTS_EXACT.has(local)) return true;
  // A role word immediately followed by a separator or digit: support.team,
  // info-msk, sales2, zakaz_spb. The lookahead means "saleshouse"/"infomir"
  // (role word + letters) do NOT match.
  const m = local.match(/^([a-z]+)(?=[._+\-0-9])/);
  return !!m && ROLE_LOCALPARTS.has(m[1]);
}

/** Is `email` a generic/role mailbox (support@, info@, …)? */
export function isSupportEmail(email: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0) return false;
  return isRoleLocalPart(email.slice(0, at));
}
