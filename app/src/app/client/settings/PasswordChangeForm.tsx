'use client';

import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2, Sparkles, Check, AlertCircle } from 'lucide-react';
import { generateStrongPassword } from '@/lib/passwordGenerator';
import { clientApiFetch } from '@/lib/clientFetcher';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

export function PasswordChangeForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  function handleGenerate() {
    const pw = generateStrongPassword(14);
    setNext(pw);
    setConfirm(pw);
    setShowNext(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setStatus({ kind: 'error', message: 'Новый пароль и подтверждение не совпадают' });
      return;
    }
    if (next.length < 8) {
      setStatus({ kind: 'error', message: 'Новый пароль должен быть не короче 8 символов' });
      return;
    }
    if (next === current) {
      setStatus({ kind: 'error', message: 'Новый пароль совпадает с текущим' });
      return;
    }

    setStatus({ kind: 'loading' });
    try {
      await clientApiFetch('/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setStatus({ kind: 'ok' });
      setCurrent('');
      setNext('');
      setConfirm('');
      setShowNext(false);
      setShowCurrent(false);
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Сетевая ошибка',
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PasswordField
        id="current-password"
        label="Текущий пароль"
        value={current}
        onChange={setCurrent}
        show={showCurrent}
        onToggleShow={() => setShowCurrent((v) => !v)}
        autoComplete="current-password"
      />

      <PasswordField
        id="new-password"
        label="Новый пароль"
        value={next}
        onChange={setNext}
        show={showNext}
        onToggleShow={() => setShowNext((v) => !v)}
        autoComplete="new-password"
        rightAction={
          <button
            type="button"
            onClick={handleGenerate}
            className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
            title="Сгенерировать сильный пароль"
          >
            <Sparkles size={14} />
            Сгенерировать
          </button>
        }
      />

      <PasswordField
        id="confirm-password"
        label="Подтвердите новый пароль"
        value={confirm}
        onChange={setConfirm}
        show={showNext}
        onToggleShow={() => setShowNext((v) => !v)}
        autoComplete="new-password"
      />

      <div className="flex items-center gap-4 pt-2">
        <button
          type="submit"
          disabled={status.kind === 'loading'}
          className="inline-flex items-center gap-2 rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status.kind === 'loading' ? <Loader2 size={16} className="animate-spin" /> : null}
          {status.kind === 'loading' ? 'Сохраняем…' : 'Сменить пароль'}
        </button>

        {status.kind === 'ok' && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-400">
            <Check size={14} /> Готово. Письмо отправлено на ваш email.
          </span>
        )}
        {status.kind === 'error' && (
          <span className="inline-flex items-center gap-1 text-sm text-red-400">
            <AlertCircle size={14} /> {status.message}
          </span>
        )}
      </div>
    </form>
  );
}

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  autoComplete: string;
  rightAction?: React.ReactNode;
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  show,
  onToggleShow,
  autoComplete,
  rightAction,
}: PasswordFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-neutral-300">
        {label}
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            id={id}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required
            minLength={8}
            maxLength={72}
            autoComplete={autoComplete}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 pr-10 font-mono text-sm text-neutral-100 focus:border-neutral-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={onToggleShow}
            tabIndex={-1}
            aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200"
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {rightAction}
      </div>
    </div>
  );
}
