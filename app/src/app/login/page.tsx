'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { supabase } from '@/lib/supabaseClient';
import { logAudit, logError } from '@/lib/loggerClient';
import { AuthShell, AuthField } from '@/components/auth/AuthShell';

function isSignupHost(host: string): boolean {
  const hosts = (process.env.NEXT_PUBLIC_SIGNUP_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hosts.length === 0) return false;
  return hosts.includes(host);
}

const TELEGRAM_STORAGE_KEYS = {
  token: 'tg_link_token',
  expiresAt: 'tg_link_expires_at',
  isWebApp: 'tg_is_webapp',
} as const;

function clearTelegramLink() {
  sessionStorage.removeItem(TELEGRAM_STORAGE_KEYS.token);
  sessionStorage.removeItem(TELEGRAM_STORAGE_KEYS.expiresAt);
}

function getTelegramLinkToken() {
  if (typeof window === 'undefined') return null;
  const token = sessionStorage.getItem(TELEGRAM_STORAGE_KEYS.token);
  const expiresAt = sessionStorage.getItem(TELEGRAM_STORAGE_KEYS.expiresAt);
  if (!token || !expiresAt) return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
    clearTelegramLink();
    return null;
  }
  return token;
}

async function linkTelegramAccount(accessToken: string) {
  if (typeof window === 'undefined') return { ok: true, skipped: true };
  if (!sessionStorage.getItem(TELEGRAM_STORAGE_KEYS.isWebApp)) {
    return { ok: true, skipped: true };
  }

  const linkToken = getTelegramLinkToken();
  if (!linkToken) return { ok: true, skipped: true };

  try {
    const response = await fetch('/api/telegram/link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ link_token: linkToken }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      return {
        ok: false,
        status: response.status,
        error: data?.error ?? response.statusText,
      };
    }

    clearTelegramLink();
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error };
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signupAllowed, setSignupAllowed] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotDone, setForgotDone] = useState(false);
  const [forgotError, setForgotError] = useState('');
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSignupAllowed(isSignupHost(window.location.hostname));
    }
  }, []);

  const openForgot = () => {
    setForgotEmail(email);
    setForgotError('');
    setForgotDone(false);
    setForgotOpen(true);
  };
  const closeForgot = () => {
    setForgotOpen(false);
    setForgotError('');
    setForgotLoading(false);
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (forgotLoading) return;
    setForgotLoading(true);
    setForgotError('');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      // Endpoint returns {ok:true} for every well-formed input regardless of
      // whether the email exists. So a 2xx response = "if the email matches
      // an account, the new password is on its way." No leak either way.
      if (!res.ok) {
        setForgotError('Не удалось отправить запрос. Попробуйте позже.');
        return;
      }
      setForgotDone(true);
    } catch {
      setForgotError('Сетевая ошибка. Проверьте подключение.');
    } finally {
      setForgotLoading(false);
    }
  };

  // Саморегистрация закрыта намеренно: портал B2B, все аккаунты заводит
  // администратор через /admin/users и сразу назначает роль. Здесь —
  // только вход. (Раньше тут была кнопка «Зарегистрироваться» через
  // supabase.auth.signUp — это пускало любого с улицы во внутренний
  // портал с ролью null.)
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error, data } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      if (data.session) {
        const linkResult = await linkTelegramAccount(data.session.access_token);
        if (!linkResult.ok) {
          void logError('telegram.link.failed', linkResult.error, { status: linkResult.status });
        } else if (!linkResult.skipped) {
          void logAudit('telegram.link.success', 'Telegram account linked');
        }
        void logAudit('auth.login.success', 'User logged in', { withSession: true });
        // Hard reload to ensure session is picked up by middleware
        window.location.href = '/';
      } else {
        setError('Сессия не создана. Попробуйте снова.');
        void logAudit('auth.login.missing_session', 'Login completed without session', { withSession: false });
      }
    } catch (caughtError) {
      void logError('auth.login.failed', caughtError);
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : typeof caughtError === 'object' && caughtError !== null && 'message' in caughtError && typeof (caughtError as { message: unknown }).message === 'string'
            ? ((caughtError as { message: string }).message)
            : 'Неизвестная ошибка при аутентификации.';

      if (errorMessage.includes('invalid_credentials')) {
        setError('Неверный email или пароль.');
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Вход"
      subtitle="Введите данные для входа"
      overlay={
        forgotOpen ? (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={closeForgot}
          >
            <div
              className="neu-card w-full max-w-md p-6"
              style={{ background: 'var(--cp-surface-elev)' }}
              onClick={(e) => e.stopPropagation()}
            >
              {forgotDone ? (
                <>
                  <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
                    Проверьте почту
                  </h3>
                  <p className="text-sm mb-2" style={{ color: 'var(--cp-paper-mute)' }}>
                    Если такой аккаунт зарегистрирован — на привязанный email отправлен новый пароль.
                    Войдите с ним и сразу смените на свой через «Настройки».
                  </p>
                  <p className="text-xs mb-5" style={{ color: 'var(--cp-paper-faint)' }}>
                    Письмо может прийти в течение минуты. Не пришло — проверьте папку «Спам».
                  </p>
                  <div className="flex justify-end">
                    <button type="button" onClick={closeForgot} className="neu-btn px-4 py-2 text-sm font-semibold">
                      Понятно
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
                    Восстановление пароля
                  </h3>
                  <p className="text-sm mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
                    Укажите email от аккаунта — пришлём на него новый пароль.
                  </p>
                  <form onSubmit={handleForgot} className="space-y-3">
                    <input
                      type="email"
                      required
                      autoFocus
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      placeholder="Email"
                      className="neu-input w-full px-3 py-2.5 text-sm"
                    />
                    {forgotError && (
                      <div
                        className="text-xs rounded-md p-2.5"
                        style={{ background: 'rgba(229,72,77,0.1)', border: '1px solid var(--cp-red)', color: 'var(--cp-red)' }}
                      >
                        {forgotError}
                      </div>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={closeForgot}
                        disabled={forgotLoading}
                        className="px-4 py-2 text-sm font-semibold"
                        style={{ color: 'var(--cp-paper-mute)' }}
                      >
                        Отмена
                      </button>
                      <button
                        type="submit"
                        disabled={forgotLoading || !forgotEmail.trim()}
                        className="neu-btn px-4 py-2 text-sm font-semibold"
                      >
                        {forgotLoading ? 'Отправка…' : 'Сбросить'}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </div>
          </div>
        ) : null
      }
    >
      <form className="space-y-4" onSubmit={handleAuth}>
        <AuthField
          label="Email"
          id="email-address"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Пароль"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && (
          <div
            className="text-xs rounded-md p-2.5"
            style={{ background: 'rgba(229,72,77,0.1)', border: '1px solid var(--cp-red)', color: 'var(--cp-red)' }}
          >
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} className="neu-btn w-full px-4 py-2.5 text-sm font-semibold">
          {loading ? 'Загрузка…' : 'Войти'}
        </button>

        {signupAllowed && (
          <div className="text-center">
            <button type="button" onClick={openForgot} className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
              Забыли пароль?
            </button>
          </div>
        )}
      </form>

      <p className="mt-5 text-center text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
        Доступ выдаёт администратор
      </p>

      {signupAllowed && (
        <p className="mt-2 text-center text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          Нет аккаунта?{' '}
          <Link href={'/signup' as Route} className="font-semibold" style={{ color: 'var(--cp-amber)' }}>
            Зарегистрироваться
          </Link>
        </p>
      )}

      {/* Public link to the platform offer agreement — quiet text button. */}
      <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--cp-divider)' }}>
        <a href="/offer" className="block text-center text-xs font-medium" style={{ color: 'var(--cp-paper-faint)' }}>
          Договор оферты
        </a>
      </div>
    </AuthShell>
  );
}
