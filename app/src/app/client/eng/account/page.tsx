'use client';

/**
 * /client/eng/account — аккаунт ENG-клиента: адрес входа и смена пароля.
 *
 * Сюда ведёт письмо «Your new outreachOS password» (api/auth/forgot-password,
 * ветка ENG): «войдите с этим паролем и задайте свой». В меню пункта нет
 * намеренно — набор пунктов закреплён tests/lib/clientNav.test.ts.
 *
 * Смена — существующий POST /api/client/password: он перепроверяет текущий
 * пароль входом, на ENG-хосте отвечает по-английски (неверный текущий — 400,
 * чтобы authFetch не повторял запрос после обновления сессии) и шлёт
 * английское уведомление без самого пароля (engPasswordChanged.ts). Проверки
 * ниже — те же правила, что у роута (8–72 символа, не совпадает с текущим),
 * плюс совпадение с подтверждением; роут — второй замок.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import { engSafeText } from '@/components/client-eng/engText';
import { EngCard, EngSpinner } from '@/components/client-eng/ui';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

const CHANGE_FAILED = 'Could not change the password. Try again in a minute.';
const SESSION_EXPIRED = 'Your session has expired. Sign in again, then change your password.';

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'done' }
  | { kind: 'error'; text: string };

/** Ошибка формы до отправки; null — можно отправлять. */
function passwordFormError(current: string, next: string, confirm: string): string | null {
  if (!current) return 'Enter your current password.';
  if (next.length < PASSWORD_MIN) return `The new password must be at least ${PASSWORD_MIN} characters.`;
  if (next.length > PASSWORD_MAX) return `The new password must be at most ${PASSWORD_MAX} characters.`;
  if (next === current) return 'The new password is the same as the current one.';
  if (next !== confirm) return 'The new password and its confirmation do not match.';
  return null;
}

export default function EngAccountPage() {
  // undefined — сессия ещё читается; null — адреса в сессии нет.
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!cancelled) setEmail(session?.user?.email ?? null);
      } catch {
        if (!cancelled) setEmail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const formError = passwordFormError(current, next, confirm);
    if (formError) {
      setStatus({ kind: 'error', text: formError });
      return;
    }
    setStatus({ kind: 'saving' });
    try {
      const res = await authFetch('/api/client/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (res.ok) {
        setStatus({ kind: 'done' });
        setCurrent('');
        setNext('');
        setConfirm('');
        return;
      }
      if (res.status === 401) {
        setStatus({ kind: 'error', text: SESSION_EXPIRED });
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const routeText = typeof body?.error === 'string' ? engSafeText(body.error) : null;
      setStatus({ kind: 'error', text: routeText ?? CHANGE_FAILED });
    } catch {
      setStatus({ kind: 'error', text: CHANGE_FAILED });
    }
  };

  const saving = status.kind === 'saving';

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    autoComplete: 'current-password' | 'new-password',
    hint?: string,
  ) => (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
        {label}
      </span>
      <input
        id={id}
        type="password"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (status.kind === 'error' || status.kind === 'done') setStatus({ kind: 'idle' });
        }}
        required
        maxLength={PASSWORD_MAX}
        autoComplete={autoComplete}
        className="ds-input w-full"
      />
      {hint ? (
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          {hint}
        </span>
      ) : null}
    </label>
  );

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Account
        </h1>
      </header>

      <EngCard className="mb-4">
        <h3 className="ds-eyebrow mb-2">Email</h3>
        {email === undefined ? (
          <EngSpinner />
        ) : (
          <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            {email
              ? `You sign in with ${email}.`
              : 'We could not read the email of this session. Refresh the page.'}
          </p>
        )}
      </EngCard>

      <EngCard>
        <h3 className="ds-eyebrow mb-3">Change password</h3>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          {field('current-password', 'Current password', current, setCurrent, 'current-password')}
          {field(
            'new-password',
            'New password',
            next,
            setNext,
            'new-password',
            `${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
          )}
          {field('confirm-password', 'Confirm the new password', confirm, setConfirm, 'new-password')}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={saving}
              className="ds-btn-primary inline-flex items-center gap-2 self-start"
            >
              {saving && <EngSpinner />}
              {saving ? 'Changing…' : 'Change password'}
            </button>
            {status.kind === 'done' && (
              <span className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
                Your password is changed. Use it the next time you sign in.
              </span>
            )}
            {status.kind === 'error' && (
              <span className="text-sm" style={{ color: 'var(--cp-red)' }}>
                {status.text}
              </span>
            )}
          </div>
        </form>
      </EngCard>

      <p className="mt-5 text-sm m-0">
        <Link href="/client/eng" className="underline" style={{ color: 'var(--cp-text-m)' }}>
          Back to Outreach
        </Link>
      </p>
    </div>
  );
}
