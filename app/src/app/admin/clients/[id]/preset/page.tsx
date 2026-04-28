'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, Mail, Search } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { useUser } from '@/lib/UserProvider';
import { isAdmin } from '@/lib/roles';
import { logAudit, logError } from '@/lib/loggerClient';
import type { UserProfile } from '@/types';
import {
  AccountStatus,
  AccountStatusLabels,
  type Account,
  type AccountStatusValue,
} from '@/lib/instantly/types';

interface PresetState {
  email_account_ids: string[];
  daily_limit: number;
  daily_max_leads: number;
  email_gap_minutes: number;
  open_tracking: boolean;
  link_tracking: boolean;
  stop_on_reply: boolean;
  text_only: boolean;
  schedule_from: string;
  schedule_to: string;
  schedule_days: number[];
  schedule_timezone: string;
}

const DEFAULT_PRESET: PresetState = {
  email_account_ids: [],
  daily_limit: 50,
  daily_max_leads: 50,
  email_gap_minutes: 10,
  open_tracking: true,
  link_tracking: true,
  stop_on_reply: true,
  text_only: false,
  schedule_from: '09:00',
  schedule_to: '18:00',
  schedule_days: [1, 2, 3, 4, 5],
  schedule_timezone: 'Europe/Moscow',
};

const WEEKDAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
] as const;

const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
  'UTC',
] as const;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Неизвестная ошибка';
}

export default function ClientPresetPage() {
  const params = useParams<{ id: string }>();
  const clientUserId = params?.id ?? '';
  const { userRole } = useUser();
  const admin = isAdmin(userRole);

  const [client, setClient] = useState<UserProfile | null>(null);
  const [preset, setPreset] = useState<PresetState>(DEFAULT_PRESET);
  const [hasExistingPreset, setHasExistingPreset] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [accountSearch, setAccountSearch] = useState('');

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        const msg = typeof parsed?.error === 'string' ? parsed.error : '';
        throw new Error(msg || text || `Request failed: ${res.status}`);
      } catch {
        throw new Error(text || `Request failed: ${res.status}`);
      }
    }
    return (await res.json()) as T;
  }, []);

  const loadAll = useCallback(async () => {
    if (!clientUserId) return;
    setError('');
    try {
      const [{ data: profileData }, presetRes, accountsRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', clientUserId).single(),
        apiFetch<{ preset: (PresetState & { id: string }) | null }>(`/api/admin/clients/${clientUserId}/preset`),
        apiFetch<{ items: Account[] }>('/api/instantly/accounts?limit=all'),
      ]);

      setClient((profileData as UserProfile | null) ?? null);

      if (presetRes.preset) {
        const p = presetRes.preset;
        setPreset({
          email_account_ids: Array.isArray(p.email_account_ids) ? p.email_account_ids : [],
          daily_limit: typeof p.daily_limit === 'number' ? p.daily_limit : DEFAULT_PRESET.daily_limit,
          daily_max_leads: typeof p.daily_max_leads === 'number' ? p.daily_max_leads : DEFAULT_PRESET.daily_max_leads,
          email_gap_minutes: typeof p.email_gap_minutes === 'number' ? p.email_gap_minutes : DEFAULT_PRESET.email_gap_minutes,
          open_tracking: Boolean(p.open_tracking),
          link_tracking: Boolean(p.link_tracking),
          stop_on_reply: Boolean(p.stop_on_reply),
          text_only: Boolean(p.text_only),
          schedule_from: p.schedule_from || DEFAULT_PRESET.schedule_from,
          schedule_to: p.schedule_to || DEFAULT_PRESET.schedule_to,
          schedule_days: Array.isArray(p.schedule_days) ? p.schedule_days : DEFAULT_PRESET.schedule_days,
          schedule_timezone: p.schedule_timezone || DEFAULT_PRESET.schedule_timezone,
        });
        setHasExistingPreset(true);
      }

      setAccounts(accountsRes.items ?? []);
    } catch (err) {
      void logError('admin.client-preset.load.failed', err, { clientUserId });
      setError(getErrorMessage(err) || 'Ошибка загрузки');
    } finally {
      setLoading(false);
      setAccountsLoading(false);
    }
  }, [clientUserId, apiFetch]);

  useEffect(() => {
    if (admin && clientUserId) {
      void loadAll();
    } else if (!admin) {
      setLoading(false);
    }
  }, [admin, clientUserId, loadAll]);

  useEffect(() => {
    if (!savedMessage) return;
    const t = setTimeout(() => setSavedMessage(''), 3000);
    return () => clearTimeout(t);
  }, [savedMessage]);

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    const selected = accounts.filter((a) => preset.email_account_ids.includes(a.email));
    const unselected = accounts.filter((a) => !preset.email_account_ids.includes(a.email));
    const ordered = [...selected, ...unselected];
    if (!q) return ordered;
    return ordered.filter(
      (a) =>
        a.email.toLowerCase().includes(q) ||
        (a.first_name || '').toLowerCase().includes(q) ||
        (a.last_name || '').toLowerCase().includes(q),
    );
  }, [accounts, preset.email_account_ids, accountSearch]);

  function toggleAccount(email: string) {
    setPreset((prev) => ({
      ...prev,
      email_account_ids: prev.email_account_ids.includes(email)
        ? prev.email_account_ids.filter((e) => e !== email)
        : [...prev.email_account_ids, email],
    }));
  }

  function toggleDay(day: number) {
    setPreset((prev) => ({
      ...prev,
      schedule_days: prev.schedule_days.includes(day)
        ? prev.schedule_days.filter((d) => d !== day)
        : [...prev.schedule_days, day].sort((a, b) => a - b),
    }));
  }

  async function handleSave() {
    if (preset.email_account_ids.length === 0) {
      setError('Выберите хотя бы один email-аккаунт');
      return;
    }
    if (preset.schedule_days.length === 0) {
      setError('Выберите хотя бы один день расписания');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await apiFetch<{ preset: unknown }>(`/api/admin/clients/${clientUserId}/preset`, {
        method: 'PUT',
        body: JSON.stringify(preset),
      });
      void logAudit('admin.client-preset.save.success', 'Client preset saved', {
        targetUserId: clientUserId,
        accounts: preset.email_account_ids.length,
      });
      setSavedMessage('Пресет сохранён');
      setHasExistingPreset(true);
    } catch (err) {
      void logError('admin.client-preset.save.failed', err, { clientUserId });
      setError(getErrorMessage(err) || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (!admin) {
    return (
      <div className="max-w-4xl mx-auto py-10">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-red-800">Доступ запрещён</h2>
          <p className="text-red-600">Только администраторы могут управлять пресетами клиентов.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <div className="mb-6">
        <Link href="/admin/users" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад к пользователям
        </Link>
      </div>

      <div className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
          Пресет запуска кампаний
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Клиент: <span className="font-medium text-gray-700">{client?.full_name || client?.email || clientUserId}</span>
        </p>
        {!hasExistingPreset && (
          <p className="mt-2 text-xs text-amber-700 bg-amber-50 inline-block px-2 py-1 rounded">
            Пресет ещё не настроен — клиент не сможет запустить ни одну кампанию
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-auto" aria-label="Закрыть">✕</button>
        </div>
      )}
      {savedMessage && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-800 text-sm">
          <span className="size-5 rounded-full bg-green-500 flex items-center justify-center text-white" aria-hidden>
            <Check className="size-3 stroke-[3]" />
          </span>
          {savedMessage}
        </div>
      )}

      <div className="space-y-6">
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <header className="px-6 py-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-900">
                Email-аккаунты для рассылки
              </h2>
            </div>
            <span className="text-xs text-blue-700 font-medium">
              {preset.email_account_ids.length} выбрано
            </span>
          </header>
          <div className="p-4 space-y-3">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                placeholder="Поиск аккаунта..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
              {accountsLoading ? (
                <div className="px-3 py-4 text-center text-xs text-gray-400">Загрузка аккаунтов...</div>
              ) : filteredAccounts.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-gray-400">Нет аккаунтов</div>
              ) : (
                filteredAccounts.map((a) => {
                  const checked = preset.email_account_ids.includes(a.email);
                  const statusKey = a.status as AccountStatusValue;
                  return (
                    <label
                      key={a.email}
                      className={`flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${checked ? 'bg-blue-50/50' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAccount(a.email)}
                        className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-900 truncate">{a.email}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {(a.first_name || '') + ' ' + (a.last_name || '')}
                          {a.organization ? ` · ${a.organization}` : ''}
                        </p>
                      </div>
                      <span className={`shrink-0 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        statusKey === AccountStatus.Active ? 'bg-green-100 text-green-700' :
                        statusKey === AccountStatus.Paused ? 'bg-yellow-100 text-yellow-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {AccountStatusLabels[statusKey] ?? `Статус ${statusKey}`}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <header className="px-6 py-4 border-b border-gray-200 bg-gray-50">
            <h2 className="text-sm font-semibold text-gray-900">Лимиты и интервалы</h2>
          </header>
          <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <NumberField
              label="Лимит писем в день (на аккаунт)"
              value={preset.daily_limit}
              onChange={(v) => setPreset({ ...preset, daily_limit: v })}
              min={0}
              max={1000}
            />
            <NumberField
              label="Новых лидов в день"
              value={preset.daily_max_leads}
              onChange={(v) => setPreset({ ...preset, daily_max_leads: v })}
              min={0}
              max={1000}
            />
            <NumberField
              label="Интервал между письмами (мин)"
              value={preset.email_gap_minutes}
              onChange={(v) => setPreset({ ...preset, email_gap_minutes: v })}
              min={0}
              max={60}
            />
          </div>
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <header className="px-6 py-4 border-b border-gray-200 bg-gray-50">
            <h2 className="text-sm font-semibold text-gray-900">Расписание отправки</h2>
          </header>
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Начало</label>
                <input
                  type="time"
                  value={preset.schedule_from}
                  onChange={(e) => setPreset({ ...preset, schedule_from: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Конец</label>
                <input
                  type="time"
                  value={preset.schedule_to}
                  onChange={(e) => setPreset({ ...preset, schedule_to: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Часовой пояс</label>
                <select
                  value={preset.schedule_timezone}
                  onChange={(e) => setPreset({ ...preset, schedule_timezone: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">Дни недели</label>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((d) => {
                  const checked = preset.schedule_days.includes(d.value);
                  return (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => toggleDay(d.value)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        checked
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <header className="px-6 py-4 border-b border-gray-200 bg-gray-50">
            <h2 className="text-sm font-semibold text-gray-900">Трекинг и поведение</h2>
          </header>
          <div className="p-6 space-y-3">
            <ToggleRow
              label="Отслеживать открытия писем"
              hint="Open tracking pixel"
              checked={preset.open_tracking}
              onChange={(v) => setPreset({ ...preset, open_tracking: v })}
            />
            <ToggleRow
              label="Отслеживать клики по ссылкам"
              hint="Link tracking"
              checked={preset.link_tracking}
              onChange={(v) => setPreset({ ...preset, link_tracking: v })}
            />
            <ToggleRow
              label="Останавливать цепочку при ответе"
              hint="Stop on reply"
              checked={preset.stop_on_reply}
              onChange={(v) => setPreset({ ...preset, stop_on_reply: v })}
            />
            <ToggleRow
              label="Только текстовые письма"
              hint="Text only (без HTML)"
              checked={preset.text_only}
              onChange={(v) => setPreset({ ...preset, text_only: v })}
            />
          </div>
        </section>

        <div className="sticky bottom-4 bg-white rounded-xl border border-gray-200 shadow-lg p-4 flex items-center justify-end gap-3">
          <span className="text-xs text-gray-500 mr-auto">
            Изменения применятся ко всем будущим запускам клиента
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-10 items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-6 text-sm font-semibold text-white shadow-sm shadow-blue-600/25 transition-all hover:-translate-y-0.5 hover:from-blue-500 hover:to-indigo-500 hover:shadow-md hover:shadow-blue-600/35 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Сохранение...' : hasExistingPreset ? 'Сохранить изменения' : 'Создать пресет'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min ?? 0, Math.min(max ?? Infinity, Math.floor(n))));
        }}
        min={min}
        max={max}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-sm text-gray-900">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          checked ? 'bg-blue-600' : 'bg-gray-200'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}
