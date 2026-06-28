'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { AuthShell, AuthField } from '@/components/auth/AuthShell';

/**
 * Self-signup page. Visible on hosts listed in NEXT_PUBLIC_SIGNUP_HOSTS
 * (login page conditionally exposes the link). The page itself doesn't
 * check the host — anyone with the URL can register. Defense-in-depth would
 * be checking host server-side; out of scope for this PR.
 */
export default function SignupPage() {
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
