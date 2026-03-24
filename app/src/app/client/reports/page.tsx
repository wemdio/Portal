'use client';

import { useState, useCallback, useEffect } from 'react';
import { Loader2, FileText, Download } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';

interface ReportSummary {
  totalCampaigns: number;
  totalContacts: number;
  totalEmailsSent: number;
  totalOpened: number;
  totalReplies: number;
  totalLeads: number;
  totalBounced: number;
  conversion: { openPctAllEmails: string; replyPctByLeads: string };
}

interface ReportResponse {
  tableText: string;
  csvText: string;
  rows: (string | number)[][];
  summary: ReportSummary;
  campaignData: Record<string, unknown>;
}

export default function ClientReportsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [analytics, setAnalytics] = useState<CampaignAnalytics[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApiFetch<{ campaigns: Campaign[]; analytics: CampaignAnalytics[] }>('/campaigns');
      setCampaigns(data.campaigns ?? []);
      setAnalytics(data.analytics ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const toggleCampaign = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === campaigns.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(campaigns.map((c) => c.id)));
    }
  };

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError('');
    setReport(null);
    try {
      const ids = selectedIds.size > 0 ? [...selectedIds] : [];
      const data = await clientApiFetch<ReportResponse>('/reports', {
        method: 'POST',
        body: JSON.stringify({ campaignIds: ids }),
      });
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации отчёта');
    } finally {
      setGenerating(false);
    }
  }, [selectedIds]);

  const handleDownloadCsv = () => {
    if (!report?.csvText) return;
    const blob = new Blob([report.csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Отчёты</h1>
        <p className="mt-1 text-sm text-zinc-500">Выберите кампании и сформируйте отчёт</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <button
              onClick={selectAll}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {selectedIds.size === campaigns.length ? 'Снять все' : 'Выбрать все'}
            </button>
            <span className="text-xs text-zinc-400">
              {selectedIds.size > 0 ? `Выбрано: ${selectedIds.size}` : 'Все кампании'}
            </span>
          </div>

          {campaigns.length > 0 && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100 max-h-64 overflow-y-auto">
              {campaigns.map((c) => {
                const a = analytics.find((x) => x.campaign_id === c.id);
                const sent = a?.emails_sent_count ?? 0;
                const replied = a?.reply_count ?? 0;
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                      selectedIds.has(c.id) ? 'bg-blue-50' : 'hover:bg-zinc-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleCampaign(c.id)}
                      className="rounded border-zinc-300"
                    />
                    <span className="flex-1 min-w-0 text-sm text-zinc-800 truncate">{c.name}</span>
                    <span className="text-xs text-zinc-400 shrink-0">
                      {sent} sent / {replied} replies
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="mb-8">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors"
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Генерация...
                </>
              ) : (
                <>
                  <FileText className="h-4 w-4" />
                  Сформировать отчёт
                </>
              )}
            </button>
          </div>

          {report && (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-800">Результат</h3>
                <button
                  onClick={handleDownloadCsv}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                >
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
              </div>

              <div className="p-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-zinc-500">Кампаний</p>
                  <p className="text-lg font-bold text-zinc-900">{report.summary.totalCampaigns}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Отправлено</p>
                  <p className="text-lg font-bold text-zinc-900">{report.summary.totalEmailsSent}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Открытия</p>
                  <p className="text-lg font-bold text-zinc-900">
                    {report.summary.totalOpened}
                    <span className="text-xs font-normal text-zinc-400 ml-1">{report.summary.conversion.openPctAllEmails}</span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Ответы</p>
                  <p className="text-lg font-bold text-zinc-900">
                    {report.summary.totalReplies}
                    <span className="text-xs font-normal text-zinc-400 ml-1">{report.summary.conversion.replyPctByLeads}</span>
                  </p>
                </div>
              </div>

              {report.rows && report.rows.length > 0 && (
                <div className="border-t border-zinc-100 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-zinc-50 text-left">
                        {report.rows[0]?.map((cell, i) => (
                          <th key={i} className="px-3 py-2 font-medium text-zinc-500">{String(cell)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      {report.rows.slice(1).map((row, ri) => (
                        <tr key={ri} className="hover:bg-zinc-50">
                          {row.map((cell, ci) => (
                            <td key={ci} className="px-3 py-2 text-zinc-700">{String(cell)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
