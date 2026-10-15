'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import { DEFAULT_OKVED_PREFIXES } from '@/lib/polzaRuOutreach/types';
import { authFetchJson } from '@/lib/authFetch';

interface Option {
  code: string;
  companies: number;
  name: string | null;
}

const nf = (n: number) => n.toLocaleString('ru-RU');

/** Строка «62.01, 62.02, 28» → список кодов. */
function parse(value: string): string[] {
  return value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Выбор ОКВЭД галочками в открывающемся меню. Список — из общей базы компаний
 * (код, сколько компаний, вид деятельности). Строка с кодами остаётся главной:
 * галочки только правят её, коды можно дописать и руками.
 */
export function OkvedPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open || options) return;
    let alive = true;
    // authFetch — с токеном сессии, как у остальных запросов экрана.
    authFetchJson<{ options: Option[] }>('/api/tools/polza-ru-outreach/okved-options')
      .then((body) => {
        if (alive) setOptions(body.options);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [open, options]);

  const chosen = useMemo(() => new Set(parse(value)), [value]);

  // Целевые коды из документа всегда в списке, даже если в базе их мало.
  const rows = useMemo(() => {
    const byCode = new Map<string, Option>();
    for (const o of options ?? []) byCode.set(o.code, o);
    for (const code of [...DEFAULT_OKVED_PREFIXES, ...chosen]) {
      if (!byCode.has(code)) byCode.set(code, { code, companies: 0, name: null });
    }
    const needle = query.trim().toLowerCase();
    return [...byCode.values()]
      .filter((o) => !needle || o.code.toLowerCase().includes(needle) || (o.name ?? '').toLowerCase().includes(needle))
      .sort((a, b) => Number(chosen.has(b.code)) - Number(chosen.has(a.code)) || a.code.localeCompare(b.code));
  }, [options, chosen, query]);

  const toggle = (code: string) => {
    const next = new Set(chosen);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next].join(', '));
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-full items-center gap-1 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
      >
        Выбрать из списка ({chosen.size})
        <ChevronDown className="h-4 w-4" />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
              onClick={() => setOpen(false)}
            >
              <div
                role="dialog"
                aria-label="Выбор ОКВЭД"
                className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-semibold text-zinc-900">Выбор ОКВЭД ({chosen.size})</div>
                  <button type="button" aria-label="Закрыть" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" onClick={() => setOpen(false)}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Код или вид деятельности"
                    className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-2 text-sm text-zinc-900"
                  />
                </div>
                <div className="mb-2 flex gap-3 text-xs">
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => onChange([...DEFAULT_OKVED_PREFIXES].join(', '))}>
                    Целевые по умолчанию
                  </button>
                  <button type="button" className="text-zinc-500 hover:underline" onClick={() => onChange('')}>
                    Снять все
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {!options && !error ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-xs text-zinc-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загрузка списка…
                    </div>
                  ) : null}
                  {error ? <div className="px-2 py-3 text-xs text-red-600">Список не загрузился: {error}. Коды можно вписать вручную.</div> : null}
                  {rows.map((o) => (
                    <label key={o.code} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-zinc-50">
                      <input type="checkbox" checked={chosen.has(o.code)} onChange={() => toggle(o.code)} className="mt-0.5 h-4 w-4" />
                      <span className="w-16 shrink-0 font-mono text-zinc-800">{o.code}</span>
                      <span className="min-w-0 flex-1 text-zinc-600">{o.name ?? ''}</span>
                      {o.companies ? <span className="shrink-0 tabular-nums text-zinc-400">{nf(o.companies)}</span> : null}
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex justify-end">
                  <button type="button" className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700" onClick={() => setOpen(false)}>
                    Готово
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
