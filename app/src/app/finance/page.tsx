'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';

/* ═══════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════ */

interface ProjectRow {
  id: string;
  name: string;
  client: string;
  specialist: string;
  status: string;
  budget: string | null;
  margin: string | null;
  contract_date: string | null;
  launch_date: string | null;
  work_format: string | null;
  lead_source: string | null;
}

interface ProjectFinanceItem {
  id: string;
  name: string;
  client: string;
  specialist: string;
  status: string;
  budget: number;
  marginPercent: number;
  marginValue: number;
  cost: number;
  month: string; // YYYY-MM
  isRenewal: boolean;
  leadSource: string; // outreach | telegram | leadscan | linkedin | performance
}

interface ExpenseRow {
  category: string;
  name: string;
  plan: number;
  fact: number;
}

interface MonthlyExpenses {
  payroll: ExpenseRow[];
  operations: ExpenseRow[];
  taxes: ExpenseRow[];
  marketing: ExpenseRow[];
}

interface MonthlyExpensesSummary {
  payroll: { plan: number; fact: number };
  operations: { plan: number; fact: number };
  taxes: { plan: number; fact: number };
  marketing: { plan: number; fact: number };
  additional: { plan: number; fact: number };
  total: { plan: number; fact: number };
}

interface ApprovedPayment {
  id: string;
  department: string;
  description: string;
  amount: number;
  created_at: string;
}

/* ═══════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════ */

const EXPENSE_STORAGE_KEY = 'portal:finance-expenses';

const MONTH_NAMES: Record<string, string> = {
  '01': 'Январь', '02': 'Февраль', '03': 'Март', '04': 'Апрель',
  '05': 'Май', '06': 'Июнь', '07': 'Июль', '08': 'Август',
  '09': 'Сентябрь', '10': 'Октябрь', '11': 'Ноябрь', '12': 'Декабрь',
};

const EMPTY_EXPENSES: MonthlyExpenses = {
  payroll: [],
  operations: [],
  taxes: [],
  marketing: [],
};

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function normalizeLeadSource(raw: string | null | undefined): string {
  if (!raw) return 'outreach';
  const lower = raw.trim().toLowerCase();
  if (lower.includes('телеграм') || lower.includes('telegram') || lower.includes('тг')) return 'telegram';
  if (lower.includes('лидскан') || lower.includes('leadscan')) return 'leadscan';
  if (lower.includes('линкедин') || lower.includes('linkedin')) return 'linkedin';
  if (lower.includes('перфоманс') || lower.includes('performance') || lower.includes('перф')) return 'performance';
  return 'outreach';
}

const SOURCE_LABELS: Record<string, string> = {
  outreach: 'Аутрич',
  telegram: 'Телеграм',
  leadscan: 'Лидскан',
  linkedin: 'ЛинкедИн',
  performance: 'Перфоманс',
};

function parseBudget(raw: string | null | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.toString().replace(/\s/g, '').replace(/[^0-9.,]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

function parseMargin(raw: string | null | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.toString().replace(/\s/g, '').replace(',', '.');
  if (cleaned.includes('%')) {
    return parseFloat(cleaned.replace('%', '')) || 0;
  }
  const val = parseFloat(cleaned);
  if (isNaN(val)) return 0;
  return val <= 1 && val > 0 ? val * 100 : val;
}

function getProjectMonth(project: ProjectRow): string {
  const dateStr = project.contract_date || project.launch_date;
  if (!dateStr) {
    // Fallback: current month
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${MONTH_NAMES[month] || month} ${year}`;
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(val);
}

function formatPercent(val: number): string {
  if (!isFinite(val)) return '—';
  return `${val.toFixed(1)}%`;
}

function formatNumber(val: number): string {
  return new Intl.NumberFormat('ru-RU').format(val);
}

function loadExpenses(): Record<string, MonthlyExpenses> {
  try {
    const stored = window.localStorage.getItem(EXPENSE_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return {};
}

function saveExpenses(data: Record<string, MonthlyExpenses>): void {
  try {
    window.localStorage.setItem(EXPENSE_STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

function generateMonthRange(): string[] {
  const months: string[] = [];
  const now = new Date();
  // Show from Jan 2024 to current month + 2
  const start = new Date(2024, 0, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const cursor = new Date(start);
  while (cursor < end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

/* ═══════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════ */

export default function FinancePage() {
  const isTma = useIsTma();
  const [projects, setProjects] = useState<ProjectFinanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [allExpenses, setAllExpenses] = useState<Record<string, MonthlyExpenses>>({});
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'overview' | 'revenue' | 'expenses' | 'kpi'>('overview');
  const [approvedPayments, setApprovedPayments] = useState<ApprovedPayment[]>([]);

  // Generate month list
  const monthRange = useMemo(() => generateMonthRange(), []);

  // Initialize selected month to current
  useEffect(() => {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    setSelectedMonth(current);
  }, []);

  // Load expenses from localStorage
  useEffect(() => {
    setAllExpenses(loadExpenses());
  }, []);

  // Fetch approved payments from payment_requests
  useEffect(() => {
    async function fetchApprovedPayments() {
      try {
        const { data, error } = await supabase
          .from('payment_requests')
          .select('id, department, description, amount, created_at')
          .eq('status', 'approved')
          .order('created_at', { ascending: false });
        if (!error && data) setApprovedPayments(data);
      } catch {
        // table may not exist yet
      }
    }
    fetchApprovedPayments();
  }, []);

  // Fetch projects
  useEffect(() => {
    fetchProjects();
  }, []);

  async function fetchProjects() {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, client, specialist, status, budget, margin, contract_date, launch_date, work_format, lead_source');

      if (error) throw error;

      // First pass: collect all clients to detect renewals
      const clientFirstSeen = new Map<string, string>();
      const sorted = [...(data || [])].sort((a, b) => {
        const da = a.contract_date || a.launch_date || '';
        const db = b.contract_date || b.launch_date || '';
        return da.localeCompare(db);
      });

      for (const p of sorted) {
        const client = (p.client || '').trim().toLowerCase();
        if (client && !clientFirstSeen.has(client)) {
          clientFirstSeen.set(client, p.id);
        }
      }

      const parsed: ProjectFinanceItem[] = sorted
        .filter((p) => {
          const budget = parseBudget(p.budget);
          return budget > 0 && p.status !== 'Отменен';
        })
        .map((p) => {
          const budget = parseBudget(p.budget);
          const marginPercent = parseMargin(p.margin);
          const marginValue = (budget * marginPercent) / 100;
          const cost = budget - marginValue;
          const month = getProjectMonth(p);
          const client = (p.client || '').trim().toLowerCase();
          const isRenewal = clientFirstSeen.get(client) !== p.id;

          return {
            id: p.id,
            name: p.name || 'Без названия',
            client: p.client || 'Неизвестный',
            specialist: p.specialist || 'Не назначен',
            status: p.status,
            budget,
            marginPercent,
            marginValue,
            cost,
            month,
            isRenewal,
            leadSource: normalizeLeadSource(p.lead_source),
          };
        });

      setProjects(parsed);
    } catch (err) {
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  }

  // ────── Monthly data ──────

  const monthlyProjects = useMemo(() => {
    return projects.filter((p) => p.month === selectedMonth);
  }, [projects, selectedMonth]);

  const prevMonth = useMemo(() => {
    if (!selectedMonth) return '';
    const [y, m] = selectedMonth.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [selectedMonth]);

  const prevMonthProjects = useMemo(() => {
    return projects.filter((p) => p.month === prevMonth);
  }, [projects, prevMonth]);

  // Revenue breakdown
  const revenue = useMemo(() => {
    const renewals = monthlyProjects.filter((p) => p.isRenewal);
    const sales = monthlyProjects.filter((p) => !p.isRenewal);

    return {
      renewals: {
        total: renewals.reduce((s, p) => s + p.budget, 0),
        count: renewals.length,
        items: renewals,
      },
      sales: {
        total: sales.reduce((s, p) => s + p.budget, 0),
        count: sales.length,
        items: sales,
      },
      total: monthlyProjects.reduce((s, p) => s + p.budget, 0),
      totalMargin: monthlyProjects.reduce((s, p) => s + p.marginValue, 0),
      totalCost: monthlyProjects.reduce((s, p) => s + p.cost, 0),
      count: monthlyProjects.length,
    };
  }, [monthlyProjects]);

  const prevRevenue = useMemo(() => {
    return {
      total: prevMonthProjects.reduce((s, p) => s + p.budget, 0),
      renewals: prevMonthProjects.filter((p) => p.isRenewal).reduce((s, p) => s + p.budget, 0),
      sales: prevMonthProjects.filter((p) => !p.isRenewal).reduce((s, p) => s + p.budget, 0),
      count: prevMonthProjects.length,
    };
  }, [prevMonthProjects]);

  // Expenses
  const currentExpenses = useMemo((): MonthlyExpenses => {
    return allExpenses[selectedMonth] || EMPTY_EXPENSES;
  }, [allExpenses, selectedMonth]);

  const additionalExpenses = useMemo(() => {
    const monthPayments = approvedPayments.filter((p) => {
      const d = new Date(p.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return key === selectedMonth;
    });
    const total = monthPayments.reduce((s, p) => s + Number(p.amount), 0);
    return { total, count: monthPayments.length, items: monthPayments };
  }, [approvedPayments, selectedMonth]);

  const expenseSummary = useMemo((): MonthlyExpensesSummary => {
    const sum = (rows: ExpenseRow[]) => ({
      plan: rows.reduce((s, r) => s + r.plan, 0),
      fact: rows.reduce((s, r) => s + r.fact, 0),
    });
    const payroll = sum(currentExpenses.payroll);
    const operations = sum(currentExpenses.operations);
    const taxes = sum(currentExpenses.taxes);
    const marketing = sum(currentExpenses.marketing);
    const additional = { plan: additionalExpenses.total, fact: additionalExpenses.total };
    return {
      payroll,
      operations,
      taxes,
      marketing,
      additional,
      total: {
        plan: payroll.plan + operations.plan + taxes.plan + marketing.plan + additional.plan,
        fact: payroll.fact + operations.fact + taxes.fact + marketing.fact + additional.fact,
      },
    };
  }, [currentExpenses, additionalExpenses]);

  // P&L
  const pnl = useMemo(() => {
    const revenueTotal = revenue.total;
    const expensesFact = expenseSummary.total.fact;
    const expensesPlan = expenseSummary.total.plan;
    const netProfitFact = revenueTotal - expensesFact;
    const netProfitPlan = revenueTotal - expensesPlan;
    const marginFact = revenueTotal > 0 ? (netProfitFact / revenueTotal) * 100 : 0;
    const marginPlan = revenueTotal > 0 ? (netProfitPlan / revenueTotal) * 100 : 0;

    const prevRevenueTotal = prevRevenue.total;
    const revenueGrowth = prevRevenueTotal > 0 ? ((revenueTotal - prevRevenueTotal) / prevRevenueTotal) * 100 : 0;

    return {
      revenue: revenueTotal,
      expensesFact,
      expensesPlan,
      netProfitFact,
      netProfitPlan,
      marginFact,
      marginPlan,
      revenueGrowth,
    };
  }, [revenue, expenseSummary, prevRevenue]);

  // KPIs
  const kpis = useMemo(() => {
    const renewalItems = monthlyProjects.filter((p) => p.isRenewal && p.budget > 0);
    const salesItems = monthlyProjects.filter((p) => !p.isRenewal && p.budget > 0);

    const avgRenewalCheck = renewalItems.length > 0
      ? renewalItems.reduce((s, p) => s + p.budget, 0) / renewalItems.length
      : 0;
    const avgSalesCheck = salesItems.length > 0
      ? salesItems.reduce((s, p) => s + p.budget, 0) / salesItems.length
      : 0;

    const renewalCount = renewalItems.length;
    const newClientCount = salesItems.length;

    // Churn: prev month active renewals that didn't renew this month
    const prevRenewalClients = new Set(
      prevMonthProjects.filter((p) => p.isRenewal).map((p) => p.client.toLowerCase()),
    );
    const currRenewalClients = new Set(
      monthlyProjects.filter((p) => p.isRenewal).map((p) => p.client.toLowerCase()),
    );
    const churned = [...prevRenewalClients].filter((c) => !currRenewalClients.has(c)).length;
    const churnRate = prevRenewalClients.size > 0 ? (churned / prevRenewalClients.size) * 100 : 0;

    // Active clients = unique clients with revenue this month
    const activeClients = new Set(monthlyProjects.map((p) => p.client.toLowerCase())).size;

    // Renewal share
    const renewalShare = revenue.total > 0 ? (revenue.renewals.total / revenue.total) * 100 : 0;

    // MoM growth
    const prevTotal = prevRevenue.total;
    const revenueGrowthMoM = prevTotal > 0 ? ((revenue.total - prevTotal) / prevTotal) * 100 : 0;

    return {
      avgRenewalCheck,
      avgSalesCheck,
      renewalCount,
      newClientCount,
      churnRate,
      activeClients,
      renewalShare,
      revenueGrowthMoM,
    };
  }, [monthlyProjects, prevMonthProjects, revenue, prevRevenue]);

  // Revenue by source
  const revenueBySource = useMemo(() => {
    const sources = ['outreach', 'telegram', 'leadscan', 'linkedin', 'performance'] as const;
    return sources.map((source) => {
      const items = monthlyProjects.filter((p) => p.leadSource === source);
      const prevItems = prevMonthProjects.filter((p) => p.leadSource === source);
      const total = items.reduce((s, p) => s + p.budget, 0);
      const prevTotal = prevItems.reduce((s, p) => s + p.budget, 0);
      return {
        source,
        label: SOURCE_LABELS[source],
        total,
        count: items.length,
        prevTotal,
        growth: prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0,
      };
    });
  }, [monthlyProjects, prevMonthProjects]);

  // Previous month P&L (for growth calculations)
  const prevPnl = useMemo(() => {
    const rev = prevRevenue.total;
    const expData = allExpenses[prevMonth];
    const exp = expData
      ? [...(expData.payroll || []), ...(expData.operations || []), ...(expData.taxes || []), ...(expData.marketing || [])].reduce((s, r) => s + r.fact, 0)
      : 0;
    return { revenue: rev, expenses: exp, netProfit: rev - exp, margin: rev > 0 ? ((rev - exp) / rev) * 100 : 0 };
  }, [prevRevenue, allExpenses, prevMonth]);

  // Outreach-specific P&L
  const outreachPnl = useMemo(() => {
    const outreachItems = monthlyProjects.filter((p) => p.leadSource === 'outreach');
    const outreachRevenue = outreachItems.reduce((s, p) => s + p.budget, 0);
    const outreachNetProfit = outreachRevenue - expenseSummary.total.fact;
    const outreachMargin = outreachRevenue > 0 ? (outreachNetProfit / outreachRevenue) * 100 : 0;

    const prevOutreachItems = prevMonthProjects.filter((p) => p.leadSource === 'outreach');
    const prevOutreachRevenue = prevOutreachItems.reduce((s, p) => s + p.budget, 0);
    const prevExpData = allExpenses[prevMonth];
    const prevExpTotal = prevExpData
      ? [...(prevExpData.payroll || []), ...(prevExpData.operations || []), ...(prevExpData.taxes || []), ...(prevExpData.marketing || [])].reduce((s, r) => s + r.fact, 0)
      : 0;
    const prevOutreachNetProfit = prevOutreachRevenue - prevExpTotal;

    const revenueGrowth = prevOutreachRevenue > 0 ? ((outreachRevenue - prevOutreachRevenue) / prevOutreachRevenue) * 100 : 0;
    const netProfitGrowth = prevOutreachNetProfit !== 0
      ? ((outreachNetProfit - prevOutreachNetProfit) / Math.abs(prevOutreachNetProfit)) * 100
      : 0;

    return {
      revenue: outreachRevenue,
      netProfit: outreachNetProfit,
      margin: outreachMargin,
      revenueGrowth,
      netProfitGrowth,
    };
  }, [monthlyProjects, prevMonthProjects, expenseSummary, allExpenses, prevMonth]);

  // Extended KPIs (all spreadsheet metrics)
  const extendedKpis = useMemo(() => {
    // Net profit growth MoM (total)
    const netProfitGrowthMoM = prevPnl.netProfit !== 0
      ? ((pnl.netProfitFact - prevPnl.netProfit) / Math.abs(prevPnl.netProfit)) * 100
      : 0;

    // Churn absolute count
    const prevAllClients = new Set(prevMonthProjects.map((p) => p.client.toLowerCase()));
    const currRenewalClients = new Set(
      monthlyProjects.filter((p) => p.isRenewal).map((p) => p.client.toLowerCase()),
    );
    const churnedClients = [...prevAllClients].filter((c) => !currRenewalClients.has(c) && !monthlyProjects.some((p) => !p.isRenewal && p.client.toLowerCase() === c));
    const churnedAbsolute = churnedClients.length;

    // Revenue by source totals
    const leadscanRevenue = revenueBySource.find((r) => r.source === 'leadscan')?.total || 0;
    const performanceRevenue = revenueBySource.find((r) => r.source === 'performance')?.total || 0;
    const linkedinRevenue = revenueBySource.find((r) => r.source === 'linkedin')?.total || 0;
    const telegramRevenue = revenueBySource.find((r) => r.source === 'telegram')?.total || 0;

    // Total revenue growth (final, across all sources)
    const totalRevenueGrowth = prevPnl.revenue > 0
      ? ((pnl.revenue - prevPnl.revenue) / prevPnl.revenue) * 100
      : 0;

    return {
      ...kpis,
      netProfitGrowthMoM,
      churnedAbsolute,
      leadscanRevenue,
      performanceRevenue,
      linkedinRevenue,
      telegramRevenue,
      totalRevenueGrowth,
    };
  }, [kpis, prevPnl, pnl, monthlyProjects, prevMonthProjects, revenueBySource]);

  // Client breakdown
  const clientStats = useMemo(() => {
    const map = new Map<string, { name: string; revenue: number; margin: number; count: number }>();
    monthlyProjects.forEach((p) => {
      const existing = map.get(p.client) || { name: p.client, revenue: 0, margin: 0, count: 0 };
      existing.revenue += p.budget;
      existing.margin += p.marginValue;
      existing.count += 1;
      map.set(p.client, existing);
    });
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [monthlyProjects]);

  // Specialist breakdown
  const specialistStats = useMemo(() => {
    const map = new Map<string, { name: string; revenue: number; margin: number; count: number }>();
    monthlyProjects.forEach((p) => {
      if (!p.specialist || p.specialist === 'Не назначен') return;
      const existing = map.get(p.specialist) || { name: p.specialist, revenue: 0, margin: 0, count: 0 };
      existing.revenue += p.budget;
      existing.margin += p.marginValue;
      existing.count += 1;
      map.set(p.specialist, existing);
    });
    return Array.from(map.values()).sort((a, b) => b.margin - a.margin);
  }, [monthlyProjects]);

  // Yearly summary
  const yearlyData = useMemo(() => {
    const currentYear = selectedMonth.split('-')[0];
    const yearMonths = monthRange.filter((m) => m.startsWith(currentYear));
    return yearMonths.map((m) => {
      const mp = projects.filter((p) => p.month === m);
      const rev = mp.reduce((s, p) => s + p.budget, 0);
      const exp = allExpenses[m]
        ? [...(allExpenses[m].payroll || []), ...(allExpenses[m].operations || []), ...(allExpenses[m].taxes || []), ...(allExpenses[m].marketing || [])].reduce((s, r) => s + r.fact, 0)
        : 0;
      return { month: m, label: formatMonthLabel(m), revenue: rev, expenses: exp, profit: rev - exp };
    });
  }, [projects, allExpenses, selectedMonth, monthRange]);

  // ────── Expense editing ──────

  const updateExpenses = useCallback((month: string, expenses: MonthlyExpenses) => {
    setAllExpenses((prev) => {
      const next = { ...prev, [month]: expenses };
      saveExpenses(next);
      return next;
    });
  }, []);

  // ────── Render ──────

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400 text-sm">Загрузка финансов...</div>
      </div>
    );
  }

  const sectionHeaderClass = `${isTma ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-100 bg-gray-50/50`;
  const sectionBodyClass = isTma ? 'px-4 py-3' : 'px-6 py-4';

  return (
    <div className={`${isTma ? 'space-y-4' : 'space-y-6'} max-w-[1600px] mx-auto`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className={`${isTma ? 'text-2xl' : 'text-3xl'} font-bold tracking-tight text-gray-900`}>Финансы</h1>
          <p className="mt-1 text-sm text-gray-500">P&L, выручка, расходы, KPI</p>
        </div>
        <div className={`${isTma ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-3'}`}>
          <button
            onClick={() => {
              const idx = monthRange.indexOf(selectedMonth);
              if (idx > 0) setSelectedMonth(monthRange[idx - 1]);
            }}
            disabled={monthRange.indexOf(selectedMonth) <= 0}
            className="px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
          >
            &larr;
          </button>
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-4 py-2 text-sm font-medium bg-white border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            {monthRange.map((m) => (
              <option key={m} value={m}>{formatMonthLabel(m)}</option>
            ))}
          </select>
          <button
            onClick={() => {
              const idx = monthRange.indexOf(selectedMonth);
              if (idx < monthRange.length - 1) setSelectedMonth(monthRange[idx + 1]);
            }}
            disabled={monthRange.indexOf(selectedMonth) >= monthRange.length - 1}
            className="px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
          >
            &rarr;
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className={isTma ? 'flex gap-1 bg-gray-100 p-1 rounded-xl w-full overflow-x-auto no-scrollbar' : 'flex gap-1 bg-gray-100 p-1 rounded-xl w-fit'}>
        {(['overview', 'revenue', 'expenses', 'kpi'] as const).map((tab) => {
          const labels = { overview: 'Обзор', revenue: 'Выручка', expenses: 'Расходы', kpi: 'KPI' };
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`${isTma ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} font-medium rounded-lg transition-all ${
                activeTab === tab
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {labels[tab]}
            </button>
          );
        })}
      </div>

      {/* ═══════════ OVERVIEW TAB ═══════════ */}
      {activeTab === 'overview' && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <SummaryCard
              label="Выручка"
              value={formatCurrency(pnl.revenue)}
              sub={revenue.count > 0 ? `${revenue.count} проектов` : 'нет проектов'}
              trend={pnl.revenueGrowth}
            />
            <SummaryCard
              label="Расходы (факт)"
              value={expenseSummary.total.fact > 0 ? formatCurrency(pnl.expensesFact) : '—'}
              sub={expenseSummary.total.fact > 0 ? `план: ${formatCurrency(pnl.expensesPlan)}` : 'не заполнены'}
              color="red"
            />
            <SummaryCard
              label="Чистая прибыль"
              value={expenseSummary.total.fact > 0 ? formatCurrency(pnl.netProfitFact) : '—'}
              sub={expenseSummary.total.fact > 0 ? `маржа: ${formatPercent(pnl.marginFact)}` : 'заполните расходы'}
              color={pnl.netProfitFact >= 0 ? 'green' : 'red'}
            />
            <SummaryCard
              label="Продажи"
              value={formatCurrency(revenue.sales.total)}
              sub={`${revenue.sales.count} новых клиентов`}
            />
            <SummaryCard
              label="Продления"
              value={formatCurrency(revenue.renewals.total)}
              sub={`${revenue.renewals.count} продлений`}
            />
          </div>

          {/* Monthly P&L Mini Table */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">
                P&L — {formatMonthLabel(selectedMonth)}
              </h2>
            </div>
            <div className={`${sectionBodyClass} divide-y divide-gray-100`}>
              <PnlRow label="Выручка" value={pnl.revenue} bold />
              <PnlRow label="  Продажи (новые клиенты)" value={revenue.sales.total} indent />
              <PnlRow label="  Продления" value={revenue.renewals.total} indent />
              {revenueBySource.filter(s => s.total > 0).length > 0 && (
                <>
                  <div className="py-1" />
                  <div className="py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">По каналам</div>
                  {revenueBySource.map((src) => (
                    <PnlRow key={src.source} label={`  ${src.label}`} value={src.total} indent />
                  ))}
                </>
              )}
              <div className="py-2" />
              <PnlRow label="Расходы (факт)" value={-pnl.expensesFact} bold negative />
              <PnlRow label="  ФОТ" value={-expenseSummary.payroll.fact} indent negative />
              <PnlRow label="  Операционные" value={-expenseSummary.operations.fact} indent negative />
              <PnlRow label="  Налоги" value={-expenseSummary.taxes.fact} indent negative />
              <PnlRow label="  Маркетинг" value={-expenseSummary.marketing.fact} indent negative />
              {expenseSummary.additional.fact > 0 && (
                <PnlRow label="  Доп. расходы (оплаты)" value={-expenseSummary.additional.fact} indent negative />
              )}
              <div className="py-2" />
              <PnlRow
                label="Чистая прибыль"
                value={pnl.netProfitFact}
                bold
                highlight={pnl.netProfitFact >= 0 ? 'green' : 'red'}
              />
              <PnlRow label="Маржинальность" valueStr={formatPercent(pnl.marginFact)} bold />
              <PnlRow label="Маржинальность аутрич" valueStr={formatPercent(outreachPnl.margin)} bold />
              <PnlRow
                label="Прирост оборота (MoM)"
                valueStr={`${pnl.revenueGrowth > 0 ? '+' : ''}${formatPercent(pnl.revenueGrowth)}`}
                bold
                highlight={pnl.revenueGrowth > 0 ? 'green' : pnl.revenueGrowth < 0 ? 'red' : undefined}
              />
              <PnlRow
                label="Прирост чистой прибыли (MoM)"
                valueStr={`${extendedKpis.netProfitGrowthMoM > 0 ? '+' : ''}${formatPercent(extendedKpis.netProfitGrowthMoM)}`}
                bold
                highlight={extendedKpis.netProfitGrowthMoM > 0 ? 'green' : extendedKpis.netProfitGrowthMoM < 0 ? 'red' : undefined}
              />
            </div>
          </div>

          {/* Year Overview Chart */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">
                Годовая динамика — {selectedMonth.split('-')[0]}
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Месяц</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Выручка</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Расходы</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Прибыль</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase min-w-[200px]">Визуализация</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {yearlyData.map((d) => {
                    const maxRev = Math.max(...yearlyData.map((x) => x.revenue), 1);
                    const barWidth = (d.revenue / maxRev) * 100;
                    const isSelected = d.month === selectedMonth;
                    return (
                      <tr
                        key={d.month}
                        className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-50/50' : 'hover:bg-gray-50/50'}`}
                        onClick={() => setSelectedMonth(d.month)}
                      >
                        <td className={`px-4 py-3 text-sm ${isSelected ? 'font-bold text-blue-700' : 'text-gray-700'}`}>
                          {MONTH_NAMES[d.month.split('-')[1]] || d.month}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">{d.revenue > 0 ? formatCurrency(d.revenue) : '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-gray-500">{d.expenses > 0 ? formatCurrency(d.expenses) : '—'}</td>
                        <td className={`px-4 py-3 text-right text-sm font-medium ${d.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {d.revenue > 0 || d.expenses > 0 ? formatCurrency(d.profit) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${d.profit >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ REVENUE TAB ═══════════ */}
      {activeTab === 'revenue' && (
        <>
          {/* Revenue Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <SummaryCard label="Общая выручка" value={formatCurrency(revenue.total)} sub={`${revenue.count} проектов`} trend={pnl.revenueGrowth} />
            <SummaryCard label="Продажи (новые)" value={formatCurrency(revenue.sales.total)} sub={`${revenue.sales.count} клиентов`} />
            <SummaryCard label="Продления" value={formatCurrency(revenue.renewals.total)} sub={`${revenue.renewals.count} продлений`} />
          </div>

          {/* Revenue by Source */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">По каналам</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Канал</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Проектов</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Выручка</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Доля</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase min-w-[120px]">Визуализация</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {revenueBySource.map((src) => {
                    const maxSrc = Math.max(...revenueBySource.map((s) => s.total), 1);
                    const barWidth = (src.total / maxSrc) * 100;
                    return (
                      <tr key={src.source} className="hover:bg-gray-50/50">
                        <td className="px-4 py-2.5 text-sm font-medium text-gray-900">{src.label}</td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-500">{src.count}</td>
                        <td className="px-4 py-2.5 text-right text-sm font-medium text-gray-900">{formatCurrency(src.total)}</td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-500">
                          {revenue.total > 0 ? formatPercent((src.total / revenue.total) * 100) : '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-blue-400 transition-all" style={{ width: `${barWidth}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* By Client */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className={sectionHeaderClass}>
                <h2 className="text-lg font-bold text-gray-900">По клиентам</h2>
              </div>
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="min-w-full divide-y divide-gray-100">
                  <thead className="bg-gray-50/50 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Клиент</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Проекты</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Выручка</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {clientStats.map((c) => (
                      <tr key={c.name} className="hover:bg-gray-50/50">
                        <td className="px-4 py-2 text-sm font-medium text-gray-900 max-w-[200px] truncate">{c.name}</td>
                        <td className="px-4 py-2 text-right text-sm text-gray-500">{c.count}</td>
                        <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">{formatCurrency(c.revenue)}</td>
                        <td className="px-4 py-2 text-right text-sm text-emerald-600">{formatCurrency(c.margin)}</td>
                      </tr>
                    ))}
                    {clientStats.length === 0 && (
                      <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">Нет данных за этот месяц</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* By Specialist */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className={sectionHeaderClass}>
                <h2 className="text-lg font-bold text-gray-900">По специалистам</h2>
              </div>
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="min-w-full divide-y divide-gray-100">
                  <thead className="bg-gray-50/50 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Специалист</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Проекты</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Выручка</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {specialistStats.map((s) => (
                      <tr key={s.name} className="hover:bg-gray-50/50">
                        <td className="px-4 py-2 text-sm font-medium text-gray-900">{s.name}</td>
                        <td className="px-4 py-2 text-right text-sm text-gray-500">{s.count}</td>
                        <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">{formatCurrency(s.revenue)}</td>
                        <td className="px-4 py-2 text-right text-sm text-emerald-600">{formatCurrency(s.margin)}</td>
                      </tr>
                    ))}
                    {specialistStats.length === 0 && (
                      <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">Нет данных за этот месяц</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Project Details */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">Детализация по проектам</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Клиент</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Услуги</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Тип</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Бюджет</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа %</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Себестоимость</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {monthlyProjects.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2 text-sm font-medium text-gray-900 max-w-[200px] truncate">{p.client}</td>
                      <td className="px-4 py-2 text-sm text-gray-500 max-w-[200px]">
                        <div className="flex flex-wrap gap-1">
                          {p.name.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0).map((service: string, idx: number) => (
                            <span key={idx} className="inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-700/10">
                              {service}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-sm">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                          p.isRenewal
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}>
                          {p.isRenewal ? 'Продление' : 'Продажа'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">{formatCurrency(p.budget)}</td>
                      <td className="px-4 py-2 text-right text-sm text-gray-500">{formatPercent(p.marginPercent)}</td>
                      <td className="px-4 py-2 text-right text-sm text-emerald-600 font-medium">{formatCurrency(p.marginValue)}</td>
                      <td className="px-4 py-2 text-right text-sm text-gray-500">{formatCurrency(p.cost)}</td>
                    </tr>
                  ))}
                  {monthlyProjects.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">Нет проектов за этот месяц</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ EXPENSES TAB ═══════════ */}
      {activeTab === 'expenses' && (
        <ExpensesTab
          expenses={currentExpenses}
          summary={expenseSummary}
          onUpdate={(updated) => updateExpenses(selectedMonth, updated)}
          additionalExpenses={additionalExpenses}
        />
      )}

      {/* ═══════════ KPI TAB ═══════════ */}
      {activeTab === 'kpi' && (
        <>
          {/* Section 1: Общие показатели */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">Общие показатели</h2>
            </div>
            <div className={`${sectionBodyClass} divide-y divide-gray-100`}>
              <MetricRow label="Оборот" value={formatCurrency(pnl.revenue)} />
              <MetricRow label="Расход компании" value={formatCurrency(pnl.expensesFact)} />
              <MetricRow label="Итого чистая прибыль" value={formatCurrency(pnl.netProfitFact)} highlight={pnl.netProfitFact >= 0 ? 'green' : 'red'} />
              <MetricRow label="Маржинальность" value={formatPercent(pnl.marginFact)} />
              <MetricRow
                label="Прирост оборота (MoM)"
                value={formatPercent(pnl.revenueGrowth)}
                highlight={pnl.revenueGrowth > 0 ? 'green' : pnl.revenueGrowth < 0 ? 'red' : undefined}
              />
              <MetricRow
                label="Прирост чистой прибыли (MoM)"
                value={formatPercent(extendedKpis.netProfitGrowthMoM)}
                highlight={extendedKpis.netProfitGrowthMoM > 0 ? 'green' : extendedKpis.netProfitGrowthMoM < 0 ? 'red' : undefined}
              />
            </div>
          </div>

          {/* Section 2: Аутрич направление */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">Аутрич направление</h2>
            </div>
            <div className={`${sectionBodyClass} divide-y divide-gray-100`}>
              <MetricRow label="Выручка аутрич" value={formatCurrency(outreachPnl.revenue)} />
              <MetricRow label="Чистая прибыль аутрич" value={formatCurrency(outreachPnl.netProfit)} highlight={outreachPnl.netProfit >= 0 ? 'green' : 'red'} />
              <MetricRow label="Маржинальность аутрич" value={formatPercent(outreachPnl.margin)} />
              <MetricRow
                label="Прирост оборота аутрич (MoM)"
                value={formatPercent(outreachPnl.revenueGrowth)}
                highlight={outreachPnl.revenueGrowth > 0 ? 'green' : outreachPnl.revenueGrowth < 0 ? 'red' : undefined}
              />
              <MetricRow
                label="Прирост чистой аутрич (MoM)"
                value={formatPercent(outreachPnl.netProfitGrowth)}
                highlight={outreachPnl.netProfitGrowth > 0 ? 'green' : outreachPnl.netProfitGrowth < 0 ? 'red' : undefined}
              />
            </div>
          </div>

          {/* Section 3: Клиенты и продажи */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">Клиенты и продажи</h2>
            </div>
            <div className={sectionBodyClass}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-0 divide-y divide-gray-100">
                  <h4 className="text-sm font-semibold text-gray-500 uppercase pb-3">Продажи (новые клиенты)</h4>
                  <MetricRow label="Количество новых клиентов" value={String(kpis.newClientCount)} />
                  <MetricRow label="Выручка продажи" value={formatCurrency(revenue.sales.total)} />
                  <MetricRow label="Средний чек продаж" value={kpis.avgSalesCheck > 0 ? formatCurrency(kpis.avgSalesCheck) : '—'} />
                </div>
                <div className="space-y-0 divide-y divide-gray-100">
                  <h4 className="text-sm font-semibold text-gray-500 uppercase pb-3">Продления</h4>
                  <MetricRow label="Количество продлений" value={String(kpis.renewalCount)} />
                  <MetricRow label="Выручка продления" value={formatCurrency(revenue.renewals.total)} />
                  <MetricRow label="Средний чек продлений" value={kpis.avgRenewalCheck > 0 ? formatCurrency(kpis.avgRenewalCheck) : '—'} />
                  <MetricRow label="Доля продлений от оборота" value={formatPercent(kpis.renewalShare)} />
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-gray-100 divide-y divide-gray-100">
                <MetricRow label="Количество активных клиентов" value={String(kpis.activeClients)} />
                <MetricRow
                  label="% оттока"
                  value={formatPercent(kpis.churnRate)}
                  highlight={kpis.churnRate > 20 ? 'red' : kpis.churnRate > 10 ? 'amber' : 'green'}
                />
                <MetricRow label="Отвал (клиентов)" value={String(extendedKpis.churnedAbsolute)} highlight={extendedKpis.churnedAbsolute > 0 ? 'red' : 'green'} />
              </div>
            </div>
          </div>

          {/* Section 4: Выручка по каналам */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={sectionHeaderClass}>
              <h2 className="text-lg font-bold text-gray-900">Выручка по каналам</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Канал</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Проектов</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Выручка</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Доля</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Пред. месяц</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Рост</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {revenueBySource.map((src) => (
                    <tr key={src.source} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 text-sm font-medium text-gray-900">{src.label}</td>
                      <td className="px-4 py-2.5 text-right text-sm text-gray-500">{src.count}</td>
                      <td className="px-4 py-2.5 text-right text-sm font-medium text-gray-900">{formatCurrency(src.total)}</td>
                      <td className="px-4 py-2.5 text-right text-sm text-gray-500">
                        {revenue.total > 0 ? formatPercent((src.total / revenue.total) * 100) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-sm text-gray-400">{src.prevTotal > 0 ? formatCurrency(src.prevTotal) : '—'}</td>
                      <td className={`px-4 py-2.5 text-right text-sm font-medium ${
                        src.growth > 0 ? 'text-emerald-600' : src.growth < 0 ? 'text-red-500' : 'text-gray-400'
                      }`}>
                        {src.prevTotal > 0 ? `${src.growth > 0 ? '+' : ''}${formatPercent(src.growth)}` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50/50 font-semibold">
                    <td className="px-4 py-2.5 text-sm text-gray-900">Итого</td>
                    <td className="px-4 py-2.5 text-right text-sm text-gray-700">{revenue.count}</td>
                    <td className="px-4 py-2.5 text-right text-sm text-gray-900">{formatCurrency(revenue.total)}</td>
                    <td className="px-4 py-2.5 text-right text-sm text-gray-500">100%</td>
                    <td className="px-4 py-2.5 text-right text-sm text-gray-400">{prevRevenue.total > 0 ? formatCurrency(prevRevenue.total) : '—'}</td>
                    <td className={`px-4 py-2.5 text-right text-sm font-medium ${
                      pnl.revenueGrowth > 0 ? 'text-emerald-600' : pnl.revenueGrowth < 0 ? 'text-red-500' : 'text-gray-400'
                    }`}>
                      {prevRevenue.total > 0 ? `${pnl.revenueGrowth > 0 ? '+' : ''}${formatPercent(pnl.revenueGrowth)}` : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/30">
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-gray-500">Выручка лидскан итого: <strong className="text-gray-900">{formatCurrency(extendedKpis.leadscanRevenue)}</strong></span>
                <span className="text-gray-500">Выручка перфоманс итого: <strong className="text-gray-900">{formatCurrency(extendedKpis.performanceRevenue)}</strong></span>
                <span className="text-gray-500">Выручка линкедин итого: <strong className="text-gray-900">{formatCurrency(extendedKpis.linkedinRevenue)}</strong></span>
                <span className="text-gray-500">Выручка телеграм итого: <strong className="text-gray-900">{formatCurrency(extendedKpis.telegramRevenue)}</strong></span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ MISSING DATA NOTICE ═══════════ */}
      <MissingFieldsNotice />
    </div>
  );
}

/* ═══════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════ */

function SummaryCard({
  label, value, sub, color, trend,
}: {
  label: string; value: string; sub?: string; color?: 'green' | 'red'; trend?: number;
}) {
  const isTma = useIsTma();
  return (
    <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
      <div className="text-sm font-medium text-gray-500 mb-1">{label}</div>
      <p className={`text-2xl font-bold ${
        color === 'green' ? 'text-emerald-700' : color === 'red' ? 'text-red-700' : 'text-gray-900'
      }`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
      {trend !== undefined && trend !== 0 && (
        <p className={`text-xs mt-1 font-medium ${trend > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {trend > 0 ? '+' : ''}{formatPercent(trend)} к пред. месяцу
        </p>
      )}
    </div>
  );
}

function PnlRow({
  label, value, valueStr, bold, indent, negative, highlight,
}: {
  label: string; value?: number; valueStr?: string; bold?: boolean; indent?: boolean; negative?: boolean; highlight?: 'green' | 'red';
}) {
  const displayValue = valueStr || (value !== undefined ? formatCurrency(value) : '—');
  return (
    <div className={`flex justify-between items-center py-2 ${indent ? 'pl-4' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>{label}</span>
      <span className={`text-sm font-mono ${
        highlight === 'green' ? 'font-bold text-emerald-600'
          : highlight === 'red' ? 'font-bold text-red-600'
          : negative && value !== undefined && value < 0 ? 'text-red-500'
          : bold ? 'font-semibold text-gray-900'
          : 'text-gray-700'
      }`}>
        {displayValue}
      </span>
    </div>
  );
}

function MetricRow({ label, value, highlight }: { label: string; value: string; highlight?: 'green' | 'red' | 'amber' }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-medium ${
        highlight === 'green' ? 'text-emerald-600'
          : highlight === 'red' ? 'text-red-600'
          : highlight === 'amber' ? 'text-amber-600'
          : 'text-gray-900'
      }`}>
        {value}
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════
   EXPENSES TAB
   ═══════════════════════════════════════════ */

function ExpensesTab({
  expenses, summary, onUpdate, additionalExpenses,
}: {
  expenses: MonthlyExpenses;
  summary: MonthlyExpensesSummary;
  onUpdate: (updated: MonthlyExpenses) => void;
  additionalExpenses: { total: number; count: number; items: ApprovedPayment[] };
}) {
  const isTma = useIsTma();
  const categories: { key: keyof MonthlyExpenses; label: string; summaryKey: keyof MonthlyExpensesSummary }[] = [
    { key: 'payroll', label: 'ФОТ (зарплаты)', summaryKey: 'payroll' },
    { key: 'operations', label: 'Операционные расходы (подписки, инструменты)', summaryKey: 'operations' },
    { key: 'taxes', label: 'Налоги и обязательные платежи', summaryKey: 'taxes' },
    { key: 'marketing', label: 'Маркетинг и продвижение', summaryKey: 'marketing' },
  ];

  const addRow = (category: keyof MonthlyExpenses) => {
    const updated = { ...expenses };
    updated[category] = [...updated[category], { category, name: '', plan: 0, fact: 0 }];
    onUpdate(updated);
  };

  const updateRow = (category: keyof MonthlyExpenses, index: number, field: keyof ExpenseRow, value: string | number) => {
    const updated = { ...expenses };
    updated[category] = updated[category].map((row, i) =>
      i === index ? { ...row, [field]: field === 'name' ? value : Number(value) || 0 } : row,
    );
    onUpdate(updated);
  };

  const removeRow = (category: keyof MonthlyExpenses, index: number) => {
    const updated = { ...expenses };
    updated[category] = updated[category].filter((_, i) => i !== index);
    onUpdate(updated);
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <SummaryCard label="ФОТ (факт)" value={summary.payroll.fact > 0 ? formatCurrency(summary.payroll.fact) : '—'} sub={summary.payroll.plan > 0 ? `план: ${formatCurrency(summary.payroll.plan)}` : undefined} />
        <SummaryCard label="Операционные (факт)" value={summary.operations.fact > 0 ? formatCurrency(summary.operations.fact) : '—'} sub={summary.operations.plan > 0 ? `план: ${formatCurrency(summary.operations.plan)}` : undefined} />
        <SummaryCard label="Налоги (факт)" value={summary.taxes.fact > 0 ? formatCurrency(summary.taxes.fact) : '—'} sub={summary.taxes.plan > 0 ? `план: ${formatCurrency(summary.taxes.plan)}` : undefined} />
        <SummaryCard label="Маркетинг (факт)" value={summary.marketing.fact > 0 ? formatCurrency(summary.marketing.fact) : '—'} sub={summary.marketing.plan > 0 ? `план: ${formatCurrency(summary.marketing.plan)}` : undefined} />
        <SummaryCard label="Доп. расходы (оплаты)" value={summary.additional.fact > 0 ? formatCurrency(summary.additional.fact) : '—'} sub={`${additionalExpenses.count} согласованных`} />
        <SummaryCard
          label="Итого расходы (факт)"
          value={summary.total.fact > 0 ? formatCurrency(summary.total.fact) : '—'}
          sub={summary.total.plan > 0 ? `план: ${formatCurrency(summary.total.plan)}` : undefined}
          color="red"
        />
      </div>

      {/* Expense Categories */}
      {categories.map(({ key, label }) => {
        const rows = expenses[key] || [];
        const catSummary = summary[key as keyof MonthlyExpensesSummary] as { plan: number; fact: number };
        return (
          <div key={key} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-100 bg-gray-50/50 flex items-center justify-between`}>
              <div>
                <h3 className="text-base font-bold text-gray-900">{label}</h3>
                {catSummary.fact > 0 && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    Факт: {formatCurrency(catSummary.fact)} / План: {formatCurrency(catSummary.plan)}
                  </p>
                )}
              </div>
              <button
                onClick={() => addRow(key)}
                className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
              >
                + Добавить строку
              </button>
            </div>
            {rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-100">
                  <thead className="bg-gray-50/30">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 w-[40%]">Название</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 w-[20%]">План</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 w-[20%]">Факт</th>
                      <th className="px-4 py-2 w-[60px]"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map((row, idx) => (
                      <tr key={idx} className="group">
                        <td className="px-4 py-1.5">
                          <input
                            type="text"
                            value={row.name}
                            onChange={(e) => updateRow(key, idx, 'name', e.target.value)}
                            placeholder="Название..."
                            className="w-full text-sm text-gray-900 bg-transparent border-0 border-b border-transparent focus:border-gray-300 outline-none py-1"
                          />
                        </td>
                        <td className="px-4 py-1.5">
                          <input
                            type="number"
                            value={row.plan || ''}
                            onChange={(e) => updateRow(key, idx, 'plan', e.target.value)}
                            placeholder="0"
                            className="w-full text-sm text-right text-gray-700 bg-transparent border-0 border-b border-transparent focus:border-gray-300 outline-none py-1"
                          />
                        </td>
                        <td className="px-4 py-1.5">
                          <input
                            type="number"
                            value={row.fact || ''}
                            onChange={(e) => updateRow(key, idx, 'fact', e.target.value)}
                            placeholder="0"
                            className="w-full text-sm text-right text-gray-900 font-medium bg-transparent border-0 border-b border-transparent focus:border-gray-300 outline-none py-1"
                          />
                        </td>
                        <td className="px-4 py-1.5 text-center">
                          <button
                            onClick={() => removeRow(key, idx)}
                            className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          >
                            x
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length > 1 && (
                      <tr className="bg-gray-50/50">
                        <td className="px-4 py-2 text-sm font-semibold text-gray-700">Итого</td>
                        <td className="px-4 py-2 text-right text-sm font-semibold text-gray-700">
                          {formatNumber(catSummary.plan)}
                        </td>
                        <td className="px-4 py-2 text-right text-sm font-semibold text-gray-900">
                          {formatNumber(catSummary.fact)}
                        </td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-6 py-6 text-center text-sm text-gray-400">
                Нет записей. Нажмите «+ Добавить строку» чтобы начать
              </div>
            )}
          </div>
        );
      })}

      {/* Additional expenses from approved payment requests */}
      {additionalExpenses.items.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-100 bg-gray-50/50`}>
            <h3 className="text-base font-bold text-gray-900">Доп. расходы (согласованные оплаты)</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {additionalExpenses.count} запросов на {formatCurrency(additionalExpenses.total)}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50/30">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Описание</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Отдел</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">Сумма</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {additionalExpenses.items.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-2 text-sm text-gray-900">{p.description}</td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {({ outreach: 'Аутрич', paid_traffic: 'Платный трафик', accounting: 'Аккаунтинг', sales: 'Продажи' } as Record<string, string>)[p.department] || p.department}
                    </td>
                    <td className="px-4 py-2 text-right text-sm font-medium text-gray-900">{formatCurrency(Number(p.amount))}</td>
                  </tr>
                ))}
                <tr className="bg-gray-50/50">
                  <td className="px-4 py-2 text-sm font-semibold text-gray-700" colSpan={2}>Итого</td>
                  <td className="px-4 py-2 text-right text-sm font-semibold text-gray-900">{formatCurrency(additionalExpenses.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className={`bg-amber-50 border border-amber-200 rounded-2xl ${isTma ? 'p-4' : 'p-5'}`}>
        <h4 className="text-sm font-semibold text-amber-800 mb-1">Данные хранятся локально</h4>
        <p className="text-sm text-amber-700">
          Расходы сохраняются в браузере (localStorage). Для совместного доступа рекомендуется
          создать таблицу finance_expenses в Supabase — см. раздел «Недостающие данные» внизу страницы.
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MISSING FIELDS NOTICE
   ═══════════════════════════════════════════ */

function MissingFieldsNotice() {
  const [expanded, setExpanded] = useState(false);
  const isTma = useIsTma();

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`${isTma ? 'w-full px-4 py-3' : 'w-full px-6 py-4'} flex items-center justify-between text-left hover:bg-gray-100 transition-colors`}
      >
        <span className="text-sm font-semibold text-gray-700">
          Недостающие данные для полной финансовой модели
        </span>
        <span className="text-gray-400 text-xs">{expanded ? 'свернуть' : 'развернуть'}</span>
      </button>
      {expanded && (
        <div className={`${isTma ? 'px-4 pb-6' : 'px-6 pb-6'} space-y-4`}>
          {/* Fields to add to projects */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2">1. Поля для таблицы projects</h4>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="min-w-full divide-y divide-gray-100 text-sm">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold text-gray-500">Поле</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-500">Тип</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-500">Зачем нужно</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">project_type</td>
                    <td className="px-4 py-2 text-gray-600">text</td>
                    <td className="px-4 py-2 text-gray-600">Продажа / Продление — сейчас определяется эвристикой по имени клиента</td>
                  </tr>
                  <tr className="bg-emerald-50/50">
                    <td className="px-4 py-2 font-mono text-xs text-emerald-700">lead_source</td>
                    <td className="px-4 py-2 text-gray-600">text</td>
                    <td className="px-4 py-2 text-emerald-700">Используется для разбивки по каналам (Аутрич / Телеграм / Лидскан / ЛинкедИн / Перфоманс)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">payment_date</td>
                    <td className="px-4 py-2 text-gray-600">date</td>
                    <td className="px-4 py-2 text-gray-600">Дата оплаты — для точного разнесения по месяцам</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Expenses table */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2">2. Таблица finance_expenses (для общих расходов)</h4>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="min-w-full divide-y divide-gray-100 text-sm">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold text-gray-500">Колонка</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-500">Тип</th>
                    <th className="px-4 py-2 text-left font-semibold text-gray-500">Описание</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">id</td>
                    <td className="px-4 py-2 text-gray-600">uuid (PK)</td>
                    <td className="px-4 py-2 text-gray-600">Первичный ключ</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">month</td>
                    <td className="px-4 py-2 text-gray-600">text</td>
                    <td className="px-4 py-2 text-gray-600">Месяц в формате YYYY-MM</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">category</td>
                    <td className="px-4 py-2 text-gray-600">text</td>
                    <td className="px-4 py-2 text-gray-600">payroll / operations / taxes / marketing</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">name</td>
                    <td className="px-4 py-2 text-gray-600">text</td>
                    <td className="px-4 py-2 text-gray-600">Название позиции (имя сотрудника, инструмент и т.д.)</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">plan_amount</td>
                    <td className="px-4 py-2 text-gray-600">numeric</td>
                    <td className="px-4 py-2 text-gray-600">Плановая сумма</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700">fact_amount</td>
                    <td className="px-4 py-2 text-gray-600">numeric</td>
                    <td className="px-4 py-2 text-gray-600">Фактическая сумма</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Current limitations */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2">3. Текущие ограничения</h4>
            <ul className="space-y-1.5 text-sm text-gray-600">
              <li className="flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">*</span>
                <span><strong>Продление / Продажа</strong> — определяется автоматически: если клиент встречается впервые — это продажа, если повторно — продление. Для точности нужно поле project_type.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">*</span>
                <span><strong>Месяц выручки</strong> — определяется по contract_date или launch_date. Если дата не указана — выручка попадает в текущий месяц. Для точности нужно поле payment_date.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-500 mt-0.5">+</span>
                <span><strong>Источник выручки</strong> — используется поле lead_source из таблицы projects. Разбивка по каналам (Аутрич, Телеграм, Лидскан, ЛинкедИн, Перфоманс) работает.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">*</span>
                <span><strong>Расходы</strong> — ФОТ, подписки, налоги, маркетинг хранятся в localStorage. Для совместного доступа нужна таблица finance_expenses в Supabase.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">*</span>
                <span><strong>План/Факт бюджета</strong> — поле budget (Выручка / сумма договора) используется как фактическая выручка.</span>
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
