'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Plus,
  Play,
  Pause,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
  Users,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  X,
  Volume2,
  Square,
  Mic,
} from 'lucide-react';
import type { VapiAssistant, VapiPhoneNumber } from '@/types/ai-caller';

interface Campaign {
  id: string;
  name: string;
  assistant_id: string;
  phone_number_id: string;
  status: string;
  total_contacts: number;
  called_contacts: number;
  successful_contacts: number;
  created_at: string;
}

interface Contact {
  id: string;
  phone_number: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  status: string;
  vapi_call_id: string | null;
  call_duration: number | null;
  call_ended_reason: string | null;
  called_at: string | null;
}

interface Props {
  assistants: VapiAssistant[];
  phoneNumbers: VapiPhoneNumber[];
  loading: boolean;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: 'Черновик', color: 'bg-gray-100 text-gray-600' },
  running: { label: 'Запущена', color: 'bg-green-100 text-green-700' },
  paused: { label: 'Пауза', color: 'bg-yellow-100 text-yellow-700' },
  completed: { label: 'Завершена', color: 'bg-blue-100 text-blue-700' },
  cancelled: { label: 'Отменена', color: 'bg-red-100 text-red-600' },
};

export function CampaignsTab({ assistants, phoneNumbers, loading }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  // Create form state
  const [formName, setFormName] = useState('');
  const [formAssistant, setFormAssistant] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [parsedContacts, setParsedContacts] = useState<
    { phone: string; company?: string; name?: string; email?: string }[]
  >([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const campaignsLoaded = useRef<boolean | null>(null);

  // Audio playback
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null);
  const [recordingUrls, setRecordingUrls] = useState<Record<string, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Telegram recording
  const [tgChats, setTgChats] = useState<{ id: number; title: string }[]>([]);
  const tgLoadedRef = useRef(false);
  const [sendingTgRec, setSendingTgRec] = useState<string | null>(null);
  const [tgRecSuccess, setTgRecSuccess] = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }, []);

  const fetchCampaigns = useCallback(async () => {
    setLoadingCampaigns(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/campaigns', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setCampaigns(data.campaigns ?? []);
    } catch { /* ignore */ }
    setLoadingCampaigns(false);
  }, [getToken]);

  useEffect(() => {
    if (campaignsLoaded.current == null) {
      campaignsLoaded.current = true;
      fetchCampaigns();
    }
  }, [fetchCampaigns]);

  // Auto-refresh campaign stats while any campaign is running (server-driven)
  const hasRunning = campaigns.some((c) => c.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => {
      fetchCampaigns();
      const runningCamp = campaigns.find((c) => c.status === 'running');
      if (expandedId && runningCamp && expandedId === runningCamp.id) {
        getToken().then((token) =>
          fetch(`/api/ai-caller/campaigns/${expandedId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
            .then((r) => r.json())
            .then((data) => setContacts(data.contacts ?? []))
            .catch(() => {})
        );
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [hasRunning, expandedId, campaigns, fetchCampaigns, getToken]);

  // Derived defaults
  const effectiveAssistant = formAssistant || (assistants.length ? assistants[0].id : '');
  const effectivePhone = formPhone || (phoneNumbers.length ? phoneNumbers[0].id : '');

  // ── CSV Upload ──

  function handleCsvUpload(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (!text) return;

      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) { setError('CSV пустой'); return; }

      const headers = lines[0].toLowerCase().split(/[,;\t]/).map((h) => h.trim().replace(/"/g, ''));
      const phoneIdx = headers.findIndex((h) =>
        /phone|телефон|номер|number/.test(h),
      );
      const companyIdx = headers.findIndex((h) =>
        /company|компания|организация|название/.test(h),
      );
      const nameIdx = headers.findIndex((h) =>
        /name|имя|контакт|fio|фио/.test(h),
      );
      const emailIdx = headers.findIndex((h) =>
        /email|почта|mail/.test(h),
      );

      if (phoneIdx === -1) {
        setError('Не найдена колонка с телефоном (phone/телефон/номер)');
        return;
      }

      const parsed = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(/[,;\t]/).map((c) => c.trim().replace(/"/g, ''));
        const phone = cols[phoneIdx];
        if (!phone || phone.length < 6) continue;

        parsed.push({
          phone,
          company: companyIdx >= 0 ? cols[companyIdx] : undefined,
          name: nameIdx >= 0 ? cols[nameIdx] : undefined,
          email: emailIdx >= 0 ? cols[emailIdx] : undefined,
        });
      }

      if (parsed.length === 0) { setError('Не удалось извлечь контакты'); return; }
      setParsedContacts(parsed);
      setError('');
    };
    reader.readAsText(file, 'utf-8');
  }

  // ── Create Campaign ──

  async function createCampaign() {
    if (!formName.trim() || !effectiveAssistant || !effectivePhone || !parsedContacts.length) return;

    setCreating(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: formName,
          assistantId: effectiveAssistant,
          phoneNumberId: effectivePhone,
          contacts: parsedContacts,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        let msg = data.error || 'Ошибка';
        if (data.invalidSamples?.length) {
          const samples = data.invalidSamples.map((s: { row: number; phone: string }) => `строка ${s.row}: "${s.phone}"`).join(', ');
          msg += ` Примеры: ${samples}`;
        }
        setError(msg);
        setCreating(false);
        return;
      }

      setShowCreate(false);
      setFormName('');
      setParsedContacts([]);
      fetchCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
    setCreating(false);
  }

  // ── Run Campaign (server-driven via worker) ──

  async function startCampaign(id: string) {
    const token = await getToken();
    await fetch(`/api/ai-caller/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'running' }),
    });
    fetchCampaigns();
  }

  async function pauseCampaign(id: string) {
    const token = await getToken();
    await fetch(`/api/ai-caller/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'paused' }),
    });
    fetchCampaigns();
  }

  async function deleteCampaign(id: string) {
    if (!confirm('Удалить кампанию?')) return;
    const token = await getToken();
    await fetch(`/api/ai-caller/campaigns/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    fetchCampaigns();
  }

  async function loadContacts(campaignId: string) {
    if (expandedId === campaignId) { setExpandedId(null); return; }
    setExpandedId(campaignId);
    setLoadingContacts(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/ai-caller/campaigns/${campaignId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setContacts(data.contacts ?? []);
    } catch { /* ignore */ }
    setLoadingContacts(false);
  }

  // ── Audio playback ──

  async function playRecording(vapiCallId: string) {
    // If already playing this one — stop
    if (playingCallId === vapiCallId) {
      stopPlayback();
      return;
    }

    // Stop any current playback
    stopPlayback();

    // Check cache
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

      if (!url) {
        setLoadingAudio(null);
        return;
      }

      if (url.startsWith('/api/')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(token)}`;
      }

      setRecordingUrls((prev) => ({ ...prev, [vapiCallId]: url }));
      startAudio(vapiCallId, url);
    } catch {
      // ignore
    }
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

  // ── Telegram recording ──

  useEffect(() => {
    if (tgLoadedRef.current) return;
    tgLoadedRef.current = true;
    getToken().then((token) =>
      fetch('/api/ai-caller/telegram/chats', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((data) => setTgChats(data.chats ?? []))
        .catch(() => {})
    );
  }, [getToken]);

  async function sendRecordingToTelegram(vapiCallId: string, phone: string, chatId: number) {
    setSendingTgRec(vapiCallId);
    setTgRecSuccess(null);
    try {
      const token = await getToken();
      const tgRes = await fetch('/api/ai-caller/telegram/send-recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ chatId, vapiCallId, phone }),
      });
      if (tgRes.ok) {
        setTgRecSuccess(vapiCallId);
        setTimeout(() => setTgRecSuccess(null), 3000);
      }
    } catch { /* ignore */ }
    setSendingTgRec(null);
  }

  // ── Helpers ──

  function getAssistantName(id: string) {
    return assistants.find((a) => a.id === id)?.name || id.slice(0, 8) + '...';
  }

  // ── Render ──

  if (loading || loadingCampaigns) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Загрузка...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{campaigns.length} кампаний</p>
        <button
          onClick={() => { setShowCreate(true); setError(''); setParsedContacts([]); }}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Новая кампания
        </button>
      </div>

      {/* Running indicator (server-driven) */}
      {campaigns.filter((c) => c.status === 'running').map((camp) => (
        <div key={camp.id} className="rounded-xl bg-green-50 border border-green-200 px-5 py-4 flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-green-600" />
          <div>
            <p className="text-sm font-medium text-green-800">
              Обзвон идёт: {camp.name}
            </p>
            <p className="text-xs text-green-600 mt-0.5">
              {camp.called_contacts}/{camp.total_contacts} контактов, {camp.successful_contacts} успешных
            </p>
          </div>
          <button
            onClick={() => pauseCampaign(camp.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-yellow-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600"
          >
            <Pause className="h-3.5 w-3.5" />
            Пауза
          </button>
        </div>
      ))}

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50/30 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Новая кампания</h3>
            <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Название кампании</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Обзвон ресторанов Москва"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ассистент</label>
              <select
                value={effectiveAssistant}
                onChange={(e) => setFormAssistant(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              >
                {assistants.map((a) => (
                  <option key={a.id} value={a.id}>{a.name || a.id}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Звонить с номера</label>
              <select
                value={effectivePhone}
                onChange={(e) => setFormPhone(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              >
                {phoneNumbers.map((p) => (
                  <option key={p.id} value={p.id}>{p.number || p.name || p.id}</option>
                ))}
              </select>
            </div>
          </div>

          {/* CSV Upload */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Загрузить базу контактов (CSV)
            </label>
            <p className="text-xs text-gray-400 mb-2">
              Колонки: телефон (обязательно), компания, имя, email. AI будет использовать имя и компанию при звонке.
            </p>
            <label className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors">
              <FileSpreadsheet className="h-4 w-4" />
              Выбрать CSV файл
              <input
                type="file"
                accept=".csv,.tsv,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCsvUpload(file);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {/* Parsed preview */}
          {parsedContacts.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-sm font-medium text-gray-700 mb-2">
                Загружено: {parsedContacts.length} контактов
              </p>
              <div className="max-h-40 overflow-y-auto text-xs space-y-1">
                {parsedContacts.slice(0, 10).map((c, i) => (
                  <div key={i} className="flex gap-4 text-gray-600">
                    <span className="font-mono">{c.phone}</span>
                    {c.company && <span>{c.company}</span>}
                    {c.name && <span className="text-gray-400">{c.name}</span>}
                  </div>
                ))}
                {parsedContacts.length > 10 && (
                  <p className="text-gray-400">...и ещё {parsedContacts.length - 10}</p>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={createCampaign}
              disabled={creating || !formName.trim() || !parsedContacts.length}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Создать кампанию
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Campaigns List */}
      {campaigns.length === 0 && !showCreate ? (
        <div className="text-center py-16 text-gray-400">
          <Users className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Нет кампаний. Создайте первую и загрузите CSV с контактами.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((camp) => {
            const isExpanded = expandedId === camp.id;
            const progress = camp.total_contacts > 0
              ? Math.round((camp.called_contacts / camp.total_contacts) * 100)
              : 0;
            const statusInfo = STATUS_LABELS[camp.status] || { label: camp.status, color: 'bg-gray-100 text-gray-600' };

            return (
              <div key={camp.id} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                <div
                  className="flex items-center gap-4 px-6 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => loadContacts(camp.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h4 className="font-medium text-gray-900 truncate">{camp.name}</h4>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusInfo.color}`}>
                        {statusInfo.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400 mt-1">
                      <span>{getAssistantName(camp.assistant_id)}</span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {camp.called_contacts}/{camp.total_contacts}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <CheckCircle className="h-3 w-3" />
                        {camp.successful_contacts} усп.
                      </span>
                    </div>
                    {/* Progress bar */}
                    <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden w-48">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {camp.status === 'draft' || camp.status === 'paused' ? (
                      <button
                        onClick={() => startCampaign(camp.id)}
                        className="p-2 rounded-lg text-green-600 hover:bg-green-50"
                        title="Запустить"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                    ) : camp.status === 'running' ? (
                      <button
                        onClick={() => pauseCampaign(camp.id)}
                        className="p-2 rounded-lg text-yellow-600 hover:bg-yellow-50"
                        title="Пауза"
                      >
                        <Pause className="h-4 w-4" />
                      </button>
                    ) : null}
                    <button
                      onClick={() => deleteCampaign(camp.id)}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                      title="Удалить"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                  </div>
                </div>

                {/* Expanded contacts */}
                {isExpanded && (
                  <div className="border-t border-gray-100 px-6 py-4 bg-gray-50/50">
                    {loadingContacts ? (
                      <div className="flex items-center gap-2 py-4 justify-center text-gray-400">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-sm">Загрузка контактов...</span>
                      </div>
                    ) : (
                      <div className="max-h-64 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="text-gray-500 uppercase">
                            <tr>
                              <th className="text-left py-1 pr-4">Телефон</th>
                              <th className="text-left py-1 pr-4">Компания</th>
                              <th className="text-left py-1 pr-4">Статус</th>
                              <th className="text-right py-1 pr-4">Длит.</th>
                              <th className="text-center py-1 w-20">Запись</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {contacts.map((c) => {
                              const isPlaying = playingCallId === c.vapi_call_id;
                              const isLoadingRec = loadingAudio === c.vapi_call_id;
                              const canPlay = c.status === 'completed' && c.vapi_call_id;

                              return (
                              <tr key={c.id} className="text-gray-600">
                                <td className="py-1.5 pr-4 font-mono">{c.phone_number}</td>
                                <td className="py-1.5 pr-4">{c.company_name || '—'}</td>
                                <td className="py-1.5 pr-4">
                                  <span className={`inline-flex items-center gap-1 ${
                                    c.status === 'completed' ? 'text-green-600' :
                                    c.status === 'failed' ? 'text-red-500' :
                                    c.status === 'calling' ? 'text-blue-500' :
                                    'text-gray-400'
                                  }`}>
                                    {c.status === 'calling' && <Loader2 className="h-3 w-3 animate-spin" />}
                                    {c.status === 'completed' && <CheckCircle className="h-3 w-3" />}
                                    {c.status === 'failed' && <XCircle className="h-3 w-3" />}
                                    {c.status === 'pending' ? 'Ожидает' :
                                     c.status === 'calling' ? 'Звоним' :
                                     c.status === 'completed' ? 'Готово' :
                                     c.status === 'failed' ? 'Ошибка' : c.status}
                                  </span>
                                </td>
                                <td className="py-1.5 text-right pr-4">
                                  {c.call_duration ? `${Math.floor(c.call_duration / 60)}:${(c.call_duration % 60).toString().padStart(2, '0')}` : '—'}
                                </td>
                                <td className="py-1.5 text-center">
                                  {canPlay ? (
                                    <div className="inline-flex items-center gap-0.5">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); playRecording(c.vapi_call_id!); }}
                                        className={`p-1 rounded-md transition-colors ${
                                          isPlaying
                                            ? 'text-blue-600 bg-blue-100 hover:bg-blue-200'
                                            : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
                                        }`}
                                        title={isPlaying ? 'Остановить' : 'Прослушать запись'}
                                      >
                                        {isLoadingRec
                                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                          : isPlaying
                                            ? <Square className="h-3.5 w-3.5" />
                                            : <Volume2 className="h-3.5 w-3.5" />}
                                      </button>
                                      {tgChats.length > 0 && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            sendRecordingToTelegram(c.vapi_call_id!, c.phone_number, tgChats[0].id);
                                          }}
                                          disabled={sendingTgRec === c.vapi_call_id}
                                          className="p-1 rounded-md text-gray-400 hover:text-purple-600 hover:bg-purple-50 transition-colors disabled:opacity-50"
                                          title={`Отправить запись в Telegram (${tgChats[0].title})`}
                                        >
                                          {sendingTgRec === c.vapi_call_id
                                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            : tgRecSuccess === c.vapi_call_id
                                              ? <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                                              : <Mic className="h-3.5 w-3.5" />}
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
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
