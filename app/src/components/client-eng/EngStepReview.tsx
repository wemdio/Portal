'use client';

/**
 * Шаг 5 «Review & Launch»: единое окно приёмки автопилота. По каждой вертикали
 * с готовой цепочкой/базой — письма цепочки (просмотр + инлайн-правка через
 * ChainEditor шага Letters, PATCH /eng/chains/[id]), ленивое превью базы
 * (GET /eng/bases/[id]/rows, первые 100 строк, компактные колонки) и статус
 * шаблона. Вверху — общий селектор пресета и «Launch all (paused)»:
 * последовательный запуск всех ready-шаблонов без launch_info с прогрессом
 * i/N; ошибка одного шаблона показывается и не останавливает остальные.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Eye, Rocket } from 'lucide-react';
import type { HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import {
  fetchEngBaseRows,
  fetchEngLaunchPresets,
  launchEngTemplate,
  type EngBaseSummary,
  type HeChainDto,
  type HeLaunchPresetOption,
  type HeJobSummary,
} from './api-client';
import { EngBadge, EngCard, EngSpinner, baseStatusTone } from './ui';
import { ChainEditor } from './EngStepLetters';
import type { EngDetail } from './EngProjectWizard';

/** Компактные колонки превью; остальные поля строки — в title строки таблицы. */
const PREVIEW_COLUMNS = ['company', 'website', 'email'] as const;
const PREVIEW_LIMIT = 100;

/* ── Ленивое превью базы (по кнопке) ── */

function BasePreview({ base }: { base: EngBaseSummary }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; total: number } | null>(null);

  const onToggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (preview || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchEngBaseRows(base.id, { limit: PREVIEW_LIMIT });
      setPreview({ rows: res.rows ?? [], total: res.total ?? 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the preview');
    } finally {
      setLoading(false);
    }
  };

  // Только компактные колонки, реально присутствующие в базе; email-статус —
  // служебное поле строки (_email_status), в columns его нет.
  const columns = (base.columns ?? []).filter((c) => (PREVIEW_COLUMNS as readonly string[]).includes(c));

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void onToggle()}
        className="neu-pill px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5"
        style={{ color: 'var(--cp-paper)' }}
      >
        {loading ? <EngSpinner className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {open ? 'Hide preview' : 'Preview base'}
      </button>
      {error && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
      {open && preview && (
        <div
          className="mt-2 overflow-x-auto rounded-lg"
          style={{ border: '1px solid var(--cp-divider)', background: 'var(--cp-surface-rest)' }}
        >
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left" style={{ color: 'var(--cp-text-l)' }}>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-semibold">
                    {c}
                  </th>
                ))}
                <th className="px-3 py-2 font-semibold">email status</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} title={JSON.stringify(row)} style={{ borderTop: '1px solid var(--cp-divider)' }}>
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-1.5 truncate max-w-[220px]" style={{ color: 'var(--cp-paper)' }}>
                      {typeof row[c] === 'string' || typeof row[c] === 'number' ? String(row[c]) : ''}
                    </td>
                  ))}
                  <td
                    className="px-3 py-1.5 ds-mono"
                    style={{
                      color:
                        row._email_status === 'ok'
                          ? 'var(--cp-green)'
                          : row._email_status
                            ? 'var(--cp-amber)'
                            : 'var(--cp-text-l)',
                    }}
                  >
                    {typeof row._email_status === 'string' ? row._email_status : ''}
                  </td>
                </tr>
              ))}
              {preview.rows.length === 0 && (
                <tr style={{ borderTop: '1px solid var(--cp-divider)' }}>
                  <td className="px-3 py-2" colSpan={columns.length + 1} style={{ color: 'var(--cp-text-l)' }}>
                    No rows in the base yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[10px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
            Showing {preview.rows.length} of {preview.total.toLocaleString('en-US')} rows
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Карточка вертикали ── */

function VerticalReviewCard({
  vertical,
  chain,
  base,
  template,
  templateBusy,
  onChanged,
}: {
  vertical: HeVertical;
  chain: HeChainDto | undefined;
  base: EngBaseSummary | undefined;
  template: HeTemplate | undefined;
  templateBusy: boolean;
  onChanged: () => void;
}) {
  const launch = template ? parseLaunchInfo((template as { launch_info?: unknown }).launch_info) : null;
  return (
    <EngCard>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          {vertical.name}
        </h4>
        {template && <EngBadge label={`template: ${template.status}`} tone={template.status === 'ready' ? 'green' : 'amber'} />}
        {launch && <EngBadge label="launched (paused)" tone="green" />}
        {!template && templateBusy && (
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
            <EngSpinner className="h-3 w-3" /> building template…
          </span>
        )}
        {!template && !templateBusy && (
          <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            no template yet
          </span>
        )}
      </div>

      {chain ? (
        <ChainEditor chain={chain} onSaved={onChanged} />
      ) : (
        <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
          No ready letters for this vertical yet.
        </p>
      )}

      {base && (
        <div
          className="mt-3 rounded-lg p-3"
          style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
              {base.filename}
            </span>
            <EngBadge label={base.status} tone={baseStatusTone(base.status)} />
            <span className="ml-auto ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
              {base.row_count.toLocaleString('en-US')} rows
            </span>
          </div>
          {(base.status === 'analyzed' || base.status === 'analyzing') && <BasePreview base={base} />}
        </div>
      )}
    </EngCard>
  );
}

/* ── Панель запуска всех готовых шаблонов ── */

function LaunchAllPanel({
  launchable,
  onChanged,
}: {
  launchable: HeTemplate[];
  onChanged: () => void;
}) {
  const [presets, setPresets] = useState<HeLaunchPresetOption[] | null>(null);
  const [presetId, setPresetId] = useState('');
  const [presetsError, setPresetsError] = useState('');
  const [state, setState] = useState<{ running: boolean; done: number; total: number; errors: string[] }>({
    running: false,
    done: 0,
    total: 0,
    errors: [],
  });

  // Пресеты — per-client (GET launch их не привязывает к шаблону), грузим по
  // первому ready-шаблону. Зависим от стабильного id, а не от массива.
  const firstTemplateId = launchable[0]?.id;
  useEffect(() => {
    if (!firstTemplateId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchEngLaunchPresets(firstTemplateId);
        if (cancelled) return;
        setPresets(list);
        setPresetId((prev) => prev || (list[0]?.id ?? ''));
      } catch (e) {
        if (!cancelled) setPresetsError(e instanceof Error ? e.message : 'Failed to load presets');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firstTemplateId]);

  const onLaunchAll = async () => {
    if (state.running || !presetId || launchable.length === 0) return;
    const errors: string[] = [];
    setState({ running: true, done: 0, total: launchable.length, errors: [] });
    // Последовательно: параллельный запуск уронил бы лимиты Instantly и
    // перемешал бы launch_info опросов.
    for (let i = 0; i < launchable.length; i++) {
      const tpl = launchable[i];
      try {
        const res = await launchEngTemplate(tpl.id, { preset_id: presetId });
        if (!res.ok) errors.push(res.error ?? `Template ${i + 1}: launch failed`);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `Template ${i + 1}: launch failed`);
      }
      setState({ running: true, done: i + 1, total: launchable.length, errors: [...errors] });
    }
    setState({ running: false, done: launchable.length, total: launchable.length, errors });
    onChanged();
  };

  return (
    <EngCard>
      <div className="flex flex-wrap items-center gap-2">
        {presets === null && !presetsError ? (
          <span className="text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-text-m)' }}>
            <EngSpinner className="h-3 w-3" /> Loading presets…
          </span>
        ) : presets && presets.length === 0 ? (
          <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            No sending preset configured yet — ask your manager to set one up.
          </span>
        ) : (
          <>
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
              onClick={() => void onLaunchAll()}
              disabled={state.running || !presetId}
              className="neu-pill active px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              style={{ color: 'var(--cp-paper)' }}
            >
              {state.running ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
              Launch all (paused)
            </button>
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              {launchable.length} template{launchable.length === 1 ? '' : 's'} ready — campaigns stay paused for review
            </span>
          </>
        )}
      </div>
      {state.total > 0 && (
        <div className="mt-2 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
          Launched {state.done}/{state.total}
        </div>
      )}
      {state.errors.map((err, i) => (
        <div key={i} className="mt-1 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {err}
        </div>
      ))}
      {presetsError && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {presetsError}
        </div>
      )}
    </EngCard>
  );
}

/* ── Основной компонент шага ── */

export function EngStepReview({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const chains = useMemo(() => (detail.chains ?? []) as HeChainDto[], [detail]);
  const bases = useMemo(() => (detail.bases ?? []) as EngBaseSummary[], [detail]);
  const templates = useMemo(() => (detail.templates ?? []) as HeTemplate[], [detail]);
  const jobs = useMemo(() => (detail.jobs ?? []) as HeJobSummary[], [detail]);

  // Карточка имеет смысл, только когда есть что ревьюить: готовая цепочка,
  // база или шаблон вертикали.
  const cards = verticals
    .map((vertical) => ({
      vertical,
      chain: chains.find((c) => c.vertical_id === vertical.id && c.status === 'ready'),
      base: bases.find((b) => b.vertical_id === vertical.id),
      template: templates.find((t) => t.vertical_id === vertical.id),
    }))
    .filter((c) => c.chain || c.base || c.template);

  // К запуску готовы ready-шаблоны без launch_info (уже запущенные — только бейдж).
  const launchable = templates.filter(
    (t) => t.status === 'ready' && !parseLaunchInfo((t as { launch_info?: unknown }).launch_info),
  );

  if (cards.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Autopilot is still working — letters, bases and templates will appear here once they are ready.
        </p>
        <Link
          href={'/client/eng/dashboard' as Route}
          prefetch={false}
          className="mt-2 inline-flex items-center gap-1.5 text-xs hover:underline"
          style={{ color: 'var(--cp-paper)' }}
        >
          See Command Center
        </Link>
      </EngCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {launchable.length > 0 && <LaunchAllPanel launchable={launchable} onChanged={onChanged} />}

      {cards.map(({ vertical, chain, base, template }) => {
        const templateBusy = jobs.some(
          (j) =>
            j.stage === 'template' &&
            (j.status === 'pending' || j.status === 'running') &&
            (j.payload as { base_id?: string } | null)?.base_id === base?.id,
        );
        return (
          <VerticalReviewCard
            key={vertical.id}
            vertical={vertical}
            chain={chain}
            base={base}
            template={template}
            templateBusy={templateBusy}
            onChanged={onChanged}
          />
        );
      })}
    </div>
  );
}
