'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { expensesFetch } from '@/lib/expenses/client';
import { EXPENSE_CATEGORY_VALUES, categoryLabel } from '@/lib/expenses/labels';
import {
  buildVendorPicker,
  stepVendorItem,
  type VendorPickerItem,
} from '@/lib/expenses/vendorPicker';
import type { ExpenseCategory, VendorOption } from '@/lib/expenses/types';

interface CreatedVendor {
  id: string;
  name: string;
  category: ExpenseCategory;
}

/** Вендор с таким именем уже есть: роут отдаёт 409 с текстом Postgres, читать который человеку нечем. */
function humanizeError(message: string): string {
  if (/duplicate key|unique constraint/i.test(message)) return 'Вендор с таким названием уже есть';
  return message;
}

/**
 * Поле выбора вендора с поиском и созданием на месте.
 *
 * Раньше здесь стоял `<select>` плюс кнопка «+ новый», которая разворачивала
 * рядом ещё три контрола. Два десятка вендоров плоским списком уже не ищутся, а
 * создание новым режимом отправляло человека переключать состояние вместо того,
 * чтобы дописать название. Здесь и то и другое — одно действие: набранный текст
 * фильтрует список, а когда совпадений нет, тем же текстом предлагается завести
 * вендора.
 *
 * Категория спрашивается только в момент создания и отдельной строкой под полем
 * — в общем ряду она удваивала ширину формы ради случая, который случается раз
 * в месяц.
 *
 * Внутри намеренно нет `<form>`: компонент живёт внутри формы ручной траты, а
 * вложенные формы — невалидный HTML, из-за которого внешняя форма отправляется
 * не тем сабмитом. По той же причине Enter при открытом списке всегда
 * перехватывается: иначе выбор вендора отправлял бы всю форму.
 */
export default function VendorSelect({
  value,
  onChange,
  options,
  onCreated,
  emptyLabel = null,
  emptyHint,
  placeholder = 'Начни печатать название',
  ariaLabel = 'Вендор',
}: {
  value: string;
  onChange: (vendorId: string) => void;
  options: VendorOption[];
  onCreated: (vendor: VendorOption) => void;
  /**
   * Подпись пункта «трата без вендора». `null` — пункта нет: в очереди разметки
   * выбор «без вендора» означал бы «оставить в очереди», то есть ничего.
   */
  emptyLabel?: string | null;
  /** Последствие выбора «без вендора» — стоит рядом с пунктом, а не в тексте под формой. */
  emptyHint?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKeyState, setActiveKeyState] = useState<string | null>(null);
  /** Ненулевое значение = выбран пункт «создать»: ждём категорию и подтверждение. */
  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const [category, setCategory] = useState<ExpenseCategory>('tools');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Счётчик «верни фокус в поле»: сам факт изменения, значение не важно. */
  const [refocusTick, setRefocusTick] = useState(0);
  const refocus = () => setRefocusTick((tick) => tick + 1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const categoryRef = useRef<HTMLSelectElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  const listId = useId();
  const optionId = (key: string) => `${listId}-${key}`;

  const selected = useMemo(() => options.find((item) => item.id === value) ?? null, [options, value]);

  const model = useMemo(
    () => buildVendorPicker({ options, query, includeEmpty: emptyLabel !== null }),
    [options, query, emptyLabel],
  );

  /**
   * Пока запрос набран, первый пункт подсвечен сам — иначе Enter после набора
   * не делает ничего, и приходится тянуться к стрелке ради единственного
   * совпадения. При пустом запросе подсветки нет: там список полный, и Enter
   * выбрал бы случайного первого вендора.
   */
  const activeKey =
    activeKeyState !== null && model.items.some((item) => item.key === activeKeyState)
      ? activeKeyState
      : query.trim()
        ? (model.items[0]?.key ?? null)
        : null;

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveKeyState(null);
  }, []);

  // Клик мимо поля закрывает список. Панель создания не трогаем: она уже вне
  // списка, и схлопывать её кликом по соседнему полю значит терять набранное имя.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Подсвеченный пункт держим в видимой части списка — иначе стрелка вниз
  // «теряет» фокус за нижней границей панели.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  useEffect(() => {
    if (creating) categoryRef.current?.focus();
  }, [creating]);

  // Возврат фокуса в поле — через счётчик и эффект, а не прямым вызовом
  // `inputRef.current.focus()` из обработчика: обработчики здесь создаются в
  // рендере, и чтение рефа внутри них справедливо ловит react-hooks/refs.
  useEffect(() => {
    if (refocusTick > 0) inputRef.current?.focus();
  }, [refocusTick]);

  function select(item: VendorPickerItem) {
    if (item.kind === 'create') {
      setCreating({ name: item.name });
      setError(null);
      setOpen(false);
      setActiveKeyState(null);
      return;
    }
    onChange(item.kind === 'vendor' ? item.option.id : '');
    close();
    refocus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (!open) {
          setOpen(true);
          return;
        }
        setActiveKeyState(stepVendorItem(model.items, activeKey, direction));
        return;
      }
      case 'Home':
      case 'End': {
        if (!open || model.items.length === 0) return;
        event.preventDefault();
        const item = event.key === 'Home' ? model.items[0] : model.items[model.items.length - 1];
        setActiveKeyState(item.key);
        return;
      }
      case 'Enter': {
        if (creating) {
          // Имя набрано, категория выбрана — Enter заводит вендора. Иначе он
          // отправил бы внешнюю форму, потеряв недосозданного вендора молча.
          event.preventDefault();
          void create();
          return;
        }
        if (!open) return;
        // Список открыт — Enter принадлежит ему, а не сабмиту внешней формы.
        event.preventDefault();
        const item = model.items.find((candidate) => candidate.key === activeKey);
        if (item) select(item);
        return;
      }
      case 'Escape': {
        if (!open && !creating) return;
        event.preventDefault();
        // Иначе Esc дошёл бы до модалки/страницы и закрыл заодно и их.
        event.stopPropagation();
        if (creating) cancelCreate();
        else close();
        return;
      }
      case 'Tab':
        // Уходим за пределы поля — список закрываем, но сам Tab не перехватываем.
        if (open) close();
        return;
      default:
        return;
    }
  }

  function cancelCreate() {
    const restored = creating?.name ?? '';
    setCreating(null);
    setError(null);
    setQuery(restored);
    setOpen(true);
    refocus();
  }

  async function create() {
    if (!creating) return;
    setSaving(true);
    setError(null);
    try {
      const created = await expensesFetch<CreatedVendor>('/vendors', {
        method: 'POST',
        body: JSON.stringify({ name: creating.name, category }),
      });
      onCreated({ id: created.id, name: created.name, category: created.category });
      onChange(created.id);
      setCreating(null);
      setQuery('');
      refocus();
    } catch (e) {
      setError(humanizeError(e instanceof Error ? e.message : 'Не удалось создать вендора'));
    } finally {
      setSaving(false);
    }
  }

  const inputValue = creating ? creating.name : open ? query : (selected?.name ?? '');

  function renderOption(item: VendorPickerItem) {
    const isActive = item.key === activeKey;
    const isSelected =
      item.kind === 'vendor' ? item.option.id === value : item.kind === 'empty' && value === '';

    return (
      <div
        key={item.key}
        id={optionId(item.key)}
        ref={isActive ? activeRef : undefined}
        role="option"
        aria-selected={isSelected}
        onClick={() => select(item)}
        // Подсветка активного пункта — единственный видимый «фокус» внутри
        // списка (сам фокус остаётся на поле, см. aria-activedescendant),
        // поэтому кроме фона у неё есть и контур.
        className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-xs ${
          isActive
            ? 'bg-zinc-100 text-zinc-900 ring-1 ring-inset ring-zinc-300'
            : 'text-zinc-600 hover:bg-zinc-50'
        }`}
      >
        {item.kind === 'create' ? (
          <span className="truncate font-medium text-zinc-900">
            Создать вендора «{item.name}»
          </span>
        ) : item.kind === 'empty' ? (
          <>
            <span className="shrink-0">{emptyLabel}</span>
            {emptyHint ? <span className="truncate text-[11px] text-zinc-400">{emptyHint}</span> : null}
          </>
        ) : (
          <>
            <span className={`truncate ${isSelected ? 'font-medium text-zinc-900' : ''}`}>
              {item.option.name}
            </span>
            {isSelected ? <span className="ml-auto shrink-0 text-[11px] text-zinc-400">выбран</span> : null}
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && activeKey ? optionId(activeKey) : undefined}
          autoComplete="off"
          value={inputValue}
          placeholder={open && selected ? selected.name : placeholder}
          onChange={(e) => {
            // Правка текста при выбранном «создать» — это продолжение набора,
            // а не отдельное действие: возвращаемся к поиску с новым текстом.
            if (creating) setCreating(null);
            setQuery(e.target.value);
            setActiveKeyState(null);
            setOpen(true);
          }}
          // Список открывается кликом, стрелкой и набором, но не самим фокусом:
          // после выбора мы возвращаем фокус в поле, и на onFocus список
          // распахивался бы обратно ровно в момент закрытия.
          onClick={() => {
            // Возврат в поле при незавершённом создании — отказ от него:
            // держать открытыми и список, и панель категории значит показывать
            // два ответа на один вопрос.
            if (creating) cancelCreate();
            else setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 pr-7 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
        />
        {selected && !creating ? (
          <button
            type="button"
            onClick={() => {
              onChange('');
              close();
              refocus();
            }}
            aria-label="Очистить вендора"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full px-1.5 py-0.5 text-xs leading-none text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
          >
            ×
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          // Клик по пункту не должен уводить фокус с поля: без этого input
          // теряет фокус раньше, чем срабатывает onClick, и список успевает
          // закрыться по pointerdown.
          onMouseDown={(event) => event.preventDefault()}
          className="portal-combobox-menu absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto overflow-x-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {model.emptyItem ? renderOption(model.emptyItem) : null}

          {model.groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                {group.label}
              </div>
              {group.items.map(renderOption)}
            </div>
          ))}

          {model.createItem ? renderOption(model.createItem) : null}

          {model.items.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-zinc-400">
              Ничего не нашлось. Допиши название — предложим создать вендора.
            </div>
          ) : null}
        </div>
      ) : null}

      {creating ? (
        <div className="mt-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2">
          <p className="text-[11px] text-zinc-500">
            Новый вендор «<span className="font-medium text-zinc-700">{creating.name}</span>» — выбери
            категорию
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <select
              ref={categoryRef}
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelCreate();
                }
              }}
              aria-label="Категория нового вендора"
              className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
            >
              {EXPENSE_CATEGORY_VALUES.map((item) => (
                <option key={item} value={item}>
                  {categoryLabel(item)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void create()}
              disabled={saving}
              className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs text-white disabled:opacity-40"
            >
              {saving ? 'Создаю…' : 'Создать'}
            </button>
            <button
              type="button"
              onClick={cancelCreate}
              className="rounded-lg px-2 py-1 text-xs text-zinc-400 hover:text-zinc-600"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div className="mt-1 text-[11px] text-red-600">{error}</div> : null}
    </div>
  );
}
