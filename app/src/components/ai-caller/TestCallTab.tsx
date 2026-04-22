'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { authFetch, getAccessToken } from '@/lib/authFetch';
import {
  Phone,
  Loader2,
  CheckCircle,
  XCircle,
  RefreshCw,
  Volume2,
  Square,
  Send,
  Clock,
  Mic,
} from 'lucide-react';
import type { VapiAssistant, VapiPhoneNumber, VapiCall } from '@/types/ai-caller';

interface Props {
  assistants: VapiAssistant[];
  phoneNumbers: VapiPhoneNumber[];
  loading: boolean;
  apiBase?: string;
  platformLabel?: string;
  provider?: string;
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  queued: { label: 'В очереди...', color: 'text-yellow-600' },
  ringing: { label: 'Звонок идёт...', color: 'text-blue-600' },
  'in-progress': { label: 'Разговор...', color: 'text-green-600' },
  forwarding: { label: 'Переадресация...', color: 'text-blue-600' },
  ended: { label: 'Завершён', color: 'text-gray-600' },
};

const ENDED_REASON_MAP: Record<string, string> = {
  'silence-timed-out': 'Тишина / обрыв линии',
  'max-duration-reached': 'Макс. длительность',
  'customer-ended-call': 'Абонент положил трубку',
  'assistant-ended-call': 'Ассистент завершил',
  'voicemail': 'Автоответчик',
  'customer-did-not-answer': 'Не ответили',
  'customer-busy': 'Занято',
  'manually-canceled': 'Отменён вручную',
};

interface HistoryEntry {
  call: VapiCall;
  assistantName: string;
  phoneLabel: string;
  timestamp: string;
}

export function TestCallTab({
  assistants,
  phoneNumbers,
  loading,
  apiBase = '/api/ai-caller',
}: Props) {
  const [selectedAssistant, setSelectedAssistant] = useState('');
  const [selectedPhone, setSelectedPhone] = useState('');
  const [customerNumber, setCustomerNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [activeCall, setActiveCall] = useState<VapiCall | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  // Audio playback
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Telegram
  const [tgChats, setTgChats] = useState<{ id: number; title: string }[]>([]);
  const tgLoadedRef = useRef(false);
  const [sendingTg, setSendingTg] = useState<string | null>(null);
  const [tgSuccess, setTgSuccess] = useState<string | null>(null);
  const [sendingTgRec, setSendingTgRec] = useState<string | null>(null);
  const [tgRecSuccess, setTgRecSuccess] = useState<string | null>(null);

  const effectiveAssistant = selectedAssistant || (assistants.length ? assistants[0].id : '');
  const effectivePhone = selectedPhone || (phoneNumbers.length ? phoneNumbers[0].id : '');

  // Load TG chats once
  useEffect(() => {
    if (tgLoadedRef.current) return;
    tgLoadedRef.current = true;
    authFetch('/api/ai-caller/telegram/chats')
      .then((r) => r.json())
      .then((data) => setTgChats(data.chats ?? []))
      .catch(() => {});
  }, []);

  const addToHistory = useCallback(
    (call: VapiCall) => {
      const assistantName =
        assistants.find((a) => a.id === effectiveAssistant)?.name || 'Без имени';
      const phone = phoneNumbers.find((p) => p.id === effectivePhone);
      const phoneLabel = phone?.number || phone?.name || '—';
      setHistory((prev) => [
        {
          call,
          assistantName,
          phoneLabel,
          timestamp: new Date().toLocaleString('ru-RU'),
        },
        ...prev,
      ]);
    },
    [assistants, phoneNumbers, effectiveAssistant, effectivePhone],
  );

  const pollCallStatus = useCallback(
    (callId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);

      pollRef.current = setInterval(async () => {
        try {
          const res = await authFetch(`${apiBase}/calls/${callId}`);
          const data = await res.json();
          if (data.call) {
            const call = data.call as VapiCall;
            setActiveCall(call);
            if (call.status === 'ended') {
              if (pollRef.current) clearInterval(pollRef.current);
              setCalling(false);
              addToHistory(call);
            }
          }
        } catch {
          // ignore polling errors
        }
      }, 5000);
    },
    [apiBase, addToHistory],
  );

  async function makeCall() {
    if (!effectiveAssistant || !effectivePhone || !customerNumber.trim()) return;

    setCalling(true);
    setError('');
    setActiveCall(null);

    try {
      const res = await authFetch(`${apiBase}/calls`, {
        method: 'POST',
        body: JSON.stringify({
          assistantId: effectiveAssistant,
          phoneNumberId: effectivePhone,
          customerNumber: customerNumber.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Ошибка при создании звонка');
        setCalling(false);
        return;
      }

      setActiveCall(data.call as VapiCall);
      pollCallStatus(data.call.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сети');
      setCalling(false);
    }
  }

  function resetCall() {
    if (pollRef.current) clearInterval(pollRef.current);
    setActiveCall(null);
    setCalling(false);
    setError('');
  }

  // ── Audio ──

  async function playRecording(callId: string) {
    if (playingCallId === callId) {
      stopPlayback();
      return;
    }
    stopPlayback();
    setLoadingAudio(callId);

    try {
      const res = await authFetch(`${apiBase}/calls/${callId}`);
      const data = await res.json();
      const call = data.call as Record<string, unknown> | undefined;
      let url =
        (call?.recordingUrl as string) ||
        ((call?.artifact as Record<string, unknown>)?.recordingUrl as string) ||
        '';

      if (!url) { setLoadingAudio(null); return; }

      if (url.startsWith('/api/')) {
        const token = await getAccessToken();
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(token)}`;
      }

      const audio = new Audio(url);
      audio.onended = () => { setPlayingCallId(null); audioRef.current = null; };
      audio.onerror = () => { setPlayingCallId(null); audioRef.current = null; };
      audio.play();
      audioRef.current = audio;
      setPlayingCallId(callId);
    } catch { /* ignore */ }
    setLoadingAudio(null);
  }

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setPlayingCallId(null);
  }

  // ── Telegram ──

  async function sendToTelegram(callId: string, call: VapiCall, chatId: number) {
    setSendingTg(callId);
    setTgSuccess(null);
    try {
      const res = await authFetch(`${apiBase}/calls/${callId}`);
      const data = await res.json();
      const fullCall = data.call as Record<string, unknown> | undefined;
      let recordingUrl =
        (fullCall?.recordingUrl as string) ||
        ((fullCall?.artifact as Record<string, unknown>)?.recordingUrl as string) ||
        '';

      if (recordingUrl.startsWith('/api/')) {
        recordingUrl = `${window.location.origin}${recordingUrl}`;
      }

      const transcript = call.messages
        ?.filter((m) => m.role === 'assistant' || m.role === 'user' || m.role === 'bot')
        .map((m) => `${m.role === 'user' ? 'Клиент' : 'AI'}: ${m.message || m.content || ''}`)
        .join('\n') || call.transcript || '';

      const tgRes = await authFetch('/api/ai-caller/telegram/send', {
        method: 'POST',
        body: JSON.stringify({
          chatId,
          vapiCallId: callId,
          phone: call.customer?.number || '',
          outcome: 'other',
          summary: `Тестовый звонок. Длительность: ${formatDuration(call.startedAt, call.endedAt)}\n\nТранскрипт:\n${transcript.slice(0, 3000)}`,
          recordingUrl,
          callDate: new Date().toLocaleString('ru-RU'),
        }),
      });

      if (tgRes.ok) {
        setTgSuccess(callId);
        setTimeout(() => setTgSuccess(null), 3000);
      }
    } catch { /* ignore */ }
    setSendingTg(null);
  }

  async function sendRecordingToTelegram(callId: string, call: VapiCall, chatId: number) {
    setSendingTgRec(callId);
    setTgRecSuccess(null);
    try {
      const res = await authFetch(`${apiBase}/calls/${callId}`);
      const data = await res.json();
      const fullCall = data.call as Record<string, unknown> | undefined;
      let recordingUrl =
        (fullCall?.recordingUrl as string) ||
        ((fullCall?.artifact as Record<string, unknown>)?.recordingUrl as string) ||
        '';

      if (recordingUrl.startsWith('/api/')) {
        recordingUrl = `${window.location.origin}${recordingUrl}`;
      }

      const tgRes = await authFetch('/api/ai-caller/telegram/send-recording', {
        method: 'POST',
        body: JSON.stringify({
          chatId,
          vapiCallId: callId,
          recordingUrl,
          phone: call.customer?.number || '',
        }),
      });

      if (tgRes.ok) {
        setTgRecSuccess(callId);
        setTimeout(() => setTgRecSuccess(null), 3000);
      }
    } catch { /* ignore */ }
    setSendingTgRec(null);
  }

  // ── Helpers ──

  function getSelectedAssistantName() {
    return assistants.find((a) => a.id === effectiveAssistant)?.name || 'Без имени';
  }

  function formatDuration(startedAt?: string, endedAt?: string): string {
    if (!startedAt || !endedAt) return '—';
    const diff = Math.round(
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000,
    );
    const mins = Math.floor(diff / 60);
    const secs = diff % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function renderCallCard(call: VapiCall, assistantName?: string, phoneLabel?: string) {
    const isExpanded = expandedHistoryId === call.id;
    return (
      <div key={call.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div
          className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => setExpandedHistoryId(isExpanded ? null : call.id)}
        >
          <div className="flex items-center gap-3 min-w-0">
            {call.endedReason === 'customer-ended-call' || call.endedReason === 'assistant-ended-call'
              ? <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
              : <XCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />
            }
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-gray-900 truncate">
                  {call.customer?.number || '—'}
                </span>
                <span className="text-gray-400">→</span>
                <span className="text-gray-500 truncate text-xs">
                  {assistantName || getSelectedAssistantName()}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                <span>{formatDuration(call.startedAt, call.endedAt)}</span>
                <span>{ENDED_REASON_MAP[call.endedReason ?? ''] || call.endedReason || '—'}</span>
                {call.cost != null && <span>${call.cost.toFixed(3)}</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); playRecording(call.id); }}
              className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title={playingCallId === call.id ? 'Остановить' : 'Прослушать'}
            >
              {loadingAudio === call.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : playingCallId === call.id ? (
                <Square className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (tgChats.length === 0) {
                  alert('Бот не видит чатов. Напишите боту /start в Telegram, затем обновите страницу.');
                  return;
                }
                sendToTelegram(call.id, call, tgChats[0].id);
              }}
              disabled={sendingTg === call.id}
              className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50"
              title={tgChats.length > 0 ? `Отправить в Telegram (${tgChats[0].title})` : 'Отправить в Telegram'}
            >
              {sendingTg === call.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : tgSuccess === call.id ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (tgChats.length === 0) {
                  alert('Бот не видит чатов. Напишите боту /start в Telegram, затем обновите страницу.');
                  return;
                }
                sendRecordingToTelegram(call.id, call, tgChats[0].id);
              }}
              disabled={sendingTgRec === call.id}
              className="p-1.5 rounded-md text-gray-400 hover:text-purple-600 hover:bg-purple-50 transition-colors disabled:opacity-50"
              title={tgChats.length > 0 ? `Отправить запись в Telegram (${tgChats[0].title})` : 'Отправить запись в Telegram'}
            >
              {sendingTgRec === call.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : tgRecSuccess === call.id ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {isExpanded && call.messages && (
          <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
            <div className="max-h-60 overflow-y-auto space-y-1.5">
              {call.messages
                .filter((m) => m.role === 'assistant' || m.role === 'user' || m.role === 'bot')
                .map((m, i) => (
                  <div
                    key={i}
                    className={`flex gap-2 text-xs ${m.role === 'user' ? 'justify-end' : ''}`}
                  >
                    {m.role !== 'user' && (
                      <span className="font-medium text-blue-600 w-6 flex-shrink-0">AI</span>
                    )}
                    <span
                      className={`inline-block rounded-lg px-2.5 py-1 max-w-[85%] ${
                        m.role === 'user'
                          ? 'bg-blue-50 text-gray-800'
                          : 'bg-white border border-gray-200 text-gray-800'
                      }`}
                    >
                      {m.message || m.content || ''}
                    </span>
                    {m.role === 'user' && (
                      <span className="font-medium text-gray-500 w-6 flex-shrink-0 text-right">Кл.</span>
                    )}
                  </div>
                ))}
            </div>
            <div className="mt-2 pt-2 border-t border-gray-100 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-400">
              <span>ID: {call.id}</span>
              {phoneLabel && <span>С: {phoneLabel}</span>}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Загрузка...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Call Form */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Параметры звонка</h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ассистент</label>
            <select
              value={effectiveAssistant}
              onChange={(e) => setSelectedAssistant(e.target.value)}
              disabled={calling}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {assistants.length === 0 && <option value="">Нет ассистентов</option>}
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>{a.name || a.id}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Звонить с номера</label>
            <select
              value={effectivePhone}
              onChange={(e) => setSelectedPhone(e.target.value)}
              disabled={calling}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {phoneNumbers.length === 0 && <option value="">Нет номеров</option>}
              {phoneNumbers.map((p) => (
                <option key={p.id} value={p.id}>{p.number || p.name || p.id}</option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Номер клиента</label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                type="tel"
                value={customerNumber}
                onChange={(e) => setCustomerNumber(e.target.value)}
                placeholder="+7 999 123 4567"
                disabled={calling}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                onKeyDown={(e) => { if (e.key === 'Enter' && !calling) makeCall(); }}
              />
              <button
                onClick={makeCall}
                disabled={calling || !effectiveAssistant || !effectivePhone || !customerNumber.trim()}
                className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {calling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                {calling ? 'Идёт звонок...' : 'Позвонить'}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <XCircle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}
      </div>

      {/* Active Call */}
      {activeCall && activeCall.status !== 'ended' && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50/30 p-6">
          <div className="flex items-center gap-3 justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            <span className="text-sm text-blue-700">
              {STATUS_MAP[activeCall.status ?? '']?.label ?? 'Звонок...'}
            </span>
          </div>
        </div>
      )}

      {/* Completed Active Call */}
      {activeCall && activeCall.status === 'ended' && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Последний звонок</h3>
            <button
              onClick={resetCall}
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Новый звонок
            </button>
          </div>
          {renderCallCard(activeCall)}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Clock className="h-4 w-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700">
              История тестовых звонков ({history.length})
            </h3>
          </div>
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.call.id}>
                <div className="text-[10px] text-gray-400 mb-0.5 pl-1">{h.timestamp}</div>
                {renderCallCard(h.call, h.assistantName, h.phoneLabel)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick info */}
      {!activeCall && !calling && history.length === 0 && (
        <div className="rounded-xl bg-blue-50 border border-blue-100 px-5 py-4 text-sm text-blue-700">
          Выберите ассистента, номер для звонка и введите номер клиента.
          Статус, транскрипт и запись появятся после завершения звонка.
          {tgChats.length > 0 && ' Записи можно переслать в Telegram.'}
        </div>
      )}
    </div>
  );
}
