'use client';

/**
 * Блок «Передавать в CRM» в настройках кампании TG-аутрича.
 *
 * Переданный лид (кнопкой или автоматически по интересу) заводится сделкой в
 * выбранной amoCRM: нашей или клиента. Здесь же сотрудник подключает amoCRM
 * клиента — адрес и долгосрочный токен, проверка живым запросом.
 *
 * Своей кнопки сохранения нет: текущий выбор блок отдаёт наверх через
 * onChange, и его сохраняет общая кнопка «Сохранить настройки» вкладки.
 * Спека: docs/superpowers/specs/2026-10-06-tg-outreach-crm-handoff-design.md
 */

import React, { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { Loader2, Plus, Save, Trash2, X } from 'lucide-react';

const API_BASE = '/api/tools/tg-outreach';
const POLZA = 'polza';
/** «Первичные продажи» нашей AMO — воронка по умолчанию. */
const POLZA_DEFAULT_PIPELINE_ID = 7670334;

interface CrmConnection {
  id: string;
  name: string;
  base_url: string;
  status: 'ok' | 'error';
  last_error: string | null;
  builtin: boolean;
}

interface Pipeline {
  id: number;
  name: string;
  isMain: boolean;
  statuses: Array<{ id: number; name: string }>;
}

export interface CrmSettings {
  enabled: boolean;
  connection: string | null;
  pipeline_id: number | null;
  status_id: number | null;
}

const EMPTY: CrmSettings = { enabled: false, connection: POLZA, pipeline_id: null, status_id: null };

const inputCls = 'block w-full rounded-lg border border-gray-300/70 bg-white/50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 disabled:opacity-50';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Ошибка ${res.status}`;
}

export default function CrmSettingsPanel({ initial, onChange }: {
  /** Сохранённые настройки кампании: берём из объекта кампании, отдельного запроса нет. */
  initial?: Partial<CrmSettings> | null;
  onChange: (settings: CrmSettings | null) => void;
}) {
  const [settings, setSettings] = useState<CrmSettings>(
    initial ? { ...EMPTY, ...initial, connection: initial.connection ?? POLZA } : EMPTY,
  );
  const [connections, setConnections] = useState<CrmConnection[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [loadingPipelines, setLoadingPipelines] = useState(false);
  const loaded = true;

  const [adding, setAdding] = useState(false);
  // Выбран режим «amoCRM клиента» — даже когда подключения ещё нет и connection null.
  const [clientsMode, setClientsMode] = useState(false);
  const [form, setForm] = useState({ name: '', base_url: '', token: '' });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/crm-connections`);
    if (!res.ok) return;
    const body = (await res.json()) as { connections: CrmConnection[] };
    setConnections(body.connections ?? []);
  }, []);

  // Подключения клиентов подгружаем, только когда передача включена: пока она
  // выключена, блок — один переключатель и ничего не запрашивает.
  useEffect(() => {
    if (settings.enabled) void loadConnections();
  }, [settings.enabled, loadConnections]);

  // Воронки выбранного подключения. Пустой выбор воронки — подставляем
  // разумный по умолчанию: у нашей AMO «Первичные продажи», у клиента главную.
  useEffect(() => {
    const conn = settings.connection;
    if (!loaded || !settings.enabled || !conn) return;
    let cancelled = false;
    void (async () => {
      setLoadingPipelines(true);
      setPipelinesError(null);
      const res = await authFetch(`${API_BASE}/crm-connections/${conn}/pipelines`);
      if (cancelled) return;
      if (!res.ok) {
        setPipelines([]);
        setPipelinesError(await readError(res));
      } else {
        const body = (await res.json()) as { pipelines: Pipeline[] };
        const list = body.pipelines ?? [];
        setPipelines(list);
        setSettings((prev) => {
          if (prev.pipeline_id && list.some((p) => p.id === prev.pipeline_id)) return prev;
          const pick = (conn === POLZA && list.find((p) => p.id === POLZA_DEFAULT_PIPELINE_ID))
            || list.find((p) => p.isMain) || list[0];
          return pick ? { ...prev, pipeline_id: pick.id, status_id: pick.statuses[0]?.id ?? null } : prev;
        });
      }
      setLoadingPipelines(false);
    })();
    return () => { cancelled = true; };
  }, [loaded, settings.enabled, settings.connection]);

  useEffect(() => { onChange(loaded ? settings : null); }, [loaded, settings, onChange]);

  const pipeline = pipelines.find((p) => p.id === settings.pipeline_id) ?? null;

  const addConnection = async () => {
    setFormBusy(true);
    setFormError(null);
    try {
      const res = await authFetch(`${API_BASE}/crm-connections`, { method: 'POST', body: JSON.stringify(form) });
      if (!res.ok) { setFormError(await readError(res)); return; }
      const body = (await res.json()) as { connection: CrmConnection };
      await loadConnections();
      setSettings((prev) => ({ ...prev, connection: body.connection.id, pipeline_id: null, status_id: null }));
      setForm({ name: '', base_url: '', token: '' });
      setAdding(false);
    } finally {
      setFormBusy(false);
    }
  };

  const deleteConnection = async (conn: CrmConnection) => {
    if (!confirm(`Удалить подключение «${conn.name}»?`)) return;
    let res = await authFetch(`${API_BASE}/crm-connections/${conn.id}`, { method: 'DELETE' });
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { used_by?: string[] } | null;
      const names = (body?.used_by ?? []).join(', ');
      if (!confirm(`Подключение используется в кампаниях: ${names}.\nУдалить и выключить у них передачу в CRM?`)) return;
      res = await authFetch(`${API_BASE}/crm-connections/${conn.id}?confirm=1`, { method: 'DELETE' });
    }
    if (!res.ok) { alert(await readError(res)); return; }
    await loadConnections();
    if (settings.connection === conn.id) setSettings({ ...EMPTY });
  };

  const selected = connections.find((c) => c.id === settings.connection) ?? null;
  const clientConnections = connections.filter((c) => !c.builtin);
  // Куда уходят сделки: в нашу amoCRM или в amoCRM клиента. «Клиента» без
  // единого подключения — это connection null, пока его не подключат.
  const target: 'own' | 'client' = clientsMode || (settings.connection !== null && settings.connection !== POLZA) ? 'client' : 'own';

  const pickTarget = (next: 'own' | 'client') => {
    if (next === 'own') {
      setClientsMode(false);
      setAdding(false);
      setSettings((prev) => ({ ...prev, connection: POLZA, pipeline_id: null, status_id: null }));
    } else {
      setClientsMode(true);
      const first = clientConnections[0]?.id ?? null;
      if (!first) setAdding(true);
      setSettings((prev) => ({ ...prev, connection: first, pipeline_id: null, status_id: null }));
    }
  };

  const segCls = (on: boolean) =>
    `rounded-md px-3.5 py-1.5 text-xs font-medium transition cursor-pointer ${on ? 'bg-[#6366f1] text-[#ffffff] shadow-sm' : 'text-gray-500 hover:text-gray-800'}`;

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-start gap-3">
        <span className="relative mt-0.5 inline-flex shrink-0">
          <input type="checkbox" checked={settings.enabled}
            onChange={(e) => setSettings((prev) => ({ ...prev, enabled: e.target.checked, connection: prev.connection ?? POLZA }))}
            className="peer sr-only" />
          <span className="block h-5 w-9 rounded-full bg-[#6b7280] transition-colors duration-200 peer-checked:bg-[#6366f1] peer-focus-visible:ring-2 peer-focus-visible:ring-[#a5b4fc]" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 block h-4 w-4 rounded-full bg-[#ffffff] shadow-md transition-transform duration-200 peer-checked:translate-x-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm text-gray-800">Передавать лидов в CRM</span>
          <span className="mt-0.5 block text-xs text-gray-500">Лид станет сделкой: контакт @ник, тег оффера, переписка в примечании.</span>
        </span>
      </label>

      {settings.enabled && (
        <div className="space-y-4">
          <div className="inline-flex items-center gap-1 rounded-lg border border-gray-300/70 bg-white/50 p-1">
            <button type="button" onClick={() => pickTarget('own')} className={segCls(target === 'own')}>Наша amoCRM</button>
            <button type="button" onClick={() => pickTarget('client')} className={segCls(target === 'client')}>amoCRM клиента</button>
          </div>

          {/* amoCRM клиентов: подключают наши сотрудники, токен после сохранения не показывается. */}
          {target === 'client' && (
            <div className="space-y-2">
              {clientConnections.length > 0 && (
                <label className="block max-w-sm space-y-1">
                  <span className="block text-[11px] font-medium text-gray-500">Клиент</span>
                  <div className="flex items-center gap-2">
                    <select value={settings.connection ?? ''}
                      onChange={(e) => setSettings((prev) => ({ ...prev, connection: e.target.value || null, pipeline_id: null, status_id: null }))}
                      className={inputCls}>
                      {clientConnections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.status === 'error' ? ' — ошибка' : ''}</option>
                      ))}
                    </select>
                    {selected && !selected.builtin && (
                      <button type="button" onClick={() => void deleteConnection(selected)} title="Удалить подключение"
                        className="shrink-0 cursor-pointer rounded p-1.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {selected && !selected.builtin && (
                    <span className="block text-[11px] text-gray-400">{selected.base_url.replace(/^https:\/\//, '')}</span>
                  )}
                </label>
              )}

              {adding ? (
                <div className="space-y-2 rounded-lg border border-gray-300/70 bg-white/50 p-3">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <input placeholder="Название клиента" value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} />
                    <input placeholder="client.amocrm.ru" value={form.base_url}
                      onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))} className={inputCls} />
                  </div>
                  <textarea placeholder="Долгосрочный токен amoCRM" value={form.token} rows={3}
                    onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))} className={`${inputCls} font-mono`} />
                  {formError && <p className="text-[11px] text-rose-600">{formError}</p>}
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void addConnection()} disabled={formBusy}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                      {formBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      Проверить и сохранить
                    </button>
                    {clientConnections.length > 0 && (
                      <button type="button" onClick={() => { setAdding(false); setFormError(null); }}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300/70 px-3 py-1.5 text-[11px] text-gray-600 hover:bg-gray-100">
                        <X className="h-3 w-3" /> Отмена
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setAdding(true)}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-indigo-500 hover:text-indigo-400">
                  <Plus className="h-3 w-3" /> Подключить amoCRM клиента
                </button>
              )}
            </div>
          )}

          {settings.connection && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="block text-[11px] font-medium text-gray-500">Воронка</span>
                <select value={settings.pipeline_id ?? ''} disabled={loadingPipelines || !pipelines.length}
                  onChange={(e) => {
                    const p = pipelines.find((x) => x.id === Number(e.target.value));
                    setSettings((prev) => ({ ...prev, pipeline_id: p?.id ?? null, status_id: p?.statuses[0]?.id ?? null }));
                  }}
                  className={inputCls}>
                  {!pipelines.length && <option value="">{loadingPipelines ? 'Загружаю…' : '—'}</option>}
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="block text-[11px] font-medium text-gray-500">Этап</span>
                <select value={settings.status_id ?? ''} disabled={!pipeline}
                  onChange={(e) => setSettings((prev) => ({ ...prev, status_id: Number(e.target.value) || null }))}
                  className={inputCls}>
                  {!pipeline && <option value="">—</option>}
                  {pipeline?.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </div>
          )}

          {(pipelinesError || selected?.last_error) && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
              {pipelinesError || selected?.last_error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
