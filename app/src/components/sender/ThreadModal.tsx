'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { fetchThread, replyToThread, type ThreadItemDto } from './api';
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
 *
 * Ответ пишется прямо здесь (задача 4.1): письмо уходит с закреплённого ящика
 * лида тем же тредом — раньше оператор переключался в почтовый клиент, и
 * отправленный оттуда ответ в портале не появлялся.
 */
export function ThreadModal({ recipientId, onClose }: { recipientId: string; onClose: () => void }) {
  const [items, setItems] = useState<ThreadItemDto[]>([]);
  const [title, setTitle] = useState('Переписка');
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchThread(recipientId);
      setItems(res.items);
      setTitle(res.thread.recipient_name || res.thread.recipient_email);
      setSubtitle(
        [res.thread.recipient_email, res.thread.mailbox_email ? `через ${res.thread.mailbox_email}` : null, res.thread.campaign_name]
          .filter(Boolean)
          .join(' · '),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось открыть переписку');
    } finally {
      setLoading(false);
    }
  }, [recipientId]);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  const sendReply = async () => {
    const text = replyText.trim();
    if (!text) return;
    setReplying(true);
    setError(null);
    try {
      await replyToThread(recipientId, text);
      setReplyText('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить ответ');
    } finally {
      setReplying(false);
    }
  };

  return (
    <SenderModal title={title} subtitle={subtitle} size="wide" onClose={onClose}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : error && items.length === 0 ? (
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

      {/* Ответ оператора: уходит с закреплённого ящика переписки, тем же тредом.
          Кнопка неактивна, пока письмо пустое или предыдущее ещё отправляется. */}
      <div className="mt-4 border-t border-zinc-200 pt-3">
        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          rows={4}
          placeholder="Ответ лиду — уйдёт с ящика переписки в тот же тред"
          disabled={loading || replying}
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 disabled:bg-zinc-50"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          {error && items.length > 0 ? (
            <span className="text-sm text-red-600">{error}</span>
          ) : (
            <span className="text-xs text-zinc-500">Письмо встанет в очередь и отправится воркером в течение минуты</span>
          )}
          <button
            type="button"
            onClick={() => void sendReply()}
            disabled={replying || !replyText.trim() || loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Ответить
          </button>
        </div>
      </div>
    </SenderModal>
  );
}
