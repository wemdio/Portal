'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { findRegionById, HH_REGIONS, searchRegions, type HHRegion } from '@/lib/parsers/hhArchive/regions';
import { authFetchJson } from '@/lib/authFetch';

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

/** A suggestion is an HHRegion plus an optional parent-region hint (live HH cities). */
type Suggestion = HHRegion & { regionHint?: string };

/**
 * Multi-select combobox для регионов HH. Чипы выбранного + поиск + дропдаун.
 *
 * Стратегия:
 *  - Статический справочник HH_REGIONS (топ-города + все регионы) — мгновенно,
 *    без сети, дефолт при пустом запросе.
 *  - clientMode: при вводе ≥2 символов дозапрашиваем полный справочник HH
 *    (/api/parsers/hh/areas, кеш на сервере) — даёт любой город как на hh.ru.
 *    При недоступности бэка тихо откатываемся на статический поиск.
 *  - Если value пустой — поведение API: считаем как '113' (вся РФ).
 */
export function RegionPicker({ value, onChange, max = 30, clientMode }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  // clientMode live search against the full HH areas dictionary.
  const [liveHits, setLiveHits] = useState<{ id: string; name: string; region: string }[]>([]);
  const [loadingLive, setLoadingLive] = useState(false);
  // id → human name, so chips for live-picked cities (not in HH_REGIONS) show a
  // name rather than "area=NNN". Seeded from picks + live results.
  const [labelMap, setLabelMap] = useState<Map<string, string>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced live HH lookup (clientMode only). Operators stay fully static.
  useEffect(() => {
    if (!clientMode) return;
    const q = query.trim();
    if (q.length < 2) {
      setLiveHits([]);
      setLoadingLive(false);
      return;
    }
    let cancelled = false;
    setLoadingLive(true);
    const timer = setTimeout(async () => {
      try {
        const res = await authFetchJson<{ items: { id: string; name: string; region: string }[] }>(
          `/api/parsers/hh/areas?q=${encodeURIComponent(q)}`,
        );
        if (cancelled) return;
        const items = Array.isArray(res.items) ? res.items : [];
        setLiveHits(items);
        if (items.length > 0) {
          setLabelMap((prev) => {
            const next = new Map(prev);
            for (const it of items) next.set(it.id, it.name);
            return next;
          });
        }
      } catch {
        if (!cancelled) setLiveHits([]); // fall back to static matches silently
      } finally {
        if (!cancelled) setLoadingLive(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, clientMode]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const staticSuggestions = useMemo(() => searchRegions(query, clientMode ? 12 : 30), [query, clientMode]);

  // clientMode: merge static matches with live HH cities (deduped by id).
  const suggestions: Suggestion[] = useMemo(() => {
    if (!clientMode) return staticSuggestions;
    const seen = new Set(staticSuggestions.map((r) => r.id));
    const live: Suggestion[] = liveHits
      .filter((h) => !seen.has(h.id))
      .map((h) => ({ id: h.id, name: h.name, group: 'Города России', regionHint: h.region || undefined }));
    return [...staticSuggestions, ...live].slice(0, 40);
  }, [clientMode, staticSuggestions, liveHits]);

  const grouped = useMemo(() => {
    const groups = new Map<HHRegion['group'], Suggestion[]>();
    for (const r of suggestions) {
      const list = groups.get(r.group) ?? [];
      list.push(r);
      groups.set(r.group, list);
    }
    return Array.from(groups.entries());
  }, [suggestions]);

  // «Вся Россия» (area 113) already covers every city, so mixing it with
  // specific cities is meaningless. In clientMode make them mutually exclusive.
  const ALL_RUSSIA_ID = '113';
  function add(id: string, label?: string) {
    if (!id) return;
    if (label) {
      setLabelMap((prev) => (prev.get(id) === label ? prev : new Map(prev).set(id, label)));
    }
    if (selectedSet.has(id)) return;
    if (value.length >= max) return;
    if (clientMode) {
      if (id === ALL_RUSSIA_ID) {
        // Picking «Вся Россия» clears any specific cities.
        onChange([ALL_RUSSIA_ID]);
        setQuery('');
        return;
      }
      // Picking a specific city drops the all-Russia selection.
      onChange([...value.filter((x) => x !== ALL_RUSSIA_ID), id]);
      setQuery('');
      return;
    }
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

  function nameFor(id: string): string | undefined {
    return labelMap.get(id) ?? findRegionById(id)?.name;
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace на пустом инпуте — удаляем последний чип.
    if (e.key === 'Backspace' && !query && value.length > 0) {
      remove(value[value.length - 1]);
    } else if (e.key === 'Enter' && suggestions.length > 0 && query.trim()) {
      e.preventDefault();
      add(suggestions[0].id, suggestions[0].name);
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
          const name = nameFor(id);
          const label = name ?? `area=${id}`;
          return (
            <span
              key={id}
              className={clientMode
                ? 'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs'
                : 'inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-800'}
              style={clientMode ? { background: 'var(--cp-surface-elev)', border: '1px solid var(--cp-divider-strong)', color: 'var(--cp-paper)' } : undefined}
            >
              {label}
              {!name && (
                <span className={clientMode ? '' : 'text-blue-400'} style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>(код {id})</span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(id);
                }}
                aria-label={`Убрать ${label}`}
                className={clientMode ? 'ml-0.5' : 'text-blue-500 hover:text-blue-700 ml-0.5'}
                style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}
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
            ? 'Не выбрано: ищем по всей России. Начните вводить город — найдём любой, как на hh.ru.'
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
            clientMode && loadingLive ? (
              <div className="px-3 py-3 text-sm" style={{ color: 'var(--cp-paper-faint)' }}>Ищем города…</div>
            ) : clientMode ? (
              <div className="px-3 py-3 text-sm" style={{ color: 'var(--cp-paper-faint)' }}>
                {query.trim().length < 2 ? 'Начните вводить название города или региона.' : 'Ничего не нашлось.'}
              </div>
            ) : (
              <div className="px-3 py-3 text-sm text-gray-500">
                В справочнике не нашлось. Попробуй ввести код вручную ниже.
              </div>
            )
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
                        else add(r.id, r.name);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 ${
                        clientMode
                          ? isSelected
                            ? 'cp-region-opt-selected'
                            : isFull
                              ? 'cp-region-opt-full'
                              : 'cp-region-opt'
                          : isSelected
                            ? 'bg-blue-50 text-blue-700'
                            : isFull
                              ? 'text-gray-300 cursor-not-allowed'
                              : 'text-gray-800 hover:bg-blue-50'
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        {r.name}
                        {clientMode && r.regionHint ? (
                          <span className="ml-2 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>· {r.regionHint}</span>
                        ) : null}
                        {!clientMode && <span className="text-xs text-gray-400 ml-2">area={r.id}</span>}
                      </span>
                      <span className="text-xs shrink-0">
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
