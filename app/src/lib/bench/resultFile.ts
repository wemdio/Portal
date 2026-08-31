import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Сколько живёт ссылка на файл результата.
 *
 * Пятнадцать минут — чтобы скрипт успел скачать, но ссылка не пережила ни
 * отзыв ключа, ни уход подрядчика. Постоянная ссылка на файл в нашем
 * хранилище — это дыра, которую потом не закрыть: она уже разошлась.
 */
export const BENCH_FILE_URL_TTL_SECONDS = 900;

/**
 * Временная ссылка на один файл результата.
 *
 * Подписывается служебным доступом, потому что вёдра закрыты для обычных
 * пользователей. Путь при этом берётся из строки задачи, которую вызывающему
 * уже отдала база через клиент робота, — то есть чужой файл сюда не попадёт:
 * не своя задача не вернётся и до этого места дело не дойдёт.
 */
export async function signBenchResultUrl(
  bucket: string,
  path: string,
): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, BENCH_FILE_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}
