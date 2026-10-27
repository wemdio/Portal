'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { ProjectOption } from '@/lib/expenses/types';

/**
 * Привязка ручной записи к проекту портала.
 *
 * Привязка необязательна, поэтому выбранный проект показывается плашкой с
 * крестиком: снять её должно быть так же просто, как поставить.
 */

export interface PickedProject {
  id: string;
  name: string;
}

const MAX_ITEMS = 50;
/** Высота списка, если места хватает; меньше — список ужимается под экран. */
const LIST_MAX_HEIGHT = 288;

const FIELD_CLASS =
  'w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70';

/** «TypeType · Аутрич»: у десятков проектов одно имя «Аутрич», различает их клиент. */
function projectTitle(project: { name: string; client?: string | null }): string {
  return project.client ? `${project.client} · ${project.name}` : project.name;
}

type ListPosition = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

/**
 * Список ставится `fixed` по координатам поля, а не `absolute` внутри него:
 * окно ввода прокручивается и обрезало список по своему краю — видно было
 * два пункта. Места внизу мало — открываем вверх.
 */
function listPosition(field: DOMRect): ListPosition {
  const below = window.innerHeight - field.bottom - 12;
  const above = field.top - 12;
  const base = { left: field.left, width: Math.max(field.width, 280) };
  if (below >= 180 || below >= above) {
    return { ...base, top: field.bottom + 4, maxHeight: Math.min(LIST_MAX_HEIGHT, below) };
  }
  return { ...base, bottom: window.innerHeight - field.top + 4, maxHeight: Math.min(LIST_MAX_HEIGHT, above) };
}

/** Проект портала: список целиком приходит сверху, ищем на месте по клиенту и названию. */
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
  const [position, setPosition] = useState<ListPosition | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options
      .filter((p) => !needle || `${p.client ?? ''} ${p.name}`.toLowerCase().includes(needle))
      .slice(0, MAX_ITEMS);
  }, [options, query]);

  const open = position !== null;

  // Окно прокрутили или растянули — координаты списка устарели; закрываем.
  // Прокрутка самого списка не в счёт.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event.type === 'scroll' && listRef.current?.contains(event.target as Node)) return;
      setPosition(null);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const current = value ? options.find((p) => p.id === value.id) : undefined;

  if (value) {
    return (
      <div className="flex min-h-[30px] items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-800">
          {projectTitle({ name: value.name, client: current?.client })}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Убрать проект"
          className="text-sm leading-none text-zinc-400 hover:text-zinc-700"
        >
          ×
        </button>
      </div>
    );
  }

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));
  const pick = (project: ProjectOption) => {
    onChange({ id: project.id, name: project.name });
    setQuery('');
    setPosition(null);
  };

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setPosition(listPosition(event.currentTarget.getBoundingClientRect()));
      if (items.length) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + items.length) % items.length);
      }
    } else if (event.key === 'Enter' && open) {
      // Список открыт — Enter выбирает проект, а не отправляет форму.
      event.preventDefault();
      const project = items[activeIndex];
      if (project) pick(project);
    } else if (event.key === 'Escape' && open) {
      // Иначе Esc закрыл бы всё окно вместе с набранным.
      event.preventDefault();
      event.stopPropagation();
      setPosition(null);
    }
  }

  return (
    <>
      <input
        type="text"
        role="combobox"
        aria-label="Проект"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        placeholder="Клиент или название проекта"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setPosition(listPosition(e.currentTarget.getBoundingClientRect()));
        }}
        onFocus={(e) => setPosition(listPosition(e.currentTarget.getBoundingClientRect()))}
        onBlur={() => setPosition(null)}
        onKeyDown={handleKeyDown}
        className={FIELD_CLASS}
      />
      {position ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          style={position}
          className="fixed z-[70] overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-xl"
        >
          {items.length === 0 ? (
            <li className="px-3 py-2 text-xs text-zinc-400">
              {options.length === 0 ? 'Загружаю проекты…' : 'Проект не найден'}
            </li>
          ) : null}
          {items.map((project, index) => (
            <li
              key={project.id}
              role="option"
              aria-selected={index === activeIndex}
              // mousedown, а не click: click приходит после blur, а blur уже закрыл список.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(project);
              }}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-3 px-3 py-1.5 text-xs ${
                index === activeIndex ? 'bg-blue-50' : ''
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-zinc-800">{projectTitle(project)}</span>
              <span className="shrink-0 text-[10px] text-zinc-400">{project.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
