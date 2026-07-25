'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { authFetch } from '@/lib/authFetch';
import ActiveJobsPanel from './ActiveJobsPanel';
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
  Trash2,
  Square,
  X,
  ArrowUpDown,
  MessageSquare,
} from 'lucide-react';

interface TranscriptItem {
  id: string;
  created_at: string;
  tg_message_date: string | null;
  tg_chat_id: number;
  tg_message_id: number;
  topic_id: number | null;
  tg_sender_id: number;
  sender_name: string;
  caption: string | null;
  filename: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  text: string;
  length: number;
  status: string;
  error_text: string | null;
  hasFullText?: boolean;
}

interface TranscribedChat {
  chatId: number;
  topicId: number;
  displayName: string;
  count: number;
}

interface BotChat {
  chatId: number;
  title: string;
  chatType: string;
  lastMessageId: number | null;
  isForum?: boolean;
  topicId?: number | null;
  topicName?: string | null;
}

interface ScanVideoInfo {
  idx: number;
  sender: string;
  filename: string;
  fileSize: number | null;
  duration: number | null;
  messageDate?: number | null;
  phase: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  transcriptionJobId?: string;
}

interface TranscriptionProgress {
  found: boolean;
  stage?: string;
  progressPercent?: number;
  processedSeconds?: number | null;
  audioDurationSeconds?: number | null;
}

interface ScanJob {
  id: string;
  status: string;
  tg_chat_id: number;
  topic_id: number | null;
  video_count: number;
  scan_mode?: 'limited' | 'full';
  scanned: number;
  videos_found: number;
  completed: number;
  errors: number;
  videos: ScanVideoInfo[];
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  isOwner?: boolean;
}

interface QueueEntry {
  id: string;
  tg_chat_id: number;
  topic_id: number | null;
  scan_mode: 'limited' | 'full';
  status: 'pending' | 'running';
  isOwner: boolean;
  started_at: string | null;
  created_at: string;
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
  // Telegram returns duration as a float (e.g. 878.333…). The old version
  // did `seconds % 60` which preserved the fractional part, then
  // `.toString().padStart(2, '0')` did nothing to round it — the user saw
  // "14:38.33299999999997". Floor everything to whole seconds and add an
  // H:MM:SS branch for videos longer than an hour.
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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

function pluralizeRu(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function phaseLabel(phase: string): { text: string; color: string } {
  switch (phase) {
    case 'found':
      return { text: 'Ожидание…', color: 'text-gray-400' };
    case 'downloading':
      return { text: 'Скачивание', color: 'text-blue-600' };
    case 'converting':
      return { text: 'Извлечение аудио', color: 'text-amber-600' };
    case 'transcribing':
      return { text: 'Транскрибация', color: 'text-violet-600' };
    case 'done':
      return { text: 'Готово', color: 'text-emerald-600' };
    case 'error':
      return { text: 'Ошибка', color: 'text-rose-600' };
    default:
      return { text: phase, color: 'text-gray-500' };
  }
}

function formatMmSs(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ScanVideoRow({ video }: { video: ScanVideoInfo }) {
  const { text: statusText, color: statusColor } = phaseLabel(video.phase);
  const isDownloading = video.phase === 'downloading';
  const isTranscribing = video.phase === 'transcribing';
  const dlPercent =
    isDownloading && video.totalBytes && video.totalBytes > 0
      ? Math.round(((video.downloadedBytes ?? 0) / video.totalBytes) * 100)
      : null;

  const isActive = ['downloading', 'converting', 'transcribing'].includes(video.phase);

  const [txProgress, setTxProgress] = useState<TranscriptionProgress | null>(null);
  const txPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isTranscribing || !video.transcriptionJobId) return;

    const poll = async () => {
      try {
        const res = await authFetch(
          `/api/tools/audio-transcribe/progress?jobId=${encodeURIComponent(video.transcriptionJobId!)}`,
        );
        if (res.ok) {
          const data = (await res.json()) as TranscriptionProgress;
          if (data.found) {
            setTxProgress(data);
          }
        }
      } catch { /* ignore */ }
    };

    void poll();
    txPollRef.current = setInterval(poll, 4000);
    return () => {
      if (txPollRef.current) {
        clearInterval(txPollRef.current);
        txPollRef.current = null;
      }
      setTxProgress(null);
    };
  }, [isTranscribing, video.transcriptionJobId]);

  const txLabel = (() => {
    if (!isTranscribing || !txProgress) return null;
    const { processedSeconds, audioDurationSeconds, progressPercent } = txProgress;
    if (processedSeconds != null && audioDurationSeconds != null && audioDurationSeconds > 0) {
      return `${formatMmSs(processedSeconds)} / ${formatMmSs(audioDurationSeconds)}`;
    }
    if (progressPercent != null && progressPercent > 0) {
      return `${Math.round(progressPercent)}%`;
    }
    return null;
  })();

  const txPercent =
    txProgress?.processedSeconds != null && txProgress?.audioDurationSeconds != null && txProgress.audioDurationSeconds > 0
      ? Math.round((txProgress.processedSeconds / txProgress.audioDurationSeconds) * 100)
      : txProgress?.progressPercent ?? null;

  return (
    <div
      className={[
        'rounded-lg border px-3 py-2 text-xs transition-all',
        video.phase === 'error'
          ? 'border-rose-200 bg-rose-50/50'
          : video.phase === 'done'
            ? 'border-emerald-200 bg-emerald-50/50'
            : 'border-gray-150 bg-gray-50/50',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isActive && <Loader2 className="h-3 w-3 animate-spin text-indigo-500 shrink-0" />}
          {video.phase === 'done' && <Check className="h-3 w-3 text-emerald-500 shrink-0" />}
          {video.phase === 'error' && <AlertTriangle className="h-3 w-3 text-rose-500 shrink-0" />}
          <span className="font-medium text-gray-800 truncate">{video.sender}</span>
          <span className="text-gray-400 truncate">{video.filename}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {video.messageDate != null && (
            <span className="text-gray-400">
              {new Date(video.messageDate * 1000).toLocaleString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
          {video.fileSize != null && (
            <span className="text-gray-400">{formatBytes(video.fileSize)}</span>
          )}
          {video.duration != null && (
            <span className="text-gray-400">{formatDuration(video.duration)}</span>
          )}
          <span className={`font-medium ${statusColor}`}>
            {statusText}
            {dlPercent != null && ` ${dlPercent}%`}
            {txLabel != null && ` ${txLabel}`}
          </span>
        </div>
      </div>
      {isDownloading && (
        <div className="mt-1.5 h-1 w-full rounded-full bg-gray-200 overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-500"
            style={{ width: dlPercent != null ? `${dlPercent}%` : '0%' }}
          />
        </div>
      )}
      {isTranscribing && txPercent != null && txPercent > 0 && (
        <div className="mt-1.5 h-1 w-full rounded-full bg-gray-200 overflow-hidden">
          <div
            className="h-full rounded-full bg-violet-500 transition-all duration-500"
            style={{ width: `${Math.min(txPercent, 100)}%` }}
          />
        </div>
      )}
      {video.phase === 'error' && video.error && (
        <p className="mt-1 text-[10px] text-rose-500 truncate">{video.error}</p>
      )}
    </div>
  );
}

// Multi-select dropdown with checkbox rows. Button shows a compact summary
// ("Все" / "N выбрано" / имя выбранного) and opens a searchable checklist.
// Empty set = "все" (no filter).
function MultiSelectDropdown({
  label,
  icon,
  options,
  selected,
  onChange,
  emptyLabel,
  width = 'w-72',
}: {
  label: string;
  icon: React.ReactNode;
  options: { value: string; label: string; count?: number }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyLabel: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options;

  const toggleOne = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  };

  const summary =
    selected.size === 0
      ? emptyLabel
      : selected.size === 1
        ? options.find((o) => o.value === Array.from(selected)[0])?.label ??
          `${selected.size} выбрано`
        : `${selected.size} выбрано`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition border max-w-xs',
          selected.size > 0
            ? 'bg-indigo-50 text-indigo-700 border-indigo-300 hover:bg-indigo-100'
            : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50',
        ].join(' ')}
      >
        {icon}
        <span className="truncate">
          {label}: <span className="font-semibold">{summary}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          className={`absolute z-40 mt-1 ${width} rounded-xl border border-gray-200 bg-white shadow-lg p-2`}
        >
          <div className="flex items-center gap-2 px-1 pb-2 border-b border-gray-100 mb-1">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Найти…"
                className="w-full rounded-md border border-gray-200 pl-6 pr-2 py-1 text-xs outline-none focus:border-indigo-400"
              />
            </div>
            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="text-[11px] text-gray-500 hover:text-gray-800 shrink-0"
              >
                Сброс
              </button>
            )}
          </div>
          <ul className="max-h-64 overflow-auto space-y-0.5">
            {filtered.length === 0 && (
              <li className="text-[11px] text-gray-400 text-center py-2">
                Ничего не найдено
              </li>
            )}
            {filtered.map((o) => {
              const checked = selected.has(o.value);
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => toggleOne(o.value)}
                    className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs hover:bg-indigo-50 transition cursor-pointer"
                  >
                    <span
                      className={[
                        'h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center transition',
                        checked
                          ? 'bg-indigo-600 border-indigo-600'
                          : 'bg-white border-gray-300',
                      ].join(' ')}
                    >
                      {checked && <Check className="h-2.5 w-2.5 text-white" />}
                    </span>
                    <span className="flex-1 truncate text-gray-700">{o.label}</span>
                    {o.count != null && (
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {o.count.toLocaleString('ru-RU')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function StopConfirmDialog({
  open,
  onConfirm,
  onCancel,
  stopping,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  stopping: boolean;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <button
          type="button"
          onClick={onCancel}
          disabled={stopping}
          className="absolute right-3 top-3 rounded-lg p-1 text-gray-400 hover:text-gray-600 transition"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-amber-100 p-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Остановить транскрибацию?</h3>
            <p className="text-xs text-gray-500 leading-relaxed">
              Транскрибация будет остановлена. Возобновить с того же места будет <strong>невозможно</strong> — 
              только запустить заново. Уже обработанные видео сохранятся.
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={stopping}
            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={stopping}
            className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 transition disabled:opacity-60"
          >
            {stopping ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Останавливаем…
              </>
            ) : (
              <>
                <Square className="h-3 w-3" />
                Остановить
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TgTranscribePage() {
  const [allItems, setAllItems] = useState<TranscriptItem[]>([]);
  // Multi-select filters. Empty set = «все» (не фильтруем). Key for chat is
  // `${chatId}:${topicId ?? 0}` — совпадает с ключом в transcribedChats.
  const [selectedChatKeys, setSelectedChatKeys] = useState<Set<string>>(new Set());
  const [selectedSenders, setSelectedSenders] = useState<Set<string>>(new Set());
  const [transcribedChats, setTranscribedChats] = useState<TranscribedChat[]>([]);
  const [sortOrder, setSortOrder] = useState<'created_at' | 'message_date'>('created_at');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fullTextCache = useRef<Record<string, string>>({});
  const [loadingTextId, setLoadingTextId] = useState<string | null>(null);

  const [botChats, setBotChats] = useState<BotChat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [selectedChatTopicId, setSelectedChatTopicId] = useState<number | null>(null);
  const [isForum, setIsForum] = useState(false);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [fetchedTopics, setFetchedTopics] = useState<{ topicId: number; name: string }[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  const [manualTopicId, setManualTopicId] = useState('');
  const [topicNameInput, setTopicNameInput] = useState('');

  const [activeJob, setActiveJob] = useState<ScanJob | null>(null);
  const [scanResult, setScanResult] = useState<ScanJob | null>(null);
  const [scanQueue, setScanQueue] = useState<QueueEntry[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showStopDialog, setShowStopDialog] = useState(false);
  const [stopping, setStopping] = useState(false);

  const [showAddChat, setShowAddChat] = useState(false);
  const [addChatId, setAddChatId] = useState('');
  const [addChatTitle, setAddChatTitle] = useState('');

  const [showManageChats, setShowManageChats] = useState(false);
  const [chatToDelete, setChatToDelete] = useState<
    { chatId: number; topicId: number | null; label: string } | null
  >(null);
  const [deletingChat, setDeletingChat] = useState(false);

  const isJobActive = activeJob && ['pending', 'running'].includes(activeJob.status);
  const isJobOwner = activeJob?.isOwner !== false;
  const isFullScan = activeJob?.scan_mode === 'full';

  // Resolve a friendly "<group title> / <topic name>" label for a (chatId, topicId)
  // pair from the registered chats list. Falls back to the bare chat_id when the
  // chat isn't in the local list (e.g. it was removed after the job started, or
  // a different user registered it under a different name).
  const chatLabel = useCallback(
    (chatId: number, topicId: number | null): string => {
      const match = botChats.find(
        (c) => c.chatId === chatId && (c.topicId ?? null) === (topicId ?? null),
      );
      if (match) {
        const base = match.title || `Chat ${chatId}`;
        return match.topicName ? `${base} / ${match.topicName}` : base;
      }
      // No registered (chat, topic) row — fall back to any row matching this chat,
      // appending the topic id raw so the user at least knows which topic it is.
      const chatOnly = botChats.find((c) => c.chatId === chatId);
      if (chatOnly) {
        const base = chatOnly.title || `Chat ${chatId}`;
        return topicId != null ? `${base} / topic ${topicId}` : base;
      }
      return topicId != null ? `Chat ${chatId} / topic ${topicId}` : `Chat ${chatId}`;
    },
    [botChats],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchJobStatus = useCallback(async (): Promise<{ job: ScanJob | null; queue: QueueEntry[] }> => {
    try {
      const res = await authFetch('/api/tools/tg-transcribe/scan');
      if (!res.ok) return { job: null, queue: [] };
      const json = (await res.json()) as { job: ScanJob | null; queue?: QueueEntry[] };
      return { job: json.job, queue: json.queue ?? [] };
    } catch {
      return { job: null, queue: [] };
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const { job, queue } = await fetchJobStatus();
      setScanQueue(queue);
      if (!job) return;

      if (['pending', 'running'].includes(job.status)) {
        setActiveJob(job);
      } else {
        setActiveJob(null);
        // Keep polling while OTHER scans are still running on the system, so the
        // queue indicator stays fresh. Stop only when nothing is active anywhere.
        if (queue.length === 0) {
          stopPolling();
        }

        if (job.status === 'completed') {
          setScanResult(job);
        } else if (job.status === 'stopped') {
          setScanResult(job);
        } else if (job.status === 'failed') {
          setScanError(job.error_message ?? 'Ошибка сканирования');
          setScanResult(job);
        }
      }
    }, 5000);
  }, [fetchJobStatus, stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // On mount: check for active/recent job
  const initialCheckDone = useRef(false);
  useEffect(() => {
    if (initialCheckDone.current) return;
    initialCheckDone.current = true;

    (async () => {
      const { job, queue } = await fetchJobStatus();
      setScanQueue(queue);
      if (!job) {
        // No primary job for this user, but other scans might be running — keep
        // polling so the queue indicator updates.
        if (queue.length > 0) startPolling();
        return;
      }

      if (['pending', 'running'].includes(job.status)) {
        setActiveJob(job);
        startPolling();
      } else if (['completed', 'failed', 'stopped'].includes(job.status)) {
        setScanResult(job);
        if (job.status === 'failed') {
          setScanError(job.error_message ?? 'Ошибка сканирования');
        }
        if (queue.length > 0) startPolling();
      }
    })();
  }, [fetchJobStatus, startPolling]);

  const fetchChats = useCallback(async () => {
    setChatsLoading(true);
    try {
      const res = await authFetch('/api/tools/tg-transcribe/chats');
      if (!res.ok) return;
      const json = (await res.json()) as { chats: BotChat[] };
      setBotChats(json.chats ?? []);
      if (json.chats?.length && !selectedChatId) {
        setSelectedChatId(json.chats[0].chatId);
        setSelectedChatTopicId(json.chats[0].topicId ?? null);
      }
    } catch {
      /* ignore */
    } finally {
      setChatsLoading(false);
    }
  }, [selectedChatId]);

  const fetchTopics = useCallback(async (chatId: number) => {
    setTopicsLoading(true);
    setIsForum(false);
    setFetchedTopics([]);
    setSelectedTopicId(null);
    setManualTopicId('');
    setTopicNameInput('');
    try {
      const res = await authFetch(`/api/tools/tg-transcribe/chats/topics?chatId=${chatId}`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        isForum: boolean;
        topics?: { topicId: number; name: string }[];
      };
      setIsForum(json.isForum);
      if (json.topics?.length) {
        setFetchedTopics(json.topics);
      }
    } catch {
      /* ignore */
    } finally {
      setTopicsLoading(false);
    }
  }, []);

  const [deleting, setDeleting] = useState(false);

  // Delete a (chat, topic) row from the registered list — by passing chatId without
  // topicId, the DELETE endpoint removes ALL topic rows for that chat. We always pass
  // the topicId we have (or omit when null = chat-wide row), so we never accidentally
  // wipe a chat-wide row by clicking delete on a per-topic row.
  const deleteChatRow = useCallback(
    async (chatId: number, topicId: number | null) => {
      const params = new URLSearchParams({ chatId: String(chatId) });
      if (topicId != null) params.set('topicId', String(topicId));
      const res = await authFetch(`/api/tools/tg-transcribe/chats?${params}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Не удалось удалить');
      }
      // If we just removed the chat currently selected in the dropdown, clear it
      // so the form stops referencing a row that no longer exists.
      if (
        selectedChatId === chatId &&
        (selectedChatTopicId ?? null) === (topicId ?? null)
      ) {
        setSelectedChatId(null);
        setSelectedChatTopicId(null);
      }
      await fetchChats();
    },
    [fetchChats, selectedChatId, selectedChatTopicId],
  );

  const onDeleteChat = async () => {
    if (!selectedChatId || deleting) return;
    const chat = botChats.find(
      (c) => c.chatId === selectedChatId && (c.topicId ?? null) === selectedChatTopicId,
    );
    if (!chat) return;
    setDeleting(true);
    try {
      await deleteChatRow(chat.chatId, chat.topicId ?? null);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Ошибка при удалении');
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeleteChatRow = async () => {
    if (!chatToDelete || deletingChat) return;
    setDeletingChat(true);
    try {
      await deleteChatRow(chatToDelete.chatId, chatToDelete.topicId);
      setChatToDelete(null);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Ошибка при удалении');
    } finally {
      setDeletingChat(false);
    }
  };

  const onAddChat = async () => {
    const id = parseInt(addChatId, 10);
    if (!id) return;
    try {
      const res = await authFetch('/api/tools/tg-transcribe/chats/add', {
        method: 'POST',
        body: JSON.stringify({
          chatId: id,
          title: addChatTitle || undefined,
          topicId: selectedTopicId ?? (manualTopicId ? parseInt(manualTopicId, 10) : undefined) ?? undefined,
          topicName: isForum
            ? ((fetchedTopics.find((t) => t.topicId === selectedTopicId)?.name ?? topicNameInput) || undefined)
            : undefined,
        }),
      });
      if (res.ok) {
        setAddChatId('');
        setAddChatTitle('');
        setManualTopicId('');
        setTopicNameInput('');
        setFetchedTopics([]);
        setSelectedTopicId(null);
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

  const [fullScanPending, setFullScanPending] = useState(false);

  // Full-chat scan: walk the entire history of the SELECTED chat (no message cap,
  // no video count cap) until it hits the beginning of the chat or the user stops
  // the job. Long-running by design — can take hours on busy chats. Behind a
  // confirmation dialog so it isn't triggered by mis-click.
  const onScanFullChat = async () => {
    if (!selectedChatId) {
      setScanError('Выберите группу');
      return;
    }
    if (fullScanPending) return;
    setScanError(null);
    setScanResult(null);
    setFullScanPending(true);
    try {
      const res = await authFetch('/api/tools/tg-transcribe/scan', {
        method: 'POST',
        body: JSON.stringify({
          chatId: selectedChatId,
          topicId: selectedChatTopicId,
          mode: 'full',
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = 'Ошибка запуска сканирования';
        try { msg = JSON.parse(text).error ?? msg; } catch { /* default */ }
        setScanError(msg);
        return;
      }
      const json = (await res.json()) as { job: ScanJob };
      setActiveJob(json.job);
      startPolling();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setFullScanPending(false);
    }
  };

  const onStopScan = async () => {
    if (!activeJob) return;
    setStopping(true);
    try {
      const res = await authFetch('/api/tools/tg-transcribe/scan', {
        method: 'PATCH',
        body: JSON.stringify({ jobId: activeJob.id }),
      });

      if (res.ok) {
        setShowStopDialog(false);
        // Polling will pick up the stopped status and clean up
      } else {
        const json = await res.json().catch(() => ({})) as { error?: string };
        setScanError(json.error ?? 'Не удалось остановить');
        setShowStopDialog(false);
      }
    } catch {
      setScanError('Ошибка при остановке');
      setShowStopDialog(false);
    } finally {
      setStopping(false);
    }
  };

  const PAGE_SIZE = 30;

  const fetchAllItems = useCallback(async (
    sort: 'created_at' | 'message_date' = 'created_at',
  ) => {
    setLoading(true);
    try {
      // limit=all: сервер возвращает превью всех completed транскриптов
      // (~0.5 KB на строку). Фильтр по чатам/авторам теперь multi-select и
      // применяется на клиенте, поэтому серверный chatId/topicId больше не нужен.
      const params = new URLSearchParams({ limit: 'all', sort });
      const res = await authFetch(`/api/tools/tg-transcribe?${params}`);
      if (!res.ok) { setAllItems([]); return; }
      const json = (await res.json()) as { items: TranscriptItem[] };
      setAllItems(json.items ?? []);
      fullTextCache.current = {};
    } catch {
      setAllItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTranscribedChats = useCallback(async () => {
    try {
      const res = await authFetch('/api/tools/tg-transcribe/transcribed-chats');
      if (!res.ok) return;
      const json = (await res.json()) as { chats: TranscribedChat[] };
      setTranscribedChats(json.chats ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  // Первый уровень фильтрации: только по выбранным чатам. Из этого множества
  // строится список авторов в дропдауне «Автор» — так пункты автоматически
  // сужаются под выбранные чаты.
  const chatFilteredItems = React.useMemo(() => {
    if (selectedChatKeys.size === 0) return allItems;
    return allItems.filter((i) =>
      selectedChatKeys.has(`${i.tg_chat_id}:${i.topic_id ?? 0}`),
    );
  }, [allItems, selectedChatKeys]);

  const senders = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of chatFilteredItems) {
      if (!item.sender_name) continue;
      counts.set(item.sender_name, (counts.get(item.sender_name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [chatFilteredItems]);

  const filteredItems = React.useMemo(() => {
    let result = chatFilteredItems;
    if (selectedSenders.size > 0) {
      result = result.filter((i) => selectedSenders.has(i.sender_name));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((i) =>
        (i.caption ?? '').toLowerCase().includes(q) ||
        i.sender_name.toLowerCase().includes(q) ||
        i.filename.toLowerCase().includes(q),
      );
    }
    return result;
  }, [chatFilteredItems, selectedSenders, searchQuery]);

  const total = filteredItems.length;
  const items = React.useMemo(
    () => filteredItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filteredItems, page],
  );

  useEffect(() => {
    void fetchAllItems(sortOrder);
  }, [fetchAllItems, sortOrder]);

  // Reset pagination и раскрытую карточку при смене любого фильтра.
  useEffect(() => {
    setPage(0);
    setExpandedId(null);
  }, [selectedChatKeys, selectedSenders]);

  // Если выбранный автор пропал из-за сужения по чатам — убираем его,
  // чтобы counter «N выбрано» не показывал устаревшее число.
  useEffect(() => {
    if (selectedSenders.size === 0) return;
    const available = new Set(senders.map((s) => s.name));
    let changed = false;
    const next = new Set<string>();
    for (const s of selectedSenders) {
      if (available.has(s)) next.add(s);
      else changed = true;
    }
    if (changed) setSelectedSenders(next);
  }, [senders, selectedSenders]);

  // Mount-only fetches for sidebar data that doesn't depend on sort/filter.
  useEffect(() => {
    void fetchChats();
    void fetchTranscribedChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh transcript list when a video completes or job finishes
  const prevJobRef = useRef<string | null>(null);
  const prevCompletedRef = useRef<number>(0);
  useEffect(() => {
    if (activeJob) {
      prevJobRef.current = activeJob.id;
      if (activeJob.completed > prevCompletedRef.current) {
        prevCompletedRef.current = activeJob.completed;
        void fetchAllItems(sortOrder);
        void fetchTranscribedChats();
      }
    } else if (prevJobRef.current && scanResult) {
      prevCompletedRef.current = 0;
      void fetchAllItems(sortOrder);
      void fetchTranscribedChats();
      prevJobRef.current = null;
    }
  }, [activeJob, scanResult, fetchAllItems, fetchTranscribedChats, sortOrder]);

  const handleSortChange = (sort: 'created_at' | 'message_date') => {
    if (sort === sortOrder) return;
    setSortOrder(sort);
    setPage(0);
    setExpandedId(null);
  };

  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    setPage(0);
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

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = page + 1;

  return (
    <div className="flex gap-6 text-left max-w-full">
      <div className="min-w-0 flex-1 space-y-6">
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
          <div className="border-t border-gray-100 px-4 py-4 space-y-4">
            <p className="text-xs text-gray-500">
              Выберите группу и укажите сколько последних видео нужно найти и транскрибировать.
              Бот сам пройдётся по сообщениям от новых к старым.
            </p>

            {/* Row 1: Group selector */}
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Группа</span>
              <div className="flex items-center gap-2">
                <select
                  value={selectedChatId != null ? `${selectedChatId}:${selectedChatTopicId ?? ''}` : ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) {
                      setSelectedChatId(null);
                      setSelectedChatTopicId(null);
                      return;
                    }
                    const [cid, tid] = val.split(':');
                    setSelectedChatId(Number(cid));
                    setSelectedChatTopicId(tid ? Number(tid) : null);
                  }}
                  disabled={chatsLoading}
                  className="block w-full max-w-xs rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                >
                  {botChats.length === 0 && (
                    <option value="">{chatsLoading ? 'Загрузка...' : 'Нет групп — добавьте бота в группу'}</option>
                  )}
                  {botChats.map((c, i) => (
                    <option key={`${c.chatId}-${c.topicId ?? 'all'}-${i}`} value={`${c.chatId}:${c.topicId ?? ''}`}>
                      {c.topicName
                        ? `${c.title || `Chat ${c.chatId}`} / ${c.topicName}`
                        : c.title || `Chat ${c.chatId}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void fetchChats()}
                  disabled={chatsLoading}
                  className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-2 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Обновить список групп"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${chatsLoading ? 'animate-spin' : ''}`} />
                </button>
                {selectedChatId && (
                  <button
                    type="button"
                    onClick={() => void onDeleteChat()}
                    className="shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-2 text-gray-400 hover:text-rose-600 hover:border-rose-300 hover:bg-rose-50 cursor-pointer transition"
                    title="Удалить группу из списка"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowAddChat(!showAddChat)}
                  className="shrink-0 text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer transition font-medium"
                >
                  {showAddChat ? 'Отмена' : '+ Добавить'}
                </button>
                {botChats.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowManageChats((v) => !v)}
                    className="shrink-0 text-xs text-gray-600 hover:text-gray-900 cursor-pointer transition font-medium"
                  >
                    {showManageChats ? 'Скрыть список' : `Управление (${botChats.length})`}
                  </button>
                )}
              </div>
            </div>

            {/* Manage-chats list: full registered list with per-row delete. Lets users
                clean up junk entries without having to flip the dropdown one item at
                a time. Confirmation gates accidental clicks. */}
            {showManageChats && botChats.length > 0 && (
              <div className="rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 space-y-1">
                <div className="text-[11px] font-medium text-gray-500 pb-1">
                  Зарегистрированные чаты ({botChats.length})
                </div>
                <ul className="divide-y divide-gray-150 max-h-64 overflow-auto">
                  {botChats.map((c, i) => (
                    <li
                      key={`${c.chatId}-${c.topicId ?? 'all'}-${i}`}
                      className="flex items-center gap-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-gray-800 truncate">
                          {c.topicName
                            ? `${c.title || `Chat ${c.chatId}`} / ${c.topicName}`
                            : c.title || `Chat ${c.chatId}`}
                        </div>
                        <div className="text-[10px] text-gray-400 truncate">
                          id {c.chatId}
                          {c.topicId != null && ` · topic ${c.topicId}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setChatToDelete({
                            chatId: c.chatId,
                            topicId: c.topicId ?? null,
                            label: c.topicName
                              ? `${c.title || `Chat ${c.chatId}`} / ${c.topicName}`
                              : c.title || `Chat ${c.chatId}`,
                          })
                        }
                        className="shrink-0 inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 cursor-pointer transition"
                        title="Удалить из списка"
                      >
                        <Trash2 className="h-3 w-3" />
                        Удалить
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="pt-1 text-[10px] text-gray-400 leading-relaxed">
                  Удаление убирает чат/подчат из списка. Расшифровки в архиве остаются.
                  Чтобы заново подписать чат — добавьте его через «+ Добавить» или отправьте
                  в нём любое сообщение боту.
                </p>
              </div>
            )}

            {/* Inline add-chat form */}
            {showAddChat && (
              <div className="space-y-2 pl-0.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={addChatId}
                    onChange={(e) => {
                      setAddChatId(e.target.value);
                      setIsForum(false);
                      setFetchedTopics([]);
                      setSelectedTopicId(null);
                      setManualTopicId('');
                      setTopicNameInput('');
                    }}
                    placeholder="ID чата, напр. -1001234567890"
                    className="block w-48 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                  />
                  <input
                    type="text"
                    value={addChatTitle}
                    onChange={(e) => setAddChatTitle(e.target.value)}
                    placeholder="Название (необяз.)"
                    className="block w-40 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const id = parseInt(addChatId, 10);
                      if (id) void fetchTopics(id);
                    }}
                    disabled={!addChatId || topicsLoading}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {topicsLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      'Проверить подчаты'
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onAddChat()}
                    className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 cursor-pointer transition"
                  >
                    Добавить
                  </button>
                </div>
                {isForum && (
                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2">
                    <span className="text-[11px] font-medium text-amber-700">
                      Это форум-группа с подчатами
                    </span>
                    {fetchedTopics.length > 0 ? (
                      <select
                        value={selectedTopicId ?? ''}
                        onChange={(e) => setSelectedTopicId(e.target.value ? Number(e.target.value) : null)}
                        className="block w-full max-w-xs rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                      >
                        <option value="">Все подчаты (General)</option>
                        {fetchedTopics.map((t) => (
                          <option key={t.topicId} value={t.topicId}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <p className="text-[10px] text-gray-500">
                          Не удалось автоматически загрузить подчаты. Укажите ID и название вручную.
                          ID можно найти в URL Telegram Web (например, t.me/c/…/<strong>2420</strong> → ID = 2420).
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={manualTopicId}
                            onChange={(e) => setManualTopicId(e.target.value)}
                            placeholder="ID подчата"
                            className="block w-28 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                          />
                          <input
                            type="text"
                            value={topicNameInput}
                            onChange={(e) => setTopicNameInput(e.target.value)}
                            placeholder="Название подчата"
                            className="block w-44 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none"
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
                {!isForum && !topicsLoading && addChatId && (
                  <p className="text-[10px] text-gray-400">Обычная группа (без подчатов)</p>
                )}
              </div>
            )}

            {/* Single scan button — always parses the whole chat / selected topic. */}
            <div className="flex items-end gap-3">
              {isJobActive && isJobOwner ? (
                <button
                  type="button"
                  onClick={() => setShowStopDialog(true)}
                  className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-sm transition bg-rose-600 text-white hover:bg-rose-700"
                >
                  <Square className="h-3 w-3" />
                  Остановить
                </button>
              ) : !isJobActive ? (
                <button
                  type="button"
                  onClick={() => void onScanFullChat()}
                  disabled={fullScanPending || !selectedChatId}
                  title="Пройти все видео выбранного чата (или подчата) от новых к старым через MTProto-аккаунт. Уже расшифрованные пропускаются."
                  className={[
                    'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-sm transition',
                    fullScanPending || !selectedChatId
                      ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer',
                  ].join(' ')}
                >
                  {fullScanPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Сканировать чат
                </button>
              ) : null}
            </div>

            {scanError && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{scanError}</p>
              </div>
            )}

            {/* Active job progress */}
            {isJobActive && activeJob && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-indigo-700 min-w-0">
                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                    <span className="font-medium truncate">
                      {isFullScan ? 'Сканирование всего чата:' : 'Транскрибация:'}{' '}
                      <span className="font-semibold">
                        {chatLabel(activeJob.tg_chat_id, activeJob.topic_id)}
                      </span>
                    </span>
                    {!isJobOwner && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 shrink-0">
                        другой пользователь
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-indigo-500 shrink-0">
                    {isJobOwner ? 'Можно закрыть страницу — процесс продолжится' : 'Новую на этот чат начать нельзя'}
                  </span>
                </div>

                {activeJob.videos_found > 0 || activeJob.scanned > 0 ? (
                  <>
                    <div className="flex items-center justify-between text-xs text-gray-600">
                      {isFullScan ? (
                        <span>
                          Найдено видео: <span className="font-medium text-gray-800">{activeJob.videos_found}</span>
                          {' '}— проверено{' '}
                          <span className="font-medium text-gray-800">{activeJob.scanned.toLocaleString('ru-RU')}</span>{' '}
                          сообщ.
                        </span>
                      ) : activeJob.videos_found > 0 ? (
                        <>
                          <span>
                            Найдено видео: {activeJob.videos_found} из {activeJob.video_count}
                          </span>
                          {activeJob.scanned > 0 && (
                            <span className="text-gray-400">
                              проверено {activeJob.scanned} сообщ.
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-500">
                          Поиск видео… проверено {activeJob.scanned} сообщ.
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                      {/* In 'full' mode video_count is the 0-sentinel — fall back to an
                          indeterminate pulse bar since there's no known target. */}
                      {!isFullScan && activeJob.videos_found > 0 && activeJob.video_count > 0 ? (
                        <div
                          className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                          style={{ width: `${Math.min(100, Math.round((activeJob.videos_found / activeJob.video_count) * 100))}%` }}
                        />
                      ) : (
                        <div className="h-full rounded-full bg-indigo-300 animate-pulse" style={{ width: '30%' }} />
                      )}
                    </div>
                    {activeJob.videos_found > 0 && (
                      <div className="flex gap-3 text-[10px] text-gray-400">
                        <span className="text-emerald-600">{activeJob.completed} транскрибировано</span>
                        {activeJob.errors > 0 && (
                          <span className="text-rose-500">{activeJob.errors} ошибок</span>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-gray-400">Запуск сканирования…</p>
                )}

                {activeJob.videos && activeJob.videos.length > 0 && (
                  <div className="space-y-1.5">
                    {activeJob.videos.map((v) => (
                      <ScanVideoRow key={v.idx} video={v} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Queue indicator: other scans currently running/pending in the system.
                Helps explain "почему мой ещё не начался" when worker concurrency
                is saturated, and surfaces what other users are scanning. */}
            {scanQueue.length > 0 && (
              <div className="rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 space-y-1">
                <div className="text-[11px] font-medium text-gray-500">
                  Параллельно работают / ждут очереди ({scanQueue.length})
                </div>
                <ul className="space-y-0.5">
                  {scanQueue.map((q) => (
                    <li key={q.id} className="flex items-center gap-2 text-[11px] text-gray-600">
                      {q.status === 'running' ? (
                        <Loader2 className="h-3 w-3 animate-spin text-indigo-500 shrink-0" />
                      ) : (
                        <Clock className="h-3 w-3 text-gray-400 shrink-0" />
                      )}
                      <span className="truncate">{chatLabel(q.tg_chat_id, q.topic_id)}</span>
                      {q.scan_mode === 'full' && (
                        <span className="rounded-full bg-indigo-100 px-1.5 py-0 text-[9px] font-medium text-indigo-700 shrink-0">
                          весь чат
                        </span>
                      )}
                      {q.isOwner ? (
                        <span className="ml-auto text-[9px] text-indigo-500 shrink-0">ваш</span>
                      ) : (
                        <span className="ml-auto text-[9px] text-gray-400 shrink-0">другой пользователь</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Finished job result */}
            {!isJobActive && scanResult && (
              <div
                className={[
                  'rounded-lg border px-3 py-2 text-xs space-y-1',
                  scanResult.status === 'stopped'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : scanResult.status === 'failed'
                      ? 'border-rose-200 bg-rose-50 text-rose-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800',
                ].join(' ')}
              >
                <div className="text-[10px] opacity-70">
                  {scanResult.scan_mode === 'full' ? 'Весь чат: ' : 'Чат: '}
                  {chatLabel(scanResult.tg_chat_id, scanResult.topic_id)}
                </div>
                <div>
                  {scanResult.status === 'stopped' ? (
                    <>
                      Остановлено. <strong>{scanResult.completed}</strong> транскрибировано
                      {scanResult.errors > 0 && (
                        <>, <strong className="text-rose-600">{scanResult.errors}</strong> ошибок</>
                      )}
                      . Найдено {scanResult.videos_found} видео среди {scanResult.scanned} сообщений.
                    </>
                  ) : scanResult.status === 'failed' ? (
                    <>
                      Ошибка: {scanResult.error_message ?? 'Неизвестная ошибка'}
                      {scanResult.completed > 0 && (
                        <>. <strong>{scanResult.completed}</strong> транскрибировано до ошибки.</>
                      )}
                    </>
                  ) : (
                    <>
                      Готово: <strong>{scanResult.completed}</strong> транскрибировано
                      {scanResult.errors > 0 && (
                        <>, <strong className="text-rose-600">{scanResult.errors}</strong> ошибок</>
                      )}
                      . Найдено {scanResult.videos_found} видео среди {scanResult.scanned} сообщений.
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </details>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Поиск по подписи, автору или файлу…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-9 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => handleSearchChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Filters row: два дропдауна с чекбоксами + сортировка. */}
        <div className="flex items-center gap-3 flex-wrap">
          {transcribedChats.length > 0 && (
            <MultiSelectDropdown
              label="Чат"
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              emptyLabel="Все"
              width="w-80"
              options={transcribedChats.map((c) => ({
                value: `${c.chatId}:${c.topicId}`,
                label: c.displayName,
                count: c.count,
              }))}
              selected={selectedChatKeys}
              onChange={setSelectedChatKeys}
            />
          )}

          <MultiSelectDropdown
            label="Автор"
            icon={<Users className="h-3.5 w-3.5" />}
            emptyLabel="Все"
            options={senders.map((s) => ({
              value: s.name,
              label: s.name,
              count: s.count,
            }))}
            selected={selectedSenders}
            onChange={setSelectedSenders}
          />

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <div className="flex items-center gap-1 text-xs text-gray-500 mr-0.5">
              <ArrowUpDown className="h-3.5 w-3.5" />
              Сортировка:
            </div>
            <button
              type="button"
              onClick={() => handleSortChange('created_at')}
              className={[
                'rounded-full px-3 py-1 text-xs font-medium transition border',
                sortOrder === 'created_at'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50',
              ].join(' ')}
            >
              Обработано
            </button>
            <button
              type="button"
              onClick={() => handleSortChange('message_date')}
              className={[
                'rounded-full px-3 py-1 text-xs font-medium transition border',
                sortOrder === 'message_date'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50',
              ].join(' ')}
            >
              Дата сообщения
            </button>
          </div>
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
        {!loading && items.length === 0 && (() => {
          const anyFilter =
            selectedChatKeys.size > 0 ||
            selectedSenders.size > 0 ||
            searchQuery.trim() !== '';
          return (
            <div className="rounded-2xl border border-gray-200 bg-white/90 p-8 text-center">
              <Video className="mx-auto h-10 w-10 text-gray-300 mb-3" />
              <p className="text-sm text-gray-500">
                {searchQuery.trim()
                  ? `Ничего не найдено по запросу «${searchQuery.trim()}».`
                  : anyFilter
                    ? 'Нет транскрибаций по выбранным фильтрам.'
                    : 'Пока нет транскрибаций. Добавьте бота в ТГ-группу и отправьте видео.'}
              </p>
            </div>
          );
        })()}

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
                    onClick={() => {
                      if (isExpanded) { setExpandedId(null); return; }
                      setExpandedId(item.id);
                      if (item.hasFullText && !fullTextCache.current[item.id]) {
                        setLoadingTextId(item.id);
                        authFetch(`/api/tools/tg-transcribe?id=${encodeURIComponent(item.id)}`)
                          .then((res) => res?.ok ? res.json() : null)
                          .then((json: { text?: string } | null) => {
                            if (json?.text) fullTextCache.current[item.id] = json.text;
                          })
                          .finally(() => setLoadingTextId(null));
                      }
                    }}
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
                      {item.caption && (
                        <p className="mt-0.5 text-xs text-indigo-700 font-medium truncate flex items-center gap-1">
                          <MessageSquare className="h-3 w-3 shrink-0 text-indigo-400" />
                          {item.caption}
                        </p>
                      )}
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
                      {item.caption && (
                        <div className="flex items-start gap-2 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                          <p className="break-words">{item.caption}</p>
                        </div>
                      )}
                      {isError && item.error_text && (
                        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p>{item.error_text}</p>
                        </div>
                      )}

                      {item.text && (() => {
                        const displayText = fullTextCache.current[item.id] || item.text;
                        const isLoadingFull = loadingTextId === item.id;
                        return (
                          <>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                disabled={isLoadingFull}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onCopy(displayText, item.id);
                                }}
                                className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-50"
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
                                disabled={isLoadingFull}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDownloadTxt(displayText, item.filename);
                                }}
                                className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-50"
                              >
                                <Download className="h-3.5 w-3.5" />
                                TXT
                              </button>
                            </div>
                            <div className="max-h-96 overflow-auto rounded-xl bg-gray-50 px-3 py-2">
                              {isLoadingFull ? (
                                <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  Загрузка полного текста…
                                </div>
                              ) : (
                                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gray-800">
                                  {displayText}
                                </pre>
                              )}
                            </div>
                          </>
                        );
                      })()}
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
              onClick={() => setPage(Math.max(0, page - 1))}
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
              onClick={() => setPage(page + 1)}
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

      {/* Side panel: background webhook transcription jobs */}
      <ActiveJobsPanel onJobCompleted={() => void fetchAllItems(sortOrder)} />

      {/* Stop confirmation dialog */}
      <StopConfirmDialog
        open={showStopDialog}
        onConfirm={() => void onStopScan()}
        onCancel={() => setShowStopDialog(false)}
        stopping={stopping}
      />

      {/* Per-row "remove from list" confirmation. We don't auto-delete on icon click —
          users complained about accidental loss before, plus the chat row is the only
          handle for re-running scans/webhook routing. */}
      {chatToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="relative w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <button
              type="button"
              onClick={() => setChatToDelete(null)}
              disabled={deletingChat}
              className="absolute right-3 top-3 rounded-lg p-1 text-gray-400 hover:text-gray-600 transition"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-rose-100 p-2">
                <Trash2 className="h-5 w-5 text-rose-600" />
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-900">Удалить из списка?</h3>
                <p className="text-xs text-gray-500 leading-relaxed">
                  <strong>«{chatToDelete.label}»</strong> исчезнет из выпадающего списка и из{' '}
                  кнопок сканирования. Уже сделанные транскрибации в архиве{' '}
                  останутся.
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setChatToDelete(null)}
                disabled={deletingChat}
                className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteChatRow()}
                disabled={deletingChat}
                className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 transition disabled:opacity-60"
              >
                {deletingChat ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Удаляем…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3 w-3" />
                    Удалить
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
