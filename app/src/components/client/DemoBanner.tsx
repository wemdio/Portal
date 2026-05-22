'use client';

import { useDemoMode } from '@/lib/clientDemo/useDemoMode';

/**
 * Полоса «Демо-режим» вверху клиентского портала.
 *
 * Сама прячется, если под аккаунтом не демо. Когда демо — видна на каждой
 * странице, чтобы потенциальный клиент сразу понимал: это витрина с
 * тестовыми данными, а не его реальный кабинет, и изменить ничего нельзя
 * (любая мутация и так режется на бэкенде — см. lib/clientDemo).
 *
 * Editorial-dark treatment: flat surface-elev strip with a single amber dot
 * carrying the "informational, non-production" signal — no gradient chrome.
 */
export function DemoBanner() {
  const isDemo = useDemoMode();
  if (isDemo !== true) return null;

  return (
    <div
      role="status"
      className="px-4 py-2 text-center text-xs sm:text-sm font-semibold"
      style={{
        background: 'var(--cp-surface-elev)',
        color: 'var(--cp-paper)',
        borderBottom: '1px solid var(--cp-divider-strong)',
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full align-middle mr-2"
        style={{ background: 'var(--cp-amber)' }}
        aria-hidden
      />
      Демо-режим — это витрина портала с тестовыми данными. Любые изменения отключены.
    </div>
  );
}
