'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';

import { authFetch, authFetchJson } from '@/lib/authFetch';
import { ALL_TOOL_IDS, TOOLS_CONFIG, type ToolId } from '@/lib/toolsRegistry';
import type { Locale } from '@/lib/i18n';

interface Props {
  open: boolean;
  locale: Locale;
  onClose: () => void;
  /** Зовётся после успешного изменения хотя бы одного тумблера — родитель
   *  должен пере-фетчить `/api/user/tools` и обновить отрисовку. */
  onChanged: () => void;
}

/**
 * Админская модалка глобальной видимости инструментов.
 * Каждый тумблер сразу шлёт POST — без отдельной кнопки «Сохранить».
 * При выключении инструмент исчезает у ВСЕХ (включая самого админа);
 * вернуть можно только через эту же модалку.
 */
export function ToolVisibilityModal({ open, locale, onClose, onChanged }: Props) {
  const [visibility, setVisibility] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Загружаем актуальную карту при каждом открытии — состояние могло
  // измениться с предыдущего раза (например, другим админом).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await authFetchJson<{ visibility: Record<string, boolean> }>(
          '/api/admin/tool-visibility',
          { method: 'GET' },
        );
        if (!cancelled) setVisibility(data.visibility ?? {});
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Закрытие по Escape — стандартный паттерн для модалок.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const toggle = useCallback(
    async (toolId: ToolId, nextEnabled: boolean) => {
      if (savingId) return;
      setSavingId(toolId);
      setError(null);
      // Оптимистично обновляем UI — пока POST не упал.
      setVisibility((prev) => (prev ? { ...prev, [toolId]: nextEnabled } : prev));
      try {
        const res = await authFetch('/api/admin/tool-visibility', {
          method: 'POST',
          body: JSON.stringify({ visibility: { [toolId]: nextEnabled } }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body?.error ?? `Error ${res.status}`);
        }
        onChanged();
      } catch (e) {
        // Откатываем — состояние из БД не поменялось.
        setVisibility((prev) => (prev ? { ...prev, [toolId]: !nextEnabled } : prev));
        setError(e instanceof Error ? e.message : 'Не удалось сохранить');
      } finally {
        setSavingId(null);
      }
    },
    [savingId, onChanged],
  );

  if (!open) return null;

  const title = locale === 'en' ? 'Tool visibility (global)' : 'Видимость инструментов (глобально)';
  const subtitle = locale === 'en'
    ? 'Off = hidden from /tools for everyone, including admins. Per-user toggles still apply on top of this.'
    : 'Выключено = скрыто на /tools у всех, включая админов. Per-user тумблеры применяются поверх.';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={locale === 'en' ? 'Close' : 'Закрыть'}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {error ? (
          <div className="mx-6 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading || !visibility ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" aria-hidden />
              {locale === 'en' ? 'Loading…' : 'Загрузка…'}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {ALL_TOOL_IDS.map((toolId) => {
                const config = TOOLS_CONFIG[toolId];
                const toolTitle = locale === 'en' ? (config.title_en ?? config.title) : config.title;
                const enabled = visibility[toolId] !== false;
                const isSaving = savingId === toolId;
                return (
                  <li
                    key={toolId}
                    className="flex items-center justify-between gap-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{toolTitle}</div>
                      <div className="text-[11px] text-gray-400 font-mono truncate">{toolId}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      disabled={isSaving}
                      onClick={() => void toggle(toolId, !enabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                        enabled ? 'bg-blue-600' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                          enabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-gray-200 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            {locale === 'en' ? 'Close' : 'Закрыть'}
          </button>
        </div>
      </div>
    </div>
  );
}
