'use client';

import { useState } from 'react';
import { sendReply } from './api';

export function SendConfirmDialog({
  open,
  text,
  qualificationId,
  draftId,
  onCancel,
  onSent,
}: {
  open: boolean;
  text: string;
  qualificationId: string;
  draftId: string;
  onCancel: () => void;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleConfirm = async () => {
    setSending(true);
    setError(null);
    try {
      await sendReply(qualificationId, draftId);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить письмо');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => !sending && onCancel()} />
      <div className="relative mx-4 w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-center text-lg font-semibold text-zinc-900">Отправить этот ответ?</h3>
        <p className="mt-2 text-center text-sm text-zinc-500">
          Письмо уйдёт получателю через Instantly. Проверьте текст в последний раз:
        </p>
        <div className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">
          {text}
        </div>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={sending}
            className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={sending}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {sending ? 'Отправка...' : 'Да, отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
