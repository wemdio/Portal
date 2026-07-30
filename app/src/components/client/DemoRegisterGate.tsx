'use client';

import { useEffect, useState } from 'react';
import { Send, X } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import {
  DEMO_REGISTER_PROMPT_EVENT,
  type DemoRegisterPromptDetail,
} from '@/lib/clientDemo/registerPrompt';
import { isTabDemoMode, disableTabDemoMode } from '@/lib/clientDemo/tabDemoMode';

/**
 * Global "register to unlock" modal for the demo portal. Mounted once in the
 * client layout. Opens whenever a demo-blocked action fires the
 * DEMO_REGISTER_PROMPT_EVENT — either centrally from authFetch (any 403 with code
 * DEMO_READONLY) or directly from a client-disabled control (e.g. the demo launch
 * preview button). So every blocked action invites registration without per-site
 * wiring.
 *
 * Inert for real clients: they never receive a DEMO_READONLY 403, so the event
 * never fires and nothing renders. The "Зарегистрироваться" CTA signs out the shared
 * demo session FIRST, then navigates to /signup — otherwise middleware bounces the
 * still-logged-in demo (role=client) straight back to /client (the "it just threw me
 * to the dashboard" bug).
 */
export function DemoRegisterGate() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const goRegister = async () => {
    setLeaving(true);
    // Демо-ВКЛАДКА: пользователь уже залогинен — signOut тут убил бы его
    // реальную сессию посреди показа (и в соседней рабочей вкладке). Выход —
    // просто снять флаг вкладки и вернуться в рабочий кабинет.
    if (isTabDemoMode()) {
      disableTabDemoMode();
      window.location.assign('/client');
      return;
    }
    // Sign out the shared demo session before /signup: middleware redirects an
    // authenticated role=client away from /signup to /client. Cookie-based
    // (@supabase/ssr) signOut clears the session cookie the middleware reads, so a
    // full navigation then lands on /signup clean. Navigate regardless on failure.
    try {
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
    window.location.href = '/signup';
  };

  useEffect(() => {
    const onPrompt = (e: Event) => {
      const detail = (e as CustomEvent<DemoRegisterPromptDetail>).detail;
      setReason(detail?.reason ?? null);
      setOpen(true);
    };
    window.addEventListener(DEMO_REGISTER_PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(DEMO_REGISTER_PROMPT_EVENT, onPrompt);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-register-title"
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="neu-card w-full max-w-md p-6"
        style={{ background: 'var(--cp-surface-elev)' }}
      >
        <p className="ds-eyebrow m-0 mb-2" style={{ color: 'var(--cp-amber)' }}>
          Доступно в рабочем аккаунте
        </p>
        <h2 id="demo-register-title" className="text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
          {isTabDemoMode()
            ? (reason ? `Выйдите из демо, чтобы ${reason}` : 'Выйдите из демо, чтобы продолжить')
            : (reason ? `Зарегистрируйтесь, чтобы ${reason}` : 'Зарегистрируйтесь, чтобы продолжить')}
        </h2>
        <p className="text-sm mb-5" style={{ color: 'var(--cp-paper-mute)' }}>
          {isTabDemoMode()
            ? 'Это демо-вкладка — витрина на тестовых данных, действия в ней отключены. Вернитесь в рабочий режим, чтобы продолжить на своих данных.'
            : 'Это демо — витрина на тестовых данных, здесь действия отключены. Создайте аккаунт за минуту и работайте на своих данных: загрузка баз, запуск кампаний, выгрузки.'}
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="button"
            onClick={goRegister}
            disabled={leaving}
            className="neu-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
            style={{ background: 'var(--cp-amber)', color: 'var(--cp-ink)' }}
          >
            {isTabDemoMode() ? (
              <><X size={15} /> {leaving ? 'Выходим…' : 'Выйти из демо'}</>
            ) : (
              <><Send size={15} /> {leaving ? 'Открываем…' : 'Зарегистрироваться'}</>
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-sm font-semibold"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Остаться в демо
          </button>
        </div>
      </div>
    </div>
  );
}
