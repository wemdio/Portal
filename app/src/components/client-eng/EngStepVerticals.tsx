'use client';

/**
 * Шаг 2 «Verticals»: доска вертикалей с гипотезами. Кнопки Accept/Reject
 * размечают гипотезы (PATCH /api/client/eng/hypotheses/[id], % и rank
 * вертикалей пересчитываются на бэкенде). Accepted-гипотезы — основа
 * авто-сборки базы на шаге 4.
 */

import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { HeHypothesis, HeVertical } from '@/lib/hypothesisEngine/types';
import { patchEngHypothesis } from './api-client';
import { EngBadge, EngCard, EngSpinner, hypothesisStatusTone } from './ui';
import type { EngDetail } from './EngProjectWizard';

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1 · obvious',
  2: 'Tier 2 · adjacent',
  3: 'Tier 3 · non-obvious',
};

function HypothesisCard({
  hypothesis,
  busy,
  onVerdict,
}: {
  hypothesis: HeHypothesis;
  busy: boolean;
  onVerdict: (id: string, verdict: 'accept' | 'reject') => void;
}) {
  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-2"
      style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
          {hypothesis.title}
        </span>
        <EngBadge label={TIER_LABELS[hypothesis.tier] ?? `Tier ${hypothesis.tier}`} tone="neutral" />
        <span className="ml-auto ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
          {hypothesis.potential_pct}%
        </span>
        <EngBadge label={hypothesis.status} tone={hypothesisStatusTone(hypothesis.status)} />
      </div>
      {hypothesis.description && (
        <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--cp-text-m)' }}>
          {hypothesis.description}
        </p>
      )}
      {hypothesis.fit_rationale && (
        <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--cp-text-l)' }}>
          {hypothesis.fit_rationale}
        </p>
      )}
      {hypothesis.status === 'proposed' && (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => onVerdict(hypothesis.id, 'accept')}
            disabled={busy}
            className="neu-pill px-3 py-1 text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            style={{ color: 'var(--cp-green)' }}
          >
            {busy ? <EngSpinner className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            Accept
          </button>
          <button
            type="button"
            onClick={() => onVerdict(hypothesis.id, 'reject')}
            disabled={busy}
            className="neu-pill px-3 py-1 text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            style={{ color: 'var(--cp-red)' }}
          >
            <X className="h-3 w-3" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function EngStepVerticals({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const hypotheses = useMemo(() => (detail.hypotheses ?? []) as HeHypothesis[], [detail]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const onVerdict = async (id: string, verdict: 'accept' | 'reject') => {
    if (busyId) return;
    setBusyId(id);
    setError('');
    try {
      await patchEngHypothesis(id, verdict);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the verdict');
    } finally {
      setBusyId(null);
    }
  };

  if (verticals.length === 0 && hypotheses.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          No verticals yet — they appear once the research finishes (step 1).
        </p>
      </EngCard>
    );
  }

  const acceptedTotal = hypotheses.filter((h) => h.status === 'accepted').length;
  const ungrouped = hypotheses.filter(
    (h) => !h.vertical_id || !verticals.some((v) => v.id === h.vertical_id),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
        {acceptedTotal} of {hypotheses.length} hypotheses accepted — accepted ones drive the base collection on step 4.
      </div>

      {verticals.map((v) => {
        const own = hypotheses.filter((h) => h.vertical_id === v.id);
        const accepted = own.filter((h) => h.status === 'accepted').length;
        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                #{v.rank ?? '—'}
              </span>
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
              <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
                {v.potential_pct}%
              </span>
              <span className="ml-auto text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                {accepted}/{own.length} accepted
              </span>
            </div>
            {v.summary && (
              <p className="mt-1.5 text-xs whitespace-pre-wrap" style={{ color: 'var(--cp-text-m)' }}>
                {v.summary}
              </p>
            )}
            <div className="mt-3 flex flex-col gap-2">
              {own.map((h) => (
                <HypothesisCard key={h.id} hypothesis={h} busy={busyId === h.id} onVerdict={(id, verdict) => void onVerdict(id, verdict)} />
              ))}
              {own.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                  No hypotheses linked to this vertical.
                </p>
              )}
            </div>
          </EngCard>
        );
      })}

      {ungrouped.length > 0 && (
        <EngCard>
          <h4 className="text-sm font-bold m-0 mb-3" style={{ color: 'var(--cp-paper)' }}>
            Ungrouped hypotheses
          </h4>
          <div className="flex flex-col gap-2">
            {ungrouped.map((h) => (
              <HypothesisCard key={h.id} hypothesis={h} busy={busyId === h.id} onVerdict={(id, verdict) => void onVerdict(id, verdict)} />
            ))}
          </div>
        </EngCard>
      )}

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
