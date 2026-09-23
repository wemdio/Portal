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
  /** «Сводка за период с 9:00 21 сентября до 9:00 22 сентября». */
  period: string | null;
  summary: string;
}

export function ChangelogModal() {
  const [latest, setLatest] = useState<Digest | null>(null);
  const [missed, setMissed] = useState<Digest[]>([]);
  const [showMissed, setShowMissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [visible, setVisible] = useState(false);

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

  // Окно сначала монтируется скрытым, и только на следующем кадре получает
  // data-open — иначе браузер не увидит начального положения и переход не
  // проиграется, окно просто возникнет.
  useEffect(() => {
    if (!latest) return;
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [latest]);

  // Закрытие — сначала уводим окно вниз, потом снимаем его со страницы.
  // Время чуть больше самого долгого перехода в globals.css.
  const close = () => {
    setVisible(false);
    setTimeout(() => setClosed(true), 450);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await authFetch('/api/changelog', { method: 'POST' });
    } finally {
      // Закрываем в любом случае: если отметка не дошла, окно вернётся при
      // следующем заходе — это лучше, чем окно, которое не закрывается.
      close();
      setBusy(false);
    }
  };

  if (!latest || closed) return null;

  return (
    <div
      className="portal-changelog-backdrop fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      data-open={visible}
      role="dialog"
      aria-modal="true"
      aria-label="Обновления портала"
    >
      <div className="portal-changelog-card my-auto flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
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
                  // Дата в заголовке — «за 22 сентября», а сутки считаются от
                  // девяти утра до девяти утра. Без явных границ это читается
                  // как «за день, который ещё идёт».
                  : latest.period ?? 'Что изменилось в портале.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
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
                  <div className="text-sm font-semibold text-gray-900">{digest.title}</div>
                  {digest.period ? (
                    <div className="mb-2 text-[11px] text-gray-400">{digest.period}</div>
                  ) : null}
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
