'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Search } from 'lucide-react';
import { DEFAULT_OKVED_PREFIXES } from '@/lib/polzaRuOutreach/types';

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
    fetch('/api/tools/polza-ru-outreach/okved-options')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (alive) setOptions(body.options as Option[]);
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
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-96 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Код или вид деятельности"
              className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-2 text-xs text-zinc-900"
            />
          </div>
          <div className="mb-2 flex gap-2 text-[11px]">
            <button type="button" className="text-blue-600 hover:underline" onClick={() => onChange([...DEFAULT_OKVED_PREFIXES].join(', '))}>
              Целевые по умолчанию
            </button>
            <button type="button" className="text-zinc-500 hover:underline" onClick={() => onChange('')}>
              Снять все
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {!options && !error ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-zinc-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загрузка списка…
              </div>
            ) : null}
            {error ? <div className="px-2 py-3 text-xs text-red-600">Список не загрузился: {error}. Коды можно вписать вручную.</div> : null}
            {rows.map((o) => (
              <label key={o.code} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-50">
                <input type="checkbox" checked={chosen.has(o.code)} onChange={() => toggle(o.code)} className="mt-0.5 h-3.5 w-3.5" />
                <span className="w-14 shrink-0 font-mono text-zinc-800">{o.code}</span>
                <span className="min-w-0 flex-1 text-zinc-600">{o.name ?? ''}</span>
                {o.companies ? <span className="shrink-0 tabular-nums text-zinc-400">{nf(o.companies)}</span> : null}
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-end">
            <button type="button" className="rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100" onClick={() => setOpen(false)}>
              Готово
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
