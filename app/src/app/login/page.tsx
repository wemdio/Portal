'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { LayoutDashboard, Loader2, Lock, Mail } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
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
            console.error('Error creating profile:', profileError);
            // Don't throw - user is already created in auth, profile can be created later
          }
        }

        // Check if session was created immediately (meaning email confirmation is off)
        if (data.session) {
             setMessage('Регистрация успешна! Входим...');
             // Hard reload to ensure session is picked up by middleware
             window.location.href = '/';
        } else {
             setMessage('Регистрация успешна! Но Supabase требует подтверждения почты. Проверьте настройки проекта Supabase (Auth -> Providers -> Email -> Confirm email) и отключите это требование для теста.');
        }

      } else {
        const { error, data } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        
        console.log('Login response:', { error, data });
        
        if (error) throw error;
        
        if (data.session) {
          console.log('Session established, redirecting...');
          // Hard reload to ensure session is picked up by middleware
          window.location.href = '/';
        } else {
          setError('Сессия не создана. Попробуйте снова или проверьте настройки Supabase.');
        }
      }
    } catch (caughtError) {
        console.error('Auth error:', caughtError);
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
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-md space-y-8 bg-white p-8 rounded-xl shadow-lg">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
            <LayoutDashboard className="h-6 w-6 text-blue-600" />
          </div>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-gray-900">
            {isSignUp ? 'Создать аккаунт' : 'Вход в Портал'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {isSignUp ? 'Зарегистрируйтесь для доступа' : 'Введите свои данные для входа'}
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleAuth}>
          <div className="-space-y-px rounded-md shadow-sm">
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <Mail className="h-5 w-5 text-gray-400" />
              </div>
              <input
                id="email-address"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="relative block w-full rounded-t-md border-0 py-2 pl-10 pr-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6"
                placeholder="Email адрес"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <Lock className="h-5 w-5 text-gray-400" />
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="relative block w-full rounded-b-md border-0 py-2 pl-10 pr-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm sm:leading-6"
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
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSignUp ? 'Зарегистрироваться' : 'Войти'}
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
