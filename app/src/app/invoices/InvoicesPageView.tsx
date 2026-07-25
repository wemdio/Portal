'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { authFetch, authFetchJson } from '@/lib/authFetch';
import { TARIFF_LABELS_RU } from '@/lib/tariffPricing';
import type { TariffType } from '@/lib/tariffPricing';
import {
  Plus, RefreshCw, ExternalLink, Copy, Check,
  TrendingUp, Clock, CheckCircle2, XCircle, Loader2,
  Search, X, ChevronLeft, ChevronRight, Calendar, Trash2, QrCode, Link,
} from 'lucide-react';

/* ══════════════════════════════════════════
   TYPES
══════════════════════════════════════════ */

type InvoiceStatus = 'pending' | 'paid' | 'cancelled' | 'expired';

interface Invoice {
  id: string;
  company_name: string;
  client_user_id: string | null;
  amount: number;
  currency: string;
  description: string | null;
  status: InvoiceStatus;
  yookassa_payment_id: string | null;
  yookassa_payment_url: string | null;
  is_test_shop: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  creator?: { id: string; full_name: string; email: string } | null;
}

interface DailyStats {
  date: string;
  total: number;
  paid: number;
  count: number;
}

type ChartPeriod = 'week' | 'month' | 'all';

interface ApiResponse {
  invoices: Invoice[];
  total: number;
  daily: DailyStats[];
}

/* ══════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════ */

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  pending: 'Ожидает',
  paid: 'Оплачен',
  cancelled: 'Отменён',
  expired: 'Истёк',
};

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  paid: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-zinc-100 text-zinc-500',
  expired: 'bg-red-100 text-red-600',
};

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const CHART_PERIOD_LABELS: Record<ChartPeriod, string> = {
  week: 'Неделя',
  month: 'Месяц',
  all: 'Всё время',
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtMoney(amount: number, currency = 'RUB') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

/** Label for chart bar: "18 май" for daily, "май 26" for monthly */
function barLabel(date: string, isMonthly: boolean): string {
  if (isMonthly) {
    // date = "2026-05"
    const [year, month] = date.split('-');
    return `${MONTH_SHORT[Number(month) - 1]} ${String(year).slice(2)}`;
  }
  // date = "2026-05-18"
  const d = new Date(date + 'T00:00:00');
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
}

/* ══════════════════════════════════════════
   CHART (CSS flex bars — responsive)
══════════════════════════════════════════ */

function Chart({ data, isMonthly }: { data: DailyStats[]; isMonthly: boolean }) {
  const maxTotal = Math.max(...data.map((d) => d.total), 1);
  // Show label every N bars so they don't overlap
  const labelStep = Math.max(1, Math.ceil(data.length / 8));

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-xs text-zinc-300">
        Нет данных за период
      </div>
    );
  }

  return (
    <div className="flex items-end gap-px w-full" style={{ height: 96 }}>
      {data.map((d, i) => {
        const totalPct = Math.max(d.total > 0 ? 4 : 0, (d.total / maxTotal) * 80);
        const paidPct = d.total > 0 ? (d.paid / d.total) * totalPct : 0;
        const showLabel = i % labelStep === 0 || i === data.length - 1;
        const tooltip = `${barLabel(d.date, isMonthly)}: ${fmtMoney(d.total)} выставлено, ${fmtMoney(d.paid)} оплачено, ${d.count} шт.`;

        return (
          <div
            key={d.date}
            className="flex-1 flex flex-col items-center justify-end gap-0 min-w-0"
            style={{ height: 96 }}
            title={tooltip}
          >
            {/* bar */}
            <div
              className="w-full relative rounded-sm overflow-hidden bg-zinc-100 transition-all"
              style={{ height: `${totalPct}%` }}
            >
              {paidPct > 0 && (
                <div
                  className="absolute bottom-0 left-0 right-0 bg-emerald-400 rounded-sm"
                  style={{ height: `${paidPct / totalPct * 100}%` }}
                />
              )}
            </div>
            {/* label */}
            <div
              className={`text-center leading-tight mt-1 text-zinc-400 truncate w-full ${showLabel ? '' : 'invisible'}`}
              style={{ fontSize: 9 }}
            >
              {barLabel(d.date, isMonthly)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════
   CREATE MODAL
══════════════════════════════════════════ */

interface ClientTariffInfo {
  tariff_type: string;
  paid_until: string | null;
  paid_at: string | null;
  setup_until: string | null;
  is_active: boolean;
  billing_period: string | null;
  billing_amount: number | null;
}

const BILLING_PERIOD_LABEL: Record<string, string> = {
  month: 'за месяц',
  half_year: 'за полгода',
  year: 'за год',
};

interface ClientOption {
  id: string;
  full_name: string | null;
  email: string | null;
  tariff: ClientTariffInfo | null;
}

interface CreateModalProps {
  onClose: () => void;
  onCreated: (inv: Invoice, ykErr?: string | null) => void;
}

function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [companyName, setCompanyName] = useState('');
  const [clientUserId, setClientUserId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('RUB');
  const [description, setDescription] = useState('');
  const [useTestShop, setUseTestShop] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client combobox state
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedTariff, setSelectedTariff] = useState<ClientTariffInfo | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load clients on mount
  useEffect(() => {
    loadClients('');
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadClients = useCallback(async (q: string) => {
    setClientsLoading(true);
    try {
      const data = await authFetchJson<{ clients: ClientOption[] }>(
        `/api/invoices/clients?q=${encodeURIComponent(q)}`
      );
      setClients(data.clients);
    } catch {
      // ignore
    } finally {
      setClientsLoading(false);
    }
  }, []);

  const handleCompanyInput = (val: string) => {
    setCompanyName(val);
    setClientUserId(null);
    setSelectedTariff(null);
    setAmount('');
    setShowDropdown(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadClients(val), 250);
  };

  const handleSelectClient = (c: ClientOption) => {
    setCompanyName(c.full_name || c.email?.split('@')[0] || '');
    setClientUserId(c.id);
    setSelectedTariff(c.tariff);
    setShowDropdown(false);
    // Сумма берётся из активной подписки клиента (зафиксирована при активации тарифа).
    // Если подписки нет — сумма заполняется вручную.
    if (c.tariff?.is_active && c.tariff.billing_amount != null) {
      setAmount(String(c.tariff.billing_amount));
    } else {
      setAmount('');
    }
  };

  const clientLabel = (c: ClientOption) => {
    if (c.full_name && c.email) return `${c.full_name} · ${c.email}`;
    return c.full_name || c.email || c.id;
  };

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(amount.replace(',', '.'));
    if (!companyName.trim()) { setError('Укажите название компании'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setError('Укажите корректную сумму'); return; }

    setLoading(true);
    setError(null);

    try {
      const res = await authFetch('/api/invoices', {
        method: 'POST',
        body: JSON.stringify({
          company_name: companyName.trim(),
          amount: amt,
          currency,
          description: description.trim() || undefined,
          client_user_id: clientUserId ?? undefined,
          vat_code: 1,
          is_test_shop: useTestShop,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Ошибка создания счёта'); return; }
      onCreated(data.invoice as Invoice, data.yookassa_error as string | null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [companyName, clientUserId, amount, currency, description, useTestShop, onCreated, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-zinc-100">
          <h2 className="text-sm font-semibold text-zinc-800">Новый счёт</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">

          {/* Company combobox */}
          <div ref={dropdownRef} className="relative">
            <label className="block text-xs font-medium text-zinc-600 mb-1">Компания *</label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => handleCompanyInput(e.target.value)}
              onFocus={() => setShowDropdown(true)}
              placeholder="Введите или выберите клиента"
              className={`w-full rounded-lg border px-3 py-2 text-sm text-zinc-800 outline-none transition ${
                clientUserId ? 'border-emerald-400 bg-emerald-50' : 'border-zinc-200 focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400'
              }`}
              autoFocus
              autoComplete="off"
            />
            {clientUserId && (
              <button
                type="button"
                onClick={() => { setClientUserId(null); setCompanyName(''); setSelectedTariff(null); setAmount(''); }}
                className="absolute right-2.5 top-[calc(50%+6px)] -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {showDropdown && !clientUserId && (
              <div className="absolute z-10 mt-1 w-full rounded-xl border border-zinc-200 bg-white shadow-lg overflow-hidden">
                {clientsLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-300" />
                  </div>
                ) : clients.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-zinc-400">Клиенты не найдены — введите вручную</p>
                ) : (
                  <ul className="max-h-48 overflow-y-auto py-1">
                    {clients.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onMouseDown={() => handleSelectClient(c)}
                          className="w-full text-left px-3 py-2 hover:bg-zinc-50 transition-colors"
                        >
                          <p className="text-sm text-zinc-800 leading-tight">{c.full_name || '—'}</p>
                          <p className="text-[11px] text-zinc-400 leading-tight">{c.email}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {selectedTariff && selectedTariff.is_active && (() => {
            const fmt = (d: Date) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            const tariffLabel = TARIFF_LABELS_RU[selectedTariff.tariff_type as TariffType] ?? TARIFF_LABELS_RU.standard;
            const periodLabel = selectedTariff.billing_period ? BILLING_PERIOD_LABEL[selectedTariff.billing_period] : null;
            const currentPaidUntil = selectedTariff.paid_until ? new Date(selectedTariff.paid_until) : null;
            return (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800 space-y-0.5">
                <p className="font-medium">
                  Активный тариф «{tariffLabel}»{periodLabel ? ` (${periodLabel})` : ''}
                  {currentPaidUntil ? ` — до ${fmt(currentPaidUntil)}` : ''}
                </p>
                <p className="text-amber-600">
                  Сумма зафиксирована при активации подписки. Чтобы изменить — деактивируйте подписку в админке.
                </p>
              </div>
            );
          })()}

          {selectedTariff && !selectedTariff.is_active && (
            <div className="rounded-lg bg-zinc-50 border border-zinc-200 px-3 py-2.5 text-xs text-zinc-600">
              У клиента нет активной подписки. Активируйте тариф в админке — сумма проставится автоматически.
            </div>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-zinc-600 mb-1">Сумма *</label>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                readOnly={!!(selectedTariff && selectedTariff.is_active && selectedTariff.billing_amount != null)}
                placeholder="50 000"
                className={`w-full rounded-lg border px-3 py-2 text-sm text-zinc-800 outline-none transition ${
                  selectedTariff && selectedTariff.is_active && selectedTariff.billing_amount != null
                    ? 'border-zinc-200 bg-zinc-50 cursor-not-allowed'
                    : 'border-zinc-200 focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400'
                }`}
              />
            </div>
            <div className="w-24">
              <label className="block text-xs font-medium text-zinc-600 mb-1">Валюта</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400 transition bg-white"
              >
                <option value="RUB">RUB</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Назначение платежа *</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Услуги по контент-маркетингу за май 2026"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 transition"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Магазин YooKassa</label>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setUseTestShop(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  !useTestShop
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'border-zinc-200 text-zinc-600 bg-white hover:bg-zinc-50'
                }`}
              >
                Боевой
              </button>
              <button
                type="button"
                onClick={() => setUseTestShop(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  useTestShop
                    ? 'bg-yellow-500 text-white border-yellow-500'
                    : 'border-zinc-200 text-zinc-600 bg-white hover:bg-zinc-50'
                }`}
              >
                🧪 Тестовый
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 transition flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Выставить счёт
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   QR MODAL
══════════════════════════════════════════ */

function QrModal({ url, company, amount, currency, onClose }: {
  url: string;
  company: string;
  amount: number;
  currency: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}&margin=10&color=18181b&bgcolor=ffffff`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-zinc-100">
          <div>
            <h2 className="text-sm font-semibold text-zinc-800">Ссылка на оплату</h2>
            <p className="text-xs text-zinc-400 mt-0.5">{company} · {fmtMoney(amount, currency)}</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col items-center gap-4">
          {/* QR */}
          <div className="rounded-xl border border-zinc-100 p-2 bg-white shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrSrc} alt="QR код для оплаты" width={200} height={200} className="rounded" />
          </div>

          {/* URL */}
          <div className="w-full rounded-lg bg-zinc-50 border border-zinc-200 px-3 py-2 flex items-center gap-2">
            <p className="flex-1 text-xs text-zinc-500 truncate">{url}</p>
            <button onClick={handleCopy} className="flex-shrink-0 text-zinc-400 hover:text-zinc-700 transition-colors" title="Скопировать">
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>

          {/* Actions */}
          <div className="flex gap-2 w-full">
            <button
              onClick={handleCopy}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 transition"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-700 px-3 py-2 text-xs font-medium text-white transition"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Открыть
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   COPY BUTTON
══════════════════════════════════════════ */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className="text-zinc-400 hover:text-zinc-700 transition-colors"
      title="Скопировать ссылку"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/* ══════════════════════════════════════════
   MAIN VIEW
══════════════════════════════════════════ */

export default function InvoicesPageView() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [daily, setDaily] = useState<DailyStats[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>('month');

  const [showCreate, setShowCreate] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [ykError, setYkError] = useState<string | null>(null);
  const [qrInvoice, setQrInvoice] = useState<Invoice | null>(null);
  const [deleteInvoice, setDeleteInvoice] = useState<Invoice | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async (opts?: {
    searchOverride?: string;
    statusOverride?: string;
    pageOverride?: number;
    periodOverride?: ChartPeriod;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(opts?.pageOverride ?? page),
        status: opts?.statusOverride ?? statusFilter,
        search: opts?.searchOverride ?? search,
        period: opts?.periodOverride ?? chartPeriod,
      });
      const data = await authFetchJson<ApiResponse>(`/api/invoices?${params}`);
      setInvoices(data.invoices);
      setDaily(data.daily);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, search, chartPeriod]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(0);
      fetchData({ searchOverride: val, pageOverride: 0 });
    }, 350);
  };

  const handleStatusChange = (val: string) => {
    setStatusFilter(val);
    setPage(0);
    fetchData({ statusOverride: val, pageOverride: 0 });
  };

  const handleCreated = (inv: Invoice, ykErr?: string | null) => {
    setInvoices((prev) => [inv, ...prev]);
    setTotal((t) => t + 1);
    if (ykErr) {
      setYkError(ykErr);
    } else if (inv.yookassa_payment_url) {
      setQrInvoice(inv);
    }
  };

  const handlePeriodChange = (p: ChartPeriod) => {
    setChartPeriod(p);
    fetchData({ periodOverride: p });
  };

  const handleSync = async (inv: Invoice) => {
    if (!inv.yookassa_payment_id) return;
    setSyncingId(inv.id);
    try {
      const data = await authFetchJson<{ invoice: Invoice }>(`/api/invoices/${inv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ sync_yookassa: true }),
      });
      setInvoices((prev) => prev.map((i) => i.id === inv.id ? data.invoice : i));
    } catch {
      // ignore
    } finally {
      setSyncingId(null);
    }
  };

  const handleArchive = async (inv: Invoice) => {
    setInvoices((prev) => prev.filter((i) => i.id !== inv.id));
    setTotal((t) => Math.max(0, t - 1));
    try {
      await authFetch(`/api/invoices/${inv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archive: true }),
      });
    } catch {
      // restore on error
      setInvoices((prev) => [inv, ...prev]);
      setTotal((t) => t + 1);
    }
  };

  const handleCreatePayment = async (inv: Invoice) => {
    setSyncingId(inv.id);
    setYkError(null);
    try {
      const res = await authFetch(`/api/invoices/${inv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ create_yookassa_payment: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setYkError(data.error ?? 'Ошибка создания платежа в ЮКассе');
        return;
      }
      const updated = data.invoice as Invoice;
      setInvoices((prev) => prev.map((i) => i.id === inv.id ? updated : i));
      if (updated.yookassa_payment_url) setQrInvoice(updated);
    } catch (e) {
      setYkError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setSyncingId(null);
    }
  };

  // Aggregate stats
  const totalAmount = daily.reduce((s, d) => s + d.total, 0);
  const paidAmount = daily.reduce((s, d) => s + d.paid, 0);
  const pendingCount = invoices.filter((i) => i.status === 'pending').length;
  const paidCount = invoices.filter((i) => i.status === 'paid').length;

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Счета</h1>
          <p className="text-xs text-zinc-400 mt-0.5">Выставление счетов клиентам через ЮКассу</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Выставить счёт
        </button>
      </div>

      {/* ── YooKassa error banner ── */}
      {ykError && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <XCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-700">Ошибка ЮКассы</p>
            <p className="text-xs text-red-500 mt-0.5 break-all">{ykError}</p>
          </div>
          <button onClick={() => setYkError(null)} className="text-red-400 hover:text-red-600 flex-shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Stats ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Выставлено за 30 дней"
          value={fmtMoney(totalAmount)}
          color="text-zinc-700"
        />
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Оплачено за 30 дней"
          value={fmtMoney(paidAmount)}
          color="text-emerald-600"
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Ожидают оплаты"
          value={String(pendingCount)}
          color="text-amber-600"
        />
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Оплачено (всего)"
          value={String(paidCount)}
          color="text-emerald-600"
        />
      </div>

      {/* ── Chart ── */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 text-zinc-400" />
            <p className="text-xs font-medium text-zinc-600">Выставлено по периодам</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-3 text-[10px] text-zinc-400">
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-zinc-200" />Выставлено</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-400" />Оплачено</span>
            </div>
            <div className="flex gap-0.5">
              {(['week', 'month', 'all'] as ChartPeriod[]).map((p) => (
                <button
                  key={p}
                  onClick={() => handlePeriodChange(p)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    chartPeriod === p
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'
                  }`}
                >
                  {CHART_PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <Chart data={daily} isMonthly={chartPeriod === 'all'} />
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Поиск по компании..."
            className="w-full rounded-lg border border-zinc-200 pl-8 pr-3 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 transition"
          />
          {search && (
            <button onClick={() => handleSearchChange('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'pending', 'paid', 'cancelled', 'expired'] as const).map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
              }`}
            >
              {s === 'all' ? 'Все' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <button
          onClick={() => fetchData()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-50 transition disabled:opacity-50"
          title="Обновить"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ── Table ── */}
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      ) : loading && invoices.length === 0 ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-300" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center">
          <p className="text-sm text-zinc-400">Счетов не найдено</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50">
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-zinc-400 whitespace-nowrap">Компания</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-zinc-400 whitespace-nowrap">Назначение</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-zinc-400 whitespace-nowrap">Сумма</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-zinc-400 whitespace-nowrap">Статус</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-zinc-400 whitespace-nowrap">Создан</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-zinc-400 whitespace-nowrap">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-4 py-3 text-center">
                      <p className="font-medium text-zinc-800 text-sm">{inv.company_name}</p>
                      {inv.creator && (
                        <p className="text-[11px] text-zinc-400 mt-0.5">{inv.creator.full_name || inv.creator.email}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <p className="text-zinc-600 text-xs max-w-xs truncate">{inv.description ?? '—'}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="font-semibold text-zinc-800 whitespace-nowrap">{fmtMoney(inv.amount, inv.currency)}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="inline-flex items-center gap-1">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[inv.status]}`}>
                          {STATUS_LABEL[inv.status]}
                        </span>
                        {inv.is_test_shop && (
                          <span
                            className="inline-flex items-center rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700"
                            title="Счёт создан в тестовом магазине YooKassa"
                          >
                            🧪 Тест
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-zinc-500 whitespace-nowrap">{fmtDate(inv.created_at)}</td>
                    <td className="px-4 py-3 text-center">
                      <div className="inline-flex items-center gap-1.5">
                        {inv.yookassa_payment_url ? (
                          <>
                            {/* QR + link */}
                            <button
                              onClick={() => setQrInvoice(inv)}
                              className="flex items-center gap-1 rounded-md bg-zinc-900 hover:bg-zinc-700 px-2 py-1 text-[11px] font-medium text-white transition"
                              title="QR и ссылка на оплату"
                            >
                              <QrCode className="h-3 w-3" />
                              Ссылка
                            </button>
                            <CopyButton text={inv.yookassa_payment_url} />
                          </>
                        ) : inv.status === 'pending' ? (
                          <button
                            onClick={() => handleCreatePayment(inv)}
                            disabled={syncingId === inv.id}
                            className="flex items-center gap-1 rounded-md bg-zinc-100 hover:bg-zinc-200 px-2 py-1 text-[11px] text-zinc-600 transition disabled:opacity-40"
                            title="Создать в ЮКассе"
                          >
                            {syncingId === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link className="h-3 w-3" />}
                            ЮКасса
                          </button>
                        ) : null}
                        {inv.yookassa_payment_id && inv.status === 'pending' && (
                          <button
                            onClick={() => handleSync(inv)}
                            disabled={syncingId === inv.id}
                            className="text-zinc-300 hover:text-zinc-600 transition-colors disabled:opacity-40"
                            title="Проверить статус в ЮКассе"
                          >
                            {syncingId === inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <button
                          onClick={() => setDeleteInvoice(inv)}
                          className="text-zinc-200 hover:text-red-400 transition-colors"
                          title="Удалить счёт"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-100">
              <p className="text-xs text-zinc-400">
                Показано {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} из {total}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { const p = page - 1; setPage(p); fetchData({ pageOverride: p }); }}
                  disabled={page === 0}
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 transition"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-zinc-500 px-2">{page + 1} / {totalPages}</span>
                <button
                  onClick={() => { const p = page + 1; setPage(p); fetchData({ pageOverride: p }); }}
                  disabled={page >= totalPages - 1}
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 transition"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Create Modal ── */}
      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}

      {/* ── Delete Confirm Modal ── */}
      {deleteInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="px-6 pt-6 pb-2">
              <h2 className="text-sm font-semibold text-zinc-800">Удалить счёт?</h2>
              <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
                Счёт для <span className="font-medium text-zinc-700">{deleteInvoice.company_name}</span> на{' '}
                <span className="font-medium text-zinc-700">{fmtMoney(deleteInvoice.amount, deleteInvoice.currency)}</span> будет скрыт.
                {deleteInvoice.yookassa_payment_id && deleteInvoice.status === 'pending' && (
                  <span className="block mt-1 text-red-500">Счёт в ЮКассе будет отменён — клиент не сможет оплатить по ссылке.</span>
                )}
              </p>
            </div>
            <div className="flex gap-2 px-6 py-4">
              <button
                onClick={() => setDeleteInvoice(null)}
                className="flex-1 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition"
              >
                Отмена
              </button>
              <button
                onClick={() => { handleArchive(deleteInvoice); setDeleteInvoice(null); }}
                className="flex-1 rounded-lg bg-red-500 hover:bg-red-600 px-4 py-2 text-sm font-medium text-white transition"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── QR Modal ── */}
      {qrInvoice?.yookassa_payment_url && (
        <QrModal
          url={qrInvoice.yookassa_payment_url}
          company={qrInvoice.company_name}
          amount={qrInvoice.amount}
          currency={qrInvoice.currency}
          onClose={() => setQrInvoice(null)}
        />
      )}
    </div>
  );
}

/* ── Stat Card ── */
function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 flex items-start gap-3">
      <div className={`mt-0.5 ${color}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] text-zinc-400 leading-tight">{label}</p>
        <p className={`text-base font-semibold leading-tight mt-0.5 ${color}`}>{value}</p>
      </div>
    </div>
  );
}
