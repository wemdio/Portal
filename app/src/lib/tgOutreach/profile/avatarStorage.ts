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
 * Сохранить (перезаписать) аватарку аккаунта и вернуть публичную ссылку.
 *
 * Путь всегда один и тот же, поэтому к ссылке добавляем метку версии: без неё
 * браузер продолжил бы показывать старую картинку из кэша после смены фото.
 * Возвращает null, если хранилище не настроено или загрузка не удалась —
 * аватарка косметическая, ронять из-за неё правку профиля незачем.
 */
export async function storeAccountAvatar(
  accountId: string,
  jpeg: Buffer,
): Promise<string | null> {
  if (!supabaseAdmin) return null;

  const path = `tg-outreach-avatars/${accountId}.jpg`;
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
  if (error) return null;

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) return null;
  return `${data.publicUrl}?v=${Date.now()}`;
}
