'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function matchesVeSearch(text: string, query: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, '');
  return normalize(text).includes(normalize(query));
}

/** Typing only filters; a click or Enter explicitly commits the selected ID. */
export function SearchableSelect({
  id, label, value, options, onChange, disabled = false, placeholder = 'Выберите проект', describedBy,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { id: string; name: string }[];
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const selected = options.find((option) => option.id === value);
  const visible = options.filter((option) => matchesVeSearch(option.name, query));
  const activeIndex = visible.findIndex((option) => option.id === activeId);
  const expanded = open && !disabled;

  useEffect(() => {
    if (expanded && activeIndex >= 0) {
      listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [expanded, activeIndex]);

  const close = () => { setOpen(false); setQuery(''); setActiveId(null); };
  const show = () => { setOpen(true); setQuery(''); setActiveId(value || null); };
  const choose = (nextId: string) => {
    if (disabled) return;
    close();
    inputRef.current?.focus();
    if (nextId !== value) onChange(nextId);
  };

  return (
    <div className="ve2-select" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) close();
    }}>
      <label htmlFor={id} className="ve2-label mb-2 block">{label}</label>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          className="ve2-input ve2-select-input"
          value={expanded ? query : selected?.name ?? ''}
          placeholder={expanded ? 'Введите название…' : placeholder}
          disabled={disabled}
          onFocus={show}
          onClick={() => { if (!expanded) show(); }}
          onChange={(event) => { setQuery(event.target.value); setActiveId(null); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!expanded) { show(); return; }
              const next = activeIndex < 0
                ? event.key === 'ArrowDown' ? 0 : visible.length - 1
                : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
              setActiveId(visible[next]?.id ?? null);
            } else if (event.key === 'Enter' && expanded) {
              event.preventDefault();
              const option = visible[activeIndex] ?? (visible.length === 1 ? visible[0] : undefined);
              if (option) choose(option.id);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        />
        <ChevronDown aria-hidden className="ve2-select-chevron" />
      </div>
      {expanded ? (
        <div className="ve2-select-menu">
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="ve2-select-options">
            {visible.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.id === value}
                data-active={index === activeIndex}
                className="ve2-select-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.id)}
              >
                <span>{option.name}</span>
                {option.id === value ? <span className="ve2-faint text-xs">Выбрано</span> : null}
              </li>
            ))}
          </ul>
          {visible.length === 0 ? <p role="status" className="px-3 py-3 text-sm ve2-faint">Ничего не найдено. Измените название.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
