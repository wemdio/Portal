'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchThread, type ThreadItemDto } from './api';
import { SenderModal } from './SenderModal';

function formatAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Переписка с получателем: наши письма и его ответы одной лентой, сверху вниз
 * по времени. Исходящее прижато вправо, входящее влево — как в любом
 * мессенджере, чтобы направление читалось без подписи.
 */
export function ThreadModal({ recipientId, onClose }: { recipientId: string; onClose: () => void }) {
  const [items, setItems] = useState<ThreadItemDto[]>([]);
  const [title, setTitle] = useState('Переписка');
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchThread(recipientId);
        if (cancelled) return;
        setItems(res.items);
        setTitle(res.thread.recipient_name || res.thread.recipient_email);
        setSubtitle(
          [res.thread.recipient_email, res.thread.mailbox_email ? `через ${res.thread.mailbox_email}` : null, res.thread.campaign_name]
            .filter(Boolean)
            .join(' · '),
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось открыть переписку');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipientId]);

  return (
    <SenderModal title={title} subtitle={subtitle} size="wide" onClose={onClose}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : error ? (
        <p className="py-10 text-center text-sm text-red-600">{error}</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">Писем в этой переписке пока нет.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const outgoing = item.direction === 'out';
            return (
              <div key={item.id} className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-xl border p-3 ${
                    outgoing ? 'border-blue-100 bg-blue-50' : 'border-zinc-200 bg-white'
                  }`}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-700">{outgoing ? 'Мы' : item.fromEmail || 'Получатель'}</span>
                    <span>{formatAt(item.at)}</span>
                    {/* Пометка нужна там, где письмо не «просто ушло»: очередь,
                        ошибка отправки, автоответ или отбойник вместо ответа. */}
                    {item.note ? <span className="rounded-md bg-zinc-100 px-1.5 py-0.5">{item.note}</span> : null}
                  </div>
                  {item.subject ? <p className="text-sm font-medium text-zinc-900">{item.subject}</p> : null}
                  {/* Тело письма — текст как есть: HTML сюда не пускаем, это чужой
                      ввод, и его разметка не должна исполняться в портале. */}
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700">{item.body || '—'}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SenderModal>
  );
}
