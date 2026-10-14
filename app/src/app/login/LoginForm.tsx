'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { supabase } from '@/lib/supabaseClient';
import { logAudit, logError } from '@/lib/loggerClient';
import { AuthShell, AuthField } from '@/components/auth/AuthShell';

/**
 * Хосты из NEXT_PUBLIC_SIGNUP_HOSTS. ENG-хост здесь не проверяется: его
 * признак приходит от сервера (`engHost`, page.tsx) — см. эффект в LoginForm.
 */
function isSignupHost(host: string): boolean {
  const hosts = (process.env.NEXT_PUBLIC_SIGNUP_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hosts.length === 0) return false;
  return hosts.includes(host);
}

/**
 * Тексты входа. Хост решает серверная обёртка (page.tsx, isEngAppHost — тот
 * же признак, что у middleware): на ENG-хосте — английские, на остальных —
 * прежние русские, слово в слово (строки ниже перенесены из JSX как были;
 * многострочный абзац JSX склеивал через один пробел — так и записан).
 */
const LOGIN_TEXT_RU = {
  forgotSendFailed: 'Не удалось отправить запрос. Попробуйте позже.',
  forgotNetworkError: 'Сетевая ошибка. Проверьте подключение.',
  noSession: 'Сессия не создана. Попробуйте снова.',
  unknownAuthError: 'Неизвестная ошибка при аутентификации.',
  wrongCredentials: 'Неверный email или пароль.',
  serverDown: 'Сервер временно недоступен. Подождите минуту и попробуйте ещё раз.',
  title: 'Вход',
  subtitle: 'Введите данные для входа',
  forgotDoneTitle: 'Проверьте почту',
  forgotDoneBody:
    'Если такой аккаунт зарегистрирован — на привязанный email отправлен новый пароль. Войдите с ним и сразу смените на свой через «Настройки».',
  forgotDoneNote: 'Письмо может прийти в течение минуты. Не пришло — проверьте папку «Спам».',
  forgotDoneOk: 'Понятно',
  forgotTitle: 'Восстановление пароля',
  forgotBody: 'Укажите email от аккаунта — пришлём на него новый пароль.',
  forgotCancel: 'Отмена',
  forgotSending: 'Отправка…',
  forgotSend: 'Сбросить',
  passwordLabel: 'Пароль',
  submitting: 'Загрузка…',
  submit: 'Войти',
  forgotLink: 'Забыли пароль?',
  adminOnly: 'Доступ выдаёт администратор',
  noAccount: 'Нет аккаунта?',
  signupLink: 'Зарегистрироваться',
} as const;

type LoginText = { [K in keyof typeof LOGIN_TEXT_RU]: string };

/**
 * ENG. Ссылки «Set your own» в тексте сброса нет: ссылка на страницу Account
 * приходит в самом письме с новым паролем (api/auth/forgot-password, ветка
 * ENG) и ведёт через этот вход (?next=, см. page.tsx). adminOnly на ENG-хосте
 * не рисуется никогда (signupAllowed там всегда true) — перевод ради полноты
 * таблицы.
 */
const LOGIN_TEXT_EN: LoginText = {
  forgotSendFailed: 'Could not send the request. Try again later.',
  forgotNetworkError: 'Network error. Check your connection.',
  noSession: 'The session was not created. Try again.',
  unknownAuthError: 'Could not sign in. Try again.',
  wrongCredentials: 'Wrong email or password.',
  serverDown: 'The server is not responding. Wait a minute and try again.',
  title: 'Sign in',
  subtitle: 'Enter your details to sign in',
  forgotDoneTitle: 'Check your email',
  forgotDoneBody:
    'If an account with this email exists, we sent it a new password. Sign in with it, then set your own password from the link in that email.',
  forgotDoneNote: 'It can take a minute. Not there? Check spam.',
  forgotDoneOk: 'OK',
  forgotTitle: 'Reset your password',
  forgotBody: 'Enter your account email — we will send a new password to it.',
  forgotCancel: 'Cancel',
  forgotSending: 'Sending…',
  forgotSend: 'Send',
  passwordLabel: 'Password',
  submitting: 'Signing in…',
  submit: 'Sign in',
  forgotLink: 'Forgot password?',
  adminOnly: 'Access is granted by an administrator',
  noAccount: 'No account?',
  signupLink: 'Create one',
};

/**
 * Единственный адрес, куда вход может вернуть после себя (`?next=` на
 * ENG-хосте, проверка — в page.tsx). Тип-литерал, а не string: форма не
 * умеет уводить никуда, кроме '/' и этой страницы.
 */
export type EngSignInNext = '/client/eng/account';

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

/**
 * Вход. `engHost` — хост запроса на сервере (page.tsx): на ENG-хосте ссылки
 * регистрации и сброса видны уже в серверном HTML (signupAllowed там всегда
 * true), а русские юридические ссылки не рисуются. Вне ENG — прежнее
 * поведение: признак берётся в браузере после монтирования.
 * `afterSignIn` — куда уйти после входа вместо '/'; page.tsx передаёт его
 * только на ENG-хосте и только для точного `?next=/client/eng/account`.
 */
export function LoginForm({ engHost, afterSignIn }: { engHost: boolean; afterSignIn?: EngSignInNext }) {
  const t: LoginText = engHost ? LOGIN_TEXT_EN : LOGIN_TEXT_RU;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signupAllowed, setSignupAllowed] = useState(engHost);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotDone, setForgotDone] = useState(false);
  const [forgotError, setForgotError] = useState('');
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // ENG-кабинет принимает саморегистрацию всегда — иначе на ENG-хосте
      // некуда попасть новому клиенту. Признак ENG-хоста — серверный
      // (`engHost`), а не браузерный: браузер видит хост ENG только через
      // NEXT_PUBLIC_ENG_APP_HOST (lib/engMarket), и при расхождении с
      // сервером ссылки регистрации и сброса пропадали бы после монтирования.
      // Вне ENG engHost=false — прежняя проверка по NEXT_PUBLIC_SIGNUP_HOSTS.
      setSignupAllowed(engHost || isSignupHost(window.location.hostname));
    }
  }, [engHost]);

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
        setForgotError(t.forgotSendFailed);
        return;
      }
      setForgotDone(true);
    } catch {
      setForgotError(t.forgotNetworkError);
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
        window.location.href = afterSignIn ?? '/';
      } else {
        setError(t.noSession);
        void logAudit('auth.login.missing_session', 'Login completed without session', { withSession: false });
      }
    } catch (caughtError) {
      void logError('auth.login.failed', caughtError);
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : typeof caughtError === 'object' && caughtError !== null && 'message' in caughtError && typeof (caughtError as { message: unknown }).message === 'string'
            ? ((caughtError as { message: string }).message)
            : t.unknownAuthError;
      const errorCode =
        typeof caughtError === 'object' && caughtError !== null && 'code' in caughtError && typeof (caughtError as { code: unknown }).code === 'string'
          ? (caughtError as { code: string }).code
          : '';

      // GoTrue кладёт машинный код в error.code, а в message — английский
      // текст («Invalid login credentials»). Проверяем оба.
      if (errorCode === 'invalid_credentials' || errorMessage.includes('invalid_credentials') || /invalid login credentials/i.test(errorMessage)) {
        setError(t.wrongCredentials);
      } else if (
        // Сервер авторизации недоступен/отвечает мусором (падение БД,
        // 502/504 от гейтвея): message бывает пустым или «{}» — показывать
        // это пользователю бессмысленно. Инцидент 14.07.2026.
        !errorMessage.trim() ||
        errorMessage.trim() === '{}' ||
        /fetch failed|failed to fetch|networkerror|load failed|timeout|upstream|unavailable|bad gateway/i.test(errorMessage)
      ) {
        setError(t.serverDown);
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title={t.title}
      subtitle={t.subtitle}
      lang={engHost ? 'en' : undefined}
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
                    {t.forgotDoneTitle}
                  </h3>
                  <p className="text-sm mb-2" style={{ color: 'var(--cp-paper-mute)' }}>
                    {t.forgotDoneBody}
                  </p>
                  <p className="text-xs mb-5" style={{ color: 'var(--cp-paper-faint)' }}>
                    {t.forgotDoneNote}
                  </p>
                  <div className="flex justify-end">
                    <button type="button" onClick={closeForgot} className="neu-btn px-4 py-2 text-sm font-semibold">
                      {t.forgotDoneOk}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
                    {t.forgotTitle}
                  </h3>
                  <p className="text-sm mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
                    {t.forgotBody}
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
                        {t.forgotCancel}
                      </button>
                      <button
                        type="submit"
                        disabled={forgotLoading || !forgotEmail.trim()}
                        className="neu-btn px-4 py-2 text-sm font-semibold"
                      >
                        {forgotLoading ? t.forgotSending : t.forgotSend}
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
          label={t.passwordLabel}
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
          {loading ? t.submitting : t.submit}
        </button>

        {signupAllowed && (
          <div className="text-center">
            <button type="button" onClick={openForgot} className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
              {t.forgotLink}
            </button>
          </div>
        )}
      </form>

      {/* «Доступ выдаёт администратор» — только где сам-регистрация выключена
          (внутренний портал). На signup-хостах (app.outreachos.pro) показываем
          CTA на регистрацию, иначе две строки противоречат друг другу. */}
      {!signupAllowed && (
        <p className="mt-5 text-center text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
          {t.adminOnly}
        </p>
      )}

      {signupAllowed && (
        <p className="mt-5 text-center text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          {t.noAccount}{' '}
          <Link href={'/signup' as Route} className="font-semibold" style={{ color: 'var(--cp-amber)' }}>
            {t.signupLink}
          </Link>
        </p>
      )}

      {/* Public legal links — quiet text buttons. Русские документы (оферта,
          согласие и политика по 152-ФЗ) — только вне ENG-хоста: английских
          пока нет (решение владельца 9). */}
      {!engHost && (
        <div
          className="mt-5 pt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs font-medium"
          style={{ borderTop: '1px solid var(--cp-divider)', color: 'var(--cp-paper-faint)' }}
        >
          <a href="/offer" style={{ color: 'var(--cp-paper-faint)' }}>Договор оферты</a>
          <span aria-hidden>·</span>
          <a href="/consent" style={{ color: 'var(--cp-paper-faint)' }}>Согласие на обработку персональных данных</a>
          <span aria-hidden>·</span>
          <a href="/privacy" style={{ color: 'var(--cp-paper-faint)' }}>Политика конфиденциальности</a>
        </div>
      )}
    </AuthShell>
  );
}
