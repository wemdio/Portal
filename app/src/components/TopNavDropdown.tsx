'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';

export type TopNavDropdownItem = {
  id: string;
  href: string;
  label: string;
  isActive: boolean;
  badgeCount?: number;
};

/**
 * Курсор идёт от кнопки к списку не по прямой — если закрывать по первому же
 * mouseleave, до пункта долететь невозможно. Держим меню открытым ещё чуть-чуть.
 * Второй (основной) страховкой служит padding-top у обёртки списка: он
 * перекрывает зазор между кнопкой и панелью, и мышь всё время остаётся внутри
 * одного DOM-поддерева.
 */
const CLOSE_DELAY_MS = 220;

/** Ширина панели для клампа у правого края экрана (см. min-w ниже). */
const MENU_MIN_WIDTH = 208;

/** Видимый зазор между нижней границей шапки и панелью. */
const MENU_GAP_PX = 6;

/**
 * Пункт верхнего меню с выпадающим списком.
 *
 * Открывается наведением (основной сценарий), кликом (тач) и с клавиатуры
 * (Enter / Space / стрелки). Панель позиционируется fixed, а не absolute:
 * лента пунктов в TopNav — горизонтальный скролл-контейнер (overflow-x), и
 * absolute-панель внутри него обрезалась бы по нижней границе шапки.
 */
export function TopNavDropdown({
  label,
  items,
  isActive,
}: {
  label: string;
  items: TopNavDropdownItem[];
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; bridge: number } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Куда увести фокус сразу после открытия (только клавиатурный сценарий). */
  const pendingFocus = useRef<'first' | 'last' | null>(null);
  const menuId = useId();

  const cancelScheduledClose = useCallback(() => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const closeMenu = useCallback((returnFocus: boolean) => {
    cancelScheduledClose();
    pendingFocus.current = null;
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, [cancelScheduledClose]);

  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }, [cancelScheduledClose]);

  const updateCoords = useCallback(() => {
    const trigger = triggerRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = Math.max(8, window.innerWidth - MENU_MIN_WIDTH - 8);
    // Обёртка начинается сразу под кнопкой, а сама панель отодвигается ниже
    // шапки её padding-ом — так «мостик» перекрывает весь зазор целиком, и
    // курсор по дороге к списку не покидает поддерево меню.
    const headerBottom = trigger?.closest('header')?.getBoundingClientRect().bottom;
    const bridge = Math.max(MENU_GAP_PX, (headerBottom ?? rect.bottom) - rect.bottom + MENU_GAP_PX);
    setCoords({ left: Math.min(rect.left, maxLeft), top: rect.bottom, bridge });
  }, []);

  // Координаты считаем до setOpen, а не в эффекте после: иначе первый кадр
  // рендерится без панели, и уводить фокус в список было бы некуда.
  const openMenu = useCallback((focus: 'first' | 'last' | null) => {
    cancelScheduledClose();
    updateCoords();
    pendingFocus.current = focus;
    setOpen(true);
  }, [cancelScheduledClose, updateCoords]);

  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  // Панель fixed — её координаты нужно пересчитывать, пока она открыта:
  // лента пунктов скроллится по горизонтали, окно меняет размер.
  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => updateCoords();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, updateCoords]);

  // Клик мимо меню закрывает его (тач-сценарий: открыли тапом — закрываем тапом).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const intent = pendingFocus.current;
    pendingFocus.current = null;
    if (!intent) return;
    const rendered = itemRefs.current.filter((node): node is HTMLAnchorElement => node !== null);
    const target = intent === 'first' ? rendered[0] : rendered[rendered.length - 1];
    target?.focus();
  }, [open]);

  const focusItemAt = useCallback((index: number) => {
    itemRefs.current[index]?.focus();
  }, []);

  // На тач-устройствах тап сначала присылает синтетический mouseenter, и только
  // потом click. Без этой проверки меню открывалось бы по mouseenter и тут же
  // закрывалось собственным кликом — тапом его было бы не открыть.
  const hoverCapable = useRef(true);
  useEffect(() => {
    hoverCapable.current = window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches ?? true;
  }, []);

  function handleTriggerClick(event: React.MouseEvent<HTMLButtonElement>) {
    // detail === 0 — активация с клавиатуры (Enter / Space): сразу уводим фокус
    // в список, иначе клавиатурный пользователь останется на кнопке.
    if (open) {
      closeMenu(false);
      return;
    }
    openMenu(event.detail === 0 ? 'first' : null);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (open) focusItemAt(0);
      else openMenu('first');
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) focusItemAt(items.length - 1);
      else openMenu('last');
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu(false);
    }
  }

  function handleItemKeyDown(event: React.KeyboardEvent<HTMLAnchorElement>, index: number) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItemAt((index + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItemAt((index - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        focusItemAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusItemAt(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
        break;
      case 'Tab':
        // Уходим за пределы меню — закрываем, но не перехватываем сам Tab.
        closeMenu(false);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative flex-shrink-0"
      onMouseEnter={() => { if (hoverCapable.current) openMenu(null); }}
      onMouseLeave={() => { if (hoverCapable.current) scheduleClose(); }}
      onFocus={cancelScheduledClose}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        className={`portal-nav-trigger flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 ${
          isActive ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
        }`}
      >
        {label}
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && coords && (
        <div
          className="fixed z-50"
          style={{ left: coords.left, top: coords.top, paddingTop: coords.bridge }}
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={() => { if (hoverCapable.current) scheduleClose(); }}
        >
          <div
            id={menuId}
            role="menu"
            aria-label={label}
            className="portal-nav-menu min-w-[208px] overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
          >
            {items.map((item, index) => (
              <Link
                key={item.id}
                ref={(node) => { itemRefs.current[index] = node; }}
                href={item.href as Route}
                prefetch={false}
                role="menuitem"
                onClick={() => closeMenu(false)}
                onKeyDown={(event) => handleItemKeyDown(event, index)}
                className={`flex items-center gap-2 px-3 py-2 text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70 ${
                  item.isActive
                    ? 'bg-zinc-100 font-medium text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                }`}
              >
                <span className="truncate">{item.label}</span>
                {(item.badgeCount ?? 0) > 0 && (
                  <span className="ml-auto inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                    {item.badgeCount}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
