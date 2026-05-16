'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';

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
        </form>

        <p className="text-center text-sm text-gray-500">
          Доступ к порталу выдаёт администратор
        </p>
      </div>
    </div>
  );
}
