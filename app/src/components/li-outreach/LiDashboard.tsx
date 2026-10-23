'use client';

import { useMemo, useState } from 'react';

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
  funnel: LiFunnel;
  campaign_stats: LiDashCampaign[];
  activity: LiActivity;
}

export interface LiDashAccount {
  id: string;
  name: string | null;
  is_active: boolean;
  cooldown_until: string | null;
  campaigns?: Array<{ id: string; name: string; status: string }>;
}

function pct(value: number, base: number): string {
  return base > 0 ? `${Math.round((value / base) * 100)}%` : '—';
}

function formatMoment(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Kpi({
  label,
  value,
  caption,
  tone,
  onClick,
}: {
  label: string;
  value: string | number;
  caption?: string;
  tone?: 'danger';
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1 text-[11px] text-gray-500">
        <span>{label}</span>
        {onClick && <span className="ml-auto text-gray-300 transition group-hover:text-indigo-500" aria-hidden>→</span>}
      </div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${tone === 'danger' ? 'text-rose-600' : 'text-gray-900'}`}>{value}</div>
      {caption ? <div className="mt-0.5 truncate text-[10px] text-gray-400">{caption}</div> : null}
    </>
  );
  const base = 'min-w-0 rounded-xl border border-gray-200 bg-white px-3 py-2.5';
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

export default function LiDashboard({
  data,
  accounts,
  onOpenAccounts,
  onOpenCampaigns,
}: {
  data: LiDashData;
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
    // Отправлено инвайтов = лиды, дошедшие до инвайта и дальше (без «уже приглашены ранее»).
    const sent = funnel.invited + funnel.connected + funnel.messaged + funnel.replied + funnel.completed;
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">
          Статистика{selected ? ` — ${selected.name}` : ''} <span className="font-normal text-gray-400">за 30 дней</span>
        </h2>
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          aria-label="Кампания"
          className="max-w-[280px] rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">Все кампании</option>
          {data.campaign_stats.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 [&>*]:min-w-0">
        <Kpi label="Аккаунты" value={`${activeAccounts}/${accounts.length}`} caption="активных / всего" onClick={onOpenAccounts} />
        <Kpi label="Кампании" value={`${runningCampaigns}/${data.campaign_stats.length}`} caption="запущено / всего" onClick={onOpenCampaigns} />
        <Kpi
          label="Инвайтов отправлено"
          value={view.sent}
          caption={view.limit > 0 ? `сегодня ${view.today} из ${view.limit}` : `сегодня ${view.today}`}
        />
        <Kpi label="Принято" value={view.accepted} caption={`${pct(view.accepted, view.sent)} от отправленных`} />
        <Kpi label="Ответили" value={view.replied} caption={`${pct(view.replied, view.accepted)} от принявших`} />
        <Kpi
          label="Ошибок за 30 дней"
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
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Воронка лидов</h3>
          <LiFunnelChart funnel={view.funnel} height={250} />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Аккаунты</h3>
          <button type="button" onClick={onOpenAccounts} className="cursor-pointer text-xs text-indigo-600 hover:text-indigo-700">
            Все аккаунты →
          </button>
        </div>
        {accountRows.length === 0 ? (
          <p className="text-xs text-gray-400">Нет аккаунтов{selected ? ' в этой кампании' : ''}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="px-2 py-1.5 text-left font-medium">Аккаунт</th>
                  <th className="px-2 py-1.5 text-left font-medium">Статус</th>
                  <th className="px-2 py-1.5 text-right font-medium">Инвайтов сегодня</th>
                  <th className="px-2 py-1.5 text-right font-medium">Инвайтов за 30 дн.</th>
                  <th className="px-2 py-1.5 text-right font-medium">Сообщений</th>
                  <th className="px-2 py-1.5 text-right font-medium">Ошибок</th>
                  <th className="px-2 py-1.5 text-right font-medium">Последнее действие</th>
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
                    <tr key={account.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="max-w-[220px] truncate px-2 py-2 font-medium text-gray-900">{account.name ?? 'Без имени'}</td>
                      <td className="px-2 py-2">
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.cls}`}>{status.text}</span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-700">{act?.invites_today ?? 0}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-700">{act?.invites ?? 0}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-700">{act?.messages ?? 0}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${(act?.errors ?? 0) > 0 ? 'font-medium text-rose-600' : 'text-gray-700'}`}>{act?.errors ?? 0}</td>
                      <td className="px-2 py-2 text-right text-xs tabular-nums text-gray-500">{formatMoment(act?.last_action_at ?? null)}</td>
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
