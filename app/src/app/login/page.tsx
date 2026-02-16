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
  const [isSignUp, setIsSignUp] = useState(false); // Toggle between Login and Sign Up
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');

    try {
      if (isSignUp) {
        // Automatically confirm email for testing/demo purposes if Supabase is configured to allow it,
        // or just accept that email confirmation is disabled on the project.
        const { error, data } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${location.origin}/auth/callback`,
            data: {
              full_name: email.split('@')[0], // Default name from email
            }
          },
        });
        
        if (error) throw error;

        // Create profile entry if user was created
        if (data.user) {
          const { error: profileError } = await supabase
            .from('profiles')
            .upsert({
              id: data.user.id,
              email: email,
              full_name: email.split('@')[0],
              role: null, // Default role - can be set by admin later
            });

          if (profileError) {
            void logError('auth.profile.create.failed', profileError);
            // Don't throw - user is already created in auth, profile can be created later
          }
        }

        // Check if session was created immediately (meaning email confirmation is off)
        if (data.session) {
             const linkResult = await linkTelegramAccount(data.session.access_token);
             if (!linkResult.ok) {
               void logError('telegram.link.failed', linkResult.error, {
                 status: linkResult.status,
                 isSignUp,
               });
             } else if (!linkResult.skipped) {
               void logAudit('telegram.link.success', 'Telegram account linked', { isSignUp });
             }
             setMessage('Регистрация успешна! Входим...');
             void logAudit('auth.signup.success', 'User signed up', { withSession: true });
             // Hard reload to ensure session is picked up by middleware
             window.location.href = '/';
        } else {
             setMessage('Регистрация успешна! Но Supabase требует подтверждения почты. Проверьте настройки проекта Supabase (Auth -> Providers -> Email -> Confirm email) и отключите это требование для теста.');
             void logAudit('auth.signup.pending', 'User signed up without session', { withSession: false });
        }

      } else {
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
          setError('Сессия не создана. Попробуйте снова или проверьте настройки Supabase.');
          void logAudit('auth.login.missing_session', 'Login completed without session', { withSession: false });
        }
      }
    } catch (caughtError) {
        void logError('auth.login.failed', caughtError, { isSignUp });
        const errorMessage =
          caughtError instanceof Error
            ? caughtError.message
            : typeof caughtError === 'object' && caughtError !== null && 'message' in caughtError && typeof (caughtError as { message: unknown }).message === 'string'
              ? ((caughtError as { message: string }).message)
              : 'Неизвестная ошибка при аутентификации.';

        if (errorMessage.includes('Error sending confirmation email')) {
            setError('Ошибка отправки письма. Скорее всего, в Supabase превышен лимит писем (Rate Limit) или не настроен SMTP. Отключите "Confirm email" в настройках Supabase.');
        } else if (errorMessage.includes('invalid_credentials')) {
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
            {isSignUp ? 'Создать аккаунт' : 'Вход в Портал'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {isSignUp ? 'Зарегистрируйтесь для доступа' : 'Введите свои данные для входа'}
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

          {message && (
            <div className="text-sm text-green-600 bg-green-50 p-3 rounded-md border border-green-200">
              {message}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative flex w-full justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
            >
              {loading ? 'Загрузка...' : (isSignUp ? 'Зарегистрироваться' : 'Войти')}
            </button>
          </div>
        </form>

        <div className="text-center">
          <button
            onClick={() => { setIsSignUp(!isSignUp); setError(''); setMessage(''); }}
            className="text-sm font-medium text-blue-600 hover:text-blue-500"
          >
            {isSignUp ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}
          </button>
        </div>
      </div>
    </div>
  );
}
