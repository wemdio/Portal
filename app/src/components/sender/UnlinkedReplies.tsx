'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchUnlinkedReplies, type UnlinkedReplyDto } from './api';

/**
 * Входящие, которые не легли ни в одну переписку.
 *
 * Ответ связывается с получателем по ссылке на наше письмо или по адресу
 * отправителя. Если человек написал с другого ящика и новым письмом, не
 * сработает ни то, ни другое — а для него это ответ на нашу рассылку. Раньше
 * такое письмо просто оседало в базе и никому не показывалось.
 *
 * С 15.10.2026 это не блок под «Письмами», а отдельная жёлтая «кампания» внизу
 * колонки кампаний: список — в средней колонке, письмо — справа, как у
 * обычных переписок.
 */

const KIND_LABELS: Record<string, string> = {
  human: 'ответ человека',
  auto_reply: 'автоответ',
  unknown: 'входящее',
};

function formatAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Сколько писем без привязки — для счётчика у пункта в колонке кампаний. */
export function useUnlinkedTotal(): number | null {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchUnlinkedReplies(1)
      .then((res) => { if (!cancelled) setTotal(res.total); })
      .catch(() => { /* пункт вспомогательный: без счётчика вкладка работает */ });
    return () => { cancelled = true; };
  }, []);
  return total;
}

/** Список писем без привязки — средняя колонка «Писем». */
export function UnlinkedList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (reply: UnlinkedReplyDto) => void;
}) {
  const [replies, setReplies] = useState<UnlinkedReplyDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUnlinkedReplies(page)
      .then((res) => {
        if (cancelled) return;
        setReplies(res.replies);
        setTotal(res.total);
        setPageSize(res.pageSize);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить письма');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [page]);

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="border-b border-zinc-200 px-3 py-2.5">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-900">
          Без привязки — {total} шт.
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" /> : null}
        </div>
        <p className="mt-1 text-xs text-zinc-500">Письма, которые не удалось сопоставить с получателем кампании.</p>
      </div>

      {error ? <p className="px-3 py-2 text-xs text-red-600">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {loading && replies.length === 0 ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" aria-label="Загрузка писем" />
          </div>
        ) : replies.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-zinc-500">Писем без привязки нет.</p>
        ) : (
          <div className={`divide-y divide-zinc-100 transition-opacity ${loading ? 'pointer-events-none opacity-50' : ''}`}>
            {replies.map((reply) => (
              <button
                key={reply.id}
                type="button"
                onClick={() => onSelect(reply)}
                className={`block w-full px-3 py-2.5 text-left transition-colors ${
                  selectedId === reply.id ? 'bg-amber-50' : 'hover:bg-zinc-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
                    {reply.fromName || reply.fromEmail || 'Без адреса'}
                  </span>
                  <span className="shrink-0 text-[11px] text-zinc-400">{formatAt(reply.at)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    {KIND_LABELS[reply.kind] ?? reply.kind}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                  {reply.subject || 'Без темы'}
                  {reply.mailboxEmail ? ` · на ${reply.mailboxEmail}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {maxPage > 1 ? (
        <div className="flex items-center justify-center gap-3 border-t border-zinc-200 px-3 py-2 text-xs">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="rounded-md px-2 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
          >
            ← Назад
          </button>
          <span className="text-zinc-500">{page} из {maxPage}</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            disabled={page >= maxPage || loading}
            className="rounded-md px-2 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
          >
            Вперёд →
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Письмо без привязки — правая колонка. Только чтение: отвечать некому из кампании. */
export function UnlinkedLetter({ reply }: { reply: UnlinkedReplyDto }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-200 px-5 py-3">
        <div className="h-6 truncate text-base font-semibold text-zinc-900">
          {reply.fromName || reply.fromEmail || 'Без адреса'}
        </div>
        <div className="h-4 truncate text-xs text-zinc-500">
          {[reply.fromName ? reply.fromEmail : null, reply.mailboxEmail ? `пришло на ${reply.mailboxEmail}` : null, formatAt(reply.at)]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
        <div className="rounded-xl border border-amber-200 bg-white p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-amber-700">{KIND_LABELS[reply.kind] ?? reply.kind}</span>
          </div>
          {reply.subject ? <p className="text-sm font-medium text-zinc-900">{reply.subject}</p> : null}
          {/* Текст письма — как текст: это чужой ввод, его разметка не должна исполняться в портале. */}
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700">{reply.body || '—'}</p>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Письмо не привязано ни к одному получателю кампаний — ответить отсюда нельзя. Ответьте из почтового ящика{reply.mailboxEmail ? ` ${reply.mailboxEmail}` : ''}.
        </p>
      </div>
    </div>
  );
}
