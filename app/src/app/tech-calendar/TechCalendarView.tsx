'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabaseClient';
import MonthGrid from '@/components/tech-calendar/MonthGrid';
import StatsRow from '@/components/tech-calendar/StatsRow';
import SubscriptionModal, { type ModalMode, type ModalPayload } from '@/components/tech-calendar/SubscriptionModal';
import TypeBreakdown from '@/components/tech-calendar/TypeBreakdown';
import UpcomingList from '@/components/tech-calendar/UpcomingList';
import { mskDateStr } from '@/lib/techCalendar/dates';
import type { ServiceType, TechProviderBalance, TechSubscription } from '@/lib/techCalendar/types';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token ?? ''}`,
  };
}

export default function TechCalendarView() {
  const today = mskDateStr(new Date());
  const [subscriptions, setSubscriptions] = useState<TechSubscription[]>([]);
  const [balances, setBalances] = useState<TechProviderBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<ServiceType | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const [modalMode, setModalMode] = useState<ModalMode | null>(null);
  const [modalSub, setModalSub] = useState<TechSubscription | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = showHidden ? '/api/tech-calendar/subscriptions?include_hidden=1' : '/api/tech-calendar/subscriptions';
      const res = await fetch(url, { headers: await authHeaders() });
      const json = await res.json();
      setSubscriptions(res.ok ? (json.subscriptions ?? []) : []);
      setBalances(res.ok ? (json.balances ?? []) : []);
      if (!res.ok) setError(json.error ?? 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visible = useMemo(
    () => (typeFilter ? subscriptions.filter((s) => s.service_type === typeFilter) : subscriptions),
    [subscriptions, typeFilter],
  );

  const submit = async (payload: ModalPayload) => {
    setSaving(true);
    setError(null);
    try {
      const headers = await authHeaders();
      let res: Response;
      if (modalMode === 'create') {
        res = await fetch('/api/tech-calendar/subscriptions', { method: 'POST', headers, body: JSON.stringify(payload) });
      } else if (modalMode === 'edit' && modalSub) {
        res = await fetch(`/api/tech-calendar/subscriptions/${modalSub.id}`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
      } else if (modalMode === 'renew' && modalSub) {
        res = await fetch(`/api/tech-calendar/subscriptions/${modalSub.id}/renew`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ next_billing_date: payload.next_billing_date, amount: payload.amount }),
        });
      } else {
        return;
      }

      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Не удалось сохранить');
        return;
      }
      setModalMode(null);
      setModalSub(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const decide = async (sub: TechSubscription, decision: 'keep' | 'cancel') => {
    const res = await fetch(`/api/tech-calendar/subscriptions/${sub.id}/decision`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ decision }),
    });
    if (res.ok) await load();
  };

  const toggleHidden = async (sub: TechSubscription) => {
    const res = await fetch(`/api/tech-calendar/subscriptions/${sub.id}`, {
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify({ is_hidden: !sub.is_hidden }),
    });
    if (res.ok) {
      setModalMode(null);
      setModalSub(null);
      await load();
    }
  };

  const syncSpaceProxy = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/tech-calendar/sync', {
        method: 'POST',
        headers: await authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Не удалось синхронизировать техничку');
        return;
      }
      if (json.sync?.serper && !json.sync.serper.ok) {
        setError(`Serper: ${json.sync.serper.error ?? 'не удалось обновить кредиты'}`);
      }
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (sub: TechSubscription) => {
    if (!window.confirm(`Удалить «${sub.service_name}» из календаря?`)) return;
    const res = await fetch(`/api/tech-calendar/subscriptions/${sub.id}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
    if (res.ok) await load();
  };

  const shiftMonth = (delta: number) => {
    const next = month + delta;
    setYear(year + Math.floor(next / 12));
    setMonth(((next % 12) + 12) % 12);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Календарь технички</h1>
          <p className="text-sm text-gray-500">Прокси, серверы, API и софт: что и когда платим</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={syncing}
            onClick={syncSpaceProxy}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {syncing ? 'Синхронизация...' : 'Синк сейчас'}
          </button>
          <button
            type="button"
            onClick={() => {
              setModalSub(null);
              setModalMode('create');
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Добавить сервис
          </button>
        </div>
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-blue-600"
        />
        Показать скрытые
      </label>

      <ProviderBalances balances={balances} />

      <StatsRow subscriptions={visible} year={year} month={month} today={today} />
      <TypeBreakdown subscriptions={subscriptions} year={year} month={month} selected={typeFilter} onSelect={setTypeFilter} />

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => shiftMonth(-1)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
          ←
        </button>
        <div className="text-sm font-medium text-gray-900">
          {MONTH_NAMES[month]} {year}
        </div>
        <button type="button" onClick={() => shiftMonth(1)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
          →
        </button>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-100 bg-white p-8 text-center text-sm text-gray-500">Загрузка…</div>
      ) : (
        <MonthGrid
          subscriptions={visible}
          year={year}
          month={month}
          today={today}
          onSelect={(sub) => {
            setModalSub(sub);
            setModalMode('edit');
          }}
        />
      )}

      <UpcomingList
        subscriptions={visible}
        today={today}
        onRenew={(sub) => {
          setModalSub(sub);
          setModalMode('renew');
        }}
        onDecide={decide}
      />

      {error && !modalMode && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

      {modalMode && (
        <SubscriptionModal
          mode={modalMode}
          subscription={modalSub}
          saving={saving}
          error={error}
          onClose={() => {
            setModalMode(null);
            setModalSub(null);
            setError(null);
          }}
          onSubmit={submit}
          onDelete={
            modalMode === 'edit' && modalSub
              ? async () => {
                  await remove(modalSub);
                  setModalMode(null);
                  setModalSub(null);
                }
              : undefined
          }
          onToggleHidden={modalMode === 'edit' && modalSub ? () => toggleHidden(modalSub) : undefined}
        />
      )}
    </div>
  );
}

function formatCredits(value: number | null): string {
  if (value === null) return 'нет данных';
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function formatSyncTime(value: string | null): string {
  if (!value) return 'ещё не синхронизировали';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ProviderBalances({ balances }: { balances: TechProviderBalance[] }) {
  const serper = balances.find((b) => b.provider === 'serper');
  if (!serper) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border border-gray-100 bg-white p-4">
        <div className="text-xs text-gray-500">Serper credits</div>
        <div className="mt-1 text-2xl font-semibold text-gray-900">{formatCredits(serper.balance)}</div>
        <div className={`mt-1 text-xs ${serper.last_error ? 'text-red-600' : 'text-gray-500'}`}>
          {serper.last_error ? `Ошибка синка: ${serper.last_error}` : `Синк: ${formatSyncTime(serper.synced_at)}`}
        </div>
      </div>
    </div>
  );
}
