'use client';

import type { EngBaseSummary, EngCollectionTarget } from './api-client';

const formatCount = (count: number) => count.toLocaleString('en-US');

const STOP_EXPLANATIONS: Record<NonNullable<EngCollectionTarget['stop_reason']>, string> = {
  budget_limit: 'Collection stopped at the spending limit for this base.',
  sources_exhausted: 'The current sources have no more matching companies to check.',
  low_yield: 'Collection stopped because the latest batches added too few matching contacts.',
  safety_limit: 'Collection reached its collection limit before both targets were met.',
  error: 'Collection stopped before both targets were met. The contacts already checked are saved.',
};

/** The target is absent on older collections. Never infer it from row_count. */
export function engCollectionTargetView(base: EngBaseSummary) {
  const target = base.collect_info?.eng_collection_target;
  if (!target || target.version !== 1) return null;
  const counts = [target.ready_target, target.reserve_target, target.ready_count, target.reserve_count, target.total_ready];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || target.ready_target === 0 || target.reserve_target === 0) {
    return null;
  }
  const ready = Math.min(target.ready_count, target.ready_target);
  const reserve = target.reserve_count;
  const firstBatchReached = ready >= target.ready_target;
  const reserveReached = reserve >= target.reserve_target;
  const complete = target.phase === 'complete' && firstBatchReached && reserveReached;
  const active = base.status === 'collecting' && (target.phase === 'collecting' || target.phase === 'building_reserve');
  const remainingReady = Math.max(0, target.ready_target - ready);
  const remainingReserve = Math.max(0, target.reserve_target - reserve);
  const headline = complete
    ? 'First batch and reserve collected'
    : active
      ? firstBatchReached ? 'First batch collected. Building the reserve…' : 'Collecting your first batch…'
      : firstBatchReached && reserveReached ? 'Contact targets collected' : 'Collection ended before both targets were reached';
  const shortfall = active || complete ? null : remainingReady > 0
    ? `The first batch is ${formatCount(remainingReady)} contacts short of its target.`
    : remainingReserve > 0
      ? `The first batch is collected. The reserve is ${formatCount(remainingReserve)} contacts short of its target.`
      : null;
  return {
    target, ready, reserve, firstBatchReached, reserveReached, complete, active, headline, shortfall,
    stopExplanation: !active && !complete && target.stop_reason ? STOP_EXPLANATIONS[target.stop_reason] : null,
  };
}

function ContactTargetProgress({ label, count, target }: { label: string; count: number; target: number }) {
  const percent = Math.min(100, Math.max(0, count / target * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span>{label}</span>
        <span className="ds-mono text-[11px] tabular-nums">{formatCount(count)} / {formatCount(target)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(count, target)}
        aria-valuetext={`${formatCount(count)} of ${formatCount(target)} checked contacts collected`}
        className="h-1 overflow-hidden rounded-full"
        style={{ background: 'var(--cp-divider)' }}
      >
        <div
          className="h-full origin-left rounded-full transition-transform duration-200 motion-reduce:transition-none"
          style={{ background: 'var(--cp-paper)', transform: `scaleX(${percent / 100})` }}
        />
      </div>
    </div>
  );
}

/** The reserve is saved, validated contacts; it is never a market-size forecast. */
export function EngCollectionTargetSummary({ base }: { base: EngBaseSummary }) {
  const view = engCollectionTargetView(base);
  if (!view) return null;
  return (
    <div className="mt-3 flex flex-col gap-3 text-xs" style={{ color: 'var(--cp-text-m)' }}>
      <div role="status" style={{ color: view.complete ? 'var(--cp-green)' : 'var(--cp-amber)' }}>
        {view.headline}
      </div>
      <ContactTargetProgress label="First batch" count={view.ready} target={view.target.ready_target} />
      <ContactTargetProgress label="Reserve collected" count={view.reserve} target={view.target.reserve_target} />
      <div className="flex flex-col gap-1 text-[11px]">
        {view.stopExplanation && <div>{view.stopExplanation}</div>}
        {view.shortfall && <div>{view.shortfall}</div>}
        <div style={{ color: 'var(--cp-text-l)' }}>
          Only checked, unique contacts from matching companies count toward these targets.
        </div>
      </div>
    </div>
  );
}
