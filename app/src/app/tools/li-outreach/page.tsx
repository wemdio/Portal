'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch, authFetchJson, getAccessToken } from '@/lib/authFetch';
import { BarChart3, Megaphone, Search, UserCircle } from 'lucide-react';
import { CampaignRail } from '@/components/tg-outreach/CampaignRail';
import LiDashboard, { type LiActivity } from '@/components/li-outreach/LiDashboard';
import CampaignBases, { OrphanBases } from '@/components/li-outreach/CampaignBases';

// ---- Types ------------------------------------------------------------------

type Tab = 'dashboard' | 'campaigns' | 'scraper' | 'accounts';
const LI_TABS: readonly Tab[] = ['dashboard', 'campaigns', 'scraper', 'accounts'];
const LI_TAB_KEY = 'li-outreach:tab';

type LiAccountCooldownReason = 'invitation_limit' | 'already_invited' | 'account_restricted';
type LiAccount = {
  id: string;
  user_id: string;
  owner_name: string | null;
  unipile_account_id: string;
  name: string | null;
  is_active: boolean;
  profile_url: string | null;
  headline: string | null;
  last_synced_at: string | null;
  created_at: string;
  cooldown_until: string | null;
  cooldown_reason: LiAccountCooldownReason | null;
  /** Статус в Unipile как есть: OK, CREDENTIALS (разлогинен), ERROR… */
  unipile_status?: string | null;
  proxy_url: string | null;
  /** Кампании, привязанные к аккаунту (отдаёт GET /accounts). */
  campaigns?: Array<{ id: string; name: string; status: string }>;
};

const COOLDOWN_REASON_LABELS: Record<LiAccountCooldownReason, string> = {
  invitation_limit: 'лимит инвайтов LinkedIn',
  already_invited: 'уже приглашённые контакты',
  account_restricted: 'аккаунт ограничен LinkedIn',
};

// Русские лейблы статусов кампании для бейджей в списке. Бэкенд хранит
// статус в исходном виде (`draft`/`running`/...) — переводим только в UI.
const CAMPAIGN_STATUS_LABEL_RU: Record<string, string> = {
  draft: 'черновик',
  running: 'запущена',
  paused: 'пауза',
  stopped: 'остановлена',
  completed: 'завершена',
  failed: 'ошибка',
};

/** Статус аккаунта для карточки: отлёжка, затем статус Unipile (разлогинен, ошибка…). */
function liAccountStatus(a: Pick<LiAccount, 'is_active' | 'unipile_status' | 'cooldown_until'>): { text: string; cls: string; hint?: string } {
  if (isAccountInCooldown(a)) return { text: 'В отлёжке', cls: 'bg-amber-100 text-amber-700' };
  const status = (a.unipile_status ?? '').toUpperCase();
  const labels: Record<string, { text: string; hint?: string }> = {
    OK: { text: 'Активен' },
    CREDENTIALS: { text: 'Разлогинен', hint: 'LinkedIn разлогинил аккаунт: нужно заново войти в нём через Unipile' },
    ERROR: { text: 'Ошибка Unipile', hint: 'Unipile сообщает об ошибке аккаунта' },
    STOPPED: { text: 'Остановлен', hint: 'Аккаунт остановлен в Unipile' },
    CONNECTING: { text: 'Подключается' },
    PERMISSION_ERROR: { text: 'Нет прав', hint: 'У Unipile нет доступа к аккаунту' },
  };
  const known = labels[status];
  if (known) return { ...known, cls: status === 'OK' ? 'bg-green-100 text-green-700' : status === 'CONNECTING' ? 'bg-blue-100 text-blue-700' : 'bg-rose-100 text-rose-700' };
  if (status) return { text: status, cls: 'bg-rose-100 text-rose-700', hint: 'Статус аккаунта в Unipile' };
  return a.is_active ? { text: 'Активен', cls: 'bg-green-100 text-green-700' } : { text: 'Неактивен', cls: 'bg-gray-100 text-gray-600' };
}

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
type LiLeadList = { id: string; user_id?: string; owner_name?: string | null; name: string; description: string | null; created_at: string; has_custom_invites?: boolean; leads_count?: number; campaign_id?: string | null };
type LiLead = { id: string; name: string; first_name: string | null; last_name: string | null; position: string | null; company: string | null; profile_url: string | null; status: string; lead_list_id: string | null; invite_text: string | null; created_at: string };

type DashboardCompanyRow = { company: string; total: number; new: number; invited: number; connected: number; messaged: number; replied: number; completed: number; error: number };
type DashboardCampaignStat = {
  id: string; name: string; status: string; daily_invite_limit: number; invites_sent_today: number;
  leads_total: number; pending: number; in_progress: number; waiting: number; completed: number;
  error: number; skipped: number; replied: number; accepted: number; reply_rate: number; accept_rate: number;
  funnel: DashboardFunnel;
  activity: LiActivity;
};
type DashboardFunnel = { new: number; invited: number; already_invited: number; connected: number; messaged: number; replied: number; completed: number; error: number; total: number };
type DashboardData = {
  funnel: DashboardFunnel;
  by_company: DashboardCompanyRow[];
  campaign_stats: DashboardCampaignStat[];
  activity: LiActivity;
};

type LiCampaign = {
  id: string;
  user_id: string;
  owner_name: string | null;
  name: string;
  account_id: string | null;
  /** Все аккаунты кампании по порядку (отдаёт GET /campaigns). */
  account_ids?: string[];
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
  use_custom_invites: boolean;
  welcome_message: string | null;
  /** Окна "HH:MM-HH:MM", в которые runner работает. Пустой массив = 24/7. */
  working_hours: string[] | null;
  timezone_offset: number | null;
  created_at: string;
  updated_at: string;
};
/**
 * Background task row from `li_tasks`. `params` carries the exact inputs the
 * scraper was launched with (URL, account, list, max_results) — the UI uses
 * this to label rows AND repopulate the form via the «Повторить» button so
 * operators can re-run a scrape without retyping a search URL by hand.
 */
type LiTask = {
  id: string;
  type: 'search' | 'post_reactions' | 'csv_import' | string;
  status: string;
  progress: number;
  total: number;
  error_message: string | null;
  created_at: string;
  params: {
    search_url?: string;
    post_url?: string;
    account_id?: string;
    lead_list_id?: string;
    max_results?: number;
  } | null;
};
type LiCampaignLog = { id: number; level: string; message: string; lead_name: string | null; step_index: number | null; created_at: string };
type CampaignStep = { type?: unknown; message?: unknown; days?: unknown; hours?: unknown };

const UNLISTED_LEAD_LIST_FILTER = '__unlisted__';
const UNLISTED_LEAD_LIST_QUERY = '__none';

const DEFAULT_CAMPAIGN_FORM = {
  name: '',
  /** Аккаунты кампании: несколько, но один аккаунт — только в одной кампании. */
  account_ids: [] as string[],
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
  // Использовать персонализированный текст инвайта из колонки li_leads.invite_text
  // (импорт через «CSV с инвайтами»). Тумблер появляется в редакторе кампании
  // только если выбранный список имеет has_custom_invites=true.
  use_custom_invites: false,
  // Окна, в которые runner отправляет инвайты и сообщения. Формат
  // "HH:MM-HH:MM", несколько окон через запятую. Пустая строка = всегда
  // работает (24/7). Для новых кампаний дефолт — рабочий день MSK.
  working_hours: '09:00-18:00',
  timezone_offset: 3,
};

// ---- Helpers ----------------------------------------------------------------

async function api<T = unknown>(path: string, opts?: RequestInit & { json?: unknown }): Promise<T> {
  const body = opts?.json ? JSON.stringify(opts.json) : opts?.body;
  return authFetchJson<T>(`/api/tools/li-outreach${path}`, { ...opts, body });
}

// ---- Main page --------------------------------------------------------------

export default function LiOutreachPage() {
  const [tab, setTabState] = useState<Tab>('dashboard');
  // Открытая вкладка переживает перезагрузку страницы. Читаем после монтирования (не при первом
  // рендере — иначе разойдётся разметка сервера и клиента) и до тех пор ничего не грузим.
  const [tabReady, setTabReady] = useState(false);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LI_TAB_KEY);
      if (saved && (LI_TABS as readonly string[]).includes(saved)) setTabState(saved as Tab);
    } catch { /* хранилище недоступно — остаёмся на дашборде */ }
    setTabReady(true);
  }, []);
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    try { window.localStorage.setItem(LI_TAB_KEY, next); } catch { /* не критично */ }
  }, []);
  // Logged-in user — used to tell own vs other specialists' campaigns/accounts
  // apart now that everyone sees everyone's launches (read-only for others).
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
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
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set());
  const [deletingLeads, setDeletingLeads] = useState(false);
  const [campaigns, setCampaigns] = useState<LiCampaign[]>([]);
  const [tasks, setTasks] = useState<LiTask[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [campaignLogs, setCampaignLogs] = useState<LiCampaignLog[]>([]);
  // Флаги первичной загрузки для каждой вкладки. Показываем крутящийся
  // спиннер вместо «пусто», пока fetch летит — иначе пользователь видит
  // мгновение полного отсутствия данных и думает что вкладка сломана.
  // Для дашборда используется существующее dashLoading (см. loadDashboard).
  const [loadingCampaignLogs, setLoadingCampaignLogs] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingLeadLists, setLoadingLeadLists] = useState(false);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  // Range key currently being exported (button shows '...' until done).
  // Null when no export is in flight.
  const [exportingCampaignLogsRange, setExportingCampaignLogsRange] = useState<'24h' | '7d' | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Scraper form
  const [scraperUrl, setScraperUrl] = useState('');
  const [scraperAccountId, setScraperAccountId] = useState('');
  const [scraperListId, setScraperListId] = useState('');
  const [scraperMax, setScraperMax] = useState(100);
  const [scraperType, setScraperType] = useState<'search' | 'reactions'>('search');
  // Guards against double-clicks: the create-task POST is fast enough that a
  // user can click Запустить 3-4 times in a row and spawn duplicate scrape
  // tasks. Toggled around startScrape().
  const [startingScrape, setStartingScrape] = useState(false);

  const visibleLeadIds = useMemo(() => leads.map((lead) => lead.id), [leads]);
  const selectedVisibleLeadCount = useMemo(
    () => visibleLeadIds.filter((id) => selectedLeadIds.has(id)).length,
    [selectedLeadIds, visibleLeadIds],
  );
  const allVisibleLeadsSelected = visibleLeadIds.length > 0 && selectedVisibleLeadCount === visibleLeadIds.length;

  // Campaign creation
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  /** Страница кампании: настройки или логи (логи — только у существующей). */
  /** База, которую нужно раскрыть при открытии раздела «Базы» (переход из скрапера). */
  const [focusBaseId, setFocusBaseId] = useState<string | null>(null);
  const [campaignPageTab, setCampaignPageTab] = useState<'settings' | 'bases' | 'logs'>('settings');
  const [cf, setCf] = useState(DEFAULT_CAMPAIGN_FORM);

  /** Закрывает страницу кампании и возвращает к списку. Сама форма (`cf`) НЕ
   *  сбрасывается — её ресет делает openCreateCampaignForm. */
  const closeCampaignModal = useCallback(() => {
    setShowCreate(false);
    setEditingCampaignId(null);
  }, []);

  // Dashboard data
  const [dashData, setDashData] = useState<DashboardData | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [companySearch, setCompanySearch] = useState('');
  const [companySortKey, setCompanySortKey] = useState<'total' | 'replied' | 'connected' | 'invited'>('total');

  // CSV import
  const [importing, setImporting] = useState(false);
  const [importListId, setImportListId] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  // Inline error messages shown INSIDE the import modals — replaces the old
  // alert() so the user sees the reason (bad column, missing list, server 500)
  // right next to the file input and can retry without losing state.
  const [importError, setImportError] = useState<string | null>(null);
  const [importInvitesError, setImportInvitesError] = useState<string | null>(null);
  const [showCreateListModal, setShowCreateListModal] = useState(false);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [newListDescription, setNewListDescription] = useState('');

  // CSV import с персонализированными инвайтами. Отдельный поток от обычного:
  // 1) загружаем CSV с двумя колонками («LinkedIn ID», «Invite»), 2) бэкенд
  // создаёт новый список лидов с флагом has_custom_invites=true и заполняет
  // колонку invite_text. UI редактора кампании увидит флаг и покажет тумблер
  // «Использовать персонализированный инвайт» только для таких списков.
  const [showImportInvitesModal, setShowImportInvitesModal] = useState(false);
  const [importInvitesListName, setImportInvitesListName] = useState('');

  // ---- Data fetching --------------------------------------------------------

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try { const d = await api<{ accounts: LiAccount[] }>('/accounts'); setAccounts(d.accounts); } catch (e) { console.error('[li-outreach] loadAccounts failed', e); } finally { setLoadingAccounts(false); }
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
    setLoadingLeadLists(true);
    try { const d = await api<{ lead_lists: LiLeadList[] }>('/lead-lists'); setLeadLists(d.lead_lists); } catch (e) { console.error('[li-outreach] loadLeadLists failed', e); } finally { setLoadingLeadLists(false); }
  }, []);
  const loadLeads = useCallback(async (listId?: string) => {
    setLoadingLeads(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (listId === UNLISTED_LEAD_LIST_FILTER) params.set('lead_list_id', UNLISTED_LEAD_LIST_QUERY);
      else if (listId) params.set('lead_list_id', listId);
      const d = await api<{ leads: LiLead[]; total: number }>(`/leads?${params.toString()}`);
      setLeads(d.leads);
      setLeadsTotal(d.total);
      setSelectedLeadIds(new Set());
    } catch (e) {
      console.error('[li-outreach] loadLeads failed', e);
    } finally {
      setLoadingLeads(false);
    }
  }, []);
  const loadCampaigns = useCallback(async () => {
    setLoadingCampaigns(true);
    try { const d = await api<{ campaigns: LiCampaign[] }>('/campaigns'); setCampaigns(d.campaigns); } catch (e) { console.error('[li-outreach] loadCampaigns failed', e); } finally { setLoadingCampaigns(false); }
  }, []);
  const loadTasks = useCallback(async () => {
    setLoadingTasks(true);
    try { const d = await api<{ tasks: LiTask[] }>('/scraper/tasks'); setTasks(d.tasks); } catch (e) { console.error('[li-outreach] loadTasks failed', e); } finally { setLoadingTasks(false); }
  }, []);
  const loadCampaignLogs = useCallback(async (id: string) => {
    setLoadingCampaignLogs(true);
    try {
      const d = await api<{ items: LiCampaignLog[]; total: number }>(`/campaigns/${id}/logs`);
      setCampaignLogs(Array.isArray(d?.items) ? d.items : []);
    } catch (e) {
      console.error('[li-outreach] loadCampaignLogs failed', e);
      setCampaignLogs([]);
    } finally {
      setLoadingCampaignLogs(false);
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
            setCurrentUserId(s.user.id);
            void loadAccounts();
            void loadAccountErrorCounts();
            void loadCampaigns();
            void loadLeadLists();
            subscription.unsubscribe();
          }
        });
        return () => { cancelled = true; subscription.unsubscribe(); };
      }
      setCurrentUserId(session.user.id);
      void loadAccounts();
      void loadAccountErrorCounts();
      void loadCampaigns();
      void loadLeadLists();
    };
    void init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tabReady) return;
    if (tab === 'dashboard') { void loadDashboard(); void loadLeads(); void loadCampaigns(); }
    if (tab === 'campaigns') { void loadCampaigns(); void loadDashboard(); void loadLeadLists(); }
    if (tab === 'scraper' || tab === 'dashboard') void loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tabReady, leadListFilterId]);

  useEffect(() => {
    if (!selectedCampaignId) return;
    // Стираем прошлые логи сразу — иначе при переключении между
    // кампаниями секунду висят чужие сообщения и создают впечатление
    // что новая кампания уже что-то нашла.
    setCampaignLogs([]);
    void loadCampaignLogs(selectedCampaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCampaignId]);

  // Вкладка «Аккаунты»: воркер синхронизирует раз в 15 минут — подтягиваем изменения раз в минуту.
  useEffect(() => {
    if (tab !== 'accounts') return;
    const interval = window.setInterval(() => { void loadAccounts(); }, 60_000);
    return () => window.clearInterval(interval);
  }, [tab, loadAccounts]);

  // Скрапер живой: пока есть задача в работе — обновляем каждые 3 сек (прогресс идёт на глазах),
  // иначе раз в 15 сек. Когда задача завершилась, перечитываем базы: в них появились люди.
  const hasActiveTask = tasks.some((t) => t.status === 'pending' || t.status === 'running');
  const wasActiveTask = useRef(false);
  useEffect(() => {
    if (tab !== 'scraper') return;
    const interval = window.setInterval(() => {
      void loadTasks();
    }, hasActiveTask ? 3_000 : 15_000);
    return () => window.clearInterval(interval);
  }, [tab, loadTasks, hasActiveTask]);
  useEffect(() => {
    if (wasActiveTask.current && !hasActiveTask) void loadLeadLists();
    wasActiveTask.current = hasActiveTask;
  }, [hasActiveTask, loadLeadLists]);

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

  /** Когда последний раз синхронизировались: самая свежая отметка среди карточек. */
  const lastAccountSync = useMemo(
    () => accounts.reduce<string | null>((max, a) => (a.last_synced_at && (!max || a.last_synced_at > max) ? a.last_synced_at : max), null),
    [accounts],
  );
  const syncAccounts = async () => { setSyncing(true); try { await api('/accounts/sync', { method: 'POST', json: {} }); await loadAccounts(); } finally { setSyncing(false); } };
  const startCampaign = async (id: string) => { await api(`/campaigns/${id}/start`, { method: 'POST', json: {} }); await loadCampaigns(); };
  const stopCampaign = async (id: string) => { await api(`/campaigns/${id}/stop`, { method: 'POST', json: {} }); await loadCampaigns(); };
  const deleteCampaign = async (id: string) => { if (!confirm('Удалить кампанию?')) return; await api(`/campaigns/${id}`, { method: 'DELETE' }); await loadCampaigns(); };

  const startScrape = async () => {
    // Раньше тут было общее «Заполните URL и аккаунт» — операторы видели его
    // даже когда аккаунт-то как раз и был выбран, и шли искать причину не
    // там. Сообщения теперь персональные: говорят ровно про то поле, которое
    // пустое.
    if (startingScrape) return; // extra belt-and-suspenders vs double-click
    if (!scraperAccountId) { alert('Выберите LinkedIn-аккаунт справа от поля URL'); return; }
    if (!scraperUrl.trim()) {
      const hint = scraperType === 'search'
        ? 'Вставьте URL поиска LinkedIn People (https://www.linkedin.com/search/results/people/?keywords=…)'
        : 'Вставьте URL поста LinkedIn (https://www.linkedin.com/posts/…) — скрапер соберёт реакции';
      alert(hint);
      return;
    }
    // Снимок имён аккаунта и списка — чтобы даже после удаления аккаунта
    // (например, при дедупе li_accounts) задача продолжала показывать
    // человекочитаемое название, а не «аккаунт удалён».
    const accountSnapshot = accounts.find((a) => a.id === scraperAccountId);
    const listSnapshot = scraperListId ? leadLists.find((l) => l.id === scraperListId) : null;
    const accountName = accountSnapshot?.name || accountSnapshot?.unipile_account_id || null;
    const listName = listSnapshot?.name || null;
    const endpoint = scraperType === 'search' ? '/scraper/search' : '/scraper/reactions';
    const body = scraperType === 'search'
      ? { search_url: scraperUrl, account_id: scraperAccountId, account_name: accountName, lead_list_id: scraperListId || undefined, lead_list_name: listName, max_results: scraperMax }
      : { post_url: scraperUrl, account_id: scraperAccountId, account_name: accountName, lead_list_id: scraperListId || undefined, lead_list_name: listName, max_results: scraperMax };
    setStartingScrape(true);
    try {
      await api(endpoint, { method: 'POST', json: body });
      setScraperUrl('');
      void loadTasks();
    } finally {
      setStartingScrape(false);
    }
  };

  const cancelTask = async (taskId: string) => { await api(`/scraper/tasks/${taskId}/cancel`, { method: 'POST', json: {} }); void loadTasks(); };

  /**
   * «Повторить» — копирует параметры завершённой задачи в форму скрапера
   * вверху и переключает вкладку search/reactions, чтобы оператор мог сразу
   * нажать «Запустить». Поле lead_list_id — мягкий fallback: если список с
   * того момента удалили, оставляем пустым, иначе селект показал бы пустой
   * id и сбросился к «—».
   */
  const repeatTask = (task: LiTask) => {
    const params = task.params ?? {};
    const isReactions = task.type === 'post_reactions';
    setScraperType(isReactions ? 'reactions' : 'search');
    setScraperUrl(String(isReactions ? (params.post_url ?? '') : (params.search_url ?? '')));
    setScraperAccountId(params.account_id ?? '');
    const listStillExists = params.lead_list_id && leadLists.some((l) => l.id === params.lead_list_id);
    setScraperListId(listStillExists ? String(params.lead_list_id) : '');
    setScraperMax(typeof params.max_results === 'number' ? params.max_results : 100);
    // Прокрутим к форме чтобы оператор сразу увидел подставленные значения.
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /**
   * Название аккаунта для подписи под задачей. Читаем сначала снимок из
   * task.params.account_name (сохраняется при создании — переживёт даже
   * удаление аккаунта из li_accounts, например после дедупа). Если снимка
   * нет — идём в текущий список аккаунтов по id. Fallback — «аккаунт удалён»,
   * а НЕ 8-символьный ломоть UUID, который для пользователя чистый шум.
   */
  const accountLabel = (params: Record<string, unknown>): string => {
    const snapshot = String(params.account_name ?? '').trim();
    if (snapshot) return snapshot;
    const id = String(params.account_id ?? '').trim();
    if (!id) return '—';
    const acc = accounts.find((a) => a.id === id);
    return acc?.name || acc?.unipile_account_id || 'аккаунт удалён';
  };

  /** Название списка лидов по id — снимок → lookup → fallback. */
  const listLabel = (params: Record<string, unknown>): string => {
    const snapshot = String(params.lead_list_name ?? '').trim();
    if (snapshot) return snapshot;
    const id = String(params.lead_list_id ?? '').trim();
    if (!id) return 'без списка';
    const l = leadLists.find((x) => x.id === id);
    return l?.name ?? 'список удалён';
  };

  /** Перейти к базе, которую собрал скрапер: страница её кампании → «Базы» → база раскрыта. */
  const openScrapedBase = (listId: string) => {
    const list = leadLists.find((l) => l.id === listId);
    if (!list) return;
    const campaign = list.campaign_id ? campaigns.find((c) => c.id === list.campaign_id) : null;
    setTab('campaigns');
    if (campaign) {
      openEditCampaignForm(campaign);
      setCampaignPageTab('bases');
      setFocusBaseId(listId);
    }
  };

  /** Тип таски → человекочитаемое название. */
  const taskTypeLabelRu = (type: string): string => {
    if (type === 'search') return 'Поиск';
    if (type === 'post_reactions') return 'Реакции';
    return type;
  };

  /** Статус таски → русский лейбл. */
  const taskStatusLabelRu = (status: string): string => {
    switch (status) {
      case 'pending': return 'В очереди';
      case 'running': return 'Выполняется';
      case 'completed': return 'Готово';
      case 'failed': return 'Ошибка';
      case 'cancelled': return 'Отменено';
      default: return status;
    }
  };

  const createCampaign = async () => {
    if (!cf.name.trim()) { alert('Введите название кампании'); return; }
    if (cf.account_ids.length === 0) { alert('Выберите хотя бы один аккаунт'); return; }
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
          account_ids: cf.account_ids,
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
          use_custom_invites: cf.use_custom_invites,
          // UI хранит окна как строку через запятую (см. TG outreach
          // sleep_periods), API нормализатор принимает оба формата.
          working_hours: cf.working_hours
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          timezone_offset: cf.timezone_offset,
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
    setCampaignPageTab('settings');
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
      account_ids: campaign.account_ids?.length ? campaign.account_ids : campaign.account_id ? [campaign.account_id] : [],
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
      use_custom_invites: Boolean(campaign.use_custom_invites),
      // Из БД working_hours приходит массивом, в форме храним строкой через
      // запятую для редактирования. Пустой массив (legacy 24/7) → пустая
      // строка в поле, юзер видит что окон нет, и может либо оставить как
      // есть, либо ввести своё.
      working_hours: Array.isArray(campaign.working_hours) ? campaign.working_hours.join(', ') : '',
      timezone_offset: Number.isFinite(Number(campaign.timezone_offset))
        ? Number(campaign.timezone_offset)
        : DEFAULT_CAMPAIGN_FORM.timezone_offset,
    });
    setFocusBaseId(null);
    setEditingCampaignId(campaign.id);
    setSelectedCampaignId(campaign.id);
    setCampaignPageTab('settings');
    setShowCreate(true);
  };

  const exportLeadsCsv = async () => {
    // Приоритет scope'а: вручную отмеченные чекбоксы > выбранный лист > всё.
    // Раньше всегда экспортировалось всё — коллега открывал лист на 100 лидов,
    // жал «Экспорт CSV» и получал весь пул. Теперь чекбоксы (если есть) или
    // фильтр листа (если активен) сужают выборку до ожидаемой.
    const params = new URLSearchParams();
    if (selectedLeadIds.size > 0) {
      params.set('ids', Array.from(selectedLeadIds).join(','));
    } else if (leadListFilterId === UNLISTED_LEAD_LIST_FILTER) {
      params.set('lead_list_id', UNLISTED_LEAD_LIST_QUERY);
    } else if (leadListFilterId) {
      params.set('lead_list_id', leadListFilterId);
    }
    const query = params.toString();
    const res = await authFetch(`/api/tools/li-outreach/leads/export${query ? `?${query}` : ''}`);
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
    setImportError(null);
    try {
      if (!importListId) throw new Error('Выберите список для импорта');
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('lead_list_id', importListId);
      const res = await fetch('/api/tools/li-outreach/leads/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json() as {
        imported?: number;
        skipped?: number;
        already_contacted_skipped?: number;
        dup_in_file_skipped?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // На успехе показываем короткое summary в toast (можно и без) и
      // сразу закрываем модалку — пользователь видит новый список в чипсах.
      const alreadyContacted = data.already_contacted_skipped ?? 0;
      const dupInFile = data.dup_in_file_skipped ?? 0;
      const parts = [`Импортировано новых: ${data.imported ?? 0}`];
      if (alreadyContacted > 0) parts.push(`Уже контактировали (пропущено): ${alreadyContacted}`);
      if (dupInFile > 0) parts.push(`Дублей в файле (пропущено): ${dupInFile}`);
      if ((data.skipped ?? 0) > 0) parts.push(`Без валидных данных: ${data.skipped}`);
      alert(parts.join('\n'));
      setShowImportModal(false);
      await loadLeads(leadListFilterId);
      await loadLeadLists();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const importLeadsWithInvitesCsv = async (file: File) => {
    setImporting(true);
    setImportInvitesError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const fd = new FormData();
      fd.append('file', file);
      // Имя списка опционально: если пусто — бэкенд возьмёт имя файла.
      if (importInvitesListName.trim()) fd.append('list_name', importInvitesListName.trim());
      const res = await fetch('/api/tools/li-outreach/leads/import-with-invites', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json() as {
        imported?: number;
        skipped?: number;
        total_rows?: number;
        lead_list?: { id: string; name: string } | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const parts = [`Импортировано лидов: ${data.imported ?? 0}`];
      if (data.lead_list?.name) parts.push(`Создан список: «${data.lead_list.name}»`);
      if ((data.skipped ?? 0) > 0) parts.push(`Пропущено (нет имени/инвайта): ${data.skipped}`);
      alert(parts.join('\n'));
      setShowImportInvitesModal(false);
      setImportInvitesListName('');
      await loadLeadLists();
      // Сразу переключаем фильтр на новый список, чтобы пользователь видел
      // результат импорта без лишних кликов.
      if (data.lead_list?.id) setLeadListFilterId(data.lead_list.id);
      await loadLeads(data.lead_list?.id ?? leadListFilterId);
    } catch (e) {
      setImportInvitesError(e instanceof Error ? e.message : String(e));
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

  const toggleLeadSelection = (id: string, checked: boolean) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleVisibleLeadSelection = (checked: boolean) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleLeadIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const deleteSelectedLeads = async () => {
    const ids = Array.from(selectedLeadIds);
    if (!ids.length) return;

    const currentListName = leadLists.find((list) => list.id === leadListFilterId)?.name;
    const scopeLabel = leadListFilterId === UNLISTED_LEAD_LIST_FILTER
      ? 'без списка'
      : currentListName
        ? `из списка "${currentListName}"`
        : 'из общего списка';

    if (!confirm(`Удалить ${ids.length} выбранных лидов ${scopeLabel}? Это удалит их из базы.`)) return;

    setDeletingLeads(true);
    try {
      await api('/leads', { method: 'DELETE', json: { ids } });
      setSelectedLeadIds(new Set());
      await loadLeads(leadListFilterId);
      await loadLeadLists();
      if (tab === 'dashboard') await loadDashboard();
    } catch (e) {
      alert('Ошибка удаления лидов: ' + (e instanceof Error ? e.message : e));
    } finally {
      setDeletingLeads(false);
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

  const tabs = [
    { id: 'dashboard', label: 'Дашборд', icon: BarChart3 },
    { id: 'campaigns', label: 'Кампании', icon: Megaphone },
    { id: 'scraper', label: 'Скрапер', icon: Search },
    { id: 'accounts', label: 'Аккаунты', icon: UserCircle },
  ] as const;

  /** Базы и кампании перечитываем вместе: рассылаемая база — поле кампании. */
  const reloadBases = useCallback(async () => {
    await Promise.all([loadLeadLists(), loadCampaigns()]);
  }, [loadLeadLists, loadCampaigns]);

  const editingCampaign = useMemo(() => campaigns.find((c) => c.id === editingCampaignId) ?? null, [campaigns, editingCampaignId]);


  return (
    <div className="min-w-0 space-y-6 overflow-x-clip text-left max-w-full lg:pl-14">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">LinkedIn Outreach</h1>
        <p className="text-sm text-gray-500">Кампании, AI-персонализация, скрапинг лидов через Unipile.</p>
      </div>

      {/* Разделы — колонкой значков слева, как в TG-аутриче. */}
      <CampaignRail items={tabs} active={tab} onSelect={(id) => setTab(id as Tab)} />

      {/* Dashboard */}
      {tab === 'dashboard' && (
        <div className="space-y-5">
          {dashLoading && !dashData && <div className="text-center py-8 text-sm text-gray-400">Загрузка статистики…</div>}

          {dashData && (
            <LiDashboard
              data={dashData}
              accounts={accounts.filter((a) => a.user_id === currentUserId)}
              onOpenAccounts={() => setTab('accounts')}
              onOpenCampaigns={() => setTab('campaigns')}
            />
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
                            <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${cs.status === 'running' ? 'bg-green-100 text-green-700' : cs.status === 'draft' ? 'bg-gray-100 text-gray-600' : cs.status === 'paused' ? 'bg-amber-100 text-amber-700' : cs.status === 'completed' ? 'bg-cyan-100 text-cyan-700' : 'bg-gray-100 text-gray-600'}`}>
                              {cs.status === 'running' ? '● Активна' : CAMPAIGN_STATUS_LABEL_RU[cs.status] ?? cs.status}
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
              {accounts.filter((a) => a.user_id === currentUserId).length === 0 ? (
                <p className="text-xs text-gray-400">Нет аккаунтов. Откройте вкладку «Аккаунты» и нажмите «Синхронизировать».</p>
              ) : (
                <div className="space-y-2">
                  {accounts.filter((a) => a.user_id === currentUserId).map((a) => {
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
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={closeCampaignModal}
                  className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  ← Кампании
                </button>
                <h2 id="li-campaign-modal-title" className="min-w-0 truncate text-lg font-semibold text-gray-900">
                  {editingCampaignId ? (cf.name || 'Кампания') : 'Новая кампания'}
                </h2>
                {editingCampaign && (
                  <>
                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${editingCampaign.status === 'running' ? 'bg-green-100 text-green-700' : editingCampaign.status === 'draft' ? 'bg-gray-100 text-gray-600' : editingCampaign.status === 'completed' ? 'bg-cyan-100 text-cyan-700' : 'bg-amber-100 text-amber-700'}`}>
                      {CAMPAIGN_STATUS_LABEL_RU[editingCampaign.status] ?? editingCampaign.status}
                    </span>
                    <div className="ml-auto flex items-center gap-3 text-xs">
                      {editingCampaign.status !== 'running' && <button type="button" onClick={() => void startCampaign(editingCampaign.id)} className="cursor-pointer text-green-700 hover:underline">▶ Запустить</button>}
                      {editingCampaign.status === 'running' && <button type="button" onClick={() => void stopCampaign(editingCampaign.id)} className="cursor-pointer text-amber-700 hover:underline">⏹ Остановить</button>}
                    </div>
                  </>
                )}
              </div>
              {editingCampaignId && (
                <div role="tablist" aria-label="Разделы кампании" className="inline-flex rounded-full border border-gray-200 p-0.5 text-xs font-medium">
                  {(['settings', 'bases', 'logs'] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={campaignPageTab === id}
                      onClick={() => {
                        setCampaignPageTab(id);
                        if (id === 'logs' && editingCampaignId) void loadCampaignLogs(editingCampaignId);
                      }}
                      className={`cursor-pointer rounded-full px-4 py-1.5 transition ${campaignPageTab === id ? 'bg-[#4f46e5] text-white' : 'text-gray-500 hover:text-gray-800'}`}
                    >
                      {id === 'settings' ? 'Настройки' : id === 'bases' ? 'Базы' : 'Логи'}
                    </button>
                  ))}
                </div>
              )}
              {editingCampaignId && campaignPageTab === 'bases' ? (
                <CampaignBases
                  campaignId={editingCampaignId}
                  activeListId={editingCampaign?.lead_list_id ?? null}
                  bases={leadLists.filter((l) => l.campaign_id === editingCampaignId)}
                  onChanged={reloadBases}
                  focusBaseId={focusBaseId}
                  onOpenScraper={(listId) => { setScraperListId(listId); setTab('scraper'); }}
                />
              ) : editingCampaignId && campaignPageTab === 'logs' ? (
                <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-gray-900">Логи кампании</h3>
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
                      <button type="button" onClick={() => editingCampaignId && void loadCampaignLogs(editingCampaignId)} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Обновить</button>
                    </div>
                  </div>
                  <div className="max-h-[70vh] overflow-y-auto space-y-1">
                    {loadingCampaignLogs ? (
                      <div className="flex items-center justify-center py-10" role="status" aria-label="Загрузка логов">
                        <div className="h-6 w-6 rounded-full border-2 border-gray-200 border-t-blue-600 animate-spin" />
                      </div>
                    ) : campaignLogs.length === 0 ? (
                      <div className="text-xs text-gray-400">Нет логов</div>
                    ) : campaignLogs.map((log) => (
                      <div key={log.id} className={`text-xs px-2 py-1 rounded ${log.level === 'error' ? 'bg-red-50 text-red-700' : log.level === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-700'}`}>
                        <span className="text-gray-400">{new Date(log.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>{' '}
                        {log.lead_name ? <span className="font-medium">[{log.lead_name}]</span> : null}{' '}
                        {log.message}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Название *</label>
                  <input type="text" placeholder="Моя кампания" value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Аккаунты * <span className="text-gray-400">({cf.account_ids.length})</span></label>
                  <details className="group relative">
                    <summary className="flex w-full cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm">
                      <span className="truncate">
                        {cf.account_ids.length === 0
                          ? 'Выберите...'
                          : cf.account_ids.map((id) => { const a = accounts.find((x) => x.id === id); return a?.name || a?.unipile_account_id || 'аккаунт'; }).join(', ')}
                      </span>
                      <span className="text-gray-400 transition group-open:rotate-180">▾</span>
                    </summary>
                    <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-[#16171c] p-1 shadow-xl">
                      {accounts
                        .filter((a) => a.is_active || cf.account_ids.includes(a.id))
                        .map((a) => {
                          // Чужая кампания держит аккаунт — выбрать нельзя.
                          const busyIn = (a.campaigns ?? []).find((c) => c.id !== editingCampaignId);
                          const checked = cf.account_ids.includes(a.id);
                          return (
                            <label
                              key={a.id}
                              title={busyIn ? `Занят кампанией «${busyIn.name}»` : undefined}
                              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${busyIn && !checked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-white/5'}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={Boolean(busyIn) && !checked}
                                onChange={() => setCf({
                                  ...cf,
                                  account_ids: checked ? cf.account_ids.filter((id) => id !== a.id) : [...cf.account_ids, a.id],
                                })}
                              />
                              <span className="min-w-0 flex-1 truncate">{a.name || a.unipile_account_id}</span>
                              {busyIn && !checked && <span className="shrink-0 text-[10px] text-amber-500">занят: {busyIn.name}</span>}
                            </label>
                          );
                        })}
                    </div>
                  </details>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Рассылаемая база</label>
                  {editingCampaignId ? (
                    <select value={cf.lead_list_id} onChange={(e) => setCf({ ...cf, lead_list_id: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
                      <option value="">Без базы</option>
                      {leadLists.filter((l) => l.campaign_id === editingCampaignId).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}{l.has_custom_invites ? ' ✎ (с инвайтами)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
                      Базу загрузите после создания кампании — в разделе «Базы».
                    </div>
                  )}
                </div>
              </div>

              {/* Step 1: Invite */}
              {(() => {
                // Тумблер «Использовать персонализированный инвайт» имеет смысл
                // только если выбранный список лидов был импортирован через
                // «CSV с инвайтами» — иначе у лидов просто нет колонки
                // invite_text, и тумблер ничего не сделает. Поэтому отрисовываем
                // его условно: либо привязан подходящий список, либо тумблер
                // уже был включён ранее на этой кампании (чтобы при смене
                // списка пользователь увидел текущее состояние и мог его
                // выключить).
                const selectedList = leadLists.find((l) => l.id === cf.lead_list_id);
                const canUseCustomInvites = Boolean(selectedList?.has_custom_invites);
                const showCustomInvitesToggle = canUseCustomInvites || cf.use_custom_invites;
                return (
                  <div className="rounded-lg border-l-4 border-blue-400 bg-white p-3 space-y-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-xs font-semibold text-blue-700">Шаг 1 — Инвайт</div>
                      {showCustomInvitesToggle && (
                        <label
                          className={`flex items-center gap-1.5 text-xs cursor-pointer ${canUseCustomInvites ? 'text-emerald-700' : 'text-amber-700'}`}
                          title={
                            canUseCustomInvites
                              ? 'Брать персональный текст инвайта из CSV (вместо шаблона ниже). AI-персонализация пропускается — инвайт уже персонализирован.'
                              : 'Текущий список не содержит персонализированных инвайтов — тумблер ничего не изменит, пока не выберете подходящий список.'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={cf.use_custom_invites}
                            onChange={(e) => setCf({ ...cf, use_custom_invites: e.target.checked })}
                            className="rounded"
                          />
                          Использовать персонализированный инвайт из CSV
                        </label>
                      )}
                    </div>
                    <textarea
                      rows={2}
                      value={cf.invite_message}
                      onChange={(e) => setCf({ ...cf, invite_message: e.target.value })}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    {cf.use_custom_invites && (
                      <p className="text-[11px] text-emerald-700">
                        Включён персонализированный инвайт: у каждого лида берётся свой текст из CSV. Если у лида текста нет — fallback на шаблон выше.
                      </p>
                    )}
                  </div>
                );
              })()}

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
                  <label className="text-xs text-gray-600" title="Окна, в которые runner отправляет инвайты и сообщения. Несколько через запятую (например, 09:00-13:00, 14:00-18:00 для перерыва на обед). Пустое поле = работает 24/7.">Часы работы:</label>
                  <input
                    type="text"
                    value={cf.working_hours}
                    onChange={(e) => setCf({ ...cf, working_hours: e.target.value })}
                    placeholder="09:00-18:00"
                    className="w-40 rounded border border-gray-200 px-2 py-1 text-xs"
                  />
                  <label className="text-xs text-gray-600" title="Часовой пояс кампании в часах от UTC. Например, 3 для MSK.">UTC:</label>
                  <input
                    type="number"
                    min={-12}
                    max={14}
                    value={cf.timezone_offset}
                    onChange={(e) => setCf({ ...cf, timezone_offset: Number(e.target.value) || 0 })}
                    className="w-14 rounded border border-gray-200 px-2 py-1 text-xs"
                  />
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
            </div>
          )}

          {!showCreate && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Кампании <span className="font-normal text-gray-400">({campaigns.length})</span></h2>
                <button onClick={openCreateCampaignForm} className="cursor-pointer rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">+ Новая</button>
              </div>
              {loadingCampaigns && campaigns.length === 0 ? (
                <div className="flex items-center justify-center py-16" role="status" aria-label="Загрузка кампаний">
                  <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-blue-600 animate-spin" />
                </div>
              ) : campaigns.length === 0 ? (
                <div className="text-sm text-gray-500">Нет кампаний</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
                  {campaigns.map((c) => {
                    // isOwn: рамка карточки (чья кампания) и кнопка «Удалить» — удаление остаётся
                    // только у владельца в API, на чужих карточках кнопку не рисуем.
                    const isOwn = currentUserId != null && c.user_id === currentUserId;
                    const cs = dashData?.campaign_stats.find((x) => x.id === c.id);
                    return (
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openEditCampaignForm(c)}
                        onKeyDown={(e) => { if (e.key === 'Enter') openEditCampaignForm(c); }}
                        className={`group flex cursor-pointer flex-col rounded-xl border bg-white p-4 text-sm transition hover:shadow-sm ${isOwn ? 'border-gray-200 hover:border-indigo-300' : 'border-purple-200 border-l-4 border-l-purple-400 hover:border-purple-300'}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 truncate font-semibold text-gray-900">{c.name}</div>
                          <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${c.status === 'running' ? 'bg-green-100 text-green-700' : c.status === 'draft' ? 'bg-gray-100 text-gray-600' : c.status === 'completed' ? 'bg-cyan-100 text-cyan-700' : 'bg-amber-100 text-amber-700'}`}>{CAMPAIGN_STATUS_LABEL_RU[c.status] ?? c.status}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                          <span>{(c.steps ?? []).length} шагов</span>
                          <span>· AI: {c.use_ai ? 'вкл' : 'выкл'}</span>
                          <span>· лимит {c.daily_invite_limit}/день</span>
                          {c.use_custom_invites && (
                            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700" title="На шаге 1 берётся персональный текст инвайта каждого лида из CSV. AI-персонализация для инвайта пропускается.">✎ персональные инвайты</span>
                          )}
                          {!isOwn && (
                            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700" title="Кампанию добавил другой специалист. Редактирование, старт и стоп доступны всей команде.">👤 {c.owner_name ?? 'другой спец'}</span>
                          )}
                        </div>
                        {cs ? (
                          <div className="mt-3 grid grid-cols-4 gap-2 border-t border-gray-100 pt-3">
                            {[
                              { label: 'Лидов', value: cs.leads_total },
                              { label: 'Сегодня', value: `${cs.invites_sent_today}/${cs.daily_invite_limit}` },
                              { label: 'Принято', value: cs.accepted },
                              { label: 'Ответили', value: cs.replied },
                            ].map((m) => (
                              <div key={m.label} className="min-w-0">
                                <div className="text-[10px] text-gray-400">{m.label}</div>
                                <div className="text-sm font-semibold tabular-nums text-gray-900">{m.value}</div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 flex items-center gap-3 text-xs">
                          {c.status !== 'running' && <button onClick={(e) => { e.stopPropagation(); void startCampaign(c.id); }} className="cursor-pointer text-green-700 hover:underline">▶ Запустить</button>}
                          {c.status === 'running' && <button onClick={(e) => { e.stopPropagation(); void stopCampaign(c.id); }} className="cursor-pointer text-amber-700 hover:underline">⏹ Остановить</button>}
                          {isOwn && <button onClick={(e) => { e.stopPropagation(); void deleteCampaign(c.id); }} className="ml-auto cursor-pointer text-red-600 hover:underline">Удалить</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <OrphanBases
                bases={leadLists.filter((l) => !l.campaign_id)}
                campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, lead_list_id: c.lead_list_id }))}
                onChanged={reloadBases}
              />
            </div>
          )}
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
                {accounts
                  .filter((a) => a.is_active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name || a.unipile_account_id}
                    </option>
                  ))}
              </select>
              <select value={scraperListId} onChange={(e) => setScraperListId(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <option value="">Список (опционально)</option>
                {leadLists.map((l) => <option key={l.id} value={l.id}>{l.name}{l.campaign_id ? ` · ${campaigns.find((c) => c.id === l.campaign_id)?.name ?? 'кампания'}` : ''}</option>)}
              </select>
              <input type="number" value={scraperMax} onChange={(e) => setScraperMax(Number(e.target.value))} className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              <button
                onClick={() => void startScrape()}
                disabled={startingScrape}
                className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {startingScrape ? 'Запускаем…' : 'Запустить'}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Задачи</h3>
            {loadingTasks && tasks.length === 0 && (
              <div className="flex items-center justify-center py-16" role="status" aria-label="Загрузка задач">
                <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-blue-600 animate-spin" />
              </div>
            )}
            {tasks.map((t) => {
              const params = t.params ?? {};
              const taskUrl = String(t.type === 'post_reactions' ? (params.post_url ?? '') : (params.search_url ?? ''));
              const canRepeat = t.type === 'search' || t.type === 'post_reactions';
              return (
                <div key={t.id} className="rounded-xl border border-gray-200 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{taskTypeLabelRu(t.type)}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${t.status === 'completed' ? 'bg-green-100 text-green-700' : t.status === 'running' ? 'bg-blue-100 text-blue-700' : t.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{taskStatusLabelRu(t.status)}</span>
                      <span className="text-xs tabular-nums text-gray-500">{t.progress}/{t.total}</span>
                      {t.error_message && <span className="text-xs text-red-600">{t.error_message}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      {canRepeat && t.status !== 'pending' && t.status !== 'running' && (
                        <button
                          onClick={() => repeatTask(t)}
                          className="text-xs text-blue-600 hover:underline"
                          title="Подставить параметры этой задачи в форму выше"
                        >
                          Повторить
                        </button>
                      )}
                      {(t.status === 'pending' || t.status === 'running') && (
                        <button onClick={() => void cancelTask(t.id)} className="text-xs text-red-600 hover:underline">Отменить</button>
                      )}
                    </div>
                  </div>
                  {(t.status === 'pending' || t.status === 'running') && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.total > 0 ? Math.round((t.progress / t.total) * 100) : 0}>
                        <div className={`h-full rounded-full bg-blue-500 transition-all duration-700 ${t.total > 0 ? '' : 'w-1/3 animate-pulse'}`} style={t.total > 0 ? { width: `${Math.min(100, Math.round((t.progress / t.total) * 100))}%` } : undefined} />
                      </div>
                      <span className="text-[11px] tabular-nums text-gray-400">{t.total > 0 ? `${Math.round((t.progress / t.total) * 100)}%` : 'собираем…'}</span>
                    </div>
                  )}
                  {/* Параметры задачи: URL + аккаунт + список + лимит + время.
                      Лежат в li_tasks.params (jsonb), а не на отдельных колонках —
                      воркер парсит payload по типу таски. URL обрезаем CSS-ом
                      (truncate) чтобы длинная LinkedIn-ссылка не растягивала
                      строку, при клике открываем в новой вкладке. */}
                  {(taskUrl || params.account_id || params.lead_list_id) && (
                    <div className="mt-1.5 space-y-0.5 text-xs text-gray-500">
                      {taskUrl && (
                        <div className="truncate">
                          <a
                            href={taskUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                            title={taskUrl}
                          >
                            {taskUrl}
                          </a>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span>аккаунт: <span className="text-gray-700">{accountLabel(params)}</span></span>
                        <span>
                          база:{' '}
                          {params.lead_list_id && leadLists.some((l) => l.id === params.lead_list_id) ? (
                            <button
                              type="button"
                              onClick={() => openScrapedBase(String(params.lead_list_id))}
                              className="cursor-pointer text-blue-600 hover:underline"
                              title="Открыть базу, в которую собраны люди"
                            >
                              {listLabel(params)} →
                            </button>
                          ) : (
                            <span className="text-gray-700">{listLabel(params)}</span>
                          )}
                        </span>
                        {typeof params.max_results === 'number' && (
                          <span>лимит: <span className="text-gray-700">{params.max_results}</span></span>
                        )}
                        <span className="text-gray-400">
                          {new Date(t.created_at).toLocaleString('ru-RU', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Accounts */}
      {tab === 'accounts' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">LinkedIn аккаунты (Unipile)</h2>
              <p className="text-[11px] text-gray-400">
                Аккаунты подтягиваются из Unipile сами, раз в 15 минут: ушедшие пропадают, разлогиненные получают статус.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500" title="Время последней синхронизации с Unipile">
                {lastAccountSync ? `Синхронизировано: ${new Date(lastAccountSync).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Ещё не синхронизировалось'}
              </span>
              <button onClick={() => void syncAccounts()} disabled={syncing} className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
                {syncing ? 'Синхронизация...' : 'Синхронизировать'}
              </button>
            </div>
          </div>
          {loadingAccounts && accounts.length === 0 ? (
            <div className="flex items-center justify-center py-16" role="status" aria-label="Загрузка аккаунтов">
              <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-blue-600 animate-spin" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="text-sm text-gray-500">Нет аккаунтов. Настройте Unipile и нажмите «Синхронизировать».</div>
          ) : accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              isOwn={currentUserId != null && a.user_id === currentUserId}
              errorCounts24h={accountErrorCounts[a.id]}
              onUpdated={() => { void loadAccounts(); void loadAccountErrorCounts(); }}
              onShowLogs={() => setAccountLogsModal(a)}
            />
          ))}
        </div>
      )}

      {/* Logs */}

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
  isOwn,
  errorCounts24h,
  onUpdated,
  onShowLogs,
}: {
  account: LiAccount;
  isOwn: boolean;
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

  const linkedCampaigns = a.campaigns ?? [];
  const runningCampaigns = linkedCampaigns.filter((c) => c.status === 'running');

  const remove = async () => {
    // Удалить может любой: удаление не блокируется даже запущенной кампанией
    // (решение 08.10.2026), поэтому о ней предупреждаем первой строкой.
    const lines = [`Удалить карточку «${a.name || a.unipile_account_id}»?`];
    if (runningCampaigns.length > 0) {
      lines.push(`⚠ Запущенная кампания ${runningCampaigns.map((c) => `«${c.name}»`).join(', ')} останется без аккаунта и встанет, пока ей не выберут другой.`);
    } else if (linkedCampaigns.length > 0) {
      lines.push(`Кампании останутся без аккаунта: ${linkedCampaigns.map((c) => `«${c.name}»`).join(', ')}.`);
    }
    lines.push('В Unipile аккаунт останется; если он подключён, карточка вернётся при синхронизации.');
    if (!confirm(lines.join('\n\n'))) return;
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
          <div className="flex items-center gap-2 flex-wrap">
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
          {(() => {
            const st = liAccountStatus(a);
            return <span className={`text-xs px-2 py-0.5 rounded ${st.cls}`} title={st.hint}>{st.text}</span>;
          })()}
          <button
            onClick={() => void remove()}
            disabled={deleting}
            title="Удалить карточку аккаунта из портала (например, устаревший дубль)"
            className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-40"
          >
            {deleting ? '...' : 'Удалить'}
          </button>
        </div>
      </div>
      {linkedCampaigns.length > 0 && (
        <div className="text-xs text-gray-500 truncate" title={linkedCampaigns.map((c) => `${c.name} — ${CAMPAIGN_STATUS_LABEL_RU[c.status] ?? c.status}`).join('\n')}>
          Кампании: {linkedCampaigns.map((c) => `${c.name} (${CAMPAIGN_STATUS_LABEL_RU[c.status] ?? c.status})`).join(', ')}
        </div>
      )}
      {/* Proxy, logs and delete are open to the whole team; `isOwn` only
       *  tints the card and the «добавил» chip. */}
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
                <span className={cooling ? 'text-amber-700' : account.is_active ? 'text-emerald-700' : 'text-rose-600'} title={liAccountStatus(account).hint}>
                  {liAccountStatus(account).text}
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
