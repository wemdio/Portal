'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface RowMenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Опасное действие — красным и отдельно от остальных. */
  danger?: boolean;
}

/**
 * Меню строки в одно троеточие: действия с аккаунтом не занимают ширину
 * таблицы тремя значками. Список позиционируется по координатам кнопки
 * (fixed), а не внутри ячейки: таблица обрезает всё, что выходит за её рамку.
 * Закрывается кликом вне меню, Escape и прокруткой.
 */
export function RowMenu({ items, label = 'Действия' }: { items: RowMenuItem[]; label?: string }) {
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Меню высотой ~120 px: внизу экрана раскрываем вверх.
    const up = window.innerHeight - rect.bottom < 150;
    setPos({
      top: up ? rect.top - 6 : rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      up,
    });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        aria-label={label}
        title={label}
        className={`rounded-lg p-1.5 transition cursor-pointer ${
          pos ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'
        }`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {pos && (
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed',
            right: pos.right,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
          className="z-50 min-w-[210px] overflow-hidden rounded-xl border border-gray-200 bg-white py-1.5 text-xs shadow-xl"
        >
          {items.map((item, i) => (
            <div key={item.label}>
              {item.danger && i > 0 && <div className="my-1 border-t border-gray-100" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setPos(null); item.onClick(); }}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition cursor-pointer ${
                  item.danger
                    ? 'text-rose-600 hover:bg-rose-50'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
