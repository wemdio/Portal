'use client';

import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Loader2,
  BarChart3,
  ThumbsUp,
  ThumbsDown,
  PhoneCall,
  PhoneMissed,
  Voicemail,
  HelpCircle,
  RefreshCw,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import type { VapiCall } from '@/types/ai-caller';

interface Analysis {
  id: string;
  vapi_call_id: string;
  assistant_name: string | null;
  customer_number: string | null;
  company_name: string | null;
  outcome: string;
  interest_level: number;
  summary: string | null;
  next_action: string | null;
  key_points: string[] | null;
  transcript_snippet: string | null;
  analyzed_at: string;
}

interface Props {
  calls: VapiCall[];
  loading: boolean;
  onRefreshCalls: () => void;
}

const OUTCOME_CONFIG: Record<string, { label: string; icon: typeof ThumbsUp; color: string; bg: string }> = {
  interested: { label: 'Заинтересован', icon: ThumbsUp, color: 'text-green-600', bg: 'bg-green-50 border-green-200' },
  callback: { label: 'Перезвонить', icon: PhoneCall, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
  not_interested: { label: 'Не интересно', icon: ThumbsDown, color: 'text-red-500', bg: 'bg-red-50 border-red-200' },
  no_answer: { label: 'Без ответа', icon: PhoneMissed, color: 'text-gray-400', bg: 'bg-gray-50 border-gray-200' },
  voicemail: { label: 'Автоответчик', icon: Voicemail, color: 'text-amber-500', bg: 'bg-amber-50 border-amber-200' },
  other: { label: 'Другое', icon: HelpCircle, color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200' },
};

const FILTER_OPTIONS = [
  { id: 'all', label: 'Все' },
  { id: 'interested', label: 'Заинтересованы' },
  { id: 'callback', label: 'Перезвонить' },
  { id: 'not_interested', label: 'Не интересно' },
  { id: 'no_answer', label: 'Без ответа' },
];

export function AnalyticsTab({ calls, loading, onRefreshCalls }: Props) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingAnalyses, setLoadingAnalyses] = useState(true);
  const [filter, setFilter] = useState('all');
  const analysesLoaded = useRef<boolean | null>(null);

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }, []);

  // Load existing analyses
  const fetchAnalyses = useCallback(async () => {
    setLoadingAnalyses(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/analytics', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
    } catch { /* ignore */ }
    setLoadingAnalyses(false);
  }, [getToken]);

  // Initial load via ref guard
  if (analysesLoaded.current == null) {
    analysesLoaded.current = true;
    fetchAnalyses();
  }

  // Analyze unanalyzed calls
  async function analyzeNewCalls() {
    if (calls.length === 0) return;

    setAnalyzing(true);
    try {
      const callIds = calls
        .filter((c) => c.status === 'ended')
        .map((c) => c.id);

      if (callIds.length === 0) { setAnalyzing(false); return; }

      const token = await getToken();
      const res = await fetch('/api/ai-caller/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ callIds }),
      });
      const data = await res.json();
      if (data.analyses) setAnalyses(data.analyses);
    } catch { /* ignore */ }
    setAnalyzing(false);
  }

  // ── Stats ──

  const filtered = filter === 'all'
    ? analyses
    : analyses.filter((a) => a.outcome === filter);

  const stats = {
    total: analyses.length,
    interested: analyses.filter((a) => a.outcome === 'interested').length,
    callback: analyses.filter((a) => a.outcome === 'callback').length,
    notInterested: analyses.filter((a) => a.outcome === 'not_interested').length,
    noAnswer: analyses.filter((a) => a.outcome === 'no_answer').length,
    avgInterest: analyses.length > 0
      ? (analyses.reduce((sum, a) => sum + (a.interest_level || 0), 0) / analyses.length).toFixed(1)
      : '—',
  };

  const unanalyzedCount = calls.filter(
    (c) => c.status === 'ended' && !analyses.find((a) => a.vapi_call_id === c.id),
  ).length;

  // ── Render ──

  if (loading || loadingAnalyses) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Загрузка...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Action bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={analyzeNewCalls}
            disabled={analyzing || calls.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {analyzing ? 'Анализирую...' : 'Анализировать звонки'}
          </button>
          {unanalyzedCount > 0 && (
            <span className="text-xs text-gray-400">
              {unanalyzedCount} новых для анализа
            </span>
          )}
        </div>
        <button
          onClick={() => { onRefreshCalls(); fetchAnalyses(); }}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Обновить
        </button>
      </div>

      {/* Stats Cards */}
      {analyses.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
            <p className="text-xs text-gray-500 mt-0.5">Всего звонков</p>
          </div>
          <div className="rounded-xl border border-green-200 bg-green-50 p-4">
            <p className="text-2xl font-bold text-green-700">{stats.interested}</p>
            <p className="text-xs text-green-600 mt-0.5">Заинтересованы</p>
          </div>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-2xl font-bold text-blue-700">{stats.callback}</p>
            <p className="text-xs text-blue-600 mt-0.5">Перезвонить</p>
          </div>
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-2xl font-bold text-red-600">{stats.notInterested}</p>
            <p className="text-xs text-red-500 mt-0.5">Не интересно</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-2xl font-bold text-gray-900">{stats.avgInterest}</p>
            <p className="text-xs text-gray-500 mt-0.5">Ср. интерес (0-10)</p>
          </div>
        </div>
      )}

      {/* Filters */}
      {analyses.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setFilter(opt.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                filter === opt.id
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
              {opt.id !== 'all' && (
                <span className="ml-1 opacity-60">
                  ({analyses.filter((a) => a.outcome === opt.id).length})
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Analyses List */}
      {analyses.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-sm mb-2">Нет анализов. Нажмите «Анализировать звонки»,</p>
          <p className="text-sm">чтобы AI классифицировал ваши звонки по интересу.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => {
            const config = OUTCOME_CONFIG[a.outcome] || OUTCOME_CONFIG.other;
            const Icon = config.icon;

            return (
              <div
                key={a.id}
                className={`rounded-xl border p-5 ${config.bg}`}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div className={`flex-shrink-0 mt-0.5 ${config.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">
                        {a.customer_number || '—'}
                      </span>
                      {a.company_name && (
                        <span className="text-xs text-gray-500">{a.company_name}</span>
                      )}
                      <span className={`text-xs font-medium ${config.color}`}>
                        {config.label}
                      </span>
                      {a.interest_level > 0 && (
                        <span className="text-xs text-gray-400">
                          Интерес: {a.interest_level}/10
                        </span>
                      )}
                    </div>

                    {/* Summary */}
                    {a.summary && (
                      <p className="text-sm text-gray-700 mt-1.5">{a.summary}</p>
                    )}

                    {/* Key points */}
                    {a.key_points && a.key_points.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {a.key_points.map((kp, i) => (
                          <span
                            key={i}
                            className="inline-block rounded-full bg-white/80 border border-gray-200 px-2.5 py-0.5 text-xs text-gray-600"
                          >
                            {kp}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Next action */}
                    {a.next_action && (
                      <div className="flex items-center gap-1.5 mt-2.5 text-xs font-medium text-gray-600">
                        <ArrowRight className="h-3.5 w-3.5" />
                        <span>{a.next_action}</span>
                      </div>
                    )}
                  </div>

                  {/* Date */}
                  <div className="flex-shrink-0 text-xs text-gray-400">
                    {new Date(a.analyzed_at).toLocaleDateString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
