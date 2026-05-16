'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Zap, Users, Database, Sparkles } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

type LimitKey = 'max_contacts' | 'max_rows' | 'max_chains_per_month' | 'max_domains' | 'max_emails';

type LimitUsage = {
  limit: number;
  used: number;
  remaining: number;
};

type TariffResponse = {
  tariff_type: 'standard' | 'pro' | 'custom';
  status: 'setup' | 'active' | 'expired' | 'inactive';
  paid_at: string | null;
  paid_until: string | null;
  setup_until: string | null;
  period_start: string;
  usage: Record<LimitKey, LimitUsage>;
};

const LIMITS: Array<{ key: LimitKey; label: string; hint: string; unit: string; icon: React.ElementType; color: string }> = [
  { key: 'max_contacts', label: 'Контакты Instantly', hint: 'Лиды, загруженные в кампании', unit: 'контактов', icon: Users, color: '#3B82F6' },
  { key: 'max_rows', label: 'Запросы на сбор и базы', hint: 'HH, Яндекс.Карты, поисковая выдача, конструктор баз', unit: 'запросов', icon: Database, color: '#8B5CF6' },
  { key: 'max_chains_per_month', label: 'Цепочки писем', hint: 'AI-генерации цепочек за период', unit: 'цепочек', icon: Sparkles, color: '#F59E0B' },
];

const TARIFF_LABELS: Record<TariffResponse['tariff_type'], string> = {
  standard: 'Standard',
  pro: 'Pro',
  custom: 'Индивидуальный',
};

const STATUS_LABELS: Record<TariffResponse['status'], string> = {
  setup: 'Настройка',
  active: 'Активен',
  expired: 'Истёк',
  inactive: 'Не активен',
};

function formatNum(value: number) {
  return value.toLocaleString('ru-RU');
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function ClientTariffPage() {
  const [data, setData] = useState<TariffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError('');
    try {
      const res = await clientApiFetch<TariffResponse>('/tariff');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить тариф');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await clientApiFetch<TariffResponse>('/tariff');
        if (cancelled) return;
        setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить тариф');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = useMemo(() => {
    if (!data) return { used: 0, limit: 0 };
    return LIMITS.reduce(
      (acc, item) => {
        const usage = data.usage[item.key];
        return { used: acc.used + usage.used, limit: acc.limit + usage.limit };
      },
      { used: 0, limit: 0 },
    );
  }, [data]);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-center py-32">
          <div className="neu-spinner animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 sm:space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold flex items-center gap-2.5" style={{ color: 'var(--cp-text)' }}>
            <span
              className="inline-flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: 'rgba(245,158,11,0.12)', color: '#F59E0B' }}
            >
              <Zap className="h-5 w-5" />
            </span>
            Тариф
          </h1>
          <p className="mt-2 text-sm sm:text-base" style={{ color: 'var(--cp-text-m)' }}>
            Текущий тариф и остатки по лимитам на расчётный период.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="neu-pill inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold"
          style={{ color: 'var(--cp-text-m)' }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </header>

      {error ? (
        <div className="neu-inset rounded-2xl px-5 py-4 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </div>
      ) : null}

      {data ? (
        <>
          <section className="neu-card p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
                  Текущий тариф
                </p>
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <h2 className="text-2xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
                    {TARIFF_LABELS[data.tariff_type]}
                  </h2>
                  <span
                    className="neu-well rounded-full px-3 py-1 text-xs font-bold"
                    style={{
                      color: data.status === 'active' ? '#10B981' : data.status === 'expired' ? '#EF4444' : '#F59E0B',
                      background: data.status === 'active' ? 'rgba(16,185,129,0.12)' : data.status === 'expired' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
                    }}
                  >
                    {STATUS_LABELS[data.status]}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs sm:text-sm">
                <div className="neu-inset rounded-2xl px-4 py-3">
                  <p style={{ color: 'var(--cp-text-l)' }}>Период с</p>
                  <p className="font-bold mt-1" style={{ color: 'var(--cp-text)' }}>{formatDate(data.period_start)}</p>
                </div>
                <div className="neu-inset rounded-2xl px-4 py-3">
                  <p style={{ color: 'var(--cp-text-l)' }}>Оплачен до</p>
                  <p className="font-bold mt-1" style={{ color: 'var(--cp-text)' }}>{formatDate(data.paid_until)}</p>
                </div>
              </div>
            </div>
            <p className="mt-5 text-xs" style={{ color: 'var(--cp-text-m)' }}>
              Всего использовано {formatNum(total.used)} из {formatNum(total.limit)} единиц по всем лимитам.
            </p>
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {LIMITS.map((item) => {
              const usage = data.usage[item.key];
              const pct = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
              const Icon = item.icon;
              return (
                <article key={item.key} className="neu-card p-5" style={{ borderTop: `3px solid ${item.color}` }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0 mt-0.5"
                        style={{ background: `${item.color}18`, color: item.color }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div>
                        <h3 className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>{item.label}</h3>
                        <p className="mt-1 text-xs leading-snug" style={{ color: 'var(--cp-text-m)' }}>{item.hint}</p>
                      </div>
                    </div>
                    <span className="text-xs font-bold" style={{ color: item.color }}>
                      {pct}%
                    </span>
                  </div>
                  <div className="mt-4 h-2 overflow-hidden rounded-full" style={{ background: 'rgba(180,173,164,0.2)' }}>
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: item.color }} />
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="neu-inset rounded-xl px-2 py-2">
                      <p style={{ color: 'var(--cp-text-l)' }}>Лимит</p>
                      <p className="font-bold mt-1">{formatNum(usage.limit)}</p>
                    </div>
                    <div className="neu-inset rounded-xl px-2 py-2">
                      <p style={{ color: 'var(--cp-text-l)' }}>Потрачено</p>
                      <p className="font-bold mt-1">{formatNum(usage.used)}</p>
                    </div>
                    <div className="neu-inset rounded-xl px-2 py-2">
                      <p style={{ color: 'var(--cp-text-l)' }}>Осталось</p>
                      <p className="font-bold mt-1">{formatNum(usage.remaining)}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs" style={{ color: 'var(--cp-text-m)' }}>
                    Осталось {formatNum(usage.remaining)} {item.unit} по вашему тарифу.
                  </p>
                </article>
              );
            })}
          </section>
        </>
      ) : null}
    </div>
  );
}
