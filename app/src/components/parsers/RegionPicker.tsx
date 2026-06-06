'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { findRegionById, HH_REGIONS, searchRegions, type HHRegion } from '@/lib/parsers/hhArchive/regions';

interface Props {
  /** Массив выбранных area id ('113', '1', '2', ...). */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Максимум одновременно выбранных регионов. HH сам по себе допускает много,
   *  но логично ограничить 30 — соответствует серверной валидации. */
  max?: number;
  /** Client portal: hide operator jargon (area ids, OR logic, custom-code, the N/30 counter). */
  clientMode?: boolean;
}

/**
 * Multi-select combobox для регионов HH. Чипы выбранного + поиск + дропдаун.
 *
 * Стратегия:
 *  - Из дропдауна добавляем региона из справочника HH_REGIONS (известный код,
 *    человекочитаемое имя).
 *  - «Ввести код вручную» — для экзотики (любой area id из api.hh.ru/areas).
 *  - Если value пустой — поведение API: считаем как '113' (вся РФ).
 */
export function RegionPicker({ value, onChange, max = 30, clientMode }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const suggestions = useMemo(() => searchRegions(query, 30), [query]);
  const grouped = useMemo(() => {
    const groups = new Map<HHRegion['group'], HHRegion[]>();
    for (const r of suggestions) {
      const list = groups.get(r.group) ?? [];
      list.push(r);
      groups.set(r.group, list);
    }
    return Array.from(groups.entries());
  }, [suggestions]);

  function add(id: string) {
    if (!id) return;
    if (selectedSet.has(id)) return;
    if (value.length >= max) return;
    onChange([...value, id]);
    setQuery('');
  }

  function remove(id: string) {
    onChange(value.filter((x) => x !== id));
  }

  function addCustom() {
    const clean = customInput.trim();
    if (!clean) return;
    add(clean);
    setCustomInput('');
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace на пустом инпуте — удаляем последний чип.
    if (e.key === 'Backspace' && !query && value.length > 0) {
      remove(value[value.length - 1]);
    } else if (e.key === 'Enter' && suggestions.length > 0 && query.trim()) {
      e.preventDefault();
      add(suggestions[0].id);
    }
  }

  const isFull = value.length >= max;

  return (
    <div ref={rootRef} className="relative">
      {/* Chips + input — одна общая «коробка» */}
      <div
        onClick={() => {
          inputRef.current?.focus();
          setOpen(true);
        }}
        className="min-h-[40px] w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm flex flex-wrap gap-1.5 items-center cursor-text bg-white focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-200"
      >
        {value.map((id) => {
          const region = findRegionById(id);
          const label = region?.name ?? `area=${id}`;
          return (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-800"
            >
              {label}
              {!region && <span className="text-blue-400">(код {id})</span>}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(id);
                }}
                aria-label={`Убрать ${label}`}
                className="text-blue-500 hover:text-blue-700 ml-0.5"
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKeyDown}
          placeholder={value.length === 0 ? 'Москва, Екатеринбург, Казань…' : ''}
          className="flex-1 min-w-[140px] border-0 focus:outline-none focus:ring-0 bg-transparent text-sm py-1 px-1"
          disabled={isFull && !query}
        />
      </div>

      {clientMode ? (
        // Plain-language hint only — no counter, no "area", no "OR".
        <div className="text-[11px] mt-1.5" style={{ color: 'var(--cp-paper-faint)' }}>
          {value.length === 0
            ? 'Не выбрано: ищем по всей России.'
            : value.length > 1
              ? 'Несколько городов: вакансии из любого из них.'
              : 'Можно добавить ещё города.'}
        </div>
      ) : (
        <div className="text-xs text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
          <span>
            Выбрано: {value.length}/{max}
          </span>
          {value.length === 0 && <span>· пусто → парсим всю РФ (area=113)</span>}
          {value.length > 1 && (
            <span className="text-amber-700">
              · мульти-регион: HH объединяет через OR (вакансии из любого из выбранных городов)
            </span>
          )}
        </div>
      )}

      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-96 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {suggestions.length === 0 ? (
            <div className="px-3 py-3 text-sm text-gray-500">
              В справочнике не нашлось. Попробуй ввести код вручную ниже.
            </div>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group}>
                <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-gray-400 bg-gray-50 sticky top-0">
                  {group}
                </div>
                {items.map((r) => {
                  const isSelected = selectedSet.has(r.id);
                  return (
                    <button
                      type="button"
                      key={r.id}
                      disabled={isSelected || (isFull && !isSelected)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (isSelected) remove(r.id);
                        else add(r.id);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 ${
                        isSelected
                          ? 'bg-blue-50 text-blue-700'
                          : isFull
                            ? 'text-gray-300 cursor-not-allowed'
                            : 'text-gray-800 hover:bg-blue-50'
                      }`}
                    >
                      <span>
                        {r.name}
                        {!clientMode && <span className="text-xs text-gray-400 ml-2">area={r.id}</span>}
                      </span>
                      <span className="text-xs">
                        {isSelected ? '✓ выбран' : isFull ? '—' : '+ добавить'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}

          {/* Кастомный код — операторам; клиентам не показываем. */}
          {!clientMode && (
            <>
              <div className="border-t border-gray-100 px-3 py-2 bg-gray-50 flex items-center gap-2">
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustom();
                    }
                  }}
                  placeholder="Свой area id…"
                  className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addCustom();
                  }}
                  disabled={!customInput.trim() || isFull}
                  className="rounded-md bg-white border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  + добавить код
                </button>
              </div>
              <div className="px-3 py-1.5 text-[11px] text-gray-400 bg-gray-50 border-t border-gray-100">
                Всего регионов в справочнике: {HH_REGIONS.length}. Не нашли свой — введите код из api.hh.ru/areas.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
