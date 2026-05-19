'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Zap, Users, Database, Sparkles, Lock, CheckCircle2, Clock, ExternalLink, Loader2, CreditCard, Unlink } from 'lucide-react';
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
  billing_mode: 'invoice' | 'autopayment' | null;
  payment_locked: boolean;
  auto_renew: boolean;
  payment_method_saved: boolean;
  last_renewal_error: string | null;
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
  const [paying, setPaying] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const handlePay = useCallback(async () => {
    setPaying(true);
    setPayError(null);
    try {
      const res = await clientApiFetch<{ payment_url: string }>('/payment');
      setPaymentUrl(res.payment_url);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setPaying(false);
    }
  }, []);

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

  const handleUnlinkAutopay = useCallback(async () => {
    setUnlinking(true);
    setUnlinkError(null);
    try {
      await clientApiFetch<{ ok: boolean }>('/billing', {
        method: 'POST',
        body: JSON.stringify({ unlink_saved_payment: true }),
      });
      setUnlinkOpen(false);
      await load(false);
    } catch (e) {
      setUnlinkError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setUnlinking(false);
    }
  }, [load]);

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

          {/* Payment lock status card */}
          {data.payment_locked && (
            <section className="neu-card p-5 sm:p-6" style={{ borderLeft: '4px solid #DC2626' }}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3">
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl flex-shrink-0"
                    style={{ background: 'rgba(220,38,38,0.10)', color: '#DC2626' }}>
                    <Lock className="h-5 w-5" />
                  </span>
                  <div>
                    {data.billing_mode === 'invoice' ? (
                      <>
                        <h3 className="text-base font-bold" style={{ color: 'var(--cp-text)' }}>Ожидается оплата счёта</h3>
                        <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
                          Менеджер выставил вам счёт. Как только оплата поступит — доступ к функционалу откроется автоматически.
                        </p>
                      </>
                    ) : data.paid_at ? (
                      <>
                        <h3 className="text-base font-bold" style={{ color: 'var(--cp-text)' }}>Оплата получена</h3>
                        <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
                          Команда настраивает ваш аккаунт. Доступ откроется{' '}
                          <strong>{formatDate(data.setup_until)}</strong> или после уведомления от менеджера.
                        </p>
                      </>
                    ) : (
                      <>
                        <h3 className="text-base font-bold" style={{ color: 'var(--cp-text)' }}>Необходима оплата</h3>
                        <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
                          Оплатите подписку для получения доступа к функционалу портала.
                        </p>
                      </>
                    )}
                  </div>
                </div>
                {data.billing_mode === 'autopayment' && !data.paid_at && (
                  <div className="flex flex-col items-end gap-1">
                    {paymentUrl ? (
                      <a href={paymentUrl} target="_blank" rel="noopener noreferrer"
                        className="neu-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
                        style={{ background: '#DC2626', color: '#fff' }}>
                        <ExternalLink className="h-4 w-4" />
                        Перейти к оплате
                      </a>
                    ) : (
                      <button onClick={handlePay} disabled={paying}
                        className="neu-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold disabled:opacity-60"
                        style={{ background: '#DC2626', color: '#fff' }}>
                        {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                        {paying ? 'Создаём счёт...' : 'Оплатить подписку'}
                      </button>
                    )}
                    {payError && <p className="text-xs" style={{ color: '#DC2626' }}>{payError}</p>}
                  </div>
                )}
                {data.billing_mode === 'autopayment' && data.paid_at && (
                  <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: '#10B981' }}>
                    <CheckCircle2 className="h-4 w-4" />
                    Оплачено {formatDate(data.paid_at)}
                  </div>
                )}
                {data.billing_mode === 'invoice' && (
                  <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--cp-text-m)' }}>
                    <Clock className="h-4 w-4" />
                    Ожидание оплаты...
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Автоплатежи: срок продления и отключение автосписания */}
          {data.billing_mode === 'autopayment' && (
            <section className="neu-card p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span
                  className="inline-flex items-center justify-center w-9 h-9 rounded-xl flex-shrink-0"
                  style={{ background: 'rgba(59,130,246,0.12)', color: '#2563EB' }}
                >
                  <CreditCard className="h-5 w-5" />
                </span>
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <h3 className="text-base font-bold" style={{ color: 'var(--cp-text)' }}>
                      Автопродление подписки
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--cp-text-m)' }}>
                      Текущий оплаченный период до{' '}
                      <strong style={{ color: 'var(--cp-text)' }}>{formatDate(data.paid_until)}</strong>.
                      При включённом автопродлении списание за следующий месяц выполняется автоматически заранее —
                      обычно в течение нескольких дней до этой даты (как только подключается сохранённый способ
                      оплаты после первой оплаты).
                    </p>
                  </div>
                  <dl className="grid gap-2 text-xs sm:text-sm">
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      <dt className="font-semibold" style={{ color: 'var(--cp-text-l)' }}>Сохранённая карта для списаний</dt>
                      <dd style={{ color: 'var(--cp-text)' }}>
                        {data.payment_method_saved ? 'да (используется для автопродления)' : 'ещё не привязана — появится после успешной оплаты'}
                      </dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      <dt className="font-semibold" style={{ color: 'var(--cp-text-l)' }}>Автопродление в портале</dt>
                      <dd style={{ color: 'var(--cp-text)' }}>
                        {data.auto_renew && data.payment_method_saved
                          ? 'включено'
                          : data.auto_renew && !data.payment_method_saved
                            ? 'включено (ожидается привязка после оплаты)'
                            : 'выключено'}
                      </dd>
                    </div>
                  </dl>
                  {data.last_renewal_error ? (
                    <p className="text-xs font-medium rounded-xl px-3 py-2" style={{ background: 'rgba(239,68,68,0.1)', color: '#B91C1C' }}>
                      Последняя ошибка автосписания: {data.last_renewal_error}
                    </p>
                  ) : null}
                  {(data.payment_method_saved || data.auto_renew) && (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => { setUnlinkOpen(true); setUnlinkError(null); }}
                        className="neu-pill inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold w-full sm:w-auto"
                        style={{ border: '1px solid rgba(113,113,122,0.35)', color: 'var(--cp-text)' }}
                      >
                        <Unlink className="h-4 w-4" />
                        Отключить автопродление и отвязать карту
                      </button>
                      <p className="text-xs flex-1" style={{ color: 'var(--cp-text-l)' }}>
                        Автосписания из портала прекратятся. Текущий период не отменяется. При следующей оплате карту можно привязать снова.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

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

      {unlinkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden" style={{ color: '#18181b' }}>
            <div className="px-6 pt-6 pb-2">
              <h2 className="text-sm font-semibold text-zinc-800">Отключить автопродление?</h2>
              <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
                Мы перестанем автоматически продлевать подписку и уберём сохранённый способ оплаты из настроек этого
                кабинета. Оплаченный доступ до <span className="font-medium text-zinc-700">{data ? formatDate(data.paid_until) : '—'}</span> сохраняется.
              </p>
              {unlinkError ? <p className="mt-2 text-xs text-red-600">{unlinkError}</p> : null}
            </div>
            <div className="flex gap-2 px-6 py-4">
              <button
                type="button"
                onClick={() => { setUnlinkOpen(false); setUnlinkError(null); }}
                disabled={unlinking}
                className="flex-1 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void handleUnlinkAutopay()}
                disabled={unlinking}
                className="flex-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60"
              >
                {unlinking ? 'Сохраняем…' : 'Отключить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
