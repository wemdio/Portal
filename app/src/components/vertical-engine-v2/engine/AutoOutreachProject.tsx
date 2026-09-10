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
} from './api';
import { HE } from './design';
import { StatusBox, formatDate, prettyProjectName } from './ui';
import { StepNav } from './steps/StepNav';
import { Step1Research } from './steps/Step1Research';
import { DossierSegmentCard, DossierSignalsCard, DossierDatasetCard } from './steps/Step3Content';
import { BaseRow, BaseAnalysisCards } from './steps/Step4Base';
import { FinalLettersEditor } from './FinalLettersEditor';
import { OutreachLaunchPanel } from './OutreachLaunchPanel';
import { CampaignProgress } from './CampaignProgress';
import { ManualBaseLibrary } from './ManualBaseLibrary';
import { PreparationProgress, getPreparationPresentation } from './PreparationProgress';

const LABELS = ['Гипотезы', 'Письма', 'Базы и объём', 'Запуск', 'Результаты'];
const RUN_LABELS = {
  queued: 'Запуск в очереди',
  running: 'Создаём и запускаем кампании',
  waiting: 'Ожидает отправителей или даты начала',
  active: 'Кампании запущены',
  blocked: 'Запуск требует внимания',
  cancelled: 'Запуск остановлен',
};
type ProjectData = Required<
  Pick<
    VeProjectDetailResponse,
    'project' | 'jobs' | 'verticals' | 'hypotheses' | 'bases' | 'templates' | 'dossiers' | 'cases'
  >
>;

function AudienceSummary({
  baseId,
  presetId,
  onCount,
}: {
  baseId: string;
  presetId: string;
  onCount?: (count: number) => void;
}) {
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
          return;
        }
        setData(response.data);
        setError('');
        onCount?.(response.data.ready);
      } catch {
        if (!cancelled) setError('Не удалось обновить объём. Проверьте соединение');
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
  return (
    <div className="space-y-3">
      <div className="ve2-stats">
        <div className="ve2-stat">
          <p className="ve2-stat-v">{data.ready.toLocaleString('ru-RU')}</p>
          <p className="ve2-stat-k">Готово по гипотезе</p>
        </div>
        <div className="ve2-stat">
          <p className="ve2-stat-v">
            {data.estimate ? `~${data.estimate.contacts.toLocaleString('ru-RU')}` : 'Пока неизвестно'}
          </p>
          <p className="ve2-stat-k">Можно собрать дополнительно</p>
        </div>
      </div>
      {!data.client_exclusions_applied ? (
        <p className={HE.muted}>
          Исключения клиента будут учтены после выбора настроек отправки. Пересечения баз дополнительно проверим перед
          стартом.
        </p>
      ) : null}
      <details>
        <summary className="ve2-link cursor-pointer">Как рассчитан объём</summary>
        <div className="mt-2 space-y-2">
          {data.observed_yield ? (
            <p className={HE.muted}>
              Проверено кандидатов: {data.observed_yield.candidates.toLocaleString('ru-RU')}. Получено готовых
              контактов: {data.observed_yield.ready.toLocaleString('ru-RU')}. Выход:{' '}
              {data.observed_yield.contacts_per_candidate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}{' '}
              контакта на кандидата.
            </p>
          ) : null}
          <p className={HE.muted}>
            {data.estimate
              ? `Оценка с низкой уверенностью от ${formatDate(data.estimate.as_of)}. Она предполагает такой же выход в оставшейся части источника.`
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
  const [busy, setBusy] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [activeHypothesis, setActiveHypothesis] = useState('');
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
  const refresh = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    try {
      const results = await Promise.all([
        veEngineCall<VeProjectDetailResponse>(`${VE_API}/projects/${projectId}`),
        veEngineCall<VeOutreachSetupResponse>(`${VE_API}/projects/${projectId}/outreach`),
        veEngineCall<{ run: VeOutreachRun | null; error?: string }>(`${VE_API}/projects/${projectId}/outreach/start`),
      ]);
      const [project, setup, launch] = results;
      if (project.ok && project.data.project)
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
      if (launch.ok)
        setRun((current) =>
          !current || (launch.data.run && launch.data.run.updated_at >= current.updated_at) ? launch.data.run : current,
        );
      const failed = results.find((r) => !r.ok);
      if (failed) setError(failed.data.error ?? 'Не удалось обновить проект');
      else setError('');
      if (initialVisit.current && project.ok && setup.ok && launch.ok) {
        initialVisit.current = false;
        if (
          launch.data.run ||
          project.data.templates?.some((t) =>
            parseLaunchInfo((t as VeTemplate & { launch_info?: unknown }).launch_info),
          )
        )
          setStep(5);
        else if (
          setup.data.preparations.some((p) => setup.data.setup.selected_hypothesis_ids.includes(p.hypothesis_id))
        )
          setStep(2);
      }
    } catch {
      setError('Не удалось обновить проект. Проверьте соединение');
    } finally {
      refreshBusy.current = false;
    }
  }, [projectId]);
  const working =
    detail?.jobs.some((j) => ['pending', 'running'].includes(j.status)) ||
    snapshot?.preparations.some(
      (p) =>
        snapshot.setup.selected_hypothesis_ids.includes(p.hypothesis_id) &&
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
  const selectedIds = snapshot?.setup.selected_hypothesis_ids ?? [];
  const resultTemplates = (detail?.templates ?? []).filter((t) => {
    const base = detail?.bases.find((b) => b.id === t.base_id);
    return (
      base?.collect_info?.collection_mode !== 'supply' &&
      (!!parseLaunchInfo((t as VeTemplate & { launch_info?: unknown }).launch_info) ||
        run?.items.some((item) => item.template_id === t.id))
    );
  });
  const selectedHypotheses = (detail?.hypotheses ?? []).filter((h) => selectedIds.includes(h.id));
  const titles = useMemo(
    () => Object.fromEntries((detail?.hypotheses ?? []).map((h) => [h.id, h.title])),
    [detail?.hypotheses],
  );
  const activeId = selectedIds.includes(activeHypothesis) ? activeHypothesis : (selectedIds[0] ?? '');
  const preparation = snapshot?.preparations.find((p) => p.hypothesis_id === activeId);
  const template = (detail?.templates ?? []).find((t) => t.id === preparation?.template_id) ?? null;
  const guardLeave = () =>
    (!dirtyRef.current && !libraryDirtyRef.current) ||
    window.confirm('Есть несохранённые правки писем. Перейти без сохранения?');
  const jump = (next: number) => {
    if (!guardLeave()) return;
    setStep(next);
    topRef.current?.scrollIntoView({ block: 'start' });
  };
  const change = async (payload: Record<string, unknown>) => {
    if (!snapshot || busy || locked) return;
    setBusy(true);
    setError('');
    try {
      const result = await veEnginePost<VeOutreachSetupResponse>(`${VE_API}/projects/${projectId}/outreach`, {
        revision: snapshot.setup.revision,
        ...payload,
      });
      if (!result.ok) {
        setError(result.data.error ?? 'Не удалось сохранить выбор');
        return;
      }
      setSnapshot(result.data);
      if (payload.action === 'select' && payload.next_run === true) setStep(1);
      if (payload.action === 'prepare') {
        setStep(2);
        await refresh();
      }
    } catch {
      setError('Не удалось сохранить решение. Проверьте соединение');
    } finally {
      setBusy(false);
    }
  };
  const research = async () => {
    setResearchBusy(true);
    try {
      const result = await veEnginePost<VeJobResponse>(`${VE_API}/projects/${projectId}/research`);
      if (!result.ok) setError(result.data.error ?? 'Не удалось начать исследование');
      else await refresh();
    } catch {
      setError('Не удалось начать исследование. Проверьте соединение');
    } finally {
      setResearchBusy(false);
    }
  };
  const saveOffer = async (value: string) => {
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
    try {
      const response = await veEnginePost<{ error?: string }>(`${VE_API}/projects/${projectId}/cancel`);
      if (!response.ok) setError(response.data.error ?? 'Не удалось остановить подготовку');
      else await refresh();
    } catch {
      setError('Не удалось остановить подготовку. Проверьте соединение');
    }
  };
  if (!detail) return <StatusBox tone={error ? 'error' : 'info'}>{error || 'Загружаем проект…'}</StatusBox>;
  const hasJobs = detail.jobs.some((j) => ['pending', 'running'].includes(j.status));
  const researchRunning = researchBusy || detail.project.status === 'researching';
  const allPrepared =
    selectedIds.length > 0 &&
    selectedIds.every((id) => snapshot?.preparations.some((p) => p.hypothesis_id === id && p.status === 'ready'));
  const allApproved =
    allPrepared &&
    selectedIds.every((id) => {
      const p = snapshot?.preparations.find((p) => p.hypothesis_id === id);
      if (!p?.base_id) return false;
      const review = snapshot?.reviews[p.base_id],
        approval = snapshot?.setup.approved_bases[p.base_id];
      return !!review && approval?.revision === review.revision && approval.template_id === review.template_id;
    });
  const picker =
    selectedHypotheses.length > 1 ? (
      <label className="block ve2-label mb-5">
        Гипотеза
        <select
          aria-label="Гипотеза"
          className={`${HE.input} mt-2 w-full`}
          value={activeId}
          onChange={(e) => {
            if (guardLeave()) setActiveHypothesis(e.target.value);
          }}
        >
          {selectedHypotheses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.title}
            </option>
          ))}
        </select>
      </label>
    ) : null;
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
      <details className="ve2-panel-line mb-6" open={detail.project.status !== 'researched'}>
        <summary className="ve2-link cursor-pointer p-4">Данные клиента и исследование</summary>
        <div className="p-4">
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
                    : i > 0 && i < 4 && !selectedIds.length
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
                  Можно выбрать гипотезы из нескольких вертикалей. Доказательства и досье помогут проверить выбор.
                </p>
              </header>
              <div className="ve2-vertical-list">
                {detail.verticals.map((vertical) => {
                  const hypotheses = detail.hypotheses.filter((h) => h.vertical_id === vertical.id);
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
                        {hypotheses.map((h) => (
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
                                <span id={`hypothesis-description-${h.id}`} className={HE.muted}>{h.description}</span>
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
                              <details className="ve2-hypothesis-evidence">
                                <summary className="ve2-link">Доказательства · {h.evidence?.length ?? 0}</summary>
                                <div className="ve2-evidence-content">
                                  {h.fit_rationale ? <p className={HE.muted}>{h.fit_rationale}</p> : null}
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
                              </details>
                            </div>
                          </div>
                        ))}
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
                <div className="ve2-hypothesis-submit">
                  <span className={HE.muted} aria-live="polite">Выбрано: {selectedIds.length}</span>
                  <button
                    type="button"
                    disabled={busy || locked || !selectedIds.length}
                    className={HE.btnPrimary}
                    onClick={() => void change({ action: 'prepare' })}
                  >
                    Подготовить письма и базы
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {step === 2 ? (
            <section className="space-y-5">
              <h2 className="ve2-h2">Итоговые письма</h2>
              {picker}
              {template ? (
                <FinalLettersEditor
                  key={template.id}
                  templateId={template.id}
                  onDirtyChange={dirtyChange}
                  onSaved={refresh}
                />
              ) : (
                <>
                  <PreparationProgress
                    preparation={preparation}
                    base={detail.bases.find((b) => b.id === preparation?.base_id)}
                    jobs={detail.jobs}
                  />
                  {!preparation || preparation.status === 'error' ? (
                    <button
                      type="button"
                      disabled={busy || locked}
                      className={HE.btnGhost}
                      onClick={() => void change({ action: 'prepare' })}
                    >
                      Продолжить подготовку
                    </button>
                  ) : null}
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
              {selectedHypotheses.map((h) => {
                const p = snapshot?.preparations.find((p) => p.hypothesis_id === h.id),
                  base = detail.bases.find((b) => b.id === p?.base_id);
                const review = base ? snapshot?.reviews[base.id] : null,
                  approval = base ? snapshot?.setup.approved_bases[base.id] : null;
                const approved =
                  !!review && approval?.revision === review.revision && approval.template_id === review.template_id;
                return (
                  <article key={h.id} className="border-t border-[var(--ve2-line)] pt-5 space-y-4">
                    <h3 className="ve2-h3">{h.title}</h3>
                    {base ? (
                      <>
                        <AudienceSummary baseId={base.id} presetId={presetId} />
                        <details>
                          <summary className="ve2-link cursor-pointer">Превью базы и подтверждения</summary>
                          <div className="mt-3">
                            <BaseRow
                              base={base}
                              job={detail.jobs.find(
                                (j) => j.payload?.base_id === base.id && ['pending', 'running'].includes(j.status),
                              )}
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
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="ve2-cbx mt-1"
                            checked={approved}
                            disabled={!review || busy || locked}
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
                          <span>Одобряю базу для запуска</span>
                        </label>
                        {!review ? (
                          <p className={HE.muted}>Одобрение станет доступно после подготовки итоговых писем.</p>
                        ) : null}
                      </>
                    ) : (
                      <p className={HE.muted}>
                        {getPreparationPresentation({ preparation: p, base, jobs: detail.jobs }).title}
                      </p>
                    )}
                    {p?.last_error ? <StatusBox tone="error">{p.last_error}</StatusBox> : null}
                  </article>
                );
              })}
              <p className={HE.muted}>
                Контакты разных гипотез могут пересекаться. Перед отправкой система исключит повторы.
              </p>
              <button type="button" className={HE.btnPrimary} disabled={!allApproved} onClick={() => jump(4)}>
                К запуску
              </button>
            </section>
          ) : null}
          {step === 4 && snapshot ? (
            <OutreachLaunchPanel
              key={selectedIds[0] ?? 'empty'}
              projectId={projectId}
              snapshot={snapshot}
              templates={detail.templates}
              titles={titles}
              onPresetChange={setPresetId}
              onStarted={(value) => {
                setRun(value);
                setStep(5);
                void refresh();
              }}
            />
          ) : null}
          {step === 5 ? (
            <section className="space-y-5">
              <h2 className="ve2-h2">{run ? RUN_LABELS[run.status] : 'Результаты'}</h2>
              {run?.error ? <StatusBox tone="error">{run.error}</StatusBox> : null}
              {!locked && resultTemplates.length ? (
                <button
                  type="button"
                  className={HE.btnGhost}
                  disabled={busy}
                  onClick={() =>
                    void change({
                      action: 'select',
                      language: snapshot?.setup.language ?? 'ru',
                      hypothesis_ids: selectedIds.filter(
                        (id) =>
                          !resultTemplates.some((t) =>
                            detail.bases.some((b) => b.id === t.base_id && b.hypothesis_id === id),
                          ),
                      ),
                      next_run: true,
                    })
                  }
                >
                  Подготовить следующий запуск
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
                        activating: 'Включаем отправку',
                        waiting: 'Ожидает отправителей или даты',
                        active: 'Отправка включена',
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
                    required={base?.source === 'auto' && base.collect_info?.collection_mode === 'preview'}
                    title={hypothesisId ? (titles[hypothesisId] ?? 'Гипотеза') : (base?.filename ?? 'Кампания')}
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
