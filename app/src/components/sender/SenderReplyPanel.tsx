'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2, Send, Sparkles } from 'lucide-react';
import { LeadVerdictBar } from '@/components/senderLeads/LeadVerdictBar';
import {
  fetchReplyDraft,
  fetchThread,
  generateReplyDraft,
  replyToThread,
  saveReplyLanguage,
  type ReplyDraftDto,
  type ReplyLanguage,
  type ThreadItemDto,
} from './api';

function formatAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Набранный текст переживает переключение переписок и перезагрузку страницы. */
const textKey = (recipientId: string) => `sender-reply-text:${recipientId}`;

function readSaved(recipientId: string): string {
  try {
    return window.localStorage.getItem(textKey(recipientId)) ?? '';
  } catch {
    return '';
  }
}

function writeSaved(recipientId: string, text: string) {
  try {
    if (text.trim()) window.localStorage.setItem(textKey(recipientId), text);
    else window.localStorage.removeItem(textKey(recipientId));
  } catch {
    /* хранилище браузера недоступно — текст просто не переживёт перезагрузку */
  }
}

/** Пока ответ в очереди или отправляется, переписку перечитываем: видно, ушёл ли он. */
const PENDING_NOTES = new Set(['в очереди', 'отправляется']);

/**
 * Переписка «Рассылки» с персонализированным ответом — как в инструменте
 * «Персонализированные ответы»: лента писем, метка лида, ИИ пишет ответ на
 * русском или английском по брифу кампании и нашей цепочке, сотрудник правит
 * и отправляет. Письмо уходит с ящика переписки тем же тредом.
 */
export function SenderReplyPanel({
  recipientId,
  onSent,
  onVerdictChange,
}: {
  recipientId: string;
  /** Ответ ушёл в очередь — списку пора обновить переписку. */
  onSent?: () => void;
  onVerdictChange?: () => void;
}) {
  const [items, setItems] = useState<ThreadItemDto[]>([]);
  const [header, setHeader] = useState<{ title: string; subtitle: string; mailbox: string | null; email: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [language, setLanguage] = useState<ReplyLanguage>('ru');
  const [hasBrief, setHasBrief] = useState(true);
  const [draft, setDraft] = useState<ReplyDraftDto | null>(null);
  const [text, setText] = useState(() => readSaved(recipientId));
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Лента писем и последнее письмо в ней — чтобы открыть переписку на его начале. */
  const threadRef = useRef<HTMLDivElement>(null);
  const lastItemRef = useRef<HTMLDivElement>(null);

  const loadThread = useCallback(async () => {
    const res = await fetchThread(recipientId);
    setItems(res.items);
    setHeader({
      title: res.thread.recipient_name || res.thread.recipient_email,
      subtitle: [res.thread.recipient_name ? res.thread.recipient_email : null, res.thread.campaign_name].filter(Boolean).join(' · '),
      mailbox: res.thread.mailbox_email,
      email: res.thread.recipient_email,
    });
  }, [recipientId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [, draftRes] = await Promise.all([loadThread(), fetchReplyDraft(recipientId)]);
        if (cancelled) return;
        setLanguage(draftRes.language);
        setHasBrief(draftRes.hasBrief);
        setDraft(draftRes.draft);
        // Сохранённый черновик ИИ подставляем, только если руками ничего не набрано.
        if (draftRes.draft && !readSaved(recipientId).trim()) setText(draftRes.draft.text);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось открыть переписку');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadThread, recipientId]);

  useEffect(() => {
    writeSaved(recipientId, text);
  }, [recipientId, text]);

  // Переписка открывается на начале последнего письма, как в Instantly: к низу
  // длинного письма (часто с цитатой всей прежней переписки) листать незачем.
  useEffect(() => {
    const box = threadRef.current;
    const last = lastItemRef.current;
    if (loading || !box || !last) return;
    box.scrollTop = Math.max(0, last.offsetTop - 16);
  }, [loading, items.length]);

  const pending = items.some((item) => item.direction === 'out' && item.note && PENDING_NOTES.has(item.note));
  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => void loadThread().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [pending, loadThread]);

  const hasIncoming = items.some((item) => item.direction === 'in');

  const generate = async () => {
    const manual = text.trim() && text.trim() !== draft?.text.trim();
    if (manual && !window.confirm('В поле ваш текст — заменить его ответом ИИ?')) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await generateReplyDraft(recipientId, language);
      setDraft(res.draft);
      setText(res.draft.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сгенерировать ответ');
    } finally {
      setGenerating(false);
    }
  };

  const changeLanguage = (next: ReplyLanguage) => {
    setLanguage(next);
    void saveReplyLanguage(recipientId, next).catch(() => undefined);
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await replyToThread(recipientId, body, draft && body ? draft.id : null);
      setConfirming(false);
      setText('');
      setDraft(null);
      await loadThread();
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить ответ');
    } finally {
      setSending(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* буфер обмена недоступен */
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка переписки…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-200 px-5 py-3">
        <div className="truncate text-base font-semibold text-zinc-900">{header?.title ?? 'Переписка'}</div>
        <div className="truncate text-xs text-zinc-500">
          {header?.subtitle}
          {header?.mailbox ? ` · пишем с ${header.mailbox}` : ''}
        </div>
      </div>

      <div ref={threadRef} className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <LeadVerdictBar recipientId={recipientId} onChange={onVerdictChange} />
        {items.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">Писем в этой переписке пока нет.</p>
        ) : (
          <div className="space-y-3">
            {items.map((item, idx) => {
              const outgoing = item.direction === 'out';
              return (
                <div
                  key={item.id}
                  ref={idx === items.length - 1 ? lastItemRef : undefined}
                  className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[85%] rounded-xl border p-3 ${outgoing ? 'border-blue-100 bg-blue-50' : 'border-zinc-200 bg-white'}`}>
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="font-medium text-zinc-700">{outgoing ? 'Мы' : item.fromEmail || 'Адресат'}</span>
                      <span>{formatAt(item.at)}</span>
                      {item.note ? <span className="rounded-md bg-zinc-100 px-1.5 py-0.5">{item.note}</span> : null}
                    </div>
                    {item.subject ? <p className="text-sm font-medium text-zinc-900">{item.subject}</p> : null}
                    {/* Тело письма — текст как есть: HTML чужого письма в портале не исполняем. */}
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700">{item.body || '—'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-200 px-5 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating || !hasIncoming}
            title={hasIncoming ? undefined : 'Отвечать пока не на что: адресат ещё не ответил'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? 'Генерирую…' : draft ? 'Сгенерировать заново' : 'Сгенерировать ответ'}
          </button>
          <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
            {(['ru', 'en'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => changeLanguage(lang)}
                disabled={generating}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  language === lang ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {lang === 'ru' ? 'Рус' : 'Англ'}
              </button>
            ))}
          </div>
          <span className="text-xs text-zinc-500">
            {generating
              ? 'ИИ читает переписку и сайт компании — до пары минут'
              : hasBrief
                ? 'В поле — черновик ИИ, его можно править'
                : 'У кампании нет брифа — ИИ опирается на нашу цепочку писем (шестерёнка у кампании слева)'}
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder="Ответ адресату — сгенерируйте ИИ или напишите сами"
          disabled={generating || sending}
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 disabled:bg-zinc-50"
        />
        {draft?.factsUsed ? <p className="mt-1 truncate text-xs text-zinc-500" title={draft.factsUsed}>Факты: {draft.factsUsed}</p> : null}

        {confirming ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            <span>
              Уйдёт с {header?.mailbox ?? 'ящика переписки'} на {header?.email} в эту же переписку — в течение минуты.
            </span>
            <span className="flex gap-2">
              <button type="button" onClick={() => setConfirming(false)} disabled={sending} className="rounded-md px-2.5 py-1 text-blue-700 hover:bg-blue-100">
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Отправить
              </button>
            </span>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-3">
            {error ? <span className="text-sm text-red-600">{error}</span> : <span />}
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => void copy()}
                disabled={!text.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                <Copy className="h-4 w-4" />
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!text.trim() || generating || sending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                Отправить ответ
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
