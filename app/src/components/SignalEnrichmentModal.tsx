"use client";

import { useMemo, useState } from 'react';
import {
  BUILTIN_PRESETS,
  EXTRACTOR_GROUPS,
  EXTRACTOR_LABELS,
  EXTRACTOR_TO_SUBPAGES,
  type ExtractorKey,
  type SignalPresetId,
} from '@/lib/enrich/extractors/types';

/**
 * State shape mirrors the slice owned by `DatabaseSpreadsheet`. Kept as a
 * structural type instead of importing the parent's type to keep this
 * component self-contained and easier to test in isolation.
 */
export interface SignalEnrichmentModalState {
  isOpen: boolean;
  sourceCol: number;
  isProcessing: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
  /**
   * Epoch ms момента запуска активной задачи. Заполняется владельцем
   * (`DatabaseSpreadsheet`) — здесь только читается для отрисовки
   * «Процесс начат в HH:MM / Примерное время окончания HH:MM».
   * `null` пока задача не запущена.
   */
  startedAt: number | null;
  detectedJob: { id: string; total: number; processed: number; progress: number } | null;
  selectedExtractors: ExtractorKey[];
  presetId: SignalPresetId | string | null;
  customPresets: Array<{ id: string; name: string; extractors: ExtractorKey[] }>;
  cascadeToast: string | null;
}

interface Props {
  state: SignalEnrichmentModalState;
  headerLabels: string[];
  onChangeSourceCol: (idx: number) => void;
  onTogglePreset: (preset: { id: string; extractors: ExtractorKey[] }) => void;
  onSavePreset: () => void;
  onDeletePreset: (id: string) => void;
  onToggleExtractor: (key: ExtractorKey) => void;
  onClose: () => void;
  onStart: () => void;
  onResume: () => void;
  onStop: () => void;
}

/**
 * Estimate runtime in seconds per URL given the set of selected extractors.
 * Each unique subpage adds ~2s (an extra HTTP fetch + parse). Main page is
 * always counted. This is shown in the UI only — actual runtime depends on
 * server load, Playwright fallbacks, and target site performance.
 */
function estimateSecondsPerUrl(selected: ExtractorKey[]): number {
  const subpages = new Set<string>();
  for (const key of selected) {
    for (const sp of EXTRACTOR_TO_SUBPAGES[key] ?? []) subpages.add(sp);
  }
  return 2 + subpages.size * 2;
}

/**
 * How many URLs really run in parallel on prod, after all friction.
 *
 * Nominal capacity is 3 worker-enrich replicas × WEBSITE_ENRICHMENT_CONCURRENCY
 * (=25) = 75 slots. Actual throughput is lower because of: Playwright fallback
 * (~5-10× slower than HTTP for the slowest 10-20% of URLs), DOMAIN_CONCURRENCY=1
 * (same-domain URLs serialize), subpage fan-out per URL, and the 60s hard cap
 * on pathological pages. ~50 is the observed effective number.
 *
 * Keep in sync with docker-compose.prod.yml `WEBSITE_ENRICHMENT_CONCURRENCY`
 * and the `worker-enrich-*` replica count if either changes.
 */
const EFFECTIVE_PROD_PARALLELISM = 50;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${seconds} сек`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `~${hours} ч ${remMin} мин` : `~${hours} ч`;
}

/** Локальное HH:MM (без секунд) — для UI плашек «начат в» / «окончание в». */
function formatTimeHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Russian noun pluralization (1 сигнал, 2 сигнала, 5 сигналов). */
function pluralizeRu(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export default function SignalEnrichmentModal({
  state,
  headerLabels,
  onChangeSourceCol,
  onTogglePreset,
  onSavePreset,
  onDeletePreset,
  onToggleExtractor,
  onClose,
  onStart,
  onResume,
  onStop,
}: Props) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    base: true,
    customers: true,
    pricing: false,
    hiring: false,
    company: false,
  });

  const previewColumns = useMemo(() => {
    return state.selectedExtractors.map((k) => EXTRACTOR_LABELS[k]);
  }, [state.selectedExtractors]);

  const urlsWithData = useMemo(() => {
    // Estimating actual runtime requires the row count of the active tab,
    // which is owned by the parent. We approximate using `totalRows` set by
    // the parent on submit; before submit we just show a generic per-URL hint.
    return state.totalRows;
  }, [state.totalRows]);

  const secondsPerUrl = estimateSecondsPerUrl(state.selectedExtractors);
  // Real estimate = serial seconds ÷ how many URLs really run in parallel.
  // Without the divisor the UI used to advertise "~64ч" for a 16k-URL job
  // that actually finished in ~1ч because 3 worker replicas were chewing
  // through ~50 URLs at a time. Floor at 60s so a tiny 10-URL job doesn't
  // read as "12 секунд" when in reality just spinning up has overhead.
  const estimatedTotalSeconds =
    urlsWithData > 0
      ? Math.max(60, Math.ceil((urlsWithData * secondsPerUrl) / EFFECTIVE_PROD_PARALLELISM))
      : 0;

  const allPresets: Array<{
    id: string;
    name: string;
    extractors: ExtractorKey[];
    builtin: boolean;
    description?: string;
  }> = [
    ...Object.values(BUILTIN_PRESETS).map((p) => ({
      id: p.id,
      name: p.name,
      extractors: p.extractors,
      builtin: true,
      description: p.description,
    })),
    ...state.customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      extractors: p.extractors,
      builtin: false,
    })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-2xl bg-white shadow-2xl border border-gray-200 flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-lg font-bold text-indigo-600">
              S
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-gray-900">Сигналы с сайтов</h3>
              <p className="text-xs text-gray-500 font-medium">
                Парсинг сайта + опционально его подстраниц для вытаскивания структурированных сигналов
              </p>
            </div>
          </div>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Source column */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Колонка с сайтами</label>
            <select
              value={state.sourceCol}
              onChange={(e) => onChangeSourceCol(Number(e.target.value))}
              disabled={state.isProcessing}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-60"
            >
              {headerLabels.map((label, index) => (
                <option key={`signal-col-${index}`} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Presets */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-gray-700">Пресеты</label>
              <button
                type="button"
                onClick={onSavePreset}
                disabled={state.isProcessing}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                Сохранить текущий
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {allPresets.map((preset) => {
                const isActive = state.presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onTogglePreset({ id: preset.id, extractors: preset.extractors })}
                    disabled={state.isProcessing}
                    title={preset.description}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      isActive
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                    } disabled:opacity-50`}
                  >
                    {preset.name}
                    {!preset.builtin && (
                      <span
                        role="button"
                        aria-label="Удалить пресет"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Удалить пресет «${preset.name}»?`)) onDeletePreset(preset.id);
                        }}
                        className="text-gray-400 hover:text-red-500 cursor-pointer"
                      >
                        ×
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Accordion of extractor groups */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700">Что собирать</label>
            {EXTRACTOR_GROUPS.map((group) => {
              const isOpen = openGroups[group.id] ?? false;
              const enabledInGroup = group.extractors.filter((k) =>
                state.selectedExtractors.includes(k),
              ).length;
              return (
                <div
                  key={group.id}
                  className="rounded-lg border border-gray-200 bg-gray-50/40 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setOpenGroups((prev) => ({ ...prev, [group.id]: !isOpen }))
                    }
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-gray-100/60 transition"
                  >
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{group.title}</p>
                      <p className="text-[11px] text-gray-500">{group.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-gray-500">
                        {enabledInGroup}/{group.extractors.length}
                      </span>
                      <span className="text-gray-400">{isOpen ? '▾' : '▸'}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-gray-100 bg-white px-3 py-2 space-y-1.5">
                      {group.extractors.map((key) => {
                        const checked = state.selectedExtractors.includes(key);
                        const isLocked = key === 'stack' || key === 'profile';
                        return (
                          <label
                            key={key}
                            className={`flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer transition ${
                              checked ? 'bg-indigo-50/60' : 'hover:bg-gray-50'
                            } ${isLocked ? 'cursor-not-allowed opacity-80' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={state.isProcessing || isLocked}
                              onChange={() => onToggleExtractor(key)}
                              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-gray-900">
                                  {EXTRACTOR_LABELS[key]}
                                </span>
                                {isLocked && (
                                  <span className="text-[10px] uppercase tracking-wider text-gray-400">
                                    обязательно
                                  </span>
                                )}
                              </div>
                              {EXTRACTOR_TO_SUBPAGES[key].length > 0 && (
                                <p className="text-[11px] text-gray-500">
                                  Подгружает: {EXTRACTOR_TO_SUBPAGES[key].join(', ')}
                                </p>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Live preview */}
          {previewColumns.length > 0 && (
            <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3">
              <p className="text-[11px] font-semibold text-indigo-800 uppercase tracking-wide mb-1.5">
                Будут добавлены колонки ({previewColumns.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {previewColumns.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700 border border-indigo-200"
                  >
                    {label}
                  </span>
                ))}
              </div>
              {state.isProcessing && state.startedAt != null && (
                <>
                  <p className="mt-2 text-[11px] text-indigo-600">
                    Процесс начат в: {formatTimeHHMM(state.startedAt)}
                  </p>
                  {estimatedTotalSeconds > 0 && (
                    <p className="mt-0.5 text-[11px] text-indigo-600">
                      Примерное время окончания:{' '}
                      {formatTimeHHMM(state.startedAt + estimatedTotalSeconds * 1000)}
                    </p>
                  )}
                </>
              )}
              <p className="mt-2 text-[11px] text-indigo-600">
                {urlsWithData > 0
                  ? `Ожидаемое время: ${formatDuration(estimatedTotalSeconds)} (${urlsWithData.toLocaleString('ru-RU')} URL × ~${secondsPerUrl}с, ~${EFFECTIVE_PROD_PARALLELISM} параллельно)`
                  : `Ожидаемое время: ${secondsPerUrl}с / URL`}
              </p>
              <p className="mt-1 text-[11px] text-indigo-600">
                Можно закрыть страницу — задача продолжит работу в фоне.
              </p>
            </div>
          )}

          {/* Cascade toast */}
          {state.cascadeToast && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              {state.cascadeToast}
            </div>
          )}

          {/* Detected job */}
          {state.detectedJob && !state.isProcessing && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 space-y-2">
              <div>
                <p className="font-semibold">Найдена активная задача анализа сигналов</p>
                <p>
                  Прогресс: {state.detectedJob.processed} / {state.detectedJob.total} (
                  {state.detectedJob.progress}%)
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onResume}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700"
                >
                  Подключиться
                </button>
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
                >
                  Остановить
                </button>
              </div>
            </div>
          )}

          {/* Progress bar */}
          {state.isProcessing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span>
                  Обработано: {state.currentRow} / {state.totalRows}
                </span>
                <span className="font-semibold">{state.progress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {state.error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
              {state.error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4 bg-gray-50/50">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
          >
            Закрыть
          </button>
          {state.isProcessing ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-red-700"
            >
              Остановить
            </button>
          ) : (
            !state.detectedJob && (
              <button
                type="button"
                onClick={onStart}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-indigo-700"
              >
                Запустить ({state.selectedExtractors.length}{' '}
                {pluralizeRu(state.selectedExtractors.length, ['сигнал', 'сигнала', 'сигналов'])})
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
