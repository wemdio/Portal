'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch, authFetchJson, getAccessToken } from '@/lib/authFetch';
import { Archive, ArchiveRestore, ArrowLeft, BarChart3, Eye, Megaphone, Pause, Pencil, Play, Search, Square, Trash2, UserCircle } from 'lucide-react';
import { RowActionsMenu, type RowAction } from '@/components/sender/RowActionsMenu';
import { CampaignRail } from '@/components/tg-outreach/CampaignRail';
import LiDashboard, { type LiActivity, type LiDashPeriod } from '@/components/li-outreach/LiDashboard';
import CampaignBases, { OrphanBases } from '@/components/li-outreach/CampaignBases';
import CampaignSummary from '@/components/li-outreach/CampaignSummary';
import TaskLeadsModal, { type TaskLead } from '@/components/li-outreach/TaskLeadsModal';

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
// Колонки строки кампании: шапка и строки делят одну сетку, цифры выровнены вправо.
// Название чуть уже, пять колонок делят остальное поровну: промежутки одинаковые, действия — в меню «⋯».
const CAMPAIGN_ROW_GRID = 'grid grid-cols-[minmax(180px,1fr)_110px_96px_minmax(170px,1.2fr)_88px_72px_80px_64px_104px_44px] items-center gap-4';

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

type DashboardCampaignStat = {
  id: string; name: string; status: string; daily_invite_limit: number; invites_sent_today: number;
  leads_total: number; pending: number; in_progress: number; waiting: number; completed: number;
  error: number; skipped: number; replied: number; accepted: number; reply_rate: number; accept_rate: number;
  completed_period?: number; error_period?: number; skipped_period?: number;
  funnel: DashboardFunnel;
  activity: LiActivity;
};
type DashboardFunnel = { new: number; invited: number; already_invited: number; connected: number; messaged: number; replied: number; completed: number; error: number; total: number };
type DashboardData = {
  period?: { from: string; to: string; days: number };
  funnel: DashboardFunnel;
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
  /** Не null — кампания в архиве (убрана из основного списка). */
  archived_at?: string | null;
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

/** Модель AI для LinkedIn-кампаний: одна на всех, не настраивается. */
const LI_AI_MODEL = 'google/gemini-3.1-pro-preview';

/** Задач скрапера на странице. */
const TASKS_PER_PAGE = 10;

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
  followup1_enabled: true,
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
  ai_model: LI_AI_MODEL,
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
  const [showArchivedCampaigns, setShowArchivedCampaigns] = useState(false);
  const [tasks, setTasks] = useState<LiTask[]>([]);
  const [tasksPage, setTasksPage] = useState(0);
  const [viewTask, setViewTask] = useState<LiTask | null>(null);
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
  const [campaignPageTab, setCampaignPageTab] = useState<'summary' | 'settings' | 'bases' | 'logs'>('summary');
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
  const [dashPeriod, setDashPeriod] = useState<LiDashPeriod>({ mode: '30', from: '', to: '' });

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
  const loadDashboard = useCallback(async (period: LiDashPeriod = dashPeriod) => {
    setDashLoading(true);
    const query = period.mode === 'custom'
      ? (period.from && period.to ? `?from=${period.from}&to=${period.to}` : '')
      : `?days=${period.mode}`;
    try { const d = await api<DashboardData>(`/dashboard${query}`); setDashData(d); } catch (e) { console.error('[li-outreach] loadDashboard failed', e); } finally { setDashLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashPeriod]);

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
  const archiveCampaign = async (id: string, archived: boolean) => { await api(`/campaigns/${id}`, { method: 'PUT', json: { archived } }); await loadCampaigns(); };
  /** Действия строки кампании — в меню «⋯». */
  const campaignActions = (c: LiCampaign): RowAction[] => {
    const items: RowAction[] = [];
    if (c.status === 'running') items.push({ label: 'Остановить', icon: Square, onClick: () => void stopCampaign(c.id) });
    else if (!c.archived_at) items.push({ label: 'Запустить', icon: Play, onClick: () => void startCampaign(c.id) });
    if (c.status !== 'running') {
      items.push(c.archived_at
        ? { label: 'Вернуть из архива', icon: ArchiveRestore, onClick: () => void archiveCampaign(c.id, false) }
        : { label: 'В архив', icon: Archive, onClick: () => void archiveCampaign(c.id, true) });
    }
    items.push({ label: 'Удалить', icon: Trash2, danger: true, onClick: () => void deleteCampaign(c.id) });
    return items;
  };
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

  const deleteTask = async (taskId: string) => {
    if (!confirm('Удалить задачу из списка? Собранные контакты останутся в базе.')) return;
    try {
      await api(`/scraper/tasks/${taskId}`, { method: 'DELETE' });
      await loadTasks();
    } catch (e) {
      alert('Ошибка: ' + (e instanceof Error ? e.message : e));
    }
  };

  /** Контакты, которые собрала задача, — для окна по значку «глаз». */
  const loadTaskLeads = (taskId: string) =>
    api<{ leads: TaskLead[]; total: number; listMissing?: boolean }>(`/scraper/tasks/${taskId}/leads`);

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

  /** Тело запроса кампании из формы — одно и для создания, и для автосохранения. */
  const buildCampaignBody = () => {
    const steps: { type: string; message?: string; days?: number; hours?: number }[] = [
      { type: 'invite', message: cf.invite_message },
      ...(cf.followup1_enabled
        ? [
            { type: 'wait', days: cf.followup1_days, hours: cf.followup1_hours },
            { type: 'message', message: cf.followup1_message },
          ]
        : []),
    ];
    if (cf.followup2_enabled && cf.followup1_enabled) {
      steps.push({ type: 'wait', days: cf.followup2_days, hours: cf.followup2_hours });
      steps.push({ type: 'message', message: cf.followup2_message });
    }
    return {
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
      ai_model: LI_AI_MODEL,
      use_custom_invites: cf.use_custom_invites,
      // UI хранит окна как строку через запятую (см. TG outreach
      // sleep_periods), API нормализатор принимает оба формата.
      working_hours: cf.working_hours
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      timezone_offset: cf.timezone_offset,
    };
  };

  const createCampaign = async () => {
    if (!cf.name.trim()) { alert('Введите название кампании'); return; }
    if (cf.account_ids.length === 0) { alert('Выберите хотя бы один аккаунт'); return; }
    setCreating(true);
    try {
      await api(editingCampaignId ? `/campaigns/${editingCampaignId}` : '/campaigns', {
        method: editingCampaignId ? 'PUT' : 'POST',
        json: buildCampaignBody(),
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

  // Автосохранение настроек существующей кампании (как в «TG Аутриче»): через 0,8 с после
  // последней правки. Сохранения идут по очереди; первый снимок после открытия — точка отсчёта.
  const [autoSave, setAutoSave] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ state: 'idle' });
  const autoSaveBaseline = useRef<string | null>(null);
  const autoSaveChain = useRef<Promise<void>>(Promise.resolve());
  const autoSaveBody = useRef(buildCampaignBody);
  autoSaveBody.current = buildCampaignBody;
  useEffect(() => {
    autoSaveBaseline.current = null;
    setAutoSave({ state: 'idle' });
  }, [editingCampaignId]);
  const cfKey = JSON.stringify(cf);
  useEffect(() => {
    if (!showCreate || !editingCampaignId) return;
    if (autoSaveBaseline.current === null) {
      autoSaveBaseline.current = cfKey;
      return;
    }
    if (cfKey === autoSaveBaseline.current) return;
    if (!cf.name.trim() || cf.account_ids.length === 0) {
      setAutoSave({ state: 'error', message: 'Нужны название и хотя бы один аккаунт — изменения пока не сохранены' });
      return;
    }
    setAutoSave({ state: 'idle' });
    const campaignId = editingCampaignId;
    const timer = setTimeout(() => {
      autoSaveChain.current = autoSaveChain.current.then(async () => {
        setAutoSave({ state: 'saving' });
        try {
          await api(`/campaigns/${campaignId}`, { method: 'PUT', json: autoSaveBody.current() });
          autoSaveBaseline.current = cfKey;
          setAutoSave({ state: 'saved' });
          void loadCampaigns();
        } catch (e) {
          setAutoSave({ state: 'error', message: e instanceof Error ? e.message : 'Не удалось сохранить настройки' });
        }
      });
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfKey, showCreate, editingCampaignId]);

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
      followup1_enabled: Boolean(waitSteps[0] || messageSteps[0]),
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
    setCampaignPageTab('summary');
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
      if (!importListId) throw new Error('Выберите базу контактов для импорта');
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
      const parts = [`Импортировано контактов: ${data.imported ?? 0}`];
      if (data.lead_list?.name) parts.push(`Создана база: «${data.lead_list.name}»`);
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
    if (!confirm(`Удалить базу "${list.name}"?`)) return;
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

    if (!confirm(`Удалить ${ids.length} выбранных контактов ${scopeLabel}? Это удалит их из базы.`)) return;

    setDeletingLeads(true);
    try {
      await api('/leads', { method: 'DELETE', json: { ids } });
      setSelectedLeadIds(new Set());
      await loadLeads(leadListFilterId);
      await loadLeadLists();
      if (tab === 'dashboard') await loadDashboard();
    } catch (e) {
      alert('Ошибка удаления контактов: ' + (e instanceof Error ? e.message : e));
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

  const archivedCount = campaigns.filter((c) => c.archived_at).length;
  const visibleCampaigns = campaigns.filter((c) => !!c.archived_at === showArchivedCampaigns);
  const editingCampaign = useMemo(() => campaigns.find((c) => c.id === editingCampaignId) ?? null, [campaigns, editingCampaignId]);


  return (
    <div className="no-focus-ring min-w-0 space-y-6 overflow-x-clip text-left max-w-full lg:pl-14">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">LinkedIn Outreach</h1>
        <p className="text-sm text-gray-500">Кампании, AI-персонализация, скрапинг контактов через Unipile.</p>
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
              period={dashPeriod}
              onPeriodChange={(next) => { setDashPeriod(next); if (next.mode !== 'custom' || (next.from && next.to)) void loadDashboard(next); }}
              accounts={accounts.filter((a) => a.user_id === currentUserId)}
              onOpenAccounts={() => setTab('accounts')}
              onOpenCampaigns={() => setTab('campaigns')}
            />
          )}

          {/* Campaign performance */}
          {dashData && dashData.campaign_stats.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-gray-900">Кампании — эффективность</h3>
                {/* Цвета относятся только к полосе «Обработано за период» */}
                <div className="flex items-center gap-3 text-[10px] text-gray-500 flex-wrap" title="Цвета полосы «Обработано за период»">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-500" /> Завершено</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-400" /> Ошибка</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-400" /> Пропущено</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-100 border border-gray-200" /> В работе / ожидают</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Кампания</th>
                      <th className="text-center px-2 py-2 text-xs text-gray-500 font-medium">Статус</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium" title="Сколько контактов сейчас в рассылке этой кампании">Контактов в рассылке</th>
                      <th
                        className="text-right px-2 py-2 text-xs text-gray-500 font-medium"
                        title="Сколько инвайтов отправлено сегодня из дневного лимита. Счётчик сбрасывается в полночь."
                      >
                        Инвайтов сегодня
                      </th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Принято</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium">Ответили</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium" title="Принято / отправлено инвайтов за выбранный период">Принято, %</th>
                      <th className="text-right px-2 py-2 text-xs text-gray-500 font-medium" title="Ответили / приняли за выбранный период">Ответили, %</th>
                      <th
                        className="px-2 py-2 text-xs text-gray-500 font-medium w-56"
                        title="Обработано за выбранный период = Завершено + Ошибки + Пропущено от общего числа контактов в кампании"
                      >
                        Обработано за период
                        <span className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 text-gray-500 text-[9px] cursor-help" title="Доля контактов, по которым кампания уже отработала все шаги либо остановилась (успех / ошибка / пропуск). Остальные — в работе или ждут очереди.">?</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashData.campaign_stats.map((cs) => {
                      // Всё за выбранный период, кроме «Осталось»: оно считается на сейчас.
                      const completedP = cs.completed_period ?? cs.completed;
                      const errorP = cs.error_period ?? cs.error;
                      const skippedP = cs.skipped_period ?? cs.skipped;
                      const processed = completedP + errorP + skippedP;
                      const invitesP = cs.activity.timeline.reduce((sum, d) => sum + d.invites, 0);
                      const acceptPct = invitesP > 0 ? `${Math.min(100, Math.round((cs.accepted / invitesP) * 100))}%` : '—';
                      const replyPct = cs.accepted > 0 ? `${Math.min(100, Math.round((cs.replied / cs.accepted) * 100))}%` : '—';
                      const doneRatio = cs.leads_total > 0 ? Math.round((processed / cs.leads_total) * 100) : 0;
                      const pendingActive = cs.pending + cs.in_progress + cs.waiting;
                      const pctCompleted = cs.leads_total > 0 ? (completedP / cs.leads_total) * 100 : 0;
                      const pctError = cs.leads_total > 0 ? (errorP / cs.leads_total) * 100 : 0;
                      const pctSkipped = cs.leads_total > 0 ? (skippedP / cs.leads_total) * 100 : 0;
                      return (
                        <tr key={cs.id} className="li-row-hover border-b border-gray-50 hover:bg-gray-50/50">
                          <td className="px-3 py-2.5 font-medium text-gray-900 max-w-[200px] truncate">{cs.name}</td>
                          <td className="px-2 py-2.5 text-center">
                            <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${cs.status === 'running' ? 'bg-green-100 text-green-700' : cs.status === 'draft' ? 'bg-gray-100 text-gray-600' : cs.status === 'paused' || cs.status === 'stopped' ? 'bg-amber-100 text-amber-700' : cs.status === 'completed' ? 'bg-cyan-100 text-cyan-700' : 'bg-gray-100 text-gray-600'}`}>
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
                          <td className="px-2 py-2.5 text-right tabular-nums">{acceptPct}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{replyPct}</td>
                          <td className="px-2 py-2.5">
                            <ProcessedCell cs={cs} processed={processed} doneRatio={doneRatio} pendingActive={pendingActive} completed={completedP} error={errorP} skipped={skippedP}>
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
                            </ProcessedCell>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Campaigns */}
      {tab === 'campaigns' && (
        <div className="space-y-4">
          {/* Create Campaign Panel */}
          {showCreate && (
            <div className="space-y-4">
              {/* Шапка как в «Рассылке»: назад, название, статус, крупный пуск/стоп и шестерёнка настроек. */}
              <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 pb-4">
                <button
                  type="button"
                  onClick={closeCampaignModal}
                  aria-label="К списку кампаний"
                  title="К списку кампаний"
                  className="cursor-pointer rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <h2 id="li-campaign-modal-title" className="min-w-0 truncate text-xl font-semibold text-gray-900">
                  {editingCampaignId ? (cf.name || 'Кампания') : 'Новая кампания'}
                </h2>
                {editingCampaign && (
                  <>
                    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${editingCampaign.status === 'running' ? 'bg-green-100 text-green-700' : editingCampaign.status === 'draft' ? 'bg-gray-100 text-gray-600' : editingCampaign.status === 'completed' ? 'bg-cyan-100 text-cyan-700' : 'bg-amber-100 text-amber-700'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${editingCampaign.status === 'running' ? 'bg-green-500' : editingCampaign.status === 'draft' ? 'bg-gray-400' : editingCampaign.status === 'completed' ? 'bg-cyan-500' : 'bg-amber-500'}`} />
                      {CAMPAIGN_STATUS_LABEL_RU[editingCampaign.status] ?? editingCampaign.status}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      {editingCampaign.status === 'running' ? (
                        <button
                          type="button"
                          onClick={() => void stopCampaign(editingCampaign.id)}
                          className="li-run-btn li-run-btn-stop inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs font-medium"
                        >
                          <Pause className="h-3.5 w-3.5" />
                          Остановить
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void startCampaign(editingCampaign.id)}
                          className="li-run-btn li-run-btn-start inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
                        >
                          <Play className="h-3.5 w-3.5" />
                          {editingCampaign.status === 'draft' ? 'Запустить' : 'Продолжить'}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
              {editingCampaignId && (
                <div role="tablist" aria-label="Разделы кампании" className="inline-flex gap-1 rounded-xl border border-gray-200 p-1 text-sm font-medium">
                  {(['summary', 'bases', 'logs', 'settings'] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={campaignPageTab === id}
                      onClick={() => {
                        setCampaignPageTab(id);
                        if (id === 'logs' && editingCampaignId) void loadCampaignLogs(editingCampaignId);
                      }}
                      className={`li-switch-btn cursor-pointer rounded-lg px-4 py-1.5 ${campaignPageTab === id ? 'li-switch-btn-on' : ''}`}
                    >
                      {id === 'summary' ? 'Сводка' : id === 'bases' ? 'Базы' : id === 'logs' ? 'Логи' : 'Настройки'}
                    </button>
                  ))}
                </div>
              )}
              {editingCampaignId && campaignPageTab === 'summary' ? (
                <CampaignSummary
                  stats={dashData?.campaign_stats.find((x) => x.id === editingCampaignId)}
                  periodText={dashData?.period ? `за ${dashData.period.days} дн.` : 'за 30 дней'}
                  period={dashPeriod}
                  onPeriodChange={(next) => { setDashPeriod(next); if (next.mode !== 'custom' || (next.from && next.to)) void loadDashboard(next); }}
                  accounts={(editingCampaign?.account_ids ?? [])
                    .map((id) => accounts.find((a) => a.id === id))
                    .filter((a): a is NonNullable<typeof a> => !!a)
                    .map((a) => ({ id: a.id, name: a.name || a.unipile_account_id }))}
                />
              ) : editingCampaignId && campaignPageTab === 'bases' ? (
                <CampaignBases
                  campaignId={editingCampaignId}
                  activeListId={editingCampaign?.lead_list_id ?? null}
                  bases={leadLists.filter((l) => l.campaign_id === editingCampaignId)}
                  onChanged={reloadBases}
                  focusBaseId={focusBaseId}
                  accounts={accounts.filter((a) => a.is_active).map((a) => ({ id: a.id, label: a.name || a.unipile_account_id }))}
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
                          // Запущенная чужая кампания держит аккаунт — выбрать нельзя. Остановленная отдаёт его.
                          const busyIn = (a.campaigns ?? []).find((c) => c.id !== editingCampaignId && c.status === 'running');
                          const takenFrom = (a.campaigns ?? []).find((c) => c.id !== editingCampaignId && c.status !== 'running');
                          const checked = cf.account_ids.includes(a.id);
                          return (
                            <label
                              key={a.id}
                              title={busyIn ? `Занят запущенной кампанией «${busyIn.name}»` : takenFrom ? `Будет забран из остановленной кампании «${takenFrom.name}»` : undefined}
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
                              {takenFrom && !checked && !busyIn && <span className="shrink-0 text-[10px] text-gray-400">заберётся из остановленной: {takenFrom.name}</span>}
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
                        <div
                          className={`text-xs ${canUseCustomInvites ? 'text-emerald-700' : 'text-amber-700'}`}
                          title={
                            canUseCustomInvites
                              ? 'Брать персональный текст инвайта из CSV (вместо шаблона ниже). AI-персонализация пропускается — инвайт уже персонализирован.'
                              : 'Текущая база не содержит персонализированных инвайтов — тумблер ничего не изменит, пока не выберете подходящую базу.'
                          }
                        >
                          <LiSwitch
                            checked={cf.use_custom_invites}
                            onChange={(v) => setCf({ ...cf, use_custom_invites: v })}
                            label="Использовать персонализированный инвайт из CSV"
                          />
                        </div>
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
                        Включён персонализированный инвайт: у каждого контакта берётся свой текст из CSV. Если у контакта текста нет — fallback на шаблон выше.
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
                <div className="flex items-center gap-3">
                  <LiSwitch checked={cf.followup1_enabled} onChange={(v) => setCf({ ...cf, followup1_enabled: v, followup2_enabled: v ? cf.followup2_enabled : false })} label="Включить" />
                  <div className="text-xs font-semibold text-green-700">Шаг 3 — Follow-up #1</div>
                </div>
                {cf.followup1_enabled && (<>
                <div className="flex gap-2 items-center">
                  <label className="text-xs text-gray-500">Задержка:</label>
                  <input type="number" min={0} value={cf.followup1_days} onChange={(e) => setCf({ ...cf, followup1_days: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                  <span className="text-xs text-gray-400">дней</span>
                  <input type="number" min={0} max={23} value={cf.followup1_hours} onChange={(e) => setCf({ ...cf, followup1_hours: +e.target.value })} className="w-16 rounded border border-gray-200 px-2 py-1 text-xs" />
                  <span className="text-xs text-gray-400">часов</span>
                </div>
                <textarea rows={2} value={cf.followup1_message} onChange={(e) => setCf({ ...cf, followup1_message: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                </>)}
              </div>

              {/* Step 4: Follow-up 2 (optional) */}
              <div className="rounded-lg border-l-4 border-amber-400 bg-white p-3 space-y-2">
                <div className="flex items-center gap-3">
                  <LiSwitch checked={cf.followup2_enabled && cf.followup1_enabled} disabled={!cf.followup1_enabled} onChange={(v) => setCf({ ...cf, followup2_enabled: v })} label="Включить" />
                  <div className="text-xs font-semibold text-amber-700">Шаг 4 — Follow-up #2</div>
                </div>
                {cf.followup2_enabled && cf.followup1_enabled && (
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
                <LiSwitch checked={cf.use_ai} onChange={(v) => setCf({ ...cf, use_ai: v })} label="AI-персонализация" />
                <LiSwitch checked={cf.stop_on_reply} onChange={(v) => setCf({ ...cf, stop_on_reply: v })} label="Стоп при ответе" />
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
                    <LiSwitch checked={cf.use_ai_followup} onChange={(v) => setCf({ ...cf, use_ai_followup: v })} label="AI для follow-up" />
                  </div>
                </div>
              </details>

              {editingCampaignId ? (
                <div className="sticky bottom-3 z-10 flex justify-center">
                  <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl border border-gray-200 bg-white/95 px-6 py-2.5 text-xs shadow-lg backdrop-blur" aria-live="polite">
                    {autoSave.state === 'saving' ? (
                      <span className="inline-flex items-center gap-1.5 text-gray-500"><span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />Сохраняю…</span>
                    ) : autoSave.state === 'error' ? (
                      <span role="alert" className="text-red-600">{autoSave.message}</span>
                    ) : autoSave.state === 'saved' ? (
                      <span role="status" className="inline-flex items-center gap-1 text-emerald-600">✓ Сохранено, кампания применит сразу</span>
                    ) : (
                      <span className="text-gray-400">Изменения сохраняются автоматически</span>
                    )}
                  </div>
                </div>
              ) : (
                <button onClick={() => void createCampaign()} disabled={creating} className="rounded-lg bg-green-600 text-white px-5 py-2 text-sm font-medium disabled:opacity-50">
                  {creating ? 'Создание...' : 'Создать кампанию'}
                </button>
              )}
                </div>
              )}
            </div>
          )}

          {!showCreate && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-gray-900">
                  Кампании
                </h2>
                <div className="flex items-center gap-2">
                  <div className="li-period inline-flex gap-1 rounded-xl border p-1 text-sm" role="tablist" aria-label="Активные или архивные кампании">
                    {([['Активные', false, campaigns.length - archivedCount], ['Архив', true, archivedCount]] as const).map(([label, archived, count]) => (
                      <button
                        key={label}
                        type="button"
                        role="tab"
                        aria-selected={showArchivedCampaigns === archived}
                        onClick={() => setShowArchivedCampaigns(archived)}
                        className={`li-switch-btn cursor-pointer rounded-lg px-4 py-2 font-medium ${showArchivedCampaigns === archived ? 'li-switch-btn-on' : ''}`}
                      >
                        {label} ({count})
                      </button>
                    ))}
                  </div>
                  <button onClick={openCreateCampaignForm} className="cursor-pointer rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">+ Новая кампания</button>
                </div>
              </div>
              {loadingCampaigns && campaigns.length === 0 ? (
                <div className="flex items-center justify-center py-16" role="status" aria-label="Загрузка кампаний">
                  <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-blue-600 animate-spin" />
                </div>
              ) : visibleCampaigns.length === 0 ? (
                <div className="text-sm text-gray-500">{showArchivedCampaigns ? 'Архив пуст' : 'Нет кампаний'}</div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                  <div className="min-w-[1120px] text-sm">
                    <div className={`${CAMPAIGN_ROW_GRID} border-b border-gray-100 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-gray-400`}>
                      <div>Кампания</div>
                      <div>Статус</div>
                      <div>Контактов</div>
                      <div>Прогресс</div>
                      <div className="text-right">Сегодня</div>
                      <div className="text-right">Принято</div>
                      <div className="text-right">Ответили</div>
                      <div className="text-right">Ошибок</div>
                      <div className="text-right">Создана</div>
                      <div />
                    </div>
                    {visibleCampaigns.map((c) => {
                      // Кампания ничья: создавший её нигде не показывается, запускать, править и удалять может любой.
                      const cs = dashData?.campaign_stats.find((x) => x.id === c.id);
                      const processed = cs ? cs.completed + cs.error + cs.skipped : 0;
                      const progress = cs && cs.leads_total > 0 ? Math.round((processed / cs.leads_total) * 100) : 0;
                      const created = new Date(c.created_at);
                      return (
                        <div
                          key={c.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => openEditCampaignForm(c)}
                          onKeyDown={(e) => { if (e.key === 'Enter') openEditCampaignForm(c); }}
                          className={`${CAMPAIGN_ROW_GRID} cursor-pointer border-b border-gray-100 px-4 py-3 last:border-b-0 hover:bg-gray-50 li-row-hover li-campaign-row`}
                        >
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-gray-900">{c.name}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                              <span>{(c.steps ?? []).length} шагов</span>
                              <span>· AI: {c.use_ai ? 'вкл' : 'выкл'}</span>
                              {c.use_custom_invites && (
                                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700" title="На шаге 1 берётся персональный текст инвайта каждого контакта из CSV. AI-персонализация для инвайта пропускается.">✎ персональные инвайты</span>
                              )}
                            </div>
                          </div>
                          <div>
                            <span className={`rounded-md px-2 py-0.5 text-xs ${c.status === 'running' ? 'bg-green-100 text-green-700' : c.status === 'draft' ? 'bg-gray-100 text-gray-600' : c.status === 'completed' ? 'bg-cyan-100 text-cyan-700' : 'bg-amber-100 text-amber-700'}`}>{CAMPAIGN_STATUS_LABEL_RU[c.status] ?? c.status}</span>
                          </div>
                          <div className="font-semibold tabular-nums text-gray-900">{cs ? cs.leads_total : '—'}</div>
                          <div className="min-w-0">
                            {cs && cs.leads_total > 0 ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100">
                                    <div className="h-full rounded-full bg-green-500" style={{ width: `${progress}%` }} />
                                  </div>
                                  <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-gray-700">{progress}%</span>
                                </div>
                                <div className="mt-0.5 text-[10px] tabular-nums text-gray-500">{processed} из {cs.leads_total}</div>
                              </>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </div>
                          <div className="text-right font-semibold tabular-nums text-gray-900" title="Отправлено инвайтов сегодня / дневной лимит">{cs ? `${cs.invites_sent_today}/${cs.daily_invite_limit}` : '—'}</div>
                          <div className="text-right font-semibold tabular-nums text-gray-900">{cs ? cs.accepted : '—'}</div>
                          <div className="text-right font-semibold tabular-nums text-gray-900">{cs ? cs.replied : '—'}</div>
                          <div className={`text-right font-semibold tabular-nums ${cs && cs.error > 0 ? 'text-rose-600' : 'text-gray-400'}`}>{cs ? cs.error : '—'}</div>
                          <div className="text-right text-xs tabular-nums text-gray-500">{created.toLocaleDateString('ru-RU')}</div>
                          <div className="flex justify-end">
                            <RowActionsMenu items={campaignActions(c)} vertical />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <OrphanBases
                bases={leadLists.filter((l) => !l.campaign_id)}
                campaigns={campaigns.filter((c) => !c.archived_at).map((c) => ({ id: c.id, name: c.name, lead_list_id: c.lead_list_id }))}
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
            <h2 className="text-sm font-semibold text-gray-900">Скрапинг контактов</h2>
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
                <option value="">База контактов (опционально)</option>
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
            {!loadingTasks && tasks.length === 0 && <p className="text-sm text-gray-500">Задач пока нет.</p>}
            {tasks.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <table className="w-full min-w-[1000px] table-fixed text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs text-gray-500">
                      <th className="w-[11%] px-3 py-2 text-left font-medium">Тип</th>
                      <th className="w-[11%] px-3 py-2 text-left font-medium">Статус</th>
                      <th className="w-[18%] py-2 pl-3 pr-6 text-left font-medium">Прогресс</th>
                      <th className="w-[20%] py-2 pl-6 pr-3 text-left font-medium">Источник</th>
                      <th className="w-[13%] px-3 py-2 text-left font-medium">Аккаунт</th>
                      
                      <th className="w-[8%] px-3 py-2 text-right font-medium">Лимит</th>
                      <th className="w-[10%] px-3 py-2 text-right font-medium">Создана</th>
                      <th className="w-[96px] px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.slice(tasksPage * TASKS_PER_PAGE, (tasksPage + 1) * TASKS_PER_PAGE).map((t) => {
                      const params = t.params ?? {};
                      const taskUrl = String(t.type === 'post_reactions' ? (params.post_url ?? '') : (params.search_url ?? ''));
                      const active = t.status === 'pending' || t.status === 'running';
                      const pct = t.total > 0 ? Math.min(100, Math.round((t.progress / t.total) * 100)) : 0;
                                            return (
                        <tr key={t.id} className="li-row-hover border-b border-gray-50 align-top hover:bg-gray-50/50">
                          <td className="px-3 py-2.5 font-medium text-gray-900">{taskTypeLabelRu(t.type)}</td>
                          <td className="px-3 py-2.5">
                            <span className={`rounded-md px-2 py-0.5 text-xs ${t.status === 'completed' ? 'bg-green-100 text-green-700' : t.status === 'running' ? 'bg-blue-100 text-blue-700' : t.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{taskStatusLabelRu(t.status)}</span>
                          </td>
                          <td className="py-2.5 pl-3 pr-6">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                                <div className={`h-full rounded-full transition-all duration-700 ${t.status === 'failed' ? 'bg-red-400' : t.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'} ${active && t.total === 0 ? 'w-1/3 animate-pulse' : ''}`} style={active && t.total === 0 ? undefined : { width: `${pct}%` }} />
                              </div>
                              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-gray-500">{t.progress}/{t.total}</span>
                            </div>
                            {t.error_message && <div className="mt-1 text-xs text-red-600">{t.error_message}</div>}
                          </td>
                          <td className="py-2.5 pl-6 pr-3">
                            {taskUrl ? (
                              <a href={taskUrl} target="_blank" rel="noopener noreferrer" title={taskUrl} className="block truncate text-blue-600 hover:underline">{taskUrl}</a>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="truncate px-3 py-2.5 text-gray-700" title={accountLabel(params)}>{accountLabel(params)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{typeof params.max_results === 'number' ? params.max_results : '—'}</td>
                          <td className="px-3 py-2.5 text-right text-xs tabular-nums text-gray-500">
                            {new Date(t.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center justify-end gap-0.5">
                              {active ? (
                                <button type="button" onClick={() => void cancelTask(t.id)} className="px-2 py-1 text-xs text-red-600 hover:underline">Отменить</button>
                              ) : (
                                <>
                                  <button type="button" onClick={() => setViewTask(t)} aria-label="Посмотреть собранные контакты" title="Посмотреть собранные контакты" className="li-icon-btn cursor-pointer rounded-lg p-1.5">
                                    <Eye className="h-4 w-4" />
                                  </button>
                                  <button type="button" onClick={() => void deleteTask(t.id)} aria-label="Удалить задачу" title="Удалить задачу из списка" className="li-icon-btn li-icon-btn-danger cursor-pointer rounded-lg p-1.5">
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {tasks.length > TASKS_PER_PAGE && (
              <div className="flex items-center justify-between pt-1 text-xs text-gray-500">
                <span>{tasksPage * TASKS_PER_PAGE + 1}–{Math.min(tasks.length, (tasksPage + 1) * TASKS_PER_PAGE)} из {tasks.length}</span>
                <div className="flex gap-2">
                  <button type="button" disabled={tasksPage === 0} onClick={() => setTasksPage((p) => Math.max(0, p - 1))} className="li-page-btn cursor-pointer rounded-lg border px-3 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-40">← Назад</button>
                  <button type="button" disabled={(tasksPage + 1) * TASKS_PER_PAGE >= tasks.length} onClick={() => setTasksPage((p) => p + 1)} className="li-page-btn cursor-pointer rounded-lg border px-3 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-40">Вперёд →</button>
                </div>
              </div>
            )}
            {viewTask && (
              <TaskLeadsModal
                key={viewTask.id}
                title={`Контакты задачи: ${taskTypeLabelRu(viewTask.type)}`}
                load={() => loadTaskLeads(viewTask.id)}
                onClose={() => setViewTask(null)}
              />
            )}
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
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <table className="w-full min-w-[980px] table-fixed text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs text-gray-500">
                    <th className="w-[24%] px-3 py-2 text-left font-medium">Аккаунт</th>
                    <th className="w-[13%] px-3 py-2 text-left font-medium">Статус</th>
                    <th className="w-[30%] px-3 py-2 text-left font-medium">Используется в кампании</th>
                    <th className="w-[20%] px-3 py-2 text-left font-medium">Прокси</th>
                    <th className="w-[11%] px-3 py-2 text-right font-medium">Добавлен</th>
                    <th className="w-[56px] px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      errorCounts24h={accountErrorCounts[a.id]}
                      onUpdated={() => { void loadAccounts(); void loadAccountErrorCounts(); }}
                      onShowLogs={() => setAccountLogsModal(a)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

// ---- Account row ------------------------------------------------------------

function AccountRow({
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
  const [editingProxy, setEditingProxy] = useState(false);
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
      setEditingProxy(false);
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

  const st = liAccountStatus(a);
  // Показываем адрес и порт; логин и пароль прокси на экран не выводим.
  const proxyShown = (() => {
    const raw = (a.proxy_url ?? '').trim();
    if (!raw) return null;
    const noScheme = raw.replace(/^[a-z]+:\/\//i, '');
    if (noScheme.includes('@')) return noScheme.split('@').pop() ?? noScheme;
    const [host, port] = noScheme.split(':');
    return port ? `${host}:${port}` : host;
  })();

  return (
    <tr className="li-row-hover border-b border-gray-50 align-middle hover:bg-gray-50/50">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onShowLogs}
            title="Открыть логи этого аккаунта"
            className="min-w-0 cursor-pointer truncate text-left font-medium hover:text-indigo-600 hover:underline"
          >
            {a.name || a.unipile_account_id}
          </button>
          {errorCounts24h && errorCounts24h.error > 0 && (
            <button
              type="button"
              onClick={onShowLogs}
              title={`${errorCounts24h.error} ошибок${errorCounts24h.warning ? ` и ${errorCounts24h.warning} предупреждений` : ''} за 24ч — открыть логи`}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100"
            >
              ⚠ {errorCounts24h.error}
            </button>
          )}
        </div>
        {a.headline && <div className="mt-0.5 truncate text-xs text-gray-500" title={a.headline}>{a.headline}</div>}
      </td>
      <td className="px-3 py-2.5">
        <span className={`rounded-md px-2 py-0.5 text-xs ${st.cls}`} title={st.hint}>{st.text}</span>
        {cooling && (
          <div
            className="mt-1 text-xs text-amber-700"
            title={`Аккаунт в отлёжке до ${new Date(a.cooldown_until!).toLocaleString('ru-RU')}. LinkedIn вернул «${a.cooldown_reason}».`}
          >
            ещё {formatCooldownRemaining(a.cooldown_until!)}{a.cooldown_reason ? ` · ${COOLDOWN_REASON_LABELS[a.cooldown_reason]}` : ''}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5" title={linkedCampaigns.map((c) => `${c.name} — ${CAMPAIGN_STATUS_LABEL_RU[c.status] ?? c.status}`).join('\n')}>
        {linkedCampaigns.length === 0 ? (
          <span className="text-sm text-gray-400">Свободен: ни в одной кампании</span>
        ) : (
          <div className="space-y-1">
            {linkedCampaigns.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-sm text-gray-900">
                <span className={`h-2 w-2 shrink-0 rounded-full ${c.status === 'running' ? 'bg-green-500' : c.status === 'draft' ? 'bg-gray-400' : 'bg-amber-500'}`} />
                <span className="min-w-0 truncate font-medium">{c.name}</span>
                <span className="shrink-0 text-xs text-gray-500">{CAMPAIGN_STATUS_LABEL_RU[c.status] ?? c.status}</span>
              </div>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5">
        {editingProxy ? (
          <div className="space-y-1.5">
            <input
              type="text"
              autoFocus
              placeholder="ip:port:user:pass"
              value={proxyDraft}
              onChange={(e) => { setProxyDraft(e.target.value); setMsg(null); }}
              className="w-full rounded-lg border border-gray-200 px-2 py-1 font-mono text-xs"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="cursor-pointer rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">{saving ? '...' : 'Сохранить'}</button>
              <button type="button" onClick={() => { setEditingProxy(false); setProxyDraft(a.proxy_url ?? ''); setMsg(null); }} className="cursor-pointer px-2 py-1 text-xs text-gray-500 hover:underline">Отмена</button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={`min-w-0 truncate text-sm ${proxyShown ? 'font-mono text-gray-900' : 'text-gray-400'}`} title={proxyShown ? 'Прокси этого аккаунта' : 'Прокси не указан'}>
              {proxyShown ?? '—'}
            </span>
            <button
              type="button"
              onClick={() => setEditingProxy(true)}
              aria-label="Заменить прокси"
              title="Заменить прокси"
              className="li-icon-btn shrink-0 cursor-pointer rounded-lg p-1.5"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {msg && <div className={`mt-1 text-xs ${msg.startsWith('Ошибка') ? 'text-red-600' : 'text-green-600'}`}>{msg}</div>}
      </td>
      <td className="px-3 py-2.5 text-right align-middle text-xs tabular-nums text-gray-500">{a.created_at ? new Date(a.created_at).toLocaleDateString('ru-RU') : '—'}</td>
      <td className="px-3 py-1.5 text-right">
        <button
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
          aria-label="Удалить карточку аккаунта"
          title="Удалить карточку аккаунта из портала (например, устаревший дубль)"
          className="li-icon-btn li-icon-btn-danger cursor-pointer rounded-lg p-1.5 disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
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

/** Переключатель с подписью, как в «TG Аутриче». Ползунок — bg-[#ffffff]: тёмная тема перекрашивает bg-white. */
function LiSwitch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2.5 text-xs text-gray-700 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <span className="relative inline-flex shrink-0">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span className="block h-5 w-9 rounded-full bg-[#6b7280] transition-colors duration-200 peer-checked:bg-[#6366f1] peer-focus-visible:ring-2 peer-focus-visible:ring-[#a5b4fc]" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 block h-4 w-4 rounded-full bg-[#ffffff] shadow-sm transition-transform duration-200 peer-checked:translate-x-4" />
      </span>
      {label}
    </label>
  );
}

/**
 * Прогресс кампании и разбивка по наведению — карточка как в «Рассылке».
 * Рисуется fixed от ячейки: таблица в overflow-x-auto обрезала бы обычную подсказку.
 */
function ProcessedCell({
  cs,
  processed,
  doneRatio,
  pendingActive,
  completed,
  error,
  skipped,
  children,
}: {
  cs: DashboardCampaignStat;
  processed: number;
  doneRatio: number;
  pendingActive: number;
  completed: number;
  error: number;
  skipped: number;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Карточка идёт за курсором: по умолчанию справа-снизу от него; у правого и нижнего края
  // окна прижимается к курсору с другой стороны (так высота карточки не нужна).
  const GAP = 3;
  const follow = (event: React.MouseEvent<HTMLDivElement>) => setPos({ x: event.clientX, y: event.clientY });
  const anchor: React.CSSProperties = pos
    ? {
        position: 'fixed',
        ...(pos.x + GAP + 272 > window.innerWidth ? { right: window.innerWidth - pos.x + GAP } : { left: pos.x + GAP }),
        ...(pos.y + GAP + 300 > window.innerHeight ? { bottom: window.innerHeight - pos.y + GAP } : { top: pos.y + GAP }),
      }
    : {};
  const rows: Array<{ label: string; value: number; tone?: string; gap?: boolean }> = [
    { label: 'Завершено', value: completed, tone: 'text-emerald-600' },
    { label: 'Ошибки', value: error, tone: error ? 'text-red-600' : undefined },
    { label: 'Пропущено', value: skipped },
    { label: 'Осталось', value: pendingActive, gap: true },
    { label: 'В очереди', value: cs.pending },
    { label: 'Сейчас обрабатываются', value: cs.in_progress, tone: cs.in_progress ? 'text-blue-600' : undefined },
    { label: 'Ждут следующего шага', value: cs.waiting },
  ];
  return (
    <div className="cursor-default" onMouseEnter={follow} onMouseMove={follow} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && createPortal(
        <div
          role="tooltip"
          style={anchor}
          className="li-hover-card pointer-events-none z-50 w-64 rounded-xl border p-3 shadow-xl"
        >
          <div className="mb-2 border-b border-zinc-200 pb-2 text-sm font-semibold">
            Обработано {processed} из {cs.leads_total} ({doneRatio}%)
          </div>
          <dl className="space-y-1.5">
            {rows.map((row) => (
              <div key={row.label} className={`flex items-center justify-between text-sm ${row.gap ? 'mt-2 border-t border-zinc-200 pt-2' : ''}`}>
                <dt className="text-zinc-500">{row.label}</dt>
                <dd className={`font-semibold tabular-nums ${row.tone ?? ''}`}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </div>
  );
}
