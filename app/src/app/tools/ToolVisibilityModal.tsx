'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, ChevronDown } from 'lucide-react';

import { authFetch, authFetchJson } from '@/lib/authFetch';
import { ALL_TOOL_IDS, TOOLS_CONFIG, type ToolId } from '@/lib/toolsRegistry';
import { sortToolIdsByTitle } from '@/lib/toolsSort';
import {
  TOOL_STATUS_OPTIONS,
  effectiveToolStatus,
  type ToolStatus,
} from '@/lib/toolStatus';
import type { Locale } from '@/lib/i18n';

interface Props {
  open: boolean;
  locale: Locale;
  onClose: () => void;
  /** Вызывается после успешного PUT'a статуса хотя бы для одного тула —
   *  родитель должен пере-фетчить `/api/user/tools` и обновить /tools. */
  onChanged: () => void;
}

interface ToolStateRow {
  status: ToolStatus;
  new_since: string | null;
}

/**
 * Админская модалка глобальных статусов инструментов. На каждый клик в select
 * улетает POST в `/api/admin/tool-visibility` с одним апдейтом — без отдельной
 * кнопки «Сохранить». Эффективный статус (с учётом 7-дневного истечения 'new')
 * считается через `effectiveToolStatus` — в селекторе показывается именно он,
 * чтобы admin не видел «протухшее» состояние БД.
 */
export function ToolVisibilityModal({ open, locale, onClose, onChanged }: Props) {
  const [states, setStates] = useState<Record<string, ToolStateRow> | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Грузим актуальную карту при каждом открытии — состояние мог изменить
  // другой админ за прошедшее с прошлого раза время.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await authFetchJson<{ states: Record<string, ToolStateRow> }>(
          '/api/admin/tool-visibility',
          { method: 'GET' },
        );
        if (!cancelled) setStates(data.states ?? {});
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

  const changeStatus = useCallback(
    async (toolId: ToolId, nextStatus: ToolStatus) => {
      if (savingId) return;
      setSavingId(toolId);
      setError(null);
      // Оптимистично обновляем UI. Если status='new' — выставляем new_since
      // в локальном состоянии тоже (сервер сделает то же самое).
      setStates((prev) =>
        prev
          ? {
              ...prev,
              [toolId]: {
                status: nextStatus,
                new_since: nextStatus === 'new' ? new Date().toISOString() : null,
              },
            }
          : prev,
      );
      try {
        const res = await authFetch('/api/admin/tool-visibility', {
          method: 'POST',
          body: JSON.stringify({ updates: { [toolId]: { status: nextStatus } } }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body?.error ?? `Error ${res.status}`);
        }
        onChanged();
      } catch (e) {
        // Откат: перечитываем состояние с сервера, чтобы не остаться рассинхронизированными.
        try {
          const data = await authFetchJson<{ states: Record<string, ToolStateRow> }>(
            '/api/admin/tool-visibility',
            { method: 'GET' },
          );
          setStates(data.states ?? {});
        } catch {
          // ignore — модалка покажет ошибку и юзер закроет/откроет заново
        }
        setError(e instanceof Error ? e.message : 'Не удалось сохранить');
      } finally {
        setSavingId(null);
      }
    },
    [savingId, onChanged],
  );

  // Портал нужен чтобы overlay растягивался на ВЕСЬ viewport, а не упирался
  // в скролл-контейнер `<main>` из LayoutShell. Цель — оболочка `.portal-shell`,
  // а не body: тёмная тема портала — правила под оболочкой (как у DealModal),
  // вне её модалка оставалась со светлыми линиями, кнопкой и плашками.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Сортировка: для RU-локали кириллица первой (А-Я), затем латиница
  // (A-Z). Для EN-локали — просто алфавитно. Логика общая с /tools-страницей.
  const sortedToolIds = useMemo(() => sortToolIdsByTitle(ALL_TOOL_IDS, locale), [locale]);

  if (!open || !mounted || typeof document === 'undefined') return null;

  const title = locale === 'en' ? 'Tool visibility (global)' : 'Видимость инструментов (глобально)';
  const subtitle = locale === 'en'
    ? 'Status applies to everyone, including admin. “New” auto-clears after 7 days.'
    : 'Статус действует на всех, включая admin. «Новое» снимается автоматически через 7 дней.';

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={locale === 'en' ? 'Close' : 'Закрыть'}
            className="-mr-1.5 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-[var(--glass-row-hover)]"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {error ? (
          <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loading || !states ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" aria-hidden />
              {locale === 'en' ? 'Loading…' : 'Загрузка…'}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {sortedToolIds.map((toolId) => {
                const config = TOOLS_CONFIG[toolId];
                const toolTitle = locale === 'en' ? (config.title_en ?? config.title) : config.title;
                const row = states[toolId];
                // Show effective status в селекторе, чтобы admin видел то же что юзеры.
                const effective = row
                  ? effectiveToolStatus(row.status, row.new_since)
                  : ('active' as ToolStatus);
                const isSaving = savingId === toolId;
                const sinceLabel = effective === 'new' && row?.new_since
                  ? new Date(row.new_since).toLocaleDateString('ru-RU')
                  : null;
                return (
                  <li
                    key={toolId}
                    className="flex items-center justify-between gap-4 rounded-lg px-3 py-2 transition-colors hover:bg-[var(--glass-row-hover)]"
                  >
                    <div className="min-w-0">
                      <div
                        className={`truncate text-sm font-medium ${effective === 'disabled' ? 'text-gray-500' : 'text-gray-900'}`}
                      >
                        {toolTitle}
                      </div>
                      <div className="truncate font-mono text-[11px] text-gray-400">
                        {toolId}
                        {sinceLabel ? ` · «Новое» c ${sinceLabel}` : ''}
                      </div>
                    </div>
                    {/* Цвет статуса — в globals.css (.tool-status): тон по смыслу
                        как плашки карточек, одинаково спокойный в обеих темах. */}
                    <span className="tool-status relative inline-flex shrink-0" data-status={effective}>
                      <select
                        value={effective}
                        disabled={isSaving}
                        onChange={(e) => void changeStatus(toolId, e.target.value as ToolStatus)}
                        aria-label={toolTitle}
                        title={
                          TOOL_STATUS_OPTIONS.find((o) => o.value === effective)?.[locale === 'en' ? 'hint_en' : 'hint_ru']
                        }
                        className="tool-status-select w-40 cursor-pointer appearance-none rounded-full border py-1.5 pl-7 pr-8 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-60"
                      >
                        {TOOL_STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {locale === 'en' ? opt.label_en : opt.label_ru}
                          </option>
                        ))}
                      </select>
                      <span
                        aria-hidden
                        className="pointer-events-none absolute left-3 top-1/2 z-[1] h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-current"
                      />
                      {isSaving ? (
                        <Loader2
                          className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin"
                          aria-hidden
                        />
                      ) : (
                        <ChevronDown
                          className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-70"
                          aria-hidden
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t border-gray-200 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-[var(--glass-row-hover)]"
          >
            {locale === 'en' ? 'Close' : 'Закрыть'}
          </button>
        </div>
      </div>
    </div>
  );

  // Оболочка есть на всех экранах портала; body — страховка (лучше без темы, чем без модалки).
  return createPortal(overlay, document.querySelector('.portal-shell') ?? document.body);
}
