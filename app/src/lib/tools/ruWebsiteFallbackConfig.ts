/** Public constructor input never admits internal website readers. */
export function stripInternalRuWebsiteFallback(config: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...config };
  delete clean.ve_ru_website_rescue;
  if (clean.find_emails && typeof clean.find_emails === 'object' && !Array.isArray(clean.find_emails)) {
    const find = { ...clean.find_emails as Record<string, unknown> };
    delete find.ru_page_fallback;
    clean.find_emails = find;
  }
  return clean;
}

/** Match the exact server-reserved company/site inputs, including checkpoints
 * that append found-email/description columns. No position guesses for user CSV. */
export function matchesRuWebsiteRescueInput(data: unknown, receipt: unknown, childId: string): boolean {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  const state = receipt as Record<string, unknown>;
  if (state.version !== 1 || state.id !== childId || !['reserved', 'running'].includes(String(state.phase))
    || !['sources_exhausted', 'low_yield'].includes(String(state.reason))
    || !Number.isSafeInteger(state.completed_round) || Number(state.completed_round) < 1
    || !Number.isSafeInteger(state.ready_before) || Number(state.ready_before) < 0
    || !Number.isSafeInteger(state.target) || Number(state.target) <= Number(state.ready_before)
    || !Array.isArray(state.rows) || state.rows.length < 1 || state.rows.length > 100
    || !Array.isArray(data) || data.length < 1 || data.length > 101 || !Array.isArray(data[0])) return false;
  const header = data[0];
  if (header[0] !== 'Компания' || header[1] !== 'Сайт' || header[9] !== 'ИНН') return false;
  const key = (company: unknown, website: unknown, inn: unknown) => JSON.stringify([company, website, inn].map((v) => String(v ?? '').trim()));
  const scope = new Set(state.rows.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    return String(row.email ?? '').trim() ? [] : [key(row.company, row.website, row.inn)];
  }));
  return scope.size > 0 && data.slice(1).every((row) => Array.isArray(row) && scope.has(key(row[0], row[1], row[9])));
}
