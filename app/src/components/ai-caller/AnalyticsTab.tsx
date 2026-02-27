'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
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
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Building2,
  User,
  Mail,
  Filter,
  Volume2,
  Square,
  Download,
  Send,
  Check,
  Mic,
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
  campaign_id: string | null;
  contact_company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_extra: Record<string, string> | null;
}

interface Campaign {
  id: string;
  name: string;
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
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [transcriptCache, setTranscriptCache] = useState<Record<string, string>>({});
  const [loadingTranscript, setLoadingTranscript] = useState<string | null>(null);
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null);
  const [recordingUrls, setRecordingUrls] = useState<Record<string, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analysesLoaded = useRef<boolean | null>(null);

  // Telegram
  const [tgChats, setTgChats] = useState<{ id: number; title: string; type: string }[]>([]);
  const [tgChatsLoaded, setTgChatsLoaded] = useState(false);
  const [tgDropdownId, setTgDropdownId] = useState<string | null>(null);
  const [tgSending, setTgSending] = useState<string | null>(null);
  const [tgSent, setTgSent] = useState<Set<string>>(new Set());
  const [tgRecSending, setTgRecSending] = useState<string | null>(null);
  const [tgRecSent, setTgRecSent] = useState<Set<string>>(new Set());

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }, []);

  const fetchCampaigns = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/campaigns', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setCampaigns((data.campaigns ?? []) as Campaign[]);
    } catch { /* ignore */ }
  }, [getToken]);

  const fetchAnalyses = useCallback(async (campaignId?: string) => {
    setLoadingAnalyses(true);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
      if (campaignId && campaignId !== 'all') params.set('campaignId', campaignId);
      const res = await fetch(`/api/ai-caller/analytics?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
    } catch { /* ignore */ }
    setLoadingAnalyses(false);
  }, [getToken]);

  if (analysesLoaded.current == null) {
    analysesLoaded.current = true;
    fetchAnalyses();
    fetchCampaigns();
  }

  function handleCampaignChange(campaignId: string) {
    setSelectedCampaign(campaignId);
    setExpandedId(null);
    fetchAnalyses(campaignId);
  }

  async function analyzeNewCalls() {
    setAnalyzing(true);
    try {
      const token = await getToken();
      const payload: { callIds?: string[]; campaignId?: string } = {};

      if (selectedCampaign !== 'all') {
        // Analyze by campaign — API will auto-collect call IDs from contacts
        payload.campaignId = selectedCampaign;
      } else {
        // Analyze from loaded calls
        const callIds = calls
          .filter((c) => c.status === 'ended')
          .map((c) => c.id);
        if (callIds.length === 0) { setAnalyzing(false); return; }
        payload.callIds = callIds;
      }

      const res = await fetch('/api/ai-caller/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.analyses) setAnalyses(data.analyses);
    } catch { /* ignore */ }
    setAnalyzing(false);
  }

  async function fetchTranscript(vapiCallId: string) {
    if (transcriptCache[vapiCallId]) return;
    setLoadingTranscript(vapiCallId);
    try {
      const token = await getToken();
      const res = await fetch(`/api/ai-caller/calls/${vapiCallId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      const call = data.call as Record<string, unknown> | undefined;
      const messages = call?.messages as Array<{ role: string; message: string }> | undefined;
      const transcript = call?.transcript as string | undefined;

      let formatted = '';
      if (messages && messages.length > 0) {
        formatted = messages
          .filter((m) => m.role === 'assistant' || m.role === 'user')
          .map((m) => `${m.role === 'assistant' ? 'AI' : 'Клиент'}: ${m.message}`)
          .join('\n');
      } else if (transcript) {
        formatted = transcript;
      } else {
        formatted = 'Расшифровка недоступна';
      }

      setTranscriptCache((prev) => ({ ...prev, [vapiCallId]: formatted }));
    } catch {
      setTranscriptCache((prev) => ({ ...prev, [vapiCallId]: 'Ошибка загрузки расшифровки' }));
    }
    setLoadingTranscript(null);
  }

  function toggleExpand(analysisId: string, vapiCallId: string) {
    if (expandedId === analysisId) {
      setExpandedId(null);
    } else {
      setExpandedId(analysisId);
      fetchTranscript(vapiCallId);
    }
  }

  async function playRecording(vapiCallId: string) {
    if (playingCallId === vapiCallId) {
      stopPlayback();
      return;
    }
    stopPlayback();

    if (recordingUrls[vapiCallId]) {
      startAudio(vapiCallId, recordingUrls[vapiCallId]);
      return;
    }

    setLoadingAudio(vapiCallId);
    try {
      const token = await getToken();
      const res = await fetch(`/api/ai-caller/calls/${vapiCallId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      const call = data.call as Record<string, unknown> | undefined;
      let url = (call?.recordingUrl as string)
        || ((call?.artifact as Record<string, unknown>)?.recordingUrl as string)
        || '';

      if (!url) { setLoadingAudio(null); return; }
      if (url.startsWith('/api/')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(token)}`;
      }
      setRecordingUrls((prev) => ({ ...prev, [vapiCallId]: url }));
      startAudio(vapiCallId, url);
    } catch { /* ignore */ }
    setLoadingAudio(null);
  }

  function startAudio(vapiCallId: string, url: string) {
    const audio = new Audio(url);
    audio.onended = () => { setPlayingCallId(null); audioRef.current = null; };
    audio.onerror = () => { setPlayingCallId(null); audioRef.current = null; };
    audio.play();
    audioRef.current = audio;
    setPlayingCallId(vapiCallId);
  }

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setPlayingCallId(null);
  }

  // Close telegram dropdown on outside click
  useEffect(() => {
    if (!tgDropdownId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-tg-dropdown]')) {
        setTgDropdownId(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [tgDropdownId]);

  // Download recording
  async function downloadRecording(callId: string) {
    let url = recordingUrls[callId];
    if (!url) {
      try {
        const token = await getToken();
        const res = await fetch(`/api/ai-caller/calls/${callId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const call = data.call as Record<string, unknown> | undefined;
        url = (call?.recordingUrl as string)
          || ((call?.artifact as Record<string, unknown>)?.recordingUrl as string)
          || '';
        if (url) {
          if (url.startsWith('/api/')) {
            const sep = url.includes('?') ? '&' : '?';
            url = `${url}${sep}token=${encodeURIComponent(token)}`;
          }
          setRecordingUrls((prev) => ({ ...prev, [callId]: url }));
        }
      } catch {
        return;
      }
    }
    if (!url) return;

    const a = document.createElement('a');
    a.href = url;
    a.download = `call-${callId}.wav`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Telegram functions
  async function loadTgChats(force = false) {
    if (tgChatsLoaded && !force) return;
    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/telegram/chats', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      const chats = data.chats ?? [];
      setTgChats(chats);
      // Only cache if we actually got results
      if (chats.length > 0) setTgChatsLoaded(true);
    } catch {
      // silently ignore
    }
  }

  function toggleTgDropdown(analysisId: string) {
    if (tgDropdownId === analysisId) {
      setTgDropdownId(null);
      return;
    }
    setTgDropdownId(analysisId);
    loadTgChats(!tgChatsLoaded);
  }

  async function sendToTelegram(chatId: number, analysis: Analysis) {
    const key = `${analysis.id}-${chatId}`;
    setTgSending(key);
    try {
      const token = await getToken();

      // Format date dd/mm/yy
      const d = new Date(analysis.analyzed_at);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yy = String(d.getFullYear()).slice(-2);
      const callDate = `${dd}/${mm}/${yy}`;

      const body = {
        chatId,
        vapiCallId: analysis.vapi_call_id,
        phone: analysis.customer_number ?? undefined,
        company: analysis.contact_company ?? analysis.company_name ?? undefined,
        contactName: analysis.contact_name ?? undefined,
        email: analysis.contact_email ?? undefined,
        extra: analysis.contact_extra ?? undefined,
        outcome: analysis.outcome,
        interestLevel: analysis.interest_level,
        summary: analysis.summary ?? undefined,
        nextAction: analysis.next_action ?? undefined,
        keyPoints: analysis.key_points ?? undefined,
        callDate,
        recordingUrl: recordingUrls[analysis.vapi_call_id] || undefined,
      };

      const res = await fetch('/api/ai-caller/telegram/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setTgSent((prev) => new Set(prev).add(key));
      }
    } catch {
      // silently ignore
    } finally {
      setTgSending(null);
      setTimeout(() => setTgDropdownId(null), 1200);
    }
  }

  async function sendRecordingToTelegram(chatId: number, analysis: Analysis) {
    const key = `rec-${analysis.id}-${chatId}`;
    setTgRecSending(key);
    try {
      const token = await getToken();
      let url = recordingUrls[analysis.vapi_call_id] || '';
      if (!url) {
        const res = await fetch(`/api/ai-caller/calls/${analysis.vapi_call_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const call = data.call as Record<string, unknown> | undefined;
        url = (call?.recordingUrl as string)
          || ((call?.artifact as Record<string, unknown>)?.recordingUrl as string)
          || '';
        if (url?.startsWith('/api/')) {
          url = `${window.location.origin}${url}`;
        }
      }

      const res = await fetch('/api/ai-caller/telegram/send-recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          chatId,
          vapiCallId: analysis.vapi_call_id,
          recordingUrl: url,
          phone: analysis.customer_number || '',
        }),
      });
      if (res.ok) {
        setTgRecSent((prev) => new Set(prev).add(key));
      }
    } catch { /* ignore */ }
    finally {
      setTgRecSending(null);
    }
  }

  // Stats
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

        <div className="flex items-center gap-3">
          {/* Campaign filter */}
          {campaigns.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-gray-400" />
              <select
                value={selectedCampaign}
                onChange={(e) => handleCampaignChange(e.target.value)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-blue-400 focus:outline-none"
              >
                <option value="all">Все кампании</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={() => { onRefreshCalls(); fetchAnalyses(selectedCampaign); }}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Обновить
          </button>
        </div>
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
            const isExpanded = expandedId === a.id;
            const transcript = transcriptCache[a.vapi_call_id];
            const isLoadingTx = loadingTranscript === a.vapi_call_id;
            const companyName = a.contact_company || a.company_name;

            return (
              <div
                key={a.id}
                className={`rounded-xl border ${config.bg} transition-all`}
              >
                {/* Main card — clickable */}
                <button
                  type="button"
                  onClick={() => toggleExpand(a.id, a.vapi_call_id)}
                  className="w-full text-left p-5"
                >
                  <div className="flex items-start gap-4">
                    <div className={`flex-shrink-0 mt-0.5 ${config.color}`}>
                      <Icon className="h-5 w-5" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">
                          {a.customer_number || '—'}
                        </span>
                        {companyName && (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                            <Building2 className="h-3 w-3" />
                            {companyName}
                          </span>
                        )}
                        {a.contact_name && (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                            <User className="h-3 w-3" />
                            {a.contact_name}
                          </span>
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

                      {a.summary && (
                        <p className="text-sm text-gray-700 mt-1.5">{a.summary}</p>
                      )}

                    {/* Key points */}
                    {a.key_points && a.key_points.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {a.key_points.map((kp, i) => (
                          <span
                            key={i}
                            className="inline-block rounded-full bg-white/80 border border-gray-200 px-3 py-1 text-xs text-gray-600"
                          >
                            {kp}
                          </span>
                        ))}
                      </div>
                    )}

                      {a.next_action && (
                        <div className="flex items-center gap-1.5 mt-2.5 text-xs font-medium text-gray-600">
                          <ArrowRight className="h-3.5 w-3.5" />
                          <span>{a.next_action}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <span className="text-xs text-gray-400">
                        {new Date(a.analyzed_at).toLocaleDateString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {isExpanded
                        ? <ChevronUp className="h-4 w-4 text-gray-400" />
                        : <ChevronDown className="h-4 w-4 text-gray-400" />}
                    </div>
                  </div>
                </button>

                {/* Expanded panel */}
                {isExpanded && (
                  <div className="border-t border-gray-200/60 px-5 pb-5 pt-4 space-y-4">
                    {/* Company info from CSV */}
                    {(a.contact_company || a.contact_name || a.contact_email || a.contact_extra) && (
                      <div className="rounded-lg bg-white/70 border border-gray-200 p-3.5 space-y-1.5">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                          Данные из базы
                        </p>
                        {a.contact_company && (
                          <div className="flex items-center gap-2 text-sm text-gray-700">
                            <Building2 className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                            <span>{a.contact_company}</span>
                          </div>
                        )}
                        {a.contact_name && (
                          <div className="flex items-center gap-2 text-sm text-gray-700">
                            <User className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                            <span>{a.contact_name}</span>
                          </div>
                        )}
                        {a.contact_email && (
                          <div className="flex items-center gap-2 text-sm text-gray-700">
                            <Mail className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                            <span>{a.contact_email}</span>
                          </div>
                        )}
                        {a.contact_extra && Object.keys(a.contact_extra).length > 0 && (
                          <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
                            {Object.entries(a.contact_extra).map(([key, value]) => (
                              <div key={key} className="flex items-center gap-2 text-xs text-gray-500">
                                <span className="font-medium">{key}:</span>
                                <span>{value}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Play audio */}
                      <button
                        onClick={(e) => { e.stopPropagation(); playRecording(a.vapi_call_id); }}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                          playingCallId === a.vapi_call_id
                            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {loadingAudio === a.vapi_call_id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : playingCallId === a.vapi_call_id
                            ? <Square className="h-3.5 w-3.5" />
                            : <Volume2 className="h-3.5 w-3.5" />}
                        {playingCallId === a.vapi_call_id ? 'Остановить' : 'Прослушать'}
                      </button>

                      {/* Download recording */}
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadRecording(a.vapi_call_id); }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Скачать запись
                      </button>

                      {/* Telegram */}
                      <div className="relative" data-tg-dropdown>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleTgDropdown(a.id); }}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                            tgDropdownId === a.id
                              ? 'bg-sky-100 text-sky-700'
                              : 'bg-sky-50 text-sky-600 hover:bg-sky-100'
                          }`}
                        >
                          <Send className="h-3.5 w-3.5" />
                          В телеграм
                        </button>

                        {tgDropdownId === a.id && (
                          <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-xl border border-gray-200 bg-white shadow-lg py-1 max-h-60 overflow-y-auto">
                            {!tgChatsLoaded ? (
                              <div className="flex items-center gap-2 px-3 py-3 text-xs text-gray-400">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Загрузка чатов...
                              </div>
                            ) : tgChats.length === 0 ? (
                              <div className="px-3 py-3 text-xs text-gray-400">
                                Нет доступных чатов. Добавьте бота в группу или напишите ему.
                              </div>
                            ) : (
                              tgChats.map((chat) => {
                                const sentKey = `${a.id}-${chat.id}`;
                                const isSending = tgSending === sentKey;
                                const wasSent = tgSent.has(sentKey);
                                const recKey = `rec-${a.id}-${chat.id}`;
                                const isRecSending = tgRecSending === recKey;
                                const wasRecSent = tgRecSent.has(recKey);

                                return (
                                  <div key={chat.id} className="px-3 py-2 hover:bg-gray-50 transition-colors">
                                    <div className="text-sm text-gray-700 truncate mb-1.5">
                                      {chat.title}
                                      <span className="text-xs text-gray-400 ml-1">
                                        ({chat.type === 'private' ? 'ЛС' : chat.type === 'group' ? 'группа' : chat.type === 'supergroup' ? 'группа' : 'канал'})
                                      </span>
                                    </div>
                                    <div className="flex gap-1.5">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!isSending && !wasSent) sendToTelegram(chat.id, a);
                                        }}
                                        disabled={isSending || wasSent}
                                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                                          wasSent ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                        }`}
                                      >
                                        {isSending ? <Loader2 className="h-3 w-3 animate-spin" />
                                          : wasSent ? <Check className="h-3 w-3" />
                                          : <Send className="h-3 w-3" />}
                                        Текст
                                      </button>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!isRecSending && !wasRecSent) sendRecordingToTelegram(chat.id, a);
                                        }}
                                        disabled={isRecSending || wasRecSent}
                                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                                          wasRecSent ? 'bg-green-100 text-green-700' : 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                                        }`}
                                      >
                                        {isRecSending ? <Loader2 className="h-3 w-3 animate-spin" />
                                          : wasRecSent ? <Check className="h-3 w-3" />
                                          : <Mic className="h-3 w-3" />}
                                        Запись
                                      </button>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Transcript */}
                    <div className="rounded-lg bg-white/70 border border-gray-200 p-3.5">
                      <div className="flex items-center gap-1.5 mb-2.5">
                        <MessageSquare className="h-3.5 w-3.5 text-gray-400" />
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          Расшифровка диалога
                        </p>
                      </div>

                      {isLoadingTx ? (
                        <div className="flex items-center gap-2 text-sm text-gray-400 py-3">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Загрузка расшифровки...
                        </div>
                      ) : transcript ? (
                        <div className="space-y-1.5 max-h-80 overflow-y-auto">
                          {transcript.split('\n').map((line, i) => {
                            const isAi = line.startsWith('AI:');
                            const isClient = line.startsWith('Клиент:');
                            if (!line.trim()) return null;
                            return (
                              <div
                                key={i}
                                className={`text-sm rounded-lg px-3 py-2 ${
                                  isAi
                                    ? 'bg-blue-50 text-blue-900 ml-0 mr-8'
                                    : isClient
                                      ? 'bg-gray-100 text-gray-800 ml-8 mr-0'
                                      : 'bg-gray-50 text-gray-700'
                                }`}
                              >
                                {isAi && <span className="text-xs font-semibold text-blue-500">AI  </span>}
                                {isClient && <span className="text-xs font-semibold text-gray-500">Клиент  </span>}
                                {line.replace(/^(AI|Клиент):\s*/, '')}
                              </div>
                            );
                          })}
                        </div>
                      ) : a.transcript_snippet ? (
                        <p className="text-sm text-gray-600 whitespace-pre-wrap">{a.transcript_snippet}</p>
                      ) : (
                        <p className="text-sm text-gray-400">Расшифровка недоступна</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
