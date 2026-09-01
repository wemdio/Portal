'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

import { describeProxy, healthToneClass } from '@/lib/tgOutreach/accountHealth';
import {
  groupProxiesForPicker,
  flattenPickerGroups,
  type PickerProxy,
} from '@/lib/tgOutreach/proxyPicker';

/**
 * Выбор прокси для аккаунта — со здоровьем каждого варианта.
 *
 * Почему не `<select>`. Плашки статуса в нативном списке не показать: popup
 * рисует операционная система, разметку внутрь `<option>` она не пускает, а в
 * тёмной теме портала все опции вдобавок принудительно перекрашены в
 * нейтральный цвет (`globals.css`, «Нативный popup опций <select>») — цветом
 * там сказать нечего. Поэтому список свой.
 *
 * Popup живёт в `document.body` и позиционируется по координатам кнопки:
 * таблица аккаунтов лежит в контейнере с `overflow-hidden`, и обычный
 * абсолютный список обрезался бы по нижней границе строки. Скролл и смена
 * размера окна список закрывают — это честнее, чем догонять кнопку на каждом
 * кадре.
 */
export function ProxyPicker<T extends PickerProxy>({
  value,
  proxies,
  now,
  onChange,
  onDismiss,
  defaultOpen = false,
  emptyLabel = 'Без прокси',
  ariaLabel = 'Прокси',
  className = '',
}: {
  /** id выбранного прокси; пустая строка — «Без прокси». */
  value: string;
  /** Что предлагать: свободные плюс собственный прокси аккаунта. */
  proxies: T[];
  /** Момент, от которого считается здоровье. Берётся снаружи — `Date.now()` в рендере нечист. */
  now: number;
  onChange: (proxyId: string) => void;
  /** Закрыли, ничего не выбрав. Строка таблицы по этому сигналу выходит из режима правки. */
  onDismiss?: () => void;
  /** Открыть сразу — строка таблицы разворачивает список по клику по ячейке. */
  defaultOpen?: boolean;
  emptyLabel?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupProxiesForPicker(proxies, now), [proxies, now]);
  /** Пункт «Без прокси» идёт первым и в клавиатурном обходе тоже — индекс 0. */
  const flat = useMemo(() => flattenPickerGroups(groups), [groups]);
  const selected = useMemo(() => proxies.find((p) => p.id === value) ?? null, [proxies, value]);

  const close = useCallback(() => {
    setOpen(false);
    onDismiss?.();
  }, [onDismiss]);

  const choose = useCallback((proxyId: string) => {
    setOpen(false);
    onChange(proxyId);
  }, [onChange]);

  /** Кнопка могла уехать за время, пока список был закрыт, — меряем при каждом открытии. */
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 320) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    // capture: список закрываем и от прокрутки внутренних контейнеров, а они
    // событие наверх не отдают. Сам popup в capture-цепочке тоже виден — без
    // фильтра скролл внутри него закрывал бы список раньше, чем оператор
    // докрутит до конца (история: баг 27.08.2026, ~74 прокси не помещались).
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (popupRef.current && target && popupRef.current.contains(target)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, flat.length)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      choose(activeIndex === 0 ? '' : flat[activeIndex - 1]?.proxy.id ?? '');
    }
  };

  const selectedMark = selected ? describeProxy(selected, now) : null;
  const rowIndexOf = (id: string) => flat.findIndex((it) => it.proxy.id === id) + 1;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onKeyDown}
        title={selectedMark ? `${selected?.name || selected?.url} — ${selectedMark.detail}` : 'Назначить прокси'}
        className={`flex w-full items-center gap-1.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-left text-xs transition hover:border-indigo-300 hover:bg-indigo-50 cursor-pointer ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (selected.name || selected.url) : <span className="text-gray-400">{emptyLabel}</span>}
        </span>
        {selectedMark && (
          <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium ${healthToneClass(selectedMark.tone)}`}>
            {selectedMark.label}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      </button>

      {open && rect && createPortal(
        <div
          ref={popupRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
          className="dark-scrollbar z-50 max-h-80 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
        >
          <button
            type="button"
            role="option"
            aria-selected={value === ''}
            onMouseEnter={() => setActiveIndex(0)}
            onClick={() => choose('')}
            className={`block w-full px-2.5 py-1.5 text-left text-xs cursor-pointer ${activeIndex === 0 ? 'bg-indigo-50' : ''} ${value === '' ? 'font-semibold text-indigo-700' : 'text-gray-600'}`}
          >
            {emptyLabel}
          </button>

          {groups.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-gray-400">
              Свободных прокси нет — все адреса кампании уже заняты аккаунтами.
            </p>
          )}

          {groups.map((group) => (
            <div key={group.tone}>
              {/* Заголовок с пояснением: сам по себе «Сбоят» не отвечает на
                  вопрос оператора — можно ли отсюда брать вообще. */}
              <div className="sticky top-0 bg-white px-2.5 pb-1 pt-2">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] font-semibold text-gray-600">{group.title}</span>
                  <span className="text-[10px] text-gray-400">{group.items.length}</span>
                </div>
                <p className="text-[10px] leading-tight text-gray-400">{group.hint}</p>
              </div>
              {group.items.map(({ proxy, mark }) => {
                const index = rowIndexOf(proxy.id);
                return (
                  <button
                    key={proxy.id}
                    type="button"
                    role="option"
                    aria-selected={proxy.id === value}
                    title={mark.detail}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(proxy.id)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs cursor-pointer ${activeIndex === index ? 'bg-indigo-50' : ''}`}
                  >
                    {/* Приглушаем только неработающие: список ими не
                        заканчивается, но и предлагать их наравне с живыми
                        нечестно. */}
                    <span className={`min-w-0 flex-1 truncate ${mark.tone === 'bad' ? 'text-gray-400' : 'text-gray-700'} ${proxy.id === value ? 'font-semibold' : ''}`}>
                      {proxy.name || proxy.url}
                    </span>
                    <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium ${healthToneClass(mark.tone)}`}>
                      {mark.label}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
