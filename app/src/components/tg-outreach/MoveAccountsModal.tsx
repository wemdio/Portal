'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';

/**
 * Перенос аккаунтов в другую кампанию.
 *
 * Аккаунты переезжают: партию закупили под один проект, а нужна она в другом,
 * или кампанию закрывают и живые номера забирают. Раньше их заводили в новой
 * кампании заново — вместе с потерей истории и возраста аккаунта.
 *
 * Два правила, которые окно объясняет на месте, а не отказом от сервера:
 * обе кампании должны быть остановлены, и причина обязательна.
 */

const API_BASE = '/api/tools/tg-outreach';

interface CampaignRow {
  id: string;
  name: string;
  status: string;
}

/** «error» — тоже остановленная кампания: круг в ней не идёт. */
function isStopped(status: string): boolean {
  return status === 'stopped' || status === 'error';
}

export function MoveAccountsModal({
  ids,
  fromCampaignId,
  onClose,
  onMoved,
}: {
  ids: string[];
  fromCampaignId: string;
  onClose: () => void;
  /** Аккаунты уехали — строки убираются из списка текущей кампании. */
  onMoved: (movedIds: string[], toCampaignName: string) => void;
}) {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/campaigns`);
      const data = (await res.json()) as { items?: CampaignRow[]; error?: string };
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      setCampaigns((data.items ?? []).filter((c) => c.id !== fromCampaignId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить список кампаний');
      setCampaigns([]);
    }
  }, [fromCampaignId]);

  useEffect(() => { void load(); }, [load]);

  const available = (campaigns ?? []).filter((c) => isStopped(c.status));
  const busyCampaigns = (campaigns ?? []).length - available.length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/accounts/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: ids, to_campaign_id: target, reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as
        { moved?: number; to_campaign_name?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Не удалось перенести (HTTP ${res.status})`);
        return;
      }
      onMoved(ids, data.to_campaign_name ?? available.find((c) => c.id === target)?.name ?? 'другую кампанию');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось перенести');
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(target) && Boolean(reason.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Перенести аккаунты"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Перенести в другую кампанию</h2>
            <p className="mt-0.5 text-xs text-gray-500">Аккаунтов: {ids.length}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600" htmlFor="move-target">
              Куда переносим
            </label>
            {campaigns === null ? (
              <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Загружаю кампании…
              </div>
            ) : (
              <select
                id="move-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={busy}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
              >
                <option value="">Выберите кампанию</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
            {/* Запущенные кампании в списке не показываем вовсе, но объясняем,
                почему нужной там может не оказаться: иначе оператор ищет
                кампанию, которая просто работает. */}
            {busyCampaigns > 0 ? (
              <p className="mt-1 text-[11px] text-gray-400">
                Не показаны кампании в работе ({busyCampaigns}): переносить можно только между
                остановленными — и эту, и ту.
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600" htmlFor="move-reason">
              Причина переноса <span className="text-rose-500">*</span>
            </label>
            <textarea
              id="move-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={500}
              placeholder="Например: проект ATOL закрыт, аккаунты уходят на Polza"
              className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Сохранится в истории аккаунта. Через месяц «почему этот аккаунт здесь» — единственный
              вопрос, который задают.
            </p>
          </div>

          <div className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
            Прокси не поедет вместе с аккаунтом: пул закреплён за кампанией. На новом месте назначьте
            прокси заново — аккаунты приедут выключенными, чтобы не уйти в бой без него.
          </div>

          {error ? <p className="text-xs text-rose-600">{error}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !ready}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Перенести
          </button>
        </div>
      </div>
    </div>
  );
}
