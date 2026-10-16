'use client';

/**
 * Выбор стран сбора ENG-проекта (план §1A): поиск по справочнику
 * ENG_COUNTRIES (243 предлагаемые страны, по подписи), выбранные — чипами.
 * Один компонент на два экрана: карточка «Countries» шага 1 (EngStepBrief) и
 * свёрнутый «Countries (optional)» формы создания (EngProjectsList).
 *
 * Значения — написание каталога (`value`), их и шлёт PATCH/POST; проверку
 * строго повторяет сервер (parseHeCollectCountries), здесь — только потолок
 * HE_COLLECT_COUNTRIES_MAX, чтобы не дать набрать заведомый отказ.
 *
 * Клавиатура: ↑/↓ — по списку, Enter — добавить подсвеченную, Backspace в
 * пустом поле — снять последний чип, Escape — закрыть список (второй —
 * очистить поиск). Ничего не выбирается само по мере набора: «Niger» не
 * подхватывается, пока клиент дописывает «Nigeria» — добавляет только Enter
 * или клик. Точное совпадение (и псевдоним: «UK», «Holland») — первым,
 * затем начало подписи, затем вхождение.
 *
 * Сохранённое значение, которого справочник больше не знает (unavailable
 * сервера), остаётся чипом с подписью engCountryLabel — его можно снять.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  ENG_COUNTRIES,
  HE_COLLECT_COUNTRIES_MAX,
  engCountryKey,
  engCountryLabel,
  normalizeEngCountry,
  type EngCountry,
} from '@/lib/hypothesisEngine/engCountries';

/** Подсказки списка по запросу: точное/псевдоним → начало подписи → вхождение. */
export function engCountryMatches(query: string, selected: ReadonlySet<string>): EngCountry[] {
  const free = ENG_COUNTRIES.filter((c) => !selected.has(c.value));
  const key = engCountryKey(query);
  if (!key) return free;
  const exact = normalizeEngCountry(query);
  const first: EngCountry[] = [];
  const prefix: EngCountry[] = [];
  const inside: EngCountry[] = [];
  for (const c of free) {
    const labelKey = engCountryKey(c.label);
    if (c.value === exact) first.push(c);
    else if (labelKey.startsWith(key) || engCountryKey(c.value).startsWith(key)) prefix.push(c);
    else if (labelKey.includes(key) || engCountryKey(c.value).includes(key)) inside.push(c);
  }
  return [...first, ...prefix, ...inside];
}

export function EngCountryPicker({
  value,
  onChange,
  disabled = false,
  label = 'Countries',
}: {
  /** Выбранные значения каталога (порядок сохраняет сервер — по алфавиту). */
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Доступное имя поля поиска. */
  label?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = useMemo(() => new Set(value), [value]);
  // Чипы — по подписи, как список: значение каталога («republic of the congo»)
  // и подпись («Congo - Brazzaville») сортируются по-разному.
  const chips = useMemo(
    () => [...value].sort((a, b) => engCountryLabel(a).localeCompare(engCountryLabel(b), 'en')),
    [value],
  );
  const options = useMemo(() => engCountryMatches(query, selected), [query, selected]);
  const full = value.length >= HE_COLLECT_COUNTRIES_MAX;
  const shown = open && !disabled && !full && options.length > 0;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const add = (country: EngCountry) => {
    if (full || selected.has(country.value)) return;
    onChange([...value, country.value].sort());
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };
  const remove = (country: string) => {
    onChange(value.filter((v) => v !== country));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const n = options.length;
      if (n > 0) setActive((activeIndex + step + n) % n);
    } else if (e.key === 'Enter') {
      // Enter в поле поиска не отправляет форму создания проекта.
      e.preventDefault();
      if (shown && options[activeIndex]) add(options[activeIndex]);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      } else if (query) {
        e.preventDefault();
        setQuery('');
      }
    } else if (e.key === 'Backspace' && query === '' && chips.length > 0) {
      // Снимается последний видимый чип.
      e.preventDefault();
      const last = chips[chips.length - 1];
      onChange(value.filter((v) => v !== last));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {chips.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Chosen countries">
          {chips.map((country) => {
            const name = engCountryLabel(country);
            return (
              <li
                key={country}
                className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs"
                style={{ border: '1px solid var(--cp-divider)', color: 'var(--cp-paper)' }}
              >
                {name}
                <button
                  type="button"
                  onClick={() => remove(country)}
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ color: 'var(--cp-text-l)' }}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && options[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          value={query}
          disabled={disabled || full}
          placeholder={full ? `Up to ${HE_COLLECT_COUNTRIES_MAX} countries` : 'Search countries'}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          className="ds-input w-full text-xs"
        />
        {shown && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="absolute left-0 right-0 z-20 mt-1 max-h-60 list-none overflow-y-auto rounded-md p-1"
            style={{ background: 'var(--cp-surface-elev)', border: '1px solid var(--cp-divider)' }}
          >
            {options.map((country, i) => (
              <li
                key={country.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                // mousedown, а не click: иначе blur поля закрыл бы список раньше.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(country);
                }}
                onMouseEnter={() => setActive(i)}
                className="cursor-pointer rounded px-2 py-1 text-xs"
                style={{
                  color: 'var(--cp-paper)',
                  background: i === activeIndex ? 'var(--cp-divider)' : 'transparent',
                }}
              >
                {country.label}
              </li>
            ))}
          </ul>
        )}
        {open && !disabled && !full && options.length === 0 && query.trim() && (
          <p className="m-0 mt-1 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            No country matches «{query.trim()}».
          </p>
        )}
      </div>
      {full && (
        <p className="m-0 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          You can choose up to {HE_COLLECT_COUNTRIES_MAX} countries. Remove one to add another.
        </p>
      )}
    </div>
  );
}
