'use client';

/**
 * Client tariff / billing view.
 *
 * One-page contract summary: current plan + access status + autopay (if any)
 * + per-limit usage ledger. Editorial dark, ledger pattern (no card-grid
 * anti-pattern), honest unit names (no faux "60 020 единиц" summary across
 * orthogonal quantities — see /impeccable critique 2026-05-24 for context).
 *
 * Sections, all editorially numbered so a screen-reader / cmd-F user can
 * jump between them:
 *   01 → биллинг           page header
 *   02 → текущий тариф     plan name + status dot + billing dates
 *   02b → доступ           shown only when payment_locked
 *   02c → автопродление    shown only when billing_mode === 'autopayment'
 *   03 → лимиты            ledger of per-limit usage rows
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  RefreshCw,
  Unlink,
  Zap,
} from 'lucide-react';
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

const LIMITS: Array<{
  key: LimitKey;
  label: string;
  hint: string;
}> = [
  {
    key: 'max_contacts',
    label: 'Контакты Instantly',
    hint: 'Лиды, загруженные в кампании',
  },
  {
    key: 'max_rows',
    label: 'Запросы на сбор и базы',
    hint: 'HH, Яндекс.Карты, поисковая выдача, конструктор баз',
  },
  {
    key: 'max_chains_per_month',
    label: 'Цепочки писем',
    hint: 'AI-генерации цепочек за период',
  },
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

// Status → 6px semantic dot. Active = green; expired = red; setup/inactive
// = amber (in-progress). Matches the system's Status-as-Data rule.
function statusDot(status: TariffResponse['status']): string {
  switch (status) {
    case 'active':
      return 'var(--cp-green)';
    case 'expired':
      return 'var(--cp-red)';
    case 'setup':
    case 'inactive':
    default:
      return 'var(--cp-amber)';
  }
}

// Progress fill colour: green when there's plenty of headroom, amber over
// 80%, red over 95%. Data semantics, not decoration.
function usageDot(pct: number): string {
  if (pct >= 95) return 'var(--cp-red)';
  if (pct >= 80) return 'var(--cp-amber)';
  return 'var(--cp-green)';
}

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

  // Most-stressed limit: surfaces a single one-line answer to "am I about
  // to hit something?" so Olga doesn't have to scan three rows to feel safe
  // and Maksim can prioritize. Replaces the meaningless "12 754 из 60 020
  // единиц" sum-of-orthogonal-quantities line we deleted.
  const stressedLimit = useMemo(() => {
    if (!data) return null;
    let best: { key: LimitKey; label: string; pct: number; color: string } | null = null;
    for (const item of LIMITS) {
      const u = data.usage[item.key];
      if (!u || u.limit <= 0) continue;
      const pct = Math.min(100, Math.round((u.used / u.limit) * 100));
      if (!best || pct > best.pct) {
        best = { key: item.key, label: item.label, pct, color: usageDot(pct) };
      }
    }
    return best;
  }, [data]);

  // ── Loading skeleton ───────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 sm:space-y-8">
        <header>
          <p className="ds-eyebrow mb-2">
            01<span aria-hidden> → </span>биллинг
          </p>
          <h1
            className="text-xl sm:text-2xl font-extrabold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Тариф
          </h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Текущий тариф и остатки по лимитам на расчётный период.
          </p>
        </header>
        <div className="neu-card flex items-center gap-3 px-5 py-4">
          <Loader2
            className="h-4 w-4 animate-spin"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Загружаем тариф…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 sm:space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="ds-eyebrow mb-2">
            01<span aria-hidden> → </span>биллинг
          </p>
          <h1
            className="text-xl sm:text-2xl font-extrabold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Тариф
          </h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Текущий тариф и остатки по лимитам на расчётный период.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ds-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-xs disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            aria-hidden
          />
          Обновить
        </button>
      </header>

      {error && !data && (
        <div
          className="neu-card flex items-center gap-3 px-5 py-4"
          role="alert"
        >
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
            style={{ background: 'var(--cp-red)' }}
          />
          <p className="text-sm flex-1" style={{ color: 'var(--cp-paper)' }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs shrink-0"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
        </div>
      )}

      {/* Soft error (data exists but a recent reload failed) — quiet line, no chrome */}
      {error && data && (
        <p className="text-xs ds-mono" style={{ color: 'var(--cp-red)' }}>
          {error} <button
            type="button"
            onClick={() => void load()}
            className="underline ml-1"
            style={{ color: 'var(--cp-paper)' }}
          >
            повторить
          </button>
        </p>
      )}

      {data && (
        <>
          {/* ── 02 → Текущий тариф ───────────────────────────────────── */}
          <section className="neu-card p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="ds-eyebrow mb-2">02<span aria-hidden> → </span>текущий тариф</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <h2
                    className="text-2xl font-bold m-0"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {TARIFF_LABELS[data.tariff_type]}
                  </h2>
                  {/* Quieter: dot + colored label, no tag wrapper / uppercase pill. */}
                  <span
                    className="inline-flex items-center gap-1.5 text-sm"
                    style={{ color: statusDot(data.status) }}
                  >
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: statusDot(data.status) }}
                    />
                    {STATUS_LABELS[data.status]}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs sm:text-sm">
                <div
                  className="rounded-md px-4 py-3"
                  style={{
                    background: 'var(--cp-surface-rest)',
                    border: '1px solid var(--cp-divider)',
                  }}
                >
                  <p className="ds-eyebrow">период с</p>
                  <p
                    className="ds-mono font-semibold mt-1"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {formatDate(data.period_start)}
                  </p>
                </div>
                <div
                  className="rounded-md px-4 py-3"
                  style={{
                    background: 'var(--cp-surface-rest)',
                    border: '1px solid var(--cp-divider)',
                  }}
                >
                  <p className="ds-eyebrow">оплачен до</p>
                  <p
                    className="ds-mono font-semibold mt-1"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {formatDate(data.paid_until)}
                  </p>
                </div>
              </div>
            </div>
            {/* Removed faux total "N из M единиц" — see /impeccable critique 2026-05-24:
                you cannot sum контакты + запросы + AI-цепочки as one "единиц"
                count without misleading the reader. The most-stressed limit
                hint above the ledger does the real job. */}
          </section>

          {/* ── 02b → Доступ (когда payment locked) ───────────────────── */}
          {data.payment_locked && (
            <section className="neu-card p-5 sm:p-6">
              <p className="ds-eyebrow mb-3">02b<span aria-hidden> → </span>доступ</p>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3">
                  {/* Distill: dropped redundant Lock icon — the red dot already
                      carries the "locked" semantic; the heading carries the rest. */}
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ background: 'var(--cp-red)', marginTop: '8px' }}
                  />
                  <div>
                    {data.billing_mode === 'invoice' ? (
                      <>
                        <h3
                          className="text-base font-bold m-0"
                          style={{ color: 'var(--cp-paper)' }}
                        >
                          Ожидается оплата счёта
                        </h3>
                        <p
                          className="mt-1 text-sm"
                          style={{ color: 'var(--cp-paper-mute)' }}
                        >
                          Менеджер выставил вам счёт. Как только оплата поступит — доступ к функционалу откроется автоматически.
                        </p>
                      </>
                    ) : data.paid_at ? (
                      <>
                        <h3
                          className="text-base font-bold m-0"
                          style={{ color: 'var(--cp-paper)' }}
                        >
                          Оплата получена
                        </h3>
                        <p
                          className="mt-1 text-sm"
                          style={{ color: 'var(--cp-paper-mute)' }}
                        >
                          Команда настраивает ваш аккаунт. Доступ откроется{' '}
                          <strong style={{ color: 'var(--cp-paper)' }}>
                            {formatDate(data.setup_until)}
                          </strong>{' '}
                          или после уведомления от менеджера.
                        </p>
                      </>
                    ) : (
                      <>
                        <h3
                          className="text-base font-bold m-0"
                          style={{ color: 'var(--cp-paper)' }}
                        >
                          Необходима оплата
                        </h3>
                        <p
                          className="mt-1 text-sm"
                          style={{ color: 'var(--cp-paper-mute)' }}
                        >
                          Оплатите подписку для получения доступа к функционалу портала.
                        </p>
                      </>
                    )}
                  </div>
                </div>
                {data.billing_mode === 'autopayment' && !data.paid_at && (
                  <div className="flex flex-col items-end gap-1">
                    {paymentUrl ? (
                      <a
                        href={paymentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ds-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden />
                        Перейти к оплате
                      </a>
                    ) : (
                      <button
                        onClick={handlePay}
                        disabled={paying}
                        className="ds-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-60"
                      >
                        {paying ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Zap className="h-4 w-4" aria-hidden />
                        )}
                        {paying ? 'Создаём счёт…' : 'Оплатить подписку'}
                      </button>
                    )}
                    {payError && (
                      <p
                        className="ds-mono text-xs"
                        style={{ color: 'var(--cp-red)' }}
                      >
                        {payError}
                      </p>
                    )}
                  </div>
                )}
                {data.billing_mode === 'autopayment' && data.paid_at && (
                  <div
                    className="flex items-center gap-1.5 text-sm font-semibold"
                    style={{ color: 'var(--cp-green)' }}
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    Оплачено {formatDate(data.paid_at)}
                  </div>
                )}
                {data.billing_mode === 'invoice' && (
                  <div
                    className="flex items-center gap-1.5 text-sm"
                    style={{ color: 'var(--cp-paper-mute)' }}
                  >
                    <Clock className="h-4 w-4" aria-hidden />
                    Ожидание оплаты…
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── 02c → Автопродление (только когда billing_mode = autopayment) ── */}
          {data.billing_mode === 'autopayment' && (
            <section className="neu-card p-5 sm:p-6">
              <p className="ds-eyebrow mb-3">02c<span aria-hidden> → </span>автопродление</p>
              <div className="flex items-start gap-3">
                <CreditCard
                  className="h-5 w-5 shrink-0 mt-0.5"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-hidden
                />
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <h3
                      className="text-base font-bold m-0"
                      style={{ color: 'var(--cp-paper)' }}
                    >
                      Автопродление подписки
                    </h3>
                    <p
                      className="mt-1 text-sm leading-relaxed"
                      style={{ color: 'var(--cp-paper-mute)' }}
                    >
                      Текущий оплаченный период до{' '}
                      <strong style={{ color: 'var(--cp-paper)' }}>
                        {formatDate(data.paid_until)}
                      </strong>
                      . При включённом автопродлении списание за следующий месяц выполняется
                      автоматически заранее — обычно в течение нескольких дней до этой даты
                      (как только подключается сохранённый способ оплаты после первой оплаты).
                    </p>
                  </div>
                  <dl className="grid gap-2 text-xs sm:text-sm">
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      <dt
                        className="font-semibold"
                        style={{ color: 'var(--cp-paper-faint)' }}
                      >
                        Сохранённая карта для списаний
                      </dt>
                      <dd style={{ color: 'var(--cp-paper)' }}>
                        {data.payment_method_saved
                          ? 'да (используется для автопродления)'
                          : 'ещё не привязана — появится после успешной оплаты'}
                      </dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      <dt
                        className="font-semibold"
                        style={{ color: 'var(--cp-paper-faint)' }}
                      >
                        Автопродление в портале
                      </dt>
                      <dd style={{ color: 'var(--cp-paper)' }}>
                        {data.auto_renew && data.payment_method_saved
                          ? 'включено'
                          : data.auto_renew && !data.payment_method_saved
                            ? 'включено (ожидается привязка после оплаты)'
                            : 'выключено'}
                      </dd>
                    </div>
                  </dl>
                  {data.last_renewal_error && (
                    <div
                      className="text-xs font-medium rounded-md px-3 py-2 flex items-start gap-2.5"
                      style={{
                        background: 'var(--cp-surface-rest)',
                        border: '1px solid var(--cp-divider)',
                      }}
                    >
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: 'var(--cp-red)', marginTop: '5px' }}
                      />
                      <span style={{ color: 'var(--cp-paper)' }}>
                        Последняя ошибка автосписания: {data.last_renewal_error}
                      </span>
                    </div>
                  )}
                  {(data.payment_method_saved || data.auto_renew) && (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setUnlinkOpen(true);
                          setUnlinkError(null);
                        }}
                        className="ds-btn-secondary inline-flex items-center justify-center gap-2 px-4 py-2 text-sm w-full sm:w-auto"
                      >
                        <Unlink className="h-4 w-4" aria-hidden />
                        Отключить автопродление и отвязать карту
                      </button>
                      <p
                        className="text-xs flex-1"
                        style={{ color: 'var(--cp-paper-faint)' }}
                      >
                        Автосписания из портала прекратятся. Текущий период не отменяется. При следующей оплате карту можно привязать снова.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ── 03 → Лимиты ─────────────────────────────────────────── */}
          <section aria-labelledby="tariff-limits-label">
            <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
              <p id="tariff-limits-label" className="ds-eyebrow">
                03<span aria-hidden> → </span>лимиты
              </p>
              {stressedLimit && (
                <p
                  className="text-xs ds-mono"
                  style={{ color: 'var(--cp-paper-mute)' }}
                >
                  ближайший: <span style={{ color: 'var(--cp-paper)' }}>{stressedLimit.label}</span>{' '}
                  <span style={{ color: stressedLimit.color }}>{stressedLimit.pct}%</span>
                </p>
              )}
            </div>

            {/* Editorial ledger: one row per limit, hairline divider between.
                Replaces the 3-card grid (absolute-ban) + nested 3-tile hero-metric
                template (absolute-ban) the page had pre-2026-05-24. */}
            <div className="neu-card px-5 sm:px-6" aria-live="polite">
              {LIMITS.map((item, idx) => {
                const usage = data.usage[item.key];
                if (!usage) return null;
                return (
                  <LimitRow
                    key={item.key}
                    item={item}
                    usage={usage}
                    isFirst={idx === 0}
                  />
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Destructive-action confirmation. Modal is acceptable here because the
          consequence (unlink saved card) is genuinely high-stakes; copy
          explicitly preserves paid_until access so the user isn't anxious. */}
      {unlinkOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.6)' }}
        >
          <div
            className="rounded-lg w-full max-w-md overflow-hidden"
            style={{
              background: 'var(--cp-surface-elev)',
              border: '1px solid var(--cp-divider-strong)',
              color: 'var(--cp-paper)',
            }}
          >
            <div className="px-6 pt-6 pb-2">
              <h2
                className="text-base font-semibold m-0"
                style={{ color: 'var(--cp-paper)' }}
              >
                Отключить автопродление?
              </h2>
              <p
                className="text-xs mt-2 leading-relaxed"
                style={{ color: 'var(--cp-paper-mute)' }}
              >
                Мы перестанем автоматически продлевать подписку и уберём сохранённый способ оплаты из настроек этого
                кабинета. Оплаченный доступ до{' '}
                <span style={{ color: 'var(--cp-paper)' }}>
                  {data ? formatDate(data.paid_until) : '—'}
                </span>{' '}
                сохраняется.
              </p>
              {unlinkError && (
                <p
                  className="ds-mono mt-2 text-xs"
                  style={{ color: 'var(--cp-red)' }}
                >
                  {unlinkError}
                </p>
              )}
            </div>
            <div className="flex gap-2 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  setUnlinkOpen(false);
                  setUnlinkError(null);
                }}
                disabled={unlinking}
                className="ds-btn-secondary flex-1 px-4 py-2 text-sm disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void handleUnlinkAutopay()}
                disabled={unlinking}
                className="ds-btn-primary flex-1 px-4 py-2 text-sm disabled:opacity-60"
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

/**
 * One limit row in the editorial ledger.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ <label>                          <used> / <limit>       │
 *   │ <hint>                                                  │
 *   │ ▓▓▓░░░░░░░░░░░░░░  <pct>%               <remaining>      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * First row sits flush, subsequent rows get a hairline top border for the
 * editorial table feel — no card chrome per row, no nested stat tiles, no
 * redundant "осталось N {unit}" sentence.
 */
function LimitRow({
  item,
  usage,
  isFirst,
}: {
  item: { key: LimitKey; label: string; hint: string };
  usage: LimitUsage;
  isFirst: boolean;
}) {
  const pct = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const fillColor = usageDot(pct);
  const showProgress = usage.limit > 0;

  return (
    <div
      className={`py-4 sm:py-5 ${isFirst ? '' : 'border-t'}`}
      style={isFirst ? undefined : { borderTopColor: 'var(--cp-divider)' }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
          {item.label}
        </p>
        <p className="text-sm ds-mono tabular-nums shrink-0" style={{ color: 'var(--cp-paper)' }}>
          {formatNum(usage.used)}{' '}
          <span style={{ color: 'var(--cp-paper-faint)' }}>
            / {showProgress ? formatNum(usage.limit) : '∞'}
          </span>
        </p>
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--cp-paper-mute)' }}>
        {item.hint}
      </p>
      {showProgress ? (
        <div className="mt-3 flex items-center gap-3">
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--cp-divider)' }}
          >
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${pct}%`, background: fillColor }}
            />
          </div>
          <span
            className="ds-mono text-xs tabular-nums font-semibold shrink-0"
            style={{ color: fillColor, minWidth: '2.5rem', textAlign: 'right' }}
          >
            {pct}%
          </span>
          <span
            className="ds-mono text-xs tabular-nums shrink-0"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {formatNum(usage.remaining)} осталось
          </span>
        </div>
      ) : (
        <p
          className="mt-3 ds-mono text-xs"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          Лимит не задан — расход не ограничен.
        </p>
      )}
    </div>
  );
}
