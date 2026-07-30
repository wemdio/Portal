'use client';

import { Send, X } from 'lucide-react';
import { useDemoMode } from '@/lib/clientDemo/useDemoMode';
import { promptDemoRegister } from '@/lib/clientDemo/registerPrompt';
import { isTabDemoMode, disableTabDemoMode } from '@/lib/clientDemo/tabDemoMode';

/**
 * Полоса «Демо-режим» вверху клиентского портала.
 *
 * Сама прячется, если под аккаунтом не демо. Когда демо — видна на каждой
 * странице, чтобы потенциальный клиент сразу понимал: это витрина с
 * тестовыми данными, а не его реальный кабинет, и изменить ничего нельзя
 * (любая мутация и так режется на бэкенде — см. lib/clientDemo).
 *
 * Помимо пояснения несёт постоянную CTA-кнопку «Зарегистрироваться» — чтобы у
 * человека, который просто листает демо, конверсия всегда была под рукой, а не
 * только когда он упрётся в заблокированное действие. Кнопка переиспользует
 * promptDemoRegister → тот же модал DemoRegisterGate (signOut → /signup).
 *
 * Editorial-dark treatment: flat surface-elev strip with a single amber dot
 * carrying the "informational, non-production" signal — no gradient chrome.
 * Full-width flex-wrap: на узких экранах кнопка переносится под текст, не ломая
 * шапку (в отличие от навбара, который зажат в одну строку).
 */
export function DemoBanner() {
  const isDemo = useDemoMode();
  if (isDemo !== true) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-2 text-center text-xs sm:text-sm font-semibold"
      style={{
        background: 'var(--cp-surface-elev)',
        color: 'var(--cp-paper)',
        borderBottom: '1px solid var(--cp-divider-strong)',
      }}
    >
      <span>
        <span
          className="inline-block h-1.5 w-1.5 rounded-full align-middle mr-2"
          style={{ background: 'var(--cp-amber)' }}
          aria-hidden
        />
        Демо-режим — это витрина портала с тестовыми данными. Любые изменения отключены.
      </span>
      {isTabDemoMode() ? (
        // Демо-вкладка (?demo=1): выход — снять флаг вкладки, аккаунт не трогаем.
        // Рядом в другой вкладке может жить рабочий кабинет — он не затрагивается.
        <button
          type="button"
          onClick={() => {
            disableTabDemoMode();
            window.location.assign('/client');
          }}
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold shrink-0"
          style={{ background: 'var(--cp-surface)', color: 'var(--cp-paper)' }}
        >
          <X size={13} aria-hidden />
          Выйти из демо
        </button>
      ) : (
        <button
          type="button"
          onClick={() => promptDemoRegister('работать на своих данных')}
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold shrink-0"
          style={{ background: 'var(--cp-amber)', color: 'var(--cp-ink)' }}
        >
          <Send size={13} aria-hidden />
          Зарегистрироваться
        </button>
      )}
    </div>
  );
}
