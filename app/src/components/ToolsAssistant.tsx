'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Sparkles, X, Send, Loader2 } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const GREETING: ChatMessage = {
  role: 'assistant',
  content:
    'Привет! Я помогу разобраться в инструментах портала. Спросите, где найти нужный раздел или как им пользоваться.',
};

/** Где храним историю чата между перезагрузками. localStorage, чтобы не
 *  тащить серверное хранилище — диалог с помощником короткий и приватный
 *  для устройства. */
const STORAGE_KEY = 'portal-ai-chat-history-v1';
/** Сколько последних сообщений (без GREETING) восстанавливаем при заходе. */
const MAX_STORED = 20;

function loadHistory(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          !!m && typeof m === 'object'
          && (m.role === 'user' || m.role === 'assistant')
          && typeof m.content === 'string',
      )
      .slice(-MAX_STORED);
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]): void {
  if (typeof window === 'undefined') return;
  // GREETING — это статическая обертка из бандла, в хранилище его не пишем,
  // иначе при апгрейде текста приветствия пользователи увидят старый вариант.
  const realMessages = messages.filter((m) => m !== GREETING).slice(-MAX_STORED);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(realMessages));
  } catch {
    // Тихо игнорируем переполнение квоты — потеря истории не критична.
  }
}

const URL_REGEX = /(https?:\/\/[^\s)]+)/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;

/** Превращает голые URL в кликабельные ссылки прямо внутри bubble.
 *  Модель в промпте просили писать ссылки plain-текстом — здесь их оборачиваем.
 *  Конечную пунктуацию отрезаем от URL обратно в текст, иначе точка/запятая
 *  из конца предложения попадает в href и ссылка ведёт на 404. */
function renderWithLinks(text: string): ReactNode {
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const trailing = part.match(TRAILING_PUNCT)?.[0] ?? '';
      const url = trailing ? part.slice(0, -trailing.length) : part;
      return (
        <span key={i}>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:opacity-80"
          >
            {url}
          </a>
          {trailing}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function ToolsAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Восстанавливаем историю из localStorage один раз, после mount, чтобы
  // SSR-разметка совпала с первым клиентским рендером (GREETING-only).
  useEffect(() => {
    const stored = loadHistory();
    if (stored.length > 0) {
      setMessages([GREETING, ...stored]);
    }
    hydratedRef.current = true;
  }, []);

  // Пишем в storage после каждой правки messages, но только когда
  // гидратация уже прошла — иначе перезатрём сохранённое стартовым
  // [GREETING] и история обнулится при заходе.
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveHistory(messages);
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [open, messages, loading]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);

    const nextHistory: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);

    try {
      const res = await authFetch('/api/tools-assistant/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: nextHistory.filter((m) => m.role !== 'assistant' || m !== GREETING),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Ошибка запроса' }));
        throw new Error(data.error || `Ошибка ${res.status}`);
      }
      const data = (await res.json()) as { reply: string };
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось получить ответ');
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 inline-flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/30 transition hover:bg-blue-700 hover:shadow-xl"
          title="Portal AI"
          aria-label="Открыть Portal AI"
        >
          <Sparkles className="h-5 w-5" aria-hidden />
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-50 flex h-[560px] max-h-[calc(100vh-2.5rem)] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                <Sparkles className="h-4 w-4" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-900">Portal AI</p>
                <p className="text-[11px] text-zinc-500">Подскажет, где что лежит и как пользоваться</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
          >
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed break-words ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-100 text-zinc-800'
                  }`}
                >
                  {renderWithLinks(m.content)}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-2xl bg-zinc-100 px-3 py-2 text-sm text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Думаю…
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-zinc-200 px-3 py-2">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                placeholder="Например: где найти расшифровку видео?"
                className="flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={loading || !input.trim()}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
                aria-label="Отправить"
                title="Отправить (Enter)"
              >
                <Send className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <p className="mt-1 text-[10px] text-zinc-400">
              Enter — отправить, Shift+Enter — перенос строки
            </p>
          </div>
        </div>
      )}
    </>
  );
}
