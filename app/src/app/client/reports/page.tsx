'use client';

import { useState, useCallback, useEffect } from 'react';
import { clientApiFetch } from '@/lib/clientFetcher';

interface CampaignRow {
  id: string;
  name: string;
  emails_sent_count: number | null;
  reply_count: number | null;
}

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
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApiFetch<{ campaigns: CampaignRow[] }>('/campaigns');
      setCampaigns(data.campaigns ?? []);
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
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Отчёты</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>Выберите кампании и сформируйте отчёт</p>
      </div>

      {error && (
        <div className="neu-inset mb-6 rounded-2xl px-5 py-3.5 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="neu-spinner animate-spin" />
        </div>
      ) : (
        <>
          {campaigns.length === 0 ? (
            <div className="neu-inset mb-4 rounded-2xl px-5 py-3.5 text-sm" style={{ color: 'var(--cp-text-l)' }}>
              Нет доступных кампаний
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-3">
              <button
                onClick={selectAll}
                className="text-xs font-semibold transition-colors"
                style={{ color: 'var(--cp-accent)' }}
              >
                {selectedIds.size === campaigns.length ? 'Снять все' : 'Выбрать все'}
              </button>
              <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                {selectedIds.size > 0 ? `Выбрано: ${selectedIds.size}` : 'Все кампании'}
              </span>
            </div>
          )}

          {campaigns.length > 0 && (
            <div className="neu-card mb-6 max-h-64 overflow-y-auto">
              {campaigns.map((c, idx) => {
                const sent = Number(c.emails_sent_count ?? 0);
                const replied = Number(c.reply_count ?? 0);
                const checked = selectedIds.has(c.id);
                return (
                  <label
                    key={c.id}
                    className="neu-row flex items-center gap-2 sm:gap-3 px-3 sm:px-5 py-2.5 sm:py-3 cursor-pointer"
                    style={idx > 0 ? { borderTop: '1px solid rgba(180,173,164,0.15)' } : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCampaign(c.id)}
                    />
                    <span className="flex-1 min-w-0 text-xs sm:text-sm font-medium truncate">{c.name}</span>
                    <span className="text-[10px] sm:text-[11px] shrink-0 hidden sm:inline" style={{ color: 'var(--cp-text-l)' }}>
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
              disabled={generating || campaigns.length === 0}
              className="neu-btn inline-flex items-center gap-2 px-5 sm:px-6 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold w-full sm:w-auto justify-center"
            >
              {generating ? 'Генерация...' : 'Сформировать отчёт'}
            </button>
          </div>

          {report && (
            <div className="neu-card overflow-hidden">
              <div className="px-3 sm:px-5 py-3 sm:py-4 flex items-center justify-between">
                <h3 className="text-xs sm:text-sm font-bold">Результат</h3>
                <button
                  onClick={handleDownloadCsv}
                  className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] sm:text-xs font-semibold"
                  style={{ color: 'var(--cp-accent)' }}
                >
                  CSV
                </button>
              </div>

              <hr className="neu-divider mx-3 sm:mx-5" />

              <div className="p-3 sm:p-5 grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4">
                {[
                  { label: 'Кампаний', value: report.summary.totalCampaigns },
                  { label: 'Отправлено', value: report.summary.totalEmailsSent },
                  { label: 'Открытия', value: report.summary.totalOpened, sub: report.summary.conversion.openPctAllEmails },
                  { label: 'Ответы', value: report.summary.totalReplies, sub: report.summary.conversion.replyPctByLeads },
                ].map((m) => (
                  <div key={m.label} className="neu-sm p-2.5 sm:p-3.5">
                    <p className="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>{m.label}</p>
                    <p className="text-base sm:text-lg font-bold mt-1">
                      {m.value}
                      {m.sub && <span className="text-[10px] sm:text-xs font-normal ml-1 sm:ml-1.5" style={{ color: 'var(--cp-text-l)' }}>{m.sub}</span>}
                    </p>
                  </div>
                ))}
              </div>

              {report.rows && report.rows.length > 0 && (
                <>
                  <hr className="neu-divider mx-3 sm:mx-5" />
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px] sm:text-xs">
                      <thead>
                        <tr>
                          {report.rows[0]?.map((cell, i) => (
                            <th key={i} className="px-3 sm:px-5 py-2.5 sm:py-3 text-left text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--cp-text-l)' }}>
                              {String(cell)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.rows.slice(1).map((row, ri) => (
                          <tr key={ri} className="neu-row" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-3 sm:px-5 py-2 sm:py-2.5 whitespace-nowrap" style={{ color: 'var(--cp-text-m)' }}>{String(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
