'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { UserRole, UserProfile } from '@/types';
import { ALL_ROLES, ROLE_LABELS, isAdmin } from '@/lib/roles';
import { useUser } from '@/lib/UserProvider';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { Check, CheckCircle2, ChevronDown, ChevronUp, FileUp, Loader2, MoreVertical, Plus, Power, Unlock } from 'lucide-react';
import { parseInnColumn } from '@/lib/companiesSearch/innCsv';
import { ALL_TOOL_IDS, TOOLS_CONFIG, ALL_NAV_TAB_IDS, NAV_TABS_CONFIG } from '@/lib/toolsRegistry';
import { CampaignStatusLabels } from '@/lib/instantly/types';

type TariffType = 'standard' | 'pro' | 'custom';
type TariffData = {
  tariff_type: TariffType;
  max_contacts: number | null;
  max_rows: number | null;
  max_chains_per_month: number | null;
  max_domains: number | null;
  max_emails: number | null;
};

/** Ответ GET /api/admin/users/:id/tariff — поле tariff */
type AdminUserTariffPayload = TariffData & {
  is_active?: boolean;
  paid_until?: string | null;
  setup_until?: string | null;
  billing_mode?: 'invoice' | 'autopayment' | null;
  payment_locked?: boolean;
  billing_period?: BillingPeriod | null;
  billing_amount?: number | null;
  /** Персистентный флаг "клиент работает с тестовым магазином ЮКассы".
   *  Управляется отдельным блоком в админ-модалке, переключает отображение
   *  цен в клиентском ЛК и креды при создании счёта. */
  is_test_shop?: boolean;
};
const TARIFF_DEFAULTS: Record<'standard' | 'pro', Omit<TariffData, 'tariff_type'>> = {
  standard: { max_contacts: 10_000, max_rows: 20_000, max_chains_per_month: 10, max_domains: 4, max_emails: 16 },
  pro: { max_contacts: 20_000, max_rows: 40_000, max_chains_per_month: 20, max_domains: 8, max_emails: 32 },
};
// Названия тарифов совпадают с лендингом outreachos.pro. DB-enum остаётся
// standard/pro/custom — переименование только на уровне UI.
const TARIFF_LABELS: Record<TariffType, string> = { standard: 'Запуск', pro: 'Поток', custom: 'Масштаб' };

// Клиентская пагинация списка кампаний в action-модалке. В DOM держим только
// 10 строк за раз — у клиентов бывает 200+ кампаний, и рендер всех чекбоксов
// заметно лагает при каждом keystroke / toggle (см. также useMemo ниже).
const CAMPAIGNS_PER_PAGE = 10;

// Mirror lib/tariffs.ts (which is server-only). Keep in sync with that file.
// Цены и скидки должны совпадать 1-в-1 с lib/tariffs.ts — иначе админ увидит
// одни цифры, клиент в ЛК — другие.
type BillingPeriod = 'month' | 'quarter' | 'half_year' | 'year';
const TARIFF_MONTHLY_PRICE: Record<'standard' | 'pro', number> = { standard: 40_000, pro: 65_000 };
const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = { month: 1, quarter: 3, half_year: 6, year: 12 };
// 3 мес = -5%, 6 мес = -10%, 12 мес = -20%. Месяц — без скидки.
const BILLING_PERIOD_DISCOUNT: Record<BillingPeriod, number> = { month: 1, quarter: 0.95, half_year: 0.9, year: 0.8 };
const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  month: '1 месяц',
  quarter: '3 месяца',
  half_year: '6 месяцев',
  year: '12 месяцев',
};

function calcTariffAmount(tariff: TariffType, period: BillingPeriod): number | null {
  if (tariff === 'custom') return null;
  const base = TARIFF_MONTHLY_PRICE[tariff] * BILLING_PERIOD_MONTHS[period];
  return Math.round(base * BILLING_PERIOD_DISCOUNT[period]);
}

function formatRub(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toLocaleString('ru-RU')} ₽`;
}
function haveSameIds(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
}

const LIMIT_LABELS: { key: keyof Omit<TariffData, 'tariff_type'>; label: string }[] = [
  { key: 'max_contacts', label: 'Контакты Instantly' },
  { key: 'max_rows', label: 'Строки для сбора + конструктор баз' },
  { key: 'max_chains_per_month', label: 'Генерация цепочек / мес' },
  { key: 'max_domains', label: 'Домены' },
  { key: 'max_emails', label: 'Почты' },
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Неизвестная ошибка';
}

/**
 * One row of the users table. Extracted + React.memo'd so that typing in the
 * action modal (which lives in the same parent component) does not re-render
 * 50+ rows on every keystroke. memo's default shallow compare is enough here
 * because parent passes `user` from a stable sortedUsers reference,
 * `signedUrl` as a primitive string (or undefined), `actionLoading` as a
 * boolean, and `onOpenAction` is wrapped in useCallback below.
 */
const UserRow = memo(function UserRow({
  user,
  signedUrl,
  actionLoading,
  onOpenAction,
}: {
  user: UserProfile;
  signedUrl: string | null | undefined;
  actionLoading: boolean;
  onOpenAction: (user: UserProfile, origin: { x: number; y: number }) => void;
}) {
  const roleBadgeClass =
    user.role === 'admin' ? 'bg-purple-100 text-purple-800' :
    user.role === 'manager' ? 'bg-blue-100 text-blue-800' :
    user.role === 'director' ? 'bg-indigo-100 text-indigo-800' :
    user.role === 'technician' ? 'bg-green-100 text-green-800' :
    user.role === 'sales' ? 'bg-yellow-100 text-yellow-800' :
    user.role === 'marketer' ? 'bg-pink-100 text-pink-800' :
    'bg-gray-100 text-gray-800';

  return (
    <tr className="hover:bg-gray-50">
      <td className="pl-10 pr-6 py-4 whitespace-nowrap text-left">
        <div className="flex items-center">
          <div className="w-10 flex justify-center flex-shrink-0">
            <UserAvatar user={user} signedUrl={signedUrl} />
          </div>
          <div className="ml-4">
            <p className="text-sm font-medium text-gray-900">
              {user.full_name || 'Без имени'}
            </p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-center">
        <p className="text-sm text-gray-600">{user.email || '—'}</p>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-center">
        <span className={`inline-flex px-3 py-1 rounded-full text-xs font-medium ${roleBadgeClass}`}>
          {user.role ? ROLE_LABELS[user.role] : 'Нет роли'}
        </span>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-center">
        <button
          type="button"
          onClick={(e) => {
            const target = e.currentTarget as HTMLElement;
            const rect = target.getBoundingClientRect();
            const origin = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
            onOpenAction(user, origin);
          }}
          disabled={actionLoading}
          className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors inline-flex items-center justify-center disabled:opacity-70"
          title="Действия"
          aria-label="Открыть действия"
        >
          {actionLoading ? (
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" aria-hidden />
          ) : (
            <MoreVertical className="h-5 w-5" />
          )}
        </button>
      </td>
    </tr>
  );
});

/**
 * Compose the success message after activate / extend, tagging the autopayment
 * branch with the actual YooKassa-invoice-creation outcome instead of a flat
 * "клиент оплатит в своём ЛК". Three sub-cases for autopayment:
 *
 *   1. YK invoice created and has payment_url → "Счёт автоматически создан в ЮКассе."
 *   2. Invoice row exists but YK call failed (yookassa_error present)       →
 *      include the raw error so the admin can act ("Откройте /invoices ...").
 *   3. The whole helper returned null (e.g. server misconfigured)           →
 *      generic "оплатит в своём ЛК".
 *
 * For invoice/manual modes we never auto-create a YK invoice, so the message
 * stays the same as before.
 */
function activateSuccessMessage(
  billingMode: 'invoice' | 'autopayment' | null,
  invoice: { invoice_id: string | null; payment_url: string | null; yookassa_error: string | null; is_test_shop?: boolean } | null,
): string {
  if (billingMode === 'invoice') return 'Активировано. Зайдите в Счета и выставьте счёт клиенту.';
  if (billingMode === 'autopayment') {
    if (invoice?.payment_url) {
      const shopSuffix = invoice.is_test_shop ? ' (тестовый магазин)' : '';
      return `Активировано. Счёт автоматически создан в ЮКассе${shopSuffix} — клиент увидит ссылку в своём ЛК.`;
    }
    if (invoice?.invoice_id && invoice?.yookassa_error) {
      return `Активировано. Счёт записан, но ЮКасса не приняла его: ${invoice.yookassa_error}. Откройте /invoices и нажмите «ЮКасса» вручную.`;
    }
    return 'Активировано. Клиент оплатит в своём ЛК.';
  }
  return 'Оплата отмечена, настройка ЛК начата';
}

function extendSuccessMessage(
  billingMode: 'invoice' | 'autopayment' | null,
  invoice: { invoice_id: string | null; payment_url: string | null; yookassa_error: string | null; is_test_shop?: boolean } | null,
): string {
  if (billingMode === 'invoice') return 'Подписка продлена. Выставьте новый счёт клиенту.';
  if (billingMode === 'autopayment') {
    if (invoice?.payment_url) {
      const shopSuffix = invoice.is_test_shop ? ' (тестовый магазин)' : '';
      return `Подписка продлена. Новый счёт автоматически создан в ЮКассе${shopSuffix}.`;
    }
    if (invoice?.invoice_id && invoice?.yookassa_error) {
      return `Подписка продлена. Счёт записан, но ЮКасса не приняла его: ${invoice.yookassa_error}. Откройте /invoices и нажмите «ЮКасса» вручную.`;
    }
    return 'Подписка продлена. Клиент оплатит в своём ЛК.';
  }
  return 'Подписка продлена';
}

/**
 * Subscription panel inside the user action modal. Holds the activation /
 * extend form state LOCALLY — so typing in the «Сумма за период» input or
 * clicking through the billing-mode chips no longer triggers a re-render of
 * the parent page (which carries 700+ lines of modal JSX + a 50-row users
 * table). The parent receives the resulting tariff snapshot via callbacks
 * after the API call settles, not on every keystroke.
 */
type SubscriptionPanelProps = {
  userId: string;
  apiFetch: <T,>(path: string, init?: RequestInit) => Promise<T>;
  tariffType: TariffType;
  subscriptionActive: boolean;
  subscriptionSetup: boolean;
  paidUntil: string | null;
  setupUntil: string | null;
  billingMode: 'invoice' | 'autopayment' | null;
  paymentLocked: boolean;
  billingPeriod: BillingPeriod | null;
  billingAmount: number | null;
  /** Префилл локального toggle "магазин ЮКасса" из персистентного флага на
   *  профиле клиента. Админ всё ещё может одноразово переопределить для
   *  конкретной активации/продления. */
  defaultIsTestShop: boolean;
  onActivateResult: (res: {
    paid_until?: string | null;
    setup_until?: string | null;
    billing_mode?: 'invoice' | 'autopayment' | null;
    payment_locked?: boolean;
    billing_period?: BillingPeriod | null;
    billing_amount?: number | null;
  }) => void;
  onExtendResult: (res: {
    paid_until?: string | null;
    billing_mode?: 'invoice' | 'autopayment' | null;
    payment_locked?: boolean;
    billing_period?: BillingPeriod | null;
    billing_amount?: number | null;
  }) => void;
  onFinishSetupResult: (res: { paid_until?: string | null; setup_until?: string | null }) => void;
  onUnlockPaymentSuccess: () => void;
  onDeactivateSuccess: () => void;
  onError: (msg: string) => void;
  onSuccessMessage: (msg: string) => void;
};

const SubscriptionPanel = memo(function SubscriptionPanel({
  userId,
  apiFetch,
  tariffType,
  subscriptionActive,
  subscriptionSetup,
  paidUntil,
  setupUntil,
  billingMode,
  paymentLocked,
  billingPeriod,
  billingAmount,
  defaultIsTestShop,
  onActivateResult,
  onExtendResult,
  onFinishSetupResult,
  onUnlockPaymentSuccess,
  onDeactivateSuccess,
  onError,
  onSuccessMessage,
}: SubscriptionPanelProps) {
  const [activateBillingMode, setActivateBillingMode] = useState<'invoice' | 'autopayment' | 'manual'>('manual');
  const [activatePeriod, setActivatePeriod] = useState<BillingPeriod>('month');
  const [activateCustomAmount, setActivateCustomAmount] = useState('');
  const [activating, setActivating] = useState(false);
  const [showExtendForm, setShowExtendForm] = useState(false);
  const [useTestShop, setUseTestShop] = useState(defaultIsTestShop);
  // QA test mode — replaces month/half_year/year with a minutes-based period.
  // Used to exercise the full autopayment + cron renewal loop against the
  // real YK shop in minutes instead of waiting a real month.
  const [useTestPeriod, setUseTestPeriod] = useState(false);
  const [testMinutes, setTestMinutes] = useState('10');

  const handleActivate = useCallback(async () => {
    // Test mode + Custom both require a manual amount input.
    const needsManualAmount = useTestPeriod || tariffType === 'custom';
    if (needsManualAmount) {
      const n = Number(activateCustomAmount.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) {
        onError(useTestPeriod ? 'Укажите сумму для тест-периода' : 'Укажите сумму за период для тарифа Custom');
        return;
      }
    }
    if (useTestPeriod) {
      const m = Number(testMinutes);
      if (!Number.isFinite(m) || m <= 0) {
        onError('Укажите количество минут для тест-периода');
        return;
      }
    }
    setActivating(true);
    try {
      const bm = activateBillingMode === 'manual' ? null : activateBillingMode;
      const customAmt = needsManualAmount ? Number(activateCustomAmount.replace(',', '.')) : undefined;
      const res = await apiFetch<{
        ok: true; paid_until?: string; setup_until?: string;
        billing_mode?: string; payment_locked?: boolean;
        billing_period?: string; billing_amount?: number;
        invoice?: { invoice_id: string | null; payment_url: string | null; yookassa_error: string | null } | null;
      }>(`/api/admin/users/${userId}/tariff`, {
        method: 'PUT',
        body: JSON.stringify({
          action: 'activate',
          billing_mode: bm,
          tariff_type: tariffType,
          billing_period: useTestPeriod ? undefined : activatePeriod,
          billing_amount: customAmt,
          is_test_shop: bm === 'autopayment' ? useTestShop : false,
          test_minutes: useTestPeriod ? Math.floor(Number(testMinutes)) : undefined,
        }),
      });
      onActivateResult({
        paid_until: res.paid_until ?? null,
        setup_until: res.setup_until ?? null,
        billing_mode: (res.billing_mode as 'invoice' | 'autopayment' | null) ?? null,
        payment_locked: res.payment_locked ?? false,
        billing_period: (res.billing_period as BillingPeriod | null) ?? null,
        billing_amount: res.billing_amount ?? null,
      });
      // Autopayment path also tries to auto-create a YooKassa invoice on the
      // server (see ensurePendingInvoiceForTariff). Surface the result here so
      // the admin sees WHY the YK call failed (env not set, missing receipt
      // email, YK API rejected, etc) instead of silently landing on /invoices
      // with an unpaid row and a manual "ЮКасса" button to retry.
      onSuccessMessage(activateSuccessMessage(bm, res.invoice ?? null));
    } catch (err: unknown) {
      onError(getErrorMessage(err));
    } finally {
      setActivating(false);
    }
  }, [activateBillingMode, activatePeriod, activateCustomAmount, tariffType, userId, apiFetch, onActivateResult, onSuccessMessage, onError, useTestShop, useTestPeriod, testMinutes]);

  const handleFinishSetup = useCallback(async () => {
    setActivating(true);
    try {
      const res = await apiFetch<{ ok: true; paid_until?: string; setup_until?: string }>(`/api/admin/users/${userId}/tariff`, {
        method: 'PUT',
        body: JSON.stringify({ action: 'finish_setup' }),
      });
      onFinishSetupResult({ paid_until: res.paid_until ?? null, setup_until: res.setup_until ?? null });
      onSuccessMessage('Настройка завершена, клиент активирован');
    } catch (err: unknown) {
      onError(getErrorMessage(err));
    } finally {
      setActivating(false);
    }
  }, [userId, apiFetch, onFinishSetupResult, onSuccessMessage, onError]);

  // ── Бэкфилл seen-журнала B2B-поиска из старой CSV-выгрузки клиента ──
  const seenFileRef = useRef<HTMLInputElement | null>(null);
  const [importingSeen, setImportingSeen] = useState(false);

  const handleSeenImportFile = useCallback(async (file: File) => {
    setImportingSeen(true);
    try {
      const text = await file.text();
      const inns = parseInnColumn(text);
      if (inns.length === 0) {
        onError('В файле не найдено ни одного ИНН (нужен CSV выгрузки B2B-поиска)');
        return;
      }
      const dateRaw = window.prompt(
        `Найдено ИНН: ${inns.length}. Дата той выгрузки (ГГГГ-ММ-ДД), пусто = сегодня:`,
        '',
      );
      if (dateRaw === null) return; // отмена
      let exported_at: string | undefined;
      if (dateRaw.trim()) {
        const d = new Date(dateRaw.trim());
        if (Number.isNaN(d.getTime())) {
          onError('Некорректная дата — импорт отменён');
          return;
        }
        exported_at = d.toISOString();
      }
      const res = await apiFetch<{ total_inns: number; matched_companies: number; unmatched_inns: number }>(
        `/api/admin/users/${userId}/companies-seen/import`,
        {
          method: 'POST',
          body: JSON.stringify({ inns, ...(exported_at ? { exported_at } : {}) }),
        },
      );
      onSuccessMessage(
        `Выгрузка импортирована: помечено ${res.matched_companies} компаний (ИНН в файле: ${res.total_inns}, не найдено в базе: ${res.unmatched_inns})`,
      );
    } catch (err: unknown) {
      onError(getErrorMessage(err));
    } finally {
      setImportingSeen(false);
      if (seenFileRef.current) seenFileRef.current.value = '';
    }
  }, [userId, apiFetch, onSuccessMessage, onError]);

  const handleUnlockPayment = useCallback(async () => {
    setActivating(true);
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${userId}/tariff`, {
        method: 'PUT',
        body: JSON.stringify({ action: 'unlock_payment' }),
      });
      onUnlockPaymentSuccess();
      onSuccessMessage('Блокировка оплаты снята, клиент получил доступ');
    } catch (err: unknown) {
      onError(getErrorMessage(err));
    } finally {
      setActivating(false);
    }
  }, [userId, apiFetch, onUnlockPaymentSuccess, onSuccessMessage, onError]);

  const handleDeactivate = useCallback(async () => {
    setActivating(true);
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${userId}/tariff`, {
        method: 'PUT',
        body: JSON.stringify({ action: 'deactivate' }),
      });
      setShowExtendForm(false);
      onDeactivateSuccess();
      onSuccessMessage('Подписка деактивирована');
    } catch (err: unknown) {
      onError(getErrorMessage(err));
    } finally {
      setActivating(false);
    }
  }, [userId, apiFetch, onDeactivateSuccess, onSuccessMessage, onError]);

  const handleExtend = useCallback(async () => {
    if (tariffType === 'custom') {
      const n = Number(activateCustomAmount.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) {
        onError('Укажите сумму за период для тарифа Custom');
        return;
      }
    }
    setActivating(true);
    try {
      const bm = activateBillingMode === 'manual' ? null : activateBillingMode;
      const customAmt = tariffType === 'custom' ? Number(activateCustomAmount.replace(',', '.')) : undefined;
      const res = await apiFetch<{
        ok: true; paid_until?: string;
        billing_mode?: string; payment_locked?: boolean;
        billing_period?: string; billing_amount?: number; tariff_type?: string;
        invoice?: { invoice_id: string | null; payment_url: string | null; yookassa_error: string | null } | null;
      }>(`/api/admin/users/${userId}/tariff`, {
        method: 'PUT',
        body: JSON.stringify({
          action: 'extend',
          billing_mode: bm,
          tariff_type: tariffType,
          billing_period: activatePeriod,
          billing_amount: customAmt,
          is_test_shop: bm === 'autopayment' ? useTestShop : false,
        }),
      });
      onExtendResult({
        paid_until: res.paid_until ?? null,
        billing_mode: (res.billing_mode as 'invoice' | 'autopayment' | null) ?? null,
        payment_locked: res.payment_locked ?? false,
        billing_period: (res.billing_period as BillingPeriod | null) ?? null,
        billing_amount: res.billing_amount ?? null,
      });
      setShowExtendForm(false);
      onSuccessMessage(extendSuccessMessage(bm, res.invoice ?? null));
    } catch (err: unknown) {
      onError(getErrorMessage(err));
    } finally {
      setActivating(false);
    }
  }, [activateBillingMode, activatePeriod, activateCustomAmount, tariffType, userId, apiFetch, onExtendResult, onSuccessMessage, onError, useTestShop]);

  return (
    <div className="mt-4 pt-3 border-t border-gray-100">
      <div className="flex items-start justify-between gap-3">
        <span className="pt-1 text-xs font-medium text-gray-700">Подписка</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          {(subscriptionActive || subscriptionSetup) && billingMode && (
            <>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
                billingMode === 'invoice'
                  ? 'bg-blue-50 text-blue-700 ring-blue-200/60'
                  : 'bg-purple-50 text-purple-700 ring-purple-200/60'
              }`}>
                {billingMode === 'invoice' ? '🧾 Счёт' : '💳 Автоплатёж'}
              </span>
              {paymentLocked && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600 ring-1 ring-red-200/60">
                  🔒 Ожидает оплаты
                </span>
              )}
            </>
          )}
          {subscriptionSetup ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200/60">
              Настройка ЛК до {setupUntil ? new Date(setupUntil).toLocaleDateString('ru-RU') : '—'}
            </span>
          ) : subscriptionActive ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700 ring-1 ring-green-200/60">
              Активна до {paidUntil ? new Date(paidUntil).toLocaleDateString('ru-RU') : '—'}
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600 ring-1 ring-red-200/60">
              Не оплачена
            </span>
          )}
          {(subscriptionActive || subscriptionSetup) && billingPeriod && billingAmount != null && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-50 px-2 py-0.5 text-[11px] font-semibold text-zinc-700 ring-1 ring-zinc-200/60">
              {BILLING_PERIOD_LABELS[billingPeriod]} · {formatRub(billingAmount)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2.5 min-[520px]:grid-cols-2">
        {!subscriptionActive && !subscriptionSetup && (
          <>
            <div className="min-[520px]:col-span-2">
              <p className="mb-1.5 text-[11px] font-medium text-gray-700">Период оплаты</p>
              <div className="flex gap-1.5">
                {(['month', 'quarter', 'half_year', 'year'] as const).map((p) => {
                  const amt = calcTariffAmount(tariffType, p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => { setUseTestPeriod(false); setActivatePeriod(p); }}
                      className={`flex-1 px-2 py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                        !useTestPeriod && activatePeriod === p
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'border-gray-200 text-gray-700 hover:bg-gray-50 bg-white'
                      }`}
                    >
                      <div>{BILLING_PERIOD_LABELS[p]}</div>
                      <div className={`mt-0.5 text-[10px] tabular-nums ${!useTestPeriod && activatePeriod === p ? 'text-emerald-50' : 'text-gray-500'}`}>
                        {tariffType === 'custom' ? 'индивид.' : formatRub(amt)}
                      </div>
                    </button>
                  );
                })}
                {/* 4-я кнопка — QA test mode. Заменяет период в минутах
                    и требует ручную сумму. Используется для прогона
                    автоплатёж + cron-renewal цикла за минуты, без ожидания месяца. */}
                <button
                  type="button"
                  onClick={() => setUseTestPeriod(true)}
                  className={`flex-1 px-2 py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                    useTestPeriod
                      ? 'bg-yellow-500 text-white border-yellow-500'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50 bg-white'
                  }`}
                >
                  <div>🧪 Тест</div>
                  <div className={`mt-0.5 text-[10px] ${useTestPeriod ? 'text-yellow-50' : 'text-gray-500'}`}>QA</div>
                </button>
              </div>
              {useTestPeriod && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-gray-700 mb-1">Длительность (минут)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={testMinutes}
                      onChange={(e) => setTestMinutes(e.target.value)}
                      placeholder="10"
                      className="w-full px-2.5 py-1.5 text-xs border border-yellow-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-700 mb-1">Сумма (₽)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={activateCustomAmount}
                      onChange={(e) => setActivateCustomAmount(e.target.value)}
                      placeholder="10"
                      className="w-full px-2.5 py-1.5 text-xs border border-yellow-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"
                    />
                  </div>
                </div>
              )}
              {!useTestPeriod && tariffType === 'custom' && (
                <div className="mt-2">
                  <label className="block text-[11px] font-medium text-gray-700 mb-1">Сумма за период (₽)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={activateCustomAmount}
                    onChange={(e) => setActivateCustomAmount(e.target.value)}
                    placeholder="Например: 100000"
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
            </div>
            <div className="flex gap-1.5 min-[520px]:col-span-2">
              {(['manual', 'invoice', 'autopayment'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setActivateBillingMode(m)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                    activateBillingMode === m
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {m === 'manual' ? 'Вручную' : m === 'invoice' ? '🧾 Счёт' : '💳 Автоплатёж'}
                </button>
              ))}
            </div>
            {activateBillingMode === 'autopayment' && (
              <div className="min-[520px]:col-span-2">
                <p className="mb-1.5 text-[11px] font-medium text-gray-700">Магазин YooKassa</p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setUseTestShop(false)}
                    className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                      !useTestShop
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                    }`}
                  >
                    Боевой
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseTestShop(true)}
                    className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                      useTestShop
                        ? 'bg-yellow-500 text-white border-yellow-500'
                        : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                    }`}
                  >
                    🧪 Тестовый
                  </button>
                </div>
                {useTestShop && !useTestPeriod && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1">
                    Тарифы тест-магазина: <strong>10/15/20 ₽</strong> (Стандарт) и <strong>11/16/21 ₽</strong> (Про).
                    Период действия: <strong>10/15/20 мин</strong> вместо 1/6/12 мес.
                    Setup-trial: <strong>5 мин</strong> вместо 15 дней.
                  </p>
                )}
              </div>
            )}
            <button
              type="button"
              disabled={activating}
              onClick={() => void handleActivate()}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:col-span-2"
            >
              {activating ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>Активация...</span></>
              ) : (
                <><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /><span>Активировать</span></>
              )}
            </button>
          </>
        )}
        {subscriptionSetup && (
          <button
            type="button"
            disabled={activating}
            onClick={() => void handleFinishSetup()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-center text-xs font-semibold leading-snug text-blue-700 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 min-[520px]:col-span-2"
          >
            {activating ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>Завершение...</span></>
            ) : (
              <><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /><span>Завершить настройку досрочно</span></>
            )}
          </button>
        )}
        <input
          ref={seenFileRef}
          type="file"
          accept=".csv,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleSeenImportFile(f);
          }}
        />
        <button
          type="button"
          disabled={importingSeen}
          onClick={() => seenFileRef.current?.click()}
          title="Бэкфилл журнала выгрузок B2B-поиска: загрузите старую CSV-выгрузку клиента — компании из неё пометятся «уже выгружены» и не попадут в повторные выгрузки"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-600 shadow-sm transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {importingSeen ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>Импорт…</span></>
          ) : (
            <><FileUp className="h-3.5 w-3.5 shrink-0" /><span>Импорт выгрузок B2B (CSV)</span></>
          )}
        </button>
        {(subscriptionActive || subscriptionSetup) && paymentLocked && (
          <button
            type="button"
            disabled={activating}
            onClick={() => void handleUnlockPayment()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 shadow-sm transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Unlock className="h-3.5 w-3.5 shrink-0" />
            <span>Снять блокировку</span>
          </button>
        )}
        {subscriptionActive && !showExtendForm && (
          <button
            type="button"
            disabled={activating}
            onClick={() => {
              setActivatePeriod('month');
              setActivateCustomAmount('');
              setUseTestShop(defaultIsTestShop);
              setShowExtendForm(true);
            }}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>Продлить подписку</span>
          </button>
        )}
        {(subscriptionActive || subscriptionSetup) && (
          <button
            type="button"
            disabled={activating}
            onClick={() => void handleDeactivate()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Power className="h-3.5 w-3.5 shrink-0" />
            <span>Деактивировать</span>
          </button>
        )}
      </div>

      {subscriptionActive && showExtendForm && (
        <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-indigo-900">Продление подписки</p>
            <button
              type="button"
              onClick={() => setShowExtendForm(false)}
              className="text-[11px] text-gray-500 hover:text-gray-700"
            >
              Отмена
            </button>
          </div>
          <p className="mb-2 text-[11px] text-indigo-700">
            Выберите тариф наверху и период ниже. Срок прибавится к текущему «{paidUntil ? new Date(paidUntil).toLocaleDateString('ru-RU') : '—'}».
          </p>
          <div className="flex gap-1.5">
            {(['month', 'half_year', 'year'] as const).map((p) => {
              const amt = calcTariffAmount(tariffType, p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setActivatePeriod(p)}
                  className={`flex-1 px-2 py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                    activatePeriod === p
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-indigo-200 text-gray-700 bg-white hover:bg-indigo-50'
                  }`}
                >
                  <div>{BILLING_PERIOD_LABELS[p]}</div>
                  <div className={`mt-0.5 text-[10px] tabular-nums ${activatePeriod === p ? 'text-indigo-50' : 'text-gray-500'}`}>
                    {tariffType === 'custom' ? 'индивид.' : formatRub(amt)}
                  </div>
                </button>
              );
            })}
          </div>
          {tariffType === 'custom' && (
            <div className="mt-2">
              <label className="block text-[11px] font-medium text-gray-700 mb-1">Сумма за период (₽)</label>
              <input
                type="text"
                inputMode="decimal"
                value={activateCustomAmount}
                onChange={(e) => setActivateCustomAmount(e.target.value)}
                placeholder="Например: 100000"
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            {(['manual', 'invoice', 'autopayment'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setActivateBillingMode(m)}
                className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                  activateBillingMode === m
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                }`}
              >
                {m === 'manual' ? 'Вручную' : m === 'invoice' ? '🧾 Счёт' : '💳 Автоплатёж'}
              </button>
            ))}
          </div>
          {activateBillingMode === 'autopayment' && (
            <div className="mt-2">
              <p className="mb-1.5 text-[11px] font-medium text-gray-700">Магазин YooKassa</p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setUseTestShop(false)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                    !useTestShop
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                  }`}
                >
                  Боевой
                </button>
                <button
                  type="button"
                  onClick={() => setUseTestShop(true)}
                  className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                    useTestShop
                      ? 'bg-yellow-500 text-white border-yellow-500'
                      : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                  }`}
                >
                  🧪 Тестовый
                </button>
              </div>
              {useTestShop && (
                <p className="mt-1.5 text-[10px] leading-relaxed text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1">
                  Тарифы тест-магазина: <strong>10/15/20 ₽</strong> (Стандарт) и <strong>11/16/21 ₽</strong> (Про).
                  Период действия: <strong>10/15/20 мин</strong> вместо 1/6/12 мес.
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            disabled={activating}
            onClick={() => void handleExtend()}
            className="mt-2 w-full inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-indigo-300 bg-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activating ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /><span>Продление...</span></>
            ) : (
              <><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /><span>Подтвердить продление</span></>
            )}
          </button>
        </div>
      )}
    </div>
  );
});

function UserAvatar({ user, signedUrl }: { user: UserProfile; signedUrl?: string | null }) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const publicUrl = normalizePublicAvatarUrl(user.avatar_url);
  const avatarUrl = (signedUrl && !failedUrls.has(signedUrl)) ? signedUrl
    : (publicUrl && !failedUrls.has(publicUrl)) ? publicUrl
    : null;
  const initial = (user.full_name || user.email || '?').charAt(0).toUpperCase();

  return (
    <div className="h-10 w-10 rounded-full flex items-center justify-center overflow-hidden bg-blue-600 flex-shrink-0">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={avatarUrl}
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setFailedUrls((prev) => new Set(prev).add(avatarUrl))}
        />
      ) : (
        <span className="text-white font-medium">{initial}</span>
      )}
    </div>
  );
}

export default function UsersPage() {
  const isTma = useIsTma();
  const { userId: currentUserId, userRole: currentUserRole } = useUser();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Вкладка-фильтр по типу профиля. 'client' — только клиенты (их трудно
  // выцепить из общей массы сотрудников), 'staff' — все внутренние роли.
  const [roleFilter, setRoleFilter] = useState<'all' | 'client' | 'staff'>('all');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'technician' as UserRole, full_name: '' });
  
  const [saving, setSaving] = useState(false);
  
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);

  const [actionModalUserId, setActionModalUserId] = useState<string | null>(null);
  const [actionModalOrigin, setActionModalOrigin] = useState<{ x: number; y: number } | null>(null);
  const [actionModalLoadingUserId, setActionModalLoadingUserId] = useState<string | null>(null);
  const [modalFlyIn, setModalFlyIn] = useState(false);
  const [modalRole, setModalRole] = useState<UserRole | null>(null);
  const [toolVisibility, setToolVisibility] = useState<Record<string, boolean>>({});
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);

  const [clientCampaigns, setClientCampaigns] = useState<string[]>([]);
  const [clientCampaignBaseline, setClientCampaignBaseline] = useState<string[]>([]);
  const [clientAccessLoaded, setClientAccessLoaded] = useState(false);
  const [allCampaigns, setAllCampaigns] = useState<{ id: string; name: string; status: number }[]>([]);
  const [allCampaignsLoading, setAllCampaignsLoading] = useState(false);
  const [campaignSearch, setCampaignSearch] = useState('');
  // Что реально применено к фильтру. Обновляется только при сабмите формы
  // поиска (клик по «Найти» или Enter в инпуте), не на каждое нажатие — иначе
  // re-фильтр ~200 кампаний на каждом keystroke лагает (плюс юзер сам этого
  // попросил: ввёл → нажал → увидел результаты).
  const [appliedCampaignSearch, setAppliedCampaignSearch] = useState('');
  // Текущая страница в пагинации кампаний. Сбрасывается на 1 при открытии
  // модалки и при сабмите нового поискового запроса.
  const [campaignPage, setCampaignPage] = useState(1);

  const [tariffType, setTariffType] = useState<TariffType>('standard');
  // Персистентный флаг "клиент в тест-магазине". Меняется отдельным блоком
  // «Магазин ЮКасса клиента» рядом с тарифом; сохраняется через PUT /tariff
  // вместе с тарифом по «Сохранить изменения». Префиллит локальный toggle в
  // SubscriptionPanel, чтобы активация/продление по умолчанию шли в нужный
  // магазин.
  const [clientIsTestShop, setClientIsTestShop] = useState(false);
  const [customLimits, setCustomLimits] = useState<Omit<TariffData, 'tariff_type'>>({ ...TARIFF_DEFAULTS.pro });
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [subscriptionSetup, setSubscriptionSetup] = useState(false);
  const [paidUntil, setPaidUntil] = useState<string | null>(null);
  const [setupUntil, setSetupUntil] = useState<string | null>(null);
  const [billingMode, setBillingMode] = useState<'invoice' | 'autopayment' | null>(null);
  const [paymentLocked, setPaymentLocked] = useState(false);
  // activateBillingMode / activatePeriod / activateCustomAmount / showExtendForm
  // / activating moved into <SubscriptionPanel>'s own state — typing in the
  // amount field or toggling the period chips no longer re-renders the parent.
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod | null>(null);
  const [billingAmount, setBillingAmount] = useState<number | null>(null);

  type SortColumn = 'name' | 'email' | 'role';
  type SortDir = 'asc' | 'desc';
  const [sortBy, setSortBy] = useState<SortColumn>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const [avatarSignedUrls, setAvatarSignedUrls] = useState<Record<string, string>>({});

  const fetchUsers = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*');

      if (error) throw error;
      setUsers((data as UserProfile[]) || []);
    } catch (err: unknown) {
      void logError('admin.users.fetch.failed', err);
      setError(getErrorMessage(err) || 'Ошибка загрузки пользователей');
    }
  }, []);

  const checkAccess = useCallback(async () => {
    try {
      if (!isAdmin(currentUserRole)) {
        setError('Доступ запрещен. Только администраторы могут управлять пользователями.');
        setLoading(false);
        return;
      }

      await fetchUsers();
      setLoading(false);
    } catch (err: unknown) {
      void logError('admin.users.access.check.failed', err);
      setError(getErrorMessage(err));
      setLoading(false);
    }
  }, [currentUserRole, fetchUsers]);

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getAccessToken();
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
  }, [getAccessToken]);

  async function handleResetPassword() {
    if (!resettingUserId) return;
    const pw = newPassword.trim();
    if (pw.length < 8) {
      setError('Пароль должен быть минимум 8 символов');
      return;
    }
    if (pw.length > 72) {
      setError('Пароль слишком длинный (максимум 72 символа)');
      return;
    }

    setResetting(true);
    setError('');
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${resettingUserId}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      });
      void logAudit('admin.users.password.update.success', 'User password updated (client)', {
        targetUserId: resettingUserId,
      });
      setResettingUserId(null);
      setNewPassword('');
      setRevealPassword(false);
    } catch (err: unknown) {
      void logError('admin.users.password.update.failed', err, { targetUserId: resettingUserId });
      setError(getErrorMessage(err) || 'Ошибка обновления пароля');
    } finally {
      setResetting(false);
    }
  }

  function generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const len = 14;
    let out = '';
    for (let i = 0; i < len; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? '';
    }
    setNewPassword(out);
    setRevealPassword(true);
  }

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  useEffect(() => {
    if (!actionModalUserId) {
      setActionModalOrigin(null);
      setSaveSuccessMessage(null);
    }
  }, [actionModalUserId]);

  useEffect(() => {
    if (!saveSuccessMessage) return;
    const t = setTimeout(() => setSaveSuccessMessage(null), 3500);
    return () => clearTimeout(t);
  }, [saveSuccessMessage]);

  const fetchAllCampaigns = useCallback(async () => {
    if (allCampaigns.length > 0) return;
    setAllCampaignsLoading(true);
    try {
      const res = await apiFetch<{ campaigns: { id: string; name: string; status?: number }[] }>(
        '/api/tools/auto-report/campaigns'
      );
      setAllCampaigns((res.campaigns ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status ?? 0 })));
    } catch {
      setAllCampaigns([]);
    } finally {
      setAllCampaignsLoading(false);
    }
  }, [apiFetch, allCampaigns.length]);

  useEffect(() => {
    if (modalRole === 'client') void fetchAllCampaigns();
  }, [modalRole, fetchAllCampaigns]);

  // Применяем введённый запрос к фильтру: по клику «Найти» или Enter в инпуте.
  // Параллельно сбрасываем страницу на 1, потому что после нового запроса
  // текущая может оказаться вне диапазона.
  const applyCampaignSearch = useCallback(() => {
    setAppliedCampaignSearch(campaignSearch.trim());
    setCampaignPage(1);
  }, [campaignSearch]);

  // O(1) lookup set for "is this campaign selected" checks. Used to be a linear
  // .includes() called twice per row (×N rows × every render of the modal),
  // which is what made every keystroke or checkbox toggle feel laggy.
  const selectedCampaignSet = useMemo(() => new Set(clientCampaigns), [clientCampaigns]);
  const clientCampaignsDirty = useMemo(
    () => clientAccessLoaded && !haveSameIds(clientCampaigns, clientCampaignBaseline),
    [clientAccessLoaded, clientCampaigns, clientCampaignBaseline],
  );

  // Sort-then-filter pipeline memoised against the three inputs it actually
  // depends on. Without this it ran inside a JSX IIFE — recomputing on every
  // single state change in the modal, including unrelated fields (tariff,
  // limits, role chips). That's why typing in *any* input felt sluggish.
  const visibleCampaigns = useMemo(() => {
    const q = appliedCampaignSearch.toLowerCase();
    const selected: typeof allCampaigns = [];
    const unselected: typeof allCampaigns = [];
    for (const c of allCampaigns) {
      if (selectedCampaignSet.has(c.id)) selected.push(c);
      else unselected.push(c);
    }
    const merged = selected.concat(unselected);
    if (!q) return merged;
    return merged.filter((c) => c.name.toLowerCase().includes(q));
  }, [allCampaigns, selectedCampaignSet, appliedCampaignSearch]);

  // Клиентская пагинация: режем visibleCampaigns на страницы по
  // CAMPAIGNS_PER_PAGE. effectivePage клампится в [1, pageCount] на случай,
  // если поиск ужал результаты до меньшего числа страниц, чем текущая
  // (например, юзер на странице 5, ввёл запрос → осталось 12 кампаний → 2
  // страницы → показываем 2-ю вместо пустой 5-й).
  const { pagedCampaigns, pageCount, effectivePage } = useMemo(() => {
    const total = visibleCampaigns.length;
    const pages = Math.max(1, Math.ceil(total / CAMPAIGNS_PER_PAGE));
    const page = Math.min(Math.max(1, campaignPage), pages);
    const start = (page - 1) * CAMPAIGNS_PER_PAGE;
    return {
      pagedCampaigns: visibleCampaigns.slice(start, start + CAMPAIGNS_PER_PAGE),
      pageCount: pages,
      effectivePage: page,
    };
  }, [visibleCampaigns, campaignPage]);

  // Wrapped in useCallback so its identity is stable across re-renders — the
  // memoised <UserRow> below receives it as a prop and would otherwise be
  // re-rendered for every keystroke / chip toggle in the action modal. All
  // setters are stable; apiFetch / fetchAllCampaigns are themselves useCallback.
  const openActionModal = useCallback(async (user: UserProfile, origin: { x: number; y: number }) => {
    setActionModalLoadingUserId(user.id);
    setError('');
    setCampaignSearch('');
    setAppliedCampaignSearch('');
    setCampaignPage(1);
    setClientCampaigns([]);
    setClientCampaignBaseline([]);
    setClientAccessLoaded(false);
    try {
      const isClient = user.role === 'client';
      // Per-call catch so one failing endpoint does not blow away state derived
      // from the others. Without this, a 500 on /client-access would reset the
      // already-loaded tariff/subscription back to "Не оплачена" defaults via
      // the outer catch, even though the tariff fetch itself succeeded.
      const [toolsRes, accessRes, tariffRes] = await Promise.all([
        apiFetch<{ visibility: Record<string, boolean> }>(
          `/api/admin/users/${user.id}/tools`
        ).catch((err) => {
          void logError('admin.users.modal.tools.fetch.failed', err, { targetUserId: user.id });
          return { visibility: {} as Record<string, boolean> };
        }),
        isClient
          ? apiFetch<{ rows: Array<{ resource_type: string; resource_id: string }> }>(
              `/api/admin/users/${user.id}/client-access`
            ).then((result) => ({ ...result, loaded: true as const })).catch((err) => {
              void logError('admin.users.modal.client-access.fetch.failed', err, { targetUserId: user.id });
              return {
                rows: [] as Array<{ resource_type: string; resource_id: string }>,
                loaded: false as const,
              };
            })
          : Promise.resolve({
              rows: [] as Array<{ resource_type: string; resource_id: string }>,
              loaded: false as const,
            }),
        isClient
          ? apiFetch<{ tariff: AdminUserTariffPayload | null }>(`/api/admin/users/${user.id}/tariff`).catch((err) => {
              void logError('admin.users.modal.tariff.fetch.failed', err, { targetUserId: user.id });
              return { tariff: null as AdminUserTariffPayload | null };
            })
          : Promise.resolve({ tariff: null as AdminUserTariffPayload | null }),
      ]);
      setToolVisibility(toolsRes.visibility ?? {});
      const campaigns = accessRes.rows.filter((r) => r.resource_type === 'campaign').map((r) => r.resource_id);
      setClientCampaigns(campaigns);
      setClientCampaignBaseline(campaigns);
      setClientAccessLoaded(accessRes.loaded);
      if (tariffRes.tariff) {
        setTariffType(tariffRes.tariff.tariff_type);
        setClientIsTestShop(tariffRes.tariff.is_test_shop === true);
        setCustomLimits({
          max_contacts: tariffRes.tariff.max_contacts ?? TARIFF_DEFAULTS.pro.max_contacts,
          max_rows: tariffRes.tariff.max_rows ?? TARIFF_DEFAULTS.pro.max_rows,
          max_chains_per_month: tariffRes.tariff.max_chains_per_month ?? TARIFF_DEFAULTS.pro.max_chains_per_month,
          max_domains: tariffRes.tariff.max_domains ?? TARIFF_DEFAULTS.pro.max_domains,
          max_emails: tariffRes.tariff.max_emails ?? TARIFF_DEFAULTS.pro.max_emails,
        });
        const now = new Date();
        const isActive = tariffRes.tariff.is_active === true;
        // Mirrors getClientStatus() in lib/tariffs.ts: only "expired" when paid_until is set AND in the past.
        // A null paid_until during invoice/autopayment setup is NOT expired.
        const isExpired = isActive
          && !!tariffRes.tariff.paid_until
          && new Date(tariffRes.tariff.paid_until) <= now;
        const inSetup = isActive && !isExpired
          && !!tariffRes.tariff.setup_until && new Date(tariffRes.tariff.setup_until) > now;
        const isAct = isActive && !isExpired && !inSetup;
        setSubscriptionActive(isAct);
        setSubscriptionSetup(inSetup);
        setPaidUntil(tariffRes.tariff.paid_until ?? null);
        setSetupUntil(tariffRes.tariff.setup_until ?? null);
        setBillingMode((tariffRes.tariff.billing_mode as 'invoice' | 'autopayment' | null) ?? null);
        setPaymentLocked(tariffRes.tariff.payment_locked ?? false);
        setBillingPeriod((tariffRes.tariff.billing_period as BillingPeriod | null) ?? null);
        setBillingAmount(tariffRes.tariff.billing_amount ?? null);
      } else {
        setTariffType('standard');
        setClientIsTestShop(false);
        setCustomLimits({ ...TARIFF_DEFAULTS.pro });
        setSubscriptionActive(false);
        setSubscriptionSetup(false);
        setPaidUntil(null);
        setSetupUntil(null);
        setBillingMode(null);
        setPaymentLocked(false);
        setBillingPeriod(null);
        setBillingAmount(null);
      }
      // SubscriptionPanel's local state (activate*, showExtendForm, activating)
      // resets automatically — we pass key={user.id} below so it remounts on
      // user switch with its initial defaults ('month' / '' / 'manual' / etc).
      setModalRole(user.role ?? null);
      setActionModalOrigin(origin);
      setActionModalUserId(user.id);
      setModalFlyIn(false);
      setActionModalLoadingUserId(null);
      setTimeout(() => setModalFlyIn(true), 20);
      if (isClient) void fetchAllCampaigns();
    } catch {
      setToolVisibility({});
      setClientCampaigns([]);
      setClientCampaignBaseline([]);
      setClientAccessLoaded(false);
      setTariffType('standard');
      setClientIsTestShop(false);
      setCustomLimits({ ...TARIFF_DEFAULTS.pro });
      setSubscriptionActive(false);
      setSubscriptionSetup(false);
      setPaidUntil(null);
      setBillingMode(null);
      setPaymentLocked(false);
      setSetupUntil(null);
      setBillingPeriod(null);
      setBillingAmount(null);
      setModalRole(user.role ?? null);
      setActionModalOrigin(origin);
      setActionModalUserId(user.id);
      setModalFlyIn(false);
      setActionModalLoadingUserId(null);
      setTimeout(() => setModalFlyIn(true), 20);
    }
  }, [apiFetch, fetchAllCampaigns]);

  // Callbacks SubscriptionPanel uses to push results back to the parent. All
  // wrapped in useCallback so the child's memo doesn't re-render when other
  // parent state changes (typing in fields handled outside the subscription
  // section — campaigns picker, tool toggles, etc.).
  const handleActivateResult = useCallback((res: {
    paid_until?: string | null; setup_until?: string | null;
    billing_mode?: 'invoice' | 'autopayment' | null; payment_locked?: boolean;
    billing_period?: BillingPeriod | null; billing_amount?: number | null;
  }) => {
    setSubscriptionSetup(true);
    setSubscriptionActive(false);
    setPaidUntil(res.paid_until ?? null);
    setSetupUntil(res.setup_until ?? null);
    setBillingMode(res.billing_mode ?? null);
    setPaymentLocked(res.payment_locked ?? false);
    setBillingPeriod(res.billing_period ?? null);
    setBillingAmount(res.billing_amount ?? null);
  }, []);

  const handleExtendResult = useCallback((res: {
    paid_until?: string | null;
    billing_mode?: 'invoice' | 'autopayment' | null; payment_locked?: boolean;
    billing_period?: BillingPeriod | null; billing_amount?: number | null;
  }) => {
    setPaidUntil(res.paid_until ?? null);
    setBillingMode(res.billing_mode ?? null);
    setPaymentLocked(res.payment_locked ?? false);
    setBillingPeriod(res.billing_period ?? null);
    setBillingAmount(res.billing_amount ?? null);
  }, []);

  const handleFinishSetupResult = useCallback((res: { paid_until?: string | null; setup_until?: string | null }) => {
    setSubscriptionSetup(false);
    setSubscriptionActive(true);
    setPaidUntil(res.paid_until ?? null);
    setSetupUntil(res.setup_until ?? null);
  }, []);

  const handleUnlockPaymentSuccess = useCallback(() => {
    setPaymentLocked(false);
  }, []);

  const handleDeactivateSuccess = useCallback(() => {
    setSubscriptionActive(false);
    setSubscriptionSetup(false);
    setBillingMode(null);
    setPaymentLocked(false);
    setBillingPeriod(null);
    setBillingAmount(null);
  }, []);

  const handlePanelError = useCallback((msg: string) => setError(msg), []);
  const handlePanelSuccess = useCallback((msg: string) => setSaveSuccessMessage(msg), []);

  useEffect(() => {
    if (users.length === 0) return;
    const idsWithAvatar = users
      .filter((u) => typeof u.avatar_url === 'string' && u.avatar_url.trim().length > 0)
      .map((u) => u.id);
    if (idsWithAvatar.length === 0) return;

    let cancelled = false;

    const fetchAvatars = async () => {
      try {
        const token = await getAccessToken();
        if (!token || cancelled) return;
        const res = await fetch('/api/admin/avatars/signed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ userIds: idsWithAvatar }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { urls?: Record<string, string> };
        if (cancelled || !data.urls || typeof data.urls !== 'object') return;
        setAvatarSignedUrls(data.urls);
      } catch {
        // ignore: fallback to public URL or initial
      }
    };

    void fetchAvatars();
    const interval = setInterval(() => void fetchAvatars(), 30 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchAvatars();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [users, getAccessToken]);

  async function handleCreateUser() {
    if (!newUser.email || !newUser.password || !newUser.role) {
      setError('Заполните все обязательные поля');
      return;
    }
    if (newUser.password.trim().length < 8) {
      setError('Пароль должен быть минимум 8 символов');
      return;
    }
    if (newUser.password.trim().length > 72) {
      setError('Пароль слишком длинный (максимум 72 символа)');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const fullName = newUser.full_name || newUser.email.split('@')[0];
      const result = await apiFetch<{ ok: true; user: { id: string } }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newUser.email,
          password: newUser.password,
          role: newUser.role,
          full_name: fullName,
        }),
      });

      setShowCreateModal(false);
      setNewUser({ email: '', password: '', role: 'technician', full_name: '' });
      setSearchQuery(''); // Reset search when user is created
      void logAudit('admin.users.create.success', 'User created', {
        targetUserId: result.user.id,
        role: newUser.role,
      });
      await fetchUsers();
    } catch (err: unknown) {
      void logError('admin.users.create.failed', err, { role: newUser.role });
      const message = getErrorMessage(err);
      const lower = message.toLowerCase();
      if (lower.includes('already registered')) {
        setError('Пользователь с таким email уже существует');
      } else if (lower.includes('already') || lower.includes('уже существует')) {
        setError('Пользователь с таким email уже существует');
      } else {
        setError(message || 'Ошибка создания пользователя');
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveAllChanges() {
    if (!actionModalUserId || !modalRole) return;
    setSaving(true);
    setError('');
    setSaveSuccessMessage(null);
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/role`, {
        method: 'POST',
        body: JSON.stringify({ role: modalRole }),
      });
      setUsers(users.map(u => (u.id === actionModalUserId ? { ...u, role: modalRole } : u)));
      void logAudit('admin.users.role.updated', 'User role updated', {
        targetUserId: actionModalUserId,
        role: modalRole,
      });

      await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/tools`, {
        method: 'POST',
        body: JSON.stringify({ visibility: toolVisibility }),
      });

      if (modalRole === 'client') {
        if (clientAccessLoaded && clientCampaignsDirty) {
          await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/client-access`, {
            method: 'PUT',
            body: JSON.stringify({
              campaigns: clientCampaigns,
              baselineCampaigns: clientCampaignBaseline,
            }),
          });
          setClientCampaignBaseline([...clientCampaigns]);
        }
        await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/tariff`, {
          method: 'PUT',
          body: JSON.stringify({
            tariff_type: tariffType,
            is_test_shop: clientIsTestShop,
            ...(tariffType === 'custom' ? customLimits : {}),
          }),
        });
      }

      setSaveSuccessMessage('Изменения сохранены');
    } catch (err: unknown) {
      void logError('admin.users.save.all.failed', err, { targetUserId: actionModalUserId });
      setError(getErrorMessage(err) || 'Ошибка сохранения изменений');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteUser(userId: string) {
    // Prevent deleting yourself
    if (userId === currentUserId) {
      setError('Вы не можете удалить самого себя');
      setDeletingUserId(null);
      return;
    }

    setDeleting(true);
    setError('');
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${userId}`, { method: 'DELETE' });
      setUsers(users.filter(u => u.id !== userId));
      setDeletingUserId(null);
      void logAudit('admin.users.delete.success', 'User deleted', { targetUserId: userId });
    } catch (err: unknown) {
      void logError('admin.users.delete.failed', err, { targetUserId: userId });
      setError(getErrorMessage(err) || 'Ошибка удаления пользователя');
    } finally {
      setDeleting(false);
    }
  }

  // Memoised so that sortedUsers below sees a stable filteredUsers reference
  // when nothing about (users, searchQuery) actually changed. Without this
  // wrap, every parent re-render — including those triggered by typing in
  // the action modal — produced a new array, defeating sortedUsers' useMemo
  // and re-rendering the entire users table.
  const filteredUsers = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return users.filter((user) => {
      if (roleFilter === 'client' && user.role !== 'client') return false;
      if (roleFilter === 'staff' && user.role === 'client') return false;
      return (
        user.email?.toLowerCase().includes(q) ||
        user.full_name?.toLowerCase().includes(q) ||
        (user.role && ROLE_LABELS[user.role]?.toLowerCase().includes(q))
      );
    });
  }, [users, searchQuery, roleFilter]);

  // Счётчики для вкладок — по всей базе, независимо от поиска и активной
  // вкладки. Каждый пользователь либо клиент, либо нет, так что всего =
  // clientCount + staffCount.
  const clientCount = useMemo(() => users.filter((u) => u.role === 'client').length, [users]);
  const staffCount = users.length - clientCount;

  const sortedUsers = useMemo(() => {
    const list = [...filteredUsers];
    const cmp = (a: UserProfile, b: UserProfile): number => {
      const av = sortBy === 'name' ? (a.full_name || a.email || '').toLowerCase() : sortBy === 'email' ? (a.email || '').toLowerCase() : (a.role ? ROLE_LABELS[a.role] : '');
      const bv = sortBy === 'name' ? (b.full_name || b.email || '').toLowerCase() : sortBy === 'email' ? (b.email || '').toLowerCase() : (b.role ? ROLE_LABELS[b.role] : '');
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    };
    list.sort((a, b) => (sortDir === 'asc' ? 1 : -1) * cmp(a, b));
    return list;
  }, [filteredUsers, sortBy, sortDir]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  if (!isAdmin(currentUserRole)) {
    return (
      <div className={`max-w-4xl mx-auto ${isTma ? 'py-6 px-4 text-sm leading-relaxed' : 'py-10'}`}>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center">
          <div>
            <h2 className="text-lg font-semibold text-red-800">Доступ запрещен</h2>
            <p className="text-red-600">Только администраторы могут управлять пользователями.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 sm:mb-8">
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900`}>Управление пользователями</h1>
          <p className="mt-1 text-sm text-gray-500">Создание и управление ролями пользователей</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center text-red-700">
          {error}
          <button onClick={() => setError('')} className="ml-auto">
            ✕
          </button>
        </div>
      )}

      <div className="mb-4 inline-flex w-full gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-gray-50 p-1 sm:w-fit">
        {([
          { key: 'all' as const, label: 'Все', count: users.length },
          { key: 'client' as const, label: 'Клиенты', count: clientCount },
          { key: 'staff' as const, label: 'Сотрудники', count: staffCount },
        ]).map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setRoleFilter(key)}
            className={`inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition-colors sm:flex-none ${
              roleFilter === key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
            <span
              className={`inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                roleFilter === key ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Поиск по email, имени или роли..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            className="h-8 w-full rounded-lg border border-gray-300 px-4 py-0 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={() => {
            setSearchQuery(''); // Clear search when opening modal
            setShowCreateModal(true);
          }}
          className={`inline-flex h-8 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/25 transition-all hover:-translate-y-0.5 hover:from-blue-500 hover:to-indigo-500 hover:shadow-md hover:shadow-blue-600/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 active:translate-y-0 ${isTma ? 'w-full sm:w-auto' : ''}`}
        >
          <Plus className="h-4 w-4" />
          Добавить пользователя
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            Пользователи ({filteredUsers.length})
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {([
                  { key: 'name' as SortColumn, label: 'Пользователь' },
                  { key: 'email' as SortColumn, label: 'Email' },
                  { key: 'role' as SortColumn, label: 'Роль' },
                ]).map(({ key, label }) => (
                  <th
                    key={key}
                    className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (sortBy === key) {
                          setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                        } else {
                          setSortBy(key);
                          setSortDir('asc');
                        }
                      }}
                      className="inline-flex items-center justify-center gap-1 hover:text-gray-700 focus:outline-none rounded mx-auto"
                    >
                      {label}
                      {sortBy === key && (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)}
                    </button>
                  </th>
                ))}
                <th className="px-6 py-3 w-12" aria-label="Действия" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedUsers.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  signedUrl={avatarSignedUrls[user.id]}
                  actionLoading={actionModalLoadingUserId === user.id}
                  onOpenAction={openActionModal}
                />
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                    {searchQuery ? 'Пользователи не найдены' : 'Нет пользователей'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-7 py-5 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Новый пользователь</h3>
              <button
                onClick={() => { 
                  setShowCreateModal(false); 
                  setError(''); 
                  setSearchQuery(''); 
                }}
                className="size-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>
            <div className="p-7 space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Имя
                </label>
                <input
                  type="text"
                  value={newUser.full_name}
                  onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Иван Иванов"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="user@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Пароль <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Минимум 8 символов"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Роль <span className="text-red-500">*</span>
                </label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {ALL_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="px-7 py-5 border-t border-gray-200 flex justify-center">
              <button
                onClick={handleCreateUser}
                disabled={creating}
                className="inline-flex min-w-[140px] items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/25 transition-all hover:-translate-y-0.5 hover:from-blue-500 hover:to-indigo-500 hover:shadow-md hover:shadow-blue-600/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? 'Создание...' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {actionModalUserId && actionModalOrigin && (() => {
        const userForModal = users.find((u) => u.id === actionModalUserId);
        if (!userForModal) return null;
        const origin = actionModalOrigin;
        return (
          <div
            className="fixed inset-0 z-50 p-4 flex items-center justify-center"
            style={{
              backgroundColor: modalFlyIn ? 'rgba(0,0,0,0.2)' : 'transparent',
              backdropFilter: modalFlyIn ? 'blur(4px)' : 'none',
              transition: 'background-color 1s ease-out, backdrop-filter 1s ease-out',
            }}
          >
            <div
              className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
              style={{
                position: 'fixed',
                left: modalFlyIn ? '50%' : `${origin.x}px`,
                top: modalFlyIn ? '50%' : `${origin.y}px`,
                transform: `translate(-50%, -50%) scale(${modalFlyIn ? 1 : 0})`,
                transformOrigin: 'center center',
                opacity: modalFlyIn ? 1 : 0.95,
                transition: 'left 1s cubic-bezier(0.34, 1.56, 0.64, 1), top 1s cubic-bezier(0.34, 1.56, 0.64, 1), transform 1s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 1s ease-out',
              }}
            >
              <div className="px-7 py-5 border-b border-gray-200 shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {userForModal.full_name || userForModal.email || 'Пользователь'}
                  </h3>
                  <button
                  type="button"
                  onClick={() => {
                    setActionModalUserId(null);
                    setModalFlyIn(false);
                  }}
                  className="size-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                  aria-label="Закрыть"
                >
                  ✕
                </button>
                </div>
                {saveSuccessMessage && (
                  <div
                    className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 border border-green-200"
                    role="status"
                  >
                    <span className="shrink-0 size-5 rounded-full bg-green-500 flex items-center justify-center text-white" aria-hidden>
                      <Check className="size-3 stroke-[3]" />
                    </span>
                    {saveSuccessMessage}
                  </div>
                )}
              </div>
              <div className="p-7 overflow-y-auto space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Роль</label>
                  <select
                    value={modalRole ?? ''}
                    onChange={(e) => setModalRole(e.target.value as UserRole)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {ALL_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-5">
                  {/* Раскрывающийся блок «Отображение инструментов»: раньше
                      был всегда открыт и занимал полмодалки, хотя настраивают
                      его редко. Теперь свёрнут по дефолту — заголовок +
                      chevron, клик раскрывает. `<details>` без React-стейта
                      = меньше кода, состояние живёт в DOM. */}
                  <details className="group rounded-lg border border-gray-200 bg-gray-50/50">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-gray-100 transition-colors rounded-lg">
                      <h4 className="text-sm font-medium text-gray-900 m-0">Отображение инструментов</h4>
                      <span className="text-gray-400 text-xs transition-transform group-open:rotate-90" aria-hidden>▶</span>
                    </summary>
                    <ul className="space-y-2 px-3 pb-3 pt-1">
                      {ALL_TOOL_IDS.map((toolId) => (
                        <li key={toolId} className="flex items-center justify-between gap-4">
                          <span className="text-sm text-gray-700">{TOOLS_CONFIG[toolId].title}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={toolVisibility[toolId] !== false}
                            onClick={() =>
                              setToolVisibility((prev) => ({
                                ...prev,
                                [toolId]: prev[toolId] === false,
                              }))
                            }
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                              toolVisibility[toolId] !== false ? 'bg-blue-600' : 'bg-gray-200'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                                toolVisibility[toolId] !== false ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-1">Отображение вкладок в Header-е</h4>
                    <p className="text-xs text-gray-500 mb-3">Управляет дополнительными пунктами навигации для данного пользователя</p>
                    <ul className="space-y-2">
                      {ALL_NAV_TAB_IDS.map((tabId) => (
                        <li key={tabId} className="flex items-center justify-between gap-4">
                          <span className="text-sm text-gray-700">{NAV_TABS_CONFIG[tabId].title}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={toolVisibility[tabId] !== false}
                            onClick={() =>
                              setToolVisibility((prev) => ({
                                ...prev,
                                [tabId]: prev[tabId] === false,
                              }))
                            }
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                              toolVisibility[tabId] !== false ? 'bg-blue-600' : 'bg-gray-200'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                                toolVisibility[tabId] !== false ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {modalRole === 'client' && (
                  <div className="space-y-4 pt-2 border-t border-gray-200">
                    <div className="rounded-lg border border-gray-200 bg-white p-3">
                      <h4 className="text-sm font-medium text-gray-900 mb-1">Магазин ЮКасса клиента</h4>
                      <p className="text-[11px] text-gray-500 mb-2">
                        Переключает магазин на постоянной основе. Влияет на цены в ЛК клиента и креды
                        ЮКассы во всех будущих счетах/автоплатежах. Не создаёт счёт сам по себе.
                      </p>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setClientIsTestShop(false)}
                          className={`flex-1 px-2 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
                            !clientIsTestShop
                              ? 'bg-gray-900 text-white border-gray-900'
                              : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                          }`}
                        >
                          Боевой
                        </button>
                        <button
                          type="button"
                          onClick={() => setClientIsTestShop(true)}
                          className={`flex-1 px-2 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
                            clientIsTestShop
                              ? 'bg-yellow-500 text-white border-yellow-500'
                              : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                          }`}
                        >
                          🧪 Тестовый
                        </button>
                      </div>
                      {clientIsTestShop && (
                        <p className="mt-2 text-[10px] leading-relaxed text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1">
                          В ЛК клиента покажутся тестовые цены: <strong>10/15/20 ₽</strong> (Стандарт)
                          и <strong>11/16/21 ₽</strong> (Про). Период действия — <strong>10/15/20 мин</strong>,
                          setup-trial — <strong>5 мин</strong>. Изменение применится после
                          «Сохранить изменения».
                        </p>
                      )}
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-gray-900 mb-2">Тариф клиента</h4>
                      <div className="flex gap-2">
                        {(['standard', 'pro', 'custom'] as TariffType[]).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => {
                              setTariffType(t);
                              if (t === 'custom') setCustomLimits({ ...TARIFF_DEFAULTS.pro });
                            }}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                              tariffType === t
                                ? t === 'pro'
                                  ? 'bg-violet-600 text-white border-violet-600'
                                  : t === 'custom'
                                    ? 'bg-zinc-800 text-white border-zinc-800'
                                    : 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            {TARIFF_LABELS[t]}
                          </button>
                        ))}
                      </div>
                      {tariffType !== 'custom' && (
                        <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 overflow-hidden">
                          {LIMIT_LABELS.map(({ key, label }) => (
                            <div key={key} className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 last:border-b-0">
                              <span className="text-xs text-gray-600">{label}</span>
                              <span className="text-xs font-semibold text-gray-800 tabular-nums">
                                {(TARIFF_DEFAULTS[tariffType as 'standard' | 'pro'][key] ?? 0).toLocaleString('ru-RU')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {tariffType === 'custom' && (
                        <div className="mt-3 space-y-2">
                          {LIMIT_LABELS.map(({ key, label }) => (
                            <div key={key} className="flex items-center gap-3">
                              <label className="flex-1 text-xs text-gray-700">{label}</label>
                              <input
                                type="number"
                                min={0}
                                value={customLimits[key] ?? ''}
                                onChange={(e) =>
                                  setCustomLimits((prev) => ({
                                    ...prev,
                                    [key]: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))),
                                  }))
                                }
                                className="w-28 px-2 py-1 border border-gray-300 rounded-lg text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Subscription panel — child component with its OWN local
                          state for activate / period / amount / showExtendForm
                          / activating. Typing in «Сумма за период» no longer
                          re-renders the parent and the 700+ lines of modal JSX
                          surrounding it. Parent only learns about results
                          (paid_until etc) after the API call settles, via the
                          handle*Result callbacks below. key={actionModalUserId}
                          forces a fresh mount when switching users — that
                          resets the local state to its defaults. */}
                      <SubscriptionPanel
                        key={actionModalUserId}
                        userId={actionModalUserId}
                        apiFetch={apiFetch}
                        tariffType={tariffType}
                        subscriptionActive={subscriptionActive}
                        subscriptionSetup={subscriptionSetup}
                        paidUntil={paidUntil}
                        setupUntil={setupUntil}
                        billingMode={billingMode}
                        paymentLocked={paymentLocked}
                        billingPeriod={billingPeriod}
                        billingAmount={billingAmount}
                        defaultIsTestShop={clientIsTestShop}
                        onActivateResult={handleActivateResult}
                        onExtendResult={handleExtendResult}
                        onFinishSetupResult={handleFinishSetupResult}
                        onUnlockPaymentSuccess={handleUnlockPaymentSuccess}
                        onDeactivateSuccess={handleDeactivateSuccess}
                        onError={handlePanelError}
                        onSuccessMessage={handlePanelSuccess}
                      />
                    </div>
                  </div>
                )}

                {modalRole === 'client' && (
                  <div className="space-y-3 pt-2 border-t border-gray-200">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-medium text-gray-900">Кампании клиента</h4>
                      {clientCampaigns.length > 0 && (
                        <span className="text-xs text-blue-600 font-medium">{clientCampaigns.length} выбрано</span>
                      )}
                    </div>
                    {!clientAccessLoaded && (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        Не удалось загрузить доступы кампаний. При сохранении тарифа они не будут изменены.
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={campaignSearch}
                        disabled={!clientAccessLoaded}
                        onChange={(e) => setCampaignSearch(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter в инпуте не должен сабмитить родительскую
                          // <form> модалки — иначе у нас уйдёт сохранение всего
                          // пользователя вместо применения поиска.
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            applyCampaignSearch();
                          }
                        }}
                        placeholder="Поиск кампании..."
                        className="flex-1 min-w-0 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                      />
                      <button
                        type="button"
                        onClick={applyCampaignSearch}
                        disabled={!clientAccessLoaded}
                        className="shrink-0 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Найти
                      </button>
                    </div>
                    <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {allCampaignsLoading ? (
                        <div className="px-3 py-4 text-center text-xs text-gray-400">Загрузка кампаний...</div>
                      ) : pagedCampaigns.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs text-gray-400">Кампании не найдены</div>
                      ) : (
                        pagedCampaigns.map((c) => {
                          const checked = selectedCampaignSet.has(c.id);
                          return (
                            <label
                              key={c.id}
                              className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${checked ? 'bg-blue-50/50' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!clientAccessLoaded}
                                onChange={() => {
                                  setClientCampaigns((prev) =>
                                    checked ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                                  );
                                }}
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0 disabled:cursor-not-allowed"
                              />
                              <div className="min-w-0">
                                <p className="text-sm text-gray-800 leading-snug truncate">{c.name}</p>
                                <span className={`inline-block mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                                  c.status === 1 ? 'bg-green-100 text-green-700' :
                                  c.status === 2 ? 'bg-yellow-100 text-yellow-700' :
                                  c.status === 3 ? 'bg-gray-100 text-gray-600' :
                                  'bg-gray-100 text-gray-500'
                                }`}>
                                  {CampaignStatusLabels[c.status] ?? `Статус ${c.status}`}
                                </span>
                              </div>
                            </label>
                          );
                        })
                      )}
                    </div>
                    {!allCampaignsLoading && pageCount > 1 && (
                      <div className="flex items-center justify-between gap-2 px-1">
                        <button
                          type="button"
                          onClick={() => setCampaignPage((p) => Math.max(1, p - 1))}
                          disabled={effectivePage <= 1}
                          className="px-2.5 py-1 border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          ← Назад
                        </button>
                        <span className="text-xs text-gray-500">
                          Стр. {effectivePage} / {pageCount} · всего {visibleCampaigns.length}
                        </span>
                        <button
                          type="button"
                          onClick={() => setCampaignPage((p) => Math.min(pageCount, p + 1))}
                          disabled={effectivePage >= pageCount}
                          className="px-2.5 py-1 border border-gray-300 rounded-md text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Вперёд →
                        </button>
                      </div>
                    )}
                    <p className="text-xs text-gray-400">Lead-списки определяются автоматически из назначенных кампаний</p>
                  </div>
                )}
              </div>
              {/* Одна строка кнопок в порядке: Пресет запуска кампаний,
                  Бриф клиента, Удалить пользователя, Сменить пароль,
                  Сохранить изменения. Раньше «Сохранить» была отдельной
                  колонкой справа (justify-between) — теперь все в ряд с
                  «Сохранить» справа за счёт ml-auto. flex-wrap оставлен
                  как fallback для узких экранов. */}
              <div className="pl-4 pr-5 py-5 border-t border-gray-200 bg-gray-50 flex flex-wrap items-center gap-2">
                {modalRole === 'client' && actionModalUserId && (
                  <>
                    <Link
                      href={`/admin/clients/${actionModalUserId}/preset` as Route}
                      className="px-3 py-2 border border-blue-200 text-blue-700 rounded-lg text-sm hover:bg-blue-50"
                    >
                      Пресет запуска кампаний
                    </Link>
                    <Link
                      href={`/admin/clients/${actionModalUserId}/brief` as Route}
                      className="px-3 py-2 border border-blue-200 text-blue-700 rounded-lg text-sm hover:bg-blue-50"
                    >
                      Бриф клиента
                    </Link>
                  </>
                )}
                {actionModalUserId !== currentUserId && (
                  <button
                    type="button"
                    onClick={() => {
                      setActionModalUserId(null);
                      setModalFlyIn(false);
                      setDeletingUserId(actionModalUserId);
                    }}
                    className="px-3 py-2 border border-red-200 text-red-700 rounded-lg text-sm hover:bg-red-50"
                  >
                    Удалить пользователя
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setActionModalUserId(null);
                    setModalFlyIn(false);
                    setError('');
                    setResettingUserId(actionModalUserId);
                    setNewPassword('');
                    setRevealPassword(false);
                  }}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                >
                  Сменить пароль
                </button>
                <button
                  type="button"
                  onClick={handleSaveAllChanges}
                  disabled={saving || !modalRole}
                  className="ml-auto px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium text-sm"
                >
                  {saving ? 'Сохранение...' : 'Сохранить изменения'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {deletingUserId && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Подтверждение удаления</h3>
            </div>
            <div className="p-6">
              {(() => {
                const userToDelete = users.find(u => u.id === deletingUserId);
                return (
                  <p className="text-gray-700">
                    Вы уверены, что хотите удалить пользователя{' '}
                    <span className="font-semibold">
                      {userToDelete?.full_name || userToDelete?.email || 'этого пользователя'}
                    </span>?
                    <br />
                    <span className="text-sm text-gray-500 mt-2 block">
                      Это действие нельзя отменить.
                    </span>
                  </p>
                );
              })()}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => setDeletingUserId(null)}
                disabled={deleting}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                onClick={() => deletingUserId && handleDeleteUser(deletingUserId)}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center"
              >
                {deleting ? 'Удаление...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {resettingUserId && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Сменить пароль</h3>
              <button
                onClick={() => {
                  setResettingUserId(null);
                  setNewPassword('');
                  setRevealPassword(false);
                  setError('');
                }}
                className="size-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                Админ задаёт новый пароль пользователю. Сообщите пароль пользователю безопасным способом.
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Новый пароль <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type={revealPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Минимум 8 символов"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealPassword((v) => !v)}
                    className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                    title={revealPassword ? 'Скрыть' : 'Показать'}
                  >
                    {revealPassword ? 'Скрыть' : 'Показать'}
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={generatePassword}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    Сгенерировать
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        if (!newPassword.trim()) return;
                        await navigator.clipboard.writeText(newPassword.trim());
                      } catch {
                        // ignore
                      }
                    }}
                    className="text-sm text-gray-600 hover:text-gray-800"
                    disabled={!newPassword.trim()}
                  >
                    Копировать
                  </button>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => {
                  setResettingUserId(null);
                  setNewPassword('');
                  setRevealPassword(false);
                  setError('');
                }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleResetPassword}
                disabled={resetting || newPassword.trim().length < 8}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {resetting ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
