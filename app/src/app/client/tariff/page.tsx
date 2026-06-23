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
 *   01 → биллинг           page header + «Обсудить расширение» link
 *   02 → текущий тариф     plan name + status dot + inline billing dates
 *   02b → доступ           shown only when payment_locked
 *   02c → автопродление    shown only when billing_mode === 'autopayment'
 *   03 → лимиты            ledger of per-limit usage rows; muted when locked
 *
 * Pacing for Maksim-class users: stressedLimit hint above the ledger also
 * projects an exhaustion date when current burn rate would run out before
 * the period ends. Silent otherwise.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  CheckCircle2,
  Clock,
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
  /** Mapped russian text from the last failed YooKassa payment attempt. */
  last_payment_error: string | null;
  usage: Record<LimitKey, LimitUsage>;
};

const LIMITS: Array<{
  key: LimitKey;
  label: string;
  hint: string;
}> = [
  {
    key: 'max_contacts',
    label: 'Контакты',
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

const MS_IN_DAY = 86_400_000;

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

function formatShortDate(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

/** Russian "1 / 2-4 / 5+" plural with 11-14 exception. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
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

  // Initial fetch — defers to the same `load()` the «Обновить» button uses
  // (was reimplementing the fetch body inline; invited drift between init
  // and refresh per re-critique findings).
  useEffect(() => {
    void load();
  }, [load]);

  // Days remaining until period end (paid_until). Used to annotate the
  // "оплачен до" date inline — answers "сколько у меня ещё есть" without
  // mental subtraction.
  const daysLeftInPeriod = useMemo<number | null>(() => {
    if (!data?.paid_until) return null;
    const paid = Date.parse(data.paid_until);
    if (!Number.isFinite(paid)) return null;
    const ms = paid - Date.now();
    if (ms < 0) return 0;
    return Math.ceil(ms / MS_IN_DAY);
  }, [data]);

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

  // Burn-rate projection for the stressed limit: if at the current daily
  // pace this limit will exhaust BEFORE the paid period ends, surface the
  // projected calendar date next to "ближайший: ...". Stays quiet when the
  // period ends first (no concern) or when we have <7 days of data (too
  // noisy to project from). Closes the Flexibility gap for Maksim.
  const projectedExhaustion = useMemo<Date | null>(() => {
    if (!data || !stressedLimit) return null;
    const u = data.usage[stressedLimit.key];
    if (!u || u.used <= 0 || u.remaining <= 0) return null;
    const periodStart = Date.parse(data.period_start);
    const paidUntil = data.paid_until ? Date.parse(data.paid_until) : null;
    if (!Number.isFinite(periodStart) || !paidUntil || !Number.isFinite(paidUntil)) return null;
    const now = Date.now();
    const daysElapsed = (now - periodStart) / MS_IN_DAY;
    if (daysElapsed < 7) return null; // too early to project meaningfully
    const dailyBurn = u.used / daysElapsed;
    if (dailyBurn <= 0) return null;
    const daysToExhaust = u.remaining / dailyBurn;
    const projectedMs = now + daysToExhaust * MS_IN_DAY;
    if (projectedMs >= paidUntil) return null; // period ends first; no concern
    return new Date(projectedMs);
  }, [data, stressedLimit]);

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
      <header className="flex items-start justify-between gap-4 flex-wrap">
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
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={'/client/support' as Route}
            className="ds-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-xs"
          >
            Обсудить расширение
          </Link>
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
        </div>
      </header>

      {error && !data && (
        <div className="neu-card flex items-center gap-3 px-5 py-4" role="alert">
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

      {/* Soft error (stale data still rendered) — quiet line, no chrome. */}
      {error && data && (
        <p className="text-xs ds-mono" style={{ color: 'var(--cp-red)' }}>
          {error}{' '}
          <button
            type="button"
            onClick={() => void load()}
            className="underline ml-1"
            style={{ color: 'var(--cp-paper)' }}
          >
            повторить
          </button>
        </p>
      )}

      {data && data.status === 'inactive' && !data.paid_at && (
        <TariffSelectionWidget />
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
              {/* Distilled: was two rounded-md "tile" boxes — micro-card pattern
                  that fought the ledger aesthetic below. Now: inline editorial
                  run, eyebrow + mono value, with the "осталось N дней" suffix
                  inline so the user doesn't have to compute the period length. */}
              <div className="flex flex-col gap-1.5 text-xs sm:text-sm sm:items-end">
                <div className="flex items-baseline gap-2">
                  <span className="ds-eyebrow">период с</span>
                  <span
                    className="ds-mono font-semibold"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {formatDate(data.period_start)}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="ds-eyebrow">оплачен до</span>
                  <span
                    className="ds-mono font-semibold"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {formatDate(data.paid_until)}
                  </span>
                  {daysLeftInPeriod !== null && (
                    <span
                      className="ds-mono text-xs"
                      style={{ color: 'var(--cp-paper-mute)' }}
                    >
                      ({daysLeftInPeriod} {plural(daysLeftInPeriod, 'день', 'дня', 'дней')})
                    </span>
                  )}
                </div>
              </div>
            </div>
            {/* The faux "N из M единиц" total has been deleted — see critique
                2026-05-24: cannot sum контакты + запросы + AI-цепочки as one
                dimensionless count. The "ближайший" hint above the ledger
                does the real job (and the projection extends it for Maksim). */}
          </section>

          {/* ── 02b → Доступ (когда payment locked) ───────────────────── */}
          {data.payment_locked && (
            <section className="neu-card p-5 sm:p-6">
              <p className="ds-eyebrow mb-3">02b<span aria-hidden> → </span>доступ</p>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3">
                  {/* Distill: dropped redundant Lock icon — red dot carries the
                      "locked" semantic; heading carries the rest. */}
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ background: 'var(--cp-red)', marginTop: '8px' }}
                  />
                  <div>
                    {data.billing_mode === 'invoice' ? (
                      <>
                        <h3 className="text-base font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                          Ожидается оплата счёта
                        </h3>
                        <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
                          Менеджер выставил вам счёт. Как только оплата поступит — доступ к функционалу откроется автоматически.
                        </p>
                      </>
                    ) : data.paid_at ? (
                      <>
                        <h3 className="text-base font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                          Оплата получена
                        </h3>
                        <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
                          Команда настраивает ваш аккаунт. Доступ откроется{' '}
                          <strong style={{ color: 'var(--cp-paper)' }}>
                            {formatDate(data.setup_until)}
                          </strong>{' '}
                          или после уведомления от менеджера.
                        </p>
                      </>
                    ) : (
                      <>
                        <h3 className="text-base font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                          Необходима оплата
                        </h3>
                        <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
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
                        {paying ? 'Открываем счёт…' : 'Оплатить подписку'}
                      </button>
                    )}
                    {/* Last-attempt error from YooKassa webhook (payment.canceled).
                        Helps Olga understand WHY her previous click didn't work
                        without us hiding behind a generic "try again". Cleared
                        on the next successful payment. */}
                    {data.last_payment_error && !payError && (
                      <p
                        className="ds-mono text-xs text-right max-w-[18rem]"
                        style={{ color: 'var(--cp-red)' }}
                      >
                        Прошлая попытка: {data.last_payment_error}
                      </p>
                    )}
                    {payError && (
                      <p className="ds-mono text-xs" style={{ color: 'var(--cp-red)' }}>
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

          {/* ── 02c → Автопродление (distilled per re-critique) ───────── */}
          {data.billing_mode === 'autopayment' && (
            <section className="neu-card p-5 sm:p-6">
              <p className="ds-eyebrow mb-3">02c<span aria-hidden> → </span>автопродление</p>
              <div className="space-y-3">
                <div>
                  <h3
                    className="text-base font-bold m-0"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    Автопродление
                  </h3>
                  <p
                    className="mt-1 text-sm"
                    style={{ color: 'var(--cp-paper-mute)' }}
                  >
                    Период оплачен до{' '}
                    <span className="ds-mono" style={{ color: 'var(--cp-paper)' }}>
                      {formatDate(data.paid_until)}
                    </span>
                    . При включённом автопродлении списание выполняется за 1–3 дня до этой даты.
                  </p>
                </div>

                {/* dl → eyebrow + value rows. Tightens the densest section on
                    the page (re-critique P1-NEW). */}
                <div className="flex flex-col gap-1 text-xs">
                  <div className="flex items-baseline gap-3">
                    <span
                      className="ds-eyebrow shrink-0"
                      style={{ minWidth: '14ch' }}
                    >
                      карта
                    </span>
                    <span style={{ color: 'var(--cp-paper)' }}>
                      {data.payment_method_saved
                        ? 'привязана'
                        : 'не привязана (появится после оплаты)'}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-3">
                    <span
                      className="ds-eyebrow shrink-0"
                      style={{ minWidth: '14ch' }}
                    >
                      автопродление
                    </span>
                    <span style={{ color: 'var(--cp-paper)' }}>
                      {data.auto_renew && data.payment_method_saved
                        ? 'включено'
                        : data.auto_renew && !data.payment_method_saved
                          ? 'включено (ожидается карта)'
                          : 'выключено'}
                    </span>
                  </div>
                </div>

                {/* Error tile → quiet mono red line. */}
                {data.last_renewal_error && (
                  <p
                    className="ds-mono text-xs"
                    style={{ color: 'var(--cp-red)' }}
                  >
                    Ошибка автосписания: {data.last_renewal_error}
                  </p>
                )}

                {/* «Отвязать карту» — explicit, always-visible action required
                    by YooKassa support's compliance protocol for autopayments:
                    the user must be able to remove the saved card by
                    themselves at any time. The button is rendered in BOTH
                    states (card present / card absent) so the entry point
                    never disappears — without this, the disabled state would
                    be invisible to the user, and we'd also need real card
                    data to screenshot the flow for YK's подключение review.
                    When no card is saved yet, the button is disabled with a
                    quiet "появится после оплаты" caption next to it. */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setUnlinkOpen(true);
                      setUnlinkError(null);
                    }}
                    disabled={!data.payment_method_saved}
                    aria-disabled={!data.payment_method_saved}
                    title={
                      data.payment_method_saved
                        ? 'Удалить сохранённую карту из вашего личного кабинета'
                        : 'Кнопка станет активной после первой оплаты, когда карта будет сохранена'
                    }
                    className="ds-btn-secondary inline-flex items-center justify-center gap-2 px-4 py-2 text-sm w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Unlink className="h-4 w-4" aria-hidden />
                    Отвязать карту
                  </button>
                  <p
                    className="text-xs flex-1"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    {data.payment_method_saved
                      ? 'Карта удалится из нашей системы, автопродление отключится. Оплаченный период сохраняется.'
                      : 'Карта появится здесь после первой оплаты — там же будет возможность отвязать её одной кнопкой.'}
                  </p>
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
              {stressedLimit && !data.payment_locked && (
                <p
                  className="text-xs ds-mono"
                  style={{ color: 'var(--cp-paper-mute)' }}
                >
                  ближайший:{' '}
                  <span style={{ color: 'var(--cp-paper)' }}>{stressedLimit.label}</span>{' '}
                  <span style={{ color: stressedLimit.color }}>{stressedLimit.pct}%</span>
                  {projectedExhaustion && (
                    <>
                      {' · '}
                      <span style={{ color: stressedLimit.color }}>
                        хватит до {formatShortDate(projectedExhaustion.toISOString())}
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>

            {/* Editorial ledger (1 row per limit, hairline between). When
                payment_locked, dim to 60% and show a caption — the numbers
                are still true but the user can't act on them, so we
                de-emphasize without removing the contract info. */}
            <div
              className="neu-card px-5 sm:px-6"
              style={data.payment_locked ? { opacity: 0.6 } : undefined}
              aria-live="polite"
              aria-disabled={data.payment_locked || undefined}
            >
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
            {data.payment_locked && (
              <p
                className="text-xs mt-2"
                style={{ color: 'var(--cp-paper-mute)' }}
              >
                Лимиты доступны после оплаты.
              </p>
            )}
          </section>
        </>
      )}

      {/* Destructive-action confirmation. Modal acceptable here — high-stakes
          action (unlink saved card), copy explicitly preserves paid_until. */}
      {unlinkOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'var(--cp-scrim)' }}
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
                Отвязать карту?
              </h2>
              <p
                className="text-xs mt-2 leading-relaxed"
                style={{ color: 'var(--cp-paper-mute)' }}
              >
                Сохранённая карта будет удалена из нашей системы. Автопродление отключится. Оплаченный доступ до{' '}
                <span style={{ color: 'var(--cp-paper)' }}>
                  {data ? formatDate(data.paid_until) : '—'}
                </span>{' '}
                сохраняется — продолжать пользоваться можно до этой даты.
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
                {unlinking ? 'Отвязываем…' : 'Отвязать карту'}
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
 *   <label>                          <used> / <limit>
 *   <hint>
 *   ▓▓▓░░░░░░░░░░░░░░  <pct>%               <remaining>
 *
 * First row sits flush, subsequent rows get a hairline top border — no
 * card chrome per row, no nested stat tiles, no redundant "осталось N
 * {unit}" sentence.
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

function TariffSelectionWidget() {
  const [tariff, setTariff] = useState<'standard' | 'pro'>('standard');
  const [period, setPeriod] = useState<'month' | 'quarter' | 'half_year' | 'year'>('month');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceTable: Record<'standard' | 'pro', number> = { standard: 40_000, pro: 80_000 };
  const periodMonths: Record<'month' | 'quarter' | 'half_year' | 'year', number> = {
    month: 1, quarter: 3, half_year: 6, year: 12,
  };
  const periodLabel: Record<'month' | 'quarter' | 'half_year' | 'year', string> = {
    month: '1 месяц', quarter: '3 месяца', half_year: '6 месяцев', year: '1 год',
  };
  const amount = priceTable[tariff] * periodMonths[period];

  const handlePay = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApiFetch<{ payment_url: string }>('/payment', {
        method: 'POST',
        body: JSON.stringify({ tariff_type: tariff, billing_period: period }),
      });
      if (res.payment_url) {
        window.location.href = res.payment_url;
      } else {
        setError('Не удалось получить ссылку на оплату');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Выберите тариф</h2>
      <p className="text-xs text-gray-600 mb-4">После оплаты — 15 дней прогрев почт, затем активный период.</p>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <button
          type="button"
          onClick={() => setTariff('standard')}
          className={`text-left rounded-xl border px-4 py-3 transition ${tariff === 'standard' ? 'border-indigo-500 bg-white shadow' : 'border-gray-200 bg-white/60'}`}
        >
          <p className="font-semibold text-gray-900">Стандарт</p>
          <p className="text-xs text-gray-600">40 000 ₽/мес · 10 000 контактов, 16 почт</p>
        </button>
        <button
          type="button"
          onClick={() => setTariff('pro')}
          className={`text-left rounded-xl border px-4 py-3 transition ${tariff === 'pro' ? 'border-indigo-500 bg-white shadow' : 'border-gray-200 bg-white/60'}`}
        >
          <p className="font-semibold text-gray-900">Про</p>
          <p className="text-xs text-gray-600">80 000 ₽/мес · 20 000 контактов, 32 почты</p>
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['month', 'quarter', 'half_year', 'year'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${period === p ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-700'}`}
          >
            {periodLabel[p]}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-indigo-100 pt-3">
        <p className="text-sm text-gray-700">К оплате: <span className="font-semibold text-gray-900">{amount.toLocaleString('ru-RU')} ₽</span></p>
        <button
          onClick={handlePay}
          disabled={loading}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {loading ? 'Создаём счёт…' : 'Оплатить через ЮKassa'}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700">{error}</p>
      )}
    </section>
  );
}
