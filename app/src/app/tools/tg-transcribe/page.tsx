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
  Trash2,
  Square,
  X,
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

  const txProgressRef = useRef<TranscriptionProgress | null>(null);
  const [, forceRender] = useState(0);
  const txPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isTranscribing || !video.transcriptionJobId) {
      if (txPollRef.current) {
        clearInterval(txPollRef.current);
        txPollRef.current = null;
      }
      txProgressRef.current = null;
      return;
    }

    const poll = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch(
          `/api/tools/audio-transcribe/progress?jobId=${encodeURIComponent(video.transcriptionJobId!)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (res.ok) {
          const data = (await res.json()) as TranscriptionProgress;
          if (data.found) {
            txProgressRef.current = data;
            forceRender((n) => n + 1);
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
    };
  }, [isTranscribing, video.transcriptionJobId]);

  const txProgress = txProgressRef.current;

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
  const [selectedChatTopicId, setSelectedChatTopicId] = useState<number | null>(null);
  const [isForum, setIsForum] = useState(false);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [fetchedTopics, setFetchedTopics] = useState<{ topicId: number; name: string }[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  const [manualTopicId, setManualTopicId] = useState('');
  const [topicNameInput, setTopicNameInput] = useState('');
  const [videoCount, setVideoCount] = useState('5');

  const [activeJob, setActiveJob] = useState<ScanJob | null>(null);
  const [scanResult, setScanResult] = useState<ScanJob | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showStopDialog, setShowStopDialog] = useState(false);
  const [stopping, setStopping] = useState(false);

  const [showAddChat, setShowAddChat] = useState(false);
  const [addChatId, setAddChatId] = useState('');
  const [addChatTitle, setAddChatTitle] = useState('');

  const isJobActive = activeJob && ['pending', 'running'].includes(activeJob.status);
  const isJobOwner = activeJob?.isOwner !== false;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchJobStatus = useCallback(async (): Promise<ScanJob | null> => {
    try {
      const token = await getToken();
      if (!token) return null;
      const res = await fetch('/api/tools/tg-transcribe/scan', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { job: ScanJob | null };
      return json.job;
    } catch {
      return null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const job = await fetchJobStatus();
      if (!job) return;

      if (['pending', 'running'].includes(job.status)) {
        setActiveJob(job);
      } else {
        setActiveJob(null);
        stopPolling();

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
      const job = await fetchJobStatus();
      if (!job) return;

      if (['pending', 'running'].includes(job.status)) {
        setActiveJob(job);
        startPolling();
      } else if (['completed', 'failed', 'stopped'].includes(job.status)) {
        setScanResult(job);
        if (job.status === 'failed') {
          setScanError(job.error_message ?? 'Ошибка сканирования');
        }
      }
    })();
  }, [fetchJobStatus, startPolling]);

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
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`/api/tools/tg-transcribe/chats/topics?chatId=${chatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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
  const onDeleteChat = async () => {
    if (!selectedChatId || deleting) return;
    const chat = botChats.find(
      (c) => c.chatId === selectedChatId && (c.topicId ?? null) === selectedChatTopicId,
    );
    if (!chat) return;
    setDeleting(true);
    try {
      const token = await getToken();
      const params = new URLSearchParams({ chatId: String(chat.chatId) });
      if (chat.topicId != null) params.set('topicId', String(chat.topicId));
      const res = await fetch(`/api/tools/tg-transcribe/chats?${params}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setSelectedChatId(null);
        setSelectedChatTopicId(null);
        void fetchChats();
      } else {
        const json = await res.json().catch(() => ({})) as { error?: string };
        setScanError(json.error ?? 'Не удалось удалить');
      }
    } catch {
      setScanError('Ошибка при удалении');
    } finally {
      setDeleting(false);
    }
  };

  const onAddChat = async () => {
    const id = parseInt(addChatId, 10);
    if (!id) return;
    try {
      const token = await getToken();
      const res = await fetch('/api/tools/tg-transcribe/chats/add', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    setActiveJob(null);

    try {
      const token = await getToken();
      const res = await fetch('/api/tools/tg-transcribe/scan', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatId: selectedChatId,
          videoCount: count,
          topicId: selectedChatTopicId,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        let msg = 'Ошибка сканирования';
        try { msg = JSON.parse(text).error ?? msg; } catch { /* use default */ }
        setScanError(msg);
        return;
      }

      const json = (await res.json()) as { job: ScanJob };
      setActiveJob(json.job);
      startPolling();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  const onStopScan = async () => {
    if (!activeJob) return;
    setStopping(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/tools/tg-transcribe/scan', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
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

  // Refresh transcript list when a job finishes
  const prevJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeJob) {
      prevJobRef.current = activeJob.id;
    } else if (prevJobRef.current && scanResult) {
      void fetchItems(activeSender, offset);
      void fetchSenders();
      prevJobRef.current = null;
    }
  }, [activeJob, scanResult, activeSender, offset, fetchItems, fetchSenders]);

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
                      {c.title || `Chat ${c.chatId}`}
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
              </div>
            </div>

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

            {/* Row 2: Video count + Scan button + Stop button */}
            <div className="flex items-end gap-3">
              <label className="space-y-1">
                <span className="text-[11px] font-medium text-gray-500">Кол-во видео</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={videoCount}
                  onChange={(e) => setVideoCount(e.target.value)}
                  disabled={!!isJobActive}
                  className="block w-20 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none disabled:opacity-50"
                />
              </label>
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
                  onClick={onScan}
                  disabled={!selectedChatId}
                  className={[
                    'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-sm transition',
                    !selectedChatId
                      ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer',
                  ].join(' ')}
                >
                  <Search className="h-3.5 w-3.5" />
                  Сканировать
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
                <div className="flex items-center justify-between rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-indigo-700">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span className="font-medium">
                      {isJobOwner ? 'Транскрибация выполняется в фоне' : 'Транскрибация запущена другим пользователем'}
                    </span>
                  </div>
                  <span className="text-[10px] text-indigo-500">
                    {isJobOwner ? 'Можно закрыть страницу — процесс продолжится' : 'Новую транскрибацию начать нельзя'}
                  </span>
                </div>

                {activeJob.videos_found > 0 || activeJob.scanned > 0 ? (
                  <>
                    <div className="flex items-center justify-between text-xs text-gray-600">
                      {activeJob.videos_found > 0 ? (
                        <span>
                          Найдено видео: {activeJob.videos_found} из {activeJob.video_count}
                        </span>
                      ) : (
                        <span className="text-gray-500">
                          Поиск видео… проверено {activeJob.scanned} сообщ.
                        </span>
                      )}
                      {activeJob.scanned > 0 && (
                        <span className="text-gray-400">
                          проверено {activeJob.scanned} сообщ.
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                      {activeJob.videos_found > 0 ? (
                        <div
                          className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                          style={{ width: `${Math.round((activeJob.videos_found / activeJob.video_count) * 100)}%` }}
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

            {/* Finished job result */}
            {!isJobActive && scanResult && (
              <div
                className={[
                  'rounded-lg border px-3 py-2 text-xs',
                  scanResult.status === 'stopped'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : scanResult.status === 'failed'
                      ? 'border-rose-200 bg-rose-50 text-rose-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800',
                ].join(' ')}
              >
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

      {/* Stop confirmation dialog */}
      <StopConfirmDialog
        open={showStopDialog}
        onConfirm={() => void onStopScan()}
        onCancel={() => setShowStopDialog(false)}
        stopping={stopping}
      />
    </div>
  );
}
