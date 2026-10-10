/**
 * Серверный ключ ENG-контура для подписи ссылок подтверждения почты и для
 * псевдонимизации ключей счётчиков частоты (IP, адрес почты).
 *
 * Отдельной переменной окружения нет НАМЕРЕННО: ключ выводится из
 * SUPABASE_SERVICE_ROLE_KEY, который у контейнера portal есть всегда (без него
 * не работает supabaseAdmin, а значит, и всё, что здесь подписывается).
 * Для каждого назначения — своя метка, поэтому подпись ссылки и хэш IP не
 * взаимозаменяемы. Сменили ключ сервис-роли — ссылки, выданные до смены,
 * перестают проходить подпись (клиент запрашивает новую), а окна счётчиков
 * начинаются заново.
 *
 * Модуль без логгера и без `server-only`: его тянут роуты и модули, которые
 * может импортировать воркер.
 */

import { createHmac } from 'crypto';

export type HeEngKeyPurpose = 'email-verify' | 'rate-key';

const KEY_LABEL: Record<HeEngKeyPurpose, string> = {
  'email-verify': 'he-eng-email-verify-v1',
  'rate-key': 'he-eng-rate-key-v1',
};

/** null — SUPABASE_SERVICE_ROLE_KEY не задан: подписывать нечем. */
export function deriveHeEngKey(
  purpose: HeEngKeyPurpose,
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const root = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!root) return null;
  return createHmac('sha256', root).update(KEY_LABEL[purpose]).digest();
}
