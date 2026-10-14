'use client';

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

/**
 * Колонки, ширину которых тянут мышью за правую границу: «Персонализированные
 * ответы» (проекты / письма) и «Рассылка» → «Письма» (кампании / переписки).
 * Длинные названия и адреса резались троеточием. Ширина запоминается в
 * браузере под storageKey; двойной клик по границе возвращает исходную.
 */
export function useColumnWidths<K extends string>(
  storageKey: string,
  defaults: Record<K, number>,
  limits: Record<K, readonly [number, number]>,
) {
  const [widths, setWidths] = useState<Record<K, number>>(defaults);

  const clamp = (key: K, value: number) => {
    const [min, max] = limits[key];
    return Math.round(Math.min(max, Math.max(min, value)));
  };

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<Record<K, number>> | null;
      if (!saved) return;
      const next = { ...defaults };
      for (const key of Object.keys(defaults) as K[]) {
        const value = Number(saved[key]);
        if (value) next[key] = clamp(key, value);
      }
      setWidths(next);
    } catch {
      // нет доступа к хранилищу — ширина по умолчанию
    }
    // Читаем один раз при открытии экрана.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const save = (next: Record<K, number>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // не запомнилось — не страшно
    }
  };

  const startDrag = (key: K, event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widths[key];
    let latest = widths;
    const onMove = (e: MouseEvent) => {
      latest = { ...latest, [key]: clamp(key, startWidth + e.clientX - startX) };
      setWidths(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      save(latest);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const reset = (key: K) => {
    const next = { ...widths, [key]: defaults[key] };
    setWidths(next);
    save(next);
  };

  return { widths, startDrag, reset };
}

/** Ручка на правой границе колонки; колонке нужен `relative`. */
export function ColumnResizer({
  onMouseDown,
  onDoubleClick,
  className = '',
}: {
  onMouseDown: (e: ReactMouseEvent) => void;
  onDoubleClick: () => void;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Потяните, чтобы изменить ширину; двойной клик — как было"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className={`absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-blue-400/40 ${className}`}
    />
  );
}
