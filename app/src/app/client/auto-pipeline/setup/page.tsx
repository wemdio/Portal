'use client';

/**
 * Auto-pipeline sequence setup for клиентов в auto-режиме.
 *
 * Видна только клиентам с portal-mode='auto'. Доступ через sidebar item
 * CLIENT_NAV_AUTO_PIPELINE_SETUP (рендерится условно в ClientNavList).
 *
 * Что клиент здесь делает:
 *   1. Создаёт N диапазонов score (например: 0-1000, 1001-15000, ...).
 *   2. Под каждый диапазон пишет цепочку писем (3-5 шагов, на первом
 *      шаге можно A/B-варианты).
 *   3. Если для какого-то диапазона цепочка ПУСТАЯ — лиды этого диапазона
 *      сохраняются в seen_employers со status=stored, но в Instantly
 *      не отправляются. Это «не пишем» режим (например, для низких скоров).
 *   4. При сохранении API создаёт кампании в Instantly для непустых
 *      диапазонов и/или обновляет sequence в живых.
 *   5. Cron каждое утро парсит HH, дёргает endpoint, и кладёт лидов в
 *      соответствующую кампанию по диапазону score.
 *
 * Контракт API:
 *   GET  /api/client/auto-pipeline/config   → { enabled, endpoint_configured,
 *                                                score_buckets, has_bootstrapped }
 *   PUT  /api/client/auto-pipeline/config   ← { score_buckets: BucketInput[] }
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import type {
  ClientLaunchSequence,
  ClientLaunchSequenceStep,
  ClientLaunchSequenceVariant,
} from '@/lib/clientLaunch/types';

interface ScoreBucketRow {
  id: string | null;
  label: string;
  score_min: number;
  /** null = «и выше» (open-ended top range). */
  score_max: number | null;
  sequence: ClientLaunchSequence;
  instantly_campaign_id: string | null;
}

interface ConfigResponse {
  enabled: boolean;
  endpoint_configured: boolean;
  score_buckets: Array<{
    id?: string;
    label?: string;
    score_min?: number;
    score_max?: number | null;
    sequence?: ClientLaunchSequence;
    instantly_campaign_id?: string | null;
  }>;
  has_bootstrapped: boolean;
}

interface SaveResponse {
  ok: true;
  saved_buckets: number;
  sync_warnings: string[];
}

// ── helpers ─────────────────────────────────────────────────────────────

function emptyStep(waitDays = 0): ClientLaunchSequenceStep {
  return { subject: '', body: '', wait_days: waitDays };
}

function emptySequence(label: string): ClientLaunchSequence {
  return { name: label, steps: [emptyStep(0)] };
}

/**
 * Дефолтная заготовка диапазонов для нового клиента — четыре bucket'а,
 * под которые менеджер обычно настраивает первый запуск. Клиент может
 * добавить/убрать диапазоны, изменить границы. Пока для каждого
 * sequence пустая — на сохранении кампания в Instantly не создаётся.
 */
function defaultBuckets(): ScoreBucketRow[] {
  return [
    {
      id: null,
      label: 'Низкий скор — не писать',
      score_min: 0,
      score_max: 1000,
      sequence: { name: 'Низкий скор — не писать', steps: [] },
      instantly_campaign_id: null,
    },
    {
      id: null,
      label: 'Средний скор',
      score_min: 1001,
      score_max: 15000,
      sequence: emptySequence('Средний скор'),
      instantly_campaign_id: null,
    },
    {
      id: null,
      label: 'Высокий скор',
      score_min: 15001,
      score_max: 1_000_000,
      sequence: emptySequence('Высокий скор'),
      instantly_campaign_id: null,
    },
    {
      id: null,
      label: 'Топ скор',
      score_min: 1_000_001,
      score_max: null,
      sequence: emptySequence('Топ скор'),
      instantly_campaign_id: null,
    },
  ];
}

function bucketsFromResponse(
  storedBuckets: ConfigResponse['score_buckets'],
): ScoreBucketRow[] {
  if (!storedBuckets || storedBuckets.length === 0) return defaultBuckets();
  const result: ScoreBucketRow[] = [];
  for (const b of storedBuckets) {
    if (typeof b.score_min !== 'number' || !Number.isFinite(b.score_min)) continue;
    const score_max =
      b.score_max === null || b.score_max === undefined
        ? null
        : Number.isFinite(b.score_max)
          ? Number(b.score_max)
          : null;
    const label = typeof b.label === 'string' && b.label.trim() ? b.label : `${b.score_min}…`;
    const sequence =
      b.sequence && Array.isArray(b.sequence.steps)
        ? b.sequence
        : { name: label, steps: [] };
    result.push({
      id: typeof b.id === 'string' ? b.id : null,
      label,
      score_min: b.score_min,
      score_max,
      sequence,
      instantly_campaign_id: b.instantly_campaign_id ?? null,
    });
  }
  return result.sort((a, b) => a.score_min - b.score_min);
}

function isStepEmpty(step: ClientLaunchSequenceStep): boolean {
  return step.subject.trim() === '' && step.body.trim() === '';
}

function bucketHasContent(bucket: ScoreBucketRow): boolean {
  return bucket.sequence.steps.some((s) => !isStepEmpty(s));
}

function formatScoreMax(value: number | null): string {
  return value === null ? '∞' : value.toLocaleString('ru-RU');
}

// ── page component ──────────────────────────────────────────────────────

export default function AutoPipelineSetupPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [buckets, setBuckets] = useState<ScoreBucketRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncWarnings, setSyncWarnings] = useState<string[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await clientApiFetch<ConfigResponse>('/auto-pipeline/config');
      setConfig(data);
      setBuckets(bucketsFromResponse(data.score_buckets));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Frontend-side validation, идентичная backend'у — помогает UX (мгновенный
  // фидбэк), backend всё равно перепроверит при PUT.
  const validationError = useMemo<string | null>(() => {
    if (buckets.length === 0) return 'Нужно задать хотя бы один диапазон';
    const sorted = [...buckets].sort((a, b) => a.score_min - b.score_min);
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i];
      if (!b.label.trim()) return `Пустое название у диапазона #${i + 1}`;
      if (b.score_max !== null && b.score_min > b.score_max) {
        return `«${b.label}»: нижняя граница (${b.score_min}) больше верхней (${b.score_max})`;
      }
      if (i < sorted.length - 1) {
        const next = sorted[i + 1];
        if (b.score_max === null) {
          return `«${b.label}» имеет открытую верхнюю границу — должен быть последним`;
        }
        if (next.score_min <= b.score_max) {
          return `Диапазоны «${b.label}» и «${next.label}» пересекаются (${b.score_max} ≥ ${next.score_min})`;
        }
      }
    }
    return null;
  }, [buckets]);

  const handleSave = useCallback(async () => {
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSyncWarnings([]);
    try {
      const payload = {
        score_buckets: buckets.map((b) => ({
          id: b.id,
          label: b.label,
          score_min: b.score_min,
          score_max: b.score_max,
          sequence: {
            name: b.sequence.name || b.label,
            steps: b.sequence.steps.filter((s) => !isStepEmpty(s)),
          },
        })),
      };
      const res = await clientApiFetch<SaveResponse>('/auto-pipeline/config', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setSavedAt(Date.now());
      setSyncWarnings(res.sync_warnings ?? []);
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }, [buckets, reload, validationError]);

  const addBucket = useCallback(() => {
    setBuckets((prev) => {
      // Новый bucket встаёт после последнего: score_min = (последний max + 1).
      const sorted = [...prev].sort((a, b) => a.score_min - b.score_min);
      const last = sorted[sorted.length - 1];
      const min = last && last.score_max !== null ? last.score_max + 1 : 0;
      const label = `Диапазон от ${min}`;
      return [
        ...prev,
        {
          id: null,
          label,
          score_min: min,
          score_max: null,
          sequence: emptySequence(label),
          instantly_campaign_id: null,
        },
      ];
    });
  }, []);

  // ── render ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--cp-text-l)' }} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl mx-auto">
        <ErrorBlock text={loadError} onRetry={() => void reload()} />
      </div>
    );
  }

  if (!config) return null;

  if (!config.enabled || !config.endpoint_configured) {
    return (
      <div className="max-w-3xl mx-auto">
        <Header />
        <div className="neu-card px-5 py-8 text-center">
          <AlertCircle className="mx-auto h-8 w-8 mb-3" style={{ color: 'var(--cp-text-l)' }} />
          <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
            Авто-пайплайн ещё не подключён
          </p>
          <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
            Обратитесь к менеджеру — настроим endpoint скоринга и включим режим.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto pb-24">
      <Header />

      <p className="text-sm mb-6" style={{ color: 'var(--cp-text-m)' }}>
        Настройте диапазоны score, которые возвращает ваш endpoint. Для каждого
        диапазона напишите свою цепочку писем. <strong>Пустая цепочка</strong> —
        лиды с таким скором сохраняются в журнале, но <strong>не отправляются</strong>
        (полезно для «холодных» сегментов).
      </p>

      <div className="flex flex-col gap-5 mb-4">
        {buckets.map((bucket, idx) => (
          <BucketCard
            key={`${bucket.id ?? 'new'}-${idx}`}
            bucket={bucket}
            position={idx + 1}
            canDelete={buckets.length > 1}
            onChange={(updater) =>
              setBuckets((prev) => {
                const next = [...prev];
                next[idx] = updater(next[idx]);
                return next;
              })
            }
            onDelete={() =>
              setBuckets((prev) => prev.filter((_, i) => i !== idx))
            }
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addBucket}
        className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold mb-4"
        style={{ color: 'var(--cp-text-m)' }}
      >
        <Plus className="h-3.5 w-3.5" /> Добавить диапазон
      </button>

      <div className="sticky bottom-4 neu-card flex items-center gap-3 px-5 py-4">
        {(saveError || validationError) && (
          <span className="text-xs flex-1" style={{ color: 'var(--cp-danger)' }}>
            {saveError ?? validationError}
          </span>
        )}
        {!saveError && !validationError && savedAt && Date.now() - savedAt < 5000 && (
          <span className="text-xs flex-1 inline-flex items-center gap-1.5" style={{ color: 'var(--cp-success, #4ade80)' }}>
            <Check className="h-3.5 w-3.5" /> Сохранено
          </span>
        )}
        {!saveError && !validationError && (!savedAt || Date.now() - savedAt >= 5000) && (
          <span className="text-xs flex-1" style={{ color: 'var(--cp-text-l)' }}>
            {syncWarnings.length > 0
              ? `Сохранено, но ${syncWarnings.length} ${syncWarnings.length === 1 ? 'кампания' : 'кампаний'} не синхронизирована${syncWarnings.length === 1 ? '' : 'ы'} с Instantly`
              : 'Изменения применятся ко всем будущим прогонам'}
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !!validationError}
          className="neu-btn px-5 py-2 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Сохранение
            </>
          ) : (
            'Сохранить'
          )}
        </button>
      </div>

      {syncWarnings.length > 0 && (
        <div className="mt-4 neu-inset rounded-2xl px-4 py-3 text-xs" style={{ color: 'var(--cp-danger)' }}>
          <p className="font-bold mb-1">Не удалось синхронизировать с Instantly:</p>
          <ul className="list-disc list-inside space-y-0.5">
            {syncWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <p className="mt-2" style={{ color: 'var(--cp-text-m)' }}>
            Тексты сохранены в портале — попробуйте сохранить ещё раз через минуту, либо обратитесь к менеджеру.
          </p>
        </div>
      )}
    </div>
  );
}

// ── subcomponents ───────────────────────────────────────────────────────

function Header() {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-extrabold tracking-tight" style={{ color: 'var(--cp-text)' }}>
        Настройка цепочек
      </h1>
    </header>
  );
}

function ErrorBlock({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="neu-card px-5 py-6 flex items-center gap-3" role="alert">
      <AlertCircle className="h-5 w-5" style={{ color: 'var(--cp-danger)' }} />
      <span className="flex-1 text-sm" style={{ color: 'var(--cp-text)' }}>
        {text}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="neu-pill px-3 py-1 text-xs font-semibold"
        style={{ color: 'var(--cp-text)' }}
      >
        Повторить
      </button>
    </div>
  );
}

function BucketCard({
  bucket,
  position,
  canDelete,
  onChange,
  onDelete,
}: {
  bucket: ScoreBucketRow;
  position: number;
  canDelete: boolean;
  onChange: (updater: (prev: ScoreBucketRow) => ScoreBucketRow) => void;
  onDelete: () => void;
}) {
  const hasContent = bucketHasContent(bucket);
  const statusLabel = useMemo(() => {
    if (!hasContent) return 'Не пишем — лиды сохраняются без отправки';
    if (bucket.instantly_campaign_id) return 'Кампания в Instantly: создана';
    return 'Кампания создастся при сохранении';
  }, [hasContent, bucket.instantly_campaign_id]);

  const statusColor = bucket.instantly_campaign_id
    ? 'var(--cp-success, #4ade80)'
    : hasContent
      ? 'var(--cp-accent)'
      : 'var(--cp-text-l)';

  return (
    <section className="neu-card px-5 py-4" aria-labelledby={`bucket-${position}`}>
      <header className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[11px] font-bold uppercase tracking-wider"
              style={{ color: 'var(--cp-text-l)' }}
            >
              Score {bucket.score_min.toLocaleString('ru-RU')} – {formatScoreMax(bucket.score_max)}
            </span>
          </div>
          <input
            id={`bucket-${position}`}
            type="text"
            value={bucket.label}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, label: e.target.value }))
            }
            placeholder="Название диапазона"
            className="w-full bg-transparent text-base font-bold focus:outline-none"
            style={{ color: 'var(--cp-text)' }}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-semibold" style={{ color: statusColor }}>
            {statusLabel}
          </span>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="p-1.5"
              style={{ color: 'var(--cp-text-l)' }}
              aria-label="Удалить диапазон"
              title="Удалить диапазон"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-[11px] block mb-1" style={{ color: 'var(--cp-text-l)' }}>
            От (включительно)
          </label>
          <input
            type="number"
            value={bucket.score_min}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange((prev) => ({
                ...prev,
                score_min: Number.isFinite(n) ? n : 0,
              }));
            }}
            className="w-full neu-inset rounded-lg px-3 py-1.5 text-sm bg-transparent focus:outline-none tabular-nums"
            style={{ color: 'var(--cp-text)' }}
          />
        </div>
        <div>
          <label className="text-[11px] block mb-1" style={{ color: 'var(--cp-text-l)' }}>
            До (включительно, пусто = ∞)
          </label>
          <input
            type="number"
            value={bucket.score_max ?? ''}
            placeholder="∞ (без верхней границы)"
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === '') {
                onChange((prev) => ({ ...prev, score_max: null }));
              } else {
                const n = Number(raw);
                if (Number.isFinite(n)) {
                  onChange((prev) => ({ ...prev, score_max: n }));
                }
              }
            }}
            className="w-full neu-inset rounded-lg px-3 py-1.5 text-sm bg-transparent focus:outline-none tabular-nums"
            style={{ color: 'var(--cp-text)' }}
          />
        </div>
      </div>

      <SequenceEditor
        sequence={bucket.sequence}
        onChange={(updater) =>
          onChange((prev) => ({ ...prev, sequence: updater(prev.sequence) }))
        }
      />
    </section>
  );
}

function SequenceEditor({
  sequence,
  onChange,
}: {
  sequence: ClientLaunchSequence;
  onChange: (updater: (prev: ClientLaunchSequence) => ClientLaunchSequence) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {sequence.steps.length === 0 && (
        <div
          className="neu-inset rounded-2xl px-4 py-3 text-xs"
          style={{ color: 'var(--cp-text-l)' }}
        >
          Цепочка пуста — лиды этого диапазона будут попадать в журнал
          (status=stored), но в Instantly не отправятся. Чтобы начать слать —
          добавьте первое письмо ниже.
        </div>
      )}

      {sequence.steps.map((step, idx) => (
        <StepEditor
          key={idx}
          step={step}
          stepIndex={idx}
          isFirst={idx === 0}
          canDelete={sequence.steps.length > 0}
          onChange={(updater) =>
            onChange((prev) => ({
              ...prev,
              steps: prev.steps.map((s, i) => (i === idx ? updater(s) : s)),
            }))
          }
          onDelete={() =>
            onChange((prev) => ({
              ...prev,
              steps: prev.steps.filter((_, i) => i !== idx),
            }))
          }
        />
      ))}

      {sequence.steps.length < 7 && (
        <button
          type="button"
          onClick={() =>
            onChange((prev) => ({
              ...prev,
              steps: [
                ...prev.steps,
                { subject: '', body: '', wait_days: prev.steps.length === 0 ? 0 : 3 },
              ],
            }))
          }
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold self-start"
          style={{ color: 'var(--cp-text-m)' }}
        >
          <Plus className="h-3.5 w-3.5" />
          {sequence.steps.length === 0 ? 'Добавить первое письмо' : 'Добавить follow-up'}
        </button>
      )}
    </div>
  );
}

function StepEditor({
  step,
  stepIndex,
  isFirst,
  canDelete,
  onChange,
  onDelete,
}: {
  step: ClientLaunchSequenceStep;
  stepIndex: number;
  isFirst: boolean;
  canDelete: boolean;
  onChange: (updater: (prev: ClientLaunchSequenceStep) => ClientLaunchSequenceStep) => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="neu-inset rounded-2xl px-4 py-3"
      aria-label={isFirst ? 'Первое письмо' : `Follow-up ${stepIndex}`}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <span
          className="text-[11px] font-bold uppercase tracking-wider"
          style={{ color: 'var(--cp-text-l)' }}
        >
          {isFirst ? 'Письмо 1 (первое касание)' : `Follow-up ${stepIndex}`}
        </span>
        <div className="flex items-center gap-2">
          {!isFirst && (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={30}
                value={step.wait_days}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onChange((prev) => ({
                    ...prev,
                    wait_days: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0,
                  }));
                }}
                className="w-12 text-center text-xs neu-pill px-2 py-1"
                style={{ color: 'var(--cp-text)' }}
              />
              <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                дн после предыдущего
              </span>
            </div>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="p-1"
              style={{ color: 'var(--cp-text-l)' }}
              aria-label="Удалить шаг"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <input
        type="text"
        value={step.subject}
        onChange={(e) =>
          onChange((prev) => ({ ...prev, subject: e.target.value }))
        }
        placeholder="Тема письма"
        className="w-full text-sm font-semibold bg-transparent focus:outline-none mb-2"
        style={{ color: 'var(--cp-text)' }}
      />
      <textarea
        value={step.body}
        onChange={(e) =>
          onChange((prev) => ({ ...prev, body: e.target.value }))
        }
        placeholder="Текст письма…"
        rows={6}
        className="w-full text-sm bg-transparent focus:outline-none resize-y"
        style={{ color: 'var(--cp-text)' }}
      />

      {isFirst && (
        <FirstStepVariants
          variants={step.variants ?? []}
          onChange={(next) => onChange((prev) => ({ ...prev, variants: next }))}
        />
      )}
    </div>
  );
}

function FirstStepVariants({
  variants,
  onChange,
}: {
  variants: ClientLaunchSequenceVariant[];
  onChange: (next: ClientLaunchSequenceVariant[]) => void;
}) {
  const canAdd = variants.length < 2;

  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px dashed var(--cp-divider)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
          Альтернативные варианты первого письма (A/B/C)
        </span>
        {canAdd && (
          <button
            type="button"
            onClick={() => onChange([...variants, { subject: '', body: '' }])}
            className="neu-pill text-[11px] px-2 py-1 inline-flex items-center gap-1"
            style={{ color: 'var(--cp-text-m)' }}
          >
            <Plus className="h-3 w-3" /> Добавить вариант
          </button>
        )}
      </div>
      {variants.length === 0 ? (
        <p className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          Можно добавить 1-2 альтернативных варианта — Instantly случайно выберет один на каждого лида.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {variants.map((variant, vi) => (
            <div key={vi} className="rounded-xl px-3 py-2" style={{ background: 'rgba(0,0,0,0.03)' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
                  Вариант {String.fromCharCode(66 + vi)}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(variants.filter((_, i) => i !== vi))}
                  className="p-1"
                  style={{ color: 'var(--cp-text-l)' }}
                  aria-label="Удалить вариант"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <input
                type="text"
                value={variant.subject ?? ''}
                onChange={(e) => {
                  const next = [...variants];
                  next[vi] = { ...variant, subject: e.target.value };
                  onChange(next);
                }}
                placeholder="Тема (вариант)"
                className="w-full text-xs font-semibold bg-transparent focus:outline-none mb-1"
                style={{ color: 'var(--cp-text)' }}
              />
              <textarea
                value={variant.body}
                onChange={(e) => {
                  const next = [...variants];
                  next[vi] = { ...variant, body: e.target.value };
                  onChange(next);
                }}
                placeholder="Текст письма (вариант)"
                rows={4}
                className="w-full text-xs bg-transparent focus:outline-none resize-y"
                style={{ color: 'var(--cp-text)' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
