'use client';

import { LiPeriodPicker, type LiDashCampaign, type LiDashPeriod } from '@/components/li-outreach/LiDashboard';
import { LiFunnelChart, LiInviteChart } from '@/components/li-outreach/LiDashboardCharts';

/**
 * Сводка по кампании — первое, что видно при входе в неё (как «Analytics» в
 * «Рассылке»): плитки, график по дням, воронка и аккаунты кампании. Только
 * отрисовка готовых чисел из /dashboard за выбранный там период.
 */

const nf = (value: number) => value.toLocaleString('ru-RU');

function Tile({ label, value, caption, tint, valueClass }: { label: string; value: string; caption?: string; tint?: string; valueClass?: string }) {
  return (
    <div className={`min-w-0 rounded-xl border px-4 py-3.5 ${tint ?? 'border-gray-200 bg-white'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass ?? 'text-gray-900'}`}>{value}</div>
      {caption ? <div className="mt-0.5 truncate text-[11px] text-gray-400">{caption}</div> : null}
    </div>
  );
}

export interface CampaignSummaryAccount {
  id: string;
  name: string;
}

export default function CampaignSummary({
  stats,
  accounts,
  periodText,
  period,
  onPeriodChange,
}: {
  stats: LiDashCampaign | undefined;
  accounts: CampaignSummaryAccount[];
  periodText: string;
  period: LiDashPeriod;
  onPeriodChange: (next: LiDashPeriod) => void;
}) {
  if (!stats) {
    return <p className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">Статистика по этой кампании пока недоступна.</p>;
  }
  const timeline = stats.activity.timeline;
  const invites = timeline.reduce((sum, d) => sum + d.invites, 0);
  const messages = timeline.reduce((sum, d) => sum + d.messages, 0);
  const errors = timeline.reduce((sum, d) => sum + d.errors, 0);
  const acceptPct = invites > 0 ? `${Math.min(100, Math.round((stats.accepted / invites) * 100))}%` : '—';
  const replyPct = stats.accepted > 0 ? `${Math.min(100, Math.round((stats.replied / stats.accepted) * 100))}%` : '—';
  const byAccount = new Map(stats.activity.accounts.map((a) => [a.account_id, a]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <LiPeriodPicker period={period} onChange={onPeriodChange} />
        <p className="text-xs text-gray-500">Статистика {periodText}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 [&>*]:min-w-0">
        <Tile label="Контактов в рассылке" value={nf(stats.funnel.total)} caption="всего в базе кампании" tint="kpi-tint-sky" valueClass="kpi-value-sky" />
        <Tile
          label="Инвайтов отправлено"
          value={nf(invites)}
          caption={`сегодня ${stats.invites_sent_today} из ${stats.daily_invite_limit}`}
          tint="kpi-tint-amber"
          valueClass="kpi-value-amber"
        />
        <Tile label="Принято" value={nf(stats.accepted)} caption={`${acceptPct} от отправленных`} tint="kpi-tint-green" valueClass="kpi-value-green" />
        <Tile label="Ответили" value={nf(stats.replied)} caption={`${replyPct} от принявших`} tint="kpi-tint-teal" valueClass="kpi-value-teal" />
        <Tile label="Ошибок" value={nf(errors)} caption={`сообщений отправлено: ${nf(messages)}`} valueClass={errors > 0 ? 'text-rose-600' : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5 [&>*]:min-w-0">
        <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-3">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Инвайты и сообщения по дням</h3>
          <LiInviteChart timeline={timeline} height={240} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Воронка контактов</h3>
          <LiFunnelChart funnel={stats.funnel} height={240} />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Аккаунты кампании</h3>
        {accounts.length === 0 ? (
          <p className="text-xs text-gray-400">Аккаунты не выбраны — задайте их в настройках кампании.</p>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-500">
                <th className="px-3 py-1.5 text-left font-medium">Аккаунт</th>
                <th className="w-[16%] px-3 py-1.5 text-right font-medium">Инвайтов за период</th>
                <th className="w-[16%] px-3 py-1.5 text-right font-medium">Сегодня</th>
                <th className="w-[16%] px-3 py-1.5 text-right font-medium">Сообщений</th>
                <th className="w-[12%] px-3 py-1.5 text-right font-medium">Ошибок</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const act = byAccount.get(account.id);
                return (
                  <tr key={account.id} className="li-row-hover border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="truncate px-3 py-2 font-medium text-gray-900">{account.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{act?.invites ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{act?.invites_today ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{act?.messages ?? 0}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${(act?.errors ?? 0) > 0 ? 'font-medium text-rose-600' : 'text-gray-700'}`}>{act?.errors ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
