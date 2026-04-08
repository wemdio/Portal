'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Flame,
  Loader2,
  Mail,
  MailCheck,
  MapPin,
  RefreshCw,
  Send,
  ShieldCheck,
  Thermometer,
  XCircle,
  Zap,
} from 'lucide-react';
import type { NashLead } from '@/lib/nashOutreach/types';
import { triggerNashCollect } from './actions';

/** Returns today's date as an ISO string (YYYY-MM-DD). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const PRIORITY_LABEL: Record<string, string> = {
  RED_HOT: 'Red Hot',
  HOT: 'Hot',
  WARM: 'Warm',
};

const PRIORITY_COLORS: Record<string, string> = {
  RED_HOT: 'bg-red-100 text-red-700',
  HOT: 'bg-orange-100 text-orange-700',
  WARM: 'bg-amber-100 text-amber-700',
};

const PRIORITY_ICON: Record<string, typeof Flame> = {
  RED_HOT: Flame,
  HOT: Zap,
  WARM: Thermometer,
};

const SIGNAL_LABELS: Record<string, string> = {
  Hiring_Sales: 'Наём продаж',
  Hiring_Marketing: 'Наём маркетинг',
  Funding: 'Инвестиции',
  Product_Launch: 'Запуск продукта',
  Expansion: 'Расширение',
  Growth: 'Рост',
  Content_Active: 'Контент',
};

/** Dashboard page for the Nash (RU) outreach pipeline — shows leads, stats and filters. */
export default function NashOutreachPage() {
  const [leads, setLeads] = useState<NashLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [filterDate, setFilterDate] = useState(todayISO());
  const [filterPriority, setFilterPriority] = useState<string>('');
  const [filterSignal, setFilterSignal] = useState<string>('');

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterDate) params.set('batch_date', filterDate);
      if (filterPriority) params.set('priority', filterPriority);
      if (filterSignal) params.set('signal_type', filterSignal);

      const res = await fetch(`/api/tools/nash-outreach/leads?${params}`);
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      setLeads(data.leads ?? []);
    } catch {
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, [filterDate, filterPriority, filterSignal]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  const handleCollect = useCallback(async () => {
    setCollecting(true);
    setCollectError(null);
    try {
      const result = await triggerNashCollect();
      if (result.ok) {
        await fetchLeads();
      } else {
        setCollectError(result.error ?? 'Сбор не удался');
      }
    } catch {
      setCollectError('Ошибка сети');
    } finally {
      setCollecting(false);
    }
  }, [fetchLeads]);

  const stats = useMemo(() => {
    const total = leads.length;
    const redHot = leads.filter((l) => l.priority === 'RED_HOT').length;
    const hot = leads.filter((l) => l.priority === 'HOT').length;
    const warm = leads.filter((l) => l.priority === 'WARM').length;
    const withEmails = leads.filter((l) => l.emails_validated?.length > 0).length;
    const withSequence = leads.filter((l) => l.email_sequence?.length).length;
    const inInstantly = leads.filter((l) => l.instantly_uploaded).length;
    const fromHH = leads.filter((l) => l.hh_employer_id).length;
    return { total, redHot, hot, warm, withEmails, withSequence, inInstantly, fromHH };
  }, [leads]);

  const pipeline = useMemo(() => {
    const noEmail = leads.filter((l) => !l.emails_found?.length && !l.emails_validated?.length).length;
    const pendingSmtp = leads.filter((l) => l.smtp_status === 'pending').length;
    const smtpValid = leads.filter((l) => l.smtp_status === 'valid' || l.smtp_status === 'catch_all').length;
    const smtpFailed = leads.filter((l) => l.smtp_status === 'invalid' || l.smtp_status === 'unknown').length;
    const skipped = leads.filter((l) => l.smtp_status === 'skipped').length;
    const withSequence = leads.filter((l) => l.email_sequence && l.email_sequence.length >= 3 && !l.instantly_uploaded).length;
    const inInstantly = leads.filter((l) => l.instantly_uploaded).length;

    const lastProcessed = leads
      .filter((l) => l.smtp_status !== 'pending' && l.smtp_status !== 'skipped')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

    let workerStatus: 'active' | 'waiting' | 'idle' = 'idle';
    if (pendingSmtp > 0 && lastProcessed) {
      const diffMin = (Date.now() - new Date(lastProcessed.created_at).getTime()) / 60_000;
      workerStatus = diffMin < 30 ? 'active' : 'waiting';
    } else if (pendingSmtp > 0) {
      workerStatus = 'waiting';
    }

    return { noEmail, pendingSmtp, smtpValid, smtpFailed, skipped, withSequence, inInstantly, workerStatus };
  }, [leads]);

  const signalTypes = useMemo(() => {
    const set = new Set(leads.map((l) => l.signal_type));
    return Array.from(set).sort();
  }, [leads]);

  return (
    <div className="space-y-6 text-left max-w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Наш аутрич</h1>
          <p className="text-sm text-gray-500">
            Автосбор российских B2B-лидов: HH.ru наём, VC.ru фандинг, запуски.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCollect}
            disabled={collecting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
          >
            {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {collecting ? 'Сбор…' : 'Собрать сейчас'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatCard label="Всего" value={stats.total} color="bg-gray-100 text-gray-800" />
        <StatCard label="Red Hot" value={stats.redHot} color="bg-red-50 text-red-700" />
        <StatCard label="Hot" value={stats.hot} color="bg-orange-50 text-orange-700" />
        <StatCard label="Warm" value={stats.warm} color="bg-amber-50 text-amber-700" />
        <StatCard label="Email найден" value={stats.withEmails} color="bg-blue-50 text-blue-700" />
        <StatCard label="Цепочка" value={stats.withSequence} color="bg-violet-50 text-violet-700" />
        <StatCard label="В Instantly" value={stats.inInstantly} color="bg-green-50 text-green-700" />
        <StatCard label="Из HH.ru" value={stats.fromHH} color="bg-cyan-50 text-cyan-700" />
      </div>

      {leads.length > 0 && <PipelineTracker pipeline={pipeline} total={leads.length} />}

      {collectError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {collectError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        />
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">Все приоритеты</option>
          <option value="RED_HOT">Red Hot</option>
          <option value="HOT">Hot</option>
          <option value="WARM">Warm</option>
        </select>
        <select
          value={filterSignal}
          onChange={(e) => setFilterSignal(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">Все сигналы</option>
          {signalTypes.map((s) => (
            <option key={s} value={s}>
              {SIGNAL_LABELS[s] ?? s}
            </option>
          ))}
        </select>
        {(filterPriority || filterSignal || filterDate !== todayISO()) && (
          <button
            onClick={() => { setFilterPriority(''); setFilterSignal(''); setFilterDate(todayISO()); }}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : leads.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-lg font-medium">Лидов пока нет</p>
            <p className="mt-1 text-sm">Нажмите «Собрать сейчас» или дождитесь утреннего сбора.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="w-8 px-3 py-3" />
                  <th className="px-3 py-3">Компания</th>
                  <th className="px-3 py-3">Сигнал</th>
                  <th className="px-3 py-3 text-center">Score</th>
                  <th className="px-3 py-3">Приоритет</th>
                  <th className="px-3 py-3">Статус</th>
                  <th className="px-3 py-3 hidden lg:table-cell">Город</th>
                  <th className="px-3 py-3 hidden lg:table-cell">Ниша</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leads.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    expanded={expandedId === lead.id}
                    onToggle={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact metric card used in the stats grid. */
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-xl px-4 py-3 ${color}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium opacity-70">{label}</div>
    </div>
  );
}

/** Badge showing the current pipeline stage of a lead. */
function PipelineStatus({ lead }: { lead: NashLead }) {
  if (lead.instantly_uploaded) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        <Send className="h-3 w-3" /> В Instantly
      </span>
    );
  }
  if (lead.email_sequence && lead.email_sequence.length >= 3) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
        <Mail className="h-3 w-3" /> Цепочка готова
      </span>
    );
  }
  if (lead.smtp_status === 'valid' || lead.smtp_status === 'catch_all') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <ShieldCheck className="h-3 w-3" /> SMTP ок
      </span>
    );
  }
  if (lead.smtp_status === 'pending' && lead.emails_validated?.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
        <Clock className="h-3 w-3" /> Ждёт SMTP
      </span>
    );
  }
  if (lead.smtp_status === 'invalid' || lead.smtp_status === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
        <XCircle className="h-3 w-3" /> SMTP не прошёл
      </span>
    );
  }
  if (lead.emails_validated?.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
        <MailCheck className="h-3 w-3" /> Email найден
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
      Нет email
    </span>
  );
}

/** Visual pipeline progress tracker showing lead counts at each stage. */
function PipelineTracker({ pipeline, total }: {
  pipeline: {
    noEmail: number; pendingSmtp: number; smtpValid: number; smtpFailed: number;
    skipped: number; withSequence: number; inInstantly: number; workerStatus: 'active' | 'waiting' | 'idle';
  };
  total: number;
}) {
  const steps = [
    { label: 'Нет email', count: pipeline.noEmail, color: 'bg-gray-200', text: 'text-gray-600' },
    { label: 'Ждёт SMTP', count: pipeline.pendingSmtp, color: 'bg-amber-200', text: 'text-amber-700' },
    { label: 'SMTP ок', count: pipeline.smtpValid, color: 'bg-emerald-200', text: 'text-emerald-700' },
    { label: 'Цепочка', count: pipeline.withSequence, color: 'bg-violet-200', text: 'text-violet-700' },
    { label: 'В Instantly', count: pipeline.inInstantly, color: 'bg-green-300', text: 'text-green-800' },
  ];

  const workerLabels: Record<string, { label: string; color: string; dot: string }> = {
    active:  { label: 'Worker обрабатывает', color: 'text-green-700', dot: 'bg-green-500 animate-pulse' },
    waiting: { label: 'Worker не отвечает', color: 'text-amber-700', dot: 'bg-amber-500' },
    idle:    { label: 'Нечего обрабатывать', color: 'text-gray-500', dot: 'bg-gray-400' },
  };
  const ws = workerLabels[pipeline.workerStatus];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Статус пайплайна</h3>
        <div className={`flex items-center gap-1.5 text-xs font-medium ${ws.color}`}>
          <span className={`h-2 w-2 rounded-full ${ws.dot}`} />
          {ws.label}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center gap-1" style={{ flex: Math.max(step.count, 0.5) }}>
            <div className={`rounded-lg px-2 py-1.5 ${step.color} w-full text-center`}>
              <div className={`text-lg font-bold ${step.text}`}>{step.count}</div>
              <div className={`text-[10px] font-medium ${step.text} opacity-70 leading-tight`}>{step.label}</div>
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      {(pipeline.smtpFailed > 0 || pipeline.skipped > 0) && (
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {pipeline.smtpFailed > 0 && (
            <span className="inline-flex items-center gap-1 text-red-500">
              <XCircle className="h-3 w-3" /> SMTP не прошёл: {pipeline.smtpFailed}
            </span>
          )}
          {pipeline.skipped > 0 && (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Пропущено (нет email): {pipeline.skipped}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Expandable table row displaying a single Nash outreach lead. */
function LeadRow({ lead, expanded, onToggle }: { lead: NashLead; expanded: boolean; onToggle: () => void }) {
  const PriorityIcon = PRIORITY_ICON[lead.priority] ?? Thermometer;

  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer transition-colors hover:bg-gray-50/60">
        <td className="px-3 py-3 text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-3">
          <div className="font-medium text-gray-900">{lead.company_name}</div>
          {lead.website && (
            <a
              href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-blue-600 hover:underline"
            >
              {lead.website}
            </a>
          )}
        </td>
        <td className="px-3 py-3">
          <span className="inline-block rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {SIGNAL_LABELS[lead.signal_type] ?? lead.signal_type}
          </span>
          <div className="mt-0.5 text-xs text-gray-500 line-clamp-1">{lead.signal_detail}</div>
        </td>
        <td className="px-3 py-3 text-center">
          <span className="font-mono font-bold text-gray-900">{lead.intent_score}</span>
        </td>
        <td className="px-3 py-3">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${PRIORITY_COLORS[lead.priority] ?? 'bg-gray-100 text-gray-600'}`}>
            <PriorityIcon className="h-3 w-3" />
            {PRIORITY_LABEL[lead.priority] ?? lead.priority}
          </span>
        </td>
        <td className="px-3 py-3">
          <PipelineStatus lead={lead} />
        </td>
        <td className="px-3 py-3 hidden lg:table-cell">
          {lead.city && (
            <span className="inline-flex items-center gap-0.5 text-xs text-gray-600">
              <MapPin className="h-3 w-3" /> {lead.city}
            </span>
          )}
        </td>
        <td className="px-3 py-3 hidden lg:table-cell">
          <span className="text-xs text-gray-600">{lead.niche}</span>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-gray-50/40">
          <td />
          <td colSpan={7} className="px-3 py-4">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                <DetailField label="Описание" value={lead.description} />
                <DetailField label="Город" value={lead.city} />
                <DetailField label="Сотрудников" value={lead.employee_count} />
                <DetailField label="Источник" value={lead.source_url} link />
                <DetailField label="Ниша" value={lead.niche} />
                {lead.hh_vacancy_name && <DetailField label="Вакансия HH" value={lead.hh_vacancy_name} />}
                <div className="sm:col-span-2 lg:col-span-3">
                  <DetailField label="Угол для письма" value={lead.outreach_angle} />
                </div>
              </div>

              {lead.emails_validated?.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-1 flex items-center gap-1">
                    <Check className="h-3 w-3 text-green-500" /> Валидные email
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {lead.emails_validated.map((email) => (
                      <span key={email} className="inline-block rounded-md bg-green-50 px-2 py-0.5 text-xs font-mono text-green-700">
                        {email}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {lead.email_sequence && lead.email_sequence.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
                    <Mail className="h-3 w-3 text-violet-500" /> Цепочка писем
                  </div>
                  <div className="space-y-3">
                    {lead.email_sequence.map((step, idx) => (
                      <div key={idx} className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-bold">
                            {idx + 1}
                          </span>
                          <span className="text-xs text-gray-400">
                            {idx === 0 ? 'День 0' : idx === 1 ? 'День 3' : 'День 7'}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-gray-900 mb-1">{step.subject}</div>
                        <div className="text-xs text-gray-600 whitespace-pre-line leading-relaxed">{step.body}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Label + value pair rendered inside the expanded lead row. */
function DetailField({ label, value, link }: { label: string; value: string | null | undefined; link?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs font-medium text-gray-400 mb-0.5">{label}</div>
      {link ? (
        <a
          href={value.startsWith('http') ? value : `https://${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-blue-600 hover:underline break-all"
        >
          {value.length > 50 ? value.slice(0, 50) + '…' : value}
          <ExternalLink className="h-3 w-3 flex-shrink-0" />
        </a>
      ) : (
        <div className="text-gray-700">{value}</div>
      )}
    </div>
  );
}
