'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Flame,
  Loader2,
  Mail,
  RefreshCw,
  Settings2,
  Thermometer,
  Snowflake,
} from 'lucide-react';
import type { EventLead } from '@/lib/eventOutreach/types';
import { triggerEventCollect } from './actions';

const TIER_META: Record<string, { label: string; color: string; icon: typeof Flame }> = {
  hot: { label: 'Hot', color: 'bg-orange-100 text-orange-700', icon: Flame },
  warm: { label: 'Warm', color: 'bg-amber-100 text-amber-700', icon: Thermometer },
  cold: { label: 'Cold', color: 'bg-sky-100 text-sky-700', icon: Snowflake },
};

const SIGNAL_LABELS: Record<string, string> = {
  anniversary: 'Юбилей',
  seeking_event_manager: 'Ищут ивент-менеджера',
  large_company: 'Крупная компания',
  mid_company: 'Средняя компания',
};

/** Dashboard for the event-agency outreach tool. */
export default function EventOutreachPage() {
  const [leads, setLeads] = useState<EventLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [limit, setLimit] = useState(100);
  const [minEmployees, setMinEmployees] = useState(0);
  const [filterTier, setFilterTier] = useState('');
  const [showConfig, setShowConfig] = useState(false);

  /* ---- leads ---- */

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterTier) params.set('tier', filterTier);
      const res = await fetch(`/api/tools/event-outreach/leads?${params}`);
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      setLeads(data.leads ?? []);
    } catch {
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, [filterTier]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  /* ---- collect ---- */

  const handleCollect = useCallback(async () => {
    setCollecting(true);
    setStatusMsg(null);
    setStatusError(false);
    try {
      const result = await triggerEventCollect({
        limit,
        minEmployees: minEmployees > 0 ? minEmployees : undefined,
      });
      if (result.ok && result.stats) {
        const s = result.stats;
        setStatusMsg(
          `Готово: ${s.inserted} компаний (hot ${s.hot}, warm ${s.warm}, cold ${s.cold}), ` +
            `email найден у ${s.emailsFound}, хуков ${s.hooksGenerated}.`,
        );
        await fetchLeads();
      } else {
        setStatusError(true);
        setStatusMsg(result.error ?? 'Сбор не удался');
      }
    } catch {
      setStatusError(true);
      setStatusMsg('Ошибка сети');
    } finally {
      setCollecting(false);
    }
  }, [limit, minEmployees, fetchLeads]);

  /* ---- export ---- */

  const handleExport = useCallback(() => {
    const params = new URLSearchParams();
    if (filterTier) params.set('tier', filterTier);
    window.open(`/api/tools/event-outreach/export?${params}`, '_blank');
  }, [filterTier]);

  /* ---- stats ---- */

  const stats = useMemo(() => {
    const total = leads.length;
    const hot = leads.filter((l) => l.tier === 'hot').length;
    const warm = leads.filter((l) => l.tier === 'warm').length;
    const cold = leads.filter((l) => l.tier === 'cold').length;
    const withEmail = leads.filter((l) => !!l.email).length;
    const withHook = leads.filter((l) => !!l.hook).length;
    return { total, hot, warm, cold, withEmail, withHook };
  }, [leads]);

  return (
    <div className="space-y-6 text-left max-w-full">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ивент аутрич</h1>
          <p className="text-sm text-gray-500">
            Сбор базы под ивент-агентство: фильтр реестра, сигналы (юбилей, HH, размер) и
            персонализированный hook для каждой компании.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            Компаний
            <input
              type="number"
              min={1}
              max={2000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))}
              className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            Сотрудников от
            <input
              type="number"
              min={0}
              value={minEmployees}
              onChange={(e) => setMinEmployees(Math.max(0, Number(e.target.value) || 0))}
              className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            onClick={handleCollect}
            disabled={collecting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
          >
            {collecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {collecting ? 'Собираю…' : 'Собрать базу'}
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

      {collecting && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-700">
          Сбор может занять несколько минут: парсинг HH, поиск почт и генерация хуков.
        </div>
      )}

      {statusMsg && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            statusError
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-green-50 border-green-200 text-green-700'
          }`}
        >
          {statusMsg}
        </div>
      )}

      {/* Agency config */}
      <AgencyConfigPanel open={showConfig} onToggle={() => setShowConfig((v) => !v)} />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <StatCard label="Всего" value={stats.total} color="bg-gray-100 text-gray-800" />
        <StatCard label="Hot" value={stats.hot} color="bg-orange-50 text-orange-700" />
        <StatCard label="Warm" value={stats.warm} color="bg-amber-50 text-amber-700" />
        <StatCard label="Cold" value={stats.cold} color="bg-sky-50 text-sky-700" />
        <StatCard label="С email" value={stats.withEmail} color="bg-blue-50 text-blue-700" />
        <StatCard label="С хуком" value={stats.withHook} color="bg-violet-50 text-violet-700" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterTier}
          onChange={(e) => setFilterTier(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">Все tier</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : leads.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <p className="text-lg font-medium">Базы пока нет</p>
            <p className="mt-1 text-sm">Настройте профиль агентства и нажмите «Собрать базу».</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="w-8 px-3 py-3" />
                  <th className="px-3 py-3">Компания</th>
                  <th className="px-3 py-3">Отрасль</th>
                  <th className="px-3 py-3">Сигналы</th>
                  <th className="px-3 py-3">Tier</th>
                  <th className="px-3 py-3">Email</th>
                  <th className="px-3 py-3 hidden lg:table-cell">Hook</th>
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

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-xl px-4 py-3 ${color}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium opacity-70">{label}</div>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const meta = TIER_META[tier] ?? TIER_META.cold;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.color}`}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function LeadRow({
  lead,
  expanded,
  onToggle,
}: {
  lead: EventLead;
  expanded: boolean;
  onToggle: () => void;
}) {
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
        <td className="px-3 py-3 text-gray-600">{lead.industry ?? '—'}</td>
        <td className="px-3 py-3">
          <div className="flex flex-wrap gap-1">
            {lead.detected_signals.length === 0 ? (
              <span className="text-xs text-gray-400">—</span>
            ) : (
              lead.detected_signals.map((s) => (
                <span
                  key={s}
                  className="inline-block rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700"
                >
                  {SIGNAL_LABELS[s] ?? s}
                </span>
              ))
            )}
          </div>
        </td>
        <td className="px-3 py-3">
          <TierBadge tier={lead.tier} />
        </td>
        <td className="px-3 py-3">
          {lead.email ? (
            <span className="inline-flex items-center gap-1 text-xs font-mono text-gray-700">
              <Mail className="h-3 w-3 text-gray-400" />
              {lead.email}
            </span>
          ) : (
            <span className="text-xs text-gray-400">нет</span>
          )}
        </td>
        <td className="px-3 py-3 hidden lg:table-cell">
          <span className="text-xs text-gray-500 line-clamp-2">{lead.hook ?? '—'}</span>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-gray-50/40">
          <td />
          <td colSpan={6} className="px-3 py-4">
            <div className="space-y-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Detail label="ИНН" value={lead.inn} />
                <Detail label="ОГРН" value={lead.ogrn} />
                <Detail label="Возраст компании" value={lead.company_age != null ? `${lead.company_age} лет` : null} />
                <Detail
                  label="Юбилей"
                  value={lead.is_anniversary ? `да, в ${lead.anniversary_year}` : 'нет'}
                />
                <Detail label="Сотрудников" value={lead.employees_count?.toLocaleString('ru')} />
                <Detail label="Выручка" value={lead.revenue ? `${lead.revenue.toLocaleString('ru')} ₽` : null} />
                <Detail label="Ивент-вакансий на HH" value={String(lead.hh_vacancies_count)} />
                <Detail label="Источник email" value={lead.email_source} />
                <div className="sm:col-span-2 lg:col-span-4">
                  <Detail label="Адрес" value={lead.address} />
                </div>
              </div>

              {lead.subject_line && (
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-0.5">Тема письма</div>
                  <div className="font-medium text-gray-900">{lead.subject_line}</div>
                </div>
              )}
              {lead.hook && (
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-0.5">Hook</div>
                  <div className="rounded-lg border border-gray-200 bg-white p-3 text-gray-700 whitespace-pre-line leading-relaxed">
                    {lead.hook}
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

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs font-medium text-gray-400 mb-0.5">{label}</div>
      <div className="text-gray-700 break-words">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agency config panel                                                 */
/* ------------------------------------------------------------------ */

function AgencyConfigPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [agencyName, setAgencyName] = useState('');
  const [services, setServices] = useState('');
  const [tone, setTone] = useState('');
  const [hookExamples, setHookExamples] = useState('');
  const [painPoints, setPainPoints] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    void (async () => {
      try {
        const res = await fetch('/api/tools/event-outreach/config');
        const data = await res.json();
        const cfg: Record<string, string> = data.config ?? {};
        setAgencyName(cfg.agency_name ?? '');
        setServices(safeJsonArrayToLines(cfg.agency_services));
        setTone(cfg.agency_tone ?? '');
        setHookExamples(cfg.hook_examples ?? '');
        setPainPoints(cfg.industry_pain_points ?? '');
      } catch {
        /* ignore */
      } finally {
        setLoaded(true);
      }
    })();
  }, [open, loaded]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, string> = {
        agency_name: agencyName,
        agency_services: JSON.stringify(
          services.split('\n').map((s) => s.trim()).filter(Boolean),
        ),
        agency_tone: tone,
        hook_examples: hookExamples.trim() || '[]',
        industry_pain_points: painPoints.trim() || '{}',
      };
      const res = await fetch('/api/tools/event-outreach/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSaveMsg(res.ok ? 'Сохранено' : 'Ошибка сохранения');
    } catch {
      setSaveMsg('Ошибка сети');
    } finally {
      setSaving(false);
    }
  }, [agencyName, services, tone, hookExamples, painPoints]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-gray-700"
      >
        <span className="inline-flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-gray-400" />
          Профиль ивент-агентства
        </span>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>

      {open && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-4">
          <Field label="Название агентства">
            <input
              value={agencyName}
              onChange={(e) => setAgencyName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label="Услуги (по одной в строке)">
            <textarea
              value={services}
              onChange={(e) => setServices(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-mono"
            />
          </Field>
          <Field label="Tone of voice">
            <textarea
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            />
          </Field>
          <Field label='Примеры хуков — JSON: [{"signal":"…","hook":"…"}]'>
            <textarea
              value={hookExamples}
              onChange={(e) => setHookExamples(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
            />
          </Field>
          <Field label='Отраслевые боли — JSON: {"IT":"…","Строительство":"…"}'>
            <textarea
              value={painPoints}
              onChange={(e) => setPainPoints(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
            />
          </Field>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Сохранить
            </button>
            {saveMsg && <span className="text-sm text-gray-500">{saveMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-500">{label}</label>
      {children}
    </div>
  );
}

function safeJsonArrayToLines(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').join('\n') : '';
  } catch {
    return '';
  }
}
