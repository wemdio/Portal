'use client';

/**
 * Детальный вид проекта «Движка вертикалей» — пошаговый мастер:
 * 1. Исследование → 2. Вертикали → 3. Контент → 4. База → 5. Шаблон.
 * Экраны шагов живут в ./steps/ и соблюдают контракт пропсов; этот компонент —
 * данные (поллинг GET /projects/[id] каждые 4 сек, пока есть джобы
 * pending/running), навигация, авто-переходы и все API-обработчики.
 * Технические детали (сырая таблица джоб) спрятаны в блок «Подробности».
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VeHypothesisStatus, VeProjectStatus, VeStage } from '@/lib/verticalEngineV2/types';
import {
  VE_API,
  veEngineCall,
  veEnginePatch,
  veEnginePost,
  type VeHypothesisResponse,
  type VeJobResponse,
  type VeJobSummary,
  type VeProjectDetailResponse,
  type VeProjectResponse,
} from './api';
import { StepNav, type VeWizardStep } from './steps/StepNav';
import { Step1Research } from './steps/Step1Research';
import { Step2Verticals } from './steps/Step2Verticals';
import { Step3Content } from './steps/Step3Content';
import { Step4Base } from './steps/Step4Base';
import { Step5Template } from './steps/Step5Template';
import { HE, StatusDot } from './design';
import { Badge, ProjectStatusBadge, StatusBox, formatDate, prettyHost, prettyProjectName } from './ui';

const POLL_INTERVAL_MS = 4000;

/** localStorage-ключ выбранной вертикали проекта. */
const selectedVerticalKey = (projectId: string) => `he.sel.${projectId}`;

/** localStorage-ключ метки последнего визита проекта (ISO-время). */
const visitKey = (projectId: string) => `he.visit.${projectId}`;

const STEP_DEFS = [
  { id: 1, label: 'Исследование', subtitle: 'анализируем рынок' },
  { id: 2, label: 'Вертикали', subtitle: 'выбираем направление' },
  { id: 3, label: 'Контент', subtitle: 'черновик писем и вокабуляр' },
  { id: 4, label: 'База', subtitle: 'загружаем контакты' },
  { id: 5, label: 'Шаблон', subtitle: 'готовый текст в работу' },
] as const;

/**
 * Payload загрузки базы контактов. Собирается экраном шага 4 (и легаси-BasesTab);
 * тип экспортируется отсюда для обратной совместимости.
 */
export interface BaseUploadPayload {
  vertical_id: string;
  filename: string;
  columns: string[];
  rows: Array<Record<string, string>>;
}

export function ProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<VeProjectDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [actionError, setActionError] = useState('');

  // Текущий шаг мастера и самый далёкий посещённый (нужен для «шаг 2 пройден»).
  const [step, setStep] = useState(1);
  const [maxVisitedStep, setMaxVisitedStep] = useState(1);
  const [selectedVerticalId, setSelectedVerticalId] = useState<string | null>(null);

  const [researchStarting, setResearchStarting] = useState(false);
  const [offerSaving, setOfferSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Короткое уведомление «Шаблон собирается…» после запуска сборки.
  const [templateNotice, setTemplateNotice] = useState(false);
  const templateNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Блок «С последнего визита»: база — метка предыдущего визита из localStorage
  // (null = первый визит, блок не показываем); dismissed — скрыт до следующего визита.
  const [visitBaseline, setVisitBaseline] = useState<string | null>(null);
  const [visitDismissed, setVisitDismissed] = useState(false);
  const visitTrackedRef = useRef(false);

  const jumpTo = useCallback((next: number) => {
    setStep(next);
    setMaxVisitedStep((prev) => Math.max(prev, next));
  }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      // Первая загрузка = начало визита: запоминаем метку прошлого визита как базу
      // и сразу пишем «сейчас» — от неё отсчитается следующий визит.
      if (!visitTrackedRef.current) {
        visitTrackedRef.current = true;
        try {
          const prevVisit = window.localStorage.getItem(visitKey(projectId));
          window.localStorage.setItem(visitKey(projectId), new Date().toISOString());
          setVisitBaseline(prevVisit);
        } catch {
          // localStorage недоступен — блок «С последнего визита» просто не появится.
        }
      }
      try {
        const { ok, data } = await veEngineCall<VeProjectDetailResponse>(`${VE_API}/projects/${projectId}`);
        if (!ok) {
          setErrorMsg(data.error || 'Не удалось загрузить проект');
          return;
        }
        setDetail(data);
        setErrorMsg('');
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Восстанавливаем выбранную вертикаль проекта из localStorage.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(selectedVerticalKey(projectId));
      if (saved) setSelectedVerticalId(saved);
    } catch {
      // localStorage недоступен — начинаем без выбора.
    }
  }, [projectId]);

  const jobs = useMemo(() => detail?.jobs ?? [], [detail]);
  const hasActiveJobs = jobs.some((j) => j.status === 'pending' || j.status === 'running');

  // Поллим, пока есть активные джобы (research, chain, vocab, base_analyze, template).
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => void load({ silent: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveJobs, load]);

  const project = detail?.project;
  const briefOffer = project?.brief?.offer_override;
  const savedOffer = typeof briefOffer === 'string' ? briefOffer : '';
  const researchRunning =
    researchStarting ||
    project?.status === 'researching' ||
    jobs.some(
      (j) =>
        (j.status === 'pending' || j.status === 'running') &&
        ['site_profile', 'competitors', 'brand_cloud', 'hypotheses', 'evidence', 'clustering'].includes(j.stage),
    );

  // Авто-переход: исследование завершилось, а пользователь на шаге 1 → шаг 2.
  // Срабатывает и на первой загрузке: проект уже researched → стартуем с шага 2.
  const prevStatusRef = useRef<VeProjectStatus | undefined>(undefined);
  useEffect(() => {
    const status = project?.status;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status === 'researched' && prev !== 'researched' && step === 1) jumpTo(2);
  }, [project?.status, step, jumpTo]);

  /* ── Производные данные выбранной вертикали ── */

  const verticals = useMemo(() => detail?.verticals ?? [], [detail]);
  const hypotheses = useMemo(() => detail?.hypotheses ?? [], [detail]);
  const dossiers = useMemo(() => detail?.dossiers ?? [], [detail]);
  const cases = useMemo(() => detail?.cases ?? [], [detail]);
  // Полные списки артефактов — доска шага 2 показывает, что собрано по каждой вертикали.
  const chains = useMemo(() => detail?.chains ?? [], [detail]);
  const vocabs = useMemo(() => detail?.vocabs ?? [], [detail]);
  const bases = useMemo(() => detail?.bases ?? [], [detail]);
  const templates = useMemo(() => detail?.templates ?? [], [detail]);
  const selectedVertical = useMemo(
    () => verticals.find((v) => v.id === selectedVerticalId) ?? null,
    [verticals, selectedVerticalId],
  );
  const selectedChains = useMemo(
    () => (detail?.chains ?? []).filter((c) => c.vertical_id === selectedVerticalId),
    [detail, selectedVerticalId],
  );
  const selectedVocabs = useMemo(
    () => (detail?.vocabs ?? []).filter((v) => v.vertical_id === selectedVerticalId),
    [detail, selectedVerticalId],
  );
  // Выбранная база — последняя по дате загрузки база выбранной вертикали.
  const selectedBases = useMemo(
    () =>
      (detail?.bases ?? [])
        .filter((b) => b.vertical_id === selectedVerticalId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [detail, selectedVerticalId],
  );
  const selectedBase = selectedBases[0] ?? null;
  // Шаблон — последний собранный для выбранной базы.
  const selectedTemplate = useMemo(() => {
    if (!selectedBase) return null;
    const list = (detail?.templates ?? [])
      .filter((t) => t.base_id === selectedBase.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return list[0] ?? null;
  }, [detail, selectedBase]);

  /* ── Блок «С последнего визита» ── */

  // События после метки прошлого визита — из уже загруженной детальной выдачи.
  const visitItems = useMemo(
    () => (visitBaseline && detail ? collectVisitItems(detail, visitBaseline) : []),
    [visitBaseline, detail],
  );

  // Скрыть блок: «сейчас» становится новой базой — события не всплывут повторно.
  const dismissVisitBlock = useCallback(() => {
    setVisitDismissed(true);
    try {
      window.localStorage.setItem(visitKey(projectId), new Date().toISOString());
    } catch {
      // localStorage недоступен — блок просто скрыт до следующего визита.
    }
  }, [projectId]);

  /* ── Состояния шагов ── */

  const researchDone = project?.status === 'researched';
  const stepDone: Record<number, boolean> = {
    1: researchDone,
    2: Boolean(selectedVerticalId) && maxVisitedStep >= 3,
    3: selectedChains.length > 0 || selectedVocabs.length > 0,
    4: selectedBases.length > 0,
    5: Boolean(selectedTemplate),
  };
  // «Locked» — лишь визуальное приглушение: клик по шагу всегда разрешён.
  const isStepLocked = (id: number): boolean => {
    if (id === 1) return false;
    if (id === 2) return !researchDone;
    return !selectedVertical;
  };
  const wizardSteps: VeWizardStep[] = STEP_DEFS.map((def) => ({
    ...def,
    state:
      def.id === step
        ? 'active'
        : stepDone[def.id]
          ? 'done'
          : isStepLocked(def.id)
            ? 'locked'
            : 'available',
  }));

  /* ── Обработчики (API) ── */

  const runResearch = useCallback(async () => {
    if (researchRunning) return;
    setActionError('');
    setResearchStarting(true);
    try {
      const { ok, status, data } = await veEnginePost<VeJobResponse>(`${VE_API}/projects/${projectId}/research`);
      if (!ok) {
        setActionError(
          status === 409 ? 'Исследование уже запущено' : data.error || 'Не удалось запустить исследование',
        );
        return;
      }
      await load({ silent: true });
    } finally {
      setResearchStarting(false);
    }
  }, [projectId, researchRunning, load]);

  // Отмена всех активных задач проекта (research/chain/vocab/base/template) —
  // сценарий «запустили по ошибке, воркер жжёт API». Подтверждение обязательно.
  const cancelJobs = useCallback(async () => {
    if (cancelling) return;
    if (
      !window.confirm(
        'Остановить все активные задачи проекта? Текущий запрос к модели оборвётся сразу, новые списания прекратятся. Уже готовые результаты сохранятся.',
      )
    ) {
      return;
    }
    setActionError('');
    setCancelling(true);
    try {
      const { ok, data } = await veEnginePost<{ ok?: boolean; cancelled?: number; error?: string }>(
        `${VE_API}/projects/${projectId}/cancel`,
      );
      if (!ok) {
        setActionError(data.error || 'Не удалось остановить задачи');
        return;
      }
      await load({ silent: true });
    } finally {
      setCancelling(false);
    }
  }, [cancelling, projectId, load]);

  const runChain = useCallback(
    async (verticalId: string, language: string) => {
      setActionError('');
      const { ok, data } = await veEnginePost<VeJobResponse>(`${VE_API}/verticals/${verticalId}/chain`, { language });
      if (!ok) {
        setActionError(data.error || 'Не удалось запустить генерацию цепочки');
        return;
      }
      await load({ silent: true });
    },
    [load],
  );

  const runVocab = useCallback(
    async (verticalId: string) => {
      setActionError('');
      const { ok, data } = await veEnginePost<VeJobResponse>(`${VE_API}/verticals/${verticalId}/vocab`);
      if (!ok) {
        setActionError(data.error || 'Не удалось запустить генерацию вокабуляра');
        return;
      }
      await load({ silent: true });
    },
    [load],
  );

  // Досье вертикали: 409 = сборка уже идёт — не ошибка, просто перезагружаемся.
  const runDossier = useCallback(
    async (verticalId: string) => {
      setActionError('');
      const { ok, status, data } = await veEnginePost<VeJobResponse>(`${VE_API}/verticals/${verticalId}/dossier`);
      if (!ok && status !== 409) {
        setActionError(data.error || 'Не удалось запустить сборку досье');
        return;
      }
      await load({ silent: true });
    },
    [load],
  );

  // Оптимистичное обновление статуса гипотезы; при ошибке — откат перезагрузкой.
  const patchHypothesis = useCallback(
    async (id: string, status: VeHypothesisStatus) => {
      setActionError('');
      setDetail((prev) =>
        prev
          ? { ...prev, hypotheses: (prev.hypotheses ?? []).map((h) => (h.id === id ? { ...h, status } : h)) }
          : prev,
      );
      const { ok, data } = await veEngineCall<VeHypothesisResponse>(`${VE_API}/hypotheses/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (ok && data.hypothesis) {
        const updated = data.hypothesis;
        const updatedVerticals = data.verticals;
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                hypotheses: (prev.hypotheses ?? []).map((h) => (h.id === id ? updated : h)),
                // Доска вертикалей сразу отражает пересчёт pct/rank по разметке.
                verticals: updatedVerticals
                  ? (prev.verticals ?? []).map((v) => {
                      const nv = updatedVerticals.find((x) => x.id === v.id);
                      return nv ? { ...v, potential_pct: nv.potential_pct, rank: nv.rank } : v;
                    })
                  : prev.verticals,
              }
            : prev,
        );
      } else {
        setActionError(data.error || 'Не удалось обновить гипотезу');
        await load({ silent: true });
      }
    },
    [load],
  );

  const saveOffer = useCallback(
    async (value: string) => {
      if (offerSaving) return;
      setActionError('');
      setOfferSaving(true);
      try {
        const { ok, data } = await veEnginePatch<VeProjectResponse>(`${VE_API}/projects/${projectId}`, {
          offer_override: value,
        });
        if (ok && data.project) {
          const updated = data.project;
          setDetail((prev) => (prev ? { ...prev, project: updated } : prev));
        } else {
          setActionError(data.error || 'Не удалось сохранить оффер');
        }
      } finally {
        setOfferSaving(false);
      }
    },
    [projectId, offerSaving],
  );

  const buildTemplate = useCallback(
    async (baseId: string) => {
      const { ok, data } = await veEnginePost<VeJobResponse>(`${VE_API}/bases/${baseId}/template`);
      if (!ok || !data.job) throw new Error(data.error || 'Не удалось запустить сборку шаблона');
      await load({ silent: true });
    },
    [load],
  );

  const showTemplateNotice = useCallback(() => {
    setTemplateNotice(true);
    if (templateNoticeTimer.current) clearTimeout(templateNoticeTimer.current);
    templateNoticeTimer.current = setTimeout(() => setTemplateNotice(false), 8000);
  }, []);

  useEffect(
    () => () => {
      if (templateNoticeTimer.current) clearTimeout(templateNoticeTimer.current);
    },
    [],
  );

  // Шаг 5: «Собрать шаблон» по выбранной (последней) базе вертикали.
  const handleBuildTemplate = useCallback(() => {
    if (!selectedBase) return;
    setActionError('');
    void (async () => {
      try {
        await buildTemplate(selectedBase.id);
        showTemplateNotice();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Не удалось запустить сборку шаблона');
      }
    })();
  }, [selectedBase, buildTemplate, showTemplateNotice]);

  // Шаг 4: сборка шаблона запущена с экрана базы → уведомление + переход на шаг 5.
  const handleTemplateStarted = useCallback(() => {
    showTemplateNotice();
    jumpTo(5);
    void load({ silent: true });
  }, [showTemplateNotice, jumpTo, load]);

  // Выбор вертикали на шаге 2: запоминаем (localStorage) и переходим к контенту.
  const handleSelectVertical = useCallback(
    (id: string) => {
      setSelectedVerticalId(id);
      try {
        window.localStorage.setItem(selectedVerticalKey(projectId), id);
      } catch {
        // localStorage недоступен — выбор живёт только в состоянии компонента.
      }
      jumpTo(3);
    },
    [projectId, jumpTo],
  );

  /* ── Рендер текущего шага ── */

  // Шаги 3–5 без выбранной вертикали: подсказка с переходом на шаг 2.
  const verticalRequiredHint = (
    <StepHint
      title="Выберите вертикаль на шаге 2"
      text="Контент, база и шаблон собираются под конкретную вертикаль."
      actionLabel="Выбрать вертикаль"
      onAction={() => jumpTo(2)}
    />
  );

  function renderStep() {
    switch (step) {
      case 2: {
        if (verticals.length === 0 && hypotheses.length === 0) {
          return researchRunning ? (
            <StepHint
              title="Исследование ещё выполняется"
              text="Обычно это занимает 5–15 минут, страница обновится автоматически."
              actionLabel="К шагу 1"
              onAction={() => jumpTo(1)}
            />
          ) : (
            <StepHint
              title="Сначала запустите исследование"
              text="Вертикали и гипотезы появятся после анализа сайта на шаге 1."
              actionLabel="Перейти к исследованию"
              onAction={() => jumpTo(1)}
            />
          );
        }
        return (
          <Step2Verticals
            verticals={verticals}
            hypotheses={hypotheses}
            selectedVerticalId={selectedVerticalId}
            onPatchHypothesis={patchHypothesis}
            onSelectVertical={handleSelectVertical}
            jobs={jobs}
            dossiers={dossiers}
            chains={chains}
            vocabs={vocabs}
            bases={bases}
            templates={templates}
          />
        );
      }
      case 3: {
        if (!selectedVertical) return verticalRequiredHint;
        return (
          <Step3Content
            vertical={selectedVertical}
            chains={selectedChains}
            vocabs={selectedVocabs}
            jobs={jobs}
            onGenerateChain={(language: 'ru' | 'en' | 'pl') => void runChain(selectedVertical.id, language)}
            onGenerateVocab={() => void runVocab(selectedVertical.id)}
            onGoToBase={() => jumpTo(4)}
            dossiers={dossiers}
            onBuildDossier={() => void runDossier(selectedVertical.id)}
          />
        );
      }
      case 4: {
        if (!selectedVertical) return verticalRequiredHint;
        return (
          <Step4Base
            projectId={projectId}
            vertical={selectedVertical}
            hypotheses={hypotheses}
            bases={selectedBases}
            jobs={jobs}
            onUploaded={() => void load({ silent: true })}
            onTemplateStarted={handleTemplateStarted}
            onGoToTemplate={() => jumpTo(5)}
          />
        );
      }
      case 5: {
        if (!selectedVertical) return verticalRequiredHint;
        return (
          <Step5Template
            template={selectedTemplate}
            base={selectedBase}
            jobs={jobs}
            onBuildTemplate={handleBuildTemplate}
          />
        );
      }
      case 1:
      default:
        return (
          <Step1Research
            project={project}
            jobs={jobs}
            busy={researchRunning}
            onStartResearch={() => void runResearch()}
            offerValue={savedOffer}
            onSaveOffer={saveOffer}
            cases={cases}
            onCasesChanged={() => void load({ silent: true })}
          />
        );
    }
  }

  return (
    <div className="space-y-9 text-left">
      {/* Шапка: возврат к проектам, название проекта, статус и мета-строка */}
      <header className="border-b border-gray-200/80 pb-7">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium text-gray-500 transition hover:text-gray-900 active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
        >
          ← Проекты
        </button>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h2 className="truncate text-[22px] font-semibold leading-tight tracking-tight text-gray-900">
                {project ? prettyProjectName(project.name, project.website_url) : 'Проект'}
              </h2>
              {project ? <ProjectStatusBadge status={project.status} /> : null}
            </div>
            {project ? (
              <p className={`mt-1.5 ${HE.muted}`}>
                {hypotheses.length} {pluralRu(hypotheses.length, 'гипотеза', 'гипотезы', 'гипотез')}
                {' · '}
                {verticals.length} {pluralRu(verticals.length, 'вертикаль', 'вертикали', 'вертикалей')}
                {' · '}
                обновлено {formatDate(project.updated_at)}
                {' · '}
                <a
                  href={project.website_url}
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-blue-600 hover:underline"
                >
                  {prettyHost(project.website_url)}
                </a>
              </p>
            ) : null}
          </div>
          {hasActiveJobs ? (
            <button
              type="button"
              onClick={() => void cancelJobs()}
              disabled={cancelling}
              title="Остановить все активные задачи проекта (исследование, цепочки, шаблоны, сборку баз)"
              className="h-8 shrink-0 rounded-lg border border-red-200 bg-white px-3 text-[13px] font-medium text-red-600 transition hover:bg-red-50 active:scale-[0.97] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
            >
              {cancelling ? 'Останавливаем…' : 'Остановить задачи'}
            </button>
          ) : null}
        </div>
      </header>

      {/* «С последнего визита»: что завершилось, пока пользователя не было */}
      {visitItems.length > 0 && !visitDismissed ? (
        <section className="rounded-2xl border border-gray-200 bg-blue-50/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">
              С последнего визита
            </h2>
            <button
              type="button"
              onClick={dismissVisitBlock}
              className="shrink-0 text-xs font-medium text-blue-600 transition hover:underline"
            >
              Скрыть
            </button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {visitItems.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-xs text-gray-600">
                <StatusDot tone={item.tone} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={item.text}>
                  {item.text}
                </span>
                <span className="shrink-0 text-gray-500">{timeAgoRu(item.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {errorMsg && <StatusBox tone="error">{errorMsg}</StatusBox>}
      {actionError && <StatusBox tone="error">{actionError}</StatusBox>}
      {project?.status === 'failed' && project.error ? (
        <StatusBox tone="error">Исследование завершилось ошибкой: {project.error}</StatusBox>
      ) : null}
      {templateNotice ? (
        <StatusBox tone="info">
          Шаблон собирается: обычно это занимает пару минут. Прогресс виден на шаге 5.
        </StatusBox>
      ) : null}

      {loading && !detail ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-2xl border border-gray-200 bg-gray-50 motion-safe:animate-pulse" aria-hidden />
          ))}
        </div>
      ) : null}

      {detail ? (
        <>
          {/* Навигация мастера — sticky-плашка внутри StepNav */}
          <StepNav steps={wizardSteps} onJump={jumpTo} />

          {renderStep()}

          {/* Техническая информация для отладки — по умолчанию скрыта */}
          <details className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-widest text-gray-500 transition hover:text-gray-700">
              Подробности
            </summary>
            <JobsDebugTable jobs={jobs} />
          </details>
        </>
      ) : null}
    </div>
  );
}

/** Плашка-подсказка с кнопкой перехода (пустые состояния мастера). */
function StepHint({
  title,
  text,
  actionLabel,
  onAction,
}: {
  title: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      <p className="mt-1 text-xs text-gray-500">{text}</p>
      <button type="button" onClick={onAction} className={`mt-4 inline-flex ${HE.btnPrimary}`}>
        {actionLabel}
      </button>
    </div>
  );
}

/** Сырая таблица джоб проекта — только внутри «Подробностей», для отладки. */
function JobsDebugTable({ jobs }: { jobs: VeJobSummary[] }) {
  if (jobs.length === 0) {
    return <p className="mt-3 text-xs text-gray-500">Фоновых задач пока не было.</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-gray-500">
            <th className="py-1.5 pr-3 font-medium">Стадия</th>
            <th className="py-1.5 pr-3 font-medium">Статус</th>
            <th className="py-1.5 pr-3 font-medium">Попытки</th>
            <th className="py-1.5 pr-3 font-medium">Начата</th>
            <th className="py-1.5 pr-3 font-medium">Завершена</th>
            <th className="py-1.5 font-medium">Ошибка</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-b border-gray-100 last:border-0">
              <td className="py-1.5 pr-3 font-mono text-gray-700">{j.stage}</td>
              <td className="py-1.5 pr-3">
                <Badge
                  tone={
                    j.status === 'done'
                      ? 'emerald'
                      : j.status === 'failed'
                        ? 'red'
                        : j.status === 'running'
                          ? 'blue'
                          : j.status === 'cancelled'
                            ? 'amber'
                            : 'gray'
                  }
                >
                  {j.status}
                </Badge>
              </td>
              <td className="py-1.5 pr-3 text-gray-500">{j.attempts}</td>
              <td className="py-1.5 pr-3 text-gray-500">{formatDate(j.started_at)}</td>
              <td className="py-1.5 pr-3 text-gray-500">{formatDate(j.finished_at)}</td>
              <td className="max-w-[220px] truncate py-1.5 text-red-500" title={j.error ?? undefined}>
                {j.error ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Блок «С последнего визита» ── */

/** Русские имена стадий джоб для ленты событий (исследовательские — как на шаге 1). */
const VISIT_STAGE_NAMES: Record<VeStage, string> = {
  site_profile: 'Изучение сайта',
  competitors: 'Поиск конкурентов',
  brand_cloud: 'Разбор клиентов конкурентов',
  hypotheses: 'Генерация гипотез',
  evidence: 'Проверка гипотез',
  clustering: 'Сборка вертикалей',
  chain: 'Генерация цепочки',
  vocab: 'Сборка вокабуляра',
  base_analyze: 'Анализ базы',
  base_collect: 'Авто-сборка базы',
  template: 'Сборка шаблона',
  dossier: 'Сборка досье',
};

/** Относительное время по-русски: «только что», «5 мин назад», «2 ч назад», «3 дн назад». */
function timeAgoRu(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

/** Русские плюралы: pluralRu(2, 'гипотеза', 'гипотезы', 'гипотез') → 'гипотезы'. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 > 1 && mod10 < 5) return few;
  if (mod10 === 1) return one;
  return many;
}

/** Один пункт ленты «С последнего визита». */
interface VisitActivityItem {
  id: string;
  /** Тон точки статуса (StatusDot): ok — готово, err — ошибка, info — артефакт. */
  tone: 'ok' | 'warn' | 'err' | 'info' | 'muted';
  text: string;
  /** ISO-время события — для сортировки (новые сверху) и относительной метки. */
  at: string;
}

/**
 * Собирает события, произошедшие после baseline (метка прошлого визита), из данных
 * детальной выдачи — без дополнительных запросов. Артефакты (цепочка, вокабуляр,
 * досье, база, шаблон) перекрывают свои джобы, чтобы событие не дублировалось;
 * неперекрытые стадии показываются джобами («готово»/«ошибка»).
 * Максимум 5 пунктов, новые сверху.
 */
function collectVisitItems(detail: VeProjectDetailResponse, baselineIso: string): VisitActivityItem[] {
  const since = new Date(baselineIso).getTime();
  if (Number.isNaN(since)) return [];
  const after = (iso: string | null | undefined): iso is string =>
    typeof iso === 'string' && new Date(iso).getTime() > since;

  const items: VisitActivityItem[] = [];
  const coveredStages = new Set<string>();

  for (const c of detail.chains ?? []) {
    if (after(c.created_at)) {
      items.push({ id: `chain-${c.id}`, tone: 'info', text: 'Сгенерирована цепочка', at: c.created_at });
      coveredStages.add('chain');
    }
  }
  for (const v of detail.vocabs ?? []) {
    if (after(v.created_at)) {
      items.push({ id: `vocab-${v.id}`, tone: 'info', text: 'Собран вокабуляр', at: v.created_at });
      coveredStages.add('vocab');
    }
  }
  for (const d of detail.dossiers ?? []) {
    // У досье в DTO нет created_at — ближайшая метка готовности: data.computed_at.
    const readyAt = d.data?.computed_at;
    if (d.status === 'ready' && after(readyAt)) {
      items.push({ id: `dossier-${d.id}`, tone: 'info', text: 'Готово досье', at: readyAt });
      coveredStages.add('dossier');
    }
  }
  for (const b of detail.bases ?? []) {
    if (after(b.created_at)) {
      const text =
        b.status === 'analyzed'
          ? `База «${b.filename}» загружена и проанализирована`
          : b.status === 'failed'
            ? `База «${b.filename}»: ошибка анализа`
            : `Загружена база «${b.filename}»`;
      items.push({ id: `base-${b.id}`, tone: b.status === 'failed' ? 'err' : 'ok', text, at: b.created_at });
      coveredStages.add('base_analyze');
    }
  }
  for (const t of detail.templates ?? []) {
    if (t.status === 'ready' && after(t.created_at)) {
      items.push({ id: `template-${t.id}`, tone: 'ok', text: 'Готов шаблон', at: t.created_at });
      coveredStages.add('template');
    }
  }

  // Джобы: только последняя завершившаяся (done/failed/cancelled) джоба каждой стадии после baseline.
  const latestByStage = new Map<string, { job: VeJobSummary; finishedAt: string }>();
  for (const j of detail.jobs ?? []) {
    if (j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled') continue;
    const finishedAt = j.finished_at;
    if (!after(finishedAt)) continue;
    const prev = latestByStage.get(j.stage);
    if (!prev || new Date(finishedAt).getTime() > new Date(prev.finishedAt).getTime()) {
      latestByStage.set(j.stage, { job: j, finishedAt });
    }
  }
  for (const { job, finishedAt } of latestByStage.values()) {
    if (coveredStages.has(job.stage)) continue;
    items.push({
      id: `job-${job.id}`,
      tone: job.status === 'done' ? 'ok' : 'err',
      text: `${VISIT_STAGE_NAMES[job.stage]}: ${
        job.status === 'done' ? 'готово' : job.status === 'cancelled' ? 'отменено' : 'ошибка'
      }`,
      at: finishedAt,
    });
  }

  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 5);
}
