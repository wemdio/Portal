import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isTransientDbError } from '@/lib/db/transientError';

type JournalTable = 'polza_outreach_companies' | 'polza_ru_outreach_companies';
const MAX_ATTEMPTS = 5;

/** Повторяем только запись готовой порции, без повторного поиска или вызовов ИИ. */
export async function persistCandidateChunk(
  db: SupabaseClient,
  table: JournalTable,
  candidates: Record<string, unknown>[],
  options: {
    beforeAttempt: () => Promise<void>;
    onRetry: (attempt: number, delayMs: number, message: string) => void;
  },
): Promise<string[]> {
  if (!candidates.length) return [];
  // Ответ может потеряться ПОСЛЕ коммита БД. Те же UUID и DO NOTHING не создают
  // второй набор строк и не сбрасывают состояние уже сохранённой компании.
  const rows = candidates.map((candidate) => ({ ...candidate, id: randomUUID() }));
  const ids = rows.map((row) => row.id);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await options.beforeAttempt();
    let status: number | undefined;
    try {
      const result = await db.from(table).upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
      status = result.status;
      if (result.error) throw result.error;
      return ids;
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message) : String(error);
      if (attempt === MAX_ATTEMPTS || !isTransientDbError(error, status)) {
        throw new Error(`Не удалось сохранить кандидатов ${table === 'polza_outreach_companies' ? 'EN' : 'RU'} (попытка ${attempt}/${MAX_ATTEMPTS}): ${message}`, { cause: error });
      }
      const delayMs = 1_000 * 2 ** (attempt - 1);
      options.onRetry(attempt + 1, delayMs, message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Все ветви цикла завершаются return/throw; защита при изменении лимита.
  throw new Error('Не выполнено сохранение кандидатов');
}
