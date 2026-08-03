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
 * Курсор идёт от кнопки к списку не по прямой — например, к пункту в правой
 * части панели (она шире кнопки) он летит по диагонали через зону, которая
 * не принадлежит ни кнопке, ни панели. Если закрывать по первому же
 * mouseleave, до такого пункта долететь невозможно — держим меню открытым
 * ещё чуть-чуть. Панель садится вплотную к кнопке (top панели = bottom
 * кнопки, без зазора), так что для вертикального перехода отдельный
 * «мостик»-паддинг не нужен: коробки соприкасаются, мышь и так не покидает
 * поддерево меню.
 */
const CLOSE_DELAY_MS = 220;

/** Ширина панели для клампа у правого края экрана (см. min-w ниже). */
const MENU_MIN_WIDTH = 208;

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
  const [coords, setCoords] = useState<{ left: number; top: number; alignLeft: boolean } | null>(null);

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
    const left = Math.min(rect.left, maxLeft);
    // Панель стартует ровно там, где кончается кнопка (top = bottom кнопки) —
    // визуального зазора нет, кнопка и список читаются одним блоком.
    // alignLeft — не сработал ли кламп у правого края экрана: только тогда
    // левый край панели совпадает с левым краем кнопки, и её левый верхний
    // угол можно скруглить «в ноль» (см. rounded-tl-none ниже), чтобы шов
    // с плоским низом кнопки совпал идеально. Если кламп сработал, панель
    // сдвинута влево относительно кнопки — под кнопкой окажется прямой
    // участок верхней границы панели, а не скруглённый угол, и трогать
    // скругление не нужно.
    setCoords({ left, top: rect.bottom, alignLeft: left === rect.left });
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
        className={`portal-nav-trigger flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[12px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 ${
          open
            // Раскрытое состояние «перетекает» в панель ниже: тот же bg-white
            // и тот же border-zinc-200, что у панели, а низ кнопки — плоский
            // и без собственного нижнего бордера (border-b-0), чтобы шов с
            // верхом панели читался одной линией, а не двумя рядом. Активная
            // (чёрная) плашка маршрута на время раскрытия уступает место
            // этому состоянию — какой пункт активен, всё равно видно по
            // подсветке в самом списке.
            ? 'rounded-t-xl rounded-b-none border border-b-0 border-zinc-200 bg-white text-zinc-900 shadow-sm'
            : isActive
              ? 'rounded-full bg-zinc-900 text-white shadow-sm'
              : 'rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
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
          style={{ left: coords.left, top: coords.top }}
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={() => { if (hoverCapable.current) scheduleClose(); }}
        >
          <div
            id={menuId}
            role="menu"
            aria-label={label}
            className={`portal-nav-menu min-w-[208px] overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg ${
              coords.alignLeft ? 'rounded-tl-none' : ''
            }`}
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
