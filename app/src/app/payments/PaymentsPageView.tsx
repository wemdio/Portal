'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';

/* ═══════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════ */

interface PaymentRequest {
  id: string;
  user_id: string;
  department: string;
  description: string;
  amount: number;
  project_id: string | null;
  comment: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  created_at: string;
  // joined
  requester_name?: string;
  requester_email?: string;
  project_name?: string;
  project_client?: string;
}

interface ProjectOption {
  id: string;
  name: string;
  client: string;
}

interface ProfileMap {
  [id: string]: { full_name: string; email: string };
}

/* ═══════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════ */

const DEPARTMENTS: { value: string; label: string }[] = [
  { value: 'outreach', label: 'Аутрич' },
  { value: 'paid_traffic', label: 'Платный трафик' },
  { value: 'accounting', label: 'Аккаунтинг' },
  { value: 'sales', label: 'Продажи' },
];

const DEPARTMENT_LABELS: Record<string, string> = Object.fromEntries(
  DEPARTMENTS.map((d) => [d.value, d.label]),
);

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(val);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function getMonthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function generateMonthRange(): string[] {
  const months: string[] = [];
  const now = new Date();
  const start = new Date(2025, 0, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const cursor = new Date(start);
  while (cursor < end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months.reverse();
}

function formatMonthLabel(key: string): string {
  const [year, month] = key.split('-');
  return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

/* ═══════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════ */

export default function PaymentsPageView() {
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [profiles, setProfiles] = useState<ProfileMap>({});
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'requests' | 'stats'>('requests');

  // Form state
  const [form, setForm] = useState({
    department: 'outreach',
    description: '',
    amount: '',
    project_id: '',
    comment: '',
  });

  /* ─── Auth ─── */

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      setUserId(session.user.id);

    }
    init();
  }, []);

  /* ─── Data Fetching ─── */

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('payment_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setRequests(data || []);
    } catch (err) {
      console.error('Error fetching payment requests:', err);
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

  const fetchProfiles = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email');
      if (error) throw error;
      const map: ProfileMap = {};
      for (const p of data || []) {
        map[p.id] = { full_name: p.full_name || p.email || 'Неизвестно', email: p.email || '' };
      }
      setProfiles(map);
    } catch (err) {
      console.error('Error fetching profiles:', err);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
    fetchProjects();
    fetchProfiles();
  }, [fetchRequests, fetchProjects, fetchProfiles]);

  /* ─── Submit new request ─── */

  const handleSubmit = async () => {
    if (!userId) return;
    const amount = parseFloat(form.amount.replace(/\s/g, '').replace(',', '.'));
    if (!form.description.trim() || !amount || amount <= 0) return;

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        user_id: userId,
        department: form.department,
        description: form.description.trim(),
        amount,
        project_id: form.project_id || null,
        comment: form.comment.trim() || null,
        status: 'approved',
        decided_by: userId,
        decided_at: new Date().toISOString(),
        decision_comment: 'Занесено в расход',
      };

      const { error } = await supabase.from('payment_requests').insert(payload);
      if (error) throw error;

      setForm({ department: 'outreach', description: '', amount: '', project_id: '', comment: '' });
      await fetchRequests();
    } catch (err) {
      console.error('Error submitting request:', err);
      alert('Ошибка при отправке');
    } finally {
      setSubmitting(false);
    }
  };

  /* ─── Stats computation ─── */

  const monthRange = useMemo(() => generateMonthRange(), []);
  const [statsMonth, setStatsMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  const approvedRequests = useMemo(
    () => requests.filter((r) => r.status === 'approved'),
    [requests],
  );

  const monthlyStats = useMemo(() => {
    const monthRequests = approvedRequests.filter((r) => getMonthKey(r.created_at) === statsMonth);
    const byDepartment: Record<string, { count: number; total: number }> = {};
    let grandTotal = 0;

    for (const r of monthRequests) {
      if (!byDepartment[r.department]) byDepartment[r.department] = { count: 0, total: 0 };
      byDepartment[r.department].count += 1;
      byDepartment[r.department].total += Number(r.amount);
      grandTotal += Number(r.amount);
    }

    return { byDepartment, grandTotal, count: monthRequests.length };
  }, [approvedRequests, statsMonth]);

  const allTimeStats = useMemo(() => {
    let total = 0;
    for (const r of approvedRequests) total += Number(r.amount);
    return { count: approvedRequests.length, total };
  }, [approvedRequests]);

  /* ─── Enrich requests with profile/project names ─── */

  const enrichedRequests = useMemo(() => {
    return requests.map((r) => ({
      ...r,
      requester_name: profiles[r.user_id]?.full_name || 'Неизвестно',
      requester_email: profiles[r.user_id]?.email || '',
      project_name: r.project_id ? projects.find((p) => p.id === r.project_id)?.name : undefined,
      project_client: r.project_id ? projects.find((p) => p.id === r.project_id)?.client : undefined,
    }));
  }, [requests, profiles, projects]);

  /* ─── Filter for stats tab ─── */

  const statsRequests = useMemo(
    () => enrichedRequests.filter((r) => r.status === 'approved' && getMonthKey(r.created_at) === statsMonth),
    [enrichedRequests, statsMonth],
  );

  /* ═══════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════ */

  const formValid = form.description.trim().length > 0 && parseFloat(form.amount.replace(/\s/g, '').replace(',', '.')) > 0;

  return (
    <div className="min-h-screen bg-gray-50/60 px-4 py-6 sm:px-6 lg:px-8">
      <div className="max-w-[1400px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">Оплаты</h1>
            <p className="mt-1 text-sm text-gray-500">Учёт дополнительных расходов</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('requests')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
                activeTab === 'requests'
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              Расходы
            </button>
            <button
              onClick={() => setActiveTab('stats')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
                activeTab === 'stats'
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              Статистика
            </button>
          </div>
        </div>

        {/* ═══════════ REQUESTS TAB ═══════════ */}
        {activeTab === 'requests' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* ── Left: Form ── */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden sticky top-6">
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                  <h2 className="text-base font-bold text-gray-900">Занести в расход</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Добавится сразу в статистику</p>
                </div>
                <div className="px-6 py-5 space-y-4">
                  {/* Department */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">Отдел</label>
                    <select
                      value={form.department}
                      onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white"
                    >
                      {DEPARTMENTS.map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                      Оплата какого сервиса / базы / доп. расхода?
                    </label>
                    <input
                      type="text"
                      value={form.description}
                      onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="Например: Instantly.ai подписка"
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white"
                    />
                  </div>

                  {/* Amount */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">Сумма (руб.)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                      placeholder="15 000"
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white"
                    />
                  </div>

                  {/* Project (optional) */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                      Проект <span className="text-gray-400 font-normal">(необязательно)</span>
                    </label>
                    <select
                      value={form.project_id}
                      onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white"
                    >
                      <option value="">Без проекта</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.client} — {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Comment */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1.5">Комментарий</label>
                    <textarea
                      value={form.comment}
                      onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
                      rows={3}
                      placeholder="Зачем нужна эта оплата, ссылки и т.д."
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white resize-none"
                    />
                  </div>

                  <button
                    onClick={() => void handleSubmit()}
                    disabled={!formValid || submitting}
                    className="w-full py-2.5 text-sm font-medium rounded-xl bg-gray-900 text-white shadow-sm transition hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {submitting ? 'Сохранение...' : 'Занести в расход'}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Right: Request list ── */}
            <div className="lg:col-span-2 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900">
                  Все расходы <span className="text-gray-400 font-normal text-sm">({enrichedRequests.length})</span>
                </h2>
              </div>

              {loading ? (
                <div className="text-center text-gray-400 py-16">Загрузка...</div>
              ) : enrichedRequests.length === 0 ? (
                <div className="text-center text-gray-400 py-16 bg-white rounded-2xl border border-gray-200">
                  Нет записей о расходах
                </div>
              ) : (
                <div className="space-y-3">
                  {enrichedRequests.map((r) => {
                    const sc = { label: 'Расход', bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' };
                    return (
                      <div
                        key={r.id}
                        className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden transition hover:shadow-md"
                      >
                        <div className="px-5 py-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-gray-900 text-sm">{r.description}</span>
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${sc.bg} ${sc.text}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                                  {sc.label}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500 flex-wrap">
                                <span>{r.requester_name}</span>
                                <span className="text-gray-300">|</span>
                                <span>{DEPARTMENT_LABELS[r.department] || r.department}</span>
                                <span className="text-gray-300">|</span>
                                <span>{formatDate(r.created_at)}</span>
                                {r.project_name && (
                                  <>
                                    <span className="text-gray-300">|</span>
                                    <span className="text-indigo-600">{r.project_client} — {r.project_name}</span>
                                  </>
                                )}
                              </div>
                              {r.comment && (
                                <p className="mt-2 text-xs text-gray-500 leading-relaxed">{r.comment}</p>
                              )}
                              {r.decided_at && (
                                <p className="mt-1.5 text-xs text-gray-400">
                                  Занесено{' '}
                                  {profiles[r.decided_by ?? '']?.full_name || ''}{' '}
                                  {formatDateTime(r.decided_at)}
                                </p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-lg font-bold text-gray-900">{formatCurrency(Number(r.amount))}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════ STATS TAB ═══════════ */}
        {activeTab === 'stats' && (
          <div className="space-y-6">
            {/* Month selector + summary cards */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const idx = monthRange.indexOf(statsMonth);
                    if (idx < monthRange.length - 1) setStatsMonth(monthRange[idx + 1]);
                  }}
                  disabled={monthRange.indexOf(statsMonth) >= monthRange.length - 1}
                  className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  &larr;
                </button>
                <select
                  value={statsMonth}
                  onChange={(e) => setStatsMonth(e.target.value)}
                  className="px-3 py-2 text-sm font-medium border border-gray-200 rounded-lg bg-white hover:bg-gray-50"
                >
                  {monthRange.map((m) => (
                    <option key={m} value={m}>{formatMonthLabel(m)}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const idx = monthRange.indexOf(statsMonth);
                    if (idx > 0) setStatsMonth(monthRange[idx - 1]);
                  }}
                  disabled={monthRange.indexOf(statsMonth) <= 0}
                  className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  &rarr;
                </button>
              </div>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Расходы за месяц</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(monthlyStats.grandTotal)}</p>
                <p className="text-xs text-gray-400 mt-1">{monthlyStats.count} расходов</p>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Всего расходов (все время)</p>
                <p className="mt-2 text-2xl font-bold text-emerald-600">{formatCurrency(allTimeStats.total)}</p>
                <p className="text-xs text-gray-400 mt-1">{allTimeStats.count} расходов</p>
              </div>
            </div>

            {/* By department table */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                <h3 className="text-base font-bold text-gray-900">По отделам — {formatMonthLabel(statsMonth)}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-100 text-sm">
                  <thead className="bg-gray-50/50">
                    <tr>
                      <th className="px-6 py-3 text-left font-semibold text-gray-500">Отдел</th>
                      <th className="px-6 py-3 text-right font-semibold text-gray-500">Расходов</th>
                      <th className="px-6 py-3 text-right font-semibold text-gray-500">Сумма</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {DEPARTMENTS.map((d) => {
                      const stats = monthlyStats.byDepartment[d.value];
                      return (
                        <tr key={d.value} className="hover:bg-gray-50/50 transition">
                          <td className="px-6 py-3 font-medium text-gray-900">{d.label}</td>
                          <td className="px-6 py-3 text-right text-gray-600">{stats?.count || 0}</td>
                          <td className="px-6 py-3 text-right font-medium text-gray-900">
                            {stats ? formatCurrency(stats.total) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="bg-gray-50/80 font-bold">
                      <td className="px-6 py-3 text-gray-900">Итого</td>
                      <td className="px-6 py-3 text-right text-gray-900">{monthlyStats.count}</td>
                      <td className="px-6 py-3 text-right text-gray-900">{formatCurrency(monthlyStats.grandTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Detailed list for the month */}
            {statsRequests.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                  <h3 className="text-base font-bold text-gray-900">Детализация — {formatMonthLabel(statsMonth)}</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-100 text-sm">
                    <thead className="bg-gray-50/50">
                      <tr>
                        <th className="px-5 py-3 text-left font-semibold text-gray-500">Дата</th>
                        <th className="px-5 py-3 text-left font-semibold text-gray-500">Сотрудник</th>
                        <th className="px-5 py-3 text-left font-semibold text-gray-500">Отдел</th>
                        <th className="px-5 py-3 text-left font-semibold text-gray-500">Описание</th>
                        <th className="px-5 py-3 text-left font-semibold text-gray-500">Проект</th>
                        <th className="px-5 py-3 text-right font-semibold text-gray-500">Сумма</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {statsRequests.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50/50 transition">
                          <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{formatDate(r.created_at)}</td>
                          <td className="px-5 py-3 text-gray-900">{r.requester_name}</td>
                          <td className="px-5 py-3 text-gray-600">{DEPARTMENT_LABELS[r.department] || r.department}</td>
                          <td className="px-5 py-3 text-gray-900">{r.description}</td>
                          <td className="px-5 py-3 text-gray-500">
                            {r.project_name ? `${r.project_client} — ${r.project_name}` : '—'}
                          </td>
                          <td className="px-5 py-3 text-right font-medium text-gray-900">{formatCurrency(Number(r.amount))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
