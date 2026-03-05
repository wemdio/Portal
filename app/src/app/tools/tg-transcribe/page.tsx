'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Video,
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  Download,
  ChevronDown,
  ChevronUp,
  Users,
  Clock,
  FileText,
  Search,
  RefreshCw,
} from 'lucide-react';

interface TranscriptItem {
  id: string;
  created_at: string;
  tg_chat_id: number;
  tg_message_id: number;
  tg_sender_id: number;
  sender_name: string;
  filename: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  text: string;
  length: number;
  status: string;
  error_text: string | null;
}

interface BotChat {
  chatId: number;
  title: string;
  chatType: string;
  lastMessageId: number | null;
}

async function getToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

function formatBytes(bytes: number | null) {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  if (bytes === 0) return '0 Б';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TgTranscribePage() {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [senders, setSenders] = useState<string[]>([]);
  const [activeSender, setActiveSender] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [botChats, setBotChats] = useState<BotChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [videoCount, setVideoCount] = useState('5');
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{
    scanned: number;
    videosFound: number;
    videoCount: number;
    completed: number;
    errors: number;
    lastSender?: string;
  } | null>(null);
  const [scanResult, setScanResult] = useState<{
    completed: number;
    errors: number;
    videosFound: number;
    scanned: number;
  } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const [showAddChat, setShowAddChat] = useState(false);
  const [addChatId, setAddChatId] = useState('');
  const [addChatTitle, setAddChatTitle] = useState('');

  const fetchChats = useCallback(async () => {
    setChatsLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch('/api/tools/tg-transcribe/chats', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { chats: BotChat[] };
      setBotChats(json.chats ?? []);
      if (json.chats?.length && !selectedChatId) {
        setSelectedChatId(json.chats[0].chatId);
      }
    } catch {
      /* ignore */
    } finally {
      setChatsLoading(false);
    }
  }, [selectedChatId]);

  const onAddChat = async () => {
    const id = parseInt(addChatId, 10);
    if (!id) return;
    try {
      const token = await getToken();
      const res = await fetch('/api/tools/tg-transcribe/chats/add', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: id, title: addChatTitle || undefined }),
      });
      if (res.ok) {
        setAddChatId('');
        setAddChatTitle('');
        setShowAddChat(false);
        void fetchChats();
      } else {
        const json = await res.json().catch(() => ({})) as { error?: string };
        setScanError(json.error ?? 'Не удалось добавить группу');
      }
    } catch {
      setScanError('Ошибка при добавлении группы');
    }
  };

  const onScan = async () => {
    if (!selectedChatId) {
      setScanError('Выберите группу');
      return;
    }
    const count = parseInt(videoCount, 10);
    if (!count || count < 1) {
      setScanError('Укажите количество видео');
      return;
    }

    setScanError(null);
    setScanResult(null);
    setScanProgress(null);
    setScanning(true);
    scanAbort.current = new AbortController();

    try {
      const token = await getToken();
      const res = await fetch('/api/tools/tg-transcribe/scan', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chatId: selectedChatId, videoCount: count }),
        signal: scanAbort.current.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let msg = 'Ошибка сканирования';
        try { msg = JSON.parse(text).error ?? msg; } catch { /* use default */ }
        setScanError(msg);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setScanError('Нет потока данных');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'progress') {
              setScanProgress({
                scanned: obj.scanned,
                videosFound: obj.videosFound,
                videoCount: obj.videoCount,
                completed: obj.completed,
                errors: obj.errors,
                lastSender: obj.lastSender,
              });
            } else if (obj.type === 'done') {
              setScanResult({
                completed: obj.completed,
                errors: obj.errors,
                videosFound: obj.videosFound,
                scanned: obj.scanned,
              });
              void fetchItems(activeSender, offset);
              void fetchSenders();
            }
          } catch {
            /* skip malformed line */
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setScanError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  };

  const limit = 50;

  const fetchSenders = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch('/api/tools/tg-transcribe/senders', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { senders: string[] };
      setSenders(json.senders ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchItems = useCallback(
    async (sender: string | null, pageOffset: number) => {
      setLoading(true);
      try {
        const token = await getToken();
        if (!token) {
          setItems([]);
          return;
        }
        const params = new URLSearchParams({ limit: String(limit), offset: String(pageOffset) });
        if (sender) params.set('sender', sender);

        const res = await fetch(`/api/tools/tg-transcribe?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setItems([]);
          return;
        }
        const json = (await res.json()) as { items: TranscriptItem[]; total: number };
        setItems(json.items ?? []);
        setTotal(json.total ?? 0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [limit],
  );

  useEffect(() => {
    void fetchSenders();
    void fetchChats();
  }, [fetchSenders, fetchChats]);

  useEffect(() => {
    void fetchItems(activeSender, offset);
  }, [activeSender, offset, fetchItems]);

  const handleSenderChange = (sender: string | null) => {
    setActiveSender(sender);
    setOffset(0);
    setExpandedId(null);
  };

  const onCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* ignore */
    }
  };

  const onDownloadTxt = (text: string, filename: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.replace(/\.[^.]+$/, '') + '_transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="flex gap-6 text-left max-w-full">
      <div className="min-w-0 flex-1 max-w-7xl space-y-6">
        {/* Header */}
        <header className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
            <Video className="h-3.5 w-3.5" />
            Транскрибации из Telegram
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Транскрибации из ТГ</h1>
          <p className="max-w-2xl text-sm text-gray-500">
            Автоматическая расшифровка видео из Telegram-группы. Видео обрабатываются ботом
            и сохраняются с привязкой к отправителю.
          </p>
        </header>

        {/* Scan section */}
        <details className="rounded-xl border border-gray-200 bg-white/90 shadow-sm" open>
          <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900 select-none">
            <Search className="h-4 w-4 text-indigo-500" />
            Сканировать видео из группы
          </summary>
          <div className="border-t border-gray-100 px-4 py-3 space-y-3">
            <p className="text-xs text-gray-500">
              Выберите группу и укажите сколько последних видео нужно найти и транскрибировать.
              Бот сам пройдётся по сообщениям от новых к старым.
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <label className="space-y-1 min-w-[200px] flex-1 max-w-xs">
                <span className="text-[11px] font-medium text-gray-500">Группа</span>
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedChatId ?? ''}
                    onChange={(e) => setSelectedChatId(e.target.value ? Number(e.target.value) : null)}
                    disabled={chatsLoading}
                    className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                  >
                    {botChats.length === 0 && (
                      <option value="">{chatsLoading ? 'Загрузка...' : 'Нет групп — добавьте бота в группу'}</option>
                    )}
                    {botChats.map((c) => (
                      <option key={c.chatId} value={c.chatId}>
                        {c.title || `Chat ${c.chatId}`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void fetchChats()}
                    disabled={chatsLoading}
                    className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-1.5 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 transition"
                    title="Обновить список групп"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${chatsLoading ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAddChat(!showAddChat)}
                    className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-[10px] font-medium text-gray-500 hover:text-indigo-600 hover:border-indigo-300 transition"
                  >
                    + Добавить
                  </button>
                </div>
                {showAddChat && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <input
                      type="text"
                      value={addChatId}
                      onChange={(e) => setAddChatId(e.target.value)}
                      placeholder="-1001234567890"
                      className="block w-40 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                    />
                    <input
                      type="text"
                      value={addChatTitle}
                      onChange={(e) => setAddChatTitle(e.target.value)}
                      placeholder="Название (необяз.)"
                      className="block w-36 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void onAddChat()}
                      className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 transition"
                    >
                      OK
                    </button>
                  </div>
                )}
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-medium text-gray-500">Кол-во видео</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={videoCount}
                  onChange={(e) => setVideoCount(e.target.value)}
                  className="block w-24 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                />
              </label>
              <button
                type="button"
                onClick={onScan}
                disabled={scanning || !selectedChatId}
                className={[
                  'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-sm transition',
                  scanning || !selectedChatId
                    ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                    : 'bg-indigo-600 text-white hover:bg-indigo-700',
                ].join(' ')}
              >
                {scanning ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Сканирование...
                  </>
                ) : (
                  <>
                    <Search className="h-3.5 w-3.5" />
                    Сканировать
                  </>
                )}
              </button>
            </div>

            {scanError && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{scanError}</p>
              </div>
            )}

            {scanning && scanProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span>
                    Найдено видео: {scanProgress.videosFound} из {scanProgress.videoCount}
                    {scanProgress.lastSender && (
                      <span className="text-gray-400"> — {scanProgress.lastSender}</span>
                    )}
                  </span>
                  <span className="text-gray-400">
                    проверено {scanProgress.scanned} сообщ.
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                    style={{ width: `${Math.round((scanProgress.videosFound / scanProgress.videoCount) * 100)}%` }}
                  />
                </div>
                <div className="flex gap-3 text-[10px] text-gray-400">
                  <span className="text-emerald-600">{scanProgress.completed} транскрибировано</span>
                  {scanProgress.errors > 0 && (
                    <span className="text-rose-500">{scanProgress.errors} ошибок</span>
                  )}
                </div>
              </div>
            )}

            {scanResult && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                Готово: <strong>{scanResult.completed}</strong> транскрибировано
                {scanResult.errors > 0 && (
                  <>, <strong className="text-rose-600">{scanResult.errors}</strong> ошибок</>
                )}
                . Найдено {scanResult.videosFound} видео среди {scanResult.scanned} сообщений.
              </div>
            )}
          </div>
        </details>

        {/* Sender filter tabs */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mr-1">
            <Users className="h-3.5 w-3.5" />
            Автор:
          </div>
          <button
            type="button"
            onClick={() => handleSenderChange(null)}
            className={[
              'rounded-full px-3 py-1 text-xs font-medium transition border',
              activeSender === null
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50',
            ].join(' ')}
          >
            Все
          </button>
          {senders.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSenderChange(s)}
              className={[
                'rounded-full px-3 py-1 text-xs font-medium transition border',
                activeSender === s
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50',
              ].join(' ')}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span>
            Всего записей:{' '}
            <span className="font-medium text-gray-700">{total}</span>
          </span>
          {totalPages > 1 && (
            <span>
              Страница {currentPage} из {totalPages}
            </span>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Загрузка...
          </div>
        )}

        {/* Empty state */}
        {!loading && items.length === 0 && (
          <div className="rounded-2xl border border-gray-200 bg-white/90 p-8 text-center">
            <Video className="mx-auto h-10 w-10 text-gray-300 mb-3" />
            <p className="text-sm text-gray-500">
              {activeSender
                ? `Нет транскрибаций от ${activeSender}.`
                : 'Пока нет транскрибаций. Добавьте бота в ТГ-группу и отправьте видео.'}
            </p>
          </div>
        )}

        {/* Transcript list */}
        {!loading && items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => {
              const isExpanded = expandedId === item.id;
              const isError = item.status === 'error';

              return (
                <div
                  key={item.id}
                  className={[
                    'rounded-xl border bg-white/90 shadow-sm transition-all',
                    isError ? 'border-rose-200' : 'border-gray-200',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50/50 transition-colors rounded-xl"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {item.sender_name}
                        </span>
                        <span className="text-[10px] text-gray-400 shrink-0">
                          {item.filename}
                        </span>
                        {isError && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-600 border border-rose-200">
                            <AlertTriangle className="h-3 w-3" />
                            Ошибка
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[11px] text-gray-400">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDate(item.created_at)}
                        </span>
                        {item.duration_seconds != null && (
                          <span>{formatDuration(item.duration_seconds)}</span>
                        )}
                        {item.file_size_bytes != null && (
                          <span>{formatBytes(item.file_size_bytes)}</span>
                        )}
                        {item.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            {item.length.toLocaleString('ru-RU')} симв.
                          </span>
                        )}
                      </div>
                      {!isExpanded && item.text && (
                        <p className="mt-1 line-clamp-1 text-xs text-gray-500">{item.text}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-gray-400">
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-100 px-4 py-3 space-y-3">
                      {isError && item.error_text && (
                        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p>{item.error_text}</p>
                        </div>
                      )}

                      {item.text && (
                        <>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onCopy(item.text, item.id);
                              }}
                              className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition"
                            >
                              {copiedId === item.id ? (
                                <>
                                  <Check className="h-3.5 w-3.5" />
                                  Скопировано
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  Копировать
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDownloadTxt(item.text, item.filename);
                              }}
                              className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition"
                            >
                              <Download className="h-3.5 w-3.5" />
                              TXT
                            </button>
                          </div>
                          <div className="max-h-96 overflow-auto rounded-xl bg-gray-50 px-3 py-2">
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gray-800">
                              {item.text}
                            </pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-2 pb-4">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              className={[
                'rounded-full px-3 py-1.5 text-xs font-medium border transition',
                currentPage <= 1
                  ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50',
              ].join(' ')}
            >
              Назад
            </button>
            <span className="text-xs text-gray-500">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setOffset(offset + limit)}
              className={[
                'rounded-full px-3 py-1.5 text-xs font-medium border transition',
                currentPage >= totalPages
                  ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50',
              ].join(' ')}
            >
              Вперёд
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
