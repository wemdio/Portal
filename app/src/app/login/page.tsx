'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';

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
  const isTma = useIsTma();
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
    <div className={isTma ? 'flex min-h-screen items-center justify-center bg-gray-50 px-4 py-6' : 'flex min-h-screen items-center justify-center bg-gray-50'}>
      <div className={`w-full max-w-md bg-white rounded-xl border border-gray-100 shadow-sm ${isTma ? 'space-y-6 p-6' : 'space-y-8 p-8'}`}>
        <div className="text-center">
          <h2 className={`${isTma ? 'mt-4 text-2xl' : 'mt-6 text-3xl'} font-bold tracking-tight text-gray-900`}>
            Вход в Портал
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Введите свои данные для входа
          </p>
        </div>

        <form className={`${isTma ? 'mt-6' : 'mt-8'} space-y-6`} onSubmit={handleAuth}>
          <div className="space-y-4 rounded-md shadow-sm">
            <div>
              <input
                id="email-address"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="relative block w-full rounded-md border-0 py-2 px-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6"
                placeholder="Email адрес"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="relative block w-full rounded-md border-0 py-2 px-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6"
                placeholder="Пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md border border-red-200">
              {error}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative flex w-full justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
            >
              {loading ? 'Загрузка...' : 'Войти'}
            </button>
          </div>

          {signupAllowed && (
            <div className="text-center">
              <button
                type="button"
                onClick={openForgot}
                className="text-xs text-gray-500 hover:text-blue-600 hover:underline"
              >
                Забыли пароль?
              </button>
            </div>
          )}
        </form>

        <p className="text-center text-sm text-gray-500">
          Доступ к порталу выдаёт администратор
        </p>

        {signupAllowed && (
          <p className="mt-2 text-center text-xs text-gray-600">
            Нет аккаунта?{' '}
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <Link href={'/signup' as any} className="font-medium text-indigo-600 hover:underline">
              Зарегистрироваться
            </Link>
          </p>
        )}

        {/* Public link to the platform offer agreement. Always visible
            (auth-walled users see it before they log in), styled as a quiet
            text button so it doesn't compete with the primary Войти CTA. */}
        <div className="border-t border-gray-100 pt-4">
          <a
            href="/offer"
            className="block text-center text-xs font-medium text-gray-500 hover:text-gray-900 hover:underline"
          >
            Договор оферты
          </a>
        </div>
      </div>

      {forgotOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={closeForgot}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {forgotDone ? (
              <>
                <h3 className="text-lg font-semibold text-gray-900">Проверьте почту</h3>
                <p className="mt-3 text-sm text-gray-600">
                  Если такой аккаунт зарегистрирован — на привязанный email отправлен новый пароль.
                  Войдите с ним и сразу смените на свой через «Настройки».
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Письмо может прийти в течение минуты. Не пришло — проверь папку «Спам».
                </p>
                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={closeForgot}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                  >
                    Понятно
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold text-gray-900">Восстановление пароля</h3>
                <p className="mt-2 text-sm text-gray-600">
                  Укажи email от аккаунта — пришлём на него новый пароль.
                </p>
                <form onSubmit={handleForgot} className="mt-4 space-y-3">
                  <input
                    type="email"
                    required
                    autoFocus
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="Email"
                    className="block w-full rounded-md border-0 py-2 px-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm"
                  />
                  {forgotError && (
                    <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                      {forgotError}
                    </div>
                  )}
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={closeForgot}
                      disabled={forgotLoading}
                      className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Отмена
                    </button>
                    <button
                      type="submit"
                      disabled={forgotLoading || !forgotEmail.trim()}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                    >
                      {forgotLoading ? 'Отправка…' : 'Сбросить'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
