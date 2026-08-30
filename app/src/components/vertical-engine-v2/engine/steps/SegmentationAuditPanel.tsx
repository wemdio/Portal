'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { parseLaunchInfo, type VeTemplateLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import { VE_API, veEngineCall, veEnginePatch, veEnginePost } from '../api';
import { HE, Spinner, StatusDot } from '../design';

const AUDIT_POLL_INTERVAL_MS = 1_500;
// До 2 000 строк = до 50 LLM-батчей; оставляем окну проверки до 10 минут.
const AUDIT_POLL_ATTEMPTS = 400;

type AuditPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'incomplete'
  | 'stale'
  | 'launch_uncertain'
  | 'launch_succeeded'
  | 'error';

interface SegmentationAuditField {
  label: string;
  value: string;
}

interface SegmentationAuditExample {
  rowIndex: number | null;
  label: string;
  email: string | null;
  fields: SegmentationAuditField[];
}

interface SegmentationAuditGroup {
  when: string;
  count: number;
  sharePct: number;
  examples: SegmentationAuditExample[];
}

interface SegmentationAuditSummary {
  status: 'complete' | 'incomplete' | 'not_required';
  totalBaseRows: number;
  launchableRows: number;
  unclassifiedCount: number;
  excluded: {
    lowRelevance: number;
    invalidEmailStatus: number;
    invalidEmail: number;
    duplicateEmail: number;
  };
  segments: SegmentationAuditGroup[];
  defaultGroup: Omit<SegmentationAuditGroup, 'when'>;
}

interface SegmentationAuditSnapshot {
  id: string;
  status: string;
  current: boolean;
  error: string | null;
  launchStatus: 'idle' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  launchReservationId: string | null;
  launchStartedAt: string | null;
  launchError: string | null;
  launch: VeTemplateLaunchInfo | null;
  summary: SegmentationAuditSummary | null;
}

interface SegmentationAuditState {
  templateId: string | null;
  phase: AuditPhase;
  audit: SegmentationAuditSnapshot | null;
  error: string | null;
}

interface AuditEnvelope {
  audit?: unknown;
  error?: string;
}

const IDLE_AUDIT_STATE: SegmentationAuditState = {
  templateId: null,
  phase: 'idle',
  audit: null,
  error: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function valueString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = valueString(record[key]);
    if (value) return value;
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
  }
  return undefined;
}

function normalizeFields(value: unknown): SegmentationAuditField[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        const record = asRecord(entry);
        if (!record) return null;
        const label = firstString(record, ['label', 'column', 'name', 'key']);
        const fieldValue = valueString(record.value);
        return label && fieldValue ? { label, value: fieldValue } : null;
      })
      .filter((entry): entry is SegmentationAuditField => entry !== null);
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .map(([label, fieldValue]) => ({ label, value: valueString(fieldValue) }))
    .filter((entry) => entry.value.length > 0);
}

function normalizeExamples(value: unknown): SegmentationAuditExample[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((entry, index) => {
    const record = asRecord(entry) ?? {};
    const rowIndex = firstNumber(record, ['row_index', 'rowIndex']);
    const label = firstString(record, ['label', 'company', 'company_name', 'companyName']);
    const email = firstString(record, ['email']);
    return {
      rowIndex: rowIndex ?? null,
      label: label || (rowIndex === undefined ? `Пример ${index + 1}` : `Строка ${rowIndex + 1}`),
      email: email || null,
      fields: normalizeFields(record.fields ?? record.cells),
    };
  });
}

function normalizeGroup(value: unknown, launchableRows: number): Omit<SegmentationAuditGroup, 'when'> {
  const record = asRecord(value) ?? {};
  const count = firstNumber(record, ['count']) ?? 0;
  const sharePct =
    firstNumber(record, ['share_pct', 'sharePct']) ??
    (launchableRows > 0 ? Math.round((count / launchableRows) * 1_000) / 10 : 0);
  return {
    count,
    sharePct,
    examples: normalizeExamples(record.examples),
  };
}

function normalizeSummary(value: unknown): SegmentationAuditSummary | null {
  const record = asRecord(value);
  if (!record) return null;

  const excludedRaw = asRecord(record.excluded) ?? {};
  const excluded = {
    lowRelevance: firstNumber(excludedRaw, ['low_relevance', 'lowRelevance']) ?? 0,
    invalidEmailStatus:
      firstNumber(excludedRaw, [
        'invalid_verification',
        'invalidVerification',
        'invalid_email_status',
        'invalidEmailStatus',
      ]) ?? 0,
    invalidEmail: firstNumber(excludedRaw, ['invalid_email', 'invalidEmail']) ?? 0,
    duplicateEmail: firstNumber(excludedRaw, ['duplicate_email', 'duplicateEmail']) ?? 0,
  };
  const excludedTotal = Object.values(excluded).reduce((sum, count) => sum + count, 0);
  const launchableRows =
    firstNumber(record, ['launchable_rows', 'launchable_rows_total', 'launchableRows']) ?? 0;
  const unclassifiedCount =
    firstNumber(record, [
      'unclassified_count',
      'unclassified_rows_total',
      'unclassifiedCount',
    ]) ?? 0;
  const totalBaseRows =
    firstNumber(record, ['total_base_rows', 'base_rows_total', 'totalBaseRows']) ??
    launchableRows + excludedTotal;

  const rawStatus = firstString(record, ['status']).toLowerCase();
  const status: SegmentationAuditSummary['status'] =
    rawStatus === 'not_required'
      ? 'not_required'
      : rawStatus === 'incomplete' || unclassifiedCount > 0
        ? 'incomplete'
        : 'complete';

  const rawSegments = Array.isArray(record.segments) ? record.segments : [];
  const segments = rawSegments.map((entry, index) => {
    const segment = asRecord(entry) ?? {};
    return {
      when: firstString(segment, ['when', 'segment', 'key']) || `Сегмент ${index + 1}`,
      ...normalizeGroup(segment, launchableRows),
    };
  });

  return {
    status,
    totalBaseRows,
    launchableRows,
    unclassifiedCount,
    excluded,
    segments,
    defaultGroup: normalizeGroup(record.default, launchableRows),
  };
}

function normalizeAudit(value: unknown): SegmentationAuditSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = firstString(record, ['id']);
  const status = firstString(record, ['status']).toLowerCase();
  if (!id || !status) return null;
  const rawLaunchStatus = firstString(record, ['launch_status', 'launchStatus']).toLowerCase();
  const launchStatus: SegmentationAuditSnapshot['launchStatus'] =
    rawLaunchStatus === 'running' ||
    rawLaunchStatus === 'succeeded' ||
    rawLaunchStatus === 'failed' ||
    rawLaunchStatus === 'uncertain'
      ? rawLaunchStatus
      : 'idle';
  return {
    id,
    status,
    current: record.current === true,
    error: firstString(record, ['error']) || null,
    launchStatus,
    launchReservationId:
      firstString(record, ['launch_reservation_id', 'launchReservationId']) || null,
    launchStartedAt: firstString(record, ['launch_started_at', 'launchStartedAt']) || null,
    launchError: firstString(record, ['launch_error', 'launchError']) || null,
    launch: parseLaunchInfo(record.launch),
    summary: normalizeSummary(record.summary),
  };
}

function errorMessage(value: unknown, fallback: string): string {
  const record = asRecord(value);
  return (record && firstString(record, ['error'])) || fallback;
}

function stateFromAudit(
  audit: SegmentationAuditSnapshot,
): Omit<SegmentationAuditState, 'templateId'> | null {
  if (audit.status === 'pending' || audit.status === 'running' || audit.status === 'queued') return null;
  if (audit.status === 'failed' || audit.status === 'cancelled') {
    return {
      phase: 'error',
      audit,
      error: audit.error ?? 'Проверка сегментации завершилась ошибкой',
    };
  }
  if (audit.status !== 'ready' || !audit.summary) {
    return {
      phase: 'error',
      audit,
      error: 'Сервис вернул неполный отчёт сегментации',
    };
  }
  if (audit.launchStatus === 'running') return null;
  if (audit.launchStatus === 'uncertain') {
    return { phase: 'launch_uncertain', audit, error: null };
  }
  if (audit.launchStatus === 'succeeded') {
    return { phase: 'launch_succeeded', audit, error: null };
  }
  if (!audit.current) return { phase: 'stale', audit, error: null };
  const summaryComplete =
    audit.summary.status === 'complete' || audit.summary.status === 'not_required';
  if (!summaryComplete || audit.summary.unclassifiedCount > 0) {
    return { phase: 'incomplete', audit, error: null };
  }
  return { phase: 'ready', audit, error: null };
}

/**
 * Аудит запускается только явным действием пользователя. После POST читаем
 * серверный snapshot и опрашиваем его до terminal state; таймер и старые
 * ответы инвалидируются при смене шаблона и unmount.
 */
export function useSegmentationAudit(templateId: string | null) {
  const [state, setState] = useState<SegmentationAuditState>(IDLE_AUDIT_STATE);
  const [resolvingTemplateId, setResolvingTemplateId] = useState<string | null>(null);
  const [resolutionFailure, setResolutionFailure] = useState<{
    templateId: string;
    message: string;
  } | null>(null);
  const generationRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    clearPollTimer();
  }, [clearPollTimer, templateId]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      clearPollTimer();
    },
    [clearPollTimer],
  );

  const beginRead = useCallback((enqueue: boolean) => {
    if (!templateId) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    clearPollTimer();
    setResolutionFailure((current) =>
      current?.templateId === templateId ? null : current,
    );
    setState({ templateId, phase: 'loading', audit: null, error: null });

    const auditUrl = `${VE_API}/templates/${templateId}/segmentation-audit`;

    const readAudit = async (attempt: number): Promise<void> => {
      try {
        const response = await veEngineCall<AuditEnvelope>(auditUrl);
        if (generationRef.current !== generation) return;
        if (!response?.ok) {
          setState({
            templateId,
            phase: 'error',
            audit: null,
            error: errorMessage(response?.data, 'Не удалось получить отчёт сегментации'),
          });
          return;
        }

        const audit = normalizeAudit(response.data.audit);
        if (!audit) {
          setState({
            templateId,
            phase: 'error',
            audit: null,
            error: 'Сервис вернул неполный отчёт сегментации',
          });
          return;
        }

        const terminalState = stateFromAudit(audit);
        if (terminalState) {
          setState({ templateId, ...terminalState });
          return;
        }

        if (attempt >= AUDIT_POLL_ATTEMPTS) {
          setState({
            templateId,
            phase: 'error',
            audit,
            error: 'Проверка сегментации не завершилась вовремя',
          });
          return;
        }

        pollTimerRef.current = setTimeout(() => {
          pollTimerRef.current = null;
          void readAudit(attempt + 1);
        }, AUDIT_POLL_INTERVAL_MS);
      } catch {
        if (generationRef.current !== generation) return;
        setState({
          templateId,
          phase: 'error',
          audit: null,
          error: 'Не удалось получить отчёт сегментации',
        });
      }
    };

    if (!enqueue) {
      void readAudit(0);
      return;
    }
    void veEnginePost<AuditEnvelope>(auditUrl)
      .then((response) => {
        if (generationRef.current !== generation) return;
        if (!response?.ok) {
          setState({
            templateId,
            phase: 'error',
            audit: null,
            error: errorMessage(response?.data, 'Не удалось запустить проверку сегментации'),
          });
          return;
        }
        void readAudit(0);
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setState({
          templateId,
          phase: 'error',
          audit: null,
          error: 'Не удалось запустить проверку сегментации',
        });
      });
  }, [clearPollTimer, templateId]);

  const start = useCallback(() => beginRead(true), [beginRead]);
  const refresh = useCallback(() => beginRead(false), [beginRead]);

  const markRejected = useCallback(
    (phase: 'stale' | 'incomplete') => {
      generationRef.current += 1;
      clearPollTimer();
      setState((current) =>
        current.templateId === templateId && current.audit
          ? { ...current, phase, error: null }
          : current,
      );
    },
    [clearPollTimer, templateId],
  );

  const resolveLaunch = useCallback(
    async (resolution: 'no_campaign' | 'campaign_created', ids: string[] = []) => {
      if (!templateId) return;
      const currentAudit = state.templateId === templateId ? state.audit : null;
      const resolving = resolvingTemplateId === templateId;
      if (
        !currentAudit ||
        currentAudit.launchStatus !== 'uncertain' ||
        !currentAudit.launchReservationId ||
        resolving
      ) return;
      generationRef.current += 1;
      const generation = generationRef.current;
      clearPollTimer();
      setResolvingTemplateId(templateId);
      setResolutionFailure(null);
      try {
        const response = await veEnginePatch<AuditEnvelope>(
          `${VE_API}/templates/${templateId}/segmentation-audit`,
          {
            audit_id: currentAudit.id,
            launch_reservation_id: currentAudit.launchReservationId,
            resolution,
            confirm: true,
            ...(resolution === 'campaign_created' ? { campaign_ids: ids } : {}),
          },
        );
        if (generationRef.current !== generation) return;
        if (!response?.ok) {
          setResolutionFailure({
            templateId,
            message: errorMessage(response?.data, 'Не удалось сохранить результат сверки'),
          });
          return;
        }
        const resolvedAudit = normalizeAudit(response.data.audit);
        const resolvedState = resolvedAudit ? stateFromAudit(resolvedAudit) : null;
        if (!resolvedAudit || !resolvedState) {
          setResolutionFailure({
            templateId,
            message: 'Сервис вернул неполный результат сверки',
          });
          return;
        }
        setState({ templateId, ...resolvedState });
      } catch {
        if (generationRef.current === generation) {
          setResolutionFailure({
            templateId,
            message: 'Не удалось сохранить результат сверки',
          });
        }
      } finally {
        setResolvingTemplateId((current) => (current === templateId ? null : current));
      }
    },
    [clearPollTimer, resolvingTemplateId, state, templateId],
  );

  const visibleState = state.templateId === templateId ? state : IDLE_AUDIT_STATE;
  const resolving = resolvingTemplateId === templateId;
  const resolutionError =
    resolutionFailure?.templateId === templateId ? resolutionFailure.message : null;
  const canLaunch =
    visibleState.phase === 'ready' &&
    visibleState.audit?.status === 'ready' &&
    visibleState.audit.current &&
    (visibleState.audit.summary?.status === 'complete' ||
      visibleState.audit.summary?.status === 'not_required') &&
    visibleState.audit.summary.unclassifiedCount === 0 &&
    visibleState.audit.summary.launchableRows > 0;

  return {
    ...visibleState,
    start,
    refresh,
    markRejected,
    resolveLaunch,
    resolving,
    resolutionError,
    canLaunch,
    auditId: canLaunch ? visibleState.audit?.id ?? null : null,
    summary: visibleState.audit?.summary ?? null,
    launchInfo: visibleState.audit?.launch ?? null,
  };
}

export type SegmentationAuditController = ReturnType<typeof useSegmentationAudit>;

function LaunchRecoveryPanel({ audit }: { audit: SegmentationAuditController }): JSX.Element {
  const knownIds = audit.launchInfo?.campaigns?.length
    ? audit.launchInfo.campaigns.map((campaign) => campaign.campaign_id)
    : audit.launchInfo?.campaign_id
      ? [audit.launchInfo.campaign_id]
      : [];
  const [idsText, setIdsText] = useState(knownIds.join(', '));
  const ids = [
    ...new Set(
      idsText
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];

  return (
    <section
      className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3"
      aria-labelledby="segmentation-audit-title"
      role="alert"
    >
      <div>
        <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-amber-900">
          <StatusDot tone="warn" />
          Результат запуска нужно проверить
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-amber-900">
          Ответ Instantly был неоднозначным. Сначала откройте список кампаний и проверьте,
          появился ли запуск. Повтор заблокирован, чтобы не создать дубли.
        </p>
        {audit.audit?.launchError ? (
          <p className="mt-1 text-xs text-amber-800">Причина: {audit.audit.launchError}</p>
        ) : null}
        {audit.launchInfo?.campaign_url ? (
          <a
            href={audit.launchInfo.campaign_url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs font-medium text-amber-900 underline"
          >
            Открыть найденную кампанию в Instantly
          </a>
        ) : null}
      </div>

      <div>
        <label htmlFor="segmentation-launch-campaign-ids" className="text-xs font-medium text-gray-700">
          ID кампаний
        </label>
        <textarea
          id="segmentation-launch-campaign-ids"
          value={idsText}
          onChange={(event) => setIdsText(event.target.value)}
          rows={2}
          placeholder="campaign-id; если кампаний несколько — через запятую"
          className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-gray-800 outline-none transition focus:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-200"
        />
        <p className="mt-1 text-[11px] text-amber-800">
          Если кампаний несколько, укажите все ID — они попадут в запись запуска.
        </p>
      </div>

      {audit.resolutionError ? (
        <p className="text-xs text-red-700" role="alert">
          {audit.resolutionError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void audit.resolveLaunch('campaign_created', ids)}
          disabled={audit.resolving || ids.length === 0}
          className={HE.btnPrimary}
        >
          {audit.resolving ? 'Сохраняем…' : 'Кампания создана — зафиксировать'}
        </button>
        {knownIds.length === 0 ? (
          <button
            type="button"
            onClick={() => void audit.resolveLaunch('no_campaign')}
            disabled={audit.resolving}
            className={HE.btnGhost}
          >
            Кампании нет — разрешить повтор
          </button>
        ) : null}
      </div>
    </section>
  );
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
}

function formatShare(value: number): string {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function GroupExamples({ examples, groupName }: { examples: SegmentationAuditExample[]; groupName: string }) {
  if (examples.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5" aria-label={`Примеры: ${groupName}`}>
      {examples.map((example, index) => {
        const details = [
          example.email,
          ...example.fields.map((field) => `${field.label}: ${field.value}`),
        ].filter((value): value is string => Boolean(value));
        return (
          <li key={`${example.rowIndex ?? index}-${example.label}`} className="min-w-0 text-xs text-gray-500">
            <span className="font-medium text-gray-700">{example.label}</span>
            {details.length > 0 ? <span className="ml-1 break-words">· {details.join(' · ')}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function AuditGroupRow({ group, label }: { group: Omit<SegmentationAuditGroup, 'when'>; label: string }) {
  return (
    <li className="px-3 py-2.5 sm:px-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
        <p className="min-w-0 break-words text-sm font-medium text-gray-800">{label}</p>
        <span className="text-sm font-semibold tabular-nums text-gray-900" aria-label={`${formatCount(group.count)} получателей`}>
          {formatCount(group.count)}
        </span>
        <span className="text-xs text-gray-500">Доля получателей</span>
        <span className="text-xs tabular-nums text-gray-500">{formatShare(group.sharePct)}</span>
      </div>
      <GroupExamples examples={group.examples} groupName={label} />
    </li>
  );
}

function AuditReport({
  summary,
  complete = true,
  notRequired = false,
}: {
  summary: SegmentationAuditSummary;
  complete?: boolean;
  notRequired?: boolean;
}): JSX.Element {
  const excludedTotal = Object.values(summary.excluded).reduce((sum, count) => sum + count, 0);
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">
          {complete
            ? `${formatCount(summary.launchableRows)} получателей готовы к запуску`
            : `${formatCount(summary.launchableRows)} получателей в проверяемой аудитории`}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">
          Проверено строк базы: {formatCount(summary.totalBaseRows)}.{' '}
          {notRequired
            ? 'В шаблоне нет сегментных условий — все получатели используют основной текст.'
            : 'Раскладка ниже включает все условия, даже с нулевым результатом.'}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <ul className="divide-y divide-gray-100">
          {summary.segments.map((segment) => (
            <AuditGroupRow key={segment.when} group={segment} label={segment.when} />
          ))}
          <AuditGroupRow
            group={summary.defaultGroup}
            label={
              notRequired
                ? 'Основной текст — сегментация не требуется'
                : 'Основной текст — не совпали с условиями'
            }
          />
        </ul>
      </div>

      <div className="text-xs text-gray-500">
        <p className="font-medium text-gray-700">Исключено до запуска: {formatCount(excludedTotal)}</p>
        <ul className="mt-1 grid gap-x-5 gap-y-1 sm:grid-cols-2">
          <li>Низкая релевантность: {formatCount(summary.excluded.lowRelevance)}</li>
          <li>Не прошли email-проверку: {formatCount(summary.excluded.invalidEmailStatus)}</li>
          <li>Невалидный email: {formatCount(summary.excluded.invalidEmail)}</li>
          <li>Дубли email: {formatCount(summary.excluded.duplicateEmail)}</li>
        </ul>
      </div>
    </div>
  );
}

export function SegmentationAuditPanel({
  audit,
}: {
  audit: SegmentationAuditController;
}): JSX.Element | null {
  if (audit.phase === 'idle') return null;

  if (audit.phase === 'loading') {
    return (
      <section
        className="ve2-nt ve2-nt-info px-4 py-3"
        aria-labelledby="segmentation-audit-title"
        aria-busy="true"
      >
        <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-gray-800">
          <Spinner className="h-3.5 w-3.5 shrink-0" />
          Проверяем сегментацию перед запуском…
        </h3>
        <p className="mt-1 text-xs text-gray-500" aria-live="polite">
          Сверяем всех подходящих получателей и исключения. Запуск станет доступен только после
          полной проверки.
        </p>
      </section>
    );
  }

  if (audit.phase === 'launch_uncertain') {
    return <LaunchRecoveryPanel audit={audit} />;
  }

  if (audit.phase === 'launch_succeeded') {
    return (
      <section
        className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3"
        aria-labelledby="segmentation-audit-title"
        role="status"
        aria-live="polite"
      >
        <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <StatusDot tone="ok" />
          Проверенный запуск зафиксирован
        </h3>
        {audit.launchInfo?.campaign_url ? (
          <a
            href={audit.launchInfo.campaign_url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs text-emerald-800 underline"
          >
            Открыть в Instantly
          </a>
        ) : null}
      </section>
    );
  }

  if (audit.phase === 'error') {
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3" aria-labelledby="segmentation-audit-title">
        <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-red-800">
          <StatusDot tone="err" />
          Проверка не завершена
        </h3>
        <p className="mt-1 text-xs text-red-700" role="alert">
          {audit.error ?? 'Не удалось проверить сегментацию'}
        </p>
        <button type="button" onClick={audit.start} className={`${HE.btnSmall} mt-3`}>
          Повторить проверку
        </button>
      </section>
    );
  }

  if (audit.phase === 'stale') {
    return (
      <section
        className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
        aria-labelledby="segmentation-audit-title"
        role="status"
        aria-live="polite"
      >
        <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-amber-800">
          <StatusDot tone="warn" />
          Аудит устарел
        </h3>
        <p className="mt-1 text-xs text-amber-800">
          Шаблон или база уже отличаются от проверенной версии. Обновите раскладку перед запуском.
        </p>
        <button type="button" onClick={audit.start} className={`${HE.btnSmall} mt-3`}>
          Обновить проверку
        </button>
      </section>
    );
  }

  if (audit.phase === 'incomplete' && audit.summary) {
    const missing = audit.summary.unclassifiedCount;
    return (
      <section
        className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3"
        aria-labelledby="segmentation-audit-title"
        role="status"
        aria-live="polite"
      >
        <div>
          <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-amber-800">
            <StatusDot tone="warn" />
            Нужна повторная проверка
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            {missing > 0
              ? `${formatCount(missing)} получателя не проверены. Запуск заблокирован.`
              : 'Не все данные проверки подтверждены. Запуск заблокирован.'}
          </p>
          <button type="button" onClick={audit.start} className={`${HE.btnSmall} mt-3`}>
            Повторить проверку
          </button>
        </div>
        <AuditReport summary={audit.summary} complete={false} />
      </section>
    );
  }

  if (audit.phase === 'ready' && audit.summary?.launchableRows === 0) {
    return (
      <section
        className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3"
        aria-labelledby="segmentation-audit-title"
        role="status"
        aria-live="polite"
      >
        <div>
          <h3
            id="segmentation-audit-title"
            className="flex items-center gap-2 text-sm font-medium text-amber-800"
          >
            <StatusDot tone="warn" />
            Нет получателей для запуска
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            После фильтров качества, проверки email и удаления дублей база пуста. Кампании не
            будут созданы.
          </p>
        </div>
        <AuditReport
          summary={audit.summary}
          complete={false}
          notRequired={audit.summary.status === 'not_required'}
        />
      </section>
    );
  }

  if (audit.phase !== 'ready' || !audit.summary) return null;

  return (
    <section
      className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3"
      aria-labelledby="segmentation-audit-title"
      role="status"
      aria-live="polite"
    >
      <h3 id="segmentation-audit-title" className="flex items-center gap-2 text-sm font-medium text-emerald-800">
        <StatusDot tone="ok" />
        {audit.summary.status === 'not_required'
          ? 'Сегментация не требуется'
          : 'Сегментация проверена'}
      </h3>
      <AuditReport
        summary={audit.summary}
        notRequired={audit.summary.status === 'not_required'}
      />
    </section>
  );
}
