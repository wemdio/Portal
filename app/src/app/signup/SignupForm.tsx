'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { AuthShell, AuthField } from '@/components/auth/AuthShell';

/**
 * Форма саморегистрации. Хост решает серверная обёртка (page.tsx, тот же
 * признак isEngAppHost, что у middleware): на ENG-хосте (app.outreachos.xyz)
 * — английская форма EngSignupForm, на остальных — прежняя русская
 * RuSignupForm, перенесённая из page.tsx без единой правки.
 */
export function SignupForm({ engHost }: { engHost: boolean }) {
  return engHost ? <EngSignupForm /> : <RuSignupForm />;
}

/**
 * Self-signup page. Visible on hosts listed in NEXT_PUBLIC_SIGNUP_HOSTS
 * (login page conditionally exposes the link). The page itself doesn't
 * check the host — anyone with the URL can register. Defense-in-depth would
 * be checking host server-side; out of scope for this PR.
 */
function RuSignupForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consent) {
      setError('Нужно согласие на обработку персональных данных');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name: name, company, phone, telegram }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Ошибка регистрации');
        return;
      }
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        setError('Аккаунт создан, но не получилось войти. Попробуйте ещё раз через /login.');
        return;
      }
      router.replace('/client');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Регистрация" subtitle="Создайте аккаунт за минуту">
      <form onSubmit={onSubmit} className="space-y-3">
        <AuthField
          label="Имя"
          id="name"
          type="text"
          required
          autoComplete="name"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <AuthField
          label="Компания"
          id="company"
          type="text"
          required
          autoComplete="organization"
          maxLength={200}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        <AuthField
          label="Email"
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Телефон"
          optional
          id="phone"
          type="tel"
          autoComplete="tel"
          maxLength={50}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <AuthField
          label="Telegram"
          optional
          id="telegram"
          type="text"
          maxLength={100}
          placeholder="@username"
          value={telegram}
          onChange={(e) => setTelegram(e.target.value)}
        />
        <AuthField
          label="Пароль"
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          hint="Минимум 8 символов"
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

        <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            required
            className="mt-0.5 shrink-0"
            style={{ accentColor: 'var(--cp-amber)' }}
          />
          <span>
            Я согласен на{' '}
            <a href="/consent" target="_blank" rel="noopener" className="font-semibold" style={{ color: 'var(--cp-amber)' }}>
              обработку персональных данных
            </a>{' '}
            и принимаю{' '}
            <a href="/privacy" target="_blank" rel="noopener" className="font-semibold" style={{ color: 'var(--cp-amber)' }}>
              политику
            </a>.
          </span>
        </label>

        <button type="submit" disabled={loading || !consent} className="neu-btn w-full px-4 py-2.5 text-sm font-semibold">
          {loading ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
        </button>

        <p className="text-center text-[11px] leading-relaxed" style={{ color: 'var(--cp-paper-faint)' }}>
          Нажимая «Зарегистрироваться», вы принимаете{' '}
          <a href="/offer" target="_blank" rel="noopener" className="font-semibold" style={{ color: 'var(--cp-paper-mute)' }}>
            Договор оферты
          </a>.
        </p>
      </form>

      <p className="mt-4 text-center text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
        Уже есть аккаунт?{' '}
        <Link href="/login" className="font-semibold" style={{ color: 'var(--cp-amber)' }}>
          Войти
        </Link>
      </p>
    </AuthShell>
  );
}

const ENG_CONSENT_REQUIRED = 'To create an account, agree to the processing of your personal data.';
const ENG_SIGNUP_FAILED = 'Could not create the account. Try again.';
const ENG_SIGN_IN_FAILED = 'Your account is created, but we could not sign you in. Sign in on the sign-in page.';
const ENG_NETWORK_ERROR = 'Network error. Check your connection and try again.';

/**
 * Английская регистрация ENG-кабинета. Отличия от RU-формы — только то, что
 * английскому клиенту не нужно или неправда:
 *  - нет полей «Телефон» и «Telegram» (роут принимает их пустыми);
 *  - нет ссылок на русские /consent, /privacy и /offer (оферта и политика по
 *    152-ФЗ — документы RU-юрлица для российских клиентов);
 *  - ошибки роута приходят уже по-английски (api/signup, ветка ENG), сырого
 *    текста исключения на экран не выводим.
 * Путь после регистрации тот же: вход → /client → middleware → /client/eng.
 */
function EngSignupForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consent) {
      setError(ENG_CONSENT_REQUIRED);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name: name, company }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        setError(typeof data.error === 'string' && data.error.trim() ? data.error : ENG_SIGNUP_FAILED);
        return;
      }
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        setError(ENG_SIGN_IN_FAILED);
        return;
      }
      router.replace('/client');
    } catch {
      setError(ENG_NETWORK_ERROR);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="It takes about a minute" lang="en">
      <form onSubmit={onSubmit} className="space-y-3">
        <AuthField
          label="Your name"
          id="name"
          type="text"
          required
          autoComplete="name"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <AuthField
          label="Company"
          id="company"
          type="text"
          required
          autoComplete="organization"
          maxLength={200}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        <AuthField
          label="Work email"
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Password"
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          hint="At least 8 characters"
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

        {/*
          OWNER ITEM — решение владельца 9: английских Terms of Service и Privacy
          Policy пока нет, поэтому согласие не называет ни одного документа (на
          несуществующий документ клиент согласиться не может), а строки «By
          clicking … you accept the Terms of Service» нет вовсе. Русские
          /consent, /privacy и /offer к английскому клиенту не относятся.
          Когда владелец пришлёт документы — НЕ построено, план: серверные env
          ENG_TERMS_URL и ENG_PRIVACY_URL читает page.tsx (только на ENG-хосте)
          и передаёт сюда; согласие получает ссылки на оба документа, строка
          про Terms возвращается, ENG-футер входа (LoginForm.tsx) — тоже.
        */}
        <label className="flex items-start gap-2 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            required
            className="mt-0.5 shrink-0"
            style={{ accentColor: 'var(--cp-amber)' }}
          />
          <span>I agree to the processing of my personal data to create and run this account.</span>
        </label>

        <button type="submit" disabled={loading || !consent} className="neu-btn w-full px-4 py-2.5 text-sm font-semibold">
          {loading ? 'Creating your account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-4 text-center text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
        Already have an account?{' '}
        <Link href="/login" className="font-semibold" style={{ color: 'var(--cp-amber)' }}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
