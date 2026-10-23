'use client';

import { useRef, useState } from 'react';

import { authFetchJson, getAccessToken } from '@/lib/authFetch';

/**
 * Базы кампании LinkedIn: загрузка, активная база, просмотр людей.
 *
 * База принадлежит кампании. Кампания рассылает одну — активную — базу
 * (`lead_list_id` кампании), но баз у неё может быть несколько: следующую
 * загружают заранее и переключают, когда нужно.
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

const API = '/api/tools/li-outreach';
const SHOWN_LEADS = 100;

function call<T = unknown>(path: string, method: string, json?: unknown): Promise<T> {
  return authFetchJson<T>(`${API}${path}`, {
    method,
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }),
  });
}

async function upload(path: string, fields: Record<string, string>, file: File): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const fd = new FormData();
  fd.append('file', file);
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function CampaignBases({
  campaignId,
  activeListId,
  bases,
  onChanged,
  onOpenScraper,
}: {
  campaignId: string;
  /** База, которую кампания рассылает сейчас. */
  activeListId: string | null;
  bases: LiBase[];
  /** Перечитать базы и кампании после любого изменения. */
  onChanged: () => Promise<void>;
  onOpenScraper: (listId: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [leads, setLeads] = useState<BaseLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);
  const invitesInput = useRef<HTMLInputElement>(null);
  // База, в которую сейчас выбирают файл: у скрытого input один обработчик на все карточки.
  const target = useRef<string | null>(null);

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

  const createBase = () =>
    run('create', async () => {
      const name = newName.trim();
      if (!name) return;
      const d = await call<{ lead_list: { id: string } }>('/lead-lists', 'POST', { name, campaign_id: campaignId });
      // Первая база кампании сразу становится рассылаемой.
      if (!activeListId) await makeActive(d.lead_list.id);
      setNewName('');
      await onChanged();
    });

  const importCsv = (file: File) =>
    run('csv', async () => {
      const listId = target.current;
      if (!listId) return;
      const data = await upload('/leads/import', { lead_list_id: listId }, file);
      const parts = [`Импортировано новых: ${Number(data.imported ?? 0)}`];
      if (Number(data.already_contacted_skipped) > 0) parts.push(`Уже контактировали (пропущено): ${data.already_contacted_skipped}`);
      if (Number(data.dup_in_file_skipped) > 0) parts.push(`Дублей в файле (пропущено): ${data.dup_in_file_skipped}`);
      if (Number(data.skipped) > 0) parts.push(`Без валидных данных: ${data.skipped}`);
      alert(parts.join('\n'));
      await onChanged();
      if (openId === listId) await loadLeads(listId);
    });

  // Импорт с персональными инвайтами всегда создаёт новую базу — в этой кампании.
  const importWithInvites = (file: File) =>
    run('invites', async () => {
      const data = await upload('/leads/import-with-invites', { campaign_id: campaignId }, file);
      const list = data.lead_list as { id: string; name: string } | null | undefined;
      const parts = [`Импортировано лидов: ${Number(data.imported ?? 0)}`];
      if (list?.name) parts.push(`Создана база: «${list.name}»`);
      if (Number(data.skipped) > 0) parts.push(`Пропущено (нет имени/инвайта): ${data.skipped}`);
      alert(parts.join('\n'));
      if (list?.id && !activeListId) await makeActive(list.id);
      await onChanged();
    });

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
      <input
        ref={csvInput}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importCsv(file);
        }}
      />
      <input
        ref={invitesInput}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importWithInvites(file);
        }}
      />

      <p className="text-[11px] text-gray-400">
        Кампания рассылает одну базу — отмеченную «рассылается». Людей из базы в рассылку добавляет запуск кампании:
        загрузили новых или сменили базу в идущей кампании — остановите и запустите её снова.
      </p>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void createBase(); }}
          placeholder="Название новой базы"
          className="min-w-[200px] flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm"
        />
        <button type="button" onClick={() => void createBase()} disabled={busy !== null || !newName.trim()} className="cursor-pointer rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
          + Создать базу
        </button>
        <button type="button" onClick={() => invitesInput.current?.click()} disabled={busy !== null} className={button} title="CSV с персональным текстом инвайта для каждого человека. Создаёт новую базу в этой кампании.">
          {busy === 'invites' ? 'Загружаю…' : 'Новая база из CSV с инвайтами'}
        </button>
      </div>

      {bases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-400">
          У кампании пока нет баз. Создайте базу и загрузите в неё CSV или соберите людей скрапером.
        </div>
      ) : (
        <div className="space-y-3">
          {bases.map((base) => {
            const active = base.id === activeListId;
            return (
              <div key={base.id} className={`rounded-xl border bg-white p-4 ${active ? 'border-green-300' : 'border-gray-200'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 truncate text-sm font-semibold text-gray-900">{base.name}</div>
                  {active && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">рассылается</span>}
                  {base.has_custom_invites && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">✎ персональные инвайты</span>}
                  <span className="ml-auto text-xs text-gray-500 tabular-nums">{base.leads_count ?? 0} чел.</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {!active && (
                    <button type="button" disabled={busy !== null} onClick={() => void run(`active:${base.id}`, async () => { await makeActive(base.id); await onChanged(); })} className={button} title="Кампания будет рассылать эту базу. Людей из неё в рассылку добавляет запуск кампании: если кампания уже идёт, остановите и запустите её снова.">
                      Рассылать эту базу
                    </button>
                  )}
                  <button type="button" disabled={busy !== null} onClick={() => { target.current = base.id; csvInput.current?.click(); }} className={button}>
                    {busy === 'csv' && target.current === base.id ? 'Загружаю…' : 'Загрузить CSV'}
                  </button>
                  <button type="button" onClick={() => onOpenScraper(base.id)} className={button} title="Открыть скрапер с выбранной базой">
                    Собрать скрапером
                  </button>
                  <button type="button" onClick={() => void toggleLeads(base.id)} className={button}>
                    {openId === base.id ? 'Скрыть людей' : 'Показать людей'}
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void exportCsv(base)} className={button}>Скачать CSV</button>
                  <button type="button" disabled={busy !== null} onClick={() => void remove(base)} className="ml-auto cursor-pointer text-xs text-red-600 hover:underline disabled:opacity-50">Удалить</button>
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
    </div>
  );
}

/**
 * Базы без кампании — наследство общих списков. Прятать их нельзя: это чьи-то
 * загруженные люди; показываем отдельно и просим перенести в кампанию.
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
    <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
      <div className="text-xs font-medium text-amber-900">Базы без кампании ({bases.length})</div>
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
    </div>
  );
}
