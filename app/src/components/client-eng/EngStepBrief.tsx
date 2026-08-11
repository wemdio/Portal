'use client';

/**
 * Шаг 1 «Brief» клиентского ENG-кабинета: карточки site_profile (что движок
 * понял с сайта), редактируемые offer/style/signature overrides (уточняют
 * генерацию писем) и «Re-run research» с дедупом на бэкенде.
 */

import { useMemo, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { patchEngProject, startEngResearch, type HeJobSummary } from './api-client';
import { EngBadge, EngCard, EngEyebrow, EngSpinner } from './ui';
import type { EngDetail } from './EngProjectWizard';

const RESEARCH_STAGES = ['site_profile', 'competitors', 'brand_cloud', 'hypotheses', 'evidence', 'clustering'];

/** Подписи полей site_profile (EN) в порядке показа. */
const PROFILE_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'company_name', label: 'Company' },
  { key: 'product_summary', label: 'Product' },
  { key: 'usp', label: 'USP' },
  { key: 'target_audience', label: 'Target audience' },
  { key: 'business_model', label: 'Business model' },
  { key: 'price_tier', label: 'Price tier' },
  { key: 'deal_cycle', label: 'Deal cycle' },
  { key: 'geo', label: 'Geo' },
  { key: 'current_clients', label: 'Current clients' },
  { key: 'cases', label: 'Cases' },
];

function isResearchActive(jobs: HeJobSummary[]): boolean {
  return jobs.some(
    (j) => RESEARCH_STAGES.includes(j.stage) && (j.status === 'pending' || j.status === 'running'),
  );
}

/** Значение поля site_profile → строка (массивы — списком через точку с запятой). */
function profileValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('; ');
  }
  if (typeof value === 'string') return value;
  return '';
}

export function EngStepBrief({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const { project, jobs = [] } = detail;
  const brief = (project.brief ?? {}) as Record<string, unknown>;
  const siteProfile = (brief.site_profile ?? null) as Record<string, unknown> | null;

  const [offer, setOffer] = useState('');
  const [style, setStyle] = useState('');
  const [signature, setSignature] = useState('');
  const [business, setBusiness] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [researchBusy, setResearchBusy] = useState(false);
  const [error, setError] = useState('');

  // Перечитываем overrides из деталки (первый рендер и после поллов) —
  // React-паттерн «правка state при смене пропа во время рендера», как в
  // client/layout (prevActiveId), без set-state-in-effect.
  const [prevUpdatedAt, setPrevUpdatedAt] = useState(project.updated_at);
  if (project.updated_at !== prevUpdatedAt) {
    setPrevUpdatedAt(project.updated_at);
    setOffer(typeof brief.offer_override === 'string' ? brief.offer_override : '');
    setStyle(typeof brief.style_override === 'string' ? brief.style_override : '');
    setSignature(typeof brief.signature_override === 'string' ? brief.signature_override : '');
    setBusiness(typeof brief.business_override === 'string' ? brief.business_override : '');
  }

  const researchActive = useMemo(() => isResearchActive(jobs), [jobs]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await patchEngProject(project.id, {
        offer_override: offer,
        style_override: style,
        signature_override: signature,
        business_override: business,
      });
      setSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const onResearch = async () => {
    if (researchBusy || researchActive) return;
    setResearchBusy(true);
    setError('');
    try {
      await startEngResearch(project.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start research');
    } finally {
      setResearchBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <EngCard>
        <div className="flex items-center gap-2">
          <EngEyebrow>Site profile</EngEyebrow>
          <span className="mb-2">
            {researchActive ? (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
                <EngSpinner className="h-3 w-3" /> research in progress…
              </span>
            ) : (
              <EngBadge label={project.status} tone={project.status === 'researched' ? 'green' : 'neutral'} />
            )}
          </span>
          <button
            type="button"
            onClick={() => void onResearch()}
            disabled={researchBusy || researchActive}
            className="ds-btn-ghost ml-auto mb-2 inline-flex items-center gap-1.5 text-[11px]"
          >
            {researchBusy ? <EngSpinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
            Re-run research
          </button>
        </div>

        {siteProfile ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {PROFILE_FIELDS.map(({ key, label }) => {
              const value = profileValue(siteProfile[key]);
              if (!value) return null;
              return (
                <div
                  key={key}
                  className="rounded-md p-3"
                  style={{ border: '1px solid var(--cp-divider)' }}
                >
                  <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--cp-text-l)' }}>
                    {label}
                  </dt>
                  <dd className="mt-1 text-sm whitespace-pre-wrap" style={{ color: 'var(--cp-paper)' }}>
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {researchActive
              ? 'Profiling the site — the brief will appear here as soon as the research finishes.'
              : 'No site profile yet. Run the research to build it from your website.'}
          </p>
        )}
      </EngCard>

      <EngCard>
        <EngEyebrow>Offer &amp; style overrides</EngEyebrow>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          These notes steer letter generation. Leave empty to use what the research inferred.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: brief.site_thin === true ? 'var(--cp-amber)' : 'var(--cp-text-m)' }}>
              Business description (manual, max 3000 chars)
              {brief.site_thin === true ? ' — recommended: your site gave us very little to read' : ''}
            </span>
            <textarea
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder="What you sell, to whom, and why clients pick you. Used above the site profile when the site is thin or JS-heavy."
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Offer override
            </span>
            <textarea
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              rows={2}
              placeholder="e.g. 4–6 qualified meetings per month with US clinic owners, pay-per-meeting"
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Style reference (1–2 “perfect” emails to imitate)
            </span>
            <textarea
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              rows={4}
              placeholder="Paste an email whose tone the generator should copy"
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Sender signature (used verbatim at the end of every letter)
            </span>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={2}
              placeholder="Jane Doe, Acme, acme.com"
              className="ds-input w-full resize-y"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
            >
              {saving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
              Save overrides
            </button>
            {savedAt > 0 && !saving && (
              <span className="text-[11px]" style={{ color: 'var(--cp-green)' }}>
                Saved
              </span>
            )}
          </div>
        </div>
      </EngCard>

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
