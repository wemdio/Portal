'use client';

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Loader2,
  PhoneOutgoing,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  History,
} from 'lucide-react';
import type { VapiCall, VapiAssistant } from '@/types/ai-caller';

interface Props {
  calls: VapiCall[];
  assistants: VapiAssistant[];
  loading: boolean;
  onRefresh: () => void;
}

const ENDED_REASON_MAP: Record<string, string> = {
  'silence-timed-out': 'Таймаут тишины',
  'max-duration-reached': 'Макс. длительность',
  'customer-ended-call': 'Абонент завершил',
  'assistant-ended-call': 'AI завершил',
  'voicemail': 'Автоответчик',
  'customer-did-not-answer': 'Не ответили',
  'customer-busy': 'Занято',
  'manually-canceled': 'Отменён',
};

/** Определяет итог звонка на основе транскрипта и причины завершения */
function getCallOutcomeLabel(call: VapiCall): { label: string; color: string } {
  const hasTranscript = !!(call.transcript && call.transcript.trim().length > 20);
  const duration = getDurationSeconds(call.startedAt, call.endedAt);

  if (call.endedReason === 'customer-did-not-answer') return { label: 'Не ответили', color: 'text-gray-400' };
  if (call.endedReason === 'customer-busy') return { label: 'Занято', color: 'text-gray-400' };
  if (call.endedReason === 'voicemail') return { label: 'Автоответчик', color: 'text-amber-500' };
  if (call.endedReason === 'manually-canceled') return { label: 'Отменён', color: 'text-gray-400' };

  if (hasTranscript && duration > 15) return { label: 'Разговор', color: 'text-green-600' };
  if (hasTranscript && duration > 5) return { label: 'Короткий разговор', color: 'text-amber-600' };
  if (call.endedReason === 'silence-timed-out' && !hasTranscript) return { label: 'Тишина', color: 'text-gray-400' };

  return {
    label: ENDED_REASON_MAP[call.endedReason ?? ''] || call.endedReason || 'Завершён',
    color: 'text-gray-500',
  };
}

function getDurationSeconds(startedAt?: string, endedAt?: string): number {
  if (!startedAt || !endedAt) return 0;
  return Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
}

function formatDuration(startedAt?: string, endedAt?: string): string {
  if (!startedAt || !endedAt) return '—';
  const diff = Math.round(
    (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  );
  if (diff < 0) return '—';
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function CallHistoryTab({ calls, assistants, loading, onRefresh }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCall, setDetailCall] = useState<VapiCall | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }, []);

  async function loadCallDetail(callId: string) {
    if (expandedId === callId) {
      setExpandedId(null);
      setDetailCall(null);
      return;
    }

    setExpandedId(callId);
    setLoadingDetail(true);

    try {
      const token = await getToken();
      const res = await fetch(`/api/ai-caller/calls/${callId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.call) setDetailCall(data.call as VapiCall);
    } catch {
      // ignore
    }

    setLoadingDetail(false);
  }

  function getAssistantName(assistantId?: string): string {
    if (!assistantId) return '—';
    const a = assistants.find((a) => a.id === assistantId);
    return a?.name || assistantId.slice(0, 8) + '...';
  }

  function getStatusIcon(call: VapiCall) {
    if (call.status !== 'ended') {
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    }
    const good =
      call.endedReason === 'customer-ended-call' ||
      call.endedReason === 'assistant-ended-call';
    return good ? (
      <CheckCircle className="h-4 w-4 text-green-500" />
    ) : (
      <XCircle className="h-4 w-4 text-amber-500" />
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

  if (calls.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <History className="h-12 w-12 mx-auto mb-3 opacity-40" />
        <p className="text-sm">Нет звонков. Сделайте первый тестовый звонок.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Последние {calls.length} звонков
        </p>
        <button
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
        >
          <History className="h-3.5 w-3.5" />
          Обновить
        </button>
      </div>

      {/* Calls List */}
      <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
        {calls.map((call) => {
          const isExpanded = expandedId === call.id;

          return (
            <div key={call.id}>
              {/* Row */}
              <div
                className="flex items-center gap-4 px-5 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => loadCallDetail(call.id)}
              >
                {/* Status icon */}
                <div className="flex-shrink-0">{getStatusIcon(call)}</div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <PhoneOutgoing className="h-3.5 w-3.5 text-gray-400" />
                    <span className="text-sm font-medium text-gray-900">
                      {call.customer?.number || '—'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {getAssistantName(call.assistantId)}
                  </div>
                </div>

                {/* Duration */}
                <div className="flex items-center gap-1 text-sm text-gray-500">
                  <Clock className="h-3.5 w-3.5" />
                  {formatDuration(call.startedAt, call.endedAt)}
                </div>

                {/* Call outcome */}
                {(() => {
                  const outcome = getCallOutcomeLabel(call);
                  return (
                    <div className={`text-xs font-medium w-32 text-right truncate ${outcome.color}`}>
                      {outcome.label}
                    </div>
                  );
                })()}

                {/* Date */}
                <div className="text-xs text-gray-400 w-32 text-right">
                  {formatDate(call.createdAt)}
                </div>

                {/* Chevron */}
                <div className="flex-shrink-0">
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-gray-400" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-gray-400" />
                  )}
                </div>
              </div>

              {/* Expanded Detail */}
              {isExpanded && (
                <div className="bg-gray-50/70 border-t border-gray-100 px-6 py-4">
                  {loadingDetail ? (
                    <div className="flex items-center gap-2 py-4 justify-center text-gray-400">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm">Загрузка транскрипта...</span>
                    </div>
                  ) : detailCall ? (
                    <div className="space-y-3">
                      {/* Transcript */}
                      {detailCall.transcript ? (
                        <div>
                          <span className="text-xs font-medium text-gray-500 uppercase">
                            Транскрипт
                          </span>
                          <div className="max-h-64 overflow-y-auto rounded-lg bg-white border border-gray-200 p-4 mt-1 space-y-2">
                            {detailCall.messages
                              ?.filter(
                                (m) =>
                                  m.role === 'assistant' ||
                                  m.role === 'user' ||
                                  m.role === 'bot',
                              )
                              .map((m, i) => (
                                <div
                                  key={i}
                                  className={`flex gap-3 text-sm ${
                                    m.role === 'user' ? 'justify-end' : ''
                                  }`}
                                >
                                  {m.role !== 'user' && (
                                    <span className="text-xs font-medium text-blue-600 w-6 flex-shrink-0 pt-0.5">
                                      AI
                                    </span>
                                  )}
                                  <span
                                    className={`inline-block rounded-lg px-3 py-1.5 max-w-[80%] ${
                                      m.role === 'user'
                                        ? 'bg-blue-50 text-gray-800'
                                        : 'bg-gray-50 border border-gray-100 text-gray-800'
                                    }`}
                                  >
                                    {m.message || m.content || ''}
                                  </span>
                                  {m.role === 'user' && (
                                    <span className="text-xs font-medium text-gray-500 w-6 flex-shrink-0 pt-0.5 text-right">
                                      Кл.
                                    </span>
                                  )}
                                </div>
                              )) ?? (
                              <p className="text-sm text-gray-600 whitespace-pre-wrap">
                                {detailCall.transcript}
                              </p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-400">
                          Транскрипт недоступен
                        </p>
                      )}

                      {/* Cost */}
                      {detailCall.cost != null && (
                        <div className="text-xs text-gray-400">
                          Стоимость: ${detailCall.cost.toFixed(4)}
                        </div>
                      )}

                      {/* Call ID */}
                      <div className="text-xs text-gray-400">
                        ID звонка: {detailCall.id}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 py-2">
                      Не удалось загрузить детали
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
