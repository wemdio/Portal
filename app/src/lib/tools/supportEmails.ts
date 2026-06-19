/**
 * Detects SUPPORT / service / system mailbox addresses (support@, help@, zakaz@,
 * billing@, hr@, noreply@ …) — inboxes that aren't worth cold outreach. Used by
 * the base-constructor «Убрать почты поддержки» step to drop those rows.
 *
 * Deliberately CONSERVATIVE: it does NOT flag good general business inboxes the
 * studio wants to keep — info@, sales@, contact@, office@, hello@, mail@,
 * general@, marketing@ … — those are real contact points, not support queues.
 * (Per owner feedback: info@ is a good common box.)
 *
 * Pure + dependency-free → safe to import anywhere (client UI, worker, tests).
 */

// Base local-parts (the part before @). The matcher also flags these when
// followed by a separator or digit — support.team / help-ru / zakaz_spb /
// support2 — but NOT when they're merely a prefix of a longer word (supportive
// doesn't match). Keep this list narrowly «support / служебное», not «generic».
const ROLE_LOCALPARTS = new Set<string>([
  // Support / customer service
  'support', 'help', 'helpdesk', 'service', 'podderzhka',
  // No-reply / system / abuse
  'noreply', 'postmaster', 'webmaster', 'hostmaster', 'abuse',
  // Orders / delivery (zakaz@ — explicitly flagged by the owner)
  'zakaz', 'zakazy', 'zakazat', 'order', 'orders', 'booking', 'reservations', 'dostavka',
  // Finance / billing
  'billing', 'accounting', 'accounts', 'finance', 'buh', 'buhgalteria', 'bukhgalteria',
  // HR / jobs / recruiting
  'hr', 'jobs', 'job', 'career', 'careers', 'vacancy', 'vacancies', 'rekrut',
]);

// Role addresses that aren't a single [a-z]+ token (hyphen/underscore variants).
const ROLE_LOCALPARTS_EXACT = new Set<string>([
  'no-reply', 'no_reply', 'do-not-reply', 'donotreply', 'do_not_reply', 'mailer-daemon',
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
