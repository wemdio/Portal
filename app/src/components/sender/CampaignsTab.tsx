'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pause, Play, Plus } from 'lucide-react';
import { fetchCampaigns, patchCampaign, type CampaignDto } from './api';
import { CampaignFormModal } from './CampaignFormModal';
import { weekdaysLabel } from './CampaignSteps';

const STATUS_LABELS: Record<CampaignDto['status'], { text: string; className: string }> = {
  draft: { text: 'Черновик', className: 'bg-zinc-100 text-zinc-600' },
  running: { text: 'Идёт', className: 'bg-emerald-100 text-emerald-700' },
  paused: { text: 'Пауза', className: 'bg-amber-100 text-amber-700' },
  done: { text: 'Завершена', className: 'bg-zinc-100 text-zinc-600' },
};

/**
 * Вкладка «Кампании»: на экране список, создание — в отдельном окне.
 *
 * Форма создания занимала верх страницы всегда, хотя нужна раз в неделю: список
 * кампаний — то, ради чего сюда заходят каждый день, — оказывался под ней и
 * начинался ниже сгиба.
 */
export function CampaignsTab() {
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  // Какую кампанию открыли по названию. null — окно создания новой.
  const [editing, setEditing] = useState<CampaignDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchCampaigns();
      setCampaigns(res.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить кампании');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Кампании</h2>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" />
            Кампания
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : campaigns.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <p className="text-sm text-zinc-500">Кампаний пока нет.</p>
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="mt-3 text-sm text-blue-600 transition-colors hover:text-blue-500"
            >
              Создать первую
            </button>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {campaigns.map((campaign) => {
              const status = STATUS_LABELS[campaign.status];
              const stats = campaign.stats;
              return (
                <div key={campaign.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="min-w-48 flex-1">
                    <div className="flex items-center gap-2">
                      {/* Название — вход в настройки: отдельная кнопка
                          «Изменить» в строке была бы четвёртой подряд, а по
                          названию кликают и так, ожидая карточку. */}
                      <button
                        type="button"
                        onClick={() => setEditing(campaign)}
                        className="rounded font-medium text-zinc-900 underline-offset-4 transition-colors hover:text-blue-600 hover:underline"
                      >
                        {campaign.name}
                      </button>
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>
                        {status.text}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {stats
                        ? `${stats.recipients} получателей · отправлено ${stats.sent} · в очереди ${stats.scheduled} · ответили ${stats.replied}${
                            stats.failed ? ` · ошибок ${stats.failed}` : ''
                          }`
                        : '—'}
                      {' · '}
                      {campaign.send_hour_from}:00–{campaign.send_hour_to}:00
                      {' · '}
                      {weekdaysLabel(campaign.send_weekdays ?? [])}
                    </div>
                  </div>

                  {campaign.status === 'running' ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await patchCampaign(campaign.id, 'pause');
                        await load();
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Пауза
                    </button>
                  ) : campaign.status !== 'done' ? (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await patchCampaign(campaign.id, 'start');
                          await load();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Не удалось запустить');
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Запустить
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {formOpen || editing ? (
        <CampaignFormModal
          key={editing?.id ?? 'new'}
          campaign={editing ?? undefined}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onCreated={async ({ notice: savedNotice, error: savedError }) => {
            setNotice(savedNotice ?? null);
            setError(savedError ?? null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}
