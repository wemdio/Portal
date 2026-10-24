'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';

import { LiFunnelChart, LiInviteChart, type LiFunnel, type LiTimelineDay } from '@/components/li-outreach/LiDashboardCharts';

/**
 * Дашборд LinkedIn Outreach: главное — инвайты, принятые, ответы; по всем
 * кампаниям или по одной; ниже — работа аккаунтов. Только отрисовка готовых
 * чисел из /dashboard: активность по дням и по аккаунтам считает сервер по
 * журналу кампаний (отправленные инвайты и сообщения, ошибки).
 */

export interface LiAccountActivity {
  account_id: string;
  invites_today: number;
  invites: number;
  messages: number;
  errors: number;
  last_action_at: string | null;
}

export interface LiActivity {
  timeline: LiTimelineDay[];
  accounts: LiAccountActivity[];
}

export interface LiDashCampaign {
  id: string;
  name: string;
  status: string;
  daily_invite_limit: number;
  invites_sent_today: number;
  accepted: number;
  replied: number;
  funnel: LiFunnel;
  activity: LiActivity;
}

export interface LiDashData {
  period?: { from: string; to: string; days: number };
  funnel: LiFunnel;
  campaign_stats: LiDashCampaign[];
  activity: LiActivity;
}

/** Период статистики: 7, 14 или 30 дней, либо свои даты (YYYY-MM-DD). */
export interface LiDashPeriod {
  mode: '7' | '14' | '30' | 'custom';
  from: string;
  to: string;
}

const PERIOD_OPTIONS: Array<{ mode: LiDashPeriod['mode']; label: string }> = [
  { mode: '7', label: '7 дней' },
  { mode: '14', label: '14 дней' },
  { mode: '30', label: '30 дней' },
  { mode: 'custom', label: 'Свой период' },
];

function periodLabel(period: LiDashPeriod, data: { period?: { from: string; to: string; days: number } }): string {
  if (period.mode !== 'custom') return `за ${period.mode} дней`;
  const ru = (iso: string) => iso.split('-').reverse().join('.');
  return data.period ? `${ru(data.period.from)} — ${ru(data.period.to)}` : 'за выбранный период';
}

export interface LiDashAccount {
  id: string;
  name: string | null;
  is_active: boolean;
  cooldown_until: string | null;
  /** Когда аккаунт попал на портал (синхронизация с Unipile). */
  created_at?: string | null;
  campaigns?: Array<{ id: string; name: string; status: string }>;
}

function pct(value: number, base: number): string {
  return base > 0 ? `${Math.round((value / base) * 100)}%` : '—';
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function formatMoment(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Оттенок блока: лёгкий фон и рамка, цвет подписи и значения. */
// Фон задаётся классом kpi-tint-* из globals.css: тема гасит обычные bg-*-50.
const KPI_TONES = {
  violet: { box: 'kpi-tint-violet', value: 'kpi-value-violet' },
  sky: { box: 'kpi-tint-sky', value: 'kpi-value-sky' },
  green: { box: 'kpi-tint-green', value: 'kpi-value-green' },
  teal: { box: 'kpi-tint-teal', value: 'kpi-value-teal' },
  amber: { box: 'kpi-tint-amber', value: 'kpi-value-amber' },
} as const;

function Kpi({
  label,
  value,
  caption,
  tone,
  color,
  onClick,
}: {
  label: string;
  value: string | number;
  caption?: string;
  tone?: 'danger';
  color?: keyof typeof KPI_TONES;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1 text-[11px] text-gray-500">
        <span>{label}</span>
        {onClick && <span className="ml-auto text-gray-300 transition group-hover:text-indigo-500" aria-hidden>→</span>}
      </div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${tone === 'danger' ? 'text-rose-600' : color ? KPI_TONES[color].value : 'text-gray-900'}`}>{value}</div>
      {caption ? <div className="mt-0.5 truncate text-[10px] text-gray-400">{caption}</div> : null}
    </>
  );
  const base = `min-w-0 rounded-xl border px-3 py-2.5 ${color ? KPI_TONES[color].box : 'border-gray-200 bg-white'}`;
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`group w-full cursor-pointer text-left transition hover:border-indigo-300 hover:shadow-sm ${base}`}
    >
      {body}
    </button>
  ) : (
    <div className={base}>{body}</div>
  );
}

/**
 * Выбор кампании: заметная кнопка с названием и стрелкой, список с цветными
 * точками статуса. Обычный select в тёмной теме сливался с фоном.
 */
function CampaignPicker({
  campaigns,
  value,
  onChange,
}: {
  campaigns: Array<{ id: string; name: string; status: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = campaigns.find((c) => c.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const dot = (status: string) => (status === 'running' ? 'bg-green-500' : status === 'draft' ? 'bg-gray-400' : 'bg-amber-500');
  const item = 'li-picker-item flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Выбрать кампанию"
        onClick={() => setOpen((v) => !v)}
        className="li-picker inline-flex min-w-[240px] max-w-[340px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
      >
        <span className="font-normal text-gray-500">Кампания:</span>
        <span className="min-w-0 flex-1 truncate text-left">{current ? current.name : 'Все кампании'}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="listbox" className="li-picker-menu absolute left-0 top-full z-30 mt-1.5 max-h-72 min-w-full overflow-y-auto rounded-lg border py-1 shadow-xl">
          <button type="button" role="option" aria-selected={!value} onClick={() => { onChange(''); setOpen(false); }} className={item}>
            <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            <span className="min-w-0 flex-1 truncate font-medium">Все кампании</span>
            {!value && <Check className="h-4 w-4 shrink-0" />}
          </button>
          {campaigns.map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={c.id === value} onClick={() => { onChange(c.id); setOpen(false); }} className={item}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot(c.status)}`} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.id === value && <Check className="h-4 w-4 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LiPeriodPicker({
  period,
  onChange,
}: {
  period: LiDashPeriod;
  onChange: (next: LiDashPeriod) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="li-period inline-flex gap-0.5 rounded-lg border p-0.5 text-sm" role="group" aria-label="Период">
        {PERIOD_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={period.mode === option.mode}
            onClick={() => onChange({ ...period, mode: option.mode })}
            className={`li-period-btn cursor-pointer rounded-md px-3 py-1 font-medium ${period.mode === option.mode ? 'li-period-btn-on' : ''}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {period.mode === 'custom' && (
        <div className="flex items-center gap-1.5 text-sm">
          <input
            type="date"
            aria-label="С"
            value={period.from}
            max={period.to || undefined}
            onChange={(e) => onChange({ ...period, from: e.target.value })}
            className="li-filter rounded-lg border px-2 py-1"
          />
          <span className="text-gray-400">—</span>
          <input
            type="date"
            aria-label="По"
            value={period.to}
            min={period.from || undefined}
            onChange={(e) => onChange({ ...period, to: e.target.value })}
            className="li-filter rounded-lg border px-2 py-1"
          />
        </div>
      )}
    </div>
  );
}

export default function LiDashboard({
  data,
  period,
  onPeriodChange,
  accounts,
  onOpenAccounts,
  onOpenCampaigns,
}: {
  data: LiDashData;
  period: LiDashPeriod;
  onPeriodChange: (next: LiDashPeriod) => void;
  accounts: LiDashAccount[];
  onOpenAccounts: () => void;
  onOpenCampaigns: () => void;
}) {
  const [campaignId, setCampaignId] = useState('');
  const selected = campaignId ? data.campaign_stats.find((c) => c.id === campaignId) ?? null : null;

  const view = useMemo(() => {
    const scope = selected ? [selected] : data.campaign_stats;
    const funnel = selected ? selected.funnel : data.funnel;
    const activity = selected ? selected.activity : data.activity;
    // Отправлено инвайтов за период — по журналу кампаний.
    const sent = activity.timeline.reduce((sum, d) => sum + d.invites, 0);
    const accepted = scope.reduce((sum, c) => sum + c.accepted, 0);
    const replied = scope.reduce((sum, c) => sum + c.replied, 0);
    const running = scope.filter((c) => c.status === 'running');
    return {
      funnel,
      activity,
      sent,
      accepted,
      replied,
      today: scope.reduce((sum, c) => sum + c.invites_sent_today, 0),
      limit: running.reduce((sum, c) => sum + c.daily_invite_limit, 0),
      messages: activity.timeline.reduce((sum, d) => sum + d.messages, 0),
      errors: activity.timeline.reduce((sum, d) => sum + d.errors, 0),
    };
  }, [data, selected]);

  const accountRows = useMemo(() => {
    const byId = new Map(view.activity.accounts.map((a) => [a.account_id, a]));
    return accounts
      .filter((a) => !selected || byId.has(a.id) || a.campaigns?.some((c) => c.id === selected.id))
      .map((a) => ({ account: a, act: byId.get(a.id) }))
      .sort((x, y) => (y.act?.invites ?? 0) - (x.act?.invites ?? 0));
  }, [accounts, view.activity.accounts, selected]);

  const activeAccounts = accounts.filter((a) => a.is_active).length;
  const runningCampaigns = data.campaign_stats.filter((c) => c.status === 'running').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CampaignPicker campaigns={data.campaign_stats} value={campaignId} onChange={setCampaignId} />
        <LiPeriodPicker period={period} onChange={onPeriodChange} />
        <h2 className="ml-auto text-sm font-semibold text-gray-900">
          Статистика{selected ? ` — ${selected.name}` : ''} <span className="font-normal text-gray-400">{periodLabel(period, data)}</span>
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 [&>*]:min-w-0">
        <Kpi label="Аккаунты" color="violet" value={`${activeAccounts}/${accounts.length}`} caption="активных / всего" onClick={onOpenAccounts} />
        <Kpi label="Кампании" color="sky" value={`${runningCampaigns}/${data.campaign_stats.length}`} caption="запущено / всего" onClick={onOpenCampaigns} />
        <Kpi
          label="Инвайтов отправлено"
          color="amber"
          value={view.sent}
          caption={view.limit > 0 ? `сегодня ${view.today} из ${view.limit}` : `сегодня ${view.today}`}
        />
        <Kpi label="Принято" color="green" value={view.accepted} caption={`${pct(view.accepted, view.sent)} от отправленных`} />
        <Kpi label="Ответили" color="teal" value={view.replied} caption={`${pct(view.replied, view.accepted)} от принявших`} />
        <Kpi
          label={`Ошибок ${periodLabel(period, data)}`}
          value={view.errors}
          caption={`сообщений отправлено: ${view.messages}`}
          tone={view.errors > 0 ? 'danger' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5 [&>*]:min-w-0">
        <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-3">
          <div className="mb-1 flex items-center gap-3 text-xs">
            <h3 className="text-sm font-semibold text-gray-900">Инвайты и сообщения по дням</h3>
          </div>
          <LiInviteChart timeline={view.activity.timeline} height={250} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Воронка контактов</h3>
          <LiFunnelChart funnel={view.funnel} height={250} />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Аккаунты</h3>
          <button
            type="button"
            onClick={onOpenAccounts}
            className="li-link-pill group inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
          >
            Все аккаунты
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>
        {accountRows.length === 0 ? (
          <p className="text-xs text-gray-400">Нет аккаунтов{selected ? ' в этой кампании' : ''}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="w-[22%] px-3 py-1.5 text-left font-medium">Аккаунт</th>
                  <th className="w-[16%] px-3 py-1.5 text-left font-medium">Статус</th>
                  <th className="w-[14%] px-3 py-1.5 text-right font-medium">Инвайтов за период</th>
                  <th className="w-[14%] px-3 py-1.5 text-right font-medium">Инвайтов сегодня</th>
                  <th className="w-[12%] px-3 py-1.5 text-right font-medium">Сообщений</th>
                  <th className="w-[10%] px-3 py-1.5 text-right font-medium">Ошибок</th>
                  <th className="w-[12%] px-3 py-1.5 text-right font-medium">Добавлен на портал</th>
                </tr>
              </thead>
              <tbody>
                {accountRows.map(({ account, act }) => {
                  const cooling = account.cooldown_until && new Date(account.cooldown_until).getTime() > Date.now();
                  const status = !account.is_active
                    ? { text: 'выключен', cls: 'bg-gray-100 text-gray-600' }
                    : cooling
                      ? { text: `пауза до ${formatMoment(account.cooldown_until)}`, cls: 'bg-amber-100 text-amber-700' }
                      : { text: 'работает', cls: 'bg-green-100 text-green-700' };
                  return (
                    <tr key={account.id} className="li-row-hover border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="truncate px-3 py-2 font-medium text-gray-900">{account.name ?? 'Без имени'}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.cls}`}>{status.text}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{act?.invites ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{act?.invites_today ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{act?.messages ?? 0}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${(act?.errors ?? 0) > 0 ? 'font-medium text-rose-600' : 'text-gray-700'}`}>{act?.errors ?? 0}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-gray-500">{formatDate(account.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
