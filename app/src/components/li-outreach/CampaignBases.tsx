'use client';

import { useEffect, useState } from 'react';

import { Download, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';

import { RowActionsMenu } from '@/components/sender/RowActionsMenu';

import { call, errorText } from './liApi';
import NewBaseModal, { type NewBaseAccount } from './NewBaseModal';

/**
 * Базы кампании LinkedIn: создание окном, очередь, просмотр людей.
 *
 * База принадлежит кампании. Кампания рассылает одну — активную — базу
 * (`lead_list_id` кампании), но баз у неё может быть несколько: они идут по
 * очереди, закончилась одна — начинается следующая.
 */

export interface LiBase {
  id: string;
  name: string;
  campaign_id?: string | null;
  owner_name?: string | null;
  leads_count?: number;
  has_custom_invites?: boolean;
}

interface BaseLead {
  id: string;
  name: string;
  position: string | null;
  company: string | null;
  profile_url: string | null;
  status: string;
}

const SHOWN_LEADS = 100;

export default function CampaignBases({
  campaignId,
  activeListId,
  bases,
  onChanged,
  focusBaseId = null,
  accounts,
}: {
  campaignId: string;
  /** База, которую кампания рассылает сейчас. */
  activeListId: string | null;
  bases: LiBase[];
  /** Перечитать базы и кампании после любого изменения. */
  onChanged: () => Promise<void>;
  /** Раскрыть эту базу при открытии (переход из скрапера к собранной базе). */
  focusBaseId?: string | null;
  /** Аккаунты, с которых скрапер может собирать людей. */
  accounts: NewBaseAccount[];
}) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [leads, setLeads] = useState<BaseLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [loadingLeads, setLoadingLeads] = useState(false);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      alert('Ошибка: ' + errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const makeActive = (listId: string) => call(`/campaigns/${campaignId}`, 'PUT', { lead_list_id: listId });

  const loadLeads = async (listId: string) => {
    setLoadingLeads(true);
    try {
      const d = await call<{ leads: BaseLead[]; total: number }>(`/leads?limit=200&lead_list_id=${encodeURIComponent(listId)}`, 'GET');
      setLeads(d.leads);
      setLeadsTotal(d.total);
    } catch (e) {
      alert('Ошибка: ' + errorText(e));
    } finally {
      setLoadingLeads(false);
    }
  };

  // Переход из скрапера: раскрываем собранную базу и прокручиваем к ней.
  useEffect(() => {
    if (!focusBaseId) return;
    setOpenId(focusBaseId);
    setLeads([]);
    void loadLeads(focusBaseId);
    window.setTimeout(() => document.getElementById(`li-base-${focusBaseId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBaseId]);

  const toggleLeads = async (listId: string) => {
    if (openId === listId) {
      setOpenId(null);
      return;
    }
    setOpenId(listId);
    setLeads([]);
    await loadLeads(listId);
  };

  const exportCsv = (base: LiBase) =>
    run(`export:${base.id}`, async () => {
      const d = await call<{ leads: Array<BaseLead & { first_name: string | null; last_name: string | null }> }>(
        `/leads?limit=1000&lead_list_id=${encodeURIComponent(base.id)}`,
        'GET',
      );
      const esc = (v: string | null | undefined) => `"${String(v ?? '').replaceAll('"', '""')}"`;
      const rows = [
        ['name', 'first_name', 'last_name', 'position', 'company', 'profile_url', 'status'].join(','),
        ...d.leads.map((l) => [esc(l.name), esc(l.first_name), esc(l.last_name), esc(l.position), esc(l.company), esc(l.profile_url), esc(l.status)].join(',')),
      ];
      const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `li_base_${base.name.replaceAll(/\s+/g, '_')}_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const remove = (base: LiBase) =>
    run(`delete:${base.id}`, async () => {
      if (!confirm(`Удалить базу «${base.name}» вместе с людьми?`)) return;
      await call(`/lead-lists/${base.id}`, 'DELETE');
      if (openId === base.id) setOpenId(null);
      await onChanged();
    });

  const button = 'cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-gray-400">
          Базы рассылаются по очереди: закончилась одна — кампания сама берёт следующую, без перезапуска.
        </p>
        <button type="button" onClick={() => setCreating(true)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
          <Plus className="h-3.5 w-3.5" />
          Создать базу
        </button>
      </div>

      {bases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-400">
          У кампании пока нет баз. Создайте базу: соберите людей скрапером или загрузите CSV.
        </div>
      ) : (
        <div className="space-y-3">
          {bases.map((base) => {
            const active = base.id === activeListId;
            return (
              <div key={base.id} id={`li-base-${base.id}`} className={`rounded-xl border bg-white p-4 ${active ? 'border-green-300' : 'border-gray-200'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 truncate text-sm font-semibold text-gray-900">{base.name}</div>
                  {active && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">рассылается</span>}
                  {base.has_custom_invites && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">✎ персональные инвайты</span>}
                  <span className="text-xs text-gray-500 tabular-nums">{base.leads_count ?? 0} чел.</span>
                  <div className="ml-auto flex items-center gap-1">
                    {!active && (
                      <button type="button" disabled={busy !== null} onClick={() => void run(`active:${base.id}`, async () => { await makeActive(base.id); await onChanged(); })} className={button} title="Кампания будет рассылать эту базу. Люди из неё попадут в рассылку в течение ~5 минут, перезапуск не нужен.">
                        Рассылать эту базу
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void toggleLeads(base.id)}
                      aria-label={openId === base.id ? 'Скрыть людей' : 'Показать людей'}
                      title={openId === base.id ? 'Скрыть людей' : 'Показать людей'}
                      className="row-actions-btn cursor-pointer rounded-md p-1.5"
                    >
                      {openId === base.id ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                    <RowActionsMenu
                      vertical
                      items={[
                        { label: 'Скачать CSV', icon: Download, disabled: busy !== null, onClick: () => void exportCsv(base) },
                        { label: 'Удалить', icon: Trash2, danger: true, disabled: busy !== null, onClick: () => void remove(base) },
                      ]}
                    />
                  </div>
                </div>

                {openId === base.id && (
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    {loadingLeads ? (
                      <div className="flex justify-center py-6" role="status" aria-label="Загрузка людей">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-blue-600" />
                      </div>
                    ) : leads.length === 0 ? (
                      <div className="text-xs text-gray-400">В базе пока никого нет.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-100 text-xs text-gray-500">
                              <th className="px-2 py-1.5 text-left font-medium">Имя</th>
                              <th className="px-2 py-1.5 text-left font-medium">Должность</th>
                              <th className="px-2 py-1.5 text-left font-medium">Компания</th>
                              <th className="px-2 py-1.5 text-left font-medium">Статус</th>
                            </tr>
                          </thead>
                          <tbody>
                            {leads.slice(0, SHOWN_LEADS).map((lead) => (
                              <tr key={lead.id} className="border-b border-gray-50">
                                <td className="max-w-[220px] truncate px-2 py-1.5">
                                  {lead.profile_url ? <a href={lead.profile_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{lead.name}</a> : lead.name}
                                </td>
                                <td className="max-w-[260px] truncate px-2 py-1.5 text-gray-700">{lead.position ?? ''}</td>
                                <td className="max-w-[260px] truncate px-2 py-1.5 text-gray-700">{lead.company ?? ''}</td>
                                <td className="px-2 py-1.5"><span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{lead.status}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-2 text-xs text-gray-400">
                          Показано {Math.min(leads.length, SHOWN_LEADS)} из {leadsTotal}. Все — в «Скачать CSV».
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <NewBaseModal
          campaignId={campaignId}
          activeListId={activeListId}
          accounts={accounts}
          onClose={() => setCreating(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

/**
 * Базы без кампании — наследство общих списков. Не удаляем: это чьи-то
 * загруженные люди; держим в свёрнутом списке и просим перенести в кампанию.
 */
export function OrphanBases({
  bases,
  campaigns,
  onChanged,
}: {
  bases: LiBase[];
  campaigns: Array<{ id: string; name: string; lead_list_id: string | null }>;
  onChanged: () => Promise<void>;
}) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  if (bases.length === 0) return null;

  const move = async (base: LiBase) => {
    const campaignId = pick[base.id];
    if (!campaignId) return;
    setBusy(base.id);
    try {
      await call(`/lead-lists/${base.id}`, 'PUT', { campaign_id: campaignId });
      // В кампании без рассылаемой базы перенесённая становится рассылаемой.
      const campaign = campaigns.find((c) => c.id === campaignId);
      if (campaign && !campaign.lead_list_id) await call(`/campaigns/${campaignId}`, 'PUT', { lead_list_id: base.id });
      await onChanged();
    } catch (e) {
      alert('Ошибка: ' + errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="group space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
      <summary className="cursor-pointer text-xs font-medium text-amber-900">Базы без кампании ({bases.length})</summary>
      <p className="text-[10px] text-amber-800">
        Остались от общих списков и не привязаны ни к одной кампании. Перенесите нужные в кампанию, чтобы они рассылались.
      </p>
      <div className="space-y-1.5">
        {bases.map((base) => (
          <div key={base.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{base.name}</span>
            <span className="tabular-nums text-gray-500">{base.leads_count ?? 0} чел.</span>
            <select
              value={pick[base.id] ?? ''}
              onChange={(e) => setPick((prev) => ({ ...prev, [base.id]: e.target.value }))}
              aria-label={`Кампания для базы ${base.name}`}
              className="max-w-[220px] rounded-lg border border-gray-200 px-2 py-1"
            >
              <option value="">Выберите кампанию</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              type="button"
              disabled={!pick[base.id] || busy !== null}
              onClick={() => void move(base)}
              className="cursor-pointer rounded-lg bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === base.id ? '…' : 'Перенести'}
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
