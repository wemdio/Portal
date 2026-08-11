'use client';

/**
 * Шаг 4 «Bases & Launch» — ВИТРИНА прогресса (без ручных кнопок): сборки,
 * конструктор и шаблоны гоняет автопилот («Start outreach», шаг 2), запуск —
 * единая кнопка на шаге 5 «Review & Launch». Здесь клиент видит живой прогресс
 * сборки (фазы задач + счётчики конструктора: найдено/валидных почт из
 * collect_info.construct), статусы баз (анализ: сегменты/углы) и кампании
 * после запуска (ссылки Instantly).
 */

import { useMemo } from 'react';
import { Database, ExternalLink } from 'lucide-react';
import type { HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import { type EngBaseSummary } from './api-client';
import { EngBadge, EngCard, EngSpinner, baseStatusTone, fmtDate } from './ui';
import type { EngDetail } from './EngProjectWizard';

/* ── Прогресс авто-сборки (collecting-база) ── */

function CollectProgress({ base }: { base: EngBaseSummary }) {
  const info = base.collect_info;
  const tasks = info?.tasks ?? [];
  const stats = info?.stats;
  const construct = info?.construct;
  return (
    <div
      className="rounded-lg p-3 mt-2 flex flex-col gap-1.5"
      style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
    >
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-amber)' }}>
        <EngSpinner className="h-3 w-3" />
        Collecting base{info?.limit ? ` (limit ${info.limit.toLocaleString('en-US')})` : ''}…
      </div>
      {tasks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {tasks.map((t, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
              <span style={{ color: t.status === 'done' ? 'var(--cp-green)' : t.status === 'failed' ? 'var(--cp-red)' : 'var(--cp-text-l)' }}>
                {t.status ?? 'pending'}
              </span>
              <span>{t.source ?? 'source'}</span>
              {typeof t.rows === 'number' && <span className="ml-auto">{t.rows.toLocaleString('en-US')} rows</span>}
            </li>
          ))}
        </ul>
      )}
      {stats && (
        <div className="text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
          {stats.tasks_done ?? 0}/{stats.tasks_total ?? 0} tasks · {(stats.rows_total ?? 0).toLocaleString('en-US')} rows
        </div>
      )}
      {construct && (
        <div className="text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
          {construct.status === 'dispatched' && (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
              <EngSpinner className="h-3 w-3" /> Finding &amp; validating emails…
            </span>
          )}
          {construct.status === 'done' && (
            <span className="ds-mono">
              Emails found: {(construct.emails_found ?? 0).toLocaleString('en-US')} · valid:{' '}
              {(construct.valid_count ?? 0).toLocaleString('en-US')}
            </span>
          )}
          {(construct.status === 'failed' || construct.status === 'cancelled') && (
            <span style={{ color: 'var(--cp-red)' }}>Email enrichment {construct.status}.</span>
          )}
          {construct.note && <span className="block text-[10px]" style={{ color: 'var(--cp-text-l)' }}>{construct.note}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Состояние запуска готового шаблона (только отображение; запуск — шаг 5) ── */

function TemplateLaunchStatus({ template }: { template: HeTemplate }) {
  const launch = parseLaunchInfo((template as { launch_info?: unknown }).launch_info);

  if (!launch) {
    return (
      <div className="mt-2 rounded-lg p-3 text-[11px]" style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)', color: 'var(--cp-text-m)' }}>
        {template.status === 'ready'
          ? 'Template is ready — launch it from step 5 «Review & Launch».'
          : 'Template is being built…'}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg p-3 text-xs flex flex-col gap-1" style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}>
      <div className="flex items-center gap-2">
        <EngBadge label="launched (paused)" tone="green" />
        <span className="font-semibold" style={{ color: 'var(--cp-paper)' }}>{launch.campaign_name}</span>
      </div>
      <div className="ds-mono" style={{ color: 'var(--cp-text-m)' }}>
        {launch.leads_count.toLocaleString('en-US')} contacts · {fmtDate(launch.created_at)}
      </div>
      {launch.campaign_url && (
        <a
          href={launch.campaign_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:underline"
          style={{ color: 'var(--cp-paper)' }}
        >
          Open the campaign <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {Array.isArray(launch.campaigns) && launch.campaigns.length > 1 ? (
        <div className="flex flex-col gap-1 mt-1">
          <span className="text-[10px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
            Segment campaigns ({launch.campaigns.length})
          </span>
          {launch.campaigns.map((c) => (
            <a
              key={`${c.campaign_url}-${c.segment ?? 'main'}`}
              href={c.campaign_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              {c.segment ?? 'Default texts'} <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      ) : null}
      <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
        The campaign stays paused — the team reviews and starts it manually.
      </span>
    </div>
  );
}

/* ── Основной компонент шага ── */

export function EngStepBases({ detail }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const bases = useMemo(() => (detail.bases ?? []) as EngBaseSummary[], [detail]);
  const templates = useMemo(() => (detail.templates ?? []) as HeTemplate[], [detail]);
  const jobs = useMemo(() => detail.jobs ?? [], [detail]);

  if (verticals.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          No verticals yet — finish the research and review verticals on step 2 first.
        </p>
      </EngCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {verticals.map((v) => {
        const ownBases = bases.filter((b) => b.vertical_id === v.id);
        const collecting = ownBases.find((b) => b.status === 'collecting');

        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
            </div>

            {/* Прогресс идущей сборки */}
            {collecting && <CollectProgress base={collecting} />}

            {/* Готовые/падавшие базы вертикали */}
            {ownBases.filter((b) => b.status !== 'collecting').map((b) => {
              const template = templates.find((t) => t.base_id === b.id);
              const templateJobActive = jobs.some(
                (j) =>
                  j.stage === 'template' &&
                  (j.status === 'pending' || j.status === 'running') &&
                  (j.payload as { base_id?: string } | null)?.base_id === b.id,
              );
              return (
                <div
                  key={b.id}
                  className="mt-2 rounded-lg p-3"
                  style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
                      {b.filename}
                    </span>
                    <EngBadge label={b.status} tone={baseStatusTone(b.status)} />
                    <span className="ml-auto ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
                      {b.row_count.toLocaleString('en-US')} rows
                    </span>
                  </div>

                  {b.status === 'analyzing' && (
                    <div className="mt-2 text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
                      <EngSpinner className="h-3 w-3" /> Analyzing the base…
                    </div>
                  )}

                  {b.status === 'analyzed' && b.analysis && (
                    <div className="mt-2 text-[11px] flex flex-col gap-1" style={{ color: 'var(--cp-text-m)' }}>
                      {b.analysis.notable_segments.length > 0 && (
                        <div>Segments: {b.analysis.notable_segments.join(' · ')}</div>
                      )}
                      {b.analysis.recommended_angles.length > 0 && (
                        <div>Angles: {b.analysis.recommended_angles.join(' · ')}</div>
                      )}
                    </div>
                  )}

                  {templateJobActive && (
                    <div className="mt-2 text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
                      <EngSpinner className="h-3 w-3" /> Building template…
                    </div>
                  )}

                  {template && (
                    <div className="mt-2">
                      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-text-m)' }}>
                        <EngBadge label={`template: ${template.status}`} tone={template.status === 'ready' ? 'green' : 'amber'} />
                        <span>{template.letters.length} letter{template.letters.length === 1 ? '' : 's'}</span>
                      </div>
                      <TemplateLaunchStatus template={template} />
                    </div>
                  )}
                </div>
              );
            })}

            {ownBases.length === 0 && !collecting && (
              <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
                No base yet — the autopilot collects one after «Start outreach» on step 2.
              </p>
            )}
          </EngCard>
        );
      })}
    </div>
  );
}
