import type { SupabaseClient } from '@supabase/supabase-js';

/** Только английский автоаутрич: не общий стоп-лист отправителя и не домены. */
export const EN_EMAIL_STOP_LIST_KEY = 'blocked_emails';

/** Читаем один раз на запуск/импорт. Ошибка или битый список запрещают заливку. */
export async function loadEnEmailStopList(db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db.from('polza_outreach_settings')
    .select('value').eq('key', EN_EMAIL_STOP_LIST_KEY).maybeSingle();
  if (error) throw new Error(`Не удалось прочитать стоп-лист английского автоаутрича: ${error.message}`);
  if (!data) return new Set();
  const raw: unknown = data.value;
  if (!Array.isArray(raw) || raw.some(email => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
    throw new Error('Стоп-лист английского автоаутрича повреждён: ожидается список email-адресов');
  }
  return new Set(raw.map(email => (email as string).trim().toLowerCase()));
}
