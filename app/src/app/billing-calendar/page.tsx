'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { UserRole } from '@/types';
import { isTechnician, isLead } from '@/lib/roles';

/* ═══════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════ */

interface EmailSubscription {
  id: string;
  project_id: string | null;
  project_name: string;
  email_provider: string;
  email_count: number;
  next_billing_date: string;
  billing_amount: number;
  currency: string;
  billing_cycle: 'monthly' | 'quarterly' | 'yearly';
  status: 'active' | 'pending_review' | 'keep' | 'cancel' | 'expired';
  lead_decision: 'keep' | 'cancel' | null;
  lead_decision_by: string | null;
  lead_decision_at: string | null;
  lead_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  notes: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
  client: string;
}

type ModalMode = 'create' | 'edit' | 'decision' | 'pay_today';

/* ═══════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════ */

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const CYCLE_LABELS: Record<string, string> = {
  monthly: 'Ежемесячно',
  quarterly: 'Ежеквартально',
  yearly: 'Ежегодно',
};

const SETUP_SQL = `CREATE TABLE IF NOT EXISTS email_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_name TEXT NOT NULL,
  email_provider TEXT NOT NULL DEFAULT '',
  email_count INTEGER NOT NULL DEFAULT 1,
  next_billing_date DATE NOT NULL,
  billing_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_review', 'keep', 'cancel', 'expired')),
  lead_decision TEXT
    CHECK (lead_decision IS NULL OR lead_decision IN ('keep', 'cancel')),
  lead_decision_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  lead_decision_at TIMESTAMPTZ,
  lead_notes TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_subscriptions_billing_date ON email_subscriptions(next_billing_date);
CREATE INDEX IF NOT EXISTS idx_email_subscriptions_status ON email_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_email_subscriptions_project ON email_subscriptions(project_id);

ALTER TABLE email_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_subscriptions_select" ON email_subscriptions FOR SELECT TO authenticated USING (true);
CREATE POLICY "email_subscriptions_insert" ON email_subscriptions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "email_subscriptions_update" ON email_subscriptions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "email_subscriptions_delete" ON email_subscriptions FOR DELETE TO authenticated USING (true);

CREATE OR REPLACE FUNCTION update_email_subscriptions_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER email_subscriptions_updated_at BEFORE UPDATE ON email_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_email_subscriptions_updated_at();`;

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  active: { label: 'Активна', bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  pending_review: { label: 'Ожидает решения', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  keep: { label: 'Оставить', bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancel: { label: 'Отменить', bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  expired: { label: 'Истекла', bg: 'bg-gray-100', text: 'text-gray-500', dot: 'bg-gray-400' },
};

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function formatCurrency(amount: number, currency: string): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', RUB: '₽' };
  const symbol = symbols[currency] || currency;
  return `${symbol}${amount.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1; // Monday = 0
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysBetween(dateStr1: string, dateStr2: string): number {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

function todayStr(): string {
  const d = new Date();
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

function getNextMonthDate(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDate();
  const nextMonth = d.getMonth() + 1;
  const nextYear = nextMonth > 11 ? d.getFullYear() + 1 : d.getFullYear();
  const normalizedMonth = nextMonth % 12;
  const daysInNext = new Date(nextYear, normalizedMonth + 1, 0).getDate();
  return toDateStr(nextYear, normalizedMonth, Math.min(day, daysInNext));
}

/* ═══════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════ */

export default function BillingCalendarPage() {
  const [subscriptions, setSubscriptions] = useState<EmailSubscription[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Calendar state
  const now = new Date();
  const [currentYear, setCurrentYear] = useState(now.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(now.getMonth());

  // Day popover state
  const [dayPopover, setDayPopover] = useState<{ dateStr: string; rect: DOMRect } | null>(null);
  const dayPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dayPopover) return;
    const handler = (e: MouseEvent) => {
      if (dayPopoverRef.current && !dayPopoverRef.current.contains(e.target as Node)) {
        setDayPopover(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dayPopover]);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('create');
  const [editingItem, setEditingItem] = useState<EmailSubscription | null>(null);

  // View mode
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');

  // Form state
  const [form, setForm] = useState({
    project_id: '',
    project_name: '',
    email_provider: '',
    email_count: 1,
    next_billing_date: '',
    billing_amount: 0,
    currency: 'USD',
    billing_cycle: 'monthly' as 'monthly' | 'quarterly' | 'yearly',
    notes: '',
  });

  // Decision form state
  const [decisionForm, setDecisionForm] = useState({
    decision: '' as 'keep' | 'cancel' | '',
    notes: '',
  });

  /* ─── Auth & Data Fetching ─── */

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;

      setUserId(session.user.id);

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .single();

      if (profile) setUserRole(profile.role as UserRole);
    }
    init();
  }, []);

  // Table existence state
  const [tableExists, setTableExists] = useState(true);
  const [sqlCopied, setSqlCopied] = useState(false);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('email_subscriptions')
        .select('*')
        .order('next_billing_date', { ascending: true });

      if (error) {
        // Check if table doesn't exist
        if (error.code === 'PGRST205' || error.message?.includes('email_subscriptions')) {
          setTableExists(false);
          return;
        }
        throw error;
      }
      setTableExists(true);
      setSubscriptions(data || []);
    } catch (err) {
      console.error('Error fetching subscriptions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, client')
        .order('name');

      if (error) throw error;
      setProjects(data || []);
    } catch (err) {
      console.error('Error fetching projects:', err);
    }
  }, []);

  useEffect(() => {
    fetchSubscriptions();
    fetchProjects();
  }, [fetchSubscriptions, fetchProjects]);

  /* ─── Auto-update status to pending_review 2 days before billing ─── */

  useEffect(() => {
    if (subscriptions.length === 0) return;

    const today = todayStr();
    const toUpdate: string[] = [];

    subscriptions.forEach((sub) => {
      if (sub.status === 'active') {
        const daysUntil = daysBetween(today, sub.next_billing_date);
        if (daysUntil <= 2 && daysUntil >= 0) {
          toUpdate.push(sub.id);
        }
      }
    });

    if (toUpdate.length > 0) {
      (async () => {
        await supabase
          .from('email_subscriptions')
          .update({ status: 'pending_review' })
          .in('id', toUpdate);
        fetchSubscriptions();
      })();
    }
  }, [subscriptions, fetchSubscriptions]);

  /* ─── Calendar Data ─── */

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);

  const subscriptionsByDate = useMemo(() => {
    const map = new Map<string, EmailSubscription[]>();
    subscriptions.forEach((sub) => {
      const existing = map.get(sub.next_billing_date) || [];
      existing.push(sub);
      map.set(sub.next_billing_date, existing);
    });
    return map;
  }, [subscriptions]);

  /* ─── Navigation ─── */

  function prevMonth() {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  }

  function nextMonth() {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  }

  function goToToday() {
    const now = new Date();
    setCurrentYear(now.getFullYear());
    setCurrentMonth(now.getMonth());
  }

  /* ─── CRUD ─── */

  function openCreateModal(date?: string) {
    setModalMode('create');
    setEditingItem(null);
    setForm({
      project_id: '',
      project_name: '',
      email_provider: '',
      email_count: 1,
      next_billing_date: date || todayStr(),
      billing_amount: 0,
      currency: 'USD',
      billing_cycle: 'monthly',
      notes: '',
    });
    setModalOpen(true);
  }

  function openPayTodayModal() {
    setModalMode('pay_today');
    setEditingItem(null);
    setForm({
      project_id: '',
      project_name: '',
      email_provider: '',
      email_count: 1,
      next_billing_date: todayStr(),
      billing_amount: 0,
      currency: 'USD',
      billing_cycle: 'monthly',
      notes: '',
    });
    setModalOpen(true);
  }

  function openEditModal(item: EmailSubscription) {
    setModalMode('edit');
    setEditingItem(item);
    setForm({
      project_id: item.project_id || '',
      project_name: item.project_name,
      email_provider: item.email_provider,
      email_count: item.email_count,
      next_billing_date: item.next_billing_date,
      billing_amount: item.billing_amount,
      currency: item.currency,
      billing_cycle: item.billing_cycle,
      notes: item.notes || '',
    });
    setModalOpen(true);
  }

  function openDecisionModal(item: EmailSubscription) {
    setModalMode('decision');
    setEditingItem(item);
    setDecisionForm({
      decision: item.lead_decision || '',
      notes: item.lead_notes || '',
    });
    setModalOpen(true);
  }

  async function handleSave() {
    if (!form.project_name.trim() || !form.next_billing_date) return;

    const payload = {
      project_id: form.project_id || null,
      project_name: form.project_name,
      email_provider: form.email_provider,
      email_count: form.email_count,
      next_billing_date: form.next_billing_date,
      billing_amount: form.billing_amount,
      currency: form.currency,
      billing_cycle: form.billing_cycle,
      notes: form.notes || null,
    };

    try {
      if (modalMode === 'create') {
        await supabase
          .from('email_subscriptions')
          .insert({ ...payload, created_by: userId, status: 'active' });
      } else if (modalMode === 'pay_today') {
        await supabase
          .from('email_subscriptions')
          .insert({
            ...payload,
            next_billing_date: todayStr(),
            created_by: userId,
            status: 'keep',
            lead_decision: 'keep',
            lead_decision_by: userId,
            lead_decision_at: new Date().toISOString(),
          });
        await supabase
          .from('email_subscriptions')
          .insert({
            ...payload,
            next_billing_date: getNextMonthDate(todayStr()),
            created_by: userId,
            status: 'active',
          });
      } else if (modalMode === 'edit' && editingItem) {
        await supabase
          .from('email_subscriptions')
          .update(payload)
          .eq('id', editingItem.id);
      }

      setModalOpen(false);
      fetchSubscriptions();
    } catch (err) {
      console.error('Error saving:', err);
    }
  }

  async function handleDecisionSave() {
    if (!editingItem || !decisionForm.decision) return;

    try {
      await supabase
        .from('email_subscriptions')
        .update({
          lead_decision: decisionForm.decision,
          lead_notes: decisionForm.notes || null,
          lead_decision_by: userId,
          lead_decision_at: new Date().toISOString(),
          status: decisionForm.decision,
        })
        .eq('id', editingItem.id);

      if (decisionForm.decision === 'keep') {
        await supabase
          .from('email_subscriptions')
          .insert({
            project_id: editingItem.project_id,
            project_name: editingItem.project_name,
            email_provider: editingItem.email_provider,
            email_count: editingItem.email_count,
            next_billing_date: getNextMonthDate(editingItem.next_billing_date),
            billing_amount: editingItem.billing_amount,
            currency: editingItem.currency,
            billing_cycle: editingItem.billing_cycle,
            notes: editingItem.notes,
            created_by: editingItem.created_by,
            status: 'active',
          });
      }

      setModalOpen(false);
      fetchSubscriptions();
    } catch (err) {
      console.error('Error saving decision:', err);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить эту запись?')) return;
    try {
      await supabase.from('email_subscriptions').delete().eq('id', id);
      fetchSubscriptions();
    } catch (err) {
      console.error('Error deleting:', err);
    }
  }

  function handleProjectSelect(projectId: string) {
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      setForm((prev) => ({
        ...prev,
        project_id: projectId,
        project_name: `${project.client} — ${project.name}`,
      }));
    }
  }

  /* ─── Stats ─── */

  const stats = useMemo(() => {
    const today = todayStr();
    const activeCount = subscriptions.filter((s) => s.status === 'active' || s.status === 'pending_review' || s.status === 'keep').length;
    const pendingCount = subscriptions.filter((s) => s.status === 'pending_review').length;
    const thisMonthSubs = subscriptions.filter((s) => {
      const d = new Date(s.next_billing_date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth && s.status === 'keep';
    });
    const monthTotal = thisMonthSubs.reduce((sum, s) => sum + s.billing_amount, 0);
    const upcomingCount = subscriptions.filter((s) => {
      const daysUntil = daysBetween(today, s.next_billing_date);
      return daysUntil >= 0 && daysUntil <= 7 && (s.status === 'active' || s.status === 'pending_review');
    }).length;

    return { activeCount, pendingCount, monthTotal, upcomingCount };
  }, [subscriptions, currentYear, currentMonth]);

  /* ─── Render ─── */

  if (loading && subscriptions.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400 text-sm">Загрузка календаря...</div>
      </div>
    );
  }

  // Show setup instructions if table doesn't exist
  if (!tableExists) {
    return (
      <div className="space-y-6 max-w-[900px] mx-auto">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Календарь почт</h1>
          <p className="mt-1 text-sm text-gray-500">Требуется настройка базы данных</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6">
          <h2 className="text-lg font-bold text-amber-800 mb-2">Таблица email_subscriptions не найдена</h2>
          <p className="text-sm text-amber-700 mb-4">
            Для работы календаря необходимо создать таблицу в Supabase. Скопируйте SQL ниже и выполните его
            в <a href="https://supabase.com/dashboard/project/whhkkmfcmstawodnghzw/sql/new" target="_blank" rel="noopener noreferrer" className="underline font-medium">Supabase SQL Editor</a>.
          </p>
          <div className="relative">
            <pre className="bg-gray-900 text-gray-100 rounded-xl p-4 text-xs overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre">
{SETUP_SQL}
            </pre>
            <button
              onClick={() => {
                navigator.clipboard.writeText(SETUP_SQL);
                setSqlCopied(true);
                setTimeout(() => setSqlCopied(false), 2000);
              }}
              className="absolute top-3 right-3 px-3 py-1.5 text-xs font-medium bg-white text-gray-800 rounded-lg hover:bg-gray-100 transition-colors shadow"
            >
              {sqlCopied ? 'Скопировано!' : 'Копировать SQL'}
            </button>
          </div>
          <button
            onClick={() => { setTableExists(true); fetchSubscriptions(); }}
            className="mt-4 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Проверить снова
          </button>
        </div>
      </div>
    );
  }

  const today = todayStr();

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Календарь почт</h1>
          <p className="mt-1 text-sm text-gray-500">
            Управление сроками оплаты email-аккаунтов по проектам
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex bg-gray-100 p-0.5 rounded-lg mr-2">
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                viewMode === 'calendar' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Календарь
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                viewMode === 'list' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Список
            </button>
          </div>

          {isTechnician(userRole) && (
            <>
              <button
                onClick={openPayTodayModal}
                className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm"
              >
                Оплата сегодня
              </button>
              <button
                onClick={() => openCreateModal()}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
              >
                + Добавить
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
        <StatCard label="Активные подписки" value={String(stats.activeCount)} />
        <StatCard
          label="Ожидают решения"
          value={String(stats.pendingCount)}
          color={stats.pendingCount > 0 ? 'amber' : undefined}
        />
        <StatCard label="На этот месяц" value={formatCurrency(stats.monthTotal, 'USD')} />
        <StatCard
          label="Ближайшие 7 дней"
          value={String(stats.upcomingCount)}
          color={stats.upcomingCount > 0 ? 'blue' : undefined}
        />
      </div>

      {/* Calendar View */}
      {viewMode === 'calendar' && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          {/* Calendar Header */}
          <div className="px-4 py-3 sm:px-6 sm:py-4 border-b border-gray-100 bg-gray-50/50">
            <div className="grid grid-cols-3 items-center">
              <div className="justify-self-start">
                <button
                  onClick={goToToday}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors hidden sm:inline-flex"
                >
                  Сегодня
                </button>
              </div>

              <div className="justify-self-center flex items-center gap-3">
                <button
                  onClick={prevMonth}
                  className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <h2 className="text-base sm:text-lg font-bold text-gray-900 min-w-[140px] sm:min-w-[180px] text-center">
                  {MONTH_NAMES[currentMonth]} {currentYear}
                </h2>
                <button
                  onClick={nextMonth}
                  className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>

              <div className="justify-self-end hidden lg:flex items-center gap-4 text-xs text-gray-500">
                {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                    {cfg.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Day Names */}
          <div className="grid grid-cols-7 border-b border-gray-100">
            {DAY_NAMES.map((name) => (
              <div key={name} className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-center text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">
                {name}
              </div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7">
            {/* Empty cells before first day */}
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`empty-${i}`} className="min-h-[56px] sm:min-h-[80px] border-b border-r border-gray-200 bg-gray-50/30" />
            ))}

            {/* Day cells */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = toDateStr(currentYear, currentMonth, day);
              const isToday = dateStr === today;
              const daySubs = subscriptionsByDate.get(dateStr) || [];
              const isWeekend = (firstDay + i) % 7 >= 5;

              return (
                <div
                  key={day}
                  className={`min-h-[56px] sm:min-h-[80px] border-b border-r border-gray-200 p-1 sm:p-1.5 transition-colors
                    ${isToday ? 'bg-blue-50/40' : isWeekend ? 'bg-gray-50/40' : 'hover:bg-gray-50/50'}
                    ${isTechnician(userRole) ? 'cursor-pointer' : ''}
                  `}
                  onClick={() => {
                    if (isTechnician(userRole)) openCreateModal(dateStr);
                  }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className={`text-[11px] sm:text-xs font-medium w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full
                        ${isToday ? 'bg-blue-600 text-white' : 'text-gray-700'}
                      `}
                    >
                      {day}
                    </span>
                    {daySubs.length > 0 && (
                      <span className="text-[10px] font-medium text-gray-400">
                        {daySubs.length}
                      </span>
                    )}
                  </div>

                  <div className="space-y-0.5">
                    {daySubs.slice(0, 3).map((sub) => {
                      const cfg = STATUS_CONFIG[sub.status] || STATUS_CONFIG.active;
                      return (
                        <button
                          key={sub.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isLead(userRole) && (sub.status === 'pending_review' || sub.status === 'keep' || sub.status === 'cancel')) {
                              openDecisionModal(sub);
                            } else if (isTechnician(userRole)) {
                              openEditModal(sub);
                            }
                          }}
                          className={`w-full text-left px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] leading-tight truncate block transition-all hover:opacity-80
                            ${cfg.bg} ${cfg.text}
                          `}
                          title={`${sub.project_name} — ${formatCurrency(sub.billing_amount, sub.currency)}`}
                        >
                          <span className="font-medium truncate block">{sub.project_name}</span>
                          <span className="opacity-70">{formatCurrency(sub.billing_amount, sub.currency)}</span>
                        </button>
                      );
                    })}
                    {daySubs.length > 3 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setDayPopover((prev) => prev?.dateStr === dateStr ? null : { dateStr, rect });
                        }}
                        className="text-[9px] sm:text-[10px] text-blue-500 hover:text-blue-700 font-medium px-1.5 cursor-pointer transition-colors"
                      >
                        +{daySubs.length - 3} ещё
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Empty cells after last day */}
            {Array.from({ length: (7 - ((firstDay + daysInMonth) % 7)) % 7 }).map((_, i) => (
              <div key={`trail-${i}`} className="min-h-[56px] sm:min-h-[80px] border-b border-r border-gray-200 bg-gray-50/30" />
            ))}
          </div>

          {/* Day popover */}
          {dayPopover && (() => {
            const popSubs = subscriptionsByDate.get(dayPopover.dateStr) || [];
            if (popSubs.length === 0) return null;
            const d = new Date(dayPopover.dateStr + 'T00:00:00');
            const label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
            const total = popSubs.reduce((s, sub) => s + sub.billing_amount, 0);
            const r = dayPopover.rect;
            const openUp = r.bottom + 300 > window.innerHeight;
            let left = r.left;
            if (left + 320 > window.innerWidth - 8) left = window.innerWidth - 328;
            if (left < 8) left = 8;

            return (
              <div
                ref={dayPopoverRef}
                className="fixed z-50 w-[320px] bg-white rounded-xl border border-gray-200 shadow-2xl flex flex-col"
                style={{
                  maxHeight: '60vh',
                  ...(openUp
                    ? { bottom: `${window.innerHeight - r.top + 4}px`, left: `${left}px` }
                    : { top: `${r.bottom + 4}px`, left: `${left}px` }),
                }}
              >
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
                  <div>
                    <span className="text-sm font-semibold text-gray-900">{label}</span>
                    <span className="ml-2 text-xs text-gray-400">{popSubs.length} подписок</span>
                  </div>
                  <button type="button" onClick={() => setDayPopover(null)} className="w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 3.5L3.5 10.5M3.5 3.5l7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1" style={{ minHeight: 0 }}>
                  {popSubs.map((sub) => {
                    const cfg = STATUS_CONFIG[sub.status] || STATUS_CONFIG.active;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => {
                          setDayPopover(null);
                          if (isLead(userRole) && (sub.status === 'pending_review' || sub.status === 'keep' || sub.status === 'cancel')) {
                            openDecisionModal(sub);
                          } else if (isTechnician(userRole)) {
                            openEditModal(sub);
                          }
                        }}
                        className={`w-full text-left rounded-lg p-2.5 text-xs transition-colors hover:opacity-80 ${cfg.bg} ${cfg.text}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">{sub.project_name}</span>
                          <span className="font-semibold flex-shrink-0">{formatCurrency(sub.billing_amount, sub.currency)}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 opacity-70 text-[10px]">
                          <span>{sub.email_provider || '—'}</span>
                          <span>·</span>
                          <span>{sub.email_count} почт</span>
                          <span>·</span>
                          <span className={`inline-flex items-center gap-0.5`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                            {cfg.label}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="px-4 py-2 border-t border-gray-100 text-xs font-semibold text-gray-700 text-right">
                  Итого: {formatCurrency(total, popSubs[0]?.currency || 'USD')}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
            <h2 className="text-lg font-bold text-gray-900">Все подписки</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full divide-y divide-gray-100 text-xs sm:text-sm">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-3 py-2 sm:px-4 sm:py-3 text-left text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Проект</th>
                  <th className="hidden sm:table-cell px-3 py-2 sm:px-4 sm:py-3 text-left text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Провайдер</th>
                  <th className="hidden sm:table-cell px-3 py-2 sm:px-4 sm:py-3 text-center text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Почт</th>
                  <th className="px-3 py-2 sm:px-4 sm:py-3 text-left text-[10px] sm:text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">Дата</th>
                  <th className="px-3 py-2 sm:px-4 sm:py-3 text-right text-[10px] sm:text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">Сумма</th>
                  <th className="hidden md:table-cell px-3 py-2 sm:px-4 sm:py-3 text-center text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Цикл</th>
                  <th className="px-3 py-2 sm:px-4 sm:py-3 text-center text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Статус</th>
                  <th className="hidden lg:table-cell px-3 py-2 sm:px-4 sm:py-3 text-center text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Решение</th>
                  <th className="px-3 py-2 sm:px-4 sm:py-3 text-center text-[10px] sm:text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">Дней</th>
                  <th className="px-3 py-2 sm:px-4 sm:py-3 text-right text-[10px] sm:text-xs font-semibold text-gray-500 uppercase">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {subscriptions.map((sub) => {
                  const cfg = STATUS_CONFIG[sub.status] || STATUS_CONFIG.active;
                  const daysUntil = daysBetween(today, sub.next_billing_date);
                  const isUrgent = daysUntil <= 2 && daysUntil >= 0;

                  return (
                    <tr key={sub.id} className={`hover:bg-gray-50/50 ${isUrgent ? 'bg-amber-50/30' : ''}`}>
                      <td className="px-3 py-2 sm:px-4 sm:py-3 font-medium text-gray-900 max-w-[220px] sm:max-w-[200px]">
                        <div className="truncate">{sub.project_name}</div>
                        <div className="sm:hidden mt-0.5 text-[11px] text-gray-400 truncate">
                          {(sub.email_provider || '—')}{' · '}{sub.email_count} почт{' · '}{CYCLE_LABELS[sub.billing_cycle]}
                        </div>
                      </td>
                      <td className="hidden sm:table-cell px-3 py-2 sm:px-4 sm:py-3 text-gray-500">{sub.email_provider || '—'}</td>
                      <td className="hidden sm:table-cell px-3 py-2 sm:px-4 sm:py-3 text-center text-gray-500">{sub.email_count}</td>
                      <td className="px-3 py-2 sm:px-4 sm:py-3 text-gray-700 whitespace-nowrap">
                        {new Date(sub.next_billing_date).toLocaleDateString('ru-RU', {
                          day: 'numeric', month: 'short', year: 'numeric',
                        })}
                      </td>
                      <td className="px-3 py-2 sm:px-4 sm:py-3 text-right font-medium text-gray-900 whitespace-nowrap">
                        {formatCurrency(sub.billing_amount, sub.currency)}
                      </td>
                      <td className="hidden md:table-cell px-3 py-2 sm:px-4 sm:py-3 text-center text-gray-500">
                        {CYCLE_LABELS[sub.billing_cycle]}
                      </td>
                      <td className="px-3 py-2 sm:px-4 sm:py-3 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                          {cfg.label}
                        </span>
                      </td>
                      <td className="hidden lg:table-cell px-3 py-2 sm:px-4 sm:py-3 text-center">
                        {sub.lead_decision ? (
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            sub.lead_decision === 'keep'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-red-50 text-red-700'
                          }`}>
                            {sub.lead_decision === 'keep' ? 'Оставить' : 'Отменить'}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 sm:px-4 sm:py-3 text-center whitespace-nowrap">
                        <span className={`text-sm font-medium ${
                          daysUntil < 0 ? 'text-red-500' : daysUntil <= 2 ? 'text-amber-600' : 'text-gray-500'
                        }`}>
                          {daysUntil < 0 ? `${Math.abs(daysUntil)}д назад` : daysUntil === 0 ? 'Сегодня' : `${daysUntil}д`}
                        </span>
                      </td>
                      <td className="px-3 py-2 sm:px-4 sm:py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {isLead(userRole) && (sub.status === 'pending_review' || sub.status === 'active') && (
                            <button
                              onClick={() => openDecisionModal(sub)}
                              className="px-2.5 py-1 text-[11px] sm:text-xs font-medium text-amber-700 bg-amber-50 rounded-md hover:bg-amber-100 transition-colors"
                            >
                              Решение
                            </button>
                          )}
                          {isTechnician(userRole) && (
                            <>
                              <button
                                onClick={() => openEditModal(sub)}
                                className="px-2.5 py-1 text-[11px] sm:text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                              >
                                Ред.
                              </button>
                              <button
                                onClick={() => handleDelete(sub.id)}
                                className="px-2.5 py-1 text-[11px] sm:text-xs font-medium text-red-600 bg-red-50 rounded-md hover:bg-red-100 transition-colors"
                              >
                                Уд.
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {subscriptions.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-sm text-gray-400">
                      Нет записей. {isTechnician(userRole) ? 'Нажмите «+ Добавить» чтобы создать первую запись.' : ''}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Upcoming Deadlines (always visible) */}
      <UpcomingDeadlines
        subscriptions={subscriptions}
        userRole={userRole}
        onDecision={openDecisionModal}
        onEdit={openEditModal}
      />

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setModalOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900">
                {modalMode === 'create' ? 'Новая подписка' : modalMode === 'pay_today' ? 'Оплата сегодня' : modalMode === 'edit' ? 'Редактирование' : 'Решение по подписке'}
              </h3>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-5 space-y-4">
              {(modalMode === 'create' || modalMode === 'edit' || modalMode === 'pay_today') && (
                <>
                  {modalMode === 'pay_today' && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                      <p className="text-sm text-emerald-700">
                        Оплата будет добавлена на сегодня без согласования. Следующее списание создастся автоматически через месяц.
                      </p>
                    </div>
                  )}

                  {/* Project Select */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Проект</label>
                    <select
                      value={form.project_id}
                      onChange={(e) => handleProjectSelect(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                    >
                      <option value="">Выберите проект...</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.client} — {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Project Name (editable, fallback) */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Название (клиент — проект)
                    </label>
                    <input
                      type="text"
                      value={form.project_name}
                      onChange={(e) => setForm({ ...form, project_name: e.target.value })}
                      placeholder="Например: ClientCo — Email Outreach"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>

                  {/* Email Provider & Count */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Почтовый провайдер</label>
                      <input
                        type="text"
                        value={form.email_provider}
                        onChange={(e) => setForm({ ...form, email_provider: e.target.value })}
                        placeholder="Google Workspace, Zoho..."
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Кол-во почт</label>
                      <input
                        type="number"
                        min={1}
                        value={form.email_count}
                        onChange={(e) => setForm({ ...form, email_count: parseInt(e.target.value) || 1 })}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>
                  </div>

                  {/* Billing Date */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {modalMode === 'pay_today' ? 'Дата оплаты (сегодня)' : 'Дата следующего списания'}
                    </label>
                    <input
                      type="date"
                      value={form.next_billing_date}
                      onChange={(e) => setForm({ ...form, next_billing_date: e.target.value })}
                      disabled={modalMode === 'pay_today'}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-60 disabled:cursor-not-allowed disabled:bg-gray-50"
                    />
                  </div>

                  {/* Amount, Currency, Cycle */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Сумма</label>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={form.billing_amount || ''}
                        onChange={(e) => setForm({ ...form, billing_amount: parseFloat(e.target.value) || 0 })}
                        placeholder="0.00"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Валюта</label>
                      <select
                        value={form.currency}
                        onChange={(e) => setForm({ ...form, currency: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                      >
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR (€)</option>
                        <option value="RUB">RUB (₽)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Цикл</label>
                      <select
                        value={form.billing_cycle}
                        onChange={(e) => setForm({ ...form, billing_cycle: e.target.value as 'monthly' | 'quarterly' | 'yearly' })}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                      >
                        <option value="monthly">Ежемесячно</option>
                        <option value="quarterly">Ежеквартально</option>
                        <option value="yearly">Ежегодно</option>
                      </select>
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Заметки</label>
                    <textarea
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      rows={2}
                      placeholder="Дополнительная информация..."
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                    />
                  </div>
                </>
              )}

              {modalMode === 'decision' && editingItem && (
                <>
                  {/* Info about the subscription */}
                  <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Проект</span>
                      <span className="text-sm font-medium text-gray-900">{editingItem.project_name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Провайдер</span>
                      <span className="text-sm text-gray-700">{editingItem.email_provider || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Кол-во почт</span>
                      <span className="text-sm text-gray-700">{editingItem.email_count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Дата списания</span>
                      <span className="text-sm font-medium text-gray-900">
                        {new Date(editingItem.next_billing_date).toLocaleDateString('ru-RU', {
                          day: 'numeric', month: 'long', year: 'numeric',
                        })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Сумма</span>
                      <span className="text-sm font-bold text-gray-900">
                        {formatCurrency(editingItem.billing_amount, editingItem.currency)}
                      </span>
                    </div>
                    {editingItem.notes && (
                      <div className="pt-2 border-t border-gray-200">
                        <span className="text-xs text-gray-500">Заметки от технаря:</span>
                        <p className="text-sm text-gray-700 mt-0.5">{editingItem.notes}</p>
                      </div>
                    )}
                  </div>

                  {/* Decision buttons */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Решение</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => setDecisionForm({ ...decisionForm, decision: 'keep' })}
                        className={`p-4 rounded-xl border-2 text-center transition-all ${
                          decisionForm.decision === 'keep'
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                            : 'border-gray-200 text-gray-600 hover:border-emerald-300 hover:bg-emerald-50/50'
                        }`}
                      >
                        <div className="text-2xl mb-1">&#10003;</div>
                        <div className="text-sm font-semibold">Оставить</div>
                        <div className="text-xs opacity-70 mt-0.5">Продолжаем оплачивать</div>
                      </button>
                      <button
                        onClick={() => setDecisionForm({ ...decisionForm, decision: 'cancel' })}
                        className={`p-4 rounded-xl border-2 text-center transition-all ${
                          decisionForm.decision === 'cancel'
                            ? 'border-red-500 bg-red-50 text-red-700'
                            : 'border-gray-200 text-gray-600 hover:border-red-300 hover:bg-red-50/50'
                        }`}
                      >
                        <div className="text-2xl mb-1">&#10007;</div>
                        <div className="text-sm font-semibold">Отменить</div>
                        <div className="text-xs opacity-70 mt-0.5">Клиент уходит</div>
                      </button>
                    </div>
                  </div>

                  {/* Decision notes */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Комментарий лида</label>
                    <textarea
                      value={decisionForm.notes}
                      onChange={(e) => setDecisionForm({ ...decisionForm, notes: e.target.value })}
                      rows={2}
                      placeholder="Причина решения..."
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3">
              <button
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Отмена
              </button>
              {(modalMode === 'create' || modalMode === 'edit' || modalMode === 'pay_today') && (
                <button
                  onClick={handleSave}
                  disabled={!form.project_name.trim() || !form.next_billing_date}
                  className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    modalMode === 'pay_today' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {modalMode === 'create' ? 'Создать' : modalMode === 'pay_today' ? 'Оплатить' : 'Сохранить'}
                </button>
              )}
              {modalMode === 'decision' && (
                <button
                  onClick={handleDecisionSave}
                  disabled={!decisionForm.decision}
                  className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    decisionForm.decision === 'keep'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : decisionForm.decision === 'cancel'
                        ? 'bg-red-600 hover:bg-red-700'
                        : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  Подтвердить
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════ */

function StatCard({ label, value, color }: { label: string; value: string; color?: 'amber' | 'blue' | 'green' | 'red' }) {
  const colorClasses = {
    amber: 'text-amber-700',
    blue: 'text-blue-700',
    green: 'text-emerald-700',
    red: 'text-red-700',
  };

  return (
    <div className="bg-white p-4 sm:p-5 rounded-2xl border border-gray-200 shadow-sm">
      <div className="text-xs sm:text-sm font-medium text-gray-500 mb-1">{label}</div>
      <p className={`text-xl sm:text-2xl font-bold ${color ? colorClasses[color] : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function UpcomingDeadlines({
  subscriptions,
  userRole,
  onDecision,
  onEdit,
}: {
  subscriptions: EmailSubscription[];
  userRole: UserRole | null;
  onDecision: (item: EmailSubscription) => void;
  onEdit: (item: EmailSubscription) => void;
}) {
  const today = todayStr();
  const upcoming = subscriptions
    .filter((sub) => {
      const daysUntil = daysBetween(today, sub.next_billing_date);
      return daysUntil >= -3 && daysUntil <= 7 && (sub.status === 'active' || sub.status === 'pending_review');
    })
    .sort((a, b) => a.next_billing_date.localeCompare(b.next_billing_date));

  if (upcoming.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 bg-amber-50/50">
        <h2 className="text-lg font-bold text-gray-900">Ближайшие списания</h2>
        <p className="text-xs text-gray-500 mt-0.5">Подписки с датой списания в ближайшие 7 дней</p>
      </div>
      <div className="divide-y divide-gray-50">
        {upcoming.map((sub) => {
          const daysUntil = daysBetween(today, sub.next_billing_date);
          const cfg = STATUS_CONFIG[sub.status] || STATUS_CONFIG.active;
          const isOverdue = daysUntil < 0;
          const needsDecision = sub.status === 'pending_review' && !sub.lead_decision;

          return (
            <div key={sub.id} className={`px-6 py-4 flex items-center gap-4 ${isOverdue ? 'bg-red-50/30' : needsDecision ? 'bg-amber-50/30' : ''}`}>
              {/* Date badge */}
              <div className={`flex-shrink-0 w-14 h-14 rounded-xl flex flex-col items-center justify-center ${
                isOverdue ? 'bg-red-100 text-red-700' : daysUntil <= 2 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'
              }`}>
                <span className="text-lg font-bold leading-none">
                  {new Date(sub.next_billing_date).getDate()}
                </span>
                <span className="text-[10px] font-medium uppercase mt-0.5">
                  {MONTH_NAMES[new Date(sub.next_billing_date).getMonth()]?.slice(0, 3)}
                </span>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-gray-900 truncate">{sub.project_name}</h4>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${cfg.bg} ${cfg.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                    {cfg.label}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                  {sub.email_provider && <span>{sub.email_provider}</span>}
                  <span>{sub.email_count} почт</span>
                  <span>{CYCLE_LABELS[sub.billing_cycle]}</span>
                  {sub.lead_decision && (
                    <span className={`font-medium ${sub.lead_decision === 'keep' ? 'text-emerald-600' : 'text-red-600'}`}>
                      Решение: {sub.lead_decision === 'keep' ? 'оставить' : 'отменить'}
                    </span>
                  )}
                </div>
                {sub.lead_notes && (
                  <p className="text-xs text-gray-400 mt-0.5 truncate">Лид: {sub.lead_notes}</p>
                )}
              </div>

              {/* Amount */}
              <div className="flex-shrink-0 text-right">
                <div className="text-lg font-bold text-gray-900">
                  {formatCurrency(sub.billing_amount, sub.currency)}
                </div>
                <div className={`text-xs font-medium ${
                  isOverdue ? 'text-red-500' : daysUntil === 0 ? 'text-amber-600' : daysUntil <= 2 ? 'text-amber-500' : 'text-gray-400'
                }`}>
                  {isOverdue ? `${Math.abs(daysUntil)}д назад!` : daysUntil === 0 ? 'Сегодня!' : `через ${daysUntil}д`}
                </div>
              </div>

              {/* Actions */}
              <div className="flex-shrink-0 flex items-center gap-1">
                {isLead(userRole) && needsDecision && (
                  <button
                    onClick={() => onDecision(sub)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-amber-500 rounded-lg hover:bg-amber-600 transition-colors animate-pulse"
                  >
                    Решить
                  </button>
                )}
                {isTechnician(userRole) && (
                  <button
                    onClick={() => onEdit(sub)}
                    className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                  >
                    Ред.
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
