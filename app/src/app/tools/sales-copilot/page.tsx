'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Bot,
  Loader2,
  Settings,
  ScrollText,
  Send,
  X,
  RefreshCw,
  Play,
  Square,
  Trash2,
  MessageSquare,
  Clock,
  Check,
  Pencil,
  Inbox,
  Snowflake,
  ChevronDown,
  ChevronUp,
  UserCircle,
  Phone,
  ShieldCheck,
  KeyRound,
  Database,
} from 'lucide-react';
import type {
  SalesCopilotConfig,
  SalesCopilotDraft,
  SalesCopilotLog,
  DraftStats,
} from '@/lib/salesCopilot/types';

const API = '/api/sales-copilot';

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}ч назад`;
  const days = Math.floor(hours / 24);
  return `${days}д назад`;
}

type Tab = 'drafts' | 'settings' | 'logs';
type DraftSubTab = 'reactive' | 'proactive';

export default function SalesCopilotPage() {
  const [tab, setTab] = useState<Tab>('drafts');
  const [configs, setConfigs] = useState<SalesCopilotConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadConfigs = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API}/configs`, { headers: authHeaders(token) });
      const data = await res.json();
      setConfigs(data.items ?? []);
      if (!selectedConfigId && data.items?.length) {
        setSelectedConfigId(data.items[0].id);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [selectedConfigId]);

  useEffect(() => { void loadConfigs(); }, [loadConfigs]);

  const selectedConfig = configs.find(c => c.id === selectedConfigId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'drafts', label: 'Черновики', icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'settings', label: 'Настройки', icon: <Settings className="w-4 h-4" /> },
    { id: 'logs', label: 'Логи', icon: <ScrollText className="w-4 h-4" /> },
  ];

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bot className="w-7 h-7 text-indigo-600" />
          <h1 className="text-2xl font-bold">Sales Copilot</h1>
        </div>

        {selectedConfig && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-sm text-gray-600">
              <UserCircle className="w-4 h-4" />
              {selectedConfig.tg_first_name || selectedConfig.phone || selectedConfig.id.slice(0, 8)}
              {selectedConfig.tg_username && <span className="text-gray-400">@{selectedConfig.tg_username}</span>}
            </div>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              selectedConfig?.is_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
            }`}>
              {selectedConfig?.is_enabled ? 'Активен' : 'Выключен'}
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {configs.length === 0 ? (
        <EmptyState onCreated={loadConfigs} />
      ) : tab === 'drafts' && selectedConfig ? (
        <DraftsTab config={selectedConfig} />
      ) : tab === 'settings' && selectedConfig ? (
        <SettingsTab config={selectedConfig} onUpdated={loadConfigs} onDeleted={() => { setSelectedConfigId(null); void loadConfigs(); }} />
      ) : tab === 'logs' && selectedConfig ? (
        <LogsTab config={selectedConfig} />
      ) : null}
    </div>
  );
}

/* ---------- Empty state — phone auth flow ---------- */

type AuthStep = 'phone' | 'code' | 'password';

function EmptyState({ onCreated }: { onCreated: () => void }) {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSendCode = async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch(`${API}/auth/send-code`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Ошибка отправки кода');
        return;
      }
      setStep('code');
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (pwd?: string) => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const body: Record<string, string> = { phone, code };
      if (pwd) body.password = pwd;
      const res = await fetch(`${API}/auth/verify-code`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.needs_password) {
          setStep('password');
          setError('');
          return;
        }
        setError(data.error ?? 'Ошибка верификации');
        return;
      }
      onCreated();
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center space-y-2">
          <Bot className="w-12 h-12 text-indigo-300 mx-auto" />
          <h2 className="text-lg font-semibold">Подключите Telegram</h2>
          <p className="text-sm text-gray-500">Введите номер вашего рабочего аккаунта для начала работы с Copilot</p>
        </div>

        {step === 'phone' && (
          <div className="space-y-3">
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                className="w-full border rounded-lg pl-10 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none"
                placeholder="+7 900 123 45 67"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendCode()}
              />
            </div>
            <button
              onClick={handleSendCode}
              disabled={loading || phone.length < 10}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Отправить код
            </button>
          </div>
        )}

        {step === 'code' && (
          <div className="space-y-3">
            <div className="bg-emerald-50 text-emerald-700 rounded-lg p-3 text-sm text-center">
              <ShieldCheck className="w-4 h-4 inline mr-1.5" />
              Код отправлен в Telegram на {phone}
            </div>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                className="w-full border rounded-lg pl-10 pr-3 py-2.5 text-sm text-center tracking-[0.3em] font-mono focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none"
                placeholder="12345"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={e => e.key === 'Enter' && handleVerifyCode()}
                autoFocus
              />
            </div>
            <button
              onClick={() => handleVerifyCode()}
              disabled={loading || code.length < 4}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Подключить
            </button>
            <button
              onClick={() => { setStep('phone'); setCode(''); setError(''); }}
              className="w-full text-center text-xs text-gray-400 hover:text-gray-600"
            >
              Ввести другой номер
            </button>
          </div>
        )}

        {step === 'password' && (
          <div className="space-y-3">
            <div className="bg-amber-50 text-amber-700 rounded-lg p-3 text-sm text-center">
              <KeyRound className="w-4 h-4 inline mr-1.5" />
              Аккаунт защищён двухфакторной аутентификацией
            </div>
            <input
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none"
              type="password"
              placeholder="Облачный пароль"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleVerifyCode(password)}
              autoFocus
            />
            <button
              onClick={() => handleVerifyCode(password)}
              disabled={loading || !password}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Подтвердить
            </button>
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-600 rounded-lg p-3 text-sm text-center">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Drafts tab ---------- */

function DraftsTab({ config }: { config: SalesCopilotConfig }) {
  const [subTab, setSubTab] = useState<DraftSubTab>('reactive');
  const [drafts, setDrafts] = useState<SalesCopilotDraft[]>([]);
  const [stats, setStats] = useState<DraftStats | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getToken();
      const [draftsRes, statsRes] = await Promise.all([
        fetch(`${API}/configs/${config.id}/drafts?type=${subTab}&status=pending`, { headers: authHeaders(token) }),
        fetch(`${API}/configs/${config.id}/drafts/stats`, { headers: authHeaders(token) }),
      ]);
      const draftsData = await draftsRes.json();
      const statsData = await statsRes.json();
      setDrafts(draftsData.items ?? []);
      setStats(statsData);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [config.id, subTab]);

  useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  const handleSend = async (draftId: string, editedText?: string) => {
    const token = await getToken();
    await fetch(`${API}/configs/${config.id}/drafts/${draftId}/send`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(editedText ? { edited_text: editedText } : {}),
    });
    void loadDrafts();
  };

  const handleDismiss = async (draftId: string) => {
    const token = await getToken();
    await fetch(`${API}/configs/${config.id}/drafts/${draftId}/dismiss`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    void loadDrafts();
  };

  const handleRegenerate = async (draftId: string): Promise<string | null> => {
    const token = await getToken();
    const res = await fetch(`${API}/configs/${config.id}/drafts/${draftId}/regenerate`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const data = await res.json();
    if (data.ok) return data.draft_text as string;
    return null;
  };

  return (
    <div className="space-y-4">
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Входящие" value={stats.pending_reactive} icon={<Inbox className="w-4 h-4" />} color="indigo" />
          <StatCard label="Холодные" value={stats.pending_proactive} icon={<Snowflake className="w-4 h-4" />} color="blue" />
          <StatCard label="Отправлено сегодня" value={stats.sent_today} icon={<Check className="w-4 h-4" />} color="emerald" />
          <StatCard label="Пропущено сегодня" value={stats.dismissed_today} icon={<X className="w-4 h-4" />} color="gray" />
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setSubTab('reactive')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            subTab === 'reactive'
              ? 'bg-indigo-100 text-indigo-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <Inbox className="w-3.5 h-3.5" /> Входящие
          {stats && stats.pending_reactive > 0 && (
            <span className="bg-indigo-600 text-white text-xs px-1.5 py-0.5 rounded-full ml-1">{stats.pending_reactive}</span>
          )}
        </button>
        <button
          onClick={() => setSubTab('proactive')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            subTab === 'proactive'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <Snowflake className="w-3.5 h-3.5" /> Холодные диалоги
          {stats && stats.pending_proactive > 0 && (
            <span className="bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full ml-1">{stats.pending_proactive}</span>
          )}
        </button>
        <button onClick={loadDrafts} className="ml-auto p-1.5 text-gray-400 hover:text-gray-600" title="Обновить">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
        </div>
      ) : drafts.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{subTab === 'reactive' ? 'Нет новых входящих черновиков' : 'Нет холодных диалогов для реанимации'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map(draft => (
            <DraftCard
              key={draft.id}
              draft={draft}
              onSend={handleSend}
              onDismiss={handleDismiss}
              onRegenerate={handleRegenerate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  const colors: Record<string, string> = {
    indigo: 'bg-indigo-50 text-indigo-700',
    blue: 'bg-blue-50 text-blue-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    gray: 'bg-gray-50 text-gray-600',
  };

  return (
    <div className={`rounded-xl p-3 ${colors[color] ?? colors.gray}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-70 mb-1">
        {icon} {label}
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function DraftCard({
  draft,
  onSend,
  onDismiss,
  onRegenerate,
}: {
  draft: SalesCopilotDraft;
  onSend: (id: string, editedText?: string) => void;
  onDismiss: (id: string) => void;
  onRegenerate: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.draft_text);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const displayName = draft.tg_display_name ?? draft.tg_username ?? `ID:${draft.tg_user_id}`;

  const handleSend = async () => {
    setSending(true);
    const editedText = text !== draft.draft_text ? text : undefined;
    await onSend(draft.id, editedText);
    setSending(false);
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    const newText = await onRegenerate(draft.id);
    if (newText) {
      setText(newText);
    }
    setRegenerating(false);
  };

  return (
    <div className="border rounded-xl p-4 space-y-3 hover:border-indigo-200 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <UserCircle className="w-8 h-8 text-gray-300" />
          <div>
            <div className="font-medium text-sm">{displayName}</div>
            <div className="text-xs text-gray-400">{timeAgo(draft.created_at)}</div>
          </div>
        </div>
        {draft.draft_type === 'proactive' && draft.silence_days && (
          <span className="flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
            <Clock className="w-3 h-3" /> {draft.silence_days}д молчания
          </span>
        )}
      </div>

      {draft.last_incoming_text && (
        <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
          <span className="text-xs text-gray-400 block mb-1">Последнее от клиента:</span>
          {draft.last_incoming_text}
        </div>
      )}

      {editing ? (
        <textarea
          className="w-full border rounded-lg p-3 text-sm resize-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none"
          rows={3}
          value={text}
          onChange={e => setText(e.target.value)}
        />
      ) : (
        <div className="bg-indigo-50 rounded-lg p-3 text-sm text-indigo-900">
          <span className="text-xs text-indigo-400 block mb-1">Черновик:</span>
          {draft.draft_text}
        </div>
      )}

      {expanded && draft.chat_history.length > 0 && (
        <div className="bg-gray-50 rounded-lg p-3 space-y-2 max-h-60 overflow-y-auto">
          <span className="text-xs text-gray-400 block mb-1">История диалога:</span>
          {draft.chat_history.map((msg, i) => (
            <div key={i} className={`text-xs p-2 rounded ${
              msg.role === 'assistant' ? 'bg-indigo-100 text-indigo-800 ml-4' : 'bg-white text-gray-700 mr-4'
            }`}>
              <span className="font-medium">{msg.role === 'assistant' ? 'Менеджер' : 'Клиент'}:</span> {msg.content}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSend}
          disabled={sending}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
        >
          {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Отправить
        </button>
        <button
          onClick={() => { setEditing(!editing); if (!editing) setText(draft.draft_text); }}
          className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
        >
          <Pencil className="w-3.5 h-3.5" /> {editing ? 'Отмена' : 'Править'}
        </button>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Перегенерировать
        </button>
        <button
          onClick={() => onDismiss(draft.id)}
          className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-sm text-gray-400 hover:text-red-500 hover:border-red-200"
        >
          <X className="w-3.5 h-3.5" /> Пропустить
        </button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto flex items-center gap-1 px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {expanded ? 'Скрыть историю' : 'Показать историю'}
        </button>
      </div>
    </div>
  );
}

/* ---------- Settings tab ---------- */

function SettingsTab({
  config,
  onUpdated,
  onDeleted,
}: {
  config: SalesCopilotConfig;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState({ ...config });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState('');

  const update = (patch: Partial<typeof form>) => setForm(prev => ({ ...prev, ...patch }));

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const token = await getToken();
      const { id, user_id, account_id, created_at, updated_at, session_data, phone, tg_first_name, tg_username, initial_sync_completed, initial_sync_offset, last_full_sync_at, ...body } = form;
      void id; void user_id; void account_id; void created_at; void updated_at; void session_data; void phone; void tg_first_name; void tg_username;
      void initial_sync_completed; void initial_sync_offset; void last_full_sync_at;
      await fetch(`${API}/configs/${config.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      setMsg('Сохранено');
      onUpdated();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    setToggling(true);
    try {
      const token = await getToken();
      const endpoint = config.is_enabled ? 'stop' : 'start';
      await fetch(`${API}/configs/${config.id}/${endpoint}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      onUpdated();
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Удалить этот copilot и все его черновики?')) return;
    setDeleting(true);
    try {
      const token = await getToken();
      await fetch(`${API}/configs/${config.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  const accountLabel = config.tg_first_name
    ? `${config.tg_first_name}${config.tg_username ? ` (@${config.tg_username})` : ''}`
    : config.phone || config.id.slice(0, 8);

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between border rounded-xl p-4">
        <div className="flex items-center gap-3">
          <UserCircle className="w-10 h-10 text-indigo-300" />
          <div>
            <div className="font-medium">{accountLabel}</div>
            <div className="text-sm text-gray-400">
              {config.phone && <span>{config.phone} &middot; </span>}
              Подключённый аккаунт
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium ${
              config.is_enabled
                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
            }`}
          >
            {toggling ? <Loader2 className="w-4 h-4 animate-spin" /> : config.is_enabled ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {config.is_enabled ? 'Остановить' : 'Запустить'}
          </button>
        </div>
      </div>

      <SyncStatus config={config} />

      <Section title="Общие">
        <Field label="Модель LLM">
          <input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.llm_model} onChange={e => update({ llm_model: e.target.value })} />
        </Field>
        <Field label="Интервал сканирования (сек)">
          <input className="w-full border rounded-lg px-3 py-2 text-sm" type="number" value={form.scan_interval_seconds} onChange={e => update({ scan_interval_seconds: +e.target.value })} />
        </Field>
        <Field label="Часовой пояс (UTC+)">
          <input className="w-full border rounded-lg px-3 py-2 text-sm" type="number" value={form.timezone_offset} onChange={e => update({ timezone_offset: +e.target.value })} />
        </Field>
        <Field label="Период сна (не сканировать)">
          <input
            className="w-full border rounded-lg px-3 py-2 text-sm"
            placeholder="00:00-08:00, 14:00-15:00"
            value={(form.sleep_periods ?? []).join(', ')}
            onChange={e => {
              const raw = e.target.value;
              const periods = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
              update({ sleep_periods: periods });
            }}
          />
          <p className="text-xs text-gray-400 mt-1">Через запятую, например: 00:00-08:00. Оставьте пустым для работы 24/7.</p>
        </Field>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.ignore_bots} onChange={e => update({ ignore_bots: e.target.checked })} /> Игнорировать ботов
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.ignore_no_username} onChange={e => update({ ignore_no_username: e.target.checked })} /> Игнорировать без username
          </label>
        </div>
        <Field label="Игнорировать юзернеймы (коллеги, не клиенты)">
          <input
            className="w-full border rounded-lg px-3 py-2 text-sm"
            placeholder="username1, username2, username3"
            value={(form.excluded_usernames ?? []).join(', ')}
            onChange={e => {
              const raw = e.target.value;
              const usernames = raw ? raw.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean) : [];
              update({ excluded_usernames: usernames });
            }}
          />
          <p className="text-xs text-gray-400 mt-1">Через запятую, без @. Эти диалоги не будут синхронизироваться и обрабатываться.</p>
        </Field>
      </Section>

      <Section title="Реактивный сценарий — ответ на входящие">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.reactive_enabled} onChange={e => update({ reactive_enabled: e.target.checked })} /> Включён
        </label>
        <Field label="System prompt">
          <textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={6} value={form.reactive_system_prompt} onChange={e => update({ reactive_system_prompt: e.target.value })} />
        </Field>
        <Field label="Лимит истории (сообщений)">
          <input className="w-full border rounded-lg px-3 py-2 text-sm" type="number" value={form.reactive_history_limit} onChange={e => update({ reactive_history_limit: +e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.reactive_set_tg_draft} onChange={e => update({ reactive_set_tg_draft: e.target.checked })} /> Ставить draft в Telegram
        </label>
      </Section>

      <Section title="Проактивный сценарий — реанимация холодных">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.proactive_enabled} onChange={e => update({ proactive_enabled: e.target.checked })} /> Включён
        </label>
        <Field label="System prompt">
          <textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={6} value={form.proactive_system_prompt} onChange={e => update({ proactive_system_prompt: e.target.value })} />
        </Field>
        <Field label="Порог молчания (дней)">
          <input className="w-full border rounded-lg px-3 py-2 text-sm" type="number" value={form.proactive_silence_days} onChange={e => update({ proactive_silence_days: +e.target.value })} />
        </Field>
        <Field label="Макс. черновиков за скан">
          <input className="w-full border rounded-lg px-3 py-2 text-sm" type="number" value={form.proactive_max_drafts_per_scan} onChange={e => update({ proactive_max_drafts_per_scan: +e.target.value })} />
        </Field>
      </Section>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Сохранить
        </button>
        {msg && <span className="text-sm text-emerald-600">{msg}</span>}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="ml-auto flex items-center gap-1 px-3 py-2 text-sm text-red-400 hover:text-red-600"
        >
          <Trash2 className="w-4 h-4" /> Удалить
        </button>
      </div>
    </div>
  );
}

function SyncStatus({ config }: { config: SalesCopilotConfig }) {
  const [dialogCount, setDialogCount] = useState<number | null>(null);
  const [msgCount, setMsgCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { count: dc } = await supabase
          .from('copilot_dialogs')
          .select('id', { count: 'exact', head: true })
          .eq('config_id', config.id);
        const { count: mc } = await supabase
          .from('copilot_messages')
          .select('id', { count: 'exact', head: true })
          .in('dialog_id', (
            await supabase
              .from('copilot_dialogs')
              .select('id')
              .eq('config_id', config.id)
          ).data?.map(d => d.id) ?? []);
        if (!cancelled) {
          setDialogCount(dc ?? 0);
          setMsgCount(mc ?? 0);
        }
      } catch { /* ignore */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [config.id]);

  const syncDone = config.initial_sync_completed;
  const lastSync = config.last_full_sync_at;

  return (
    <div className={`border rounded-xl p-4 ${syncDone ? 'border-emerald-200 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Database className="w-4 h-4" />
        <h3 className="text-sm font-semibold text-gray-700">Синхронизация диалогов</h3>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загрузка...
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Статус:</span>{' '}
            {syncDone ? (
              <span className="text-emerald-700 font-medium">Синхронизирован</span>
            ) : (
              <span className="text-amber-700 font-medium">
                Синхронизация... ({config.initial_sync_offset} обработано)
              </span>
            )}
          </div>
          <div>
            <span className="text-gray-500">Диалогов:</span>{' '}
            <span className="font-medium">{dialogCount ?? 0}</span>
          </div>
          <div>
            <span className="text-gray-500">Сообщений:</span>{' '}
            <span className="font-medium">{msgCount?.toLocaleString('ru-RU') ?? 0}</span>
          </div>
          <div>
            <span className="text-gray-500">Посл. синхронизация:</span>{' '}
            <span className="font-medium">
              {lastSync ? timeAgo(lastSync) : 'нет'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-500">{label}</label>
      {children}
    </div>
  );
}

/* ---------- Logs tab ---------- */

function LogsTab({ config }: { config: SalesCopilotConfig }) {
  const [logs, setLogs] = useState<SalesCopilotLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState('');

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getToken();
      const params = new URLSearchParams({ limit: '100' });
      if (levelFilter) params.set('level', levelFilter);
      const res = await fetch(`${API}/configs/${config.id}/logs?${params}`, { headers: authHeaders(token) });
      const data = await res.json();
      setLogs(data.items ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [config.id, levelFilter]);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

  const levelStyles: Record<string, string> = {
    info: 'text-gray-600',
    warning: 'text-amber-600',
    error: 'text-red-600',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          className="border rounded-lg px-3 py-1.5 text-sm"
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
        >
          <option value="">Все уровни</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
        <button onClick={loadLogs} className="p-1.5 text-gray-400 hover:text-gray-600">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <ScrollText className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>Логи пока пусты</p>
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Время</th>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Уровень</th>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Сообщение</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-t">
                  <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{formatDate(log.created_at)}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${levelStyles[log.level] ?? ''}`}>{log.level}</td>
                  <td className="px-3 py-2 text-xs">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
