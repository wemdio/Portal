'use client';

import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Phone, Loader2, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import type { VapiAssistant, VapiPhoneNumber, VapiCall } from '@/types/ai-caller';

interface Props {
  assistants: VapiAssistant[];
  phoneNumbers: VapiPhoneNumber[];
  loading: boolean;
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  queued: { label: 'В очереди...', color: 'text-yellow-600' },
  ringing: { label: 'Звонок идёт...', color: 'text-blue-600' },
  'in-progress': { label: 'Разговор...', color: 'text-green-600' },
  forwarding: { label: 'Переадресация...', color: 'text-blue-600' },
  ended: { label: 'Завершён', color: 'text-gray-600' },
};

const ENDED_REASON_MAP: Record<string, string> = {
  'silence-timed-out': 'Тишина — таймаут',
  'max-duration-reached': 'Макс. длительность',
  'customer-ended-call': 'Абонент положил трубку',
  'assistant-ended-call': 'Ассистент завершил',
  'voicemail': 'Автоответчик',
  'customer-did-not-answer': 'Не ответили',
  'customer-busy': 'Занято',
  'manually-canceled': 'Отменён вручную',
};

export function TestCallTab({ assistants, phoneNumbers, loading }: Props) {
  const [selectedAssistant, setSelectedAssistant] = useState('');
  const [selectedPhone, setSelectedPhone] = useState('');
  const [customerNumber, setCustomerNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [activeCall, setActiveCall] = useState<VapiCall | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-select first items (derived — no useEffect needed)
  const effectiveAssistant = selectedAssistant || (assistants.length ? assistants[0].id : '');
  const effectivePhone = selectedPhone || (phoneNumbers.length ? phoneNumbers[0].id : '');

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }, []);

  const pollCallStatus = useCallback(
    (callId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);

      pollRef.current = setInterval(async () => {
        try {
          const token = await getToken();
          const res = await fetch(`/api/ai-caller/calls/${callId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await res.json();
          if (data.call) {
            setActiveCall(data.call as VapiCall);
            if (data.call.status === 'ended') {
              if (pollRef.current) clearInterval(pollRef.current);
              setCalling(false);
            }
          }
        } catch {
          // ignore polling errors
        }
      }, 2500);
    },
    [getToken],
  );

  async function makeCall() {
    if (!effectiveAssistant || !effectivePhone || !customerNumber.trim()) return;

    setCalling(true);
    setError('');
    setActiveCall(null);

    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
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

  // ── Helpers ──

  function getSelectedAssistantName() {
    const a = assistants.find((a) => a.id === effectiveAssistant);
    return a?.name || 'Без имени';
  }

  function getSelectedPhoneLabel() {
    const p = phoneNumbers.find((p) => p.id === effectivePhone);
    return p?.number || p?.name || p?.id || '—';
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
          {/* Assistant */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Ассистент
            </label>
            <select
              value={effectiveAssistant}
              onChange={(e) => setSelectedAssistant(e.target.value)}
              disabled={calling}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {assistants.length === 0 && (
                <option value="">Нет ассистентов</option>
              )}
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.id}
                </option>
              ))}
            </select>
          </div>

          {/* Phone number (from) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Звонить с номера
            </label>
            <select
              value={effectivePhone}
              onChange={(e) => setSelectedPhone(e.target.value)}
              disabled={calling}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {phoneNumbers.length === 0 && (
                <option value="">Нет номеров</option>
              )}
              {phoneNumbers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number || p.name || p.id}
                </option>
              ))}
            </select>
          </div>

          {/* Customer number */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Номер клиента
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                type="tel"
                value={customerNumber}
                onChange={(e) => setCustomerNumber(e.target.value)}
                placeholder="+7 999 123 4567"
                disabled={calling}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !calling) makeCall();
                }}
              />
              <button
                onClick={makeCall}
                disabled={calling || !effectiveAssistant || !effectivePhone || !customerNumber.trim()}
                className="inline-flex w-full sm:w-auto sm:self-auto self-center items-center justify-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {calling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Phone className="h-4 w-4" />
                )}
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

      {/* Active / Completed Call */}
      {activeCall && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Результат звонка</h3>
            {activeCall.status === 'ended' && (
              <button
                onClick={resetCall}
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Новый звонок
              </button>
            )}
          </div>

          {/* Status Bar */}
          <div className="flex flex-wrap items-center gap-4 text-sm mb-4">
            <div className="flex items-center gap-2">
              {activeCall.status === 'ended' ? (
                activeCall.endedReason === 'customer-ended-call' ||
                activeCall.endedReason === 'assistant-ended-call' ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-amber-500" />
                )
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              )}
              <span className={STATUS_MAP[activeCall.status ?? '']?.color ?? 'text-gray-600'}>
                {STATUS_MAP[activeCall.status ?? '']?.label ?? activeCall.status}
              </span>
            </div>

            {activeCall.status === 'ended' && (
              <>
                <span className="text-gray-400">|</span>
                <span className="text-gray-600">
                  Длительность: {formatDuration(activeCall.startedAt, activeCall.endedAt)}
                </span>
                {activeCall.endedReason && (
                  <>
                    <span className="text-gray-400">|</span>
                    <span className="text-gray-500">
                      {ENDED_REASON_MAP[activeCall.endedReason] || activeCall.endedReason}
                    </span>
                  </>
                )}
                {activeCall.cost != null && (
                  <>
                    <span className="text-gray-400">|</span>
                    <span className="text-gray-500">
                      ${activeCall.cost.toFixed(3)}
                    </span>
                  </>
                )}
              </>
            )}
          </div>

          {/* Transcript */}
          {activeCall.status === 'ended' && activeCall.transcript && (
            <div className="mt-2">
              <h4 className="text-sm font-medium text-gray-700 mb-2">Транскрипт</h4>
              <div className="max-h-80 overflow-y-auto rounded-lg bg-gray-50 border border-gray-100 p-4 space-y-2">
                {activeCall.messages
                  ?.filter(
                    (m) =>
                      m.role === 'assistant' || m.role === 'user' || m.role === 'bot',
                  )
                  .map((m, i) => (
                    <div
                      key={i}
                      className={`flex gap-3 text-sm ${
                        m.role === 'user' ? 'justify-end' : ''
                      }`}
                    >
                      {m.role !== 'user' && (
                        <span className="text-xs font-medium text-blue-600 w-8 flex-shrink-0 pt-0.5">
                          AI
                        </span>
                      )}
                      <span
                        className={`inline-block rounded-lg px-3 py-1.5 max-w-[80%] ${
                          m.role === 'user'
                            ? 'bg-blue-50 text-gray-800'
                            : 'bg-white border border-gray-200 text-gray-800'
                        }`}
                      >
                        {m.message || m.content || ''}
                      </span>
                      {m.role === 'user' && (
                        <span className="text-xs font-medium text-gray-500 w-8 flex-shrink-0 pt-0.5 text-right">
                          Кл.
                        </span>
                      )}
                    </div>
                  )) ?? (
                  <p className="text-sm text-gray-500 whitespace-pre-wrap">
                    {activeCall.transcript}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Waiting message */}
          {activeCall.status !== 'ended' && (
            <div className="flex items-center gap-3 py-8 justify-center text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Ожидание завершения звонка...</span>
            </div>
          )}

          {/* Call metadata */}
          {activeCall.status === 'ended' && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-400">
              <span>ID: {activeCall.id}</span>
              <span>Ассистент: {getSelectedAssistantName()}</span>
              <span>С номера: {getSelectedPhoneLabel()}</span>
              <span>Кому: {activeCall.customer?.number}</span>
            </div>
          )}
        </div>
      )}

      {/* Quick info */}
      {!activeCall && !calling && (
        <div className="rounded-xl bg-blue-50 border border-blue-100 px-5 py-4 text-sm text-blue-700">
          Выберите ассистента, номер для звонка и введите номер клиента. 
          После нажатия «Позвонить» Vapi инициирует исходящий звонок, и вы увидите 
          статус и транскрипт в реальном времени.
        </div>
      )}
    </div>
  );
}
