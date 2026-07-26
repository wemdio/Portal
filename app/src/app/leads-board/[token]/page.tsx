'use client';

import { useCallback, useEffect, useState, use } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Loader2 } from 'lucide-react';
import { BOARD_COLUMN_LABELS } from '@/lib/leadBoard/boardColumns';

type BoardRow = {
  id: string;
  lead_email: string | null;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
  website: string | null;
  request_text: string | null;
  campaign_name: string | null;
  step_number: number | null;
  reply_timestamp: string | null;
  quality: string | null;
  comment: string | null;
  taken: boolean;
};

type BoardData = {
  project: { name: string | null; client: string | null };
  columnConfig: { key: string; visible: boolean }[];
  qualities: string[];
  rows: BoardRow[];
  stats: {
    total: number;
    last7d: number;
    byQuality: Record<string, number>;
    byCampaign: Record<string, number>;
  };
};

/** Цветные чипы статусов — по цветам из Google-таблиц спецов. */
const QUALITY_COLORS: Record<string, string> = {
  'ответил': 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  'не отвечает': 'bg-zinc-800 text-zinc-300 border-zinc-600',
  'назначили звонок': 'bg-blue-900/60 text-blue-300 border-blue-700',
  'обсуждаем сотрудничество': 'bg-blue-900/60 text-blue-200 border-blue-600',
  'есть интерес': 'bg-violet-900/60 text-violet-300 border-violet-700',
  'не заинтересован': 'bg-orange-900/60 text-orange-300 border-orange-700',
  'отказался': 'bg-red-900/60 text-red-300 border-red-700',
  'лид не релевантный': 'bg-zinc-800 text-zinc-400 border-zinc-600',
  'уже в работе': 'bg-lime-900/60 text-lime-300 border-lime-700',
  'оплатил услугу/товар': 'bg-green-900/70 text-green-200 border-green-600',
  'просит связаться позже': 'bg-amber-900/60 text-amber-300 border-amber-700',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function RequestCell({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span className="text-zinc-600">—</span>;
  const long = text.length > 220;
  return (
    <div className="max-w-md">
      <div className={`whitespace-pre-wrap text-xs text-zinc-300 ${expanded ? '' : 'line-clamp-4'}`}>
        {text}
      </div>
      {long && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? 'Свернуть' : 'Развернуть'}
        </button>
      )}
    </div>
  );
}

export default function LeadBoardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<BoardData | null>(null);
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const apiBase = `/api/lead-board/${encodeURIComponent(token)}`;

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Ошибка ${res.status}`);
        return;
      }
      const d = (await res.json()) as BoardData;
      setData(d);
      setRows(d.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function patchRow(rowId: string, patch: Partial<Pick<BoardRow, 'quality' | 'comment' | 'taken'>>) {
    setRows((cur) => cur.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
    setSavingId(rowId);
    try {
      const res = await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId, ...patch }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Ошибка ${res.status}`);
      }
      setToast('Сохранено');
    } catch (err) {
      // Откат через refetch, а не снапшот state: при параллельных патчах разных
      // строк снапшотный откат затирал бы чужое успешное изменение.
      await fetchData();
      setToast(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3 px-4">
        <AlertCircle className="w-12 h-12 text-red-400" />
        <p className="text-lg text-red-400 text-center">{error || 'Данные не найдены'}</p>
        <p className="text-sm text-zinc-500 text-center">
          Проверьте ссылку или попросите специалиста прислать новую.
        </p>
      </div>
    );
  }

  const visibleColumns = data.columnConfig.filter((c) => c.visible && BOARD_COLUMN_LABELS[c.key]);
  const projectTitle = data.project.name || 'Проект';
  const qualityEntries = Object.entries(data.stats.byQuality).sort((a, b) => b[1] - a[1]);
  const campaignEntries = Object.entries(data.stats.byCampaign).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-3">
        <div className="max-w-[1400px] mx-auto">
          <h1 className="text-lg font-semibold">{projectTitle} — лиды Email Outreach</h1>
          <p className="text-sm text-zinc-400">
            {data.project.client ? `${data.project.client} · ` : ''}
            всего лидов: {data.stats.total} · за 7 дней: {data.stats.last7d}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {qualityEntries.map(([q, n]) => (
              <span
                key={q}
                className={`text-xs px-2 py-0.5 rounded-full border ${QUALITY_COLORS[q] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700'}`}
              >
                {q}: {n}
              </span>
            ))}
            {campaignEntries.length > 1 && (
              <span className="text-xs text-zinc-500 ml-2">
                Кампании: {campaignEntries.map(([c, n]) => `${c} (${n})`).join(', ')}
              </span>
            )}
          </div>
        </div>
      </header>

      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-zinc-800 border border-zinc-700 text-sm px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          {toast}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div className="max-w-[1400px] mx-auto p-4">
          {rows.length === 0 ? (
            <div className="border border-zinc-800 rounded-lg p-8 text-center text-zinc-400">
              Лидов пока нет — они появятся здесь автоматически, как только придут.
            </div>
          ) : (
            <div className="border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-900">
                    {visibleColumns.map((c) => (
                      <th
                        key={c.key}
                        className="px-3 py-2 text-left text-xs font-medium text-zinc-300 border-b border-zinc-800 whitespace-nowrap"
                      >
                        {BOARD_COLUMN_LABELS[c.key]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-zinc-800/60 align-top hover:bg-zinc-900/40">
                      {visibleColumns.map((c) => {
                        const saving = savingId === row.id;
                        switch (c.key) {
                          case 'phone':
                            return <td key={c.key} className="px-3 py-2 whitespace-pre-wrap text-xs">{row.phone || '—'}</td>;
                          case 'email':
                            return (
                              <td key={c.key} className="px-3 py-2 text-xs">
                                {row.lead_email ? (
                                  <a href={`mailto:${row.lead_email}`} className="text-blue-400 hover:underline">{row.lead_email}</a>
                                ) : '—'}
                              </td>
                            );
                          case 'name':
                            return <td key={c.key} className="px-3 py-2 text-xs">{row.lead_name || '—'}</td>;
                          case 'company':
                            return <td key={c.key} className="px-3 py-2 text-xs">{row.company_name || '—'}</td>;
                          case 'website':
                            return (
                              <td key={c.key} className="px-3 py-2 text-xs">
                                {row.website ? (
                                  <a
                                    href={row.website.startsWith('http') ? row.website : `https://${row.website}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-400 hover:underline inline-flex items-center gap-1"
                                  >
                                    {row.website} <ExternalLink className="w-3 h-3" />
                                  </a>
                                ) : '—'}
                              </td>
                            );
                          case 'request':
                            return <td key={c.key} className="px-3 py-2"><RequestCell text={row.request_text} /></td>;
                          case 'quality':
                            return (
                              <td key={c.key} className="px-3 py-2">
                                <select
                                  value={row.quality ?? ''}
                                  disabled={saving}
                                  onChange={(e) => patchRow(row.id, { quality: e.target.value || null })}
                                  className={`text-xs rounded-md border px-2 py-1 bg-zinc-900 outline-none ${
                                    row.quality
                                      ? (QUALITY_COLORS[row.quality] ?? 'border-zinc-700 text-zinc-200')
                                      : 'border-zinc-700 text-zinc-400'
                                  }`}
                                >
                                  <option value="">— выбрать —</option>
                                  {data.qualities.map((q) => (
                                    <option key={q} value={q}>{q}</option>
                                  ))}
                                </select>
                              </td>
                            );
                          case 'comment':
                            return (
                              <td key={c.key} className="px-3 py-2">
                                <input
                                  key={`${row.id}:${row.comment ?? ''}`}
                                  type="text"
                                  defaultValue={row.comment ?? ''}
                                  disabled={saving}
                                  placeholder="Комментарий…"
                                  onBlur={(e) => {
                                    const v = e.target.value;
                                    if (v !== (row.comment ?? '')) patchRow(row.id, { comment: v || null });
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                  }}
                                  className="w-44 bg-transparent border-b border-zinc-700 focus:border-blue-500 outline-none text-xs py-1 placeholder:text-zinc-600"
                                />
                              </td>
                            );
                          case 'campaign':
                            return <td key={c.key} className="px-3 py-2 text-xs">{row.campaign_name || '—'}</td>;
                          case 'step':
                            return <td key={c.key} className="px-3 py-2 text-xs text-center">{row.step_number ?? '—'}</td>;
                          case 'date':
                            return <td key={c.key} className="px-3 py-2 text-xs whitespace-nowrap">{formatDate(row.reply_timestamp)}</td>;
                          case 'taken':
                            return (
                              <td key={c.key} className="px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={row.taken}
                                  disabled={saving}
                                  onChange={(e) => patchRow(row.id, { taken: e.target.checked })}
                                  className="w-4 h-4 accent-emerald-500 cursor-pointer"
                                />
                              </td>
                            );
                          default:
                            return <td key={c.key} />;
                        }
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-600">
            Строки «Контакт» — «Дата лида» заполняются автоматически при получении лида.
            Колонки «Качество лида», «Комментарий», «Взяли в работу» — ваши, сохраняются сразу.
          </p>
        </div>
      </div>
    </div>
  );
}
