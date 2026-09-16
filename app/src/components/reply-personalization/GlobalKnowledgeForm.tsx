'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { fetchGlobalKnowledgeBase, saveGlobalKnowledgeBase } from './api';

const CONTROL_CLASS =
  'w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

/**
 * Глобальные настройки студии: тон/ограничения и пример хорошего письма.
 * Используются всеми проектами, у которых свои значения не заполнены;
 * пер-проектное значение приоритетнее. Доступно только руководителям
 * (проверяется в API), кнопка открытия не показывается остальным.
 */
export function GlobalKnowledgeForm({
  onClose,
  /** Дергается после сохранения — родитель может обновить данные. */
  onSaved,
}: {
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [toneNotes, setToneNotes] = useState('');
  const [exampleCase, setExampleCase] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGlobalKnowledgeBase()
      .then(({ global }) => {
        setToneNotes(global.toneNotes);
        setExampleCase(global.exampleCase);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveGlobalKnowledgeBase({ toneNotes, exampleCase });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-h-[88vh] min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-7 pb-5 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Глобальные настройки ответов</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Тон и пример письма по умолчанию для всех проектов. Проект со своим значением в базе
            знаний переопределяет их.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 px-7 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-7 py-6">
            <div>
              <label className="block text-sm font-medium text-zinc-900">Тон и ограничения</label>
              <p className="mt-0.5 mb-2 text-xs text-zinc-500">
                Как обращаться, чего избегать, стиль подписи
              </p>
              <textarea
                value={toneNotes}
                onChange={(e) => setToneNotes(e.target.value)}
                rows={4}
                className={`${CONTROL_CLASS} resize-y`}
                placeholder="На «вы», без давления, подпись — имя и должность…"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-900">Пример хорошего письма</label>
              <p className="mt-0.5 mb-2 text-xs text-zinc-500">
                Один реальный пример как ориентир по стилю
              </p>
              <textarea
                value={exampleCase}
                onChange={(e) => setExampleCase(e.target.value)}
                rows={7}
                className={`${CONTROL_CLASS} resize-y`}
                placeholder="Вставьте письмо, которое хорошо сработало…"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-7 py-4">
            {error ? <p className="mr-auto text-sm text-red-600">{error}</p> : null}
            {saved ? <span className="text-sm text-green-600">Сохранено</span> : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
