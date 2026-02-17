'use client';

import { useState, useCallback, useRef } from 'react';
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

  // Running campaign
  const [runningCampaignId, setRunningCampaignId] = useState<string | null>(null);
  const [currentContact, setCurrentContact] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const campaignsLoaded = useRef<boolean | null>(null);

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

  // Initial load via ref guard
  if (campaignsLoaded.current == null) {
    campaignsLoaded.current = true;
    fetchCampaigns();
  }

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
      if (!res.ok) { setError(data.error || 'Ошибка'); setCreating(false); return; }

      setShowCreate(false);
      setFormName('');
      setParsedContacts([]);
      fetchCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
    setCreating(false);
  }

  // ── Run Campaign ──

  async function startCampaign(id: string) {
    const token = await getToken();
    await fetch(`/api/ai-caller/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'running' }),
    });
    setRunningCampaignId(id);
    callNext(id);
    fetchCampaigns();
  }

  async function pauseCampaign(id: string) {
    const token = await getToken();
    await fetch(`/api/ai-caller/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'paused' }),
    });
    setRunningCampaignId(null);
    setCurrentContact(null);
    if (pollRef.current) clearTimeout(pollRef.current);
    fetchCampaigns();
  }

  async function autoAnalyzeCampaign(campaignId: string) {
    try {
      const token = await getToken();
      console.log('[Campaign] Auto-analyzing calls for campaign', campaignId);
      const res = await fetch('/api/ai-caller/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ campaignId }),
      });
      const result = await res.json();
      console.log(`[Campaign] Auto-analysis complete: ${result.newlyAnalyzed ?? 0} new analyses`);
    } catch (err) {
      console.error('[Campaign] Auto-analysis failed:', err);
    }
  }

  async function callNext(campaignId: string) {
    let token: string;
    try {
      token = await getToken();
    } catch {
      console.error('[Campaign] Failed to get auth token, stopping');
      setRunningCampaignId(null);
      setCurrentContact(null);
      return;
    }

    let data: Record<string, unknown>;
    try {
      const res = await fetch(`/api/ai-caller/campaigns/${campaignId}/call-next`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      data = await res.json();
    } catch (err) {
      console.error('[Campaign] call-next request failed:', err);
      setTimeout(() => callNext(campaignId), 5000);
      return;
    }

    if (data.done) {
      setRunningCampaignId(null);
      setCurrentContact(null);
      fetchCampaigns();
      // Auto-analyze all calls for this campaign
      autoAnalyzeCampaign(campaignId);
      return;
    }

    if (data.error) {
      console.warn('[Campaign] call-next error, skipping:', data.error);
      setTimeout(() => callNext(campaignId), 2000);
      return;
    }

    const contact = data.contact as { id: string; phone: string } | undefined;
    const callId = data.callId as string | undefined;

    setCurrentContact(contact?.phone || null);

    if (!callId) {
      console.error('[Campaign] No callId returned, skipping contact');
      setTimeout(() => callNext(campaignId), 2000);
      return;
    }

    // Poll with recursive setTimeout (avoids overlapping async callbacks)
    const TERMINAL_STATUSES = new Set(['ended', 'failed']);
    const MAX_POLL_MS = 120_000; // 2 min max per call
    const POLL_INTERVAL_MS = 3000;
    const pollStarted = Date.now();
    let pollErrors = 0;
    let stopped = false;

    async function completeAndNext() {
      stopped = true;
      // Mark contact as completed
      try {
        await fetch(`/api/ai-caller/campaigns/${campaignId}/complete-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` },
          body: JSON.stringify({ contactId: contact?.id, callId }),
        });
      } catch (err) {
        console.error('[Campaign] complete-contact failed:', err);
      }

      setCurrentContact(null);
      fetchCampaigns();

      // Check if campaign is still running before proceeding
      try {
        const campRes = await fetch(`/api/ai-caller/campaigns/${campaignId}`, {
          headers: { Authorization: `Bearer ${await getToken()}` },
        });
        const campData = await campRes.json();
        if (campData.campaign?.status === 'running') {
          setTimeout(() => callNext(campaignId), 3000);
        } else {
          setRunningCampaignId(null);
        }
      } catch {
        setTimeout(() => callNext(campaignId), 3000);
      }
    }

    async function poll() {
      if (stopped) return;

      const elapsed = Date.now() - pollStarted;

      // Timeout — skip this contact and move on
      if (elapsed > MAX_POLL_MS) {
        console.warn(`[Campaign] Call ${callId} timed out after ${elapsed}ms, moving on`);
        await completeAndNext();
        return;
      }

      let callData: Record<string, unknown>;
      try {
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 10_000);
        const callRes = await fetch(`/api/ai-caller/calls/${callId}`, {
          headers: { Authorization: `Bearer ${await getToken()}` },
          signal: controller.signal,
        });
        clearTimeout(fetchTimeout);
        if (!callRes.ok) throw new Error(`HTTP ${callRes.status}`);
        callData = await callRes.json();
        pollErrors = 0;
      } catch (err) {
        pollErrors++;
        console.warn(`[Campaign] Poll error #${pollErrors}:`, err);
        if (pollErrors >= 5) {
          console.error('[Campaign] Too many poll errors, skipping contact');
          await completeAndNext();
          return;
        }
        // Retry after delay
        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      const call = callData.call as Record<string, unknown> | undefined;
      const status = (call?.status as string) ?? '';

      if (TERMINAL_STATUSES.has(status)) {
        await completeAndNext();
      } else {
        // Schedule next poll
        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    // Start polling
    pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
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

      {/* Running indicator */}
      {runningCampaignId && (
        <div className="rounded-xl bg-green-50 border border-green-200 px-5 py-4 flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-green-600" />
          <div>
            <p className="text-sm font-medium text-green-800">Обзвон идёт...</p>
            {currentContact && (
              <p className="text-xs text-green-600 mt-0.5">
                Звоним: {currentContact}
              </p>
            )}
          </div>
          <button
            onClick={() => pauseCampaign(runningCampaignId)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-yellow-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600"
          >
            <Pause className="h-3.5 w-3.5" />
            Пауза
          </button>
        </div>
      )}

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
            <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
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
              Колонки: телефон (обязательно), компания, имя, email. Разделитель: запятая, точка с запятой или табуляция.
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
                        disabled={!!runningCampaignId}
                        className="p-2 rounded-lg text-green-600 hover:bg-green-50 disabled:opacity-50"
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
                              <th className="text-left py-1 pr-4">Контакт</th>
                              <th className="text-left py-1 pr-4">Статус</th>
                              <th className="text-right py-1">Длит.</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {contacts.map((c) => (
                              <tr key={c.id} className="text-gray-600">
                                <td className="py-1.5 pr-4 font-mono">{c.phone_number}</td>
                                <td className="py-1.5 pr-4">{c.company_name || '—'}</td>
                                <td className="py-1.5 pr-4">{c.contact_name || '—'}</td>
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
                                <td className="py-1.5 text-right">
                                  {c.call_duration ? `${Math.floor(c.call_duration / 60)}:${(c.call_duration % 60).toString().padStart(2, '0')}` : '—'}
                                </td>
                              </tr>
                            ))}
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
