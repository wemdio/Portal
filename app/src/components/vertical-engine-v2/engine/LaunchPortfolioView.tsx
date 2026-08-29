'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  VeRuSeasonality,
  VeRuSeasonalityPrioritySnapshot,
  VeRuSeasonalityState,
} from '@/lib/verticalEngineV2/types';
import { VE_API, veEngineCall, veEnginePatch, veEnginePost } from './api';
import { HE, Spinner } from './design';

type PortfolioLifecycle =
  | 'prepared'
  | 'queued'
  | 'activating'
  | 'active'
  | 'uncertain'
  | 'released'
  | 'skipped'
  | 'cancelled';

interface PortfolioCampaignDto {
  campaign_id: string;
  campaign_name?: string | null;
  campaign_url?: string | null;
  segment: string | null;
  leads_count?: number | null;
  status: string | number | null;
  status_observed_at: string | null;
}

interface PrioritySnapshotDto extends VeRuSeasonalityPrioritySnapshot {
  reasons?: string[];
  blockers?: string[];
}

export interface LaunchPortfolioItemDto {
  id: string;
  project_id: string;
  template_id?: string;
  project_name?: string;
  status: PortfolioLifecycle;
  priority_override_decision?: 'activate_next' | 'wait' | null;
  priority_override_reason?: string | null;
  activation_admissible: boolean;
  is_activation_head: boolean;
  activation_head_id: string | null;
  rank: number | null;
  priority_snapshot: PrioritySnapshotDto;
  seasonality: VeRuSeasonality | null;
  campaigns: PortfolioCampaignDto[];
  capacity?: {
    max_active_bundles: number;
    occupied_bundles: number;
    slot_available: boolean;
  };
}

export interface LaunchPortfolioResponse {
  as_of: string;
  plan_version: number;
  mode: 'advisory' | 'enforced';
  capacity: {
    max_active_bundles: number;
    active_bundles: number;
    next_estimated_release_at: string | null;
  };
  items: LaunchPortfolioItemDto[];
  error?: string;
}

interface PortfolioActionResponse {
  item?: LaunchPortfolioItemDto;
  error?: string;
}

type QueueGroup = 'active' | 'attention' | 'terminal' | VeRuSeasonalityState;

const SEASONAL_STATES = new Set<VeRuSeasonalityState>([
  'launch_now',
  'prepare_now',
  'neutral',
  'unknown',
  'wait',
  'avoid',
]);

const GROUPS: ReadonlyArray<{
  key: QueueGroup;
  title: string;
}> = [
  { key: 'active', title: 'Активная отправка' },
  { key: 'attention', title: 'Требует сверки' },
  { key: 'launch_now', title: 'Запускать сейчас' },
  { key: 'prepare_now', title: 'Подготовить заранее' },
  { key: 'neutral', title: 'Круглый год' },
  { key: 'wait', title: 'Ждать окна' },
  { key: 'avoid', title: 'Избегать запуска' },
  { key: 'unknown', title: 'Нужно решение' },
  { key: 'terminal', title: 'Завершённые' },
];

const STATE_LABEL: Record<VeRuSeasonalityState, string> = {
  launch_now: 'Запускать сейчас',
  prepare_now: 'Готовить сейчас',
  neutral: 'Круглый год',
  wait: 'Ждать',
  avoid: 'Избегать',
  unknown: 'Нужно решение',
};

const STATE_DOT: Record<VeRuSeasonalityState, string> = {
  launch_now: 've2-d-g',
  prepare_now: 've2-d-n',
  neutral: 've2-d-n',
  wait: 've2-d-w',
  avoid: 've2-d-r',
  unknown: 've2-d-q',
};

function seasonalStateOf(item: LaunchPortfolioItemDto): VeRuSeasonalityState {
  if (item.priority_override_decision === 'activate_next') return 'launch_now';
  if (item.priority_override_decision === 'wait') return 'wait';
  const state = (item.priority_snapshot as { state?: unknown } | null)?.state;
  return typeof state === 'string' && SEASONAL_STATES.has(state as VeRuSeasonalityState)
    ? (state as VeRuSeasonalityState)
    : 'unknown';
}

function itemGroup(item: LaunchPortfolioItemDto): QueueGroup {
  if (item.status === 'active') return 'active';
  if (item.status === 'activating' || item.status === 'uncertain') return 'attention';
  if (item.status === 'released' || item.status === 'skipped' || item.status === 'cancelled') {
    return 'terminal';
  }
  return seasonalStateOf(item);
}

function StatusLabel({ item }: { item: LaunchPortfolioItemDto }) {
  const state = seasonalStateOf(item);
  const lifecycle = item.status === 'active'
    ? { label: 'Активная отправка', dotClass: 've2-d-g' }
    : item.status === 'activating'
      ? { label: 'Активация выполняется', dotClass: 've2-d-w' }
        : item.status === 'uncertain'
          ? { label: 'Статус не подтверждён', dotClass: 've2-d-w' }
          : item.status === 'released'
          ? { label: 'Слот освобождён', dotClass: 've2-d-q' }
          : item.status === 'skipped'
            ? { label: 'Запуск пропущен', dotClass: 've2-d-q' }
            : item.status === 'cancelled'
              ? { label: 'Запуск отменён', dotClass: 've2-d-q' }
              : { label: STATE_LABEL[state], dotClass: STATE_DOT[state] };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${lifecycle.dotClass}`} />
      {lifecycle.label}
    </span>
  );
}

function projectName(item: LaunchPortfolioItemDto): string {
  return item.project_name?.trim() || `Проект ${item.project_id.slice(0, 8)}`;
}

function campaignName(campaign: PortfolioCampaignDto): string {
  return campaign.campaign_name?.trim()
    || campaign.segment?.trim()
    || `Кампания ${campaign.campaign_id.slice(0, 8)}`;
}

function safeCampaignUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function LaunchPortfolioView({
  onProjectOpen,
}: {
  onProjectOpen: (projectId: string) => void;
}): JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [portfolio, setPortfolio] = useState<LaunchPortfolioResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [reviewedItemIds, setReviewedItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const mountedRef = useRef(true);
  const [releaseEditor, setReleaseEditor] = useState<{
    itemId: string;
    reason: string;
  } | null>(null);
  const [overrideEditor, setOverrideEditor] = useState<{
    itemId: string;
    decision: '' | 'activate_next' | 'wait';
    reason: string;
  } | null>(null);

  const loadPortfolio = useCallback(async () => {
    try {
      const { ok, data } = await veEngineCall<LaunchPortfolioResponse>(
        `${VE_API}/launch-portfolio?market=ru`,
      );
      if (!mountedRef.current) return;
      if (!ok || !Array.isArray(data.items)) {
        setError(data.error || 'Не удалось загрузить очередь запусков');
        setState('error');
        return;
      }
      setPortfolio(data);
      setError('');
      setState('ready');
    } catch {
      if (!mountedRef.current) return;
      setError('Не удалось загрузить очередь запусков');
      setState('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Start after the effect body so React state is only updated from the
    // asynchronous request lifecycle, never synchronously during the effect.
    void Promise.resolve().then(loadPortfolio);
    return () => {
      mountedRef.current = false;
    };
  }, [loadPortfolio]);

  const grouped = useMemo(() => {
    const map = new Map<QueueGroup, LaunchPortfolioItemDto[]>();
    for (const group of GROUPS) map.set(group.key, []);
    for (const item of portfolio?.items ?? []) {
      map.get(itemGroup(item))?.push(item);
    }
    return map;
  }, [portfolio]);

  const updateItem = (next: LaunchPortfolioItemDto | undefined) => {
    if (!next) return;
    setPortfolio((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }
        : current,
    );
  };

  const submitRelease = async () => {
    if (!releaseEditor || !releaseEditor.reason.trim() || busyItemId) return;
    setBusyItemId(releaseEditor.itemId);
    setActionError('');
    try {
      const { ok, data } = await veEnginePatch<PortfolioActionResponse>(
        `${VE_API}/launch-portfolio/items/${releaseEditor.itemId}`,
        { action: 'release', reason: releaseEditor.reason.trim() },
      );
      if (!ok) {
        setActionError(data.error || 'Не удалось освободить слот');
        return;
      }
      updateItem(data.item);
      setReleaseEditor(null);
      await loadPortfolio();
    } catch {
      setActionError('Не удалось освободить слот');
    } finally {
      setBusyItemId(null);
    }
  };

  const submitOverride = async () => {
    if (
      !overrideEditor ||
      !overrideEditor.decision ||
      !overrideEditor.reason.trim() ||
      busyItemId
    ) {
      return;
    }
    setBusyItemId(overrideEditor.itemId);
    setActionError('');
    try {
      const { ok, data } = await veEnginePatch<PortfolioActionResponse>(
        `${VE_API}/launch-portfolio/items/${overrideEditor.itemId}`,
        {
          action: 'override_seasonality',
          decision: overrideEditor.decision,
          reason: overrideEditor.reason.trim(),
        },
      );
      if (!ok) {
        setActionError(data.error || 'Не удалось сохранить ручное решение');
        return;
      }
      updateItem(data.item);
      setOverrideEditor(null);
      await loadPortfolio();
    } catch {
      setActionError('Не удалось сохранить ручное решение');
    } finally {
      setBusyItemId(null);
    }
  };

  const activateItem = async (item: LaunchPortfolioItemDto) => {
    if (!portfolio || !reviewedItemIds.has(item.id) || busyItemId) return;
    setBusyItemId(item.id);
    setActionError('');
    try {
      const { ok, data } = await veEnginePost<{ error?: string }>(
        `${VE_API}/launch-portfolio/${item.id}/activate`,
        {
          confirm_campaign_review: true,
          idempotency_key: crypto.randomUUID(),
          plan_version: portfolio.plan_version,
        },
      );
      if (!ok) {
        setActionError(data.error || 'Не удалось активировать отправку');
        return;
      }
      setReviewedItemIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      await loadPortfolio();
    } catch {
      setActionError('Не удалось активировать отправку');
    } finally {
      setBusyItemId(null);
    }
  };

  if (state === 'loading') {
    return (
      <div className={`${HE.emptyState} flex min-h-48 items-center justify-center gap-2`} role="status">
        <Spinner />
        <span className="text-sm text-gray-600">Загружаем очередь запусков…</span>
      </div>
    );
  }

  if (state === 'error' || !portfolio) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
        {error}
      </div>
    );
  }

  const { capacity } = portfolio;
  const slotOccupied = capacity.active_bundles >= capacity.max_active_bundles;

  return (
    <div className="space-y-5">
      <section
        aria-live="polite"
        className="rounded-lg border border-gray-200 bg-gray-50/70 px-4 py-3"
      >
        <p className="text-sm font-semibold text-gray-900">
          Активные группы отправки · {capacity.active_bundles}
        </p>
        <p className={`mt-1 ${HE.muted}`}>
          Лимит {capacity.max_active_bundles} считается отдельно для пересекающихся mailbox-пулов
          {' '}в одном Instantly workspace. Разные пулы могут отправлять параллельно;
          {' '}PAUSED-кампании можно готовить заранее.
        </p>
      </section>

      {actionError ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {actionError}
        </p>
      ) : null}

      {GROUPS.map((group) => {
        const items = grouped.get(group.key) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={group.key} aria-labelledby={`ve-launch-group-${group.key}`}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 id={`ve-launch-group-${group.key}`} className={HE.sectionTitle}>
                {group.title}
              </h2>
              <span className={HE.faint}>{items.length}</span>
            </div>
            <ul className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              {items.map((item) => {
                const releaseOpen = releaseEditor?.itemId === item.id;
                const overrideOpen = overrideEditor?.itemId === item.id;
                const slotHolding =
                  item.status === 'activating' || item.status === 'active' || item.status === 'uncertain';
                const terminal =
                  item.status === 'released' || item.status === 'skipped' || item.status === 'cancelled';
                const seasonalState = seasonalStateOf(item);
                const timingEligible =
                  seasonalState === 'launch_now' || seasonalState === 'neutral';
                const reviewed = reviewedItemIds.has(item.id);
                const itemSlotOccupied = item.capacity
                  ? !item.capacity.slot_available
                  : slotOccupied;
                return (
                  <li key={item.id} className="border-b border-gray-200 p-4 last:border-b-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => onProjectOpen(item.project_id)}
                          className="text-left text-sm font-semibold underline-offset-2 hover:underline"
                        >
                          {projectName(item)}
                        </button>
                        <div className="mt-1.5">
                          <StatusLabel item={item} />
                        </div>
                        {item.seasonality?.rationale ? (
                          <p className={`mt-2 max-w-3xl text-xs leading-5 ${HE.muted}`}>
                            {item.seasonality.rationale}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {slotHolding ? (
                          <>
                            {item.status !== 'activating' ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setReleaseEditor({ itemId: item.id, reason: '' })
                                }
                                className={HE.btnSmall}
                              >
                                Освободить слот вручную
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        {!terminal && (
                          seasonalState === 'avoid' ||
                          seasonalState === 'wait' ||
                          seasonalState === 'unknown'
                        ) ? (
                          <button
                            type="button"
                            onClick={() =>
                              setOverrideEditor({ itemId: item.id, decision: '', reason: '' })
                            }
                            className={HE.btnSmall}
                          >
                            Изменить сезонное решение
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {!slotHolding && !terminal && item.status === 'queued' && item.is_activation_head ? (
                      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                        {item.campaigns.length > 0 ? (
                          <div className="mb-3">
                            <p className="text-xs font-semibold text-gray-800">Кампании к запуску</p>
                            <ul className="mt-1.5 space-y-1.5">
                              {item.campaigns.map((campaign) => {
                                const href = safeCampaignUrl(campaign.campaign_url);
                                const name = campaignName(campaign);
                                return (
                                  <li
                                    key={campaign.campaign_id}
                                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs"
                                  >
                                    <span className="min-w-0">
                                      {href ? (
                                        <a
                                          href={href}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="ve2-link font-medium underline-offset-2 hover:underline"
                                        >
                                          {name}
                                        </a>
                                      ) : (
                                        <span className="font-medium text-gray-800">{name}</span>
                                      )}
                                      {campaign.segment?.trim() ? (
                                        <span className="ml-2 text-gray-500">{campaign.segment.trim()}</span>
                                      ) : null}
                                    </span>
                                    {typeof campaign.leads_count === 'number' ? (
                                      <span className="shrink-0 text-gray-500">
                                        {campaign.leads_count} лидов
                                      </span>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : null}
                        {itemSlotOccupied ? (
                          <p className="ve2-t-w mb-3 text-xs">
                            Sending slot по последнему снимку занят. Перед активацией Portal сверит
                            живой статус всех пересекающихся кампаний и продолжит только если слот
                            действительно освободился.
                          </p>
                        ) : null}
                        <label className="flex items-start gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            required
                            checked={reviewed}
                            onChange={(event) => {
                              setReviewedItemIds((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              });
                            }}
                            className="mt-0.5"
                          />
                          Я проверил тексты, получателей и настройки PAUSED-кампаний
                        </label>
                        <button
                          type="button"
                          onClick={() => void activateItem(item)}
                          disabled={!reviewed || busyItemId === item.id}
                          className={`${HE.btnPrimary} mt-3`}
                        >
                          {busyItemId === item.id
                            ? 'Активируем…'
                            : itemSlotOccupied
                              ? 'Проверить слот и активировать'
                              : 'Активировать отправку'}
                        </button>
                      </div>
                    ) : !slotHolding
                      && !terminal
                      && item.status === 'queued'
                      && item.activation_admissible ? (
                      <p className="mt-3 text-xs text-gray-500" role="status">
                        Сначала должна быть активирована более приоритетная группа в этом mailbox-пуле.
                      </p>
                    ) : !slotHolding && !terminal && item.status === 'queued' ? (
                      <p className="mt-3 text-xs text-gray-500" role="status">
                        {timingEligible
                          ? 'Активация пока отложена правилами времени запуска.'
                          : `Активация заблокирована сезонным решением «${STATE_LABEL[seasonalState]}».`}
                        {' '}PAUSED-кампании можно подготовить заранее.
                      </p>
                    ) : null}

                    {releaseOpen && releaseEditor ? (
                      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <label className="block text-xs font-medium text-gray-700">
                          Причина освобождения слота
                          <textarea
                            required
                            rows={2}
                            value={releaseEditor.reason}
                            onChange={(event) =>
                              setReleaseEditor({ ...releaseEditor, reason: event.target.value })
                            }
                            className={`${HE.input} mt-1.5 resize-y`}
                          />
                        </label>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void submitRelease()}
                            disabled={!releaseEditor.reason.trim() || busyItemId === item.id}
                            className={HE.btnPrimary}
                          >
                            {busyItemId === item.id
                              ? 'Сохраняем…'
                              : 'Подтвердить освобождение'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setReleaseEditor(null)}
                            className={HE.btnGhost}
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {overrideOpen && overrideEditor ? (
                      <fieldset className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <legend className="px-1 text-xs font-semibold text-gray-800">
                          Ручное сезонное решение
                        </legend>
                        <label className="mt-1 flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="radio"
                            name={`seasonality-${item.id}`}
                            checked={overrideEditor.decision === 'activate_next'}
                            onChange={() =>
                              setOverrideEditor({ ...overrideEditor, decision: 'activate_next' })
                            }
                          />
                          Активировать при освобождении слота
                        </label>
                        <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="radio"
                            name={`seasonality-${item.id}`}
                            checked={overrideEditor.decision === 'wait'}
                            onChange={() => setOverrideEditor({ ...overrideEditor, decision: 'wait' })}
                          />
                          Оставить в ожидании
                        </label>
                        <label className="mt-3 block text-xs font-medium text-gray-700">
                          Причина ручного решения
                          <textarea
                            required
                            rows={2}
                            value={overrideEditor.reason}
                            onChange={(event) =>
                              setOverrideEditor({ ...overrideEditor, reason: event.target.value })
                            }
                            className={`${HE.input} mt-1.5 resize-y`}
                          />
                        </label>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void submitOverride()}
                            disabled={
                              !overrideEditor.decision ||
                              !overrideEditor.reason.trim() ||
                              busyItemId === item.id
                            }
                            className={HE.btnPrimary}
                          >
                            {busyItemId === item.id ? 'Сохраняем…' : 'Сохранить решение'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setOverrideEditor(null)}
                            className={HE.btnGhost}
                          >
                            Отмена
                          </button>
                        </div>
                      </fieldset>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
