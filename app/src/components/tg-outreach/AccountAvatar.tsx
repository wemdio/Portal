'use client';

import { useState } from 'react';

import type { OutreachAccount } from '@/lib/tgOutreach/types';

/**
 * Аватарка аккаунта — картинка из Telegram или инициалы.
 *
 * Вынесена из таблицы аккаунтов, когда те же строки понадобились на выборе
 * аккаунтов для прогрева: список из двадцати семи имён вида «Дмитрий» без лица
 * и ника не даёт понять, кого отмечаешь.
 */
export function AccountAvatar({
  account,
  size = 36,
}: {
  account: OutreachAccount;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const label = (account.first_name || account.session_name || '?').trim();
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const url = account.avatar_url?.trim();

  if (url && !broken) {
    // Аватарки лежат в публичном бакете Supabase; next/image потребовал бы
    // прописывать домен хранилища в конфиг ради картинки 36×36.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{ width: size, height: size }}
        className="rounded-full object-cover bg-gray-100 shrink-0"
      />
    );
  }

  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size / 2.8) }}
      className="flex items-center justify-center rounded-full bg-gray-100 font-medium text-gray-400 shrink-0"
      title={account.profile_synced_at ? 'В Telegram нет аватарки' : 'Профиль ещё не читали из Telegram'}
    >
      {initials || '?'}
    </span>
  );
}
