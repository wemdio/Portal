'use client';

import React, { useState, useCallback, useMemo, useRef, memo, useEffect } from 'react';
import { MessageSquareText, ExternalLink, Loader2, Download, Search, Check, RefreshCw } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { buildRepliesReportHtml } from '@/lib/repliesReport/buildReportHtml';
import type { RepliesReportResult, CampaignReplies } from '@/lib/repliesReport/types';

const ROW_HEIGHT = 44;
const OVERSCAN = 8;
const INSTANTLY_ANALYTICS_URL_BASE = 'https://app.instantly.ai/app/campaign/';

interface InstantlyCampaignItem {
  id: string;
  name: string;
  status?: number;
  timestamp_created?: string;
  timestamp_updated?: string;
}

function formatTs(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return new Date(ms).toLocaleString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return raw;
}

const CampaignRow = memo(function CampaignRow({
  campaign,
  isChecked,
  onToggle,
}: {
  campaign: InstantlyCampaignItem;
  isChecked: boolean;
  onToggle: (id: string) => void;
}) {
  const createdLabel = formatTs(campaign.timestamp_created) ?? formatTs(campaign.timestamp_updated);
  return (
    <li>
      <label
        htmlFor={`camp-${campaign.id}`}
        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors h-[38px] box-border ${
          isChecked ? 'bg-indigo-50 border border-indigo-100' : 'bg-gray-50/80 border border-transparent hover:bg-gray-100/90 hover:border-gray-200'
        }`}
      >
        <input type="checkbox" id={`camp-${campaign.id}`} checked={isChecked} onChange={() => onToggle(campaign.id)} className="sr-only" />
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${isChecked ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-transparent'}`}>
          <Check className="h-3 w-3 stroke-[3]" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-gray-800 break-words truncate">{campaign.name || campaign.id}</span>
          {createdLabel ? <span className="block text-[11px] leading-4 text-gray-500 truncate">Добавлено: {createdLabel}</span> : null}
        </span>
        <a
          href={`${INSTANTLY_ANALYTICS_URL_BASE}${campaign.id}/analytics`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-200 hover:text-indigo-600 transition-colors"
          title="Открыть аналитику в Instantly"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </label>
    </li>
  );
});

interface ProgressState {
  current: number;
  total: number;
  phase: 'fetching' | 'done' | 'error';
}

function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%';
}

function buildFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `otvety-po-kampaniyam_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.html`;
}

export default function RepliesReportPage() {
  const [campaignsList, setCampaignsList] = useState<InstantlyCampaignItem[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsFetched, setCampaignsFetched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [progressTotal, setProgressTotal] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RepliesReportResult | null>(null);

  const listContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const loadCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setError('');
    try {
      const res = await authFetch('/api/tools/auto-report/campaigns');
      const data = (await res.json().catch(() => ({}))) as { campaigns?: InstantlyCampaignItem[]; error?: string };
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`);
        return;
      }
      const sorted = [...(data.campaigns ?? [])].sort((a, b) => {
        const an = Date.parse(a.timestamp_created ?? a.timestamp_updated ?? '');
        const bn = Date.parse(b.timestamp_created ?? b.timestamp_updated ?? '');
        if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
        return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
      });
      setCampaignsList(sorted);
      setSelectedIds(new Set());
      setCampaignsFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки кампаний');
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  const filteredCampaigns = useMemo(() => {
    const q = normalizeForSearch(searchQuery);
    if (!q) return campaignsList;
    return campaignsList.filter((c) => normalizeForSearch(c.name || '').includes(q));
  }, [campaignsList, searchQuery]);

  const { startIndex, totalHeight, visibleCampaigns } = useMemo(() => {
    const total = filteredCampaigns.length;
    if (total === 0) return { startIndex: 0, totalHeight: 0, visibleCampaigns: [] as InstantlyCampaignItem[] };
    const containerHeight = 28 * 16;
    const rowCount = Math.ceil(containerHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(total, start + rowCount);
    return { startIndex: start, totalHeight: total * ROW_HEIGHT, visibleCampaigns: filteredCampaigns.slice(start, end) };
  }, [filteredCampaigns, scrollTop]);

  const toggleCampaign = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = () => setSelectedIds(new Set(filteredCampaigns.map((c) => c.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setProgress(null);
    setProgressTotal(0);
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setError('Выберите хотя бы одну кампанию.');
      return;
    }
    setLoading(true);
    try {
      const res = await authFetch('/api/tools/replies-report/stream', {
        method: 'POST',
        body: JSON.stringify({ campaignIds: ids, since: since || undefined, until: until || undefined }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error || `Ошибка ${res.status}`);
        setLoading(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const chunk of parts) {
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as {
              type: string;
              total?: number;
              current?: number;
              phase?: 'fetching' | 'done' | 'error';
              message?: string;
              campaigns?: CampaignReplies[];
              generatedAt?: string;
              since?: string | null;
              until?: string | null;
            };
            if (event.type === 'start') {
              setProgressTotal(event.total ?? 0);
            } else if (event.type === 'progress') {
              setProgress({ current: event.current ?? 0, total: event.total ?? 0, phase: event.phase ?? 'fetching' });
            } else if (event.type === 'result') {
              setResult({
                campaigns: event.campaigns ?? [],
                generatedAt: event.generatedAt ?? new Date().toISOString(),
                since: event.since ?? null,
                until: event.until ?? null,
              });
              setProgress(null);
            } else if (event.type === 'error') {
              setError(event.message || 'Ошибка формирования отчёта');
            }
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса');
    } finally {
      setLoading(false);
    }
  };

  const downloadHtml = () => {
    if (!result) return;
    const html = buildRepliesReportHtml(result);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildFilename();
    a.click();
    URL.revokeObjectURL(url);
  };
  const openHtml = () => {
    if (!result) return;
    const html = buildRepliesReportHtml(result);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const totalReplies = result ? result.campaigns.reduce((s, c) => s + c.replies.length, 0) : 0;
  const progressPct = progressTotal > 0 && progress ? Math.round((progress.current / progressTotal) * 100) : 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600">
          <MessageSquareText className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Отчёт по ответам</h1>
          <p className="text-sm text-gray-500">
            Выберите кампании Instantly — соберём HTML с метриками и читаемыми ответами, сгруппированными по кампаниям.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Период (опционально, применяется к списку ответов) */}
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-gray-200 bg-white p-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Ответы с</label>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">по</label>
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <p className="text-xs text-gray-500 max-w-sm">Пусто = все ответы за всё время. Метрики кампаний всегда за всё время (ограничение аналитики Instantly).</p>
        </div>

        {/* Выбор кампаний */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск кампаний…"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm"
              />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <button type="button" onClick={selectAll} className="rounded-lg px-2.5 py-1.5 text-indigo-600 hover:bg-indigo-50">Выбрать все</button>
              <button type="button" onClick={clearSelection} className="rounded-lg px-2.5 py-1.5 text-gray-500 hover:bg-gray-100">Очистить</button>
              <button type="button" onClick={loadCampaigns} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-indigo-600" title="Обновить список">
                <RefreshCw className={`h-4 w-4 ${campaignsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="mb-2 text-xs text-gray-500">
            Выбрано: <span className="font-semibold text-gray-700">{selectedIds.size}</span> · всего: {filteredCampaigns.length}
          </div>

          {campaignsLoading && !campaignsFetched ? (
            <div className="flex items-center gap-2 py-10 text-gray-500"><Loader2 className="h-5 w-5 animate-spin" /> Загрузка кампаний…</div>
          ) : filteredCampaigns.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-500">Кампании не найдены. Нажмите «Обновить список».</div>
          ) : (
            <div
              ref={listContainerRef}
              onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
              className="h-[28rem] overflow-y-auto rounded-lg border border-gray-100"
            >
              <ul style={{ height: totalHeight, position: 'relative' }} className="px-2 py-1">
                <div style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }} className="absolute left-0 right-0 px-2 space-y-1">
                  {visibleCampaigns.map((c) => (
                    <CampaignRow key={c.id} campaign={c} isChecked={selectedIds.has(c.id)} onToggle={toggleCampaign} />
                  ))}
                </div>
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={loading || selectedIds.size === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
            Сформировать отчёт
          </button>
          {loading && progress ? (
            <span className="text-sm text-gray-500">Кампания {progress.current} из {progress.total}…</span>
          ) : null}
        </div>

        {loading && progressTotal > 0 ? (
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        ) : null}

        {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      </form>

      {/* Результат */}
      {result ? (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Готово</h2>
              <p className="text-sm text-gray-500">{totalReplies} ответов · {result.campaigns.length} кампаний</p>
            </div>
            <div className="flex gap-2">
              <button onClick={downloadHtml} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                <Download className="h-4 w-4" /> Скачать HTML
              </button>
              <button onClick={openHtml} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <ExternalLink className="h-4 w-4" /> Открыть
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="border-b border-gray-200 px-3 py-2">Кампания</th>
                  <th className="border-b border-gray-200 px-3 py-2 text-right">Контактов</th>
                  <th className="border-b border-gray-200 px-3 py-2 text-right">Отправлено</th>
                  <th className="border-b border-gray-200 px-3 py-2 text-right">Открытий · %</th>
                  <th className="border-b border-gray-200 px-3 py-2 text-right">Ответов · %</th>
                  <th className="border-b border-gray-200 px-3 py-2 text-right">Собрано</th>
                </tr>
              </thead>
              <tbody>
                {result.campaigns.map((c) => (
                  <tr key={c.id} className="text-gray-800">
                    <td className="border-b border-gray-100 px-3 py-2">{c.name}{c.failed ? ' ⚠' : ''}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right">{c.metrics.contacts}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right">{c.metrics.emailsSent}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right">{c.metrics.opened} · {pct(c.metrics.opened, c.metrics.emailsSent)}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right">{c.metrics.replies} · {pct(c.metrics.replies, c.metrics.contacts)}</td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right">{c.replies.length}{c.truncated ? '+' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
