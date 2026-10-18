'use client';

import { useEffect, useState } from 'react';
import { Check, Clock3, CircleAlert } from 'lucide-react';
import type { EngCollectionProgress as CollectionProgress } from './api-client';
import { EngSpinner } from './ui';

const STEP_LABELS: Record<string, string> = {
  find_emails: 'Finding email addresses',
  enrich_descriptions: 'Adding company details',
  split_emails: 'Preparing individual contacts',
  dedup_email: 'Removing duplicate addresses',
  validate_emails: 'Checking email addresses',
  cap_emails_per_company: 'Applying your contact limit',
  company_qualification: 'Checking companies and countries…',
};

/** An old heartbeat is not proof of a failure, or of work still advancing. */
export function engCollectionProgressView(progress: CollectionProgress | null | undefined, now: number) {
  const heartbeat = progress?.heartbeat_at ? Date.parse(progress.heartbeat_at) : NaN;
  const age = Number.isFinite(heartbeat) ? Math.max(0, now - heartbeat) : null;
  const fresh = age !== null && age < 3 * 60_000;
  const processing = progress?.status === 'processing';
  const active = processing && fresh;
  const complete = progress?.status === 'completed';
  const stopped = progress?.status === 'failed' || progress?.status === 'cancelled';
  const title = complete
    ? 'Email checks complete'
    : progress?.status === 'failed'
      ? 'Email preparation stopped'
      : progress?.status === 'cancelled'
        ? 'Email preparation cancelled'
        : progress?.status === 'pending'
          ? 'Email preparation is queued'
          : processing
            ? STEP_LABELS[progress.step_key ?? ''] ?? 'Preparing contacts'
            : 'Waiting for preparation details';
  const step = progress?.step_index;
  const total = progress?.total_steps;
  const stepLabel = processing && step !== null && step !== undefined && total !== null && total !== undefined &&
    step > 0 && total >= step ? `Step ${step} of ${total}` : null;
  const percent = processing && progress.step_key && STEP_LABELS[progress.step_key] &&
    typeof progress.step_percent === 'number' && Number.isFinite(progress.step_percent)
    ? Math.min(100, Math.max(0, Math.round(progress.step_percent))) : null;
  const companyCheck = progress?.step_key === 'company_qualification';
  const checkedLabel = companyCheck && typeof progress.companies_checked === 'number' &&
    typeof progress.company_count === 'number'
    ? `${progress.companies_checked.toLocaleString('en-US')} of ${progress.company_count.toLocaleString('en-US')} companies checked`
    : null;
  const activity = complete
    ? 'Preparing the results for your base.'
    : stopped
      ? 'This step is no longer running.'
      : progress?.status === 'pending'
        ? 'Waiting to start. This page updates automatically.'
        : !active
          ? 'Waiting for a progress update. This page updates automatically.'
          : 'Work continues in the background. You can leave this page.';
  const lastActivity = age === null ? null : age < 60_000 ? 'just now'
    : age < 3_600_000 ? `${Math.floor(age / 60_000)} min ago`
      : `${Math.floor(age / 3_600_000)} hr ago`;
  return { title, stepLabel, percent, checkedLabel, activity, lastActivity, active, complete, stopped };
}

/** Real per-step progress, readable even when reduced motion stops the spinner. */
export function EngCollectionProgress({ progress }: { progress: CollectionProgress | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Keep the last signal honest even when subsequent project polls fail.
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const view = engCollectionProgressView(progress, now);
  const color = view.complete ? 'var(--cp-green)' : view.stopped ? 'var(--cp-red)' : 'var(--cp-amber)';
  return (
    <div className="flex flex-col gap-2">
      <div role="status" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-2" style={{ color }}>
          {view.active ? <EngSpinner className="h-3.5 w-3.5 shrink-0" />
            : view.complete ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
              : view.stopped ? <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                : <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span>{view.title}</span>
        </span>
        {view.stepLabel && <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>{view.stepLabel}</span>}
      </div>
      {view.percent !== null && (
        <div>
          <div
            role="progressbar"
            aria-label={`${view.title}: current step`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.percent}
            aria-valuetext={`${view.checkedLabel ?? `${view.percent}% of this step`}${view.active ? '' : ', last reported progress'}`}
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: 'var(--cp-divider)' }}
          >
            <div
              className="h-full origin-left rounded-full transition-transform duration-200 motion-reduce:transition-none"
              style={{ background: color, transform: `scaleX(${view.percent / 100})` }}
            />
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
            <span>{view.checkedLabel ?? `${view.percent}% of this step`}{view.active ? '' : ' (last reported)'}</span>
            {!view.checkedLabel && typeof progress?.company_count === 'number' && progress.company_count > 0 && (
              <span>{progress.company_count.toLocaleString('en-US')} companies in this batch</span>
            )}
          </div>
        </div>
      )}
      <div className="text-[11px]" style={{ color: 'var(--cp-text-m)' }}>{view.activity}</div>
      {view.lastActivity && !view.complete && !view.stopped && (
        <div className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
          Last activity {view.lastActivity}
        </div>
      )}
    </div>
  );
}
