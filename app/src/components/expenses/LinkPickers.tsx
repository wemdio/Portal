'use client';

import { useEffect, useId, useMemo, useState } from 'react';

import { expensesFetch } from '@/lib/expenses/client';
import type { DealOption, ProjectOption } from '@/lib/expenses/types';

/**
 * Привязка ручной записи к проекту портала и к сделке AMO.
 *
 * Обе привязки необязательны, поэтому выбранное значение показывается плашкой
 * с крестиком: снять привязку должно быть так же просто, как поставить.
 */

export interface PickedProject {
  id: string;
  name: string;
}

export interface PickedDeal {
  amoId: number;
  name: string | null;
}

interface PickItem {
  key: string;
  title: string;
  sub: string;
}

const MAX_ITEMS = 8;

const FIELD_CLASS =
  'w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70';

/**
 * Поле «набери и выбери». Enter при открытом списке выбирает пункт, а не
 * отправляет форму, внутри которой поле стоит; Esc закрывает только список.
 */
function SearchPick({
  label,
  selected,
  onClear,
  query,
  onQuery,
  items,
  onPick,
  placeholder,
  emptyText,
}: {
  label: string;
  selected: { title: string; sub: string } | null;
  onClear: () => void;
  query: string;
  onQuery: (value: string) => void;
  items: PickItem[];
  onPick: (key: string) => void;
  placeholder: string;
  /** Что сказать, когда набрано, но ничего не нашлось; null — молчать (ещё ищем или набрано мало). */
  emptyText: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  if (selected) {
    return (
      <div className="flex min-h-[30px] items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-zinc-800">{selected.title}</span>
          {selected.sub ? <span className="block truncate text-[10px] text-zinc-500">{selected.sub}</span> : null}
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label={`Убрать: ${label}`}
          className="text-sm leading-none text-zinc-400 hover:text-zinc-700"
        >
          ×
        </button>
      </div>
    );
  }

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));
  const showList = open && (items.length > 0 || emptyText !== null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (items.length) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + items.length) % items.length);
      }
    } else if (event.key === 'Enter' && showList) {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) onPick(item.key);
    } else if (event.key === 'Escape' && showList) {
      // Иначе Esc дошёл бы до окна и закрыл его вместе с набранным.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          onQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        className={FIELD_CLASS}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {items.length === 0 ? <li className="px-2.5 py-1.5 text-xs text-zinc-400">{emptyText}</li> : null}
          {items.map((item, index) => (
            <li
              key={item.key}
              role="option"
              aria-selected={index === activeIndex}
              // mousedown, а не click: click приходит после blur, а blur уже
              // закрыл список.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item.key);
              }}
              onMouseEnter={() => setActive(index)}
              className={`cursor-pointer px-2.5 py-1.5 text-xs ${index === activeIndex ? 'bg-blue-50' : ''}`}
            >
              <span className="block truncate text-zinc-800">{item.title}</span>
              {item.sub ? <span className="block truncate text-[10px] text-zinc-500">{item.sub}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Проект портала: список целиком приходит сверху, ищем на месте. */
export function ProjectPicker({
  value,
  onChange,
  options,
}: {
  value: PickedProject | null;
  onChange: (next: PickedProject | null) => void;
  options: ProjectOption[];
}) {
  const [query, setQuery] = useState('');

  const items = useMemo<PickItem[]>(() => {
    const needle = query.trim().toLowerCase();
    return options
      .filter((p) => !needle || `${p.name} ${p.client ?? ''}`.toLowerCase().includes(needle))
      .slice(0, MAX_ITEMS)
      .map((p) => ({ key: p.id, title: p.name, sub: [p.client, p.status].filter(Boolean).join(' · ') }));
  }, [options, query]);

  const current = value ? options.find((p) => p.id === value.id) : undefined;

  return (
    <SearchPick
      label="Проект"
      selected={value ? { title: value.name, sub: current?.client ?? '' } : null}
      onClear={() => onChange(null)}
      query={query}
      onQuery={setQuery}
      items={items}
      onPick={(id) => {
        const project = options.find((p) => p.id === id);
        if (project) onChange({ id: project.id, name: project.name });
        setQuery('');
      }}
      placeholder="Название проекта или клиента"
      emptyText={query.trim() ? 'Проект не найден' : null}
    />
  );
}

/** Сделка AMO: ищем на сервере по названию, компании или номеру сделки. */
export function DealPicker({
  value,
  onChange,
}: {
  value: PickedDeal | null;
  onChange: (next: PickedDeal | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; items: DealOption[] }>({ q: '', items: [] });
  const [error, setError] = useState<string | null>(null);

  const q = query.trim();

  // Ищем с паузой после набора: запрос на каждую букву гонял бы базу впустую.
  useEffect(() => {
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await expensesFetch<{ items: DealOption[] }>(
            `/links/deals?q=${encodeURIComponent(q)}`,
            { signal: controller.signal },
          );
          setFound({ q, items: res.items });
          setError(null);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setError(e instanceof Error ? e.message : 'Не удалось найти сделки');
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  // Результат прошлого запроса под новый текст не показываем — это были бы не те сделки.
  const fresh = q.length >= 2 && found.q === q;
  const items: PickItem[] = fresh
    ? found.items.map((d) => ({
        key: String(d.amoId),
        title: d.name ?? `Сделка ${d.amoId}`,
        sub: [d.company, d.status, `№ ${d.amoId}`].filter(Boolean).join(' · '),
      }))
    : [];

  return (
    <>
      <SearchPick
        label="Сделка в AmoCRM"
        selected={value ? { title: value.name ?? `Сделка ${value.amoId}`, sub: `№ ${value.amoId}` } : null}
        onClear={() => onChange(null)}
        query={query}
        onQuery={setQuery}
        items={items}
        onPick={(key) => {
          const deal = found.items.find((d) => String(d.amoId) === key);
          if (deal) onChange({ amoId: deal.amoId, name: deal.name });
          setQuery('');
        }}
        placeholder="Название, компания или номер сделки"
        emptyText={fresh ? 'Сделка не найдена' : null}
      />
      {error ? <p className="mt-1 text-[11px] text-red-600">{error}</p> : null}
    </>
  );
}
