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

const inputCls = 'block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 disabled:opacity-50';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Ошибка ${res.status}`;
}

export default function CrmSettingsPanel({ campaignId, onChange }: {
  campaignId: string;
  /** null — настройки ещё не загружены, сохранять их нечего. */
  onChange: (settings: CrmSettings | null) => void;
}) {
  const [settings, setSettings] = useState<CrmSettings>(EMPTY);
  const [connections, setConnections] = useState<CrmConnection[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [loadingPipelines, setLoadingPipelines] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', base_url: '', token: '' });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/crm-connections`);
    if (!res.ok) return;
    const body = (await res.json()) as { connections: CrmConnection[] };
    setConnections(body.connections ?? []);
  }, []);

  // Настройки читаем с сервера, а не из пропсов: объект кампании у страницы
  // может быть снят до последнего сохранения этого блока.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [campRes] = await Promise.all([
        authFetch(`${API_BASE}/campaigns/${campaignId}`),
        loadConnections(),
      ]);
      if (cancelled) return;
      if (campRes.ok) {
        const camp = (await campRes.json()) as { crm_settings?: CrmSettings | null };
        if (camp.crm_settings) setSettings({ ...EMPTY, ...camp.crm_settings, connection: camp.crm_settings.connection ?? POLZA });
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [campaignId, loadConnections]);

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

  if (!loaded) {
    return <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> CRM…</div>;
  }

  const selected = connections.find((c) => c.id === settings.connection) ?? null;
  const clientConnections = connections.filter((c) => !c.builtin);

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-3">
      <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium text-gray-700">
        <span className="relative inline-flex shrink-0">
          <input type="checkbox" checked={settings.enabled}
            onChange={(e) => setSettings((prev) => ({ ...prev, enabled: e.target.checked, connection: prev.connection ?? POLZA }))}
            className="peer sr-only" />
          <span className="block h-5 w-9 rounded-full bg-gray-300 transition-colors duration-200 peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-300" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 peer-checked:translate-x-4" />
        </span>
        Передавать лидов в CRM
      </label>
      <p className="text-[10px] text-gray-400">Переданный лид станет сделкой: контакт @ник, тег оффера, переписка в примечании.</p>

      {settings.enabled && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-gray-500">Куда</span>
            <select value={settings.connection ?? POLZA}
              onChange={(e) => setSettings((prev) => ({ ...prev, connection: e.target.value, pipeline_id: null, status_id: null }))}
              className={inputCls}>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.status === 'error' ? ' — ошибка' : ''}</option>
              ))}
            </select>
          </label>
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
      {settings.enabled && (pipelinesError || selected?.last_error) && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10px] text-amber-700">
          {pipelinesError || selected?.last_error}
        </p>
      )}

      {/* amoCRM клиентов: подключают наши сотрудники, токен после сохранения не показывается. */}
      <div className="space-y-2 border-t border-gray-100 pt-3">
        {clientConnections.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-[11px] text-gray-600">
            <span className="font-medium text-gray-800">{c.name}</span>
            <span className="text-gray-400">{c.base_url.replace(/^https:\/\//, '')}</span>
            {c.status === 'error' && <span className="text-rose-600">ошибка</span>}
            <button type="button" onClick={() => void deleteConnection(c)} title="Удалить подключение"
              className="ml-auto cursor-pointer rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {adding ? (
          <div className="space-y-2 rounded-lg bg-gray-50 p-2.5">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <input placeholder="Название (клиент)" value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} />
              <input placeholder="client.amocrm.ru" value={form.base_url}
                onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))} className={inputCls} />
            </div>
            <textarea placeholder="Долгосрочный токен amoCRM" value={form.token} rows={3}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))} className={`${inputCls} font-mono`} />
            {formError && <p className="text-[10px] text-rose-600">{formError}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => void addConnection()} disabled={formBusy}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                {formBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Проверить и сохранить
              </button>
              <button type="button" onClick={() => { setAdding(false); setFormError(null); }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-[11px] text-gray-600 hover:bg-gray-100">
                <X className="h-3 w-3" /> Отмена
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)}
            className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-800">
            <Plus className="h-3 w-3" /> Подключить amoCRM клиента
          </button>
        )}
      </div>
    </section>
  );
}
