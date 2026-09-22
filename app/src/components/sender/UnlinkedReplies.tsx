'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fetchUnlinkedReplies, type UnlinkedReplyDto } from './api';

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

/**
 * Входящие, которые не легли ни в одну переписку.
 *
 * Ответ связывается с получателем по ссылке на наше письмо или по адресу
 * отправителя. Если человек написал с другого ящика и новым письмом, не
 * сработает ни то, ни другое — а для него это ответ на нашу рассылку. Раньше
 * такое письмо просто оседало в базе и никому не показывалось.
 *
 * Блока не видно, пока таких писем нет: пустая плашка «0 без привязки» на
 * вкладке только отвлекала бы от переписок.
 */
export function UnlinkedReplies({ refreshKey }: { refreshKey: number }) {
  const [replies, setReplies] = useState<UnlinkedReplyDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [openReply, setOpenReply] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchUnlinkedReplies(page);
        if (cancelled) return;
        setReplies(res.replies);
        setTotal(res.total);
        setPageSize(res.pageSize);
        // Страница могла стать пустой после перезагрузки списка — откат.
        if (res.replies.length === 0 && res.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(res.total / res.pageSize)));
      } catch {
        /* блок вспомогательный: его отказ не должен ронять вкладку с перепиской */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, page]);

  if (!total) return null;

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="rounded-xl border border-amber-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-zinc-100"
      >
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        <span className="text-sm font-medium text-zinc-900">Входящие без привязки</span>
        <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">{total}</span>
        <span className="ml-auto hidden text-xs text-zinc-500 sm:block">
          письма, которые не удалось сопоставить с получателем кампании
        </span>
      </button>

      {open ? (
        <div className="divide-y divide-zinc-100 border-t border-zinc-200">
          {replies.map((reply) => {
            const expanded = openReply === reply.id;
            return (
              <div key={reply.id}>
                <button
                  type="button"
                  onClick={() => setOpenReply(expanded ? null : reply.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-zinc-100"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-zinc-900">
                        {reply.fromName || reply.fromEmail || 'Без адреса'}
                      </span>
                      <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                        {KIND_LABELS[reply.kind] ?? reply.kind}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {reply.subject || 'Без темы'}
                      {reply.mailboxEmail ? ` · на ${reply.mailboxEmail}` : ''}
                    </div>
                  </div>
                  <span className="text-xs text-zinc-500">{formatAt(reply.at)}</span>
                </button>

                {/* Текст письма — как текст: это чужой ввод, его разметка не
                    должна исполняться в портале. */}
                {expanded ? (
                  <p className="whitespace-pre-wrap break-words border-t border-zinc-100 bg-zinc-50 px-5 py-3 text-sm text-zinc-700">
                    {reply.body || '—'}
                  </p>
                ) : null}
              </div>
            );
          })}

          {maxPage > 1 ? (
            <div className="flex items-center justify-center gap-4 px-5 py-2.5 text-xs text-zinc-500">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-md px-2.5 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
              >
                ← Назад
              </button>
              <span>Стр. {page} из {maxPage} · {total} писем</span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                disabled={page >= maxPage}
                className="rounded-md px-2.5 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
              >
                Вперёд →
              </button>
            </div>
          ) : total > replies.length ? (
            <p className="px-5 py-2.5 text-xs text-zinc-500">
              Показаны последние {replies.length} из {total}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
