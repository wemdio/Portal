'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, MessageSquareText, Play, RefreshCw, RotateCcw, Save, Square, Trash2 } from 'lucide-react';
import { authFetchJson } from '@/lib/authFetch';
import { V2_DEFAULT_PROMPTS, type V2PromptKey } from '@/lib/liOutreach/v2DefaultPrompts';

type Tab = 'campaigns' | 'leads' | 'dialogs' | 'logs' | 'settings';

type Settings = {
  linkedin_email: string;
  linkedin_password: string;
  connect_daily_limit: number;
  connect_weekly_limit: number;
  follow_up_daily_limit: number;
  legal_accepted: boolean;
  /** OpenOutreach follow_up_agent.j2 override. Empty = use upstream default. */
  prompt_follow_up_agent: string;
  /** OpenOutreach qualify_lead.j2 override. Empty = use upstream default. */
  prompt_qualify_lead: string;
  /** OpenOutreach search_keywords.j2 override. Empty = use upstream default. */
  prompt_search_keywords: string;
};

type Campaign = {
  id: string;
  name: string;
  product_description: string;
  target_market: string;
  campaign_objective: string;
  seed_profile_urls: string;
  /** Window(s) during which the bot is allowed to send invites and replies. */
  working_hours: string[];
  /** Hours from UTC, e.g. 3 for MSK. Compared against `working_hours`. */
  timezone_offset: number;
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

type Account = {
  id: string;
  status: 'stopped' | 'running' | 'needs_captcha' | 'disconnected';
  runtime_status: string;
  last_error: string | null;
  last_heartbeat_at: string | null;
  updated_at: string;
};

const ACCOUNT_STATUS_LABEL: Record<Account['status'], string> = {
  stopped: 'Остановлен',
  running: 'Работает',
  needs_captcha: 'Нужна CAPTCHA',
  disconnected: 'Отключён',
};

const API = '/api/tools/li-outreach-v2';

const DEFAULT_SETTINGS: Settings = {
  linkedin_email: '',
  linkedin_password: '',
  connect_daily_limit: 20,
  connect_weekly_limit: 100,
  follow_up_daily_limit: 25,
  legal_accepted: false,
  // Seed the textareas with the upstream OpenOutreach defaults so users see
  // the actual prompt the worker would use. When DB has an empty string the
  // start route falls back to the same default, so what the user sees here
  // matches what the worker receives.
  prompt_follow_up_agent: V2_DEFAULT_PROMPTS.follow_up_agent,
  prompt_qualify_lead: V2_DEFAULT_PROMPTS.qualify_lead,
  prompt_search_keywords: V2_DEFAULT_PROMPTS.search_keywords,
};

const DEFAULT_CAMPAIGN = {
  name: '',
  product_description: '',
  target_market: '',
  campaign_objective: '',
  seed_profile_urls: '',
  // Same format as TG sleep_periods but inverted in meaning — when the bot is
  // ALLOWED to send. Comma-separated to support a lunch break, e.g.
  // "09:00-12:00, 14:00-18:00".
  working_hours: '09:00-18:00',
  timezone_offset: 3,
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
  const [account, setAccount] = useState<Account | null>(null);
  const [resuming, setResuming] = useState(false);

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
    if (!data.settings) return;
    // Plain spread would let empty-string prompts from DB clobber the
    // upstream defaults. Per-prompt fallback keeps "не редактировал" rows
    // showing the actual default text in the textarea.
    const loaded = data.settings;
    setSettings({
      ...DEFAULT_SETTINGS,
      ...loaded,
      prompt_follow_up_agent: loaded.prompt_follow_up_agent?.trim() || V2_DEFAULT_PROMPTS.follow_up_agent,
      prompt_qualify_lead:    loaded.prompt_qualify_lead?.trim()    || V2_DEFAULT_PROMPTS.qualify_lead,
      prompt_search_keywords: loaded.prompt_search_keywords?.trim() || V2_DEFAULT_PROMPTS.search_keywords,
    });
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

  const loadAccount = useCallback(async () => {
    const data = await api<{ account: Account | null }>('/accounts');
    setAccount(data.account);
  }, []);

  const refreshAll = useCallback(async () => {
    setError('');
    try {
      await Promise.all([loadSettings(), loadCampaigns(), loadAccount()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    }
  }, [loadAccount, loadCampaigns, loadSettings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void refreshAll(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [refreshAll]);
  // Поллим статус аккаунта — чтобы needs_captcha/disconnected всплывали без
  // ручного «Обновить» (оператор должен быстро узнать, что аккаунт встал).
  useEffect(() => {
    const interval = window.setInterval(() => { void loadAccount(); }, 15000);
    return () => window.clearInterval(interval);
  }, [loadAccount]);

  async function resumeFromCaptcha() {
    setResuming(true);
    setError('');
    try {
      await api('/accounts/resume-from-captcha', { method: 'POST', json: {} });
      await loadAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка возобновления');
    } finally {
      setResuming(false);
    }
  }
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
      // Strip prompts that exactly match the upstream default before saving —
      // we want "user has not customised this slot" to round-trip as empty in
      // the DB so future upstream changes can take effect without each user
      // resetting their copy. The start route falls back to the same default
      // when the column is empty, so payload behaviour is identical.
      const toSave = {
        ...settings,
        prompt_follow_up_agent: settings.prompt_follow_up_agent === V2_DEFAULT_PROMPTS.follow_up_agent ? '' : settings.prompt_follow_up_agent,
        prompt_qualify_lead:    settings.prompt_qualify_lead    === V2_DEFAULT_PROMPTS.qualify_lead    ? '' : settings.prompt_qualify_lead,
        prompt_search_keywords: settings.prompt_search_keywords === V2_DEFAULT_PROMPTS.search_keywords ? '' : settings.prompt_search_keywords,
      };
      await api<{ settings: Settings }>('/settings', { method: 'PUT', json: toSave });
      // Don't trust the server's echo: it stores the stripped-empty value but
      // the UI still wants to show the default in the textarea. Refetch via
      // loadSettings so the per-prompt fallback re-applies.
      await loadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  function resetPromptToDefault(key: V2PromptKey) {
    setSettings((current) => ({
      ...current,
      [`prompt_${key}`]: V2_DEFAULT_PROMPTS[key],
    }));
  }

  async function createCampaign() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...campaignForm,
        // UI keeps working_hours as a comma-separated string for editing;
        // the API normalizer accepts both string and array.
        working_hours: campaignForm.working_hours
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        timezone_offset: campaignForm.timezone_offset,
      };
      const data = await api<{ campaign: Campaign }>('/campaigns', { method: 'POST', json: payload });
      setCampaigns((items) => [data.campaign, ...items]);
      setSelectedCampaignId(data.campaign.id);
      setCampaignForm(DEFAULT_CAMPAIGN);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка создания кампании');
    } finally {
      setSaving(false);
    }
  }

  async function updateCampaignSchedule(id: string, workingHours: string, timezoneOffset: number) {
    setBusyCampaignId(id);
    setError('');
    try {
      const data = await api<{ campaign: Campaign }>(`/campaigns/${id}`, {
        method: 'PATCH',
        json: {
          working_hours: workingHours
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          timezone_offset: timezoneOffset,
        },
      });
      setCampaigns((items) => items.map((item) => (item.id === id ? data.campaign : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения расписания');
    } finally {
      setBusyCampaignId(null);
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
            <p className="flex items-center gap-2 text-sm text-gray-500">
              OpenOutreach runtime в Portal
              {account && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    account.status === 'running'
                      ? 'bg-emerald-100 text-emerald-700'
                      : account.status === 'needs_captcha'
                        ? 'bg-amber-100 text-amber-700'
                        : account.status === 'disconnected'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  Аккаунт: {ACCOUNT_STATUS_LABEL[account.status]}
                </span>
              )}
            </p>
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

        {account && (account.status === 'needs_captcha' || account.status === 'disconnected') && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              account.status === 'needs_captcha'
                ? 'border-amber-300 bg-amber-50'
                : 'border-red-300 bg-red-50'
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className={`mt-0.5 h-4 w-4 shrink-0 ${account.status === 'needs_captcha' ? 'text-amber-600' : 'text-red-600'}`}
              />
              <div className="flex-1">
                {account.status === 'needs_captcha' ? (
                  <>
                    <div className="font-medium text-amber-800">Аккаунт остановлен — нужно пройти CAPTCHA</div>
                    <div className="mt-0.5 text-amber-700">
                      Откройте VNC (<code>/openoutreach-vnc/</code>), пройдите проверку LinkedIn вручную, затем нажмите «Возобновить».
                      {account.last_error ? <span className="text-amber-600"> ({account.last_error})</span> : null}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-medium text-red-800">LinkedIn отключён</div>
                    <div className="mt-0.5 text-red-700">
                      {account.last_error || 'Ошибка авторизации.'} Проверьте логин/пароль/прокси в «Настройках» и перезапустите кампанию.
                    </div>
                  </>
                )}
              </div>
              {account.status === 'needs_captcha' && (
                <button
                  onClick={() => void resumeFromCaptcha()}
                  disabled={resuming}
                  className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {resuming ? 'Возобновляю…' : 'Возобновить'}
                </button>
              )}
            </div>
          </div>
        )}

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
                <label className="block text-sm">
                  <span className="font-medium text-gray-700">Seed LinkedIn profiles</span>
                  <textarea
                    value={campaignForm.seed_profile_urls}
                    rows={5}
                    onChange={(e) => setCampaignForm({ ...campaignForm, seed_profile_urls: e.target.value })}
                    placeholder={'https://www.linkedin.com/in/john-doe/\nhttps://www.linkedin.com/in/jane-smith/'}
                    className="mt-1 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono outline-none focus:border-emerald-400"
                  />
                  <span className="mt-1 block text-[11px] text-gray-500">
                    По одной ссылке на строку — стартовые профили для инвайтов. Можно оставить пустым: тогда включится автопоиск по ключевым словам (генерятся из продукта и цели промптом «Search keywords»), агент сам найдёт похожих ЛПР и отквалифицирует их перед инвайтом.
                  </span>
                </label>
                <div className="grid grid-cols-[1fr_120px] gap-3">
                  <Input
                    label="Часы работы (рассылки и ответы)"
                    value={campaignForm.working_hours}
                    onChange={(v) => setCampaignForm({ ...campaignForm, working_hours: v })}
                    placeholder="09:00-18:00, 14:00-18:00"
                  />
                  <NumberInput
                    label="Таймзона (UTC)"
                    value={campaignForm.timezone_offset}
                    onChange={(v) => setCampaignForm({ ...campaignForm, timezone_offset: v })}
                  />
                </div>
                <div className="rounded-md border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs text-gray-600">
                  Бот будет слать инвайты и отвечать только в указанные часы. Формат — как в TG аутриче,
                  но наоборот: здесь «время работы», а не «периоды сна». Можно указать несколько окон через запятую.
                </div>
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
                    {selectedCampaign?.id === campaign.id && (
                      <CampaignScheduleEditor
                        // Key on the persisted schedule so the editor remounts
                        // (and re-seeds local state from props) after a save,
                        // or when the user picks a different campaign.
                        key={`${campaign.id}-${(campaign.working_hours ?? []).join(',')}-${campaign.timezone_offset}`}
                        campaign={campaign}
                        busy={busyCampaignId === campaign.id}
                        onSave={(hours, tz) => void updateCampaignSchedule(campaign.id, hours, tz)}
                      />
                    )}
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
            <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              🔒 Прокси/VPN для LinkedIn управляется централизованно (env). Одинаков для всей команды.
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Input label="LinkedIn email" value={settings.linkedin_email} onChange={(v) => setSettings({ ...settings, linkedin_email: v })} />
              <Input label="LinkedIn password" type="password" value={settings.linkedin_password} onChange={(v) => setSettings({ ...settings, linkedin_password: v })} />
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

            <details className="mt-6 rounded-lg border border-gray-200 bg-gray-50/50">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-gray-900">
                AI-промпты для OpenOutreach <span className="text-xs font-normal text-gray-500">(3 шаблона — раскрыть)</span>
              </summary>
              <div className="space-y-5 px-4 pb-4 pt-2">
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Шаблоны на Jinja2 — переменные в {'{{ ... }}'} и блоки {'{% if ... %}'} нельзя переименовывать,
                  иначе раннер не сможет подставить значения. Пустое поле = использовать дефолт OpenOutreach
                  (он отображается ниже как стартовая точка).
                </div>
                <PromptEditor
                  label="Follow-up agent (system prompt диалога)"
                  hint="Промпт переписки: генерит следующее сообщение — первый opener или контекстный ответ на реплику контакта (плоский DM, демон шлёт как есть)."
                  value={settings.prompt_follow_up_agent}
                  onChange={(v) => setSettings({ ...settings, prompt_follow_up_agent: v })}
                  onReset={() => resetPromptToDefault('follow_up_agent')}
                  rows={20}
                />
                <PromptEditor
                  label="Qualify lead (AI-квалификация ICP)"
                  hint="Промпт для классификатора: подходит ли найденный профиль под целевой рынок кампании."
                  value={settings.prompt_qualify_lead}
                  onChange={(v) => setSettings({ ...settings, prompt_qualify_lead: v })}
                  onReset={() => resetPromptToDefault('qualify_lead')}
                  rows={10}
                />
                <PromptEditor
                  label="Search keywords (генерация поисковых запросов)"
                  hint="Промпт для составления коротких поисковых фраз для LinkedIn People search."
                  value={settings.prompt_search_keywords}
                  onChange={(v) => setSettings({ ...settings, prompt_search_keywords: v })}
                  onReset={() => resetPromptToDefault('search_keywords')}
                  rows={10}
                />
              </div>
            </details>
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

function PromptEditor({
  label,
  hint,
  value,
  onChange,
  onReset,
  rows,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
  rows: number;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">{label}</div>
          <div className="mt-0.5 text-xs text-gray-500">{hint}</div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          title="Вернуть текст из апстрима OpenOutreach"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Дефолт
        </button>
      </div>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="mt-2 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-emerald-400"
      />
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

function Input({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-emerald-400" />
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

/**
 * Inline editor for `working_hours` + `timezone_offset` on an existing
 * campaign. Local state is seeded from props and reset every time a different
 * card opens so editing one campaign never leaks into another.
 *
 * Why inline (not a separate page): the rest of the campaign card is read-only
 * preview, and the only field users actually want to tweak after creation is
 * the schedule. A modal/route would be overkill.
 */
function CampaignScheduleEditor({
  campaign,
  busy,
  onSave,
}: {
  campaign: Campaign;
  busy: boolean;
  onSave: (workingHours: string, timezoneOffset: number) => void;
}) {
  const initialHours = Array.isArray(campaign.working_hours)
    ? campaign.working_hours.join(', ')
    : '';
  const initialTz = Number.isFinite(Number(campaign.timezone_offset))
    ? Number(campaign.timezone_offset)
    : 0;
  // Local form state seeded from the campaign row. The parent passes a
  // `key` derived from the persisted schedule, so this component remounts
  // whenever the persisted values change — no useEffect-based prop sync.
  const [hours, setHours] = useState(initialHours);
  const [tz, setTz] = useState(initialTz);

  const dirty = hours !== initialHours || tz !== initialTz;

  return (
    <div
      className="mt-4 rounded-md border border-emerald-100 bg-white p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Расписание</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_110px_auto]">
        <Input
          label="Часы работы"
          value={hours}
          onChange={setHours}
          placeholder="09:00-18:00, 14:00-18:00"
        />
        <NumberInput label="UTC offset" value={tz} onChange={setTz} />
        <button
          onClick={() => onSave(hours, tz)}
          disabled={busy || !dirty}
          className="self-end rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
      <div className="mt-2 text-[11px] text-gray-500">
        Бот шлёт инвайты и отвечает только в эти часы (локальное время = UTC + offset). Несколько окон — через запятую.
      </div>
    </div>
  );
}
