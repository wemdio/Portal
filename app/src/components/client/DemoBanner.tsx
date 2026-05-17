'use client';

import { useDemoMode } from '@/lib/clientDemo/useDemoMode';

/**
 * Полоса «Демо-режим» вверху клиентского портала.
 *
 * Сама прячется, если под аккаунтом не демо. Когда демо — видна на каждой
 * странице, чтобы потенциальный клиент сразу понимал: это витрина с
 * тестовыми данными, а не его реальный кабинет, и изменить ничего нельзя
 * (любая мутация и так режется на бэкенде — см. lib/clientDemo).
 */
export function DemoBanner() {
  const isDemo = useDemoMode();
  if (isDemo !== true) return null;

  return (
    <div
      role="status"
      className="px-4 py-2 text-center text-xs sm:text-sm font-semibold"
      style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', color: '#fff' }}
    >
      Демо-режим — это витрина портала с тестовыми данными. Любые изменения отключены.
    </div>
  );
}
