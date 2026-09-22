'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { DigestBody } from './DigestBody';

/**
 * Сводка обновлений портала при входе.
 *
 * Показывается один раз на сводку: закрыл — больше не всплывёт. Если человек
 * не заходил несколько дней, окно покажет только последнюю, а пропущенные
 * спрячет за кнопкой: три окна подряд никто читать не станет, а закрывать их
 * не глядя научится с первого же раза.
 *
 * «Прочитано» здесь — то же самое «прочитано», что у колокольчика: сводки
 * лежат обычными уведомлениями, и второго признака прочитанности рядом нет.
 * Иначе закрытая модалка оставляла бы висеть непрочитанное уведомление.
 */

interface Digest {
  id: number;
  title: string;
  summary: string;
}

export function ChangelogModal() {
  const [latest, setLatest] = useState<Digest | null>(null);
  const [missed, setMissed] = useState<Digest[]>([]);
  const [showMissed, setShowMissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/changelog');
      if (!res.ok) return;
      const data = (await res.json()) as { latest: Digest | null; missed: Digest[] };
      setLatest(data.latest);
      setMissed(data.missed ?? []);
    } catch {
      /* не доехало — окно просто не показываем, это не повод ломать вход */
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    setBusy(true);
    try {
      await authFetch('/api/changelog', { method: 'POST' });
    } finally {
      // Закрываем в любом случае: если отметка не дошла, окно вернётся при
      // следующем заходе — это лучше, чем окно, которое не закрывается.
      setClosed(true);
      setBusy(false);
    }
  };

  if (!latest || closed) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Обновления портала"
    >
      <div className="my-auto flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-lg bg-indigo-50 p-2 text-indigo-600">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {showMissed ? 'Пропущенные обновления' : latest.title}
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                {showMissed
                  ? `Сводок: ${missed.length}. Все они останутся в уведомлениях.`
                  : 'Что изменилось в портале. Останется в уведомлениях, если захотите вернуться.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setClosed(true)}
            aria-label="Закрыть"
            title="Закрыть без отметки — окно вернётся при следующем заходе"
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {showMissed ? (
            <div className="space-y-6">
              {missed.map((digest) => (
                <div key={digest.id}>
                  <div className="mb-2 text-sm font-semibold text-gray-900">{digest.title}</div>
                  <DigestBody summary={digest.summary} />
                </div>
              ))}
            </div>
          ) : (
            <DigestBody summary={latest.summary} />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3">
          {/* Кнопка появляется только когда пропущено больше одной сводки —
              иначе она обещала бы содержимое, которого нет. */}
          {missed.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowMissed((v) => !v)}
              className="mr-auto rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-100"
            >
              {showMissed ? `← К сводке за ${latest.title.replace('Обновления портала за ', '')}` : `Посмотреть пропущенные (${missed.length})`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Всё понятно
          </button>
        </div>
      </div>
    </div>
  );
}
