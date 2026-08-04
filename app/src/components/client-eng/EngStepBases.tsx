'use client';

/**
 * Шаг 4 «Bases & Launch»: авто-сборка базы под вертикаль (лимит 2000/10000,
 * опциональный выбор гипотез) → прогресс сборки (фазы задач + счётчики
 * конструктора: найдено/валидных почт из collect_info.construct) → генерация
 * шаблона 85/15 (при analyzed) → пресет + «Launch (paused)» → launch_info.
 * Все действия — /api/client/eng/*, дедуп активных запусков на бэкенде.
 */

import { useEffect, useMemo, useState } from 'react';
import { Database, ExternalLink, Rocket, Wand2 } from 'lucide-react';
import type { HeHypothesis, HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import {
  buildEngTemplate,
  collectEngBase,
  fetchEngLaunchPresets,
  launchEngTemplate,
  type EngBaseSummary,
  type HeLaunchPresetOption,
} from './api-client';
import { EngBadge, EngCard, EngSpinner, baseStatusTone, fmtDate } from './ui';
import type { EngDetail } from './EngProjectWizard';

const COLLECT_LIMITS = [2000, 10000] as const;

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

/* ── Пресет + кнопка запуска готового шаблона ── */

function TemplateLaunchPanel({
  template,
  onChanged,
}: {
  template: HeTemplate;
  onChanged: () => void;
}) {
  const launch = parseLaunchInfo((template as { launch_info?: unknown }).launch_info);
  const [presets, setPresets] = useState<HeLaunchPresetOption[] | null>(null);
  const [presetId, setPresetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  // Зависим от стабильных примитивов: launch — пересчитанный объект каждого
  // рендера, в deps ему не место (иначе рефетч пресетов на каждый полл).
  const hasLaunch = launch !== null;
  useEffect(() => {
    if (hasLaunch) return; // уже запущен — селектор не нужен
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchEngLaunchPresets(template.id);
        if (cancelled) return;
        setPresets(list);
        if (list.length > 0) setPresetId(list[0].id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load presets');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [template.id, hasLaunch]);

  const onLaunch = async () => {
    if (busy || !presetId) return;
    setBusy(true);
    setError('');
    setWarnings([]);
    try {
      const res = await launchEngTemplate(template.id, { preset_id: presetId });
      if (res.ok) {
        setWarnings(res.warnings ?? []);
        onChanged();
      } else {
        setError(res.error ?? 'Launch failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  if (launch) {
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
        <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
          The campaign stays paused — the team reviews and starts it manually.
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg p-3 flex flex-col gap-2" style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}>
      {presets === null && !error ? (
        <span className="text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner className="h-3 w-3" /> Loading presets…
        </span>
      ) : presets && presets.length === 0 ? (
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          No sending preset configured yet — ask your manager to set one up.
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
            className="neu-pill px-3 py-1.5 text-xs bg-transparent outline-none"
            style={{ color: 'var(--cp-paper)' }}
            aria-label="Sending preset"
          >
            {(presets ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void onLaunch()}
            disabled={busy || !presetId}
            className="neu-pill active px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            style={{ color: 'var(--cp-paper)' }}
          >
            {busy ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
            Launch (paused)
          </button>
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          {w}
        </div>
      ))}
      {error && (
        <div className="text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}

/* ── Основной компонент шага ── */

export function EngStepBases({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const hypotheses = useMemo(() => (detail.hypotheses ?? []) as HeHypothesis[], [detail]);
  const bases = useMemo(() => (detail.bases ?? []) as EngBaseSummary[], [detail]);
  const templates = useMemo(() => (detail.templates ?? []) as HeTemplate[], [detail]);
  const jobs = useMemo(() => detail.jobs ?? [], [detail]);

  const [limit, setLimit] = useState<number>(2000);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busyCollect, setBusyCollect] = useState<string | null>(null);
  const [busyTemplate, setBusyTemplate] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Дефолт выбора гипотез — accepted (как у движка); подхватываем при смене
  // списка «правкой state при смене пропа во время рендера» (без эффекта).
  const [prevHypotheses, setPrevHypotheses] = useState(hypotheses);
  if (hypotheses !== prevHypotheses) {
    setPrevHypotheses(hypotheses);
    setChecked((prev) => {
      const next = { ...prev };
      for (const h of hypotheses) {
        if (!(h.id in next)) next[h.id] = h.status === 'accepted';
      }
      return next;
    });
  }

  const onCollect = async (verticalId: string, hypothesisIds: string[]) => {
    if (busyCollect) return;
    setBusyCollect(verticalId);
    setError('');
    try {
      await collectEngBase(verticalId, { limit, hypothesis_ids: hypothesisIds });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start base collection');
    } finally {
      setBusyCollect(null);
    }
  };

  const onBuildTemplate = async (baseId: string) => {
    if (busyTemplate) return;
    setBusyTemplate(baseId);
    setError('');
    try {
      await buildEngTemplate(baseId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start template generation');
    } finally {
      setBusyTemplate(null);
    }
  };

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
        const ownHypotheses = hypotheses.filter((h) => h.vertical_id === v.id);
        const selectedIds = ownHypotheses.filter((h) => checked[h.id]).map((h) => h.id);
        const collectDisabled =
          !!collecting || !!busyCollect || (ownHypotheses.length > 0 && selectedIds.length === 0);

        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
            </div>

            {/* Запуск авто-сборки */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="neu-pill px-3 py-1.5 text-xs bg-transparent outline-none ds-mono"
                style={{ color: 'var(--cp-paper)' }}
                aria-label="Row limit"
              >
                {COLLECT_LIMITS.map((l) => (
                  <option key={l} value={l}>
                    {l.toLocaleString('en-US')} rows
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void onCollect(v.id, selectedIds)}
                disabled={collectDisabled}
                className="neu-pill px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                style={{ color: 'var(--cp-paper)' }}
              >
                {busyCollect === v.id && <EngSpinner className="h-3 w-3" />}
                Collect base
              </button>
              {ownHypotheses.length > 0 && selectedIds.length === 0 && (
                <span className="text-[10px]" style={{ color: 'var(--cp-amber)' }}>
                  Select at least one hypothesis
                </span>
              )}
            </div>

            {/* Выбор гипотез под сборку */}
            {ownHypotheses.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {ownHypotheses.map((h) => (
                  <label key={h.id} className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
                    <input
                      type="checkbox"
                      checked={!!checked[h.id]}
                      onChange={(e) => setChecked((prev) => ({ ...prev, [h.id]: e.target.checked }))}
                    />
                    <span className="truncate max-w-[280px]">{h.title}</span>
                    {h.status !== 'accepted' && (
                      <span style={{ color: 'var(--cp-text-l)' }}>({h.status})</span>
                    )}
                  </label>
                ))}
              </div>
            )}

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

                  {b.status === 'analyzed' && !template && (
                    <button
                      type="button"
                      onClick={() => void onBuildTemplate(b.id)}
                      disabled={busyTemplate === b.id || templateJobActive}
                      className="neu-pill mt-2 px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                      style={{ color: 'var(--cp-paper)' }}
                    >
                      {busyTemplate === b.id || templateJobActive ? (
                        <EngSpinner className="h-3 w-3" />
                      ) : (
                        <Wand2 className="h-3 w-3" />
                      )}
                      {templateJobActive ? 'Building template…' : 'Build 85/15 template'}
                    </button>
                  )}

                  {template && (
                    <div className="mt-2">
                      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-text-m)' }}>
                        <EngBadge label={`template: ${template.status}`} tone={template.status === 'ready' ? 'green' : 'amber'} />
                        <span>{template.letters.length} letter{template.letters.length === 1 ? '' : 's'}</span>
                      </div>
                      {template.status === 'ready' && (
                        <TemplateLaunchPanel template={template} onChanged={onChanged} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {ownBases.length === 0 && !collecting && (
              <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
                No base yet — collect one to build the 85/15 template and launch.
              </p>
            )}
          </EngCard>
        );
      })}

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
