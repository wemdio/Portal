'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, MessageSquareText, Play, RefreshCw, Save, Square, Trash2 } from 'lucide-react';
import { authFetchJson } from '@/lib/authFetch';

type Tab = 'campaigns' | 'leads' | 'dialogs' | 'logs' | 'settings';

type Settings = {
  linkedin_email: string;
  linkedin_password: string;
  llm_provider: string;
  llm_api_key: string;
  ai_model: string;
  llm_api_base: string;
  proxy_url: string;
  connect_daily_limit: number;
  connect_weekly_limit: number;
  follow_up_daily_limit: number;
  legal_accepted: boolean;
};

type Campaign = {
  id: string;
  name: string;
  product_description: string;
  target_market: string;
  campaign_objective: string;
  booking_link: string;
  seed_profile_urls: string;
  status: string;
  runtime_status: string;
  stats: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  error_message: string | null;
};

type Lead = {
  id: string;
  campaign_id: string | null;
  profile_url: string | null;
  name: string;
  position: string | null;
  company: string | null;
  state: string;
  qualification_score: number | null;
  qualification_reason: string | null;
  last_activity_at: string | null;
  updated_at: string;
};

type Message = {
  id: string;
  direction: 'inbound' | 'outbound' | 'system';
  content: string;
  sent_at: string;
};

type LogRow = {
  id: number;
  campaign_id: string | null;
  level: 'info' | 'warning' | 'error';
  message: string;
  created_at: string;
};

const API = '/api/tools/li-outreach-v2';

const DEFAULT_SETTINGS: Settings = {
  linkedin_email: '',
  linkedin_password: '',
  llm_provider: 'openai',
  llm_api_key: '',
  ai_model: 'gpt-4o-mini',
  llm_api_base: '',
  proxy_url: '',
  connect_daily_limit: 20,
  connect_weekly_limit: 100,
  follow_up_daily_limit: 25,
  legal_accepted: false,
};

const DEFAULT_CAMPAIGN = {
  name: '',
  product_description: '',
  target_market: '',
  campaign_objective: '',
  booking_link: '',
  seed_profile_urls: '',
};

function formatDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function stateLabel(state: string) {
  const map: Record<string, string> = {
    discovered: 'Найден',
    qualified: 'Квалифицирован',
    ready_to_connect: 'Готов к инвайту',
    pending: 'Инвайт отправлен',
    connected: 'В контактах',
    completed: 'Завершен',
    failed: 'Ошибка',
  };
  return map[state] ?? state;
}

async function api<T>(path: string, init?: RequestInit & { json?: unknown }) {
  return authFetchJson<T>(`${API}${path}`, {
    ...init,
    body: init?.json ? JSON.stringify(init.json) : init?.body,
  });
}

export default function LiOutreachV2Page() {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [campaignForm, setCampaignForm] = useState(DEFAULT_CAMPAIGN);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyCampaignId, setBusyCampaignId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const selectedCampaign = useMemo(
    () => campaigns.find((c) => c.id === selectedCampaignId) ?? campaigns[0] ?? null,
    [campaigns, selectedCampaignId],
  );
  const activeCampaignId = selectedCampaign?.id ?? '';
  const visibleLeads = useMemo(
    () => leads.filter((lead) => !activeCampaignId || lead.campaign_id === activeCampaignId),
    [activeCampaignId, leads],
  );
  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? visibleLeads[0] ?? null,
    [leads, selectedLeadId, visibleLeads],
  );
  const activeLeadId = selectedLead?.id ?? '';

  const loadSettings = useCallback(async () => {
    const data = await api<{ settings: Partial<Settings> | null }>('/settings');
    if (data.settings) setSettings({ ...DEFAULT_SETTINGS, ...data.settings });
  }, []);

  const loadCampaigns = useCallback(async () => {
    const data = await api<{ campaigns: Campaign[] }>('/campaigns');
    setCampaigns(data.campaigns);
    if (!selectedCampaignId && data.campaigns[0]) setSelectedCampaignId(data.campaigns[0].id);
  }, [selectedCampaignId]);

  const loadLeads = useCallback(async () => {
    const params = activeCampaignId ? `?campaign_id=${encodeURIComponent(activeCampaignId)}&limit=200` : '?limit=200';
    const data = await api<{ leads: Lead[] }>(`/leads${params}`);
    setLeads(data.leads);
    if (!selectedLeadId && data.leads[0]) setSelectedLeadId(data.leads[0].id);
  }, [activeCampaignId, selectedLeadId]);

  const loadLogs = useCallback(async () => {
    const params = activeCampaignId ? `?campaign_id=${encodeURIComponent(activeCampaignId)}&limit=150` : '?limit=150';
    const data = await api<{ logs: LogRow[] }>(`/logs${params}`);
    setLogs(data.logs);
  }, [activeCampaignId]);

  const loadMessages = useCallback(async () => {
    if (!activeLeadId) {
      setMessages([]);
      return;
    }
    const data = await api<{ messages: Message[] }>(`/leads/${activeLeadId}/messages`);
    setMessages(data.messages);
  }, [activeLeadId]);

  const refreshAll = useCallback(async () => {
    setError('');
    try {
      await Promise.all([loadSettings(), loadCampaigns()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    }
  }, [loadCampaigns, loadSettings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void refreshAll(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [refreshAll]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadLeads(); void loadLogs(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadLeads, loadLogs]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadMessages(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadMessages]);

  async function saveSettings() {
    setSaving(true);
    setError('');
    try {
      const data = await api<{ settings: Settings }>('/settings', { method: 'PUT', json: settings });
      setSettings({ ...DEFAULT_SETTINGS, ...data.settings });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  async function createCampaign() {
    setSaving(true);
    setError('');
    try {
      const data = await api<{ campaign: Campaign }>('/campaigns', { method: 'POST', json: campaignForm });
      setCampaigns((items) => [data.campaign, ...items]);
      setSelectedCampaignId(data.campaign.id);
      setCampaignForm(DEFAULT_CAMPAIGN);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка создания кампании');
    } finally {
      setSaving(false);
    }
  }

  async function startCampaign(id: string) {
    setBusyCampaignId(id);
    setError('');
    try {
      await api(`/campaigns/${id}/start`, { method: 'POST', json: {} });
      await Promise.all([loadCampaigns(), loadLogs()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запуска');
    } finally {
      setBusyCampaignId(null);
    }
  }

  async function stopCampaign(id: string) {
    setBusyCampaignId(id);
    setError('');
    try {
      await api(`/campaigns/${id}/stop`, { method: 'POST', json: {} });
      await Promise.all([loadCampaigns(), loadLogs()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка остановки');
    } finally {
      setBusyCampaignId(null);
    }
  }

  async function deleteCampaign(id: string) {
    if (!confirm('Удалить кампанию LinkedIn Outreach 2.0?')) return;
    await api(`/campaigns/${id}`, { method: 'DELETE' });
    setCampaigns((items) => items.filter((item) => item.id !== id));
    if (selectedCampaignId === id) setSelectedCampaignId('');
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'campaigns', label: 'Кампании' },
    { key: 'leads', label: 'Лиды' },
    { key: 'dialogs', label: 'Переписка' },
    { key: 'logs', label: 'Логи' },
    { key: 'settings', label: 'Настройки' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">LinkedIn Outreach 2.0</h1>
            <p className="text-sm text-gray-500">OpenOutreach runtime в Portal</p>
          </div>
          <button
            onClick={() => void refreshAll()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Обновить
          </button>
        </header>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-4">
          <Stat label="Кампании" value={campaigns.length} />
          <Stat label="В работе" value={campaigns.filter((c) => ['queued', 'running'].includes(c.status)).length} />
          <Stat label="Лиды" value={leads.length} />
          <Stat label="Диалоги" value={leads.filter((l) => ['connected', 'completed'].includes(l.state)).length} />
        </div>

        <nav className="flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === item.key ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'}`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {tab === 'campaigns' && (
          <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
            <section className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="text-base font-semibold text-gray-900">Новая кампания</h2>
              <div className="mt-4 space-y-3">
                <Input label="Название" value={campaignForm.name} onChange={(v) => setCampaignForm({ ...campaignForm, name: v })} />
                <TextArea label="Описание продукта" value={campaignForm.product_description} onChange={(v) => setCampaignForm({ ...campaignForm, product_description: v })} rows={4} />
                <TextArea label="Целевой рынок / ICP" value={campaignForm.target_market} onChange={(v) => setCampaignForm({ ...campaignForm, target_market: v })} rows={4} />
                <TextArea label="Цель кампании" value={campaignForm.campaign_objective} onChange={(v) => setCampaignForm({ ...campaignForm, campaign_objective: v })} rows={3} />
                <Input label="Ссылка для бронирования" value={campaignForm.booking_link} onChange={(v) => setCampaignForm({ ...campaignForm, booking_link: v })} />
                <TextArea label="Seed LinkedIn profiles" value={campaignForm.seed_profile_urls} onChange={(v) => setCampaignForm({ ...campaignForm, seed_profile_urls: v })} rows={3} />
                <button
                  onClick={() => void createCampaign()}
                  disabled={saving}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Bot className="h-4 w-4" />
                  Создать
                </button>
              </div>
            </section>

            <section className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-200 px-5 py-4">
                <h2 className="text-base font-semibold text-gray-900">Кампании</h2>
              </div>
              <div className="divide-y divide-gray-100">
                {campaigns.length === 0 ? (
                  <div className="p-6 text-sm text-gray-500">Нет кампаний</div>
                ) : campaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    className={`p-5 ${selectedCampaign?.id === campaign.id ? 'bg-emerald-50/60' : 'bg-white'}`}
                    onClick={() => setSelectedCampaignId(campaign.id)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-gray-900">{campaign.name}</div>
                        <div className="mt-1 text-xs text-gray-500">{campaign.status} / {campaign.runtime_status}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!['queued', 'running'].includes(campaign.status) ? (
                          <button onClick={(e) => { e.stopPropagation(); void startCampaign(campaign.id); }} disabled={busyCampaignId === campaign.id} className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white">
                            <Play className="h-3.5 w-3.5" />
                            Старт
                          </button>
                        ) : (
                          <button onClick={(e) => { e.stopPropagation(); void stopCampaign(campaign.id); }} disabled={busyCampaignId === campaign.id} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700">
                            <Square className="h-3.5 w-3.5" />
                            Стоп
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); void deleteCampaign(campaign.id); }} className="rounded-lg border border-gray-200 bg-white p-1.5 text-gray-500 hover:text-red-600">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm text-gray-600">{campaign.target_market}</p>
                    <div className="mt-3 text-xs text-gray-400">Создана {formatDate(campaign.created_at)}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === 'leads' && (
          <DataShell selectedCampaign={selectedCampaign} campaigns={campaigns} onCampaignChange={setSelectedCampaignId}>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100 text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Лид</th>
                    <th className="px-4 py-3 text-left font-medium">Компания</th>
                    <th className="px-4 py-3 text-left font-medium">Статус</th>
                    <th className="px-4 py-3 text-left font-medium">Score</th>
                    <th className="px-4 py-3 text-left font-medium">Активность</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {visibleLeads.map((lead) => (
                    <tr key={lead.id} className="cursor-pointer hover:bg-gray-50" onClick={() => { setSelectedLeadId(lead.id); setTab('dialogs'); }}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{lead.name || lead.profile_url || 'Без имени'}</div>
                        <div className="text-xs text-gray-500">{lead.position || '—'}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{lead.company || '—'}</td>
                      <td className="px-4 py-3"><span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{stateLabel(lead.state)}</span></td>
                      <td className="px-4 py-3 text-gray-700">{lead.qualification_score ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-500">{formatDate(lead.last_activity_at ?? lead.updated_at)}</td>
                    </tr>
                  ))}
                  {visibleLeads.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">Пока нет лидов</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </DataShell>
        )}

        {tab === 'dialogs' && (
          <DataShell selectedCampaign={selectedCampaign} campaigns={campaigns} onCampaignChange={setSelectedCampaignId}>
            <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                {visibleLeads.map((lead) => (
                  <button key={lead.id} onClick={() => setSelectedLeadId(lead.id)} className={`block w-full px-4 py-3 text-left ${selectedLead?.id === lead.id ? 'bg-emerald-50' : 'hover:bg-gray-50'}`}>
                    <div className="font-medium text-gray-900">{lead.name || 'Без имени'}</div>
                    <div className="truncate text-xs text-gray-500">{lead.company || lead.profile_url || '—'}</div>
                  </button>
                ))}
                {visibleLeads.length === 0 && <div className="p-5 text-sm text-gray-500">Нет лидов</div>}
              </div>
              <div className="rounded-lg border border-gray-200 bg-white">
                <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-4">
                  <MessageSquareText className="h-4 w-4 text-gray-500" />
                  <div className="font-semibold text-gray-900">{selectedLead?.name ?? 'Переписка'}</div>
                </div>
                <div className="max-h-[560px] space-y-3 overflow-y-auto p-5">
                  {messages.map((message) => (
                    <div key={message.id} className={`max-w-[78%] rounded-lg px-3 py-2 text-sm ${message.direction === 'outbound' ? 'ml-auto bg-gray-900 text-white' : message.direction === 'inbound' ? 'bg-emerald-50 text-gray-900' : 'bg-gray-100 text-gray-600'}`}>
                      <div>{message.content}</div>
                      <div className={`mt-1 text-[11px] ${message.direction === 'outbound' ? 'text-gray-300' : 'text-gray-400'}`}>{formatDate(message.sent_at)}</div>
                    </div>
                  ))}
                  {messages.length === 0 && <div className="text-sm text-gray-500">История пустая</div>}
                </div>
              </div>
            </div>
          </DataShell>
        )}

        {tab === 'logs' && (
          <DataShell selectedCampaign={selectedCampaign} campaigns={campaigns} onCampaignChange={setSelectedCampaignId}>
            <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-3 px-5 py-3 text-sm">
                  <span className={`w-16 shrink-0 font-medium ${log.level === 'error' ? 'text-red-600' : log.level === 'warning' ? 'text-amber-600' : 'text-gray-500'}`}>{log.level}</span>
                  <span className="flex-1 text-gray-800">{log.message}</span>
                  <span className="shrink-0 text-xs text-gray-400">{formatDate(log.created_at)}</span>
                </div>
              ))}
              {logs.length === 0 && <div className="p-6 text-sm text-gray-500">Логов нет</div>}
            </div>
          </DataShell>
        )}

        {tab === 'settings' && (
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Настройки OpenOutreach</h2>
              <button onClick={() => void saveSettings()} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                <Save className="h-4 w-4" />
                Сохранить
              </button>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Input label="LinkedIn email" value={settings.linkedin_email} onChange={(v) => setSettings({ ...settings, linkedin_email: v })} />
              <Input label="LinkedIn password" type="password" value={settings.linkedin_password} onChange={(v) => setSettings({ ...settings, linkedin_password: v })} />
              <Select label="LLM provider" value={settings.llm_provider} onChange={(v) => setSettings({ ...settings, llm_provider: v })} options={['openai', 'anthropic', 'google', 'groq', 'mistral', 'cohere', 'openai_compatible']} />
              <Input label="AI model" value={settings.ai_model} onChange={(v) => setSettings({ ...settings, ai_model: v })} />
              <Input label="LLM API key" type="password" value={settings.llm_api_key} onChange={(v) => setSettings({ ...settings, llm_api_key: v })} />
              <Input label="LLM API base" value={settings.llm_api_base} onChange={(v) => setSettings({ ...settings, llm_api_base: v })} />
              <Input label="Proxy / VPN URL" value={settings.proxy_url} onChange={(v) => setSettings({ ...settings, proxy_url: v })} />
              <div className="grid grid-cols-3 gap-3">
                <NumberInput label="Invite/day" value={settings.connect_daily_limit} onChange={(v) => setSettings({ ...settings, connect_daily_limit: v })} />
                <NumberInput label="Invite/week" value={settings.connect_weekly_limit} onChange={(v) => setSettings({ ...settings, connect_weekly_limit: v })} />
                <NumberInput label="Follow-up/day" value={settings.follow_up_daily_limit} onChange={(v) => setSettings({ ...settings, follow_up_daily_limit: v })} />
              </div>
              <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700">
                <input type="checkbox" checked={settings.legal_accepted} onChange={(e) => setSettings({ ...settings, legal_accepted: e.target.checked })} />
                Принимаю риски LinkedIn automation
              </label>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function DataShell({ children, selectedCampaign, campaigns, onCampaignChange }: { children: ReactNode; selectedCampaign: Campaign | null; campaigns: Campaign[]; onCampaignChange: (id: string) => void }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <span className="text-sm font-medium text-gray-700">Кампания</span>
        <select value={selectedCampaign?.id ?? ''} onChange={(e) => onCampaignChange(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
        </select>
      </div>
      {children}
    </section>
  );
}

function Input({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-400" />
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <input type="number" min={0} value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-400" />
    </label>
  );
}

function TextArea({ label, value, onChange, rows }: { label: string; value: string; onChange: (value: string) => void; rows: number }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <textarea value={value} rows={rows} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-400" />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-400">
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}
