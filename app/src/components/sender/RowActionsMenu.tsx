'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, MoreVertical, type LucideIcon } from 'lucide-react';

export interface RowAction {
  label: string;
  /** Иконка слева от подписи. */
  icon?: LucideIcon;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

/**
 * Действия строки в меню «⋯» (дизайн как в Instantly, 15.10.2026). Список
 * рисуется fixed от кнопки: таблица в overflow-x-auto обрезала бы обычный
 * выпадающий список у нижних строк.
 */
export function RowActionsMenu({ items, vertical = false }: { items: RowAction[]; vertical?: boolean }) {
  const Dots = vertical ? MoreVertical : MoreHorizontal;
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (pos) return setPos(null);
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = items.length * 38 + 12;
    const top = rect.bottom + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4;
    setPos({ top, right: Math.max(8, window.innerWidth - rect.right) });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label="Действия"
        className="row-actions-btn rounded-md p-1.5"
      >
        <Dots className="h-4 w-4" />
      </button>
      {pos ? createPortal(
        <div
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="z-50 min-w-48 rounded-lg border border-zinc-300 bg-white py-1.5 text-left shadow-xl ring-1 ring-black/10"
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              title={item.title}
              disabled={item.disabled}
              onClick={() => {
                setPos(null);
                item.onClick();
              }}
              className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 ${
                item.danger ? 'text-red-600' : 'text-zinc-900'
              }`}
            >
              {item.icon ? <item.icon className="h-4 w-4 shrink-0" /> : null}
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
