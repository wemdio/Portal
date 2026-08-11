/**
 * Аватарка аккаунта в хранилище портала.
 *
 * В Telegram фото живёт у самого аккаунта, но список кампании не может ходить в
 * Telegram за каждой картинкой — поэтому копию кладём в бакет `avatars`, ровно
 * как это давно сделано для аккаунтов пула, и в БД храним ссылку.
 */
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const BUCKET = 'avatars';

/**
 * Итог сохранения: либо ссылка, либо причина, почему её нет.
 *
 * Раньше функция на любой сбой возвращала null, и вызывающий код записывал в
 * аккаунт пустую ссылку — оператор видел «в Telegram нет аватарки» и там, где
 * фото было, а не доехало хранилище. Причину теперь отдаём наверх: «бакета нет»
 * и «фото нет» — разные новости, и лечатся они по-разному.
 */
export type AvatarStoreResult =
  | { url: string; error: null }
  | { url: null; error: string };

/**
 * Сохранить (перезаписать) аватарку аккаунта и вернуть публичную ссылку.
 *
 * Путь всегда один и тот же, поэтому к ссылке добавляем метку версии: без неё
 * браузер продолжил бы показывать старую картинку из кэша после смены фото.
 * Ошибку не глотаем, но и не бросаем: аватарка косметическая, ронять из-за неё
 * чтение имени и описания незачем.
 */
export async function storeAccountAvatar(
  accountId: string,
  jpeg: Buffer,
): Promise<AvatarStoreResult> {
  if (!supabaseAdmin) {
    return { url: null, error: 'хранилище портала не настроено (нет служебного ключа)' };
  }

  const path = `tg-outreach-avatars/${accountId}.jpg`;
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
  if (error) {
    return { url: null, error: `хранилище не приняло аватарку (бакет «${BUCKET}»): ${error.message}` };
  }

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    return { url: null, error: `хранилище не вернуло публичную ссылку на бакет «${BUCKET}»` };
  }
  return { url: `${data.publicUrl}?v=${Date.now()}`, error: null };
}
