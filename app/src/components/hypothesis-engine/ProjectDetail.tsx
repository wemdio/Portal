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
import { ArrowLeft, Globe } from 'lucide-react';
import type { HeHypothesisStatus, HeProjectStatus } from '@/lib/hypothesisEngine/types';
import {
  HE_API,
  heCall,
  hePatch,
  hePost,
  type HeHypothesisResponse,
  type HeJobResponse,
  type HeJobSummary,
  type HeProjectDetailResponse,
  type HeProjectResponse,
} from './api';
import { StepNav, type HeWizardStep } from './steps/StepNav';
import { Step1Research } from './steps/Step1Research';
import { Step2Verticals } from './steps/Step2Verticals';
import { Step3Content } from './steps/Step3Content';
import { Step4Base } from './steps/Step4Base';
import { Step5Template } from './steps/Step5Template';
import { Badge, ProjectStatusBadge, StatusBox, formatDate, prettyHost } from './ui';

const POLL_INTERVAL_MS = 4000;

/** localStorage-ключ выбранной вертикали проекта. */
const selectedVerticalKey = (projectId: string) => `he.sel.${projectId}`;

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
  const [detail, setDetail] = useState<HeProjectDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [actionError, setActionError] = useState('');

  // Текущий шаг мастера и самый далёкий посещённый (нужен для «шаг 2 пройден»).
  const [step, setStep] = useState(1);
  const [maxVisitedStep, setMaxVisitedStep] = useState(1);
  const [selectedVerticalId, setSelectedVerticalId] = useState<string | null>(null);

  const [researchStarting, setResearchStarting] = useState(false);
  const [offerSaving, setOfferSaving] = useState(false);

  // Короткое уведомление «Шаблон собирается…» после запуска сборки.
  const [templateNotice, setTemplateNotice] = useState(false);
  const templateNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const jumpTo = useCallback((next: number) => {
    setStep(next);
    setMaxVisitedStep((prev) => Math.max(prev, next));
  }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const { ok, data } = await heCall<HeProjectDetailResponse>(`${HE_API}/projects/${projectId}`);
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
  const prevStatusRef = useRef<HeProjectStatus | undefined>(undefined);
  useEffect(() => {
    const status = project?.status;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status === 'researched' && prev !== 'researched' && step === 1) jumpTo(2);
  }, [project?.status, step, jumpTo]);

  /* ── Производные данные выбранной вертикали ── */

  const verticals = useMemo(() => detail?.verticals ?? [], [detail]);
  const hypotheses = useMemo(() => detail?.hypotheses ?? [], [detail]);
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
  const wizardSteps: HeWizardStep[] = STEP_DEFS.map((def) => ({
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
      const { ok, status, data } = await hePost<HeJobResponse>(`${HE_API}/projects/${projectId}/research`);
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

  const runChain = useCallback(
    async (verticalId: string, language: string) => {
      setActionError('');
      const { ok, data } = await hePost<HeJobResponse>(`${HE_API}/verticals/${verticalId}/chain`, { language });
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
      const { ok, data } = await hePost<HeJobResponse>(`${HE_API}/verticals/${verticalId}/vocab`);
      if (!ok) {
        setActionError(data.error || 'Не удалось запустить генерацию вокабуляра');
        return;
      }
      await load({ silent: true });
    },
    [load],
  );

  // Оптимистичное обновление статуса гипотезы; при ошибке — откат перезагрузкой.
  const patchHypothesis = useCallback(
    async (id: string, status: HeHypothesisStatus) => {
      setActionError('');
      setDetail((prev) =>
        prev
          ? { ...prev, hypotheses: (prev.hypotheses ?? []).map((h) => (h.id === id ? { ...h, status } : h)) }
          : prev,
      );
      const { ok, data } = await heCall<HeHypothesisResponse>(`${HE_API}/hypotheses/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (ok && data.hypothesis) {
        const updated = data.hypothesis;
        setDetail((prev) =>
          prev ? { ...prev, hypotheses: (prev.hypotheses ?? []).map((h) => (h.id === id ? updated : h)) } : prev,
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
        const { ok, data } = await hePatch<HeProjectResponse>(`${HE_API}/projects/${projectId}`, {
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
      const { ok, data } = await hePost<HeJobResponse>(`${HE_API}/bases/${baseId}/template`);
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
              text="Обычно это занимает 5–15 минут — страница обновится автоматически."
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
          />
        );
      }
      case 4: {
        if (!selectedVertical) return verticalRequiredHint;
        return (
          <Step4Base
            projectId={projectId}
            vertical={selectedVertical}
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
          />
        );
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 text-left">
      {/* Шапка: назад, название проекта и ссылка на сайт — без технических деталей */}
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="mt-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-500 transition hover:bg-gray-50 hover:text-gray-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          К проектам
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-bold text-gray-900">
              {project?.name?.trim() || (project ? prettyHost(project.website_url) : 'Проект')}
            </h1>
            {project ? <ProjectStatusBadge status={project.status} /> : null}
          </div>
          {project ? (
            <a
              href={project.website_url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600"
            >
              <Globe className="h-3 w-3" aria-hidden />
              {prettyHost(project.website_url)}
            </a>
          ) : null}
        </div>
      </div>

      {errorMsg && <StatusBox tone="error">{errorMsg}</StatusBox>}
      {actionError && <StatusBox tone="error">{actionError}</StatusBox>}
      {project?.status === 'failed' && project.error ? (
        <StatusBox tone="error">Исследование завершилось ошибкой: {project.error}</StatusBox>
      ) : null}
      {templateNotice ? (
        <StatusBox tone="info">
          Шаблон собирается — обычно это занимает пару минут. Прогресс виден на шаге 5.
        </StatusBox>
      ) : null}

      {loading && !detail ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-gray-50" aria-hidden />
          ))}
        </div>
      ) : null}

      {detail ? (
        <>
          {/* Навигация мастера */}
          <div className="rounded-2xl border border-gray-200 bg-white px-3 py-4 sm:px-6">
            <StepNav steps={wizardSteps} onJump={jumpTo} />
          </div>

          {renderStep()}

          {/* Техническая информация для отладки — по умолчанию скрыта */}
          <details className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-widest text-gray-400 transition hover:text-gray-600">
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
      <p className="mt-1 text-xs text-gray-400">{text}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-4 inline-flex h-9 items-center rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/** Сырая таблица джоб проекта — только внутри «Подробностей», для отладки. */
function JobsDebugTable({ jobs }: { jobs: HeJobSummary[] }) {
  if (jobs.length === 0) {
    return <p className="mt-3 text-xs text-gray-400">Фоновых задач пока не было.</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-gray-400">
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
