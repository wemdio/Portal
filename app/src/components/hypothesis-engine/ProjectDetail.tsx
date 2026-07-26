'use client';

/**
 * Детальный вид проекта «Движка вертикалей»: шапка с сайтом/статусом,
 * степпер research-стадий, кнопка запуска исследования, вкладки
 * «Вертикали» и «Базы». Авто-поллинг GET /projects/[id] каждые 4 сек,
 * пока есть джобы pending/running.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, FlaskConical, Globe, Loader2, Play } from 'lucide-react';
import type { HeHypothesisStatus } from '@/lib/hypothesisEngine/types';
import {
  HE_API,
  heCall,
  hePatch,
  hePost,
  type HeBaseCreateResponse,
  type HeHypothesisResponse,
  type HeJobResponse,
  type HeProjectDetailResponse,
  type HeProjectResponse,
} from './api';
import { ResearchStepper } from './ResearchStepper';
import { VerticalsBoard } from './VerticalsBoard';
import { BasesTab } from './BasesTab';
import { ProjectStatusBadge, StatusBox, formatDate, prettyHost } from './ui';

const POLL_INTERVAL_MS = 4000;

type DetailTab = 'verticals' | 'bases';

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
  const [tab, setTab] = useState<DetailTab>('verticals');

  // Отслеживаемые джобы, запущенные с этого экрана: verticalId/baseId → jobId.
  // Нужны для мгновенного спиннера до ближайшего полла и для текста ошибки.
  const [chainJobs, setChainJobs] = useState<Record<string, string>>({});
  const [vocabJobs, setVocabJobs] = useState<Record<string, string>>({});
  const [templateJobs, setTemplateJobs] = useState<Record<string, string>>({});

  const [researchStarting, setResearchStarting] = useState(false);
  const [hypBusyId, setHypBusyId] = useState<string | null>(null);

  // Редактируемый оффер: черновик textarea + индикатор «Сохранено».
  const [offerDraft, setOfferDraft] = useState('');
  const [offerSaving, setOfferSaving] = useState(false);
  const [offerSaved, setOfferSaved] = useState(false);

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

  // Подтягиваем сохранённый оффер в черновик. Ввод пользователя не затирается:
  // эффект пересрабатывает только при смене значения на сервере.
  useEffect(() => {
    setOfferDraft(savedOffer);
  }, [savedOffer]);

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
      if (!ok || !data.job) {
        setActionError(data.error || 'Не удалось запустить генерацию цепочки');
        return;
      }
      setChainJobs((prev) => ({ ...prev, [verticalId]: data.job!.id }));
      await load({ silent: true });
    },
    [load],
  );

  const runVocab = useCallback(
    async (verticalId: string) => {
      setActionError('');
      const { ok, data } = await hePost<HeJobResponse>(`${HE_API}/verticals/${verticalId}/vocab`);
      if (!ok || !data.job) {
        setActionError(data.error || 'Не удалось запустить генерацию вокабуляра');
        return;
      }
      setVocabJobs((prev) => ({ ...prev, [verticalId]: data.job!.id }));
      await load({ silent: true });
    },
    [load],
  );

  const patchHypothesis = useCallback(
    async (id: string, status: HeHypothesisStatus) => {
      setActionError('');
      setHypBusyId(id);
      try {
        const { ok, data } = await heCall<HeHypothesisResponse>(`${HE_API}/hypotheses/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        if (ok && data.hypothesis) {
          const updated = data.hypothesis;
          setDetail((prev) =>
            prev
              ? { ...prev, hypotheses: (prev.hypotheses ?? []).map((h) => (h.id === id ? updated : h)) }
              : prev,
          );
        } else {
          setActionError(data.error || 'Не удалось обновить гипотезу');
        }
      } finally {
        setHypBusyId(null);
      }
    },
    [],
  );

  const saveOffer = useCallback(async () => {
    if (offerSaving) return;
    setActionError('');
    setOfferSaving(true);
    try {
      const { ok, data } = await hePatch<HeProjectResponse>(`${HE_API}/projects/${projectId}`, {
        offer_override: offerDraft,
      });
      if (ok && data.project) {
        const updated = data.project;
        setDetail((prev) => (prev ? { ...prev, project: updated } : prev));
        setOfferSaved(true);
        setTimeout(() => setOfferSaved(false), 2000);
      } else {
        setActionError(data.error || 'Не удалось сохранить оффер');
      }
    } finally {
      setOfferSaving(false);
    }
  }, [projectId, offerDraft, offerSaving]);

  const uploadBase = useCallback(
    async (payload: BaseUploadPayload) => {
      const { ok, data } = await hePost<HeBaseCreateResponse>(`${HE_API}/projects/${projectId}/bases`, payload);
      if (!ok) throw new Error(data.error || 'Не удалось загрузить базу');
      await load({ silent: true });
    },
    [projectId, load],
  );

  const buildTemplate = useCallback(
    async (baseId: string) => {
      const { ok, data } = await hePost<HeJobResponse>(`${HE_API}/bases/${baseId}/template`);
      if (!ok || !data.job) throw new Error(data.error || 'Не удалось запустить сборку шаблона');
      setTemplateJobs((prev) => ({ ...prev, [baseId]: data.job!.id }));
      await load({ silent: true });
    },
    [load],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 text-left">
      {/* Шапка */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-700"
            aria-label="Назад к проектам"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-bold text-gray-900">
                {project?.name?.trim() || (project ? prettyHost(project.website_url) : 'Проект')}
              </h1>
              {project ? <ProjectStatusBadge status={project.status} /> : null}
            </div>
            {project ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-400">
                <a
                  href={project.website_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-blue-600"
                >
                  <Globe className="h-3 w-3" aria-hidden />
                  {prettyHost(project.website_url)}
                </a>
                <span>Создан: {formatDate(project.created_at)}</span>
                <span>Вертикалей: {detail?.verticals?.length ?? 0}</span>
                <span>Гипотез: {detail?.hypotheses?.length ?? 0}</span>
              </div>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void runResearch()}
          disabled={researchRunning || loading}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {researchRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Play className="h-4 w-4" aria-hidden />
          )}
          {project?.status === 'researched' ? 'Перезапустить исследование' : 'Запустить исследование'}
        </button>
      </div>

      {/* Оффер — уточняет генерацию цепочек; пустое значение снимает переопределение */}
      {project ? (
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <label
            htmlFor="he-offer-override"
            className="text-xs font-semibold uppercase tracking-widest text-gray-400"
          >
            Оффер (необязательно)
          </label>
          <textarea
            id="he-offer-override"
            rows={2}
            value={offerDraft}
            onChange={(e) => setOfferDraft(e.target.value)}
            placeholder="Например: 3–5 встреч в месяц с HRD крупных работодателей, тест за 2 недели"
            className="mt-1.5 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void saveOffer()}
              disabled={offerSaving || offerDraft.trim() === savedOffer}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {offerSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Сохранить
            </button>
            {offerSaved ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                <Check className="h-3.5 w-3.5" aria-hidden />
                Сохранено
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorMsg && <StatusBox tone="error">{errorMsg}</StatusBox>}
      {actionError && <StatusBox tone="error">{actionError}</StatusBox>}
      {project?.status === 'failed' && project.error ? (
        <StatusBox tone="error">Исследование завершилось ошибкой: {project.error}</StatusBox>
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
          {/* Прогресс исследования */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
              <FlaskConical className="h-3.5 w-3.5" aria-hidden />
              Исследование
              {hasActiveJobs ? (
                <span className="inline-flex items-center gap-1 normal-case tracking-normal text-blue-500">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  выполняется…
                </span>
              ) : null}
            </div>
            <ResearchStepper jobs={jobs} />
          </div>

          {/* Вкладки */}
          <div className="inline-flex h-10 items-center rounded-lg border border-gray-200 bg-white p-0.5">
            {(
              [
                { id: 'verticals', label: `Вертикали (${detail.verticals?.length ?? 0})` },
                { id: 'bases', label: `Базы (${detail.bases?.length ?? 0})` },
              ] as Array<{ id: DetailTab; label: string }>
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={`inline-flex h-full items-center rounded-md px-4 text-sm font-medium transition-colors ${
                  tab === t.id ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'verticals' ? (
            <VerticalsBoard
              verticals={detail.verticals ?? []}
              hypotheses={detail.hypotheses ?? []}
              chains={detail.chains ?? []}
              vocabs={detail.vocabs ?? []}
              jobs={jobs}
              chainJobs={chainJobs}
              vocabJobs={vocabJobs}
              hypBusyId={hypBusyId}
              onRunChain={(verticalId, language) => void runChain(verticalId, language)}
              onRunVocab={(verticalId) => void runVocab(verticalId)}
              onPatchHypothesis={(id, status) => void patchHypothesis(id, status)}
            />
          ) : (
            <BasesTab
              verticals={detail.verticals ?? []}
              bases={detail.bases ?? []}
              templates={detail.templates ?? []}
              jobs={jobs}
              templateJobs={templateJobs}
              onUpload={uploadBase}
              onBuildTemplate={buildTemplate}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
