'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { call, errorText, upload } from './liApi';

/**
 * Окно «Создать базу» кампании LinkedIn: база собирается скрапером (параметры
 * и результат — здесь же) или грузится из CSV. Порядок баз в очереди кампании
 * определяется порядком сохранения.
 */

export interface NewBaseAccount {
  id: string;
  label: string;
}

interface ScrapedLead {
  id: string;
  name: string;
  position: string | null;
  company: string | null;
  profile_url: string | null;
}

type Method = 'scraper' | 'csv';
type ScrapeType = 'search' | 'reactions';
type Phase = 'form' | 'running' | 'done' | 'failed';

const POLL_MS = 3000;
const SHOWN = 100;

const field = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm';
const primary = 'cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50';
const secondary = 'cursor-pointer rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50';

export default function NewBaseModal({
  campaignId,
  activeListId,
  accounts,
  onClose,
  onSaved,
}: {
  campaignId: string;
  activeListId: string | null;
  accounts: NewBaseAccount[];
  onClose: () => void;
  /** База сохранена в кампании — перечитать список. */
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [method, setMethod] = useState<Method>('scraper');
  const [error, setError] = useState<string | null>(null);

  const [scrapeType, setScrapeType] = useState<ScrapeType>('search');
  const [url, setUrl] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [max, setMax] = useState(100);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [leads, setLeads] = useState<ScrapedLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const draft = useRef<{ listId: string | null; taskId: string | null }>({ listId: null, taskId: null });
  const timer = useRef<number | null>(null);

  const [csvKind, setCsvKind] = useState<'plain' | 'invites'>('plain');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const stopPolling = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  /** Черновая база скрапера: идущую задачу отменяем, базу удаляем. */
  const dropDraft = async () => {
    stopPolling();
    const { listId, taskId } = draft.current;
    draft.current = { listId: null, taskId: null };
    try {
      if (taskId) await call(`/scraper/tasks/${taskId}/cancel`, 'POST', {}).catch(() => undefined);
      if (listId) await call(`/lead-lists/${listId}`, 'DELETE');
    } catch {
      // Не удалилась — останется базой без кампании, её видно в общем списке.
    }
  };

  useEffect(() => () => stopPolling(), []);

  const close = async () => {
    if (draft.current.listId) await dropDraft();
    onClose();
  };

  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') void close(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poll = (taskId: string, listId: string) => {
    timer.current = window.setTimeout(async () => {
      try {
        const { task } = await call<{ task: { status: string; progress: number; total: number; error_message: string | null } }>(`/scraper/tasks/${taskId}`, 'GET');
        setProgress({ done: task.progress ?? 0, total: task.total ?? 0 });
        if (task.status === 'completed') {
          const d = await call<{ leads: ScrapedLead[]; total: number }>(`/scraper/tasks/${taskId}/leads`, 'GET');
          if (draft.current.listId !== listId) return;
          setLeads(d.leads);
          setLeadsTotal(d.total);
          setPhase('done');
          return;
        }
        if (task.status === 'failed' || task.status === 'cancelled') {
          setError(task.error_message || 'Сбор не удался');
          setPhase('failed');
          return;
        }
      } catch (e) {
        setError(errorText(e));
        setPhase('failed');
        return;
      }
      if (draft.current.listId === listId) poll(taskId, listId);
    }, POLL_MS);
  };

  const startScrape = async () => {
    const baseName = name.trim();
    if (!baseName) return setError('Введите название базы');
    if (!accountId) return setError('Выберите LinkedIn-аккаунт');
    if (!url.trim()) {
      return setError(scrapeType === 'search'
        ? 'Вставьте URL поиска LinkedIn People'
        : 'Вставьте URL поста LinkedIn — скрапер соберёт реакции');
    }
    setError(null);
    await dropDraft();
    setPhase('running');
    setProgress({ done: 0, total: 0 });
    setLeads([]);
    try {
      const { lead_list } = await call<{ lead_list: { id: string } }>('/lead-lists', 'POST', { name: baseName });
      draft.current.listId = lead_list.id;
      const accountName = accounts.find((a) => a.id === accountId)?.label ?? null;
      const common = { account_id: accountId, account_name: accountName, lead_list_id: lead_list.id, lead_list_name: baseName, max_results: max };
      const body = scrapeType === 'search' ? { search_url: url.trim(), ...common } : { post_url: url.trim(), ...common };
      const { task_id } = await call<{ task_id: string }>(scrapeType === 'search' ? '/scraper/search' : '/scraper/reactions', 'POST', body);
      draft.current.taskId = task_id;
      poll(task_id, lead_list.id);
    } catch (e) {
      setError(errorText(e));
      setPhase('failed');
    }
  };

  const makeActive = (listId: string) => call(`/campaigns/${campaignId}`, 'PUT', { lead_list_id: listId });

  const applyScraped = async () => {
    const listId = draft.current.listId;
    if (!listId) return;
    setSaving(true);
    try {
      await call(`/lead-lists/${listId}`, 'PUT', { campaign_id: campaignId });
      if (!activeListId) await makeActive(listId);
      draft.current = { listId: null, taskId: null };
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const saveCsv = async () => {
    const baseName = name.trim();
    if (!baseName) return setError('Введите название базы');
    if (!file) return setError('Выберите CSV-файл');
    setError(null);
    setSaving(true);
    let createdId: string | null = null;
    try {
      if (csvKind === 'invites') {
        const data = await upload('/leads/import-with-invites', { campaign_id: campaignId, list_name: baseName }, file);
        const list = data.lead_list as { id: string } | null | undefined;
        createdId = list?.id ?? null;
        const parts = [`Загружено контактов: ${Number(data.imported ?? 0)}`];
        if (Number(data.skipped) > 0) parts.push(`Пропущено (нет имени или инвайта): ${data.skipped}`);
        setSummary(parts.join('\n'));
      } else {
        const { lead_list } = await call<{ lead_list: { id: string } }>('/lead-lists', 'POST', { name: baseName, campaign_id: campaignId });
        createdId = lead_list.id;
        let data: Record<string, unknown>;
        try {
          data = await upload('/leads/import', { lead_list_id: lead_list.id }, file);
        } catch (e) {
          await call(`/lead-lists/${lead_list.id}`, 'DELETE').catch(() => undefined);
          createdId = null;
          throw e;
        }
        const parts = [`Загружено новых: ${Number(data.imported ?? 0)}`];
        if (Number(data.already_contacted_skipped) > 0) parts.push(`Уже контактировали (пропущено): ${data.already_contacted_skipped}`);
        if (Number(data.dup_in_file_skipped) > 0) parts.push(`Дублей в файле (пропущено): ${data.dup_in_file_skipped}`);
        if (Number(data.skipped) > 0) parts.push(`Без валидных данных: ${data.skipped}`);
        setSummary(parts.join('\n'));
      }
      if (createdId && !activeListId) await makeActive(createdId);
      await onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const busy = phase === 'running';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={() => { if (!busy && !saving) void close(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Создать базу"
        onMouseDown={(e) => e.stopPropagation()}
        className="li-hover-card flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl border shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <h3 className="text-base font-semibold">Создать базу</h3>
          <button type="button" onClick={() => void close()} aria-label="Закрыть" className="cursor-pointer rounded-lg p-1.5 text-zinc-500 hover:bg-black/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {summary ? (
            <div className="space-y-3">
              <p className="whitespace-pre-line text-sm">{summary}</p>
              <p className="text-xs text-zinc-500">База появилась на вкладке «Базы» и встала в конец очереди кампании.</p>
              <button type="button" onClick={onClose} className={primary}>Готово</button>
            </div>
          ) : (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy || phase === 'done'}
                placeholder="Название базы"
                className={field}
              />

              <div className="flex gap-2">
                {(['scraper', 'csv'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={busy || phase === 'done'}
                    onClick={() => { setMethod(m); setError(null); }}
                    className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed ${method === m ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
                  >
                    {m === 'scraper' ? 'Собрать скрапером' : 'Загрузить CSV'}
                  </button>
                ))}
              </div>

              {method === 'scraper' ? (
                phase === 'form' || phase === 'failed' ? (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setScrapeType('search')} className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs ${scrapeType === 'search' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>Поиск по URL</button>
                      <button type="button" onClick={() => setScrapeType('reactions')} className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs ${scrapeType === 'reactions' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>Реакции на пост</button>
                    </div>
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder={scrapeType === 'search' ? 'URL поиска LinkedIn People' : 'URL поста LinkedIn'}
                      className={field}
                    />
                    <div className="flex flex-wrap gap-3">
                      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="min-w-[200px] flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm">
                        <option value="">Аккаунт…</option>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                      <label className="flex items-center gap-2 text-xs text-zinc-500">
                        Сколько собрать
                        <input type="number" min={1} value={max} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} className="w-24 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                      </label>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-zinc-500">
                      {phase === 'running'
                        ? `Собираю… ${progress.total > 0 ? `${progress.done} из ${progress.total}` : 'запускаю задачу'}`
                        : leadsTotal > leads.length ? `Собрано ${leadsTotal}, показаны первые ${leads.length}` : `Собрано: ${leadsTotal}`}
                    </p>
                    {phase === 'running' ? (
                      <div className="flex justify-center py-6"><div className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600" /></div>
                    ) : leads.length === 0 ? (
                      <p className="py-4 text-center text-sm text-zinc-500">Скрапер никого не нашёл. Измените параметры и пересоберите.</p>
                    ) : (
                      <div className="max-h-72 overflow-y-auto">
                        <table className="w-full table-fixed text-sm">
                          <thead>
                            <tr className="border-b border-zinc-200 text-xs text-zinc-500">
                              <th className="px-2 py-1.5 text-left font-medium">Имя</th>
                              <th className="w-[32%] px-2 py-1.5 text-left font-medium">Должность</th>
                              <th className="w-[24%] px-2 py-1.5 text-left font-medium">Компания</th>
                            </tr>
                          </thead>
                          <tbody>
                            {leads.slice(0, SHOWN).map((lead) => (
                              <tr key={lead.id} className="border-b border-zinc-100">
                                <td className="truncate px-2 py-1.5 font-medium">
                                  {lead.profile_url ? <a href={lead.profile_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{lead.name}</a> : lead.name}
                                </td>
                                <td className="truncate px-2 py-1.5 text-zinc-600" title={lead.position ?? ''}>{lead.position ?? '—'}</td>
                                <td className="truncate px-2 py-1.5 text-zinc-600" title={lead.company ?? ''}>{lead.company ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setCsvKind('plain')} className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs ${csvKind === 'plain' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>Простой</button>
                    <button type="button" onClick={() => setCsvKind('invites')} className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs ${csvKind === 'invites' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>С персональными инвайтами</button>
                  </div>
                  <p className="text-xs text-zinc-500">
                    {csvKind === 'plain'
                      ? 'Колонки: name (или first_name и last_name) и profile_url — ссылка на профиль LinkedIn. По желанию: position, company.'
                      : 'Колонки: «LinkedIn ID» — имя лида и «Invite» — текст инвайта для него. По желанию: position, company, profile_url.'}
                  </p>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm"
                  />
                </div>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}
            </>
          )}
        </div>

        {!summary && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3">
            {method === 'scraper' ? (
              phase === 'form' || phase === 'failed' ? (
                <button type="button" onClick={() => void startScrape()} className={primary}>Собрать</button>
              ) : phase === 'done' ? (
                <>
                  <button type="button" onClick={() => void startScrape()} disabled={saving} className={secondary}>Пересобрать</button>
                  <button type="button" onClick={() => void applyScraped()} disabled={saving || leads.length === 0} className={primary}>
                    {saving ? 'Сохраняю…' : 'Использовать эту'}
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => void close()} className={secondary}>Отменить сбор</button>
              )
            ) : (
              <button type="button" onClick={() => void saveCsv()} disabled={saving} className={primary}>
                {saving ? 'Загружаю…' : 'Сохранить'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
