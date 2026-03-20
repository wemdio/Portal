'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// ---- Types ------------------------------------------------------------------

type Tab = 'dashboard' | 'campaigns' | 'leads' | 'scraper' | 'accounts' | 'settings';

type LiAccount = { id: string; unipile_account_id: string; name: string | null; is_active: boolean; profile_url: string | null; headline: string | null; last_synced_at: string | null; created_at: string };
type LiLeadList = { id: string; name: string; description: string | null; created_at: string };
type LiLead = { id: string; name: string; first_name: string | null; last_name: string | null; position: string | null; company: string | null; profile_url: string | null; status: string; lead_list_id: string | null; created_at: string };
type LiCampaign = { id: string; name: string; account_id: string | null; lead_list_id: string | null; steps: unknown[]; status: string; use_ai: boolean; daily_invite_limit: number; created_at: string; updated_at: string };
type LiTask = { id: string; type: string; status: string; progress: number; total: number; error_message: string | null; created_at: string };
type LiCampaignLog = { id: number; level: string; message: string; lead_name: string | null; step_index: number | null; created_at: string };
type LiSettings = { unipile_dsn: string; unipile_api_key: string; openai_api_key: string; openai_model: string; webhook_secret: string; proxy_url: string };

// ---- Helpers ----------------------------------------------------------------

async function getToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function api<T = unknown>(path: string, opts?: RequestInit & { json?: unknown }): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: BodyInit | undefined;
  if (opts?.json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`/api/tools/li-outreach${path}`, { ...opts, headers: { ...headers, ...opts?.headers }, body: body ?? opts?.body });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---- Main page --------------------------------------------------------------

export default function LiOutreachPage() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [accounts, setAccounts] = useState<LiAccount[]>([]);
  const [leadLists, setLeadLists] = useState<LiLeadList[]>([]);
  const [leads, setLeads] = useState<LiLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [campaigns, setCampaigns] = useState<LiCampaign[]>([]);
  const [tasks, setTasks] = useState<LiTask[]>([]);
  const [settings, setSettings] = useState<LiSettings | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [campaignLogs, setCampaignLogs] = useState<LiCampaignLog[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<LiSettings>({ unipile_dsn: '', unipile_api_key: '', openai_api_key: '', openai_model: 'gpt-4o-mini', webhook_secret: '', proxy_url: '' });

  // Scraper form
  const [scraperUrl, setScraperUrl] = useState('');
  const [scraperAccountId, setScraperAccountId] = useState('');
  const [scraperListId, setScraperListId] = useState('');
  const [scraperMax, setScraperMax] = useState(100);
  const [scraperType, setScraperType] = useState<'search' | 'reactions'>('search');

  // ---- Data fetching --------------------------------------------------------

  const loadAccounts = useCallback(async () => {
    try { const d = await api<{ accounts: LiAccount[] }>('/accounts'); setAccounts(d.accounts); } catch { /* */ }
  }, []);
  const loadLeadLists = useCallback(async () => {
    try { const d = await api<{ lead_lists: LiLeadList[] }>('/lead-lists'); setLeadLists(d.lead_lists); } catch { /* */ }
  }, []);
  const loadLeads = useCallback(async () => {
    try { const d = await api<{ leads: LiLead[]; total: number }>('/leads?limit=200'); setLeads(d.leads); setLeadsTotal(d.total); } catch { /* */ }
  }, []);
  const loadCampaigns = useCallback(async () => {
    try { const d = await api<{ campaigns: LiCampaign[] }>('/campaigns'); setCampaigns(d.campaigns); } catch { /* */ }
  }, []);
  const loadTasks = useCallback(async () => {
    try { const d = await api<{ tasks: LiTask[] }>('/scraper/tasks'); setTasks(d.tasks); } catch { /* */ }
  }, []);
  const loadSettings = useCallback(async () => {
    try {
      const d = await api<{ settings: LiSettings | null }>('/settings');
      setSettings(d.settings);
      if (d.settings) setSettingsForm(d.settings);
    } catch { /* */ }
  }, []);
  const loadCampaignLogs = useCallback(async (id: string) => {
    try { const d = await api<{ logs: LiCampaignLog[] }>(`/campaigns/${id}/logs`); setCampaignLogs(d.logs); } catch { /* */ }
  }, []);

  useEffect(() => {
    void loadAccounts();
    void loadCampaigns();
    void loadLeadLists();
    void loadSettings();
  }, []);

  useEffect(() => {
    if (tab === 'leads') void loadLeads();
    if (tab === 'scraper') void loadTasks();
  }, [tab]);

  useEffect(() => {
    if (selectedCampaignId) void loadCampaignLogs(selectedCampaignId);
  }, [selectedCampaignId]);

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

  // ---- Tab bar --------------------------------------------------------------

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Дашборд' },
    { key: 'campaigns', label: 'Кампании' },
    { key: 'leads', label: 'Лиды' },
    { key: 'scraper', label: 'Скрапер' },
    { key: 'accounts', label: 'Аккаунты' },
    { key: 'settings', label: 'Настройки' },
  ];

  const selectedCampaign = useMemo(() => campaigns.find((c) => c.id === selectedCampaignId) ?? null, [campaigns, selectedCampaignId]);

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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Аккаунты" value={accounts.filter((a) => a.is_active).length} total={accounts.length} />
          <StatCard label="Кампании" value={campaigns.filter((c) => c.status === 'running').length} total={campaigns.length} />
          <StatCard label="Лиды" value={leadsTotal} />
          <StatCard label="Списки" value={leadLists.length} />
        </div>
      )}

      {/* Campaigns */}
      {tab === 'campaigns' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Кампании</h2>
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
                <h3 className="font-semibold text-gray-900">{selectedCampaign.name} — Логи</h3>
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
      )}

      {/* Leads */}
      {tab === 'leads' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Лиды ({leadsTotal})</h2>
          </div>
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
            <div key={a.id} className="rounded-xl border border-gray-200 px-3 py-2 text-sm flex items-center justify-between">
              <div>
                <span className="font-medium">{a.name || a.unipile_account_id}</span>
                {a.headline && <span className="text-xs text-gray-500 ml-2">{a.headline}</span>}
              </div>
              <span className={`text-xs px-2 py-0.5 rounded ${a.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{a.is_active ? 'Активен' : 'Неактивен'}</span>
            </div>
          ))}
        </div>
      )}

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
    </div>
  );
}

function StatCard({ label, value, total }: { label: string; value: number; total?: number }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">
        {value}{total !== undefined && total !== value ? <span className="text-sm font-normal text-gray-400">/{total}</span> : null}
      </div>
    </div>
  );
}
