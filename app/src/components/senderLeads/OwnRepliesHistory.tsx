'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { OwnHistoryFilter, OwnHistoryRowDto } from '@/lib/ownReplyLeads/history';
import { fetchOwnHistory } from './api';

const FILTERS: { id: OwnHistoryFilter; label: string; tone: string }[] = [
  { id: 'all', label: 'Всего', tone: 'text-zinc-900' },
  { id: 'lead', label: 'Лиды', tone: 'text-emerald-700' },
  { id: 'not_lead', label: 'Не лиды', tone: 'text-zinc-600' },
  { id: 'pending', label: 'В очереди', tone: 'text-amber-700' },
  { id: 'error', label: 'Ошибки', tone: 'text-red-700' },
];

const BADGE: Record<OwnHistoryRowDto['status'], { label: string; className: string }> = {
  lead: { label: 'Лид', className: 'bg-emerald-100 text-emerald-700' },
  not_lead: { label: 'Не лид', className: 'bg-zinc-100 text-zinc-600' },
  pending: { label: 'В очереди', className: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', className: 'bg-red-100 text-red-700' },
  skipped: { label: 'Пропущен', className: 'bg-zinc-100 text-zinc-500' },
};

function formatAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Что сделано в AMO и в чате — одной строкой. */
function crmLine(row: OwnHistoryRowDto): { text: string; className: string } | null {
  if (row.handoffNote) return { text: row.handoffNote, className: 'text-zinc-500' };
  const crm = row.crm;
  if (!crm) return row.status === 'lead' ? { text: 'AMO: ставится в очередь', className: 'text-amber-700' } : null;
  if (crm.status === 'failed') return { text: `AMO: не получилось — ${crm.error ?? 'ошибка'}`, className: 'text-red-600' };
  if (crm.status === 'pending') return { text: `AMO: в очереди${crm.error ? ` — ${crm.error}` : ''}`, className: 'text-amber-700' };
  const what = crm.action === 'note_added' ? `добавлено к сделке «${crm.amoLeadName ?? ''}»` : 'сделка создана';
  const chat = crm.tgSentAt ? 'в чат ушло' : crm.tgError ? `в чат не ушло: ${crm.tgError}` : 'в чат уходит';
  return { text: `AMO: ${what} · ${chat}`, className: 'text-blue-700' };
}

/** История блока «Instantly · наши кампании» на вкладке «Квалификация». */
export function OwnRepliesHistory() {
  const [filter, setFilter] = useState<OwnHistoryFilter>('all');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<OwnHistoryRowDto[]>([]);
  const [counts, setCounts] = useState<Record<OwnHistoryFilter, number>>({ all: 0, lead: 0, not_lead: 0, pending: 0, error: 0 });
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetchOwnHistory(filter, page);
      setRows(res.rows);
      setCounts(res.counts);
      setTotal(res.total);
      setPageSize(res.pageSize);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить историю');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setFilter(item.id);
              setPage(1);
            }}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              filter === item.id ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
            }`}
          >
            <div className="text-xs text-zinc-500">{item.label}</div>
            <div className={`text-lg font-semibold ${item.tone}`}>{counts[item.id]}</div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Instantly · наши кампании ({total})</h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </div>
        {error ? <p className="px-5 pt-3 text-sm text-red-600">{error}</p> : null}
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-zinc-500">Оценённых ответов пока нет.</p>
        ) : (
          <div className="divide-y divide-zinc-100">
            {rows.map((row) => {
              const badge = BADGE[row.status];
              const crm = crmLine(row);
              const explanation = row.status === 'error' || (row.status === 'pending' && row.attempts > 0)
                ? row.lastError
                : row.aiReason;
              return (
                <div key={row.emailId} className="space-y-2 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900">{row.leadEmail}</span>
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">{row.campaignName}</div>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-500">{formatAt(row.replyAt)}</span>
                  </div>
                  <div className="rounded-lg bg-zinc-50 px-3 py-2">
                    {row.replySubject ? <p className="mb-0.5 text-xs font-medium text-zinc-600">{row.replySubject}</p> : null}
                    {/* Чужой ввод — текстом, разметку не исполняем. */}
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-zinc-700">{row.replyPreview || 'Текста нет'}</p>
                  </div>
                  {explanation ? <p className="text-sm text-zinc-600">{explanation}</p> : null}
                  {row.aiReply ? (
                    <p className="text-xs text-zinc-600">Ответ ИИ: {row.aiReply.status === 'sent' ? 'отправлен' : row.aiReply.status === 'review' ? 'нужен менеджер' : row.aiReply.status === 'sending' ? 'отправка не подтверждена' : row.aiReply.status === 'skipped' ? 'отменён' : row.aiReply.status === 'pending' ? 'ожидает отправки' : 'письмо не требуется'}
                      {row.aiReply.reason ? ` · ${row.aiReply.reason}` : ''}</p>
                  ) : row.aiReplyStatus === 'review' ? <p className="text-xs text-amber-700">Ответ ИИ: сбой, нужен менеджер</p> : null}
                  {crm ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className={`text-xs ${crm.className}`}>{crm.text}</span>
                      {row.crm?.leadUrl ? (
                        <a
                          href={row.crm.leadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50"
                        >
                          Сделка в AMO
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-zinc-500">Стр. {page} из {maxPage}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage}
              className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
