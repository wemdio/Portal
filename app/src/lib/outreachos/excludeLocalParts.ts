/**
 * HR/recruiting локалпарты — отсев ТОЛЬКО для OutreachOS пайплайна.
 *
 * Конструктор баз (remove_support_emails / supportEmails.ts) намеренно ОСТАВЛЯЕТ
 * hr@/recruitment@ — owner решил, что HR-ящики полезны (для другого аутрича).
 * Но мы продаём аутрич-инструмент → HR его не покупает (нужны sales/маркетинг/
 * ЛПР), а парс вакансий HH как раз тащит много HR-контактов. Поэтому режем их
 * в НАШЕМ коде (gridToLeadPayloads), не трогая общий конструктор.
 *
 * NB: список продублирован (компактно) в scripts/outreachos-export-base.mjs —
 * держать в синхроне. Standalone .mjs не может импортировать этот .ts.
 *
 * Матчинг как в supportEmails.isRoleLocalPart: точное совпадение ИЛИ role-слово,
 * за которым идёт разделитель/цифра (hr.moscow, recruitment-ru, hr2) — но НЕ
 * когда это просто префикс длинного слова (hristoforov НЕ матчится).
 */

export const HR_LOCALPARTS: ReadonlySet<string> = new Set<string>([
  'hr', 'hrd', 'hrm', 'hrbp', 'hrgroup',
  'recruit', 'recruiter', 'recruiters', 'recruitment', 'recruiting',
  'podbor', 'kadry', 'kadri', 'personnel',
  'vacancy', 'vacancies', 'vakansia', 'vakansiya', 'vakansii',
  'job', 'jobs', 'career', 'careers', 'rabota',
]);

export function isHrLocalPart(localRaw: string): boolean {
  const local = (localRaw ?? '').trim().toLowerCase();
  if (!local) return false;
  if (HR_LOCALPARTS.has(local)) return true;
  // role-слово + разделитель/цифра: hr.moscow, recruitment-ru, hr2. Lookahead
  // означает, что role-слово + ещё БУКВЫ (hristoforov) НЕ матчится.
  const m = local.match(/^([a-z]+)(?=[._+\-0-9])/);
  return !!m && HR_LOCALPARTS.has(m[1]);
}

/** true, если email — HR/recruiting-ящик (для OutreachOS такие в лиды не идут). */
export function isOutreachOsExcludedEmail(email: string): boolean {
  const at = (email ?? '').indexOf('@');
  if (at <= 0) return false;
  return isHrLocalPart(email.slice(0, at));
}
