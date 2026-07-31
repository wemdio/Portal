'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';

type QueueRow = {
  id: string;
  meeting_at: string | null;
  caption: string | null;
  filename: string;
  transcript_preview: string;
};

type DealSearchRow = {
  amo_id: number;
  name: string | null;
  company_name: string | null;
  company_website: string | null;
  created_at: string | null;
  status_name: string | null;
};

const SEARCH_DEBOUNCE_MS = 300;
/** Держим синхронно с SEARCH_MIN_CHARS в API-роуте: смысла запускать поиск
 *  раньше этого порога нет — сервер всё равно отдаст пустой список. */
const SEARCH_MIN_CHARS = 2;

const fmtDateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Moscow',
      })
    : '—';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Поиск и выбор сделки для одной строки очереди.
 *
 * Дебаунс и подсказки живут в отдельном компоненте с собственным состоянием,
 * а не в общей карте на родителе: ввод в одной строке не должен запускать
 * лишние ре-рендеры и запросы для остальных строк очереди.
 */
function DealPicker({
  disabled,
  selected,
  onSelect,
}: {
  disabled: boolean;
  selected: DealSearchRow | null;
  onSelect: (deal: DealSearchRow | null) => void;
}) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [results, setResults] = useState<DealSearchRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    let active = true;
    const run = async () => {
      // Короткий запрос — сразу пустой список без похода на сервер (там та
      // же граница SEARCH_MIN_CHARS, см. комментарий у route.ts). setState
      // — внутри async run(), а не синхронно в теле эффекта: тот же приём,
      // что и в остальных фетч-эффектах этого файла (react-hooks/set-state-
      // in-effect ругается только на синхронные вызовы в самом теле эффекта).
      if (trimmed.length < SEARCH_MIN_CHARS) {
        setResults([]);
        setTruncated(false);
        return;
      }
      setSearching(true);
      try {
        const res = await authFetch(
          `/api/analytics/first-sales/meeting-links?q=${encodeURIComponent(trimmed)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { rows: DealSearchRow[]; truncated: boolean };
        if (!active) return;
        setResults(json.rows);
        setTruncated(json.truncated);
      } catch (e) {
        if (!active) return;
        logError('first-sales.meeting_links.search_failed', e, { query: trimmed });
        setResults([]);
      } finally {
        if (active) setSearching(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [debouncedQuery]);

  if (selected) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
        <span className="font-medium">
          {selected.name || selected.company_name || `Сделка #${selected.amo_id}`}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-emerald-600 hover:text-emerald-900"
            aria-label="Сбросить выбор сделки"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder="Компания, сайт или название сделки…"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        // Задержка перед закрытием: клик по варианту в списке идёт через
        // onMouseDown ниже (срабатывает раньше blur), но небольшой зазор всё
        // равно нужен, чтобы клик успел долететь до обработчика.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-56 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700 disabled:opacity-50"
      />
      {open && query.trim().length >= SEARCH_MIN_CHARS && (
        <div className="absolute z-10 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg">
          {searching && <div className="px-2 py-1.5 text-xs text-zinc-400">Поиск…</div>}
          {!searching && results.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-zinc-400">Ничего не найдено</div>
          )}
          {!searching &&
            results.map((deal) => (
              <button
                key={deal.amo_id}
                type="button"
                onMouseDown={() => {
                  onSelect(deal);
                  setQuery('');
                  setOpen(false);
                }}
                className="block w-full border-b border-zinc-50 px-2 py-1.5 text-left text-xs last:border-0 hover:bg-zinc-50"
              >
                <div className="font-medium text-zinc-800">
                  {deal.name || deal.company_name || `Сделка #${deal.amo_id}`}
                </div>
                <div className="text-[10px] text-zinc-500">
                  {[deal.company_name, deal.company_website, deal.status_name].filter(Boolean).join(' · ') || '—'}
                  {deal.created_at ? ` · создана ${fmtDateTime(deal.created_at)}` : ''}
                </div>
              </button>
            ))}
          {truncated && (
            <div className="border-t border-zinc-100 px-2 py-1 text-[10px] text-amber-700">
              Показаны первые {results.length} — уточните запрос
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MeetingLinksEditor({
  from,
  to,
  onSaved,
}: {
  /** YYYY-MM-DD, тот же формат, что FiltersBar. */
  from: string;
  to: string;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Набор, а не одиночное значение — та же причина, что в SourceMapEditor:
  // двое элементов очереди можно сохранять параллельно, не дожидаясь первого.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [selectedByRow, setSelectedByRow] = useState<Record<string, DealSearchRow | null>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from, to });
        const res = await authFetch(`/api/analytics/first-sales/meeting-links?${qs.toString()}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { rows: QueueRow[]; truncated: boolean };
        if (!active) return;
        setError(null);
        setRows(json.rows);
        setTruncated(json.truncated);
      } catch (e) {
        if (!active) return;
        logError('first-sales.meeting_links.fetch_failed', e);
        setError(e instanceof Error ? e.message : 'Не удалось загрузить очередь');
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [from, to]);

  const removeRow = (id: string) => {
    setRows((cur) => (cur ? cur.filter((r) => r.id !== id) : cur));
  };

  const save = async (row: QueueRow, body: { amo_deal_id: number } | { not_a_meeting: true }) => {
    setSavingIds((cur) => new Set(cur).add(row.id));
    setRowErrors((cur) => {
      if (!(row.id in cur)) return cur;
      const next = { ...cur };
      delete next[row.id];
      return next;
    });

    try {
      const res = await authFetch('/api/analytics/first-sales/meeting-links', {
        method: 'PUT',
        body: JSON.stringify({ transcript_id: row.id, ...body }),
      });
      const respBody = (await res.json().catch(() => null)) as { error?: string } | null;

      if (res.status === 409) {
        // Гонка: пока эта строка лежала у нас на экране, её уже разметил
        // кто-то другой (уникальный индекс на transcript_id в БД не дал
        // тихо перезаписать чужой выбор). Строка больше не актуальна —
        // убираем её и сводку выше пересчитываем тем же onSaved, что и при
        // обычном сохранении: счётчик очереди должен уменьшиться в любом
        // случае, чей бы выбор ни выиграл гонку.
        removeRow(row.id);
        setNotice(respBody?.error || 'Запись уже разметил кто-то другой — обновили очередь.');
        onSaved();
        return;
      }

      if (!res.ok) {
        throw new Error(respBody?.error || `HTTP ${res.status}`);
      }

      removeRow(row.id);
      onSaved();
    } catch (e) {
      logError('first-sales.meeting_links.save_failed', e, { transcriptId: row.id });
      setRowErrors((cur) => ({
        ...cur,
        [row.id]: e instanceof Error ? e.message : 'Не удалось сохранить',
      }));
    } finally {
      setSavingIds((cur) => {
        if (!cur.has(row.id)) return cur;
        const next = new Set(cur);
        next.delete(row.id);
        return next;
      });
    }
  };

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white px-3 py-6 text-center text-sm text-zinc-400">
        Загрузка очереди…
      </div>
    );
  }

  const list = rows ?? [];

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-zinc-800">Записи без сделки</h2>
        <p className="text-xs text-zinc-500">
          Записи из чата встреч за выбранный период, которые автоматчик не смог однозначно привязать к сделке:
          нет подписи, подпись не опознана, либо она зацепила сразу несколько сделок. Привяжите руками или
          отметьте «не встреча» — для внутренних созвонов и мусора, чтобы они не всплывали здесь снова.
        </p>
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}
      {notice && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {notice}
        </div>
      )}
      {truncated && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          За выбранный период записей больше, чем показано — сузьте диапазон дат, чтобы увидеть остальные.
        </div>
      )}

      {list.length === 0 ? (
        <div className="rounded-lg border border-zinc-100 px-3 py-6 text-center text-xs text-zinc-400">
          Очередь пуста — все записи за период разобраны.
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((row) => {
            const saving = savingIds.has(row.id);
            const selected = selectedByRow[row.id] ?? null;
            const rowError = rowErrors[row.id];
            return (
              <li key={row.id} className="rounded-lg border border-zinc-100 p-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-medium text-zinc-800">{fmtDateTime(row.meeting_at)}</span>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-600">{row.filename}</span>
                    {row.caption ? (
                      <span className="rounded-full border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-600">
                        {row.caption}
                      </span>
                    ) : (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                        без подписи
                      </span>
                    )}
                  </div>
                  {/* Начало расшифровки — чтобы узнать, о ком речь, не открывая
                      видео (по одной подписи вроде «Mailganer гипотезы» это
                      невозможно). */}
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                    {row.transcript_preview || 'Расшифровка пуста.'}
                  </p>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <DealPicker
                    disabled={saving}
                    selected={selected}
                    onSelect={(deal) => setSelectedByRow((cur) => ({ ...cur, [row.id]: deal }))}
                  />
                  <button
                    type="button"
                    disabled={saving || !selected}
                    onClick={() => selected && void save(row, { amo_deal_id: selected.amo_id })}
                    className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Привязать
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save(row, { not_a_meeting: true })}
                    className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
                  >
                    Не встреча
                  </button>
                  {saving && <span className="text-[11px] text-zinc-400">Сохранение…</span>}
                  {rowError && <span className="text-[11px] text-red-600">{rowError}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
