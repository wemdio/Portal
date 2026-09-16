'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Окно инструмента «Рассылка»: заголовок, тело со своей прокруткой и полоса
 * действий внизу.
 *
 * Шапка и низ не прокручиваются вместе с телом — в выборе ящиков список может
 * быть на двести строк, и кнопка «Сохранить» не должна уезжать за экран.
 * Закрывается по Esc и по клику мимо окна; при открытом окне страница под ним
 * не прокручивается, иначе колесо мыши уводит фон, а не список.
 */
interface Props {
  title: string;
  subtitle?: string;
  /** 'wide' — форма кампании, 'md' — выбор ящиков. */
  size?: 'md' | 'wide';
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

export function SenderModal({ title, subtitle, size = 'md', onClose, footer, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`my-auto flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl ${
          size === 'wide' ? 'max-w-3xl' : 'max-w-xl'
        }`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
