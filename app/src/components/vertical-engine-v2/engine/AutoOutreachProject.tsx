'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VeOutreachSetupResponse } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeOutreachRun } from '@/lib/verticalEngineV2/outreachLaunch';
import type { VeBaseAudienceSummary } from '@/lib/verticalEngineV2/baseAudienceSummary';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import {
  VE_API,
  veEngineCall,
  veEnginePost,
  veEnginePatch,
  type VeProjectDetailResponse,
  type VeProjectResponse,
  type VeJobResponse,
  type VeBaseSummary,
  type VePreparationAction,
  type VeContinuationCheck,
} from './api';
import { HE } from './design';
import { StatusBox, formatDate, prettyProjectName } from './ui';
import { StepNav } from './steps/StepNav';
import { Step1Research } from './steps/Step1Research';
import { DossierSegmentCard, DossierSignalsCard, DossierDatasetCard } from './steps/Step3Content';
import { BaseRow, BaseAnalysisCards } from './steps/Step4Base';
import { FinalLettersEditor } from './FinalLettersEditor';
import { OutreachLaunchPanel } from './OutreachLaunchPanel';
import { DeliveryRatePanel } from './DeliveryRatePanel';
import { ContactUploadModePanel, type ContactUploadMode } from './ContactUploadModePanel';
import { DeliveryTargetPanel } from './DeliveryTargetPanel';
import { CampaignProgress } from './CampaignProgress';
import { ManualBaseLibrary } from './ManualBaseLibrary';
import { ManualHypothesisForm } from './ManualHypothesisForm';
import { PriorityNichesEditor, PriorityNicheResults, type PriorityNichesEditorHandle } from './PriorityNichesEditor';
import { ProjectExclusions } from './ProjectExclusions';
import { DownloadVerifiedContacts } from './DownloadVerifiedContacts';
import { CombinedContactsDownload } from './CombinedContactsDownload';
import { AudienceScopeSummary } from './AudienceScopeSummary';
import { PreparationProgress, getPreparationPresentation, getPreparationActionNotice,
  refreshPreparationRequestNotice, type PreparationPresentation, type PreparationRequestNotice } from './PreparationProgress';
import { selectHypothesisLetters, selectHypothesisPreparationBase, selectPreparationHypotheses } from './letterSelection';
import { collectCount, isPartialPreview } from './collectionProgress';
import { ContactLimitField, parseContactLimitDraft } from './ContactLimitField';
import { getVeLaunchSelectionState, getVePreparedBaseState, isVeHypothesisLaunchPending } from './launchSelection';
import { VeAutomaticContinuationChecks, veAutomaticContinuationCandidates, veAutomaticContinuationResultCurrent } from './automaticContinuationCheck';
import {
  VE_BROAD_HYPOTHESES_EMPTY_NOTE,
  VE_BROAD_HYPOTHESES_NOTE,
  VE_BROAD_HYPOTHESES_TITLE,
  groupVeHypotheses,
  veBroadHypothesesAction,
} from './hypothesisGroups';

const LABELS = ['Гипотезы', 'Письма', 'Базы и объём', 'Запуск', 'Результаты'];
const RUN_LABELS = {
  queued: 'Ожидает подготовки кампаний',
  running: 'Подготавливаем кампании без отправки',
  waiting: 'Проверяем состояние кампаний в Instantly',
  active: 'Кампании подготовлены в Instantly',
  blocked: 'Запуск требует внимания',
  cancelled: 'Запуск остановлен',
};
type ProjectData = Required<
  Pick<
    VeProjectDetailResponse,
    'project' | 'jobs' | 'verticals' | 'hypotheses' | 'bases' | 'templates' | 'dossiers' | 'cases'
  >
>;

export function AudienceSummary({
  base,
  presetId,
  preparationState,
  onCount,
}: {
  base: VeBaseSummary;
  presetId: string;
  preparationState: PreparationPresentation;
  onCount?: (baseId: string, count: number | null) => void;
}) {
  const baseId = base.id;
  const [data, setData] = useState<VeBaseAudienceSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await veEngineCall<VeBaseAudienceSummary & { error?: string }>(
          `${VE_API}/bases/${baseId}/audience${presetId ? `?preset_id=${encodeURIComponent(presetId)}` : ''}`,
        );
        if (cancelled) return;
        if (!response.ok) {
          setError(response.data.error ?? 'Не удалось пересчитать запас');
          setData(null);
          onCount?.(baseId, null);
          return;
        }
        setData(response.data);
        setError('');
        onCount?.(baseId, response.data.checked_ready);
      } catch {
        if (!cancelled) {
          setError('Не удалось обновить объём. Проверьте соединение');
          onCount?.(baseId, null);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [baseId, presetId, onCount]);
  if (error) return <StatusBox tone="error">{error}</StatusBox>;
  if (!data)
    return (
      <p role="status" className={HE.muted}>
        Считаем готовые контакты…
      </p>
    );
  const preparedForLaunch = data.client_exclusions_applied
    ? `Новых контактов для резерва запуска: ${data.ready.toLocaleString('ru-RU')}. Исключения клиента и контакты, уже распределённые в кампании проекта, учтены.`
    : `До ${data.ready.toLocaleString('ru-RU')} контактов попадут в резерв запуска. Повторы с уже подготовленными кампаниями проекта исключены; точное число пересчитаем после выбора клиента и применения его списка исключений.`;
  const partial = isPartialPreview(base);
  const target = base.collect_info?.target_progress;
  const counted = collectCount(target?.ready_rows);
  const goal = collectCount(target?.ready_target ?? data.preview_target);
  const companies = collectCount(target?.ready_companies ?? data.observed_yield?.ready_companies);
  const perCompany = collectCount(target?.counted_per_company);
  const readyForReview = base.status === 'analyzed' && preparationState.currentStep === 3;
  return (
    <div className="space-y-3">
      <div className="ve2-stats">
        <div className="ve2-stat">
          <p className="ve2-stat-v">
            {data.checked_ready.toLocaleString('ru-RU')}
          </p>
          <p className="ve2-stat-k">Проверенных контактов</p>
        </div>
        <div className="ve2-stat">
          <p className="ve2-stat-v">
            {companies === null ? '—' : companies.toLocaleString('ru-RU')}
          </p>
          <p className="ve2-stat-k">Проверенных компаний</p>
        </div>
        <div className="ve2-stat">
          <p className="ve2-stat-v">
            {data.processed_candidates === null ? '—' : data.processed_candidates.toLocaleString('ru-RU')}
          </p>
          <p className="ve2-stat-k">Проверено кандидатов</p>
        </div>
      </div>
      <p className={HE.muted}>{partial
        ? readyForReview
          ? 'Проверенные контакты можно скачать и согласовать для запуска. Добор до цели не обязателен. Откройте «Контакты базы и скачивание» ниже.'
          : data.checked_ready > 0
            ? 'Проверенные контакты можно посмотреть и скачать ниже. Готовность к согласованию зависит от завершения разбора базы и подготовки писем. Текущий этап указан выше.'
            : preparationState.guidance?.action === 'wait'
              ? 'Контакты появятся здесь после проверки. Текущий этап подготовки показан выше.'
              : 'Контактов, прошедших все проверки, пока нет. Состояние подготовки и дальнейшие действия указаны выше.'
        : preparedForLaunch}</p>
      {partial && readyForReview ? <p className={HE.muted}>{preparedForLaunch}</p> : null}
      {!partial || readyForReview ? <p className={HE.faint}>
        На шаге «Запуск» выберите загрузку всех готовых контактов сразу или дневными порциями.
        Общая цель проекта учитывает все запущенные гипотезы.
      </p> : null}
      <details>
        <summary className="ve2-link cursor-pointer">Расчёт объёма и прогноз</summary>
        <div className="mt-2 space-y-2">
          {goal !== null ? <p className={HE.muted}>
            Цель сбора: {goal.toLocaleString('ru-RU')} контактов.
            {counted !== null ? ` В неё засчитано ${counted.toLocaleString('ru-RU')}.` : ''}
            {perCompany ? ` При расчёте цели учитывается не больше ${perCompany} адресов одной компании.` : ''}
            {' '}Это правило управления добором. Все {data.checked_ready.toLocaleString('ru-RU')} проверенных контактов сохранены в базе.
          </p> : null}
          {data.observed_yield ? (
            <p className={HE.muted}>
              Проверено кандидатов: {data.observed_yield.candidates.toLocaleString('ru-RU')}. Получено готовых
              контактов: {data.observed_yield.ready.toLocaleString('ru-RU')}. Выход:{' '}
              {(data.observed_yield.contacts_per_candidate * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%.
            </p>
          ) : null}
          {data.preview_target !== null && data.checked_ready > data.preview_target ? (
            <p className={HE.muted}>
              В базе сохранены все проверенные контакты. CSV-превью содержит первые {data.preview_target.toLocaleString('ru-RU')} контактов.
            </p>
          ) : null}
          {data.estimate ? <p className={HE.muted}>
            Предварительная оценка добора: ~{data.estimate.contacts.toLocaleString('ru-RU')} контактов
            {data.estimate.companies !== undefined ? ` (≈${data.estimate.companies.toLocaleString('ru-RU')} компаний)` : ''}.
            {' '}Это оценка новых компаний, а не дополнительных адресов уже найденных. Она не гарантирует, что текущие источники дадут новые контакты, и не означает, что добор идёт.
          </p> : null}
          <p className={HE.muted}>
            {data.estimate
              ? `Оценка с низкой уверенностью от ${formatDate(data.estimate.as_of)}. `
                + (data.estimate.remaining_companies !== undefined
                  ? `В срезе реестра осталось ${data.estimate.remaining_companies.toLocaleString('ru-RU')} компаний, которые база ещё не смотрела; `
                  : '')
                + `прогноз предполагает у них такой же выход, как у уже проверенных. ${data.estimate.scope}`
                + (data.client_exclusions_applied ? ' Список исключений клиента применится при загрузке и в прогноз не входит.' : '')
              : data.estimate_reason}
          </p>
          <p className={HE.muted}>
            Исключено по блокировкам: {data.excluded_blocked}. Уже распределено в кампании: {data.excluded_used}.
          </p>
        </div>
      </details>
    </div>
  );
}

export function AutoOutreachProject({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ProjectData | null>(null);
  const [snapshot, setSnapshot] = useState<VeOutreachSetupResponse | null>(null);
  const [run, setRun] = useState<VeOutreachRun | null>(null);
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [preparationNotice, setPreparationNotice] = useState<PreparationRequestNotice | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contactLimitDraft, setContactLimitDraft] = useState<string | null>(null);
  const [launchHypothesisIds, setLaunchHypothesisIds] = useState<string[]>([]);
  const [checkedContactCounts, setCheckedContactCounts] = useState<Record<string, number | null>>({});
  const updateCheckedContactCount = useCallback((baseId: string, count: number | null) => {
    setCheckedContactCounts((current) => current[baseId] === count ? current : { ...current, [baseId]: count });
  }, []);
  const [researchBusy, setResearchBusy] = useState(false);
  const researchRequestRef = useRef(false);
  const priorityNichesRef = useRef<PriorityNichesEditorHandle>(null);
  const [priorityNichesDirty, setPriorityNichesDirty] = useState(false);
  const [broadRequesting, setBroadRequesting] = useState(false);
  const [activeHypothesis, setActiveHypothesis] = useState('');
  const [activeLetterBaseId, setActiveLetterBaseId] = useState<string | undefined>();
  const resultTemplateToFocus = useRef<string | null>(null);
  const [presetId, setPresetId] = useState('');
  const dirtyRef = useRef(false);
  const libraryDirtyRef = useRef(false);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const libraryDirtyChange = useCallback((value: boolean) => {
    libraryDirtyRef.current = value;
  }, []);
  const dirtyChange = useCallback((value: boolean) => {
    dirtyRef.current = value;
  }, []);
  const topRef = useRef<HTMLDivElement | null>(null);
  const initialVisit = useRef(true);
  const refreshBusy = useRef(false);
  // A GET already in flight must not erase an additive save that completed later.
  const detailMutationRevision = useRef(0);
  const continuationChecks = useRef(new VeAutomaticContinuationChecks());
  const continuationContext = useRef<{ enabled: boolean; input: Parameters<typeof veAutomaticContinuationCandidates>[0] } | null>(null);
  const continuationRequest = useRef<AbortController | null>(null);
  const continuationActionEpoch = useRef(0);
  const continuationMounted = useRef(false);
  const [continuationTick, setContinuationTick] = useState(0);
  useEffect(() => {
    continuationMounted.current = true;
    return () => { continuationMounted.current = false; continuationRequest.current?.abort(); };
  }, []);
  const refresh = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    setRefreshing(true);
    const readRevision = detailMutationRevision.current;
    try {
      const results = await Promise.all([
        veEngineCall<VeProjectDetailResponse>(`${VE_API}/projects/${projectId}`),
        veEngineCall<VeOutreachSetupResponse>(`${VE_API}/projects/${projectId}/outreach`),
        veEngineCall<{ run: VeOutreachRun | null; error?: string }>(`${VE_API}/projects/${projectId}/outreach/start`),
      ]);
      const [project, setup, launch] = results;
      if (project.ok && project.data.project && readRevision === detailMutationRevision.current)
        setDetail({
          project: project.data.project,
          jobs: project.data.jobs ?? [],
          verticals: project.data.verticals ?? [],
          hypotheses: project.data.hypotheses ?? [],
          bases: project.data.bases ?? [],
          templates: project.data.templates ?? [],
          dossiers: project.data.dossiers ?? [],
          cases: project.data.cases ?? [],
        });
      if (setup.ok)
        setSnapshot((current) =>
          !current || setup.data.setup.revision >= current.setup.revision ? setup.data : current,
        );
      if (project.ok && setup.ok && readRevision === detailMutationRevision.current) {
        setPreparationNotice((current) => refreshPreparationRequestNotice(current, {
          preparations: setup.data.preparations, bases: project.data.bases ?? [], jobs: project.data.jobs ?? [],
        }));
      }
      if (launch.ok)
        setRun((current) =>
          !current || (launch.data.run && launch.data.run.updated_at >= current.updated_at) ? launch.data.run : current,
        );
      const failed = results.find((r) => !r.ok);
      if (failed) setRefreshError('Не удалось обновить все статусы. Ниже показаны последние полученные данные.');
      else {
        setRefreshError('');
        setLastRefreshedAt(Date.now());
      }
      if (initialVisit.current && project.ok && setup.ok && launch.ok) {
        initialVisit.current = false;
        if (
          launch.data.run ||
          project.data.templates?.some((t) =>
            parseLaunchInfo((t as VeTemplate & { launch_info?: unknown }).launch_info),
          )
        )
          setStep(5);
        else if (setup.data.preparations.length || project.data.bases?.some((base) => base.collect_info?.collection_mode !== 'supply'))
          setStep(3);
      }
    } catch {
      setRefreshError('Не удалось обновить статус. Проверьте соединение. Ниже показаны последние полученные данные.');
    } finally {
      refreshBusy.current = false;
      setRefreshing(false);
    }
  }, [projectId]);
  const uploadModeSaved = useCallback((mode: ContactUploadMode) => {
    detailMutationRevision.current += 1;
    setDetail(current => current ? { ...current, project: { ...current.project, contact_upload_mode: mode } } : current);
    void refresh();
  }, [refresh]);
  const uploadMode = detail?.project.contact_upload_mode === 'all_ready' ? 'all_ready' : 'daily';
  const working =
    detail?.jobs.some((j) => ['pending', 'running'].includes(j.status)) ||
    snapshot?.preparations.some(
      (p) =>
        !p.paused_at && !p.cancelled_at &&
        (p.independent_control || snapshot.setup.selected_hypothesis_ids.includes(p.hypothesis_id)) &&
        ['pending', 'collecting', 'generating'].includes(p.status),
    ) ||
    (run && ['queued', 'running', 'waiting'].includes(run.status));
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), working ? 4000 : 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh, working]);
  const locked = !!run && ['queued', 'running', 'waiting'].includes(run.status);
  const contactLimit = snapshot?.setup.max_emails_per_company ?? null;
  const contactLimitText = contactLimitDraft ?? (contactLimit === null ? '' : String(contactLimit));
  const parsedContactLimit = parseContactLimitDraft(contactLimitText);
  const contactLimitUnsaved = !parsedContactLimit.valid || parsedContactLimit.value !== contactLimit;
  const selectedIds = snapshot?.setup.selected_hypothesis_ids ?? [];
  const selectedPausedCount = snapshot?.preparations.filter((item) => item.paused_at && selectedIds.includes(item.hypothesis_id)).length ?? 0;
  const resultTemplates = (detail?.templates ?? []).filter((t) => {
    const base = detail?.bases.find((b) => b.id === t.base_id);
    return (
      base?.collect_info?.collection_mode !== 'supply' &&
      (!!parseLaunchInfo((t as VeTemplate & { launch_info?: unknown }).launch_info) ||
        run?.items.some((item) => item.template_id === t.id))
    );
  });
  useEffect(() => {
    if (step !== 5 || !resultTemplateToFocus.current) return;
    const card = document.getElementById(`ve-campaign-${resultTemplateToFocus.current}`);
    resultTemplateToFocus.current = null;
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'start' });
  }, [step]);
  const visibleHypotheses = selectPreparationHypotheses(detail?.hypotheses ?? [], selectedIds,
    snapshot?.preparations ?? [], detail?.bases ?? []);
  const titles = useMemo(
    () => Object.fromEntries((detail?.hypotheses ?? []).map((h) => [h.id, h.title])),
    [detail?.hypotheses],
  );
  const activeId = visibleHypotheses.some((item) => item.id === activeHypothesis) ? activeHypothesis : (visibleHypotheses[0]?.id ?? '');
  const preparation = snapshot?.preparations.find((p) => p.hypothesis_id === activeId);
  const { base: preparationBase, canPauseOrphan: canPauseActiveOrphan } = selectHypothesisPreparationBase(
    activeId, preparation, detail?.bases ?? [], detail?.jobs ?? []);
  useEffect(() => {
    if (!detail || !snapshot) { continuationContext.current = null; return; }
    const input = { projectId, step, activeHypothesisId: activeId, setupRevision: snapshot.setup.revision,
      visibleHypothesisIds: selectPreparationHypotheses(detail.hypotheses, snapshot.setup.selected_hypothesis_ids,
        snapshot.preparations, detail.bases).map((item) => item.id), preparations: snapshot.preparations,
      selectedHypothesisIds: snapshot.setup.selected_hypothesis_ids,
      bases: detail.bases, jobs: detail.jobs,
      launchedBaseIds: new Set(detail.templates.filter((item) => (item as VeTemplate & { launch_info?: unknown }).launch_info != null).map((item) => item.base_id)) };
    const enabled = !busy && !locked && !contactLimitUnsaved && (step === 2 || step === 3);
    continuationContext.current = { enabled, input };
    if (!enabled) return;
    const queue = continuationChecks.current;
    const next = queue.next(veAutomaticContinuationCandidates(input), Date.now());
    if (!next.candidate) {
      if (next.retryAt === undefined) return;
      const timer = setTimeout(() => setContinuationTick((value) => value + 1), Math.max(0, next.retryAt - Date.now()));
      return () => clearTimeout(timer);
    }
    const candidate = next.candidate;
    if (!queue.start(candidate, Date.now())) return;
    const actionEpoch = continuationActionEpoch.current;
    const controller = new AbortController();
    continuationRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 35_000);
    // This request only reads one saved checkpoint and caches a decision. It
    // never calls change()/Prepare, changes the step or locks other controls.
    void (async () => {
      let retry = false;
      try {
        const response = await veEngineCall<{ continuation_check?: VeContinuationCheck }>(`${VE_API}/projects/${candidate.projectId}/outreach`, {
          method: 'POST', signal: controller.signal,
          body: JSON.stringify({ action: 'check_continuation', check_only: true,
            revision: candidate.setupRevision, hypothesis_id: candidate.hypothesisId }),
        });
        const checked = response.data.continuation_check;
        retry = response.status >= 500 || response.status === 429 || (response.ok && (!checked || checked.code === 'state_changed'));
        const context = continuationContext.current;
        if (!continuationMounted.current || !response.ok || !checked || !context?.enabled
          || actionEpoch !== continuationActionEpoch.current) return;
        const current = veAutomaticContinuationCandidates(context.input).find((item) => item.baseId === candidate.baseId);
        if (!veAutomaticContinuationResultCurrent(candidate, checked, current)) return;
        detailMutationRevision.current += 1;
        setDetail((latest) => {
          if (!latest || actionEpoch !== continuationActionEpoch.current) return latest;
          const match = veAutomaticContinuationCandidates({ ...context.input, bases: latest.bases, jobs: latest.jobs })
            .find((item) => item.baseId === candidate.baseId);
          if (!veAutomaticContinuationResultCurrent(candidate, checked, match)) return latest;
          return { ...latest, bases: latest.bases.map((base) => base.id === candidate.baseId ? { ...base,
            collection_continuation: { available: checked.status === 'available', action: checked.action,
              code: checked.code!, reason: checked.reason } } : base) };
        });
      } catch { retry = true; }
      finally {
        clearTimeout(timeout);
        queue.finish(candidate, retry, Date.now());
        if (continuationRequest.current === controller) continuationRequest.current = null;
        if (continuationMounted.current) setContinuationTick((value) => value + 1);
      }
    })();
  }, [projectId, step, activeId, detail, snapshot, busy, locked, contactLimitUnsaved, continuationTick]);
  const { template, previous: previousLetters } = selectHypothesisLetters(
    activeId, preparation, detail?.bases ?? [], detail?.templates ?? [], activeLetterBaseId,
  );
  const guardLeave = () =>
    (!dirtyRef.current && !libraryDirtyRef.current) ||
    window.confirm('Есть несохранённые правки писем. Перейти без сохранения?');
  const jump = (next: number) => {
    if (!guardLeave()) return false;
    setStep(next);
    topRef.current?.scrollIntoView({ block: 'start' });
    return true;
  };
  // Approval and launch may explicitly add a saved hypothesis to the selection.
  // This never requests preparation for it or for the other selected hypotheses.
  const selectForAction = async (current: VeOutreachSetupResponse, ids: readonly string[]) => {
    const added = ids.filter((id) => !current.setup.selected_hypothesis_ids.includes(id));
    if (!added.length) return current;
    const result = await veEnginePost<VeOutreachSetupResponse>(`${VE_API}/projects/${projectId}/outreach`, {
      action: 'select', revision: current.setup.revision, language: current.setup.language,
      hypothesis_ids: [...current.setup.selected_hypothesis_ids, ...added],
    });
    if (!result.ok) throw new Error(result.data.error ?? 'Не удалось выбрать базу для запуска.');
    setSnapshot((latest) => !latest || result.data.setup.revision >= latest.setup.revision ? result.data : latest);
    return result.data;
  };
  const change = async (payload: Record<string, unknown>) => {
    const pausing = payload.action === 'pause';
    const noticeHypothesisId = typeof payload.hypothesis_id === 'string' ? payload.hypothesis_id : null;
    if (!snapshot || busy || (locked && (!pausing || !noticeHypothesisId || isVeHypothesisLaunchPending(run, noticeHypothesisId)))) return;
    if (payload.action === 'prepare' && contactLimitUnsaved) {
      setError('Сначала примените лимит адресов на шаге «Гипотезы».');
      return;
    }
    // Invalidate immediately, before React's effects observe busy/new setup.
    // A check started earlier cannot replace a specialist's newer action.
    continuationActionEpoch.current += 1;
    continuationContext.current = null;
    setBusy(true);
    setError('');
    const preparing = payload.action === 'prepare';
    setPreparationNotice(preparing || pausing
      ? { hypothesisId: noticeHypothesisId, checking: true, tone: 'info',
        ...(pausing ? { operation: 'pause' as const } : {}),
        message: pausing ? 'Приостанавливаем подготовку… Дождитесь подтверждения.' : 'Проверяем возможность продолжения…' } : null);
    try {
      let requestSnapshot = snapshot;
      if (payload.action === 'approve') {
        const hypothesisId = detail?.bases.find((base) => base.id === payload.base_id)?.hypothesis_id;
        if (hypothesisId) requestSnapshot = await selectForAction(snapshot, [hypothesisId]);
      }
      const result = await veEnginePost<VeOutreachSetupResponse & { preparation_action?: VePreparationAction }>(`${VE_API}/projects/${projectId}/outreach`, {
        revision: requestSnapshot.setup.revision,
        ...payload,
      });
      if (!result.ok) {
        if (preparing) {
          setPreparationNotice({ hypothesisId: noticeHypothesisId,
            keepUntilStateChanges: result.data.preparation_action?.status === 'unavailable',
            ...(result.data.preparation_action ? getPreparationActionNotice(result.data.preparation_action)
              : { tone: 'error', message: result.data.error ?? 'Не удалось продолжить подготовку.' }) });
          await refresh();
        } else if (pausing) {
          setPreparationNotice({ hypothesisId: noticeHypothesisId, operation: 'pause', keepUntilStateChanges: true, tone: 'error',
            message: result.data.error ?? 'Не удалось приостановить подготовку. Обновите статус перед повторной попыткой.' });
          await refresh();
        } else setError(result.data.error ?? 'Не удалось сохранить выбор');
        return;
      }
      setSnapshot((current) => !current || result.data.setup.revision >= current.setup.revision ? result.data : current);
      if (payload.action === 'select') setLaunchHypothesisIds([]);
      if (payload.action === 'select' && payload.next_run === true) setStep(1);
      if (preparing) {
        const outcome = result.data.preparation_action;
        setPreparationNotice({ hypothesisId: noticeHypothesisId, keepUntilStateChanges: outcome?.status === 'unavailable',
          ...getPreparationActionNotice(outcome) });
        // No-op/rejected continuations stay beside the base that was clicked.
        // A queued response means waiting for a worker, not active collection.
        if (outcome?.status !== 'unavailable' && outcome?.status !== 'ready')
          setStep((current) => current === 3 ? 3 : 2);
        await refresh();
      }
      if (pausing) {
        const paused = result.data.preparations.some((item) => item.hypothesis_id === noticeHypothesisId && item.paused_at);
        setPreparationNotice({ hypothesisId: noticeHypothesisId, operation: 'pause', tone: 'info',
          message: paused ? 'Подготовка приостановлена. Сохранённые результаты доступны.' : 'Состояние подготовки изменилось. Обновляем статус.' });
        await refresh();
      }
      // Finished bases are re-partitioned by the worker right after the save.
      if (payload.action === 'contact_limit') {
        setContactLimitDraft(null);
        await refresh();
      }
    } catch {
      if (preparing) setPreparationNotice({ hypothesisId: noticeHypothesisId, tone: 'error',
        message: 'Ответ не получен. Обновите статус, прежде чем повторять подготовку.' });
      else if (pausing) setPreparationNotice({ hypothesisId: noticeHypothesisId, operation: 'pause', keepUntilStateChanges: true, tone: 'error',
        message: 'Подтверждение паузы не получено. Обновите статус, прежде чем повторять.' });
      else setError('Не удалось сохранить решение. Проверьте соединение');
    } finally {
      setBusy(false);
    }
  };
  const research = async () => {
    if (researchRequestRef.current) return;
    researchRequestRef.current = true;
    setError('');
    try {
      if (priorityNichesRef.current && !(await priorityNichesRef.current.save())) return;
      setResearchBusy(true);
      const result = await veEnginePost<VeJobResponse>(`${VE_API}/projects/${projectId}/research`);
      if (!result.ok) setError(result.data.error ?? 'Не удалось начать исследование');
      else await refresh();
    } catch {
      setError('Не удалось начать исследование. Проверьте соединение');
    } finally {
      researchRequestRef.current = false;
      setResearchBusy(false);
    }
  };
  const addBroadHypotheses = async () => {
    setBroadRequesting(true);
    setError('');
    try {
      const result = await veEnginePost<VeJobResponse>(`${VE_API}/projects/${projectId}/broad-hypotheses`);
      if (!result.ok) setError(result.data.error ?? 'Не удалось запустить добавление широких гипотез');
      else await refresh();
    } catch {
      setError('Не удалось запустить добавление широких гипотез. Проверьте соединение');
    } finally {
      setBroadRequesting(false);
    }
  };
  const saveOffer = async (value: string) => {
    setError('');
    try {
      const result = await veEnginePatch<VeProjectResponse>(`${VE_API}/projects/${projectId}`, {
        offer_override: value,
      });
      if (!result.ok) setError(result.data.error ?? 'Не удалось сохранить предложение');
      else await refresh();
    } catch {
      setError('Не удалось сохранить предложение. Проверьте соединение');
    }
  };
  const runDossier = async (id: string) => {
    setError('');
    try {
      const response = await veEnginePost<VeJobResponse>(`${VE_API}/verticals/${id}/dossier`);
      if (!response.ok) setError(response.data.error ?? 'Не удалось собрать досье');
      else await refresh();
    } catch {
      setError('Не удалось собрать досье. Проверьте соединение');
    }
  };
  const restoreHypothesis = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const response = await veEnginePatch<{ error?: string }>(`${VE_API}/hypotheses/${id}`, { status: 'proposed' });
      if (!response.ok) setError(response.data.error ?? 'Не удалось вернуть гипотезу');
      else await refresh();
    } catch {
      setError('Не удалось вернуть гипотезу. Проверьте соединение');
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (
      !window.confirm(
        locked
          ? 'Отменить ожидающий запуск и незавершённую подготовку? Уже работающие кампании продолжат отправку.'
          : 'Остановить подготовку писем и баз? Уже готовые результаты сохранятся. Отправка существующих кампаний продолжится.',
      )
    )
      return;
    setError('');
    try {
      const response = await veEnginePost<{ error?: string }>(`${VE_API}/projects/${projectId}/cancel`);
      if (!response.ok) setError(response.data.error ?? 'Не удалось остановить подготовку');
      else await refresh();
    } catch {
      setError('Не удалось остановить подготовку. Проверьте соединение');
    }
  };
  const configureLaunch = async (ids: string[]) => {
    if (!snapshot || busy || locked) return;
    if (contactLimitUnsaved) {
      setError('Сначала примените лимит адресов на шаге «Гипотезы».');
      return;
    }
    if (!ids.length || ids.some((id) => !getVePreparedBaseState(snapshot, detail?.templates ?? [], id).ready)) {
      setError('Выберите готовые и одобренные базы для запуска.');
      return;
    }
    if (!guardLeave()) return;
    setError('');
    continuationActionEpoch.current += 1;
    continuationContext.current = null;
    setBusy(true);
    try {
      const selected = await selectForAction(snapshot, ids);
      if (ids.some((id) => !getVeLaunchSelectionState(selected, detail?.templates ?? [], id).ready)) {
        setError('Состояние базы изменилось. Проверьте базу и согласование перед запуском.');
        return;
      }
      setLaunchHypothesisIds(ids);
      setStep(4);
      topRef.current?.scrollIntoView({ block: 'start' });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось подготовить выбор для запуска.');
    } finally { setBusy(false); }
  };
  if (!detail) return <StatusBox tone={error || refreshError ? 'error' : 'info'}>{error || refreshError || 'Загружаем проект…'}</StatusBox>;
  const hasJobs = detail.jobs.some((j) => ['pending', 'running'].includes(j.status));
  const researchRunning = researchBusy || detail.project.status === 'researching' || detail.jobs.some((job) =>
    ['site_profile', 'competitors', 'brand_cloud', 'hypotheses', 'evidence', 'clustering'].includes(job.stage) &&
    ['pending', 'running'].includes(job.status));
  const launchStates = Object.fromEntries(visibleHypotheses.map(({ id }) => [id, getVePreparedBaseState(snapshot, detail.templates, id)]));
  const readyForLaunchCount = Object.values(launchStates).filter((state) => state.ready).length;
  const chosenLaunchReady = launchHypothesisIds.length > 0 && launchHypothesisIds.every((id) => launchStates[id]?.ready);
  const statusRefresh = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className={HE.muted}>
        Статус обновляется автоматически.
        {lastRefreshedAt ? ` Проверено в ${new Date(lastRefreshedAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.` : ''}
      </p>
      <button type="button" className={HE.btnQuiet} disabled={refreshing} onClick={() => void refresh()}>
        Обновить статус
      </button>
    </div>
  );
  const picker =
    visibleHypotheses.length > 1 ? (
      <label className="block ve2-label mb-5">
        Гипотеза
        <select
          aria-label="Гипотеза"
          className={`${HE.input} mt-2 w-full`}
          value={activeId}
          onChange={(e) => {
            if (guardLeave()) { setActiveHypothesis(e.target.value); setActiveLetterBaseId(undefined); }
          }}
        >
          {visibleHypotheses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.title}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  const manualHypotheses = detail.hypotheses.filter((hypothesis) =>
    hypothesis.origin === 'manual' && detail.verticals.some((vertical) => vertical.id === hypothesis.vertical_id));
  const generatedHypotheses = detail.hypotheses.filter((hypothesis) => hypothesis.origin !== 'manual');
  const manualVerticalIds = new Set(manualHypotheses.map((hypothesis) => hypothesis.vertical_id));
  const generatedVerticals = detail.verticals.filter((vertical) =>
    !manualVerticalIds.has(vertical.id) || generatedHypotheses.some((hypothesis) => hypothesis.vertical_id === vertical.id));
  const hypothesisGroups = groupVeHypotheses(generatedVerticals, generatedHypotheses);
  const broadAction = veBroadHypothesesAction({
    jobs: detail.jobs,
    hypotheses: detail.hypotheses,
    requesting: broadRequesting,
    researchRunning,
  });
  const contextMutationBusy = researchRunning || broadAction.running;
  const contextMutationReason = broadAction.running
    ? 'Дождитесь завершения генерации широких гипотез.' : undefined;
  // Широкие дописываются только к исследованному проекту: без вертикалей кнопки нет.
  const broadControl = detail.verticals.length ? (
    <div className="ve2-broad-action">
      <button
        type="button"
        className={HE.btnGhost}
        disabled={broadAction.disabled}
        aria-busy={broadAction.running || undefined}
        onClick={() => void addBroadHypotheses()}
      >
        {broadAction.label}
      </button>
      {broadAction.error ? <p className="ve2-t-dan" role="alert">{broadAction.error}</p> : null}
      {broadAction.note ? <p className={HE.muted}>{broadAction.note}</p> : null}
    </div>
  ) : null;
  const renderHypothesis = (h: (typeof detail.hypotheses)[number]) => (
    <div
      key={h.id}
      className="ve2-hypothesis-option"
      data-selected={selectedIds.includes(h.id) || undefined}
      data-rejected={h.status === 'rejected' || undefined}
    >
      <label className="ve2-hypothesis-label">
        <input
          type="checkbox"
          className="ve2-cbx"
          aria-label={h.title}
          aria-describedby={`hypothesis-description-${h.id}`}
          checked={selectedIds.includes(h.id)}
          disabled={busy || locked || h.status === 'rejected' || !snapshot}
          onChange={(e) =>
            void change({
              action: 'select',
              language: snapshot?.setup.language ?? 'ru',
              hypothesis_ids: e.target.checked
                ? [...selectedIds, h.id]
                : selectedIds.filter((id) => id !== h.id),
            })
          }
        />
        <span className="ve2-hypothesis-copy">
          <span className="ve2-h3">{h.title}</span>
          <AudienceScopeSummary id={`hypothesis-description-${h.id}`} scope={h.audience_scope} description={h.description} />
        </span>
      </label>
      <div className="ve2-hypothesis-meta">
        {h.status === 'rejected' ? (
          <button
            type="button"
            disabled={busy || locked}
            className={HE.btnQuiet}
            onClick={() => void restoreHypothesis(h.id)}
          >
            Вернуть отклонённую гипотезу
          </button>
        ) : null}
        {h.origin === 'manual' ? <span className={`text-sm ${HE.muted}`}>Добавлена специалистом</span> : null}
        {h.origin !== 'manual' || h.evidence?.length ? <details className="ve2-hypothesis-evidence">
          <summary className="ve2-link">Доказательства · {h.evidence?.length ?? 0}</summary>
          <div className="ve2-evidence-content">
            {h.fit_rationale ? <p className={HE.muted}><span className="font-medium">Почему подходит: </span>{h.fit_rationale}</p> : null}
            {(h.evidence ?? []).map((ev, i) => (
              <div key={i} className="ve2-evidence-item">
                <p>{ev.claim}</p>
                {ev.quote ? <blockquote className={HE.muted}>{ev.quote}</blockquote> : null}
                {/^https?:\/\//i.test(ev.source_url ?? '') ? (
                  <a className="ve2-link" href={ev.source_url} target="_blank" rel="noreferrer">
                    Источник
                  </a>
                ) : null}
              </div>
            ))}
            {!h.evidence?.length ? (
              <p className={HE.muted}>Подтверждающих источников пока нет.</p>
            ) : null}
          </div>
        </details> : null}
      </div>
    </div>
  );
  return (
    <div ref={topRef} className="ve2-project">
      <div className="flex flex-wrap justify-between items-start gap-3 mb-6">
        <div>
          <button
            type="button"
            className={HE.btnQuiet}
            onClick={() => {
              if (guardLeave()) onBack();
            }}
          >
            Все проекты
          </button>
          <h1 className="ve2-h1 mt-3">{prettyProjectName(detail.project.name, detail.project.website_url)}</h1>
        </div>
        {hasJobs || locked ? (
          <button type="button" className={HE.btnGhost} onClick={() => void cancel()}>
            {locked ? 'Отменить ожидающий запуск' : 'Остановить подготовку'}
          </button>
        ) : null}
      </div>
      <ProjectExclusions key={projectId} projectId={projectId} onSaved={() => void refresh()} />
      <details className="ve2-panel-line mb-6" open={detail.project.status !== 'researched'}>
        <summary className="ve2-link cursor-pointer p-4">Данные клиента и исследование</summary>
        <div className="p-4">
          <PriorityNichesEditor
            key={projectId}
            ref={priorityNichesRef}
            project={detail.project}
            disabled={contextMutationBusy}
            disabledReason={contextMutationReason}
            onDirtyChange={setPriorityNichesDirty}
            onSaved={(project) => {
              detailMutationRevision.current += 1;
              setDetail((current) => current ? { ...current, project } : current);
            }}
          />
          <Step1Research
            project={detail.project}
            jobs={detail.jobs}
            busy={researchRunning}
            onStartResearch={() => void research()}
            onGoToVerticals={() => jump(1)}
            offerValue={
              typeof detail.project.brief?.offer_override === 'string' ? detail.project.brief.offer_override : ''
            }
            onSaveOffer={saveOffer}
            cases={detail.cases ?? []}
            onCasesChanged={() => void refresh()}
          />
        </div>
      </details>
      {error ? (
        <div className="mb-5">
          <StatusBox tone="error">{error}</StatusBox>
        </div>
      ) : null}
      {refreshError ? <div className="mb-5"><StatusBox tone="error">{refreshError}</StatusBox></div> : null}
      {preparationNotice && preparationNotice.hypothesisId === null ? <div className="mb-5">
        <StatusBox tone={preparationNotice.tone}>{preparationNotice.message}</StatusBox>
      </div> : null}
      <div className="ve2-wiz">
        <aside className="ve2-rail min-w-0">
          <StepNav
            steps={LABELS.map((label, i) => ({
              id: i + 1,
              label,
              subtitle: '',
              state:
                step === i + 1
                  ? 'active'
                  : i === 4 && !run && !resultTemplates.length
                    ? 'locked'
                    : i > 0 && i < 4 && !visibleHypotheses.length
                      ? 'locked'
                      : 'available',
            }))}
            onJump={jump}
          />
        </aside>
        <main className="min-w-0 ve2-workspace">
          {step === 1 ? (
            <section className="ve2-hypothesis-step">
              <header className="ve2-hypothesis-intro">
                <h2 className="ve2-h2">Выберите гипотезы</h2>
                <p className={HE.muted}>
                  Флажки выбирают гипотезы для общей подготовки. Сохранённые базы и письма доступны независимо от выбора.
                  Приостановить отдельную подготовку можно в «Базы и объём».
                </p>
              </header>
              {detail.project.status === 'researched' && detail.verticals.length > 0 ? (
                <ManualHypothesisForm
                  key={projectId}
                  projectId={projectId}
                  disabled={contextMutationBusy}
                  disabledReason={contextMutationReason}
                  onCreated={({ hypothesis, vertical }) => {
                    detailMutationRevision.current += 1;
                    setDetail((current) => current ? {
                      ...current,
                      hypotheses: current.hypotheses.some((item) => item.id === hypothesis.id)
                        ? current.hypotheses : [...current.hypotheses, hypothesis],
                      verticals: current.verticals.some((item) => item.id === vertical.id)
                        ? current.verticals : [...current.verticals, vertical],
                    } : current);
                    void refresh();
                  }}
                />
              ) : null}
              {!priorityNichesDirty ? <PriorityNicheResults brief={detail.project.brief} /> : null}
              <div className="ve2-vertical-list">
                {manualHypotheses.length > 0 ? (
                  <section className="ve2-vertical-group" aria-labelledby="manual-hypotheses-title">
                    <header className="ve2-vertical-header">
                      <div className="ve2-vertical-title-row">
                        <h3 id="manual-hypotheses-title" className="ve2-vertical-title">Свои гипотезы</h3>
                        <span className="ve2-vertical-count">Гипотез: {manualHypotheses.length}</span>
                      </div>
                    </header>
                    <div className="ve2-hypothesis-list">{manualHypotheses.map(renderHypothesis)}</div>
                  </section>
                ) : null}
                {hypothesisGroups.broad.length ? (
                  <section className="ve2-vertical-group ve2-broad-group" aria-labelledby="broad-hypotheses-title">
                    <header className="ve2-vertical-header">
                      <div className="ve2-vertical-title-row">
                        <h3 id="broad-hypotheses-title" className="ve2-vertical-title">{VE_BROAD_HYPOTHESES_TITLE}</h3>
                        <span className="ve2-vertical-count">Гипотез: {hypothesisGroups.broad.length}</span>
                      </div>
                      <p className={HE.muted}>{VE_BROAD_HYPOTHESES_NOTE}</p>
                      {broadControl}
                    </header>
                    <div className="ve2-hypothesis-list">{hypothesisGroups.broad.map(renderHypothesis)}</div>
                  </section>
                ) : broadControl ? (
                  <section className="ve2-vertical-group ve2-broad-group" aria-labelledby="broad-hypotheses-title">
                    <header className="ve2-vertical-header ve2-broad-empty">
                      <h3 id="broad-hypotheses-title" className="ve2-vertical-title">{VE_BROAD_HYPOTHESES_TITLE}</h3>
                      <p className={HE.muted}>{VE_BROAD_HYPOTHESES_EMPTY_NOTE}</p>
                      {broadControl}
                    </header>
                  </section>
                ) : null}
                {hypothesisGroups.verticals.map(({ vertical, hypotheses }) => {
                  const dossier = detail.dossiers?.find(
                    (d) => d.vertical_id === vertical.id && d.status === 'ready' && d.data,
                  );
                  const dossierBusy = detail.jobs.some(
                    (j) =>
                      j.stage === 'dossier' &&
                      j.payload?.vertical_id === vertical.id &&
                      ['pending', 'running'].includes(j.status),
                  );
                  return (
                    <article key={vertical.id} className="ve2-vertical-group" aria-labelledby={`vertical-${vertical.id}`}>
                      <header className="ve2-vertical-header">
                        <div className="ve2-vertical-title-row">
                          <h3 id={`vertical-${vertical.id}`} className="ve2-vertical-title">{vertical.name}</h3>
                          <span className="ve2-vertical-count">Гипотез: {hypotheses.length}</span>
                        </div>
                        {vertical.summary ? <p className={HE.muted}>{vertical.summary}</p> : null}
                        <details className="ve2-vertical-dossier">
                          <summary className="ve2-link">Досье вертикали</summary>
                          <div className="ve2-dossier-content">
                            {dossier?.data ? (
                              <>
                                <DossierSegmentCard data={dossier.data} />
                                <DossierSignalsCard data={dossier.data} />
                                <DossierDatasetCard data={dossier.data} />
                              </>
                            ) : (
                              <p className={HE.muted}>Досье ещё не подготовлено.</p>
                            )}
                            <button
                              type="button"
                              disabled={dossierBusy}
                              className={HE.btnGhost}
                              onClick={() => void runDossier(vertical.id)}
                            >
                              {dossierBusy ? 'Собираем досье…' : dossier ? 'Обновить досье' : 'Собрать досье'}
                            </button>
                          </div>
                        </details>
                      </header>
                      <div className="ve2-hypothesis-list">
                        {hypotheses.map(renderHypothesis)}
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="ve2-hypothesis-actions">
                <label className="ve2-label ve2-hypothesis-language">
                  Язык писем
                  <select
                    aria-label="Язык писем"
                    className={HE.input}
                    value={snapshot?.setup.language ?? 'ru'}
                    disabled={busy || locked || !!snapshot?.preparations.length || !snapshot}
                    onChange={(event) =>
                      void change({ action: 'select', hypothesis_ids: selectedIds, language: event.target.value })
                    }
                  >
                    <option value="ru">Русский</option>
                    <option value="en">English</option>
                    <option value="pl">Polski</option>
                  </select>
                </label>
                <ContactLimitField
                  value={contactLimit}
                  draft={contactLimitText}
                  disabled={busy || locked || !snapshot}
                  onDraftChange={setContactLimitDraft}
                  onSave={(next) => void change({ action: 'contact_limit', max_emails_per_company: next })}
                />
                <div className="ve2-hypothesis-submit">
                  <span className={HE.muted} aria-live="polite">Выбрано: {selectedIds.length}</span>
                  <button
                    type="button"
                    disabled={busy || locked || selectedIds.length === selectedPausedCount || contactLimitUnsaved}
                    className={HE.btnPrimary}
                    onClick={() => void change({ action: 'prepare' })}
                  >
                    Подготовить письма и базы
                  </button>
                </div>
                {selectedPausedCount > 0 ? <p className={HE.muted}>
                  На паузе: {selectedPausedCount}. Общая подготовка их не возобновит. Продолжайте каждую отдельно в «Базы и объём».
                </p> : null}
              </div>
            </section>
          ) : null}
          {step === 2 ? (
            <section className="space-y-5">
              <h2 className="ve2-h2">Итоговые письма</h2>
              {statusRefresh}
              {picker}
              {previousLetters ? <StatusBox tone="info">
                Это ранее созданные письма этой гипотезы. Они доступны для просмотра.
                Текущая подготовка показана на шаге «Базы и объём».
              </StatusBox> : null}
              {template ? (
                <FinalLettersEditor
                  key={template.id}
                  templateId={template.id}
                  readOnly={previousLetters}
                  onDirtyChange={dirtyChange}
                  onSaved={refresh}
                />
              ) : (
                <>
                  <PreparationProgress
                    context="letters"
                    preparation={preparation}
                    preparationSelected={selectedIds.includes(activeId)}
                    hypothesisTitle={titles[activeId]}
                    canPauseOrphan={canPauseActiveOrphan && visibleHypotheses.some((item) => item.id === activeId && item.status !== 'rejected' && !!item.vertical_id)}
                    base={preparationBase}
                    jobs={detail.jobs}
                    onStart={activeId ? () => void change({ action: 'prepare', hypothesis_id: activeId }) : undefined}
                    onPause={() => void change({ action: 'pause', hypothesis_id: activeId })}
                    onContinue={() => void change({ action: 'prepare', hypothesis_id: activeId })}
                    continueDisabled={busy || locked}
                    pauseDisabled={busy || isVeHypothesisLaunchPending(run, activeId)}
                    pauseDisabledReason={isVeHypothesisLaunchPending(run, activeId) ? 'Эта база входит в текущий запуск. Его статус доступен в «Результатах».' : undefined}
                    prepareDisabled={contactLimitUnsaved}
                    actionNotice={preparationNotice?.hypothesisId === activeId ? preparationNotice : null}
                  />
                </>
              )}
              <button type="button" className={HE.btnPrimary} onClick={() => jump(3)}>
                Посмотреть базы и объём
              </button>
            </section>
          ) : null}
          {step === 3 ? (
            <section className="space-y-6">
              <h2 className="ve2-h2">Базы и доступный объём</h2>
              <p className={HE.muted}>Здесь сохраняются все подготовленные базы. Начинайте, приостанавливайте и продолжайте каждую отдельно. Пауза сохраняет контакты, письма и согласования.</p>
              {statusRefresh}
              <CombinedContactsDownload key={projectId} projectId={projectId} hypotheses={detail.hypotheses.filter(hypothesis =>
                detail.bases.some(base => base.hypothesis_id === hypothesis.id && base.source === 'auto'))} />
              {contactLimitUnsaved ? <StatusBox tone="info">
                Изменение лимита ещё не применено. Перед запуском сохраните его на шаге «Гипотезы».
                <button type="button" className={HE.btnQuiet} onClick={() => jump(1)}>К настройке лимита</button>
              </StatusBox> : null}
              {readyForLaunchCount > 0 ? <div className="space-y-3">
                <h3 className="ve2-h3">Одобрены и готовы к запуску: {readyForLaunchCount}</h3>
                <p className={HE.muted}>
                  Выберите одну или несколько одобренных баз. Остальные могут продолжать подготовку.
                  На следующем шаге выберите клиента и подготовьте кампанию. Отправку вы включите в Instantly.
                </p>
                <div className="divide-y divide-[var(--ve2-line)]">
                  {visibleHypotheses.filter((h) => launchStates[h.id]?.ready || launchHypothesisIds.includes(h.id)).map((h) => {
                    const state = launchStates[h.id];
                    const selected = launchHypothesisIds.includes(h.id);
                    const p = snapshot?.preparations.find((row) => row.hypothesis_id === h.id);
                    const base = detail.bases.find((row) => row.id === p?.base_id);
                    return (
                      <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <label className="flex min-w-0 flex-1 items-start gap-3">
                          <input type="checkbox" className="ve2-cbx mt-1"
                            aria-label={`Включить «${h.title}» в запуск`}
                            checked={selected} disabled={busy || locked || (!state.ready && !selected)}
                            onChange={(event) => setLaunchHypothesisIds((current) => event.target.checked
                              ? [...current, h.id] : current.filter((id) => id !== h.id))} />
                          <span className="min-w-0">
                            <span className="block font-medium">{h.title}</span>
                            <span className={`block ${HE.muted}`}>{state.label}
                              {base && checkedContactCounts[base.id] != null
                                ? ` · проверенных контактов: ${checkedContactCounts[base.id]!.toLocaleString('ru-RU')}` : ''}</span>
                          </span>
                        </label>
                        <button type="button" className={HE.btnGhost}
                          aria-label={`Запустить отдельно: ${h.title}`}
                          disabled={!state.ready || busy || locked || contactLimitUnsaved}
                          onClick={() => configureLaunch([h.id])}>Запустить отдельно</button>
                      </div>
                    );
                  })}
                </div>
                {locked ? <p className={HE.muted}>Предыдущий запуск ещё обрабатывается. Его статус доступен в «Результатах».</p> : null}
                <button type="button" className={HE.btnPrimary}
                  disabled={!chosenLaunchReady || busy || locked || contactLimitUnsaved}
                  onClick={() => configureLaunch(launchHypothesisIds)}>
                  К запуску выбранных ({launchHypothesisIds.length})
                </button>
              </div> : null}
              {visibleHypotheses.map((h) => {
                const p = snapshot?.preparations.find((p) => p.hypothesis_id === h.id);
                const savedBases = detail.bases.filter((base) => base.hypothesis_id === h.id && base.collect_info?.collection_mode !== 'supply');
                const { base, canPauseOrphan } = selectHypothesisPreparationBase(h.id, p, detail.bases, detail.jobs);
                const historicalBases = savedBases.filter((item) => item.id !== base?.id);
                const savedLetters = selectHypothesisLetters(h.id, p, detail.bases, detail.templates).template;
                const launchedTemplate = resultTemplates.find((item) => item.id === p?.template_id)
                  ?? resultTemplates.find((item) => item.base_id === base?.id);
                const review = base ? snapshot?.reviews[base.id] : null,
                  approval = base ? snapshot?.setup.approved_bases[base.id] : null;
                const approved =
                  !!review && approval?.revision === review.revision && approval.template_id === review.template_id;
                const preparationState = getPreparationPresentation({ preparation: p, preparationSelected: selectedIds.includes(h.id), base, jobs: detail.jobs });
                return (
                  <article key={h.id} className="border-t border-[var(--ve2-line)] pt-5 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="ve2-h3">{h.title}</h3>
                      <DownloadVerifiedContacts projectId={projectId} hypothesisId={h.id} hypothesisTitle={h.title} />
                    </div>
                    {launchStates[h.id]?.launched ? (
                      <button type="button" className={HE.btnGhost}
                        aria-label={`Управлять добором: ${h.title}`}
                        onClick={() => {
                          if (jump(5)) resultTemplateToFocus.current = launchedTemplate?.id ?? null;
                        }}>Управлять добором</button>
                    ) : null}
                    {!launchStates[h.id]?.launched ? <PreparationProgress compact preparation={p} base={base} jobs={detail.jobs} approved={approved}
                      preparationSelected={selectedIds.includes(h.id)} hypothesisTitle={h.title}
                      canPauseOrphan={canPauseOrphan && h.status !== 'rejected' && !!h.vertical_id}
                      onStart={() => void change({ action: 'prepare', hypothesis_id: h.id })}
                      onPause={() => void change({ action: 'pause', hypothesis_id: h.id })}
                      onContinue={launchStates[h.id]?.launched ? undefined : () => void change({ action: 'prepare', hypothesis_id: h.id })}
                      continueDisabled={busy || locked}
                      pauseDisabled={busy || isVeHypothesisLaunchPending(run, h.id)}
                      pauseDisabledReason={isVeHypothesisLaunchPending(run, h.id) ? 'Эта база входит в текущий запуск. Его статус доступен в «Результатах».' : undefined}
                      prepareDisabled={contactLimitUnsaved || h.status === 'rejected'}
                      actionNotice={preparationNotice?.hypothesisId === h.id ? preparationNotice : null} /> : null}
                    {savedLetters ? <button type="button" className={HE.btnGhost} aria-label={`Посмотреть письма: ${h.title}`} onClick={() => {
                      if (jump(2)) { setActiveHypothesis(h.id); setActiveLetterBaseId(undefined); }
                    }}>Посмотреть письма</button> : null}
                    {approval && (p?.status !== 'ready' || p.paused_at) ? <p className={HE.muted}>
                      Ранее вы согласовали базу и письма. Согласование сохранено; после завершения подготовки система проверит актуальность этой версии.
                    </p> : null}
                    {base ? (
                      <>
                        <AudienceSummary base={base} presetId={presetId} preparationState={preparationState}
                          onCount={updateCheckedContactCount} />
                        <details>
                          <summary className="ve2-link cursor-pointer">Контакты базы и скачивание</summary>
                          <div className="mt-3">
                            <BaseRow
                              base={base}
                              job={detail.jobs.find(
                                (j) => j.payload?.base_id === base.id && j.stage === 'base_collect',
                              )}
                              preparationState={preparationState}
                              queued={false}
                              onUpdated={() => void refresh()}
                            />
                          </div>
                        </details>
                        {base.analysis ? (
                          <details>
                            <summary className="ve2-link cursor-pointer">
                              Разбор базы: кто внутри и почему подходит
                            </summary>
                            <div className="mt-3">
                              <BaseAnalysisCards analysis={base.analysis} />
                            </div>
                          </details>
                        ) : null}
                        {!launchStates[h.id]?.launched && review && p?.status === 'ready' && !p.paused_at ? <>
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="ve2-cbx mt-1"
                            checked={approved}
                            aria-label={`Базу и письма проверил, одобряю для запуска: ${h.title}`}
                            disabled={busy || locked}
                            onChange={(e) =>
                              void change({
                                action: 'approve',
                                base_id: base.id,
                                template_id: review?.template_id,
                                reviewed_revision: review?.revision,
                                approved: e.target.checked,
                              })
                            }
                          />
                          <span>Базу и письма проверил, одобряю для запуска</span>
                        </label>
                        {launchStates[h.id]?.ready ? <button type="button" className={HE.btnPrimary}
                          aria-label={`К запуску этой базы: ${h.title}`}
                          disabled={busy || locked || contactLimitUnsaved}
                          onClick={() => configureLaunch([h.id])}>К запуску этой базы</button>
                        : <p className={HE.muted}>{launchStates[h.id]?.label}</p>}
                        </> : !launchStates[h.id]?.launched && p?.status === 'ready' && !p.paused_at ? <p className={HE.muted}>
                          Одобрение появится после подтверждения актуальной версии базы и писем. Статус обновляется автоматически.
                        </p> : null}
                      </>
                    ) : null}
                    {historicalBases.length ? <details>
                      <summary className="ve2-link cursor-pointer">Ранее сохранённые базы: {historicalBases.length}</summary>
                      <div className="mt-3 space-y-4">{historicalBases.map((historical) => <div key={historical.id} className="space-y-2">
                        <BaseRow base={historical} queued={false} onUpdated={() => void refresh()} />
                        {selectHypothesisLetters(h.id, p, detail.bases, detail.templates, historical.id).template ?
                          <button type="button" className={HE.btnGhost} onClick={() => {
                            if (jump(2)) { setActiveHypothesis(h.id); setActiveLetterBaseId(historical.id); }
                          }}>Посмотреть письма этой базы</button> : null}
                      </div>)}</div>
                    </details> : null}
                  </article>
                );
              })}
              <p className={HE.muted}>
                Контакты разных гипотез могут пересекаться. Перед отправкой система исключит повторы.
              </p>
              <details>
                <summary className="ve2-link cursor-pointer">Настройки сбора</summary>
                <div className="mt-3 space-y-2">
                  <p className={HE.muted}>
                    Сохранённый лимит адресов на компанию: {contactLimit ?? 'без ограничения'}.
                    {' '}Запущенные базы сохраняют свои настройки.
                  </p>
                  <button type="button" className={HE.btnQuiet} onClick={() => jump(1)}>
                    Изменить на шаге «Гипотезы»
                  </button>
                </div>
              </details>
            </section>
          ) : null}
          {step === 4 && snapshot ? contactLimitUnsaved ? (
            <section className="space-y-3">
              <StatusBox tone="info">Перед запуском примените изменённый лимит адресов на шаге «Гипотезы».</StatusBox>
              <button type="button" className={HE.btnGhost} onClick={() => jump(1)}>К настройке лимита</button>
            </section>
          ) : (
            <OutreachLaunchPanel
              key={launchHypothesisIds.join(',') || 'empty'}
              projectId={projectId}
              snapshot={snapshot}
              uploadMode={uploadMode}
              onUploadModeSaved={uploadModeSaved}
              templates={detail.templates}
              titles={titles}
              hypothesisIds={launchHypothesisIds}
              onBack={() => jump(3)}
              onPresetChange={setPresetId}
              onStarted={(value) => {
                setRun(value);
                setLaunchHypothesisIds([]);
                setStep(5);
                void refresh();
              }}
            />
          ) : null}
          {step === 5 ? (
            <section className="space-y-5">
              <h2 className="ve2-h2">{run?.status === 'waiting' && run.items.some(item => item.code === 'VE_LAUNCH_REVIEW_REQUIRED')
                ? 'Кампании ожидают проверки специалиста' : run ? RUN_LABELS[run.status] : 'Результаты'}</h2>
              {run?.error ? <StatusBox tone="error">{run.error}</StatusBox> : null}
              {run ? <ContactUploadModePanel key={projectId} projectId={projectId} mode={uploadMode}
                disabled={busy || ['queued', 'running'].includes(run.status)} onSaved={uploadModeSaved} /> : null}
              {run?.request.target_contacts ? <DeliveryTargetPanel key={projectId} projectId={projectId} uploadMode={uploadMode}
                disabled={busy || ['queued', 'running', 'waiting'].includes(run.status)} onSaved={() => void refresh()} /> : null}
              {run?.request.preset_id && run.items.length ? <DeliveryRatePanel projectId={projectId}
                presetId={run.request.preset_id} templateIds={run.items.map(item => item.template_id)}
                disabled={busy || ['queued', 'running'].includes(run.status)} supplyOnly={uploadMode === 'all_ready'} /> : null}
              {!locked && resultTemplates.length ? (
                <button
                  type="button"
                  className={HE.btnGhost}
                  disabled={busy}
                  onClick={() => jump(3)}
                >
                  Выбрать другую базу для запуска
                </button>
              ) : null}
              {run?.items.map((item) => (
                <div key={item.hypothesis_id}>
                  <h3 className="ve2-h3">{titles[item.hypothesis_id]}</h3>
                  <p className={HE.muted}>
                    {item.error ??
                      {
                        queued: 'В очереди',
                        approving: 'Фиксируем согласование',
                        creating: 'Создаём кампании',
                        activating: 'Сверяем состояние кампаний',
                        waiting: 'Ожидаем подтверждения состояния из Instantly',
                        active: 'Подготовка завершена. Отправкой управляет специалист в Instantly.',
                        blocked: 'Требует внимания',
                      }[item.status]}
                  </p>
                </div>
              ))}
              {resultTemplates.map((t) => {
                const base = detail.bases.find((b) => b.id === t.base_id);
                const hypothesisId =
                  base?.hypothesis_id ?? run?.items.find((item) => item.template_id === t.id)?.hypothesis_id;
                return (
                  <CampaignProgress
                    key={t.id}
                    template={t}
                    uploadMode={uploadMode}
                    required={base?.source === 'auto' && base.collect_info?.collection_mode === 'preview'}
                    title={hypothesisId ? (titles[hypothesisId] ?? 'Гипотеза') : (base?.filename ?? 'Кампания')}
                    headerAction={hypothesisId ? <DownloadVerifiedContacts projectId={projectId} hypothesisId={hypothesisId} /> : undefined}
                  />
                );
              })}
              {detail.verticals
                .filter((v) => v.actual_measured_at)
                .map((v) => (
                  <div key={v.id} className="border-t border-[var(--ve2-line)] pt-4">
                    <h3 className="ve2-h3">{v.name} · статистика вертикали</h3>
                    <p className={HE.muted}>
                      Отправлено: {v.actual_sent ?? '—'}. Ответили:{' '}
                      {v.actual_reply_pct == null ? '—' : `${v.actual_reply_pct}%`}. Обновлено:{' '}
                      {formatDate(v.actual_measured_at!)}.
                    </p>
                  </div>
                ))}
            </section>
          ) : null}
        </main>
      </div>
      <details
        className="ve2-panel-line mt-8"
        onToggle={(event) => {
          if (event.currentTarget.open) setLibraryLoaded(true);
        }}
      >
        <summary className="ve2-link cursor-pointer p-4">Свои и прежние базы</summary>
        <div className="p-4">
          {libraryLoaded ? (
            <ManualBaseLibrary
              projectId={projectId}
              verticals={detail.verticals}
              hypotheses={detail.hypotheses}
              bases={detail.bases}
              templates={detail.templates}
              jobs={detail.jobs}
              parentPollingActive
              onUpdated={refresh}
              onDirtyChange={libraryDirtyChange}
            />
          ) : null}
        </div>
      </details>
    </div>
  );
}
