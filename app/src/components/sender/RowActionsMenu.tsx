'use client';

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

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
export function RowActionsMenu({ items }: { items: RowAction[] }) {
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
    const menuHeight = items.length * 34 + 8;
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
        className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {pos ? (
        <div
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="z-50 min-w-44 rounded-lg border border-zinc-200 bg-white py-1 text-left shadow-lg"
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
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50 disabled:opacity-50 ${
                item.danger ? 'text-red-600' : 'text-zinc-700'
              }`}
            >
              {item.icon ? <item.icon className="h-3.5 w-3.5 shrink-0" /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
