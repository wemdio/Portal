'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Flame,
  Globe,
  Loader2,
  Mail,
  MailCheck,
  RefreshCw,
  Send,
  Thermometer,
  Zap,
} from 'lucide-react';
import type { BugorLead } from '@/lib/bugorOutreach/types';
import { triggerBugorCollect } from './actions';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

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
  Funding: 'Раунд',
  Hiring_Sales: 'Найм Sales',
  YC_Batch: 'YC Batch',
  Product_Launch: 'Запуск',
  Expansion: 'Расширение',
  Tech_Change: 'Tech Change',
  M_and_A: 'M&A',
  Partnership: 'Партнёрство',
  Award: 'Награда',
};

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

/** Dashboard page for the Bugor (ENG) outreach pipeline — shows leads, stats and filters. */
export default function BugorOutreachPage() {
  const [leads, setLeads] = useState<BugorLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [filterDate, setFilterDate] = useState(todayISO());
  const [filterPriority, setFilterPriority] = useState<string>('');
  const [filterSignal, setFilterSignal] = useState<string>('');

  /* ---- fetch leads ---- */

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterDate) params.set('batch_date', filterDate);
      if (filterPriority) params.set('priority', filterPriority);
      if (filterSignal) params.set('signal_type', filterSignal);

      const res = await fetch(`/api/tools/bugor-outreach/leads?${params}`);
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

  /* ---- manual collect ---- */

  const handleCollect = useCallback(async () => {
    setCollecting(true);
    setCollectError(null);
    try {
      const result = await triggerBugorCollect();
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

  /* ---- stats ---- */

  const stats = useMemo(() => {
    const total = leads.length;
    const redHot = leads.filter((l) => l.priority === 'RED_HOT').length;
    const hot = leads.filter((l) => l.priority === 'HOT').length;
    const warm = leads.filter((l) => l.priority === 'WARM').length;
    const withEmails = leads.filter((l) => l.emails_validated?.length > 0).length;
    const withSequence = leads.filter((l) => l.email_sequence?.length).length;
    const inInstantly = leads.filter((l) => l.instantly_uploaded).length;
    const today = todayISO();
    const inQueue = leads.filter((l) => !l.instantly_uploaded && l.email_sequence?.length && l.send_after > today).length;
    const usCount = leads.filter((l) => l.region === 'US').length;
    const euCount = leads.filter((l) => l.region === 'EU').length;
    return { total, redHot, hot, warm, withEmails, withSequence, inInstantly, inQueue, usCount, euCount };
  }, [leads]);

  /* ---- signal types for filter ---- */

  const signalTypes = useMemo(() => {
    const set = new Set(leads.map((l) => l.signal_type));
    return Array.from(set).sort();
  }, [leads]);

  /* ---- export ---- */

  const handleExport = useCallback(() => {
    const params = new URLSearchParams();
    if (filterDate) params.set('batch_date', filterDate);
    if (filterPriority) params.set('priority', filterPriority);
    window.open(`/api/tools/bugor-outreach/export?${params}`, '_blank');
  }, [filterDate, filterPriority]);

  /* ---- render ---- */

  return (
    <div className="space-y-6 text-left max-w-full">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Наш бугор аутрич</h1>
          <p className="text-sm text-gray-500">
            Ежедневный автосбор горячих лидов: раунды, найм SDR, YC-батчи, запуски.
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
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            <ArrowDownToLine className="h-4 w-4" />
            CSV
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 lg:grid-cols-10">
        <StatCard label="Всего" value={stats.total} color="bg-gray-100 text-gray-800" />
        <StatCard label="Red Hot" value={stats.redHot} color="bg-red-50 text-red-700" />
        <StatCard label="Hot" value={stats.hot} color="bg-orange-50 text-orange-700" />
        <StatCard label="Warm" value={stats.warm} color="bg-amber-50 text-amber-700" />
        <StatCard label="Email найден" value={stats.withEmails} color="bg-blue-50 text-blue-700" />
        <StatCard label="Цепочка" value={stats.withSequence} color="bg-violet-50 text-violet-700" />
        <StatCard label="В Instantly" value={stats.inInstantly} color="bg-green-50 text-green-700" />
        <StatCard label="В очереди" value={stats.inQueue} color="bg-yellow-50 text-yellow-700" />
        <StatCard label="US" value={stats.usCount} color="bg-sky-50 text-sky-700" />
        <StatCard label="EU" value={stats.euCount} color="bg-indigo-50 text-indigo-700" />
      </div>

      {collectError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {collectError}
        </div>
      )}

      {/* Filters */}
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
            onClick={() => {
              setFilterPriority('');
              setFilterSignal('');
              setFilterDate(todayISO());
            }}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Сбросить
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : leads.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-lg font-medium">Лидов пока нет</p>
            <p className="mt-1 text-sm">Нажмите &laquo;Собрать сейчас&raquo; или дождитесь утреннего сбора.</p>
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
                  <th className="px-3 py-3 text-center">Регион</th>
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

/* ------------------------------------------------------------------ */
/* sub-components                                                      */
/* ------------------------------------------------------------------ */

/** Compact metric card used in the stats grid. */
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-xl px-4 py-3 ${color}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium opacity-70">{label}</div>
    </div>
  );
}

/** Badge showing the current pipeline stage of a lead (email found → sequence → Instantly). */
function PipelineStatus({ lead }: { lead: BugorLead }) {
  if (lead.instantly_uploaded) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        <Send className="h-3 w-3" /> В Instantly
      </span>
    );
  }
  const today = todayISO();
  if (lead.email_sequence?.length && lead.send_after > today) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700" title={`Отправка после ${lead.send_after}`}>
        <Clock className="h-3 w-3" /> Очередь {lead.send_after.slice(5)}
      </span>
    );
  }
  if (lead.email_sequence?.length) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
        <Mail className="h-3 w-3" /> Цепочка готова
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

/** Expandable table row displaying a single Bugor outreach lead. */
function LeadRow({
  lead,
  expanded,
  onToggle,
}: {
  lead: BugorLead;
  expanded: boolean;
  onToggle: () => void;
}) {
  const PriorityIcon = PRIORITY_ICON[lead.priority] ?? Thermometer;

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors hover:bg-gray-50/60"
      >
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
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${PRIORITY_COLORS[lead.priority] ?? 'bg-gray-100 text-gray-600'}`}
          >
            <PriorityIcon className="h-3 w-3" />
            {PRIORITY_LABEL[lead.priority] ?? lead.priority}
          </span>
        </td>
        <td className="px-3 py-3">
          <PipelineStatus lead={lead} />
        </td>
        <td className="px-3 py-3 text-center">
          <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${lead.region === 'EU' ? 'bg-indigo-100 text-indigo-700' : 'bg-sky-100 text-sky-700'}`}>
            <Globe className="h-2.5 w-2.5" />
            {lead.region || 'US'}
          </span>
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
              {/* Lead details */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                <DetailField label="Описание" value={lead.description} />
                <DetailField label="Фаундер" value={lead.founder_name} />
                <DetailField label="LinkedIn" value={lead.founder_linkedin} link />
                <DetailField label="Тайминг" value={lead.timing} />
                <DetailField label="Отправка после" value={lead.send_after} />
                <DetailField label="Регион" value={lead.region || 'US'} />
                <DetailField label="Источник" value={lead.source_url} link />
                <DetailField label="Ниша" value={lead.niche} />
                <div className="sm:col-span-2 lg:col-span-3">
                  <DetailField label="Угол для письма" value={lead.outreach_angle} />
                </div>
              </div>

              {/* Found emails */}
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

              {/* Email sequence */}
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
                            {idx === 0 ? 'Day 0' : idx === 1 ? 'Day 3' : 'Day 7'}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-gray-900 mb-1">
                          {step.subject}
                        </div>
                        <div className="text-xs text-gray-600 whitespace-pre-line leading-relaxed">
                          {step.body}
                        </div>
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
function DetailField({
  label,
  value,
  link,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  link?: boolean;
  mono?: boolean;
}) {
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
        <div className={`text-gray-700 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
      )}
    </div>
  );
}
