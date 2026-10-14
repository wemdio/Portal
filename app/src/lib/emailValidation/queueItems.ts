import { checkSyntax, normalizeEmail } from './shared';

export type EnqueueRow = { rowIndex: number; email: string };

/**
 * Строки очереди валидации — одинаково для экрана портала и Bench API.
 *
 * Адреса с битым форматом сразу ложатся `failed` с вердиктом `invalid`:
 * воркер их не трогает, а задача с первой секунды знает, сколько из них
 * уже «обработано».
 */
export function buildQueueItems(
  rows: EnqueueRow[],
  userId: string,
  now: string,
): { items: ReturnType<typeof buildOneItem>[]; invalidCount: number } {
  let invalidCount = 0;
  const items = rows.map((row) => {
    const item = buildOneItem(row, userId, now);
    if (item.status === 'failed') invalidCount += 1;
    return item;
  });
  return { items, invalidCount };
}

function buildOneItem(row: EnqueueRow, userId: string, now: string) {
  const rawEmail = String(row.email ?? '').trim();
  const normalized = normalizeEmail(rawEmail);
  let status: 'pending' | 'failed' = 'pending';
  let lastError: string | null = null;
  let result: string | null = null;
  let quality: string | null = null;

  if (!rawEmail) {
    status = 'failed'; lastError = 'Пустой email'; result = 'invalid'; quality = 'bad';
  } else if (!normalized) {
    status = 'failed'; lastError = 'Невалидный формат'; result = 'invalid'; quality = 'bad';
  } else {
    const syntaxCheck = checkSyntax(normalized);
    if (!syntaxCheck.valid) {
      status = 'failed'; lastError = syntaxCheck.error ?? 'Невалидный формат'; result = 'invalid'; quality = 'bad';
    }
  }

  return {
    job_id: '',
    user_id: userId,
    row_index: row.rowIndex,
    email_raw: rawEmail,
    email_normalized: normalized || rawEmail.toLowerCase(),
    status, last_error: lastError, result, quality,
    attempt_count: 0, created_at: now, updated_at: now,
    completed_at: status === 'failed' ? now : null,
  };
}
