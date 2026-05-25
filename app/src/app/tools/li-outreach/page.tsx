'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch, authFetchJson, getAccessToken } from '@/lib/authFetch';

// ---- Types ------------------------------------------------------------------

type Tab = 'dashboard' | 'campaigns' | 'leads' | 'scraper' | 'accounts' | 'logs' | 'settings';

type LiAccountCooldownReason = 'invitation_limit' | 'already_invited' | 'account_restricted';
type LiAccount = {
  id: string;
  unipile_account_id: string;
  name: string | null;
  is_active: boolean;
  profile_url: string | null;
  headline: string | null;
  last_synced_at: string | null;
  created_at: string;
  cooldown_until: string | null;
  cooldown_reason: LiAccountCooldownReason | null;
  proxy_url: string | null;
};

const COOLDOWN_REASON_LABELS: Record<LiAccountCooldownReason, string> = {
  invitation_limit: 'лимит инвайтов LinkedIn',
  already_invited: 'уже приглашённые контакты',
  account_restricted: 'аккаунт ограничен LinkedIn',
};

function isAccountInCooldown(a: Pick<LiAccount, 'cooldown_until'>): boolean {
  if (!a.cooldown_until) return false;
  return new Date(a.cooldown_until).getTime() > Date.now();
}

function formatCooldownRemaining(until: string): string {
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return 'истекла';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}ч ${mins}м` : `${hours}ч`;
}
type LiLeadList = { id: string; name: string; description: string | null; created_at: string; leads_count?: number };
type LiLead = { id: string; name: string; first_name: string | null; last_name: string | null; position: string | null; company: string | null; profile_url: string | null; status: string; lead_list_id: string | null; created_at: string };

type DashboardCompanyRow = { company: string; total: number; new: number; invited: number; connected: number; messaged: number; replied: number; completed: number; error: number };
type DashboardCampaignStat = {
  id: string; name: string; status: string; daily_invite_limit: number; invites_sent_today: number;
  leads_total: number; pending: number; in_progress: number; waiting: number; completed: number;
  error: number; skipped: number; replied: number; accepted: number; reply_rate: number; accept_rate: number;
  funnel: DashboardFunnel;
};
type DashboardTimeline = { date: string; actions: number; errors: number };
type DashboardFunnel = { new: number; invited: number; already_invited: number; connected: number; messaged: number; replied: number; completed: number; error: number; total: number };
type DashboardData = {
  funnel: DashboardFunnel;
  by_company: DashboardCompanyRow[];
  campaign_stats: DashboardCampaignStat[];
  timeline: DashboardTimeline[];
};

type LiCampaign = {
  id: string;
  name: string;
  account_id: string | null;
  lead_list_id: string | null;
  steps: unknown[];
  status: string;
  use_ai: boolean;
  daily_invite_limit: number;
  min_delay: number;
  max_delay: number;
  stop_on_reply: boolean;
  ai_prompt_invite: string | null;
  ai_prompt_chat: string | null;
  message_existing_connections: boolean;
  use_ai_welcome: boolean;
  use_ai_followup: boolean;
  welcome_message: string | null;
  created_at: string;
  updated_at: string;
};
type LiTask = { id: string; type: string; status: string; progress: number; total: number; error_message: string | null; created_at: string };
type LiCampaignLog = { id: number; level: string; message: string; lead_name: string | null; step_index: number | null; created_at: string };
type LiSettings = { unipile_dsn: string; unipile_api_key: string; webhook_secret: string; proxy_url: string };
type CampaignStep = { type?: unknown; message?: unknown; days?: unknown; hours?: unknown };

const DEFAULT_CAMPAIGN_FORM = {
  name: '',
  account_id: '',
  lead_list_id: '',
  invite_message: 'Привет! Заметил вашу активность в LinkedIn. Хотел бы добавить вас в профессиональную сеть.',
  welcome_message: 'Спасибо за добавление! Рад расширить профессиональную сеть.',
  followup1_message: 'Добрый день! Мы подключились недавно, и мне интересно узнать больше о вашем опыте.',
  followup1_days: 2,
  followup1_hours: 0,
  followup2_enabled: true,
  followup2_message: 'Добрый день! Хотел напомнить о себе. Давайте созвонимся на 15 минут?',
  followup2_days: 3,
  followup2_hours: 0,
  use_ai: true,
  daily_invite_limit: 25,
  min_delay: 60,
  max_delay: 180,
  stop_on_reply: true,
  ai_prompt_invite: 'Персонализируй сообщение, подставив имя получателя в начале и упомянув его должность или компанию там, где это уместно. Сохрани общий смысл исходного сообщения.',
  ai_prompt_chat: 'Ты профессиональный менеджер. Отвечай вежливо и по делу. Учитывай историю переписки. Старайся договориться о звонке или встрече. Не выдумывай факты.',
  message_existing_connections: false,
  use_ai_welcome: false,
  use_ai_followup: true,
  ai_model: 'openai/gpt-4o-mini',
};

// ---- Helpers ----------------------------------------------------------------

async function api<T = unknown>(path: string, opts?: RequestInit & { json?: unknown }): Promise<T> {
  const body = opts?.json ? JSON.stringify(opts.json) : opts?.body;
  return authFetchJson<T>(`/api/tools/li-outreach${path}`, { ...opts, body });
}

// ---- Main page --------------------------------------------------------------

export default function LiOutreachPage() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [accounts, setAccounts] = useState<LiAccount[]>([]);
  // Per-account error/warning counts from li_campaign_logs over the last 24h
  // (rendered as a chip on each AccountCard). Map keyed by account_id.
  const [accountErrorCounts, setAccountErrorCounts] = useState<
    Record<string, { error: number; warning: number }>
  >({});
  // Account whose log feed is open in the modal, or null.
  const [accountLogsModal, setAccountLogsModal] = useState<LiAccount | null>(null);
  const [leadLists, setLeadLists] = useState<LiLeadList[]>([]);
  const [leads, setLeads] = useState<LiLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadListFilterId, setLeadListFilterId] = useState('');
  const [campaigns, setCampaigns] = useState<LiCampaign[]>([]);
  const [tasks, setTasks] = useState<LiTask[]>([]);
  const [_settings, setSettings] = useState<LiSettings | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [campaignLogs, setCampaignLogs] = useState<LiCampaignLog[]>([]);
  // Range key currently being exported (button shows '...' until done).
  // Null when no export is in flight.
  const [exportingCampaignLogsRange, setExportingCampaignLogsRange] = useState<'24h' | '7d' | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<LiSettings>({ unipile_dsn: '', unipile_api_key: '', webhook_secret: '', proxy_url: '' });

  // Scraper form
  const [scraperUrl, setScraperUrl] = useState('');
  const [scraperAccountId, setScraperAccountId] = useState('');
  const [scraperListId, setScraperListId] = useState('');
  const [scraperMax, setScraperMax] = useState(100);
  const [scraperType, setScraperType] = useState<'search' | 'reactions'>('search');

  // Campaign creation
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [cf, setCf] = useState(DEFAULT_CAMPAIGN_FORM);

  // Dashboard data
  const [dashData, setDashData] = useState<DashboardData | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  // Воронка лидов на дашборде: '' = по всем кампаниям, иначе id кампании.
  const [funnelCampaignId, setFunnelCampaignId] = useState('');
  const [companySearch, setCompanySearch] = useState('');
  const [companySortKey, setCompanySortKey] = useState<'total' | 'replied' | 'connected' | 'invited'>('total');

  // CSV import
  const [importing, setImporting] = useState(false);
  const [importListId, setImportListId] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [showCreateListModal, setShowCreateListModal] = useState(false);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [newListDescription, setNewListDescription] = useState('');

  // ---- Data fetching --------------------------------------------------------

  const loadAccounts = useCallback(async () => {
    try { const d = await api<{ accounts: LiAccount[] }>('/accounts'); setAccounts(d.accounts); } catch (e) { console.error('[li-outreach] loadAccounts failed', e); }
  }, []);
  const loadAccountErrorCounts = useCallback(async () => {
    try {
      const d = await api<{
        counts: Record<string, { error: number; warning: number }>;
      }>('/accounts/error-counts?range=24h');
      setAccountErrorCounts(d.counts ?? {});
    } catch (e) {
      console.error('[li-outreach] loadAccountErrorCounts failed', e);
    }
  }, []);
  const loadLeadLists = useCallback(async () => {
    try { const d = await api<{ lead_lists: LiLeadList[] }>('/lead-lists'); setLeadLists(d.lead_lists); } catch (e) { console.error('[li-outreach] loadLeadLists failed', e); }
  }, []);
  const loadLeads = useCallback(async (listId?: string) => {
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (listId) params.set('lead_list_id', listId);
      const d = await api<{ leads: LiLead[]; total: number }>(`/leads?${params.toString()}`);
      setLeads(d.leads);
      setLeadsTotal(d.total);
    } catch (e) {
      console.error('[li-outreach] loadLeads failed', e);
    }
  }, []);
  const loadCampaigns = useCallback(async () => {
    try { const d = await api<{ campaigns: LiCampaign[] }>('/campaigns'); setCampaigns(d.campaigns); } catch (e) { console.error('[li-outreach] loadCampaigns failed', e); }
  }, []);
  const loadTasks = useCallback(async () => {
    try { const d = await api<{ tasks: LiTask[] }>('/scraper/tasks'); setTasks(d.tasks); } catch (e) { console.error('[li-outreach] loadTasks failed', e); }
  }, []);
  const loadSettings = useCallback(async () => {
    try {
      const d = await api<{ settings: LiSettings | null }>('/settings');
      setSettings(d.settings);
      if (d.settings) setSettingsForm(d.settings);
    } catch (e) { console.error('[li-outreach] loadSettings failed', e); }
  }, []);
  const loadCampaignLogs = useCallback(async (id: string) => {
    try {
      const d = await api<{ items: LiCampaignLog[]; total: number }>(`/campaigns/${id}/logs`);
      setCampaignLogs(Array.isArray(d?.items) ? d.items : []);
    } catch (e) {
      console.error('[li-outreach] loadCampaignLogs failed', e);
      setCampaignLogs([]);
    }
  }, []);
  const loadDashboard = useCallback(async () => {
    setDashLoading(true);
    try { const d = await api<DashboardData>('/dashboard'); setDashData(d); } catch (e) { console.error('[li-outreach] loadDashboard failed', e); } finally { setDashLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      // Wait for Supabase auth session to be ready before making API calls
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        // Session not ready yet — listen for auth state change
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
          if (s && !cancelled) {
            void loadAccounts();
            void loadAccountErrorCounts();
            void loadCampaigns();
            void loadLeadLists();
            void loadSettings();
            subscription.unsubscribe();
          }
        });
        return () => { cancelled = true; subscription.unsubscribe(); };
      }
      void loadAccounts();
      void loadAccountErrorCounts();
      void loadCampaigns();
      void loadLeadLists();
      void loadSettings();
    };
    void init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === 'dashboard') { void loadDashboard(); void loadLeads(); void loadCampaigns(); }
    if (tab === 'campaigns') void loadCampaigns();
    if (tab === 'leads') void loadLeads(leadListFilterId || undefined);
    if (tab === 'scraper' || tab === 'dashboard') void loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, leadListFilterId]);

  useEffect(() => {
    if (selectedCampaignId) void loadCampaignLogs(selectedCampaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCampaignId]);

  // Download the selected campaign's logs as a .txt for the given range.
  // Reuses the existing global export endpoint with campaign_id filter — same
  // contract as the per-campaign export in tg-outreach.
  const exportCampaignLogs = useCallback(
    async (range: '24h' | '7d') => {
      if (!selectedCampaignId) return;
      setExportingCampaignLogsRange(range);
      try {
        const params = new URLSearchParams({ range, campaign_id: selectedCampaignId });
        const res = await authFetch(`/api/tools/li-outreach/logs/export?${params.toString()}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert((data as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8
          ? decodeURIComponent(utf8[1])
          : (ascii?.[1] ?? `li-outreach-logs-${range}.txt`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingCampaignLogsRange(null);
      }
    },
    [selectedCampaignId],
  );

  // ---- Actions --------------------------------------------------------------

  const syncAccounts = async () => { setSyncing(true); try { await api('/accounts/sync', { method: 'POST', json: {} }); await loadAccounts(); } finally { setSyncing(false); } };
  const saveSettings = async () => { setSavingSettings(true); try { await api('/settings', { method: 'PUT', json: settingsForm }); await loadSettings(); } finally { setSavingSettings(false); } };
  const startCampaign = async (id: string) => { await api(`/campaigns/${id}/start`, { method: 'POST', json: {} }); await loadCampaigns(); };
  const stopCampaign = async (id: string) => { await api(`/campaigns/${id}/stop`, { method: 'POST', json: {} }); await loadCampaigns(); };
  const deleteCampaign = async (id: string) => { if (!confirm('Удалить кампанию?')) return; await api(`/campaigns/${id}`, { method: 'DELETE' }); await loadCampaigns(); };

  const startScrape = async () => {
    if (!scraperUrl || !scraperAccountId) { alert('Заполните URL и аккаунт'); return; }
    const endpoint = scraperType === 'search' ? '/scraper/search' : '/scraper/reactions';
    const body = scraperType === 'search'
      ? { search_url: scraperUrl, account_id: scraperAccountId, lead_list_id: scraperListId || undefined, max_results: scraperMax }
      : { post_url: scraperUrl, account_id: scraperAccountId, lead_list_id: scraperListId || undefined, max_results: scraperMax };
    await api(endpoint, { method: 'POST', json: body });
    setScraperUrl('');
    void loadTasks();
  };

  const cancelTask = async (taskId: string) => { await api(`/scraper/tasks/${taskId}/cancel`, { method: 'POST', json: {} }); void loadTasks(); };

  const createCampaign = async () => {
    if (!cf.name.trim()) { alert('Введите название кампании'); return; }
    if (!cf.account_id) { alert('Выберите аккаунт'); return; }
    setCreating(true);
    try {
      const steps: { type: string; message?: string; days?: number; hours?: number }[] = [
        { type: 'invite', message: cf.invite_message },
        { type: 'wait', days: cf.followup1_days, hours: cf.followup1_hours },
        { type: 'message', message: cf.followup1_message },
      ];
      if (cf.followup2_enabled) {
        steps.push({ type: 'wait', days: cf.followup2_days, hours: cf.followup2_hours });
        steps.push({ type: 'message', message: cf.followup2_message });
      }
      await api(editingCampaignId ? `/campaigns/${editingCampaignId}` : '/campaigns', {
        method: editingCampaignId ? 'PUT' : 'POST',
        json: {
          name: cf.name,
          account_id: cf.account_id,
          lead_list_id: cf.lead_list_id || null,
          steps,
          use_ai: cf.use_ai,
          stop_on_reply: cf.stop_on_reply,
          daily_invite_limit: cf.daily_invite_limit,
          min_delay: cf.min_delay,
          max_delay: cf.max_delay,
          welcome_message: cf.welcome_message || null,
          ai_prompt_invite: cf.ai_prompt_invite || null,
          ai_prompt_chat: cf.ai_prompt_chat || null,
          message_existing_connections: cf.message_existing_connections,
          use_ai_welcome: cf.use_ai_welcome,
          use_ai_followup: cf.use_ai_followup,
          ai_model: cf.ai_model || null,
        },
      });
      setShowCreate(false);
      setEditingCampaignId(null);
      setCf(DEFAULT_CAMPAIGN_FORM);
      await loadCampaigns();
    } catch (e) {
      alert('Ошибка: ' + (e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  };

  const openCreateCampaignForm = () => {
    setEditingCampaignId(null);
    setCf(DEFAULT_CAMPAIGN_FORM);
    setShowCreate(true);
  };

  const openEditCampaignForm = (campaign: LiCampaign) => {
    const steps = Array.isArray(campaign.steps) ? (campaign.steps as CampaignStep[]) : [];
    const inviteStep = steps.find((step) => step?.type === 'invite');
    const waitSteps = steps.filter((step) => step?.type === 'wait');
    const messageSteps = steps.filter((step) => step?.type === 'message');
    const toNumber = (value: unknown, fallback: number, min = 0, max?: number) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      if (max === undefined) return Math.max(min, parsed);
      return Math.min(max, Math.max(min, parsed));
    };
    const followup1Message = typeof messageSteps[0]?.message === 'string' ? messageSteps[0].message : DEFAULT_CAMPAIGN_FORM.followup1_message;
    const followup2Message = typeof messageSteps[1]?.message === 'string' ? messageSteps[1].message : DEFAULT_CAMPAIGN_FORM.followup2_message;
    const hasFollowup2 = Boolean(waitSteps[1] || messageSteps[1]);

    setCf({
      ...DEFAULT_CAMPAIGN_FORM,
      name: campaign.name ?? '',
      account_id: campaign.account_id ?? '',
      lead_list_id: campaign.lead_list_id ?? '',
      invite_message: typeof inviteStep?.message === 'string' ? inviteStep.message : DEFAULT_CAMPAIGN_FORM.invite_message,
      followup1_message: followup1Message,
      followup1_days: toNumber(waitSteps[0]?.days, DEFAULT_CAMPAIGN_FORM.followup1_days, 0),
      followup1_hours: toNumber(waitSteps[0]?.hours, DEFAULT_CAMPAIGN_FORM.followup1_hours, 0, 23),
      followup2_enabled: hasFollowup2,
      followup2_message: followup2Message,
      followup2_days: toNumber(waitSteps[1]?.days, DEFAULT_CAMPAIGN_FORM.followup2_days, 0),
      followup2_hours: toNumber(waitSteps[1]?.hours, DEFAULT_CAMPAIGN_FORM.followup2_hours, 0, 23),
      use_ai: campaign.use_ai,
      daily_invite_limit: toNumber(campaign.daily_invite_limit, DEFAULT_CAMPAIGN_FORM.daily_invite_limit, 1),
      min_delay: toNumber((campaign as Record<string, unknown>).min_delay, DEFAULT_CAMPAIGN_FORM.min_delay, 10),
      max_delay: toNumber((campaign as Record<string, unknown>).max_delay, DEFAULT_CAMPAIGN_FORM.max_delay, 30),
      stop_on_reply: campaign.stop_on_reply !== false,
      welcome_message: typeof campaign.welcome_message === 'string'
        ? String(campaign.welcome_message)
        : DEFAULT_CAMPAIGN_FORM.welcome_message,
      ai_prompt_invite: typeof campaign.ai_prompt_invite === 'string' ? campaign.ai_prompt_invite : DEFAULT_CAMPAIGN_FORM.ai_prompt_invite,
      ai_prompt_chat: typeof campaign.ai_prompt_chat === 'string' ? campaign.ai_prompt_chat : DEFAULT_CAMPAIGN_FORM.ai_prompt_chat,
      message_existing_connections: Boolean(campaign.message_existing_connections),
      use_ai_welcome: Boolean(campaign.use_ai_welcome),
      use_ai_followup: campaign.use_ai_followup !== false,
      ai_model: typeof (campaign as Record<string, unknown>).ai_model === 'string' ? String((campaign as Record<string, unknown>).ai_model) : DEFAULT_CAMPAIGN_FORM.ai_model,
    });
    setEditingCampaignId(campaign.id);
    setShowCreate(true);
  };

  const exportLeadsCsv = async () => {
    const res = await authFetch('/api/tools/li-outreach/leads/export');
    if (!res.ok) { alert('Ошибка экспорта'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `li_leads_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportLeadListCsv = async (list: LiLeadList) => {
    const d = await api<{ leads: LiLead[] }>(`/leads?limit=1000&lead_list_id=${encodeURIComponent(list.id)}`);
    const escapeCsv = (value: string | null | undefined) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['name', 'first_name', 'last_name', 'position', 'company', 'profile_url', 'status'].join(','),
      ...d.leads.map((lead) => [
        escapeCsv(lead.name),
        escapeCsv(lead.first_name),
        escapeCsv(lead.last_name),
        escapeCsv(lead.position),
        escapeCsv(lead.company),
        escapeCsv(lead.profile_url),
        escapeCsv(lead.status),
      ].join(',')),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `li_leads_list_${list.name.replaceAll(/\s+/g, '_')}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importLeadsCsv = async (file: File) => {
    setImporting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const fd = new FormData();
      fd.append('file', file);
      if (importListId) fd.append('lead_list_id', importListId);
      const res = await fetch('/api/tools/li-outreach/leads/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json() as { imported?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      alert(`Импортировано: ${data.imported}, пропущено: ${data.skipped ?? 0}`);
      setShowImportModal(false);
      await loadLeads();
      await loadLeadLists();
    } catch (e) {
      alert('Ошибка импорта: ' + (e instanceof Error ? e.message : e));
    } finally {
      setImporting(false);
    }
  };

  const deleteLeadList = async (list: LiLeadList) => {
    if (!confirm(`Удалить список "${list.name}"?`)) return;
    try {
      await api(`/lead-lists/${list.id}`, { method: 'DELETE' });
      const nextFilterId = leadListFilterId === list.id ? '' : leadListFilterId;
      setLeadListFilterId(nextFilterId);
      if (importListId === list.id) setImportListId('');
      if (scraperListId === list.id) setScraperListId('');
      setCf((prev) => (prev.lead_list_id === list.id ? { ...prev, lead_list_id: '' } : prev));
      await loadLeadLists();
      await loadLeads(nextFilterId || undefined);
    } catch (e) {
      alert('Ошибка удаления списка: ' + (e instanceof Error ? e.message : e));
    }
  };

  const createLeadList = async () => {
    const name = newListName.trim();
    if (!name) {
      alert('Введите название списка');
      return;
    }

    setCreatingList(true);
    try {
      const d = await api<{ lead_list: LiLeadList }>('/lead-lists', {
        method: 'POST',
        json: {
          name,
          description: newListDescription.trim() || undefined,
        },
      });

      await loadLeadLists();
      setImportListId(d.lead_list.id);
      setLeadListFilterId(d.lead_list.id);
      setCf((prev) => ({ ...prev, lead_list_id: d.lead_list.id }));
      setScraperListId(d.lead_list.id);
      setNewListName('');
      setNewListDescription('');
      setShowCreateListModal(false);
    } catch (e) {
      alert('Ошибка создания списка: ' + (e instanceof Error ? e.message : e));
    } finally {
      setCreatingList(false);
    }
  };

  // ---- Tab bar --------------------------------------------------------------

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Дашборд' },
    { key: 'campaigns', label: 'Кампании' },
    { key: 'leads', label: 'Лиды' },
    { key: 'scraper', label: 'Скрапер' },
    { key: 'accounts', label: 'Аккаунты' },
    { key: 'logs', label: 'Логи' },
    { key: 'settings', label: 'Настройки' },
  ];

  const selectedCampaign = useMemo(() => campaigns.find((c) => c.id === selectedCampaignId) ?? null, [campaigns, selectedCampaignId]);

  // Дашборд: выбранная в селекторе воронки кампания и соответствующая воронка.
  // Используется и для секции «Воронка лидов», и для верхних карточек.
  const dashFunnelCampaign = funnelCampaignId
    ? dashData?.campaign_stats.find((c) => c.id === funnelCampaignId) ?? null
    : null;
  const dashFunnel = dashFunnelCampaign ? dashFunnelCampaign.funnel : dashData?.funnel ?? null;

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">LinkedIn Outreach</h1>
        <p className="text-sm text-gray-500">Кампании, AI-персонализация, скрапинг лидов через Unipile.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && (
        <div className="space-y-5">
          {dashLoading && !dashData && <div className="text-center py-8 text-sm text-gray-400">Загрузка статистики…</div>}

          {/* Top stats row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Аккаунты" value={accounts.filter((a) => a.is_active).length} total={accounts.length} accent="green" />
            <StatCard label="Кампании" value={campaigns.filter((c) => c.status === 'running').length} total={campaigns.length} accent="blue" />
            <StatCard
              label={dashFunnelCampaign ? `Лиды · ${dashFunnelCampaign.name}` : 'Лиды'}
              value={dashFunnel?.total ?? leadsTotal}
              accent="violet"
            />
            <StatCard
              label="Ответили"
              value={dashFunnel?.replied ?? 0}
              total={dashFunnel?.total}
              accent="green"
            />
          </div>

          {/* Lead funnel (visual) — выбираемая по кампании */}
          {dashData && dashFunnel && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <h3 className="text-sm font-semibold text-gray-900">
                  Воронка лидов{dashFunnelCampaign ? ` — ${dashFunnelCampaign.name}` : ''}
                </h3>
                <select
                  value={funnelCampaignId}
                  onChange={(e) => setFunnelCampaignId(e.target.value)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm bg-white max-w-[260px]"
                >
                  <option value="">Все кампании</option>
                  {dashData.campaign_stats.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <FunnelChart funnel={dashFunnel} />
            </div>
          )}

          {/* Activity timeline (30 days) */}
          {dashData && dashData.timeline.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Активность за 30 дней</h3>
              <ActivityTimeline timeline={dashData.timeline} />
            </div>
          )}

          {/* Campaign performance */}
          {dashData && dashData.campaign_stats.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Кампании — эффективность</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Кампания</th>
                      <th className="text-center px-2 py-2 text-xs text-gray-500 font-medium">Статус</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Лидов</th>
                      <th
                        className="text-right px-2 py-2 text-xs text-gray-500 font-medium"
                        title="Сколько инвайтов отправлено сегодня из дневного лимита. Счётчик сбрасывается в полночь."
                      >
                        Инвайтов сегодня
                      </th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Принято</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Ответили</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Accept %</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Reply %</th>
                      <th
                        className="px-2 py-2 text-xs text-gray-500 font-medium w-56"
                        title="Обработано = Завершено + Ошибки + Пропущено от общего числа лидов в кампании"
                      >
                        Обработано
                        <span className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 text-gray-500 text-[9px] cursor-help" title="Доля лидов, по которым кампания уже отработала все шаги либо остановилась (успех / ошибка / пропуск). Остальные — в работе или ждут очереди.">?</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashData.campaign_stats.map((cs) => {
                      const processed = cs.completed + cs.error + cs.skipped;
                      const doneRatio = cs.leads_total > 0 ? Math.round((processed / cs.leads_total) * 100) : 0;
                      const pendingActive = cs.pending + cs.in_progress + cs.waiting;
                      const pctCompleted = cs.leads_total > 0 ? (cs.completed / cs.leads_total) * 100 : 0;
                      const pctError = cs.leads_total > 0 ? (cs.error / cs.leads_total) * 100 : 0;
                      const pctSkipped = cs.leads_total > 0 ? (cs.skipped / cs.leads_total) * 100 : 0;
                      const tooltip = `Обработано ${processed} из ${cs.leads_total} лидов (${doneRatio}%)\n` +
                        `  ✓ Завершено: ${cs.completed}\n` +
                        `  ✗ Ошибки: ${cs.error}\n` +
                        `  ⤼ Пропущено: ${cs.skipped}\n` +
                        `Осталось: ${pendingActive}\n` +
                        `  • В очереди: ${cs.pending}\n` +
                        `  • Сейчас обрабатываются: ${cs.in_progress}\n` +
                        `  • Ждут следующего шага: ${cs.waiting}`;
                      return (
                        <tr key={cs.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                          <td className="px-3 py-2.5 font-medium text-gray-900 max-w-[200px] truncate">{cs.name}</td>
                          <td className="px-2 py-2.5 text-center">
                            <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${cs.status === 'running' ? 'bg-green-100 text-green-700' : cs.status === 'draft' ? 'bg-gray-100 text-gray-600' : cs.status === 'paused' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                              {cs.status === 'running' ? '● Активна' : cs.status === 'draft' ? 'Черновик' : cs.status}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-gray-700">{cs.leads_total}</td>
                          <td
                            className="px-2 py-2.5 text-right tabular-nums"
                            title={`Отправлено сегодня ${cs.invites_sent_today} из ${cs.daily_invite_limit} (дневной лимит). Счётчик сбросится в 00:00.`}
                          >
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-12 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${cs.invites_sent_today >= cs.daily_invite_limit ? 'bg-amber-500' : 'bg-blue-500'}`}
                                  style={{ width: `${cs.daily_invite_limit > 0 ? Math.min(100, Math.round((cs.invites_sent_today / cs.daily_invite_limit) * 100)) : 0}%` }}
                                />
                              </div>
                              <span className={cs.invites_sent_today >= cs.daily_invite_limit ? 'text-amber-700 font-medium' : 'text-gray-700'}>
                                {cs.invites_sent_today} / {cs.daily_invite_limit}
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-blue-700 font-medium">{cs.accepted}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-green-700 font-medium">{cs.replied}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{cs.accept_rate}%</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{cs.reply_rate}%</td>
                          <td className="px-2 py-2.5" title={tooltip}>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden flex">
                                {pctCompleted > 0 && <div className="h-full bg-green-500 transition-all" style={{ width: `${pctCompleted}%` }} />}
                                {pctError > 0 && <div className="h-full bg-red-400 transition-all" style={{ width: `${pctError}%` }} />}
                                {pctSkipped > 0 && <div className="h-full bg-gray-400 transition-all" style={{ width: `${pctSkipped}%` }} />}
                              </div>
                              <span className="text-xs tabular-nums text-gray-700 font-medium w-10 text-right">{doneRatio}%</span>
                            </div>
                            <div className="text-[10px] text-gray-500 mt-0.5 tabular-nums">
                              {processed} из {cs.leads_total} · осталось {pendingActive}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="mt-3 flex items-center gap-3 text-[10px] text-gray-500 flex-wrap">
                  <span className="font-medium text-gray-600">Легенда:</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-500" /> Завершено</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-400" /> Ошибка</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-400" /> Пропущено</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-100 border border-gray-200" /> В работе / ожидают</span>
                </div>
              </div>
            </div>
          )}

          {/* By company */}
          {dashData && dashData.by_company.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-gray-900">Статистика по компаниям</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Поиск компании…"
                    value={companySearch}
                    onChange={(e) => setCompanySearch(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs w-48"
                  />
                  <select
                    value={companySortKey}
                    onChange={(e) => setCompanySortKey(e.target.value as typeof companySortKey)}
                    className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  >
                    <option value="total">По кол-ву лидов</option>
                    <option value="replied">По ответам</option>
                    <option value="connected">По подключениям</option>
                    <option value="invited">По приглашениям</option>
                  </select>
                </div>
              </div>
              <CompanyTable rows={dashData.by_company} search={companySearch} sortKey={companySortKey} />
            </div>
          )}

          {/* Accounts health + tasks */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Аккаунты</h3>
              {accounts.length === 0 ? (
                <p className="text-xs text-gray-400">Нет аккаунтов. Подключите через Настройки → Синхронизация.</p>
              ) : (
                <div className="space-y-2">
                  {accounts.map((a) => {
                    const cooling = isAccountInCooldown(a);
                    return (
                      <div key={a.id} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${cooling ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50'}`}>
                        <span className={`shrink-0 w-2 h-2 rounded-full ${cooling ? 'bg-amber-500 animate-pulse' : a.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-gray-900 truncate block">{a.name || a.unipile_account_id}</span>
                          {cooling ? (
                            <span
                              className="text-xs text-amber-700 truncate block"
                              title={`Аккаунт в отлёжке до ${new Date(a.cooldown_until!).toLocaleString('ru-RU')}. Все кампании и скрапинг с этого аккаунта приостановлены.`}
                            >
                              💤 в отлёжке ещё {formatCooldownRemaining(a.cooldown_until!)} · {a.cooldown_reason ? COOLDOWN_REASON_LABELS[a.cooldown_reason] : '—'}
                            </span>
                          ) : a.headline ? (
                            <span className="text-xs text-gray-500 truncate block">{a.headline}</span>
                          ) : null}
                        </div>
                        <span className="text-[10px] text-gray-400 shrink-0">
                          {a.last_synced_at ? `sync ${new Date(a.last_synced_at).toLocaleDateString()}` : 'не синхр.'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Скрапер задачи</h3>
              {tasks.length === 0 ? (
                <p className="text-xs text-gray-400">Нет задач</p>
              ) : (
                <div className="space-y-2">
                  {tasks.slice(0, 5).map((t) => {
                    const pct = t.total > 0 ? Math.round((t.progress / t.total) * 100) : 0;
                    return (
                      <div key={t.id} className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-gray-900">{t.type}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${t.status === 'completed' ? 'bg-green-100 text-green-700' : t.status === 'running' ? 'bg-blue-100 text-blue-700' : t.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-200 text-gray-600'}`}>
                            {t.status}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${t.status === 'completed' ? 'bg-green-500' : t.status === 'failed' ? 'bg-red-400' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-500 tabular-nums">{t.progress}/{t.total}</span>
                        </div>
                        {t.error_message && <p className="text-xs text-red-600 mt-1">{t.error_message}</p>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Campaigns */}
      {tab === 'campaigns' && (
        <div className="space-y-4">
          {/* Create Campaign Panel */}
          {showCreate && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">{editingCampaignId ? 'Редактирование кампании' : 'Новая кампания'}</h2>
                <button onClick={() => { setShowCreate(false); setEditingCampaignId(null); }} className="text-xs text-gray-500 hover:text-gray-700">Отмена</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Название *</label>
                  <input type="text" placeholder="Моя кампания" value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Аккаунт *</label>
                  <select value={cf.account_id} onChange={(e) => setCf({ ...cf, account_id: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                    <option value="">Выберите...</option>
                    {accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name || a.unipile_account_id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Список лидов</label>
                  <select value={cf.lead_list_id} onChange={(e) => setCf({ ...cf, lead_list_id: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                    <option value="">Без списка</option>
                    {leadLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Step 1: Invite */}
              <div className="rounded-lg border-l-4 border-blue-400 bg-white p-3 space-y-2">
                <div className="text-xs font-semibold text-blue-700">Шаг 1 — Инвайт</div>
                <textarea rows={2} value={cf.invite_message} onChange={(e) => setCf({ ...cf, invite_message: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>

              {/* Step 2: Welcome */}
              <div className="rounded-lg border-l-4 border-teal-400 bg-white p-3 space-y-2">
                <div className="text-xs font-semibold text-teal-700">Шаг 2 — Welcome (при принятии инвайта)</div>
                <textarea rows={2} value={cf.welcome_message} onChange={(e) => setCf({ ...cf, welcome_message: e.target.value })} placeholder="Оставьте пустым, чтобы пропустить" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>

              {/* Step 3: Follow-up 1 */}
              <div className="rounded-lg border-l-4 border-green-400 bg-white p-3 space-y-2">
                <div className="text-xs font-semibold text-green-700">Шаг 3 — Follow-up #1</div>
                <div className="flex gap-2 items-center">
                  <label className="text-xs text-gray-500">Задержка:</label>
                  <input type="number" min={0} value={cf.followup1_days} onChange={(e) => setCf({ ...cf, followup1_days: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                  <span className="text-xs text-gray-400">дней</span>
                  <input type="number" min={0} max={23} value={cf.followup1_hours} onChange={(e) => setCf({ ...cf, followup1_hours: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                  <span className="text-xs text-gray-400">часов</span>
                </div>
                <textarea rows={2} value={cf.followup1_message} onChange={(e) => setCf({ ...cf, followup1_message: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </div>

              {/* Step 4: Follow-up 2 (optional) */}
              <div className="rounded-lg border-l-4 border-amber-400 bg-white p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-amber-700">Шаг 4 — Follow-up #2</div>
                  <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                    <input type="checkbox" checked={cf.followup2_enabled} onChange={(e) => setCf({ ...cf, followup2_enabled: e.target.checked })} className="rounded" />
                    Включить
                  </label>
                </div>
                {cf.followup2_enabled && (
                  <>
                    <div className="flex gap-2 items-center">
                      <label className="text-xs text-gray-500">Задержка:</label>
                      <input type="number" min={0} value={cf.followup2_days} onChange={(e) => setCf({ ...cf, followup2_days: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                      <span className="text-xs text-gray-400">дней</span>
                      <input type="number" min={0} max={23} value={cf.followup2_hours} onChange={(e) => setCf({ ...cf, followup2_hours: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                      <span className="text-xs text-gray-400">часов</span>
                    </div>
                    <textarea rows={2} value={cf.followup2_message} onChange={(e) => setCf({ ...cf, followup2_message: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                  </>
                )}
              </div>

              {/* Settings row */}
              <div className="flex flex-wrap gap-4 items-center">
                <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={cf.use_ai} onChange={(e) => setCf({ ...cf, use_ai: e.target.checked })} className="rounded" />
                  AI-персонализация
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={cf.stop_on_reply} onChange={(e) => setCf({ ...cf, stop_on_reply: e.target.checked })} className="rounded" />
                  Стоп при ответе
                </label>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-600">Лимит/день:</label>
                  <input type="number" min={1} max={100} value={cf.daily_invite_limit} onChange={(e) => setCf({ ...cf, daily_invite_limit: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-600">Задержка (сек):</label>
                  <input type="number" min={10} value={cf.min_delay} onChange={(e) => setCf({ ...cf, min_delay: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                  <span className="text-xs text-gray-400">—</span>
                  <input type="number" min={30} value={cf.max_delay} onChange={(e) => setCf({ ...cf, max_delay: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                </div>
              </div>

              {/* AI settings */}
              <details className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-blue-800">AI настройки (промпты и режимы)</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-gray-600">
                    Промпт персонализации используется для инвайтов и follow-up, промпт автоответов - для ответов на входящие сообщения.
                  </p>
                  <div>
                    <label className="text-xs text-gray-600 block mb-1">Модель AI</label>
                    <select
                      value={cf.ai_model}
                      onChange={(e) => setCf({ ...cf, ai_model: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    >
                      <option value="openai/gpt-4o-mini">openai/gpt-4o-mini</option>
                      <option value="openai/gpt-5-mini">openai/gpt-5-mini</option>
                      <option value="openai/gpt-5">openai/gpt-5</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600 block mb-1">Промпт персонализации</label>
                    <textarea
                      rows={3}
                      value={cf.ai_prompt_invite}
                      onChange={(e) => setCf({ ...cf, ai_prompt_invite: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600 block mb-1">Промпт автоответов</label>
                    <textarea
                      rows={3}
                      value={cf.ai_prompt_chat}
                      onChange={(e) => setCf({ ...cf, ai_prompt_chat: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cf.use_ai_welcome}
                        onChange={(e) => setCf({ ...cf, use_ai_welcome: e.target.checked })}
                        className="rounded"
                      />
                      AI для welcome-сообщения
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cf.use_ai_followup}
                        onChange={(e) => setCf({ ...cf, use_ai_followup: e.target.checked })}
                        className="rounded"
                      />
                      AI для follow-up
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cf.message_existing_connections}
                        onChange={(e) => setCf({ ...cf, message_existing_connections: e.target.checked })}
                        className="rounded"
                      />
                      Писать тем, кто уже в контактах
                    </label>
                  </div>
                </div>
              </details>

              <button onClick={() => void createCampaign()} disabled={creating} className="rounded-lg bg-green-600 text-white px-5 py-2 text-sm font-medium disabled:opacity-50">
                {creating ? (editingCampaignId ? 'Сохранение...' : 'Создание...') : (editingCampaignId ? 'Сохранить изменения' : 'Создать кампанию')}
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Кампании</h2>
                {!showCreate && (
                  <button onClick={openCreateCampaignForm} className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-xs font-medium">+ Новая</button>
                )}
              </div>
              {campaigns.length === 0 ? (
                <div className="text-sm text-gray-500">Нет кампаний</div>
              ) : campaigns.map((c) => (
                <div key={c.id} className={`rounded-xl border p-3 text-sm cursor-pointer ${selectedCampaignId === c.id ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`} onClick={() => setSelectedCampaignId(c.id)}>
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-gray-900">{c.name}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-md ${c.status === 'running' ? 'bg-green-100 text-green-700' : c.status === 'draft' ? 'bg-gray-100 text-gray-600' : 'bg-amber-100 text-amber-700'}`}>{c.status}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">{(c.steps ?? []).length} шагов • AI: {c.use_ai ? 'вкл' : 'выкл'} • лимит: {c.daily_invite_limit}/день</div>
                  <div className="flex gap-2 mt-2">
                    <button onClick={(e) => { e.stopPropagation(); openEditCampaignForm(c); }} className="text-xs text-blue-700 hover:underline">Редактировать</button>
                    {c.status !== 'running' && <button onClick={(e) => { e.stopPropagation(); void startCampaign(c.id); }} className="text-xs text-green-700 hover:underline">▶ Запустить</button>}
                    {c.status === 'running' && <button onClick={(e) => { e.stopPropagation(); void stopCampaign(c.id); }} className="text-xs text-amber-700 hover:underline">⏹ Остановить</button>}
                    <button onClick={(e) => { e.stopPropagation(); void deleteCampaign(c.id); }} className="text-xs text-red-600 hover:underline">Удалить</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-gray-200 p-4 min-h-[200px]">
              {!selectedCampaign ? (
                <div className="text-sm text-gray-400 text-center py-8">Выберите кампанию</div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="font-semibold text-gray-900">{selectedCampaign.name} — Логи</h3>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">Выгрузить .txt:</span>
                      {(['24h', '7d'] as const).map((r) => {
                        const labels: Record<typeof r, string> = { '24h': '24 часа', '7d': '7 дней' };
                        const busy = exportingCampaignLogsRange === r;
                        return (
                          <button
                            key={r}
                            type="button"
                            onClick={() => void exportCampaignLogs(r)}
                            disabled={exportingCampaignLogsRange !== null}
                            title={`Скачать логи кампании за последние ${labels[r]}`}
                            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy ? '...' : labels[r]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="max-h-[400px] overflow-y-auto space-y-1">
                    {campaignLogs.length === 0 ? (
                      <div className="text-xs text-gray-400">Нет логов</div>
                    ) : campaignLogs.map((log) => (
                      <div key={log.id} className={`text-xs px-2 py-1 rounded ${log.level === 'error' ? 'bg-red-50 text-red-700' : log.level === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-700'}`}>
                        <span className="text-gray-400">{new Date(log.created_at).toLocaleTimeString()}</span>{' '}
                        {log.lead_name ? <span className="font-medium">[{log.lead_name}]</span> : null}{' '}
                        {log.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Leads */}
      {tab === 'leads' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Лиды ({leadsTotal})</h2>
            <div className="flex gap-2">
              <button onClick={() => setShowCreateListModal(true)} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Управление листами
              </button>
              <button onClick={() => setShowImportModal(true)} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Импорт CSV
              </button>
              <button onClick={() => void exportLeadsCsv()} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Экспорт CSV
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">Списки лидов:</span>
              <button
                onClick={() => setLeadListFilterId('')}
                className={`rounded-md px-2 py-1 text-xs ${leadListFilterId === '' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                Все
              </button>
              {leadLists.map((list) => (
                <button
                  key={list.id}
                  onClick={() => setLeadListFilterId(list.id)}
                  className={`rounded-md px-2 py-1 text-xs ${leadListFilterId === list.id ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {list.name}
                </button>
              ))}
            </div>
            {leadLists.length === 0 && (
              <p className="text-xs text-gray-400 mt-2">Списков пока нет.</p>
            )}
          </div>

          {/* Create List Modal */}
          {showCreateListModal && (
            <div className="fixed inset-0 z-40 bg-black/30 p-4 flex items-center justify-center">
              <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                  <h3 className="text-sm font-semibold text-gray-900">Manage Lead Lists</h3>
                  <button onClick={() => setShowCreateListModal(false)} disabled={creatingList} className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50">✕</button>
                </div>
                <div className="p-4 space-y-4">
                  <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                    <div className="text-xs font-medium text-gray-700 mb-2">Create New List</div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newListName}
                        onChange={(e) => setNewListName(e.target.value)}
                        placeholder="List name"
                        className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                      />
                      <button onClick={() => void createLeadList()} disabled={creatingList} className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                        {creatingList ? '...' : 'Create'}
                      </button>
                    </div>
                  </div>

                  <div className="max-h-[50vh] overflow-y-auto space-y-2 pr-1">
                    {leadLists.length === 0 ? (
                      <p className="text-xs text-gray-400">Списков пока нет.</p>
                    ) : leadLists.map((list) => (
                      <div key={list.id} className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => { setLeadListFilterId(list.id); setShowCreateListModal(false); }}
                            className={`text-left text-sm font-medium ${leadListFilterId === list.id ? 'text-blue-700' : 'text-gray-900 hover:text-blue-700'}`}
                          >
                            {list.name}
                            <span className="ml-2 text-xs font-normal text-gray-500">({list.leads_count ?? 0} leads)</span>
                          </button>
                          <div className="flex items-center gap-3">
                            <button onClick={() => void exportLeadListCsv(list)} className="text-xs text-blue-600 hover:underline">Export</button>
                            <button onClick={() => void deleteLeadList(list)} className="text-xs text-red-600 hover:underline">Delete</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Import CSV Modal */}
          {showImportModal && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">Импорт лидов из CSV</h3>
                <button onClick={() => setShowImportModal(false)} className="text-xs text-gray-500 hover:text-gray-700">Закрыть</button>
              </div>
              <p className="text-xs text-gray-500">
                Формат CSV: <code className="bg-gray-100 px-1 rounded">name, first_name, last_name, position, company, profile_url, public_identifier</code>
                <br />Первая строка — заголовки. Обязательное поле: <code className="bg-gray-100 px-1 rounded">name</code> (или <code className="bg-gray-100 px-1 rounded">first_name</code> + <code className="bg-gray-100 px-1 rounded">last_name</code>).
              </p>
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Список (опционально)</label>
                  <select value={importListId} onChange={(e) => setImportListId(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                    <option value="">Без списка</option>
                    {leadLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Файл CSV</label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    disabled={importing}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void importLeadsCsv(f);
                    }}
                    className="text-sm file:mr-2 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-blue-700 disabled:opacity-50"
                  />
                </div>
                {importing && <span className="text-xs text-gray-500">Импорт...</span>}
              </div>
            </div>
          )}

          <div className="max-h-[600px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 text-xs text-gray-500">Имя</th>
                  <th className="text-left px-3 py-2 text-xs text-gray-500">Должность</th>
                  <th className="text-left px-3 py-2 text-xs text-gray-500">Компания</th>
                  <th className="text-left px-3 py-2 text-xs text-gray-500">Статус</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      {lead.profile_url ? (
                        <a href={lead.profile_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{lead.name}</a>
                      ) : lead.name}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{lead.position ?? ''}</td>
                    <td className="px-3 py-2 text-gray-600">{lead.company ?? ''}</td>
                    <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded ${lead.status === 'replied' ? 'bg-green-100 text-green-700' : lead.status === 'connected' ? 'bg-blue-100 text-blue-700' : lead.status === 'invited' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>{lead.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Scraper */}
      {tab === 'scraper' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Скрапинг лидов</h2>
            <div className="flex gap-2">
              <button onClick={() => setScraperType('search')} className={`text-xs px-3 py-1.5 rounded-lg ${scraperType === 'search' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>Поиск по URL</button>
              <button onClick={() => setScraperType('reactions')} className={`text-xs px-3 py-1.5 rounded-lg ${scraperType === 'reactions' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>Реакции на пост</button>
            </div>
            <input type="text" placeholder={scraperType === 'search' ? 'LinkedIn search URL...' : 'LinkedIn post URL...'} value={scraperUrl} onChange={(e) => setScraperUrl(e.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            <div className="flex gap-3 flex-wrap">
              <select value={scraperAccountId} onChange={(e) => setScraperAccountId(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="">Аккаунт...</option>
                {accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name || a.unipile_account_id}</option>)}
              </select>
              <select value={scraperListId} onChange={(e) => setScraperListId(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="">Список (опционально)</option>
                {leadLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <input type="number" value={scraperMax} onChange={(e) => setScraperMax(Number(e.target.value))} className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              <button onClick={() => void startScrape()} className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium">Запустить</button>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Задачи</h3>
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border border-gray-200 px-3 py-2 text-sm flex items-center justify-between">
                <div>
                  <span className="font-medium">{t.type}</span>
                  <span className={`ml-2 text-xs px-2 py-0.5 rounded ${t.status === 'completed' ? 'bg-green-100 text-green-700' : t.status === 'running' ? 'bg-blue-100 text-blue-700' : t.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{t.status}</span>
                  <span className="text-xs text-gray-500 ml-2">{t.progress}/{t.total}</span>
                  {t.error_message && <span className="text-xs text-red-600 ml-2">{t.error_message}</span>}
                </div>
                {(t.status === 'pending' || t.status === 'running') && <button onClick={() => void cancelTask(t.id)} className="text-xs text-red-600 hover:underline">Отменить</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Accounts */}
      {tab === 'accounts' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">LinkedIn аккаунты (Unipile)</h2>
            <button onClick={() => void syncAccounts()} disabled={syncing} className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
              {syncing ? 'Синхронизация...' : 'Синхронизировать'}
            </button>
          </div>
          {accounts.length === 0 ? (
            <div className="text-sm text-gray-500">Нет аккаунтов. Настройте Unipile и нажмите «Синхронизировать».</div>
          ) : accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              errorCounts24h={accountErrorCounts[a.id]}
              onUpdated={() => { void loadAccounts(); void loadAccountErrorCounts(); }}
              onShowLogs={() => setAccountLogsModal(a)}
            />
          ))}
        </div>
      )}

      {/* Logs */}
      {tab === 'logs' && <LiLogsTab campaigns={campaigns} />}

      {/* Settings */}
      {tab === 'settings' && (
        <div className="rounded-xl border border-gray-200 p-4 space-y-4 max-w-lg">
          <h2 className="text-sm font-semibold text-gray-900">Настройки Unipile & OpenAI</h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-600">Unipile DSN</label>
              <input type="text" placeholder="api23.unipile.com:15321" value={settingsForm.unipile_dsn} onChange={(e) => setSettingsForm({ ...settingsForm, unipile_dsn: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm mt-1" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Unipile API Key</label>
              <input type="password" value={settingsForm.unipile_api_key} onChange={(e) => setSettingsForm({ ...settingsForm, unipile_api_key: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm mt-1" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Proxy (HTTP/HTTPS)</label>
              <input type="text" placeholder="http://user:pass@host:port" value={settingsForm.proxy_url} onChange={(e) => setSettingsForm({ ...settingsForm, proxy_url: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm mt-1" />
            </div>
          </div>
          <button onClick={() => void saveSettings()} disabled={savingSettings} className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
            {savingSettings ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      )}

      {/* Per-account log modal */}
      {accountLogsModal && (
        <AccountLogsModal
          account={accountLogsModal}
          onClose={() => setAccountLogsModal(null)}
        />
      )}
    </div>
  );
}

// ---- Account card -----------------------------------------------------------

function AccountCard({
  account: a,
  errorCounts24h,
  onUpdated,
  onShowLogs,
}: {
  account: LiAccount;
  errorCounts24h?: { error: number; warning: number };
  onUpdated: () => void;
  onShowLogs: () => void;
}) {
  const cooling = isAccountInCooldown(a);
  const [proxyDraft, setProxyDraft] = useState(a.proxy_url ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const dirty = proxyDraft !== (a.proxy_url ?? '');

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api(`/accounts/${a.id}`, { method: 'PATCH', json: { proxy_url: proxyDraft || null } });
      setMsg('Сохранено');
      onUpdated();
    } catch (e) {
      setMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Удалить запись аккаунта «${a.name || a.unipile_account_id}»?\n\nАккаунт в Unipile НЕ удалится — убирается только локальная карточка. Используйте для устаревших дубликатов.`)) {
      return;
    }
    setDeleting(true);
    setMsg(null);
    try {
      await api(`/accounts/${a.id}`, { method: 'DELETE' });
      onUpdated();
    } catch (e) {
      setMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
      setDeleting(false);
    }
  };

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm space-y-2 ${cooling ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200'}`}>
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onShowLogs}
              title="Открыть логи этого аккаунта"
              className="font-medium text-left hover:text-indigo-600 hover:underline transition cursor-pointer"
            >
              {a.name || a.unipile_account_id}
            </button>
            {errorCounts24h && errorCounts24h.error > 0 && (
              <button
                type="button"
                onClick={onShowLogs}
                title={`${errorCounts24h.error} ошибок${errorCounts24h.warning ? ` и ${errorCounts24h.warning} предупреждений` : ''} за 24ч — открыть логи`}
                className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100 transition cursor-pointer shrink-0"
              >
                ⚠ {errorCounts24h.error}
              </button>
            )}
            {a.headline && <span className="text-xs text-gray-500 truncate">{a.headline}</span>}
          </div>
          {cooling && (
            <div
              className="text-xs text-amber-700 mt-0.5"
              title={`Аккаунт в отлёжке до ${new Date(a.cooldown_until!).toLocaleString('ru-RU')}. LinkedIn вернул «${a.cooldown_reason}».`}
            >
              В отлёжке ещё {formatCooldownRemaining(a.cooldown_until!)} — {a.cooldown_reason ? COOLDOWN_REASON_LABELS[a.cooldown_reason] : '—'}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          <span className={`text-xs px-2 py-0.5 rounded ${cooling ? 'bg-amber-100 text-amber-700' : a.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
            {cooling ? 'В отлёжке' : a.is_active ? 'Активен' : 'Неактивен'}
          </span>
          <button
            onClick={() => void remove()}
            disabled={deleting}
            title="Удалить локальную запись аккаунта (устаревший дубликат)"
            className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-40"
          >
            {deleting ? '...' : 'Удалить'}
          </button>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="text-xs text-gray-500">
            Proxy <span className="text-gray-400">(любой формат: ip:port:user:pass, http://user:pass@host:port, host:port)</span>
          </label>
          <input
            type="text"
            placeholder="154.81.199.122:63310:VtVmt51R:7GnJr2Yb"
            value={proxyDraft}
            onChange={(e) => { setProxyDraft(e.target.value); setMsg(null); }}
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm mt-0.5 font-mono"
          />
        </div>
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-40 shrink-0"
        >
          {saving ? '...' : 'Сохранить'}
        </button>
      </div>
      {msg && <div className={`text-xs ${msg.startsWith('Ошибка') ? 'text-red-600' : 'text-green-600'}`}>{msg}</div>}
    </div>
  );
}

// ---- Logs tab ---------------------------------------------------------------

type LiLogEntry = {
  id: number;
  campaign_id: string;
  level: string;
  message: string;
  lead_name: string | null;
  step_index: number | null;
  created_at: string;
  campaign?: { name: string } | null;
};

function LiLogsTab({ campaigns }: { campaigns: LiCampaign[] }) {
  const [logs, setLogs] = useState<LiLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterCampaignId, setFilterCampaignId] = useState('');
  const [filterLevel, setFilterLevel] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '300' });
      if (filterCampaignId) params.set('campaign_id', filterCampaignId);
      if (filterLevel) params.set('level', filterLevel);
      const d = await api<{ items: LiLogEntry[]; total: number }>(`/logs?${params.toString()}`);
      const items = Array.isArray(d?.items) ? d.items : [];
      setLogs(items.slice().reverse());
      setTotal(typeof d?.total === 'number' ? d.total : items.length);
      setLoadError(null);
    } catch (e) {
      console.error('[li-outreach] fetchLogs failed', e);
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить логи');
    } finally {
      setLoading(false);
    }
  }, [filterCampaignId, filterLevel]);

  useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchLogs(), 5000);
    return () => clearInterval(interval);
  }, [fetchLogs, autoRefresh]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    isAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  useEffect(() => {
    if (isAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-emerald-400';
    }
  };

  const levelBadge = (l: string) => {
    switch (l) {
      case 'error': return 'ERR ';
      case 'warning': return 'WARN';
      default: return 'INFO';
    }
  };

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const warnCount = logs.filter((l) => l.level === 'warning').length;

  // Download buttons honour the currently-applied filters (campaign + level)
  // so the .txt file matches what the operator is actually looking at.
  const exportLogs = useCallback(
    async (range: '24h' | '7d') => {
      setExportingRange(range);
      try {
        const params = new URLSearchParams({ range });
        if (filterCampaignId) params.set('campaign_id', filterCampaignId);
        if (filterLevel) params.set('level', filterLevel);
        const res = await authFetch(`/api/tools/li-outreach/logs/export?${params.toString()}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert((data as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8 ? decodeURIComponent(utf8[1]) : (ascii?.[1] ?? `li-outreach-logs-${range}.txt`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingRange(null);
      }
    },
    [filterCampaignId, filterLevel],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={filterCampaignId}
            onChange={(e) => { setFilterCampaignId(e.target.value); setLoading(true); }}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs"
          >
            <option value="">Все кампании</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={filterLevel}
            onChange={(e) => { setFilterLevel(e.target.value); setLoading(true); }}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs"
          >
            <option value="">Все уровни</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
          <span className="text-xs text-gray-500">
            {total} записей
            {errorCount > 0 && <span className="ml-1.5 text-red-600">{errorCount} ошибок</span>}
            {warnCount > 0 && <span className="ml-1.5 text-amber-600">{warnCount} предупреждений</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Выгрузить .txt:</span>
          {(['24h', '7d'] as const).map((r) => {
            const labels: Record<typeof r, string> = { '24h': '24 часа', '7d': '7 дней' };
            const busy = exportingRange === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => void exportLogs(r)}
                disabled={exportingRange !== null}
                title={`Скачать логи за последние ${labels[r]}${filterCampaignId ? ' (текущая кампания)' : ' (все кампании)'}${filterLevel ? `, уровень ${filterLevel}` : ''}`}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? '...' : labels[r]}
              </button>
            );
          })}
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer ml-2">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Автообновление
          </label>
          <button onClick={() => { setLoading(true); void fetchLogs(); }} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            Обновить
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-[11px] leading-relaxed h-[540px] overflow-auto"
      >
        {loading && logs.length === 0 && !loadError && <p className="text-gray-500">Загрузка логов...</p>}
        {loadError && (
          <div className="text-rose-400">
            <div className="font-bold">Ошибка загрузки логов</div>
            <div className="text-gray-400 mt-1 break-all">{loadError}</div>
          </div>
        )}
        {!loading && !loadError && logs.length === 0 && <p className="text-gray-600">Нет логов. Запустите кампанию — здесь появятся записи.</p>}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2 py-[1px] hover:bg-gray-900/50">
            <span className="text-gray-600 shrink-0">{new Date(log.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className={`shrink-0 font-bold w-10 ${levelColor(log.level)}`}>{levelBadge(log.level)}</span>
            {!filterCampaignId && log.campaign && (
              <span className="shrink-0 text-blue-400 max-w-[140px] truncate">[{log.campaign.name}]</span>
            )}
            {log.lead_name && <span className="shrink-0 text-violet-400">{log.lead_name}</span>}
            {log.step_index != null && <span className="shrink-0 text-gray-600">step:{log.step_index}</span>}
            <span className="text-gray-300 break-all">{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---- Per-account log modal --------------------------------------------------

type AccountLogItem = {
  created_at: string;
  level: string;
  message: string;
  lead_name: string | null;
  step_index: number | null;
  campaign_id: string;
  campaign?: { name: string } | null;
};

function AccountLogsModal({ account, onClose }: { account: LiAccount; onClose: () => void }) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const [logs, setLogs] = useState<AccountLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ items: AccountLogItem[]; truncated: boolean }>(
        `/accounts/${account.id}/logs?range=${range}`,
      );
      setLogs(d.items ?? []);
      setTruncated(Boolean(d.truncated));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить логи');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [account.id, range]);

  useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  // Close on Escape so the modal feels native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  const exportTxt = useCallback(
    async (r: '24h' | '7d') => {
      setExportingRange(r);
      try {
        const res = await authFetch(`/api/tools/li-outreach/accounts/${account.id}/logs?range=${r}&format=txt`);
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          alert((d as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8
          ? decodeURIComponent(utf8[1])
          : (ascii?.[1] ?? `li-outreach-account-${r}.txt`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingRange(null);
      }
    },
    [account.id],
  );

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-emerald-400';
    }
  };
  const levelBadge = (l: string) => {
    switch (l) {
      case 'error': return 'ERR ';
      case 'warning': return 'WARN';
      default: return 'INFO';
    }
  };

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const warningCount = logs.filter((l) => l.level === 'warning').length;
  const cooling = isAccountInCooldown(account);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">
              {account.name || account.unipile_account_id}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              <span>Unipile ID: <span className="font-mono text-gray-700">{account.unipile_account_id}</span></span>
              {account.headline && <span className="truncate max-w-[260px]">{account.headline}</span>}
              <span>
                Статус:{' '}
                <span className={cooling ? 'text-amber-700' : account.is_active ? 'text-emerald-700' : 'text-gray-500'}>
                  {cooling ? 'В отлёжке' : account.is_active ? 'Активен' : 'Неактивен'}
                </span>
              </span>
              {cooling && account.cooldown_until && (
                <span className="text-amber-600">
                  до {new Date(account.cooldown_until).toLocaleString('ru-RU', {
                    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
                  })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 px-2 py-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>

        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">Период:</span>
            {(['24h', '7d'] as const).map((r) => {
              const labels: Record<typeof r, string> = { '24h': '24ч', '7d': '7д' };
              const active = range === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                  }`}
                >
                  {labels[r]}
                </button>
              );
            })}
          </div>
          <div className="text-xs text-gray-500">
            {loading ? '…' : (
              <>
                Всего строк: <span className="font-semibold text-gray-700">{logs.length}</span>
                {errorCount > 0 && (
                  <> · <span className="text-rose-600 font-semibold">{errorCount} ошибок</span></>
                )}
                {warningCount > 0 && (
                  <> · <span className="text-amber-600 font-semibold">{warningCount} предупреждений</span></>
                )}
                {truncated && (
                  <> · <span className="text-gray-400">(показано не всё — обрезано лимитом)</span></>
                )}
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">.txt:</span>
            {(['24h', '7d'] as const).map((r) => {
              const labels: Record<typeof r, string> = { '24h': '24ч', '7d': '7д' };
              const busy = exportingRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => void exportTxt(r)}
                  disabled={exportingRange !== null}
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? '...' : labels[r]}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-[11px] leading-relaxed">
          {loading && <p className="text-gray-500">Загрузка логов…</p>}
          {!loading && !error && logs.length === 0 && (
            <p className="text-gray-600">По этому аккаунту ничего не найдено в выбранном периоде.</p>
          )}
          {logs.map((log, idx) => (
            <div key={`${log.created_at}-${idx}`} className="flex gap-2 py-[1px] hover:bg-gray-900/50">
              <span className="text-gray-600 shrink-0">
                {new Date(log.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className={`shrink-0 font-bold w-10 ${levelColor(log.level)}`}>{levelBadge(log.level)}</span>
              {log.campaign?.name && (
                <span className="shrink-0 text-blue-400 max-w-[160px] truncate">[{log.campaign.name}]</span>
              )}
              {log.lead_name && <span className="shrink-0 text-violet-400">{log.lead_name}</span>}
              {log.step_index != null && <span className="shrink-0 text-gray-600">step:{log.step_index}</span>}
              <span className="text-gray-300 break-all">{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

// ---- Helper components ------------------------------------------------------

const ACCENT_STYLES: Record<string, { dot: string; bar: string }> = {
  green:  { dot: 'bg-green-500',  bar: 'bg-green-500' },
  blue:   { dot: 'bg-blue-500',   bar: 'bg-blue-500' },
  violet: { dot: 'bg-violet-500', bar: 'bg-violet-500' },
  gray:   { dot: 'bg-gray-400',   bar: 'bg-gray-400' },
};

function StatCard({ label, value, total, accent = 'gray' }: { label: string; value: number; total?: number; accent?: string }) {
  const s = ACCENT_STYLES[accent] ?? ACCENT_STYLES.gray;
  const pct = total && total > 0 ? Math.round((value / total) * 100) : null;
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className="text-2xl font-bold text-gray-900 mt-1">
        {value}{total !== undefined && total !== value ? <span className="text-sm font-normal text-gray-400">/{total}</span> : null}
      </div>
      {pct !== null && (
        <div className="mt-2 h-1 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ---- Funnel Chart (visual horizontal bars) ---------------------------------

const FUNNEL_STAGES: { key: keyof DashboardFunnel; label: string; color: string }[] = [
  { key: 'new',             label: 'Новые',                color: '#9ca3af' },
  { key: 'invited',         label: 'Приглашены',           color: '#f59e0b' },
  // Side-track: LinkedIn refused the invite as duplicate.
  // Sits right after 'invited' so the operator can compare
  // "actually sent" vs "already in LinkedIn's queue" at a glance.
  { key: 'already_invited', label: 'Уже приглашены ранее', color: '#a8a29e' },
  { key: 'connected',       label: 'Подключены',           color: '#3b82f6' },
  { key: 'messaged',        label: 'Написано',             color: '#8b5cf6' },
  { key: 'replied',         label: 'Ответили',             color: '#10b981' },
  { key: 'completed',       label: 'Завершено',            color: '#06b6d4' },
];

function FunnelChart({ funnel }: { funnel: DashboardFunnel }) {
  const max = Math.max(funnel.total, 1);
  if (funnel.total === 0) return <p className="text-xs text-gray-400">Нет лидов</p>;
  return (
    <div className="space-y-3">
      {FUNNEL_STAGES.map((stage) => {
        const count = funnel[stage.key] as number;
        const pct = Math.round((count / max) * 100);
        return (
          <div key={stage.key} className="flex items-center gap-3">
            <span className="w-28 text-xs font-medium text-gray-700 text-right">{stage.label}</span>
            <div className="flex-1 h-7 rounded-lg bg-gray-50 overflow-hidden relative">
              <div
                className="h-full rounded-lg transition-all duration-500"
                style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%`, backgroundColor: stage.color }}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-700 tabular-nums">
                {count}
              </span>
            </div>
            <span className="w-12 text-right text-xs tabular-nums text-gray-400">{pct}%</span>
          </div>
        );
      })}
      <div className="flex items-center gap-3 pt-1 border-t border-gray-100">
        <span className="w-28 text-xs font-semibold text-gray-900 text-right">Всего</span>
        <span className="text-sm font-bold text-gray-900 tabular-nums">{funnel.total}</span>
        {funnel.total > 0 && (
          <span className="text-xs text-gray-500">
            · конверсия в ответ: <span className="font-medium text-green-700">{Math.round((funnel.replied / funnel.total) * 100)}%</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ---- Activity Timeline (CSS-only bar chart) --------------------------------

function ActivityTimeline({ timeline }: { timeline: DashboardTimeline[] }) {
  const maxActions = Math.max(...timeline.map((d) => d.actions), 1);
  return (
    <div>
      <div className="flex items-end gap-[3px] h-28">
        {timeline.map((day) => {
          const h = Math.round((day.actions / maxActions) * 100);
          const hasError = day.errors > 0;
          const dateObj = new Date(day.date);
          const label = `${dateObj.getDate()}.${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
          return (
            <div key={day.date} className="flex-1 flex flex-col items-center justify-end h-full group relative">
              <div
                className={`w-full rounded-t transition-all ${hasError ? 'bg-red-400' : 'bg-blue-400'} group-hover:opacity-80`}
                style={{ height: `${Math.max(h, day.actions > 0 ? 3 : 0)}%`, minHeight: day.actions > 0 ? 2 : 0 }}
              />
              <div className="absolute -top-8 bg-gray-900 text-white text-[10px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10 transition-opacity">
                {label}: {day.actions} действий{hasError ? `, ${day.errors} ошибок` : ''}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[10px] text-gray-400">
        <span>{formatShortDate(timeline[0]?.date)}</span>
        <span>{formatShortDate(timeline[timeline.length - 1]?.date)}</span>
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-400" /> Действия</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-400" /> С ошибками</span>
        <span className="ml-auto tabular-nums">{timeline.reduce((s, d) => s + d.actions, 0)} всего за 30 дней</span>
      </div>
    </div>
  );
}

function formatShortDate(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---- Company Table ---------------------------------------------------------

function CompanyTable({ rows, search, sortKey }: { rows: DashboardCompanyRow[]; search: string; sortKey: string }) {
  const filtered = rows
    .filter((r) => !search || r.company.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const key = sortKey as keyof DashboardCompanyRow;
      return (b[key] as number) - (a[key] as number);
    });

  if (filtered.length === 0) return <p className="text-xs text-gray-400 py-4">Нет данных по компаниям</p>;

  const maxTotal = Math.max(...filtered.map((r) => r.total), 1);

  return (
    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-gray-100">
            <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Компания</th>
            <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Всего</th>
            <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Новые</th>
            <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Инвайты</th>
            <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Подключ.</th>
            <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Написано</th>
            <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Ответили</th>
            <th className="px-2 py-2 text-xs text-gray-500 font-medium w-28">Воронка</th>
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, 50).map((row) => {
            const replyRate = row.total > 0 ? Math.round((row.replied / row.total) * 100) : 0;
            const barW = Math.round((row.total / maxTotal) * 100);
            return (
              <tr key={row.company} className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="px-3 py-2 font-medium text-gray-900 max-w-[220px] truncate">{row.company}</td>
                <td className="px-2 py-2 text-right tabular-nums text-gray-700">{row.total}</td>
                <td className="px-2 py-2 text-right tabular-nums text-gray-500">{row.new}</td>
                <td className="px-2 py-2 text-right tabular-nums text-amber-700">{row.invited}</td>
                <td className="px-2 py-2 text-right tabular-nums text-blue-700">{row.connected}</td>
                <td className="px-2 py-2 text-right tabular-nums text-violet-700">{row.messaged}</td>
                <td className="px-2 py-2 text-right tabular-nums text-green-700 font-medium">{row.replied} <span className="text-gray-400 font-normal">({replyRate}%)</span></td>
                <td className="px-2 py-2">
                  <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden flex">
                    {row.replied > 0 && <div className="h-full bg-green-500" style={{ width: `${Math.round((row.replied / row.total) * barW)}%` }} />}
                    {row.connected > 0 && <div className="h-full bg-blue-400" style={{ width: `${Math.round((row.connected / row.total) * barW)}%` }} />}
                    {row.invited > 0 && <div className="h-full bg-amber-400" style={{ width: `${Math.round((row.invited / row.total) * barW)}%` }} />}
                    {row.new > 0 && <div className="h-full bg-gray-300" style={{ width: `${Math.round((row.new / row.total) * barW)}%` }} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length > 50 && <p className="text-xs text-gray-400 text-center py-2">Показаны первые 50 из {filtered.length}</p>}
    </div>
  );
}
