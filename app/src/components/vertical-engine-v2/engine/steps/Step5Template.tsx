'use client';

/**
 * Шаг 5 мастера «Движка вертикалей» — «Шаблон»: финальный боевой шаблон 85/15
 * под загруженную базу: письма с подсвеченными {{operators}}, сегментные
 * варианты, маппинг операторов, фиксированный блок и экспорт (копирование /
 * скачивание JSON). Поглощает старый TemplateView.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { ChevronRight, Copy, Download, Rocket, Sparkles } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { downloadBaseCsvResponse } from '@/lib/verticalEngineV2/baseCsv';
import type { VeRuSeasonalityPrioritySnapshot, VeRuSeasonalityState, VeTemplate } from '@/lib/verticalEngineV2/types';
import { renderTemplatePreview, type VePreviewToken } from '@/lib/verticalEngineV2/renderPreview';
import {
  VE_LAUNCH_MAX_LEADS,
  parseLaunchInfo,
  type VeLaunchPresetOption,
  type VeMailboxTagOption,
  type VeTemplateLaunchInfo,
} from '@/lib/verticalEngineV2/launchHandoff';
import {
  VE_API,
  veEngineCall,
  veEnginePost,
  vePreviewDeliveryPlan,
  type VeBaseSummary,
  type VeDeliveryPlanPreviewDto,
  type VeJobSummary,
  type VePortalProjectOptionDto,
} from '../api';
import { HE, StatusDot } from '../design';
import type { LaunchPortfolioResponse } from '../LaunchPortfolioView';
import { SeasonalityStatus } from '../SeasonalitySummary';
import { Badge, OperatorText, StatusBox, formatDate } from '../ui';
import {
  SegmentationAuditPanel,
  useSegmentationAudit,
  type SegmentationAuditController,
} from './SegmentationAuditPanel';

const TH_CLASS =
  'border-b border-gray-200 py-2 pr-3 text-left font-mono text-[11px] font-medium tracking-[0.02em] text-gray-500';

function templateToText(t: VeTemplate): string {
  const parts: string[] = [`ФИКСИРОВАННЫЙ БЛОК (85%):\n${t.fixed_block}`];
  t.letters.forEach((letter, idx) => {
    const wait = letter.wait_days > 0 ? ` (через ${letter.wait_days} дн.)` : '';
    parts.push(`\n--- ПИСЬМО ${idx + 1}${wait} ---\nТема: ${letter.subject ?? ''}\n\n${letter.body}`);
    (letter.segment_variants ?? []).forEach((v) => {
      parts.push(`\n[Вариант для сегмента: ${v.when}]\n${v.text}`);
    });
  });
  return parts.join('\n');
}

/** Последняя джоба стадии (по started_at; записи без started_at считаются старыми). */
function latestStageJob(jobs: VeJobSummary[], stage: VeJobSummary['stage']): VeJobSummary | undefined {
  let best: VeJobSummary | undefined;
  for (const job of jobs) {
    if (job.stage !== stage) continue;
    if (!best || (job.started_at ?? '') >= (best.started_at ?? '')) best = job;
  }
  return best;
}

/** Ответ GET bases/[id]/template — шаблон + лёгкие строки базы для превью. */
interface VeTemplateGetResponse {
  template?: VeTemplate;
  columns?: string[];
  sample_rows?: Array<Record<string, unknown>>;
  /** Сегмент каждой sample-строки (when дословно) по индексу; null — дефолт/сбой. */
  sample_segments?: Array<string | null> | null;
  error?: string;
}

/** Дедуп имён операторов по lowercase-ключу, сохраняет первое написание. */
function dedupOperatorNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Подсветка превью: подставленные значения — янтарные (зеркально OperatorText,
 * где янтарным был сам {{operator}}), запасной текст unmatched-операторов —
 * фиолетовый, неразрешённые операторы — красные.
 */
function PreviewTokens({
  tokens,
  className,
  plainText,
}: {
  tokens: VePreviewToken[];
  className?: string;
  /** Цельная фраза для screen reader; визуальные токены остаются подсвеченными. */
  plainText?: string;
}) {
  const tokenNodes = tokens.map((t, i) =>
    t.kind === 'value' ? (
      <mark key={i} className="ve2-op">
        {t.text}
      </mark>
    ) : t.kind === 'fallback' ? (
      <mark key={i} title="Запасной текст: колонки нет" className="ve2-op ve2-op-fb">
        {t.text}
      </mark>
    ) : t.kind === 'unresolved' ? (
      <mark key={i} className="ve2-op ve2-t-dan">
        {t.text}
      </mark>
    ) : (
      <span key={i}>{t.text}</span>
    ),
  );

  return (
    <span className={className}>
      {plainText === undefined ? tokenNodes : <span className="sr-only">{plainText}</span>}
      {plainText === undefined ? null : <span aria-hidden="true">{tokenNodes}</span>}
    </span>
  );
}

/**
 * «Превью по лидам»: финальные письма глазами конкретных лидов из базы.
 * Строки базы лениво подгружаются при первом раскрытии; рендер — чистый,
 * через renderTemplatePreview (сегментные варианты применяются по sample_segments).
 */
function TemplateLeadPreview({ template, baseId }: { template: VeTemplate; baseId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sample, setSample] = useState<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
    segments: Array<string | null> | null;
  } | null>(null);

  const mapping = useMemo(() => template.personalization_plan?.operator_mapping ?? [], [template]);

  const handleToggle = (open: boolean) => {
    if (!open || (state !== 'idle' && state !== 'error')) return;
    setState('loading');
    veEngineCall<VeTemplateGetResponse>(`${VE_API}/bases/${baseId}/template`)
      .then(({ ok, data }) => {
        if (!ok) {
          setState('error');
          return;
        }
        setSample({
          columns: data.columns ?? [],
          rows: data.sample_rows ?? [],
          segments: data.sample_segments ?? null,
        });
        setState('ready');
      })
      .catch(() => setState('error'));
  };

  const preview = useMemo(() => {
    if (state !== 'ready' || !sample) return null;
    return renderTemplatePreview({
      letters: template.letters,
      operatorMapping: mapping,
      rows: sample.rows,
      columns: sample.columns,
      maxRows: 3,
      rowSegments: sample.segments ?? undefined,
    });
  }, [state, sample, template, mapping]);

  const hasVariants = template.letters.some((l) => (l.segment_variants ?? []).length > 0);
  const segmentsClassified = hasVariants && (sample?.segments ?? null) !== null;

  return (
    <details className="ve2-panel-line" onToggle={(e) => handleToggle(e.currentTarget.open)}>
      <summary className={`${HE.btnQuiet} min-h-11 w-full cursor-pointer select-none px-5 py-3`}>
        Превью по лидам: письма глазами конкретных лидов из базы
        <Badge tone="amber">новое</Badge>
      </summary>
      <div className="border-t border-gray-100 px-5 py-3">
        {state === 'loading' || state === 'idle' ? (
          <p className="text-xs text-gray-500">Загружаем строки базы…</p>
        ) : null}
        {state === 'error' ? (
          <p className="text-xs text-gray-500">
            Не удалось загрузить строки базы. Закройте и откройте блок, чтобы повторить.
          </p>
        ) : null}
        {preview && preview.rows.length === 0 ? (
          <p className="text-xs text-gray-500">В базе нет строк для превью.</p>
        ) : null}
        {preview && preview.rows.length > 0 && sample ? (
          <div>
            <ol className="ve2-letter-sheet">
              {preview.rows.map((leadRow, leadIdx) => {
                const unresolved = dedupOperatorNames(leadRow.letters.flatMap((l) => l.unresolved));
                const emptyVars = dedupOperatorNames(leadRow.letters.flatMap((l) => l.emptyVars));
                return (
                  <li key={leadIdx} className="ve2-letter">
                    <p className="ve2-eb">{leadRow.rowLabel}</p>
                    <div className="mt-2">
                      {leadRow.letters.map((letter, letterIdx) => (
                        <div
                          key={letterIdx}
                          className={letterIdx > 0 ? 'mt-3 border-t border-gray-100 pt-3' : undefined}
                        >
                          <p className="text-xs font-semibold text-gray-800">
                            Письмо {letterIdx + 1}
                            {letter.wait_days > 0 ? (
                              <span className="ml-1 font-normal text-gray-500">через {letter.wait_days} дн.</span>
                            ) : null}
                            {letter.subject ? (
                              <>
                                {': '}
                                <PreviewTokens tokens={letter.subjectTokens} />
                              </>
                            ) : null}
                          </p>
                          <PreviewTokens
                            tokens={letter.bodyTokens}
                            plainText={letter.body}
                            className="mt-1 block whitespace-pre-wrap text-xs leading-relaxed text-gray-600"
                          />
                        </div>
                      ))}
                    </div>
                    {unresolved.length > 0 ? (
                      <p className="mt-2 text-[11px] text-red-500">
                        Не подставлено: {unresolved.map((u) => `{{${u}}}`).join(', ')}
                      </p>
                    ) : null}
                    {emptyVars.length > 0 ? (
                      <p className="mt-1 text-[11px] text-gray-500">
                        Пустые значения у этого лида: {emptyVars.map((u) => `{{${u}}}`).join(', ')}. В письме будет
                        пустая строка.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {hasVariants ? (
              <p className="text-[11px] text-gray-500">
                {segmentsClassified
                  ? 'Сегментные варианты показаны по выборочной классификации превью. Финальную раскладку подтвердите в аудите перед запуском.'
                  : 'Выборочная классификация недоступна — показан основной текст. Финальную раскладку подтвердите в аудите перед запуском.'}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/* ── «Отправить в запуск»: PAUSED-кампания в Instantly из готового шаблона ── */

interface VeLaunchPresetsResponse {
  presets?: VeLaunchPresetOption[];
  bound_preset_id?: string | null;
  can_create_client?: boolean;
  mailbox_tag_options?: VeMailboxTagOption[];
  /** Additive delivery contract. Missing fields keep the form readable but block a new launch. */
  portal_projects?: VePortalProjectOptionDto[];
  /** Present when this VE-project is already immutably bound to a Portal period. */
  delivery_plan?: VeDeliveryPlanPreviewDto | null;
  error?: string;
}

interface VeLaunchClientResponse {
  ok?: boolean;
  client?: { id: string; email: string };
  preset?: VeLaunchPresetOption;
  error?: string;
  code?: string;
}

interface VeLaunchResponse {
  ok?: boolean;
  launch?: VeTemplateLaunchInfo;
  warnings?: string[];
  error?: string;
  code?: string;
}

type DeliveryPreviewState = 'idle' | 'loading' | 'ready' | 'error';

function parseExactTarget(value: string): number | null {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidDeliveryPreview(value: VeDeliveryPlanPreviewDto | null): value is VeDeliveryPlanPreviewDto {
  if (!value || !value.portal_project_id || !value.portal_period_id || !value.deadline) return false;
  return [
    value.contacts_done_count,
    value.target_contacts,
    value.remaining,
    value.remaining_workdays,
    value.required_daily,
    value.effective_daily,
    value.ready_remaining,
    value.sender_capacity,
    value.supply_deficit,
    value.capacity_deficit,
  ].every(isNonNegativeInteger) && value.target_contacts > 0;
}

function portalProjectFromBoundPlan(plan: VeDeliveryPlanPreviewDto): VePortalProjectOptionDto {
  return {
    id: plan.portal_project_id,
    name: plan.portal_project_name?.trim() || 'Проект Portal',
    active_period: {
      id: plan.portal_period_id,
      label: plan.portal_period_label,
      deadline: plan.deadline,
      contacts_done_count: plan.contacts_done_count,
    },
  };
}

/**
 * Состояние запуска шаблона. Пока в launch_info шаблона есть запись — вместо
 * формы показываем её (один запуск на шаблон; повторный force — только через API).
 */
function useTemplateLaunch(
  template: VeTemplate | null,
  segmentationAuditId: string | null,
  onSegmentationRejected: (phase: 'stale' | 'incomplete' | 'refresh') => void,
) {
  const templateLaunch = parseLaunchInfo((template as { launch_info?: unknown } | null)?.launch_info);
  const reconciliationRequired = templateLaunch?.reconciliation_required === true;
  const [recorded, setRecorded] = useState<VeTemplateLaunchInfo | null>(() =>
    reconciliationRequired ? null : templateLaunch,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [presets, setPresets] = useState<VeLaunchPresetOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [boundPresetId, setBoundPresetId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState('');
  const [canCreateClient, setCanCreateClient] = useState(false);
  const [mailboxTagOptions, setMailboxTagOptions] = useState<VeMailboxTagOption[]>([]);
  const [portalProjects, setPortalProjects] = useState<VePortalProjectOptionDto[] | null>(null);
  const [portalProjectId, setPortalProjectId] = useState('');
  const [targetContactsInput, setTargetContactsInput] = useState('');
  const [deliveryPlanLocked, setDeliveryPlanLocked] = useState(false);
  const [deliveryPreview, setDeliveryPreview] = useState<VeDeliveryPlanPreviewDto | null>(null);
  const [deliveryPreviewState, setDeliveryPreviewState] = useState<DeliveryPreviewState>('idle');
  const [deliveryPreviewError, setDeliveryPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const selectedPortalProject = portalProjects?.find((project) => project.id === portalProjectId) ?? null;
  const activePortalPeriod = selectedPortalProject?.active_period ?? null;
  const targetContacts = parseExactTarget(targetContactsInput);
  const activePeriodIssue = !selectedPortalProject
    ? null
    : !activePortalPeriod
      ? 'У проекта нет активного периода.'
      : !activePortalPeriod.deadline
        ? 'В активном периоде не задан дедлайн.'
        : !isNonNegativeInteger(activePortalPeriod.contacts_done_count)
          ? 'В активном периоде нет числового факта первых контактов.'
          : null;

  const clearDeliveryPreview = useCallback(() => {
    setDeliveryPreview(null);
    setDeliveryPreviewState('idle');
    setDeliveryPreviewError(null);
  }, []);

  const openForm = useCallback(() => {
    if (!template) return;
    setFormOpen(true);
    setSubmitError(null);
    if (presets !== null) return;
    void Promise.resolve(veEngineCall<VeLaunchPresetsResponse>(`${VE_API}/templates/${template.id}/launch`))
      .then((response) => {
        if (!response?.ok) {
          setLoadError(response?.data?.error ?? 'Не удалось загрузить пресеты');
          setPresets([]);
          setBoundPresetId(null);
          setCanCreateClient(false);
          setMailboxTagOptions([]);
          setPortalProjects(null);
          setDeliveryPreview(null);
          setDeliveryPreviewState('error');
          setDeliveryPreviewError('Не удалось загрузить проекты Portal и план выполнения.');
          return;
        }
        const list = response.data.presets ?? [];
        setPresets(list);
        setCanCreateClient(response.data.can_create_client === true);
        setMailboxTagOptions(response.data.mailbox_tag_options ?? []);

        const boundDeliveryPlan = response.data.delivery_plan ?? null;
        const deliveryContractAvailable =
          response.data.portal_projects !== undefined || response.data.delivery_plan !== undefined;
        if (deliveryContractAvailable) {
          const projects = [...(response.data.portal_projects ?? [])];
          if (boundDeliveryPlan && !projects.some((project) => project.id === boundDeliveryPlan.portal_project_id)) {
            projects.push(portalProjectFromBoundPlan(boundDeliveryPlan));
          }
          setPortalProjects(projects);
          setPortalProjectId(boundDeliveryPlan?.portal_project_id ?? '');
          setTargetContactsInput(boundDeliveryPlan ? String(boundDeliveryPlan.target_contacts) : '');
          setDeliveryPlanLocked(Boolean(boundDeliveryPlan));
          const validBoundDeliveryPlan = isValidDeliveryPreview(boundDeliveryPlan) ? boundDeliveryPlan : null;
          setDeliveryPreview(validBoundDeliveryPlan);
          setDeliveryPreviewState(validBoundDeliveryPlan ? 'ready' : 'idle');
          setDeliveryPreviewError(null);
        } else {
          setPortalProjects(null);
          setPortalProjectId('');
          setTargetContactsInput('');
          setDeliveryPlanLocked(false);
          setDeliveryPreview(null);
          setDeliveryPreviewState('error');
          setDeliveryPreviewError('Сервер пока не вернул контракт плана выполнения.');
        }

        const responseBoundPresetId =
          typeof response.data.bound_preset_id === 'string' && response.data.bound_preset_id.trim()
            ? response.data.bound_preset_id
            : null;
        setBoundPresetId(responseBoundPresetId);
        if (!responseBoundPresetId) {
          setPresetId('');
          setLoadError(null);
          return;
        }
        if (list.some((preset) => preset.id === responseBoundPresetId)) {
          setPresetId(responseBoundPresetId);
          setLoadError(null);
          return;
        }
        setPresetId('');
        setLoadError('Закреплённый пресет проекта недоступен');
      })
      .catch(() => {
        setLoadError('Не удалось загрузить пресеты');
        setPresets([]);
        setBoundPresetId(null);
        setCanCreateClient(false);
        setMailboxTagOptions([]);
        setPortalProjects(null);
        setDeliveryPreview(null);
        setDeliveryPreviewState('error');
        setDeliveryPreviewError('Не удалось загрузить проекты Portal и план выполнения.');
      });
  }, [presets, template]);

  const selectPreset = useCallback((id: string) => {
    setPresetId(id);
    clearDeliveryPreview();
  }, [clearDeliveryPreview]);

  const selectPortalProject = useCallback((id: string) => {
    setPortalProjectId(id);
    setTargetContactsInput('');
    clearDeliveryPreview();
  }, [clearDeliveryPreview]);

  const changeTargetContacts = useCallback((value: string) => {
    setTargetContactsInput(value);
    clearDeliveryPreview();
  }, [clearDeliveryPreview]);

  const acceptCreatedPreset = useCallback((preset: VeLaunchPresetOption) => {
    setPresets((current) => {
      const next = [...(current ?? []).filter((item) => item.id !== preset.id), preset];
      return next.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
    });
    setPresetId(preset.id);
    clearDeliveryPreview();
    setLoadError(null);
  }, [clearDeliveryPreview]);

  useEffect(() => {
    const periodId = activePortalPeriod?.id ?? '';
    if (
      !formOpen ||
      !template ||
      !presetId ||
      !portalProjectId ||
      !periodId ||
      !segmentationAuditId ||
      targetContacts === null ||
      activePeriodIssue
    ) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setDeliveryPreviewState('loading');
      setDeliveryPreviewError(null);
      void vePreviewDeliveryPlan(template.id, {
        portal_project_id: portalProjectId,
        expected_portal_period_id: periodId,
        target_contacts: targetContacts,
        preset_id: presetId,
        segmentation_audit_id: segmentationAuditId,
      })
        .then(({ ok, data }) => {
          if (cancelled) return;
          const preview = data.preview ?? null;
          if (
            !ok ||
            !isValidDeliveryPreview(preview) ||
            preview.portal_project_id !== portalProjectId ||
            preview.portal_period_id !== periodId ||
            preview.target_contacts !== targetContacts
          ) {
            setDeliveryPreview(null);
            setDeliveryPreviewState('error');
            setDeliveryPreviewError(data.error ?? 'Не удалось рассчитать темп выполнения.');
            return;
          }
          setDeliveryPreview(preview);
          setDeliveryPreviewState('ready');
          setDeliveryPreviewError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setDeliveryPreview(null);
          setDeliveryPreviewState('error');
          setDeliveryPreviewError('Не удалось рассчитать темп выполнения.');
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activePeriodIssue,
    activePortalPeriod?.id,
    formOpen,
    portalProjectId,
    presetId,
    segmentationAuditId,
    targetContacts,
    template,
  ]);

  const deliveryPlanReady = Boolean(
    deliveryPreviewState === 'ready' &&
      deliveryPreview &&
      activePortalPeriod &&
      targetContacts !== null &&
      deliveryPreview.portal_project_id === portalProjectId &&
      deliveryPreview.portal_period_id === activePortalPeriod.id &&
      deliveryPreview.target_contacts === targetContacts,
  );

  const submit = useCallback(
    (segmentationAuditId: string) => {
      const selectedPreset = presets?.find((preset) => preset.id === presetId);
      if (
        !template ||
        !selectedPreset ||
        selectedPreset.mailbox_count === 0 ||
        !segmentationAuditId ||
        !deliveryPlanReady ||
        !deliveryPreview ||
        submitting
      ) {
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      veEnginePost<VeLaunchResponse>(`${VE_API}/templates/${template.id}/launch`, {
        preset_id: presetId,
        segmentation_audit_id: segmentationAuditId,
        confirm_segmentation: true,
        portal_project_id: deliveryPreview.portal_project_id,
        expected_portal_period_id: deliveryPreview.portal_period_id,
        target_contacts: deliveryPreview.target_contacts,
      })
        .then(({ ok, data }) => {
          if (data.code === 'TEMPLATE_LAUNCH_UNCERTAIN' || data.code === 'TEMPLATE_LAUNCH_IN_PROGRESS') {
            onSegmentationRejected('refresh');
            return;
          }
          if (!ok || !data.launch) {
            if (data.code === 'SEGMENTATION_AUDIT_STALE') {
              onSegmentationRejected('stale');
              return;
            }
            if (data.code === 'SEGMENTATION_AUDIT_INCOMPLETE') {
              onSegmentationRejected('incomplete');
              return;
            }
            setSubmitError(data.error ?? 'Не удалось отправить в запуск');
            return;
          }
          setRecorded(data.launch);
          setWarnings(data.warnings ?? []);
          setFormOpen(false);
        })
        .catch(() => setSubmitError('Не удалось отправить в запуск'))
        .finally(() => setSubmitting(false));
    },
    [deliveryPlanReady, deliveryPreview, onSegmentationRejected, presets, template, presetId, submitting],
  );

  return {
    recorded,
    formOpen,
    setFormOpen,
    presets,
    loadError,
    boundPresetId,
    presetId,
    setPresetId: selectPreset,
    canCreateClient,
    mailboxTagOptions,
    portalProjects,
    portalProjectId,
    selectedPortalProject,
    activePortalPeriod,
    selectPortalProject,
    targetContactsInput,
    targetContacts,
    changeTargetContacts,
    deliveryPlanLocked,
    deliveryPreview,
    deliveryPreviewState,
    deliveryPreviewError,
    deliveryPlanReady,
    activePeriodIssue,
    acceptCreatedPreset,
    submitting,
    submitError,
    warnings,
    reconciliationRequired,
    openForm,
    submit,
  };
}

type TemplateLaunchState = ReturnType<typeof useTemplateLaunch>;

function formatRussianCount(count: number, forms: readonly [string, string, string]): string {
  const normalized = Math.max(0, Math.trunc(count));
  const mod100 = normalized % 100;
  const mod10 = normalized % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? forms[2]
    : mod10 === 1
      ? forms[0]
      : mod10 >= 2 && mod10 <= 4
        ? forms[1]
        : forms[2];
  return `${normalized.toLocaleString('ru-RU')} ${noun}`;
}

function formatMailboxCount(count: number): string {
  return formatRussianCount(count, ['ящик', 'ящика', 'ящиков']);
}

function mailboxTagFallback(resolution: VeLaunchPresetOption['mailbox_tag_resolution']): string {
  if (resolution === 'mixed') return 'Теги пула различаются';
  if (resolution === 'unavailable') return 'Теги временно не загрузились';
  return 'Тег не назначен';
}

function mailboxTagOptionKey(option: VeMailboxTagOption): string {
  return JSON.stringify([option.instantly_account_id, option.id]);
}

function formatEmailCount(count: number | null): string {
  if (count === null || count <= 0) return 'будет проверено при создании';
  return formatRussianCount(count, ['почта', 'почты', 'почт']);
}

function DeliveryPlanBlock({ launch }: { launch: TemplateLaunchState }) {
  const preview = launch.deliveryPreview;
  const period = launch.activePortalPeriod;
  const targetInvalid = launch.targetContactsInput.trim() !== '' && launch.targetContacts === null;
  const periodLabel = preview?.portal_period_label?.trim() || period?.label?.trim() || 'Активный период';
  const periodDeadline = preview?.deadline ?? period?.deadline ?? null;
  const periodDone = preview?.contacts_done_count ?? period?.contacts_done_count ?? null;

  return (
    <section className="border-t border-gray-200 pt-3" aria-labelledby="ve2-delivery-plan-title">
      <div className="flex flex-wrap items-center gap-2">
        <p id="ve2-delivery-plan-title" className={HE.eyebrow}>
          План выполнения
        </p>
        {launch.deliveryPlanLocked ? (
          <span className={`${HE.pill} ve2-tg-ok`}>
            <StatusDot tone="ok" />
            Закреплён
          </span>
        ) : null}
      </div>

      {launch.portalProjects === null ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          Проекты Portal и активный период недоступны. Новый запуск заблокирован.
        </p>
      ) : launch.portalProjects.length === 0 ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          Нет проектов Portal, доступных для привязки. Новый запуск заблокирован.
        </p>
      ) : (
        <>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ve2-portal-project" className="ve2-label">
                Проект Portal
              </label>
              <select
                id="ve2-portal-project"
                value={launch.portalProjectId}
                onChange={(event) => launch.selectPortalProject(event.target.value)}
                disabled={launch.deliveryPlanLocked || launch.submitting}
                className="ve2-input h-10 w-full px-3 text-xs"
              >
                <option value="">Выберите проект</option>
                {launch.portalProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ve2-delivery-target" className="ve2-label">
                Обязательство, контактов
              </label>
              <input
                id="ve2-delivery-target"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={launch.targetContactsInput}
                onChange={(event) => launch.changeTargetContacts(event.target.value)}
                disabled={!launch.selectedPortalProject || launch.deliveryPlanLocked || launch.submitting}
                placeholder="Точное число"
                aria-invalid={targetInvalid}
                aria-describedby={targetInvalid ? 've2-delivery-target-error' : undefined}
                className="ve2-input h-10 w-full px-3 text-xs"
              />
            </div>
          </div>

          {launch.selectedPortalProject ? (
            period ? (
              <p className="mt-2 text-xs text-gray-600">
                {periodLabel}
                <span className="text-gray-400"> · </span>
                дедлайн {periodDeadline ? formatDate(periodDeadline) : 'не задан'}
                <span className="text-gray-400"> · </span>
                факт первых контактов{' '}
                {isNonNegativeInteger(periodDone) ? periodDone.toLocaleString('ru-RU') : 'не задан'}
              </p>
            ) : null
          ) : (
            <p className="mt-2 text-xs text-gray-500">Выберите проект явно, период подставится из Portal.</p>
          )}

          {targetInvalid ? (
            <p id="ve2-delivery-target-error" className="mt-2 text-xs text-red-600" role="alert">
              Укажите целое число больше нуля.
            </p>
          ) : null}
          {launch.activePeriodIssue ? (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {launch.activePeriodIssue} Новый запуск заблокирован.
            </p>
          ) : null}
          {!launch.presetId && launch.portalProjectId && launch.targetContacts !== null ? (
            <p className="mt-2 text-xs text-gray-500">Выберите клиентский пресет, чтобы рассчитать мощность.</p>
          ) : null}
        </>
      )}

      {launch.deliveryPreviewState === 'loading' ? (
        <p className="mt-2 text-xs text-gray-500" role="status">
          Считаем темп по рабочим дням…
        </p>
      ) : null}
      {launch.portalProjects !== null && launch.deliveryPreviewState === 'error' && launch.deliveryPreviewError ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {launch.deliveryPreviewError}
        </p>
      ) : null}

      {preview && launch.deliveryPlanReady ? (
        <div className="mt-3" aria-live="polite">
          <dl className="grid grid-cols-2 border-y border-gray-200 text-xs sm:grid-cols-5">
            {[
              [
                'Факт',
                `${preview.contacts_done_count.toLocaleString('ru-RU')} / ${preview.target_contacts.toLocaleString('ru-RU')}`,
              ],
              ['Осталось', preview.remaining.toLocaleString('ru-RU')],
              ['Рабочих дней', preview.remaining_workdays.toLocaleString('ru-RU')],
              ['Нужно в день', preview.required_daily.toLocaleString('ru-RU')],
              ['Следующая партия', preview.effective_daily.toLocaleString('ru-RU')],
            ].map(([label, value]) => (
              <div
                key={label}
                className="min-w-0 border-b border-gray-100 px-2 py-2.5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
              >
                <dt className="text-[11px] text-gray-500">{label}</dt>
                <dd className="mt-0.5 font-semibold tabular-nums text-gray-900">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-2 text-[11px] text-gray-500">
            Готово к загрузке: {preview.ready_remaining.toLocaleString('ru-RU')}
            <span className="text-gray-400"> · </span>
            мощность отправителей: {preview.sender_capacity.toLocaleString('ru-RU')} в день
          </p>
          <p className="mt-1 text-[11px] text-gray-500">
            Всего в резерве: {(preview.reserve_remaining ?? preview.ready_remaining).toLocaleString('ru-RU')}
            {' · '}Загружено, ждёт первого контакта: {(preview.outstanding_count ?? 0).toLocaleString('ru-RU')}.
            {' '}Загрузка не засчитывается в обязательство. Прогноз предполагает отправку в пределах дневного лимита;
            дата допуска новой гипотезы зависит от очереди и сезонности.
          </p>

          {preview.supply_deficit > 0 ? (
            <p className="mt-2 flex items-start gap-2 text-xs text-amber-700" role="alert">
              <StatusDot tone="warn" className="mt-1 shrink-0" />
              <span>
                Дефицит базы:{' '}
                {formatRussianCount(preview.supply_deficit, ['контакт', 'контакта', 'контактов'])} сверх доступного резерва и уже загруженного остатка.
              </span>
            </p>
          ) : null}
          {preview.capacity_deficit > 0 ? (
            <p className="mt-2 flex items-start gap-2 text-xs text-amber-700" role="alert">
              <StatusDot tone="warn" className="mt-1 shrink-0" />
              <span>
                Риск мощности: не хватает{' '}
                {formatRussianCount(preview.capacity_deficit, ['контакт', 'контакта', 'контактов'])}. Предел{' '}
                {preview.sender_capacity.toLocaleString('ru-RU')} в день на{' '}
                {preview.remaining_workdays.toLocaleString('ru-RU')} рабочих дней.
              </span>
            </p>
          ) : null}
          {preview.supply_deficit === 0 && preview.capacity_deficit === 0 ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-emerald-700" role="status">
              <StatusDot tone="ok" />
              База и мощность покрывают остаток периода.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CreateClientPresetInline({
  launch,
  templateId,
}: {
  launch: TemplateLaunchState;
  templateId: string;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tagKey, setTagKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; mailboxCount: number } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const options = useMemo(
    () => [...launch.mailboxTagOptions].sort((left, right) => {
      const workspaceOrder = left.instantly_account_label.localeCompare(right.instantly_account_label, 'ru');
      return workspaceOrder || left.name.localeCompare(right.name, 'ru');
    }),
    [launch.mailboxTagOptions],
  );
  const selectedTag = options.find((option) => mailboxTagOptionKey(option) === tagKey) ?? null;
  const hasTagOptions = options.length > 0;

  useEffect(() => {
    if (open) emailRef.current?.focus();
  }, [open]);

  const showForm = () => {
    setCreated(null);
    setError(null);
    setOpen(true);
  };

  const closeForm = () => {
    setOpen(false);
    setPassword('');
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating || !selectedTag) return;

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) return;

    setCreating(true);
    setCreated(null);
    setError(null);
    try {
      const response = await veEnginePost<VeLaunchClientResponse>(`${VE_API}/launch-clients`, {
        template_id: templateId,
        email: normalizedEmail,
        password,
        instantly_account_id: selectedTag.instantly_account_id,
        mailbox_tag_id: selectedTag.id,
      });
      if (!response.ok || !response.data.preset) {
        setError(
          response.status === 409
            ? 'Пользователь с такой почтой уже существует. Выберите его пресет или укажите другую почту.'
            : response.data.error ?? 'Не удалось создать клиента и пресет. Попробуйте ещё раз.',
        );
        requestAnimationFrame(() => passwordRef.current?.focus());
        return;
      }

      launch.acceptCreatedPreset(response.data.preset);
      setCreated({
        email: response.data.client?.email ?? normalizedEmail,
        mailboxCount: response.data.preset.mailbox_count,
      });
      setEmail('');
      setTagKey('');
      setOpen(false);
      requestAnimationFrame(() => document.getElementById('ve2-launch-preset')?.focus());
    } catch {
      setError('Не удалось создать клиента и пресет. Проверьте соединение и попробуйте ещё раз.');
      requestAnimationFrame(() => passwordRef.current?.focus());
    } finally {
      setPassword('');
      setCreating(false);
    }
  };

  return (
    <div className="border-t border-gray-200 pt-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p id="ve2-create-client-title" className="text-sm font-medium text-gray-800">
            Новый клиент
          </p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            Создайте вход в портал и пресет отправителей прямо для этого проекта.
          </p>
        </div>
        {!open ? (
          <button
            type="button"
            onClick={showForm}
            disabled={!hasTagOptions}
            aria-expanded="false"
            aria-controls="ve2-create-client-form"
            className={HE.btnSmall}
          >
            Создать клиента и пресет
          </button>
        ) : null}
      </div>

      {!hasTagOptions ? (
        <p className="mt-2 text-xs text-gray-500" role="status">
          В Instantly пока нет доступных тегов отправителей. Добавьте тег и обновите страницу.
        </p>
      ) : null}
      {created ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-emerald-700" role="status" aria-live="polite">
          <StatusDot tone="ok" />
          Клиент {created.email} создан, в пресете сохранено {formatMailboxCount(created.mailboxCount)}.
        </p>
      ) : null}

      {open ? (
        <form
          id="ve2-create-client-form"
          onSubmit={submit}
          aria-labelledby="ve2-create-client-title"
          aria-describedby="ve2-create-client-note"
          className="mt-3 space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ve2-client-email" className="ve2-label">
                Почта для входа
              </label>
              <input
                ref={emailRef}
                id="ve2-client-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={creating}
                placeholder="client@company.ru"
                className="ve2-input h-10 w-full px-3 text-xs"
              />
            </div>
            <div>
              <label htmlFor="ve2-client-password" className="ve2-label">
                Пароль для входа
              </label>
              <input
                ref={passwordRef}
                id="ve2-client-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={72}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={creating}
                className="ve2-input h-10 w-full px-3 text-xs"
              />
            </div>
          </div>

          <div className="max-w-2xl">
            <label htmlFor="ve2-client-mailbox-tag" className="ve2-label">
              Тег почт в Instantly
            </label>
            <select
              id="ve2-client-mailbox-tag"
              value={tagKey}
              onChange={(event) => setTagKey(event.target.value)}
              disabled={creating}
              required
              className="ve2-input h-10 w-full px-3 text-xs"
            >
              <option value="">Выберите workspace и тег</option>
              {options.map((option) => (
                <option
                  key={mailboxTagOptionKey(option)}
                  value={mailboxTagOptionKey(option)}
                >
                  {option.instantly_account_label} · {option.name} · {formatEmailCount(option.mailbox_count)}
                </option>
              ))}
            </select>
          </div>

          <p id="ve2-create-client-note" className="max-w-3xl text-[11px] leading-relaxed text-gray-500">
            Точный состав тега проверим в Instantly при создании. Он фиксируется в пресете и позднее не обновляется
            вслед за тегом. Кампании создаются без отправки, текущую кампанию можно вручную поправить перед активацией.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={creating || !email.trim() || password.length < 8 || !selectedTag}
              className={HE.btnPrimary}
            >
              {creating ? 'Создаём клиента…' : 'Создать клиента'}
            </button>
            <button type="button" onClick={closeForm} disabled={creating} className={HE.btnGhost}>
              Отмена
            </button>
          </div>
          {error ? (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

interface TemplateLaunchPortfolioDto {
  item_id: string;
  status: string;
  mode: 'advisory' | 'enforced';
  plan_version: number | null;
  priority_snapshot: VeRuSeasonalityPrioritySnapshot;
  capacity: {
    max_active_bundles: number;
    active_bundles: number;
  };
}

const SEASONALITY_STATES = new Set<VeRuSeasonalityState>([
  'launch_now',
  'prepare_now',
  'neutral',
  'unknown',
  'wait',
  'avoid',
]);

const NON_QUEUED_LIFECYCLE_MESSAGE: Readonly<Record<string, string>> = {
  prepared: 'Кампании подготовлены, но запуск ещё не поставлен в очередь',
  activating: 'Активация отправки выполняется',
  active: 'Отправка уже активна',
  uncertain: 'Статус активации требует сверки',
  released: 'Отправка завершена',
  skipped: 'Запуск пропущен',
  cancelled: 'Запуск отменён',
};

function readTemplateLaunchPortfolio(template: VeTemplate | null): TemplateLaunchPortfolioDto | null {
  const raw = (template as { launch_portfolio?: unknown } | null)?.launch_portfolio;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const snapshot = value.priority_snapshot;
  const capacity = value.capacity;
  if (
    typeof value.item_id !== 'string' ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !capacity ||
    typeof capacity !== 'object' ||
    Array.isArray(capacity)
  ) {
    return null;
  }
  const priority = snapshot as Record<string, unknown>;
  const capacityRecord = capacity as Record<string, unknown>;
  if (
    typeof priority.state !== 'string' ||
    !SEASONALITY_STATES.has(priority.state as VeRuSeasonalityState) ||
    typeof capacityRecord.max_active_bundles !== 'number' ||
    typeof capacityRecord.active_bundles !== 'number'
  ) {
    return null;
  }
  return {
    item_id: value.item_id,
    status: typeof value.status === 'string' ? value.status : 'prepared',
    mode: value.mode === 'advisory' ? 'advisory' : 'enforced',
    plan_version:
      typeof value.plan_version === 'number' && Number.isInteger(value.plan_version) ? value.plan_version : null,
    priority_snapshot: priority as unknown as VeRuSeasonalityPrioritySnapshot,
    capacity: {
      max_active_bundles: capacityRecord.max_active_bundles,
      active_bundles: capacityRecord.active_bundles,
    },
  };
}

function PreparedLaunchPortfolio({
  info,
  portfolio,
  warnings,
}: {
  info: VeTemplateLaunchInfo;
  portfolio: TemplateLaunchPortfolioDto;
  warnings: string[];
}) {
  const [reviewed, setReviewed] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);
  const [deliveryDeferred, setDeliveryDeferred] = useState(false);
  const [activationError, setActivationError] = useState('');
  const [queueHint, setQueueHint] = useState(false);
  const campaigns = info.campaigns && info.campaigns.length > 1 ? info.campaigns : null;
  const seasonalState = portfolio.priority_snapshot.state;
  const seasonallyEligible =
    portfolio.mode === 'advisory' || seasonalState === 'launch_now' || seasonalState === 'neutral';
  const slotAvailable = portfolio.capacity.active_bundles < portfolio.capacity.max_active_bundles;
  const hasCurrentPlan = portfolio.plan_version !== null;
  const isQueued = portfolio.status === 'queued';
  const lifecycleMessage = isQueued
    ? null
    : (portfolio.status === 'active' && info.ready_leads_count !== undefined
      ? 'Запуск одобрен. Контакты загружаются по будням согласно плану; пустые кампании ждут первой партии.'
      : NON_QUEUED_LIFECYCLE_MESSAGE[portfolio.status] ?? 'Текущий статус запуска не допускает активацию');
  // Capacity in the queue response is a read snapshot. The backend activation
  // preflight re-reads Instantly and can safely release a Completed holder.
  const canActivate = isQueued && seasonallyEligible && hasCurrentPlan;

  const activate = async () => {
    if (!canActivate || !reviewed || activating) return;
    setActivating(true);
    setActivationError('');
    const idempotencyKey =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${portfolio.item_id}-${Date.now()}`;
    try {
      const { ok, data } = await veEnginePost<{ error?: string; delivery_activation_deferred?: boolean }>(
        `${VE_API}/launch-portfolio/${portfolio.item_id}/activate`,
        {
          confirm_campaign_review: true,
          idempotency_key: idempotencyKey,
          plan_version: portfolio.plan_version,
        },
      );
      if (!ok) {
        setActivationError(data.error || 'Не удалось активировать отправку');
        return;
      }
      setActivated(true);
      setDeliveryDeferred(data.delivery_activation_deferred === true);
    } catch {
      setActivationError('Не удалось активировать отправку');
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="space-y-3">
      <section aria-label="Подготовка PAUSED-кампаний" className={`px-4 py-3 ${HE.successPanel}`}>
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <StatusDot tone="ok" />
          PAUSED-кампании подготовлены.{' '}
          {campaigns && campaigns.length > 1
            ? `Подготовлено кампаний: ${campaigns.length} по сегментам · контактов при подготовке: ${(info.ready_leads_count ?? info.leads_count).toLocaleString('ru-RU')}`
            : `Кампания: ${info.campaign_name} · контактов при подготовке: ${(info.ready_leads_count ?? info.leads_count).toLocaleString('ru-RU')}`}
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          {slotAvailable ? 'Sending slot не занят.' : 'Sending slot уже занят другой отправкой.'}
          {info.created_at ? <span> · {formatDate(info.created_at)}</span> : null}
        </p>
        {info.campaign_url && !campaigns ? (
          <a
            href={info.campaign_url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-xs text-emerald-700 underline"
          >
            Открыть в Instantly
          </a>
        ) : null}
        {campaigns ? (
          <ul className="mt-1.5 space-y-0.5 text-xs text-emerald-700">
            {campaigns.map((campaign) => (
              <li key={campaign.campaign_id}>
                <a href={campaign.campaign_url} target="_blank" rel="noreferrer" className="underline">
                  {campaign.segment ?? 'Основная (дефолтный текст)'}
                </a>
                <span> · подготовлено: {(campaign.ready_leads_count ?? campaign.leads_count).toLocaleString('ru-RU')}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {warnings.map((warning) => (
          <p key={warning} className="mt-1 text-xs text-amber-700">
            {warning}
          </p>
        ))}
      </section>

      <section aria-label="Активация отправки" className="rounded-lg border border-gray-200 bg-gray-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={HE.eyebrow}>Активация отправки</p>
            <div className="mt-1.5">
              <SeasonalityStatus state={seasonalState} />
            </div>
          </div>
          <span className={HE.faint}>
            Sending slot: {portfolio.capacity.active_bundles} из {portfolio.capacity.max_active_bundles}
          </span>
        </div>

        {lifecycleMessage ? (
          <p className="mt-3 text-sm text-gray-700">{lifecycleMessage}</p>
        ) : !seasonallyEligible ? (
          <p className="mt-3 text-sm text-amber-700">Требуется проверка сезонного решения.</p>
        ) : !hasCurrentPlan ? (
          <p className="mt-3 text-sm text-amber-700">План очереди нужно обновить перед активацией.</p>
        ) : (
          <>
            {!slotAvailable ? (
              <p className="mt-3 text-sm text-amber-700">
                По последнему снимку sending slot занят. При активации backend обновит live-статус и безопасно освободит
                holder, если кампания уже Completed.
              </p>
            ) : null}
            <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
                className="mt-0.5"
              />
              Я проверил тексты, получателей и настройки всех PAUSED-кампаний
            </label>
          </>
        )}

        {isQueued ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void activate()}
              disabled={!canActivate || !reviewed || activating || activated}
              className={HE.btnPrimary}
            >
              {activated ? (deliveryDeferred ? 'Запуск одобрен' : 'Отправка активирована') : activating ? 'Активируем…' : 'Активировать отправку'}
            </button>
            <button type="button" onClick={() => setQueueHint(true)} className={HE.btnGhost}>
              Пересмотреть сезонное решение
            </button>
          </div>
        ) : null}
        {deliveryDeferred ? (
          <p className="mt-2 text-xs text-gray-600" role="status">
            Кампании ждут первой дневной партии. После её загрузки отправка начнётся по расписанию пресета.
          </p>
        ) : null}
        {queueHint ? (
          <p className="mt-2 text-xs text-gray-600" role="status">
            Откройте «Очередь запусков» и сохраните ручное решение с причиной.
          </p>
        ) : null}
        {activationError ? (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {activationError}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** Записанный запуск либо инлайн-аудит и форма выбора пресета. */
function LaunchSection({
  launch,
  audit,
  template,
  onDownloadLaunchCsv,
  csvDownloading,
  csvDownloadError,
}: {
  launch: TemplateLaunchState;
  audit: SegmentationAuditController;
  template: VeTemplate;
  onDownloadLaunchCsv: () => void;
  csvDownloading: boolean;
  csvDownloadError: string;
}) {
  const recorded = launch.recorded ?? (audit.phase === 'launch_succeeded' ? audit.launchInfo : null);
  const selectedPreset = launch.presets?.find((preset) => preset.id === launch.presetId) ?? null;
  const embeddedPortfolio = useMemo(() => readTemplateLaunchPortfolio(template), [template]);
  const [remotePortfolio, setRemotePortfolio] = useState<TemplateLaunchPortfolioDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!embeddedPortfolio && !recorded?.priority_snapshot) {
      void Promise.resolve().then(() => {
        if (!cancelled) setRemotePortfolio(null);
      });
      return () => {
        cancelled = true;
      };
    }
    const market = embeddedPortfolio?.mode === 'advisory' ? 'us' : 'ru';
    void Promise.resolve(veEngineCall<LaunchPortfolioResponse>(`${VE_API}/launch-portfolio?market=${market}`))
      .then((response) => {
        if (cancelled || !response?.ok) return;
        const item = response.data.items?.find((candidate) => candidate.template_id === template.id);
        if (!item?.priority_snapshot || !item.capacity) return;
        setRemotePortfolio({
          item_id: item.id,
          status: item.status,
          mode: response.data.mode,
          plan_version: response.data.plan_version,
          priority_snapshot: item.priority_snapshot,
          capacity: {
            max_active_bundles: item.capacity.max_active_bundles,
            active_bundles: item.capacity.occupied_bundles,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [embeddedPortfolio, recorded?.priority_snapshot, template.id]);

  if (recorded) {
    const info = recorded;
    const portfolio = remotePortfolio ?? embeddedPortfolio;
    if (portfolio) {
      return <div className="space-y-3">
        <PreparedLaunchPortfolio info={info} portfolio={portfolio} warnings={launch.warnings} />
        {info.portal_project_id ? (
          launch.formOpen ? <DeliveryPlanBlock launch={launch} /> : (
            <button type="button" onClick={launch.openForm} className="ve2-b-quiet">План и запас контактов</button>
          )
        ) : null}
      </div>;
    }
    const campaigns = info.campaigns && info.campaigns.length > 1 ? info.campaigns : null;
    return (
      <div className={`px-4 py-3 ${HE.successPanel}`}>
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <StatusDot tone="ok" />
          {campaigns && campaigns.length > 1
            ? `Подготовлено кампаний: ${campaigns.length} по сегментам · контактов при подготовке: ${(info.ready_leads_count ?? info.leads_count).toLocaleString('ru-RU')}`
            : `Кампания: ${info.campaign_name} · контактов при подготовке: ${(info.ready_leads_count ?? info.leads_count).toLocaleString('ru-RU')}`}
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          {info.campaign_url && !campaigns ? (
            <a href={info.campaign_url} target="_blank" rel="noreferrer" className="underline">
              Открыть в Instantly
            </a>
          ) : null}
          {info.created_at ? <span> · {formatDate(info.created_at)}</span> : null}
          <span> · Активация — вручную в Instantly после проверки</span>
        </p>
        {campaigns && campaigns.length > 1 ? (
          <ul className="mt-1.5 space-y-0.5 text-xs text-emerald-700">
            {campaigns.map((c) => (
              <li key={c.campaign_id}>
                <a href={c.campaign_url} target="_blank" rel="noreferrer" className="underline">
                  {c.segment ?? 'Основная (дефолтный текст)'}
                </a>
                <span> · подготовлено: {(c.ready_leads_count ?? c.leads_count).toLocaleString('ru-RU')}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {launch.warnings.map((w) => (
          <p key={w} className="mt-1 text-xs text-amber-700">
            {w}
          </p>
        ))}
      </div>
    );
  }

  if (!launch.formOpen) return null;

  return (
    <div className="space-y-3">
      <SegmentationAuditPanel audit={audit} />
      {audit.canLaunch && audit.auditId ? (
        <div className={`space-y-3 px-4 py-3 ${HE.infoPanel}`}>
          <p className="text-sm font-medium text-gray-800">
            Запуск в Instantly: кампании будут созданы <b>на паузе</b>, получатели загрузятся из проверенной раскладки.
            Активация — вручную после проверки.
          </p>
          {launch.presets === null && !launch.loadError ? (
            <p className="text-xs text-gray-500" role="status">Загружаем пресеты…</p>
          ) : null}
          {launch.loadError ? <p className="text-xs text-red-500" role="alert">{launch.loadError}</p> : null}
          {launch.presets && launch.presets.length === 0 && !launch.loadError ? (
            <p className="text-xs text-gray-500">
              {launch.canCreateClient
                ? 'Для этого проекта ещё нет доступного пресета.'
                : 'Нет доступных пресетов. Сначала настройте пресет клиенту.'}
            </p>
          ) : null}
          {launch.presets && launch.presets.length > 0 ? (
            <div className="space-y-3">
              <div className="min-w-0 sm:max-w-sm">
                <label htmlFor="ve2-launch-preset" className="ve2-label">
                  Клиентский пресет
                </label>
                <select
                  id="ve2-launch-preset"
                  value={launch.presetId}
                  onChange={(event) => launch.setPresetId(event.target.value)}
                  disabled={Boolean(launch.boundPresetId)}
                  className="ve2-input h-10 w-full px-3 text-xs"
                  aria-describedby={selectedPreset ? 've2-launch-preset-summary' : undefined}
                >
                  {!launch.boundPresetId ? <option value="">Выберите клиента</option> : null}
                  {launch.boundPresetId && !selectedPreset ? (
                    <option value="">Закреплённый пресет недоступен</option>
                  ) : null}
                  {launch.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                {launch.boundPresetId && selectedPreset ? (
                  <p className="mt-1 text-[11px] text-gray-500">Пресет закреплён за проектом</p>
                ) : null}
              </div>
              {selectedPreset ? (
                <dl
                  id="ve2-launch-preset-summary"
                  aria-live="polite"
                  className="grid gap-3 border-t border-gray-200 pt-3 text-xs sm:grid-cols-2"
                >
                  <div>
                    <dt className="text-gray-500">Workspace</dt>
                    <dd className="mt-1 font-medium text-gray-800">{selectedPreset.instantly_account_label}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Пул отправителей</dt>
                    <dd className="mt-1 flex flex-wrap items-center gap-1.5 text-gray-800">
                      {(selectedPreset.mailbox_tag_resolution === 'exact' ||
                        selectedPreset.mailbox_tag_resolution === 'shared') &&
                      selectedPreset.mailbox_tags.length > 0 ? (
                        selectedPreset.mailbox_tags.map((tag) => (
                          <span key={tag.id} className="ve2-tag">
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span>{mailboxTagFallback(selectedPreset.mailbox_tag_resolution)}</span>
                      )}
                      <span className="text-gray-500">· {formatMailboxCount(selectedPreset.mailbox_count)}</span>
                    </dd>
                  </div>
                </dl>
              ) : null}
              <DeliveryPlanBlock launch={launch} />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => launch.submit(audit.auditId as string)}
                  disabled={
                    launch.submitting ||
                    !selectedPreset ||
                    selectedPreset.mailbox_count === 0 ||
                    !launch.deliveryPlanReady
                  }
                  className={HE.btnPrimary}
                >
                  {launch.submitting
                    ? 'Создаём кампании…'
                    : (() => {
                        const groups = audit.summary
                          ? audit.summary.segments.filter((segment) => segment.count > 0).length +
                            (audit.summary.defaultGroup.count > 0 ? 1 : 0)
                          : 0;
                        return groups === 1 ? 'Создать кампанию (на паузе)' : `Создать ${groups} кампании на паузе`;
                      })()}
                </button>
                {selectedPreset ? (
                  <button
                    type="button"
                    onClick={onDownloadLaunchCsv}
                    disabled={csvDownloading}
                    aria-label="Скачать CSV для запуска"
                    className={HE.btnGhost}
                  >
                    <Download aria-hidden className="h-4 w-4" />
                    {csvDownloading ? 'Готовим CSV…' : 'CSV для запуска'}
                  </button>
                ) : null}
                <button type="button" onClick={() => launch.setFormOpen(false)} className={HE.btnGhost}>
                  Отмена
                </button>
              </div>
              {csvDownloadError ? (
                <p className="text-xs text-red-600" role="alert">
                  {csvDownloadError}
                </p>
              ) : null}
            </div>
          ) : null}
          {launch.presets && launch.canCreateClient && !launch.boundPresetId && !launch.loadError ? (
            <CreateClientPresetInline launch={launch} templateId={template.id} />
          ) : null}
          {launch.submitError ? (
            <p className="text-xs text-red-600" role="alert">
              {launch.submitError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Step5Template(props: {
  template: VeTemplate | null;
  base: VeBaseSummary | null;
  jobs: VeJobSummary[];
  onBuildTemplate: () => void;
  /** Возврат к исходной цепочке: шаблон пересобирается после правок на шаге 3. */
  onGoToContent?: () => void;
}): JSX.Element {
  const { template, base, jobs, onBuildTemplate, onGoToContent } = props;
  const [copied, setCopied] = useState(false);
  const [copiedLetterIdx, setCopiedLetterIdx] = useState<number | null>(null);
  const [csvDownloading, setCsvDownloading] = useState(false);
  const [csvDownloadError, setCsvDownloadError] = useState('');
  const segmentationAudit = useSegmentationAudit(template?.id ?? null);
  const { refresh: refreshSegmentationAudit, markRejected: markSegmentationRejected } = segmentationAudit;
  const handleSegmentationRejected = useCallback(
    (phase: 'stale' | 'incomplete' | 'refresh') => {
      if (phase === 'refresh') {
        refreshSegmentationAudit();
        return;
      }
      markSegmentationRejected(phase);
    },
    [markSegmentationRejected, refreshSegmentationAudit],
  );
  const launch = useTemplateLaunch(
    template,
    segmentationAudit.auditId,
    handleSegmentationRejected,
  );

  const templateJob = useMemo(() => latestStageJob(jobs, 'template'), [jobs]);
  const busy = templateJob?.status === 'pending' || templateJob?.status === 'running';
  const failed = !busy && templateJob?.status === 'failed';

  const handleCopy = useCallback(() => {
    if (!template || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(templateToText(template)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [template]);

  // Копирование одного письма: «{subject}\n\n{body}», краткое «✓» на кнопке.
  const handleCopyLetter = useCallback(
    (idx: number) => {
      if (!template || typeof navigator === 'undefined' || !navigator.clipboard) return;
      const letter = template.letters[idx];
      if (!letter) return;
      const text = letter.subject ? `${letter.subject}\n\n${letter.body}` : letter.body;
      void navigator.clipboard.writeText(text).then(() => {
        setCopiedLetterIdx(idx);
        setTimeout(() => setCopiedLetterIdx((cur) => (cur === idx ? null : cur)), 1500);
      });
    },
    [template],
  );

  const handleDownload = useCallback(() => {
    if (!template) return;
    const blob = new Blob([JSON.stringify(template, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `he-template-${template.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [template]);

  const exportBaseId = template?.base_id ?? null;
  const handleLaunchReadyCsvDownload = useCallback(async () => {
    const auditId = segmentationAudit.auditId;
    const presetId = launch.presetId.trim();
    if (
      !template ||
      !exportBaseId ||
      !segmentationAudit.canLaunch ||
      !auditId ||
      !presetId ||
      csvDownloading
    ) return;
    setCsvDownloadError('');
    setCsvDownloading(true);
    try {
      const query = new URLSearchParams({
        mode: 'launch-ready',
        template_id: template.id,
        segmentation_audit_id: auditId,
        preset_id: presetId,
      });
      const res = await authFetch(`${VE_API}/bases/${exportBaseId}/export?${query}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Ошибка ${res.status}`);
      }
      await downloadBaseCsvResponse(res, `base-${exportBaseId}-launch-ready.csv`);
    } catch (err) {
      setCsvDownloadError(err instanceof Error ? err.message : 'Не удалось скачать CSV для запуска');
    } finally {
      setCsvDownloading(false);
    }
  }, [
    csvDownloading,
    exportBaseId,
    launch.presetId,
    segmentationAudit.auditId,
    segmentationAudit.canLaunch,
    template,
  ]);

  /* ── Шаблона ещё нет ── */
  if (!template) {
    if (busy) {
      return (
        <div className="space-y-3">
          <StatusBox tone="info">Собираем шаблон под базу {base?.filename ?? '—'}…</StatusBox>
          <p className="text-xs text-gray-500">Обычно это занимает несколько минут — страницу можно не закрывать.</p>
        </div>
      );
    }
    if (failed) {
      return (
        <div className="space-y-3">
          <StatusBox tone="error">
            Сборка шаблона завершилась ошибкой
            {templateJob?.error ? `: ${templateJob.error}` : '.'}
          </StatusBox>
          <div>
            <button type="button" onClick={onBuildTemplate} className={HE.btnPrimary}>
              Попробовать снова
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className={`${HE.emptyState} flex min-h-[220px] flex-col items-center justify-center`}>
        <p className="text-sm font-medium text-gray-500">Шаблона пока нет</p>
        <p className={`mt-1 max-w-md text-xs ${HE.muted}`}>
          Движок адаптирует цепочку вертикали под базу
          {base?.filename ? ` «${base.filename}»` : ''} и расставит операторы персонализации.
        </p>
        <button type="button" onClick={onBuildTemplate} className={`${HE.btnPrimary} mt-4`}>
          <Sparkles aria-hidden className="h-4 w-4" />
          Собрать шаблон
        </button>
      </div>
    );
  }

  /* ── Готовый шаблон ── */
  const mapping = template.personalization_plan?.operator_mapping ?? [];
  const unmatchedMapping = mapping.filter((item) => !item.matched);
  // The cap applies to validated unique contacts, not raw company rows.
  const baseOverLaunchLimit = (segmentationAudit.summary?.launchableRows ?? 0) > VE_LAUNCH_MAX_LEADS;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-[-0.01em] text-gray-900">Шаблон 85/15</h2>
            <span className={`${HE.pill} ${template.status === 'ready' ? 've2-tg-ok' : 've2-tg-warn'}`}>
              <StatusDot tone={template.status === 'ready' ? 'ok' : 'warn'} />
              {template.status === 'ready' ? 'Готов' : 'Черновик'}
            </span>
          </div>
          <p className={`mt-1.5 ${HE.muted}`}>
            База: {base?.filename ?? '—'}
            {base ? ` · ${base.row_count.toLocaleString('ru-RU')} строк.` : '.'}{' '}
            {onGoToContent ? (
              <button type="button" onClick={onGoToContent} className="ve2-b-quiet">
                Правится на шаге 3: Контент
              </button>
            ) : (
              <span className="text-gray-500">Правится на шаге 3: Контент</span>
            )}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2 sm:shrink-0">
          <button type="button" onClick={handleCopy} className={`${HE.btnGhost} ve2-b-sm`}>
            <Copy aria-hidden className="h-4 w-4" />
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            aria-label="Скачать JSON"
            className="ve2-btn ve2-b-ghost ve2-b-sm"
          >
            <Download aria-hidden className="h-4 w-4" />
            JSON
          </button>
        </div>
      </header>

      {/* Реальные unmatched-операторы из плана, без демонстрационных процентов. */}
      {unmatchedMapping.length > 0 ? (
        <div className="ve2-nt ve2-nt-warn flex items-start gap-2.5 px-4 py-3" role="alert">
          <StatusDot tone="warn" className="mt-[7px] shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-gray-900">
              {unmatchedMapping.length === 1 ? (
                <>
                  Оператор <code className="ve2-op">{`{{${unmatchedMapping[0].operator}}}`}</code> не совпал ни с одной
                  колонкой.
                </>
              ) : (
                <>
                  Операторы{' '}
                  <span className="font-mono">{unmatchedMapping.map((item) => `{{${item.operator}}}`).join(', ')}</span>{' '}
                  не совпали ни с одной колонкой.
                </>
              )}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {unmatchedMapping.length === 1 && unmatchedMapping[0].fallback
                ? `Подставим запасной текст «${unmatchedMapping[0].fallback}». `
                : 'Запасные тексты показаны в маппинге. '}
              Проверьте их перед запуском.
            </p>
          </div>
        </div>
      ) : null}

      {/* Запуск: существующие audit/recovery/portfolio состояния живут внутри одной панели. */}
      <section className="ve2-panel px-5 py-[18px]" aria-labelledby="ve2-template-launch-title">
        <p id="ve2-template-launch-title" className={HE.eyebrow}>
          01 → Запуск в Instantly
        </p>
        {!launch.recorded && segmentationAudit.phase !== 'launch_succeeded' ? (
          <>
            <p className={`mt-2 ${HE.muted}`}>
              Кампании будут созданы на паузе. Ничего не уйдёт без ручной активации после проверки.
            </p>
            {baseOverLaunchLimit ? (
              <p className="mt-2 text-xs text-gray-500">
                База больше лимита запуска ({VE_LAUNCH_MAX_LEADS}). Разделите исходный CSV или соберите базу
                меньшего лимита, затем повторите проверку.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (launch.formOpen) return;
                segmentationAudit.start();
                launch.openForm();
              }}
              disabled={baseOverLaunchLimit}
              aria-disabled={baseOverLaunchLimit || launch.formOpen}
              className={`mt-3 ${HE.btnPrimary} ${launch.formOpen ? 'cursor-default opacity-70' : ''}`}
            >
              <Rocket aria-hidden className="h-4 w-4" />
              {launch.formOpen
                ? segmentationAudit.phase === 'loading'
                  ? 'Проверяем сегментацию…'
                  : 'Проверка открыта'
                : launch.reconciliationRequired
                  ? 'Проверить результат запуска'
                  : 'Проверить перед запуском'}
            </button>
          </>
        ) : null}
        <div className="mt-3">
          <LaunchSection
            launch={launch}
            audit={segmentationAudit}
            template={template}
            onDownloadLaunchCsv={() => void handleLaunchReadyCsvDownload()}
            csvDownloading={csvDownloading}
            csvDownloadError={csvDownloadError}
          />
        </div>
      </section>

      {/* Финальные письма: один лист, письма разделяются только hairline. */}
      <section aria-labelledby="ve2-template-letters-title">
        <p id="ve2-template-letters-title" className={HE.eyebrow}>
          02 → Письма
        </p>
        <ol className="ve2-letter-sheet mt-2.5">
          {template.letters.map((letter, idx) => (
            <li key={idx} className="ve2-letter">
              <div className="flex flex-wrap items-center gap-3">
                <span className={HE.eyebrow}>
                  Письмо {idx + 1} · {letter.wait_days > 0 ? `через ${letter.wait_days} дн.` : 'сразу'}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyLetter(idx)}
                  title="Скопировать письмо"
                  aria-label={`Скопировать письмо ${idx + 1}`}
                  className={`ml-auto ${HE.btnQuiet}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Copy aria-hidden className="h-3.5 w-3.5" />
                    {copiedLetterIdx === idx ? 'Скопировано' : 'Скопировать'}
                  </span>
                </button>
              </div>
              {letter.subject ? (
                <OperatorText text={letter.subject} className="ve2-letter-subject block" />
              ) : (
                <p className="ve2-letter-subject italic text-gray-500">Без темы: идёт следом за предыдущим</p>
              )}
              <OperatorText text={letter.body} className="ve2-letter-body block" />
              {letter.segment_variants?.length ? (
                <div className="mt-3 space-y-1">
                  {letter.segment_variants.map((v, vi) => (
                    <details key={`${v.when}-${vi}`} className="ve2-details group">
                      <summary>
                        <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-open:rotate-90" />
                        Вариант для сегмента: {v.when}
                      </summary>
                      <OperatorText
                        text={v.text}
                        className="block whitespace-pre-wrap pb-3 text-sm leading-relaxed text-gray-700"
                      />
                    </details>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {/* Маппинг виден до фиксированного блока, как в эталоне. */}
      <section aria-labelledby="ve2-template-mapping-title">
        <p id="ve2-template-mapping-title" className={HE.eyebrow}>
          03 → Маппинг операторов на колонки базы
        </p>
        <div className="ve2-panel mt-2.5 overflow-x-auto px-5 py-1.5">
          {mapping.length > 0 ? (
            <table className="min-w-full border-collapse text-sm">
              <caption className="sr-only">Маппинг операторов шаблона на колонки базы</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    Оператор
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Колонка базы
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Статус
                  </th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((m, i) => (
                  <tr key={`${m.operator}-${i}`} className="border-b border-gray-100 last:border-0">
                    <td className="py-2.5 pr-3">
                      <code className="ve2-op">{`{{${m.operator}}}`}</code>
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-gray-700">{m.column ?? '—'}</td>
                    <td className="py-2.5">
                      <span className="inline-flex flex-col items-start gap-1">
                        <span className={`${HE.pill} ${m.matched ? 've2-tg-ok' : 've2-tg-err'}`}>
                          <StatusDot tone={m.matched ? 'ok' : 'err'} />
                          {m.matched ? 'Совпало' : 'Нет колонки'}
                        </span>
                        {!m.matched && m.fallback ? (
                          <span className="text-[11px] text-gray-500">Подставим: {m.fallback}</span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-3 text-xs text-gray-500">В письмах нет операторов для маппинга.</p>
          )}
        </div>
      </section>

      {/* Фиксированный блок: вторичная подробность после видимого маппинга. */}
      {template.fixed_block ? (
        <details className="ve2-details group">
          <summary>
            <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-open:rotate-90" />
            Фиксированный блок (85%)
          </summary>
          <OperatorText
            text={template.fixed_block}
            className="block max-w-[72ch] whitespace-pre-wrap pb-3 text-xs leading-relaxed text-gray-600"
          />
        </details>
      ) : null}

      {/* Превью по лидам сохранено как дополнительная подробность после основного шаблона. */}
      <TemplateLeadPreview template={template} baseId={base?.id ?? template.base_id} />
    </div>
  );
}
