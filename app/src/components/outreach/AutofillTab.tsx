'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Loader2, Settings2 } from 'lucide-react';
import { authFetchJson } from '@/lib/authFetch';

/**
 * Вкладка «Автодобор» автоаутрича RU/EN: выключатель, состояние базы папки и
 * настройки сбора (docs/superpowers/specs/2026-10-06-outreach-autofill-design.md, §4).
 * Сама проверка и сбор — в воркере автоаутрича (lib/outreachAutofill/check.ts).
 */

interface AutofillState {
  perDay: number;
  remaining: number;
  daysLeft: number | null;
  baseUntil: string | null;
}

/** Ответ /api/tools/outreach-autofill/[lang]. */
interface AutofillResponse<Config> {
  enabled: boolean;
  config: Config;
  ownerId: string | null;
  apiKeyReady: boolean;
  state: AutofillState | null;
  lastJob: { id: string; status: string; createdAt: string; handled: boolean; target: number | null } | null;
  lastCheckAt: string | null;
}

export interface AutofillSettingsPanelProps<Config> {
  busy: boolean;
  initial: Config;
  onClose: () => void;
  onSave: (config: Config) => void;
}

/** Совпадает с AUTOFILL_TARGET_DAYS в lib/outreachAutofill/plan.ts. */
const TARGET_DAYS = 5;

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const [, month, day] = iso.slice(0, 10).split('-');
  return `${day}.${month}`;
}

function jobStatusText(job: NonNullable<AutofillResponse<unknown>['lastJob']>): string {
  if (job.status === 'pending' || job.status === 'running') return 'идёт сбор';
  if (!job.handled) return 'собран, заливается в «Рассылку»';
  return job.status === 'failed' ? 'упал' : 'залит';
}

export function AutofillTab<Config>({
  lang,
  renderSettings,
}: {
  lang: 'ru' | 'en';
  renderSettings: (props: AutofillSettingsPanelProps<Config>) => ReactNode;
}) {
  const url = `/api/tools/outreach-autofill/${lang}`;
  const [data, setData] = useState<AutofillResponse<Config> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await authFetchJson<AutofillResponse<Config>>(url));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить автодобор');
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { enabled?: boolean; config?: Config }) => {
    setBusy(true);
    try {
      setData(await authFetchJson<AutofillResponse<Config>>(url, { method: 'PUT', body: JSON.stringify(patch) }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return error ? (
      <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
    ) : (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Загружаем…
      </div>
    );
  }

  const state = data.state;
  const weekTarget = state ? state.perDay * TARGET_DAYS : 0;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Автодобор базы</h2>
            <p className="mt-1 text-sm text-gray-500">
              В 09:00 и 21:00 МСК: базы меньше чем на 3 рабочих дня — собираем неделю и запускаем рассылку.
            </p>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 accent-violet-600"
              checked={data.enabled}
              disabled={busy}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />
            {data.enabled ? 'Включён' : 'Выключен'}
          </label>
        </div>

        {state ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <div className="text-xs text-gray-500">Новых компаний в день</div>
              <div className="text-lg font-semibold tabular-nums text-gray-900">{state.perDay}</div>
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <div className="text-xs text-gray-500">В базе без первого письма</div>
              <div className="text-lg font-semibold tabular-nums text-gray-900">{state.remaining}</div>
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <div className="text-xs text-gray-500">Хватит до</div>
              <div className="text-lg font-semibold tabular-nums text-gray-900">
                {state.perDay === 0 ? 'нет ящиков' : state.baseUntil ? shortDate(state.baseUntil) : 'база пуста'}
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-amber-700">Папка «Рассылки» не найдена.</p>
        )}

        {state && state.perDay > 0 ? (
          <p className="mt-3 text-xs text-gray-500">Один добор — {weekTarget} компаний, не чаще раза в день.</p>
        ) : null}
        {!data.apiKeyReady ? (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">На сервере не задан ключ ИИ — сбор не запустится.</p>
        ) : null}
        {data.lastJob ? (
          <p className="mt-3 text-xs text-gray-500">
            Последний автосбор {shortDate(data.lastJob.createdAt)}
            {data.lastJob.target ? ` на ${data.lastJob.target}` : ''}: {jobStatusText(data.lastJob)}.
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Settings2 className="mr-2 h-4 w-4" />
            Настройки сбора
          </button>
        </div>
      </div>

      {settingsOpen
        ? renderSettings({
            busy,
            initial: data.config,
            onClose: () => setSettingsOpen(false),
            onSave: (config) => void save({ config }),
          })
        : null}
    </div>
  );
}
