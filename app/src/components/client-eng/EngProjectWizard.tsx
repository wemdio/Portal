'use client';

/**
 * Мастер проекта клиентского ENG-кабинета: 5 шагов (Brief → Verticals →
 * Letters → Bases & Launch → Review & Launch) поверх деталки
 * GET /api/client/eng/projects/[id]. Шаг 5 — единое окно приёмки автопилота
 * («Start outreach» на шаге 2). Поллинг каждые 4с, пока есть активные джобы
 * (research, chain, base_collect, template); «Cancel all jobs» останавливает
 * идущую работу проекта, выключает автопилот и ночной добор (роут
 * api/client/eng/projects/[id]/cancel).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Ban, LayoutDashboard } from 'lucide-react';
import Link from 'next/link';
import type { Route } from 'next';
import { useSearchParams } from 'next/navigation';
import {
  cancelEngProject,
  fetchEngProjectDetail,
  type EngProject,
  type EngProjectDetailResponse,
} from './api-client';
import { engAutopilotHoldText, engAutopilotIdleText, engStageErrorText } from './engText';
import { EngBadge, EngSpinner, fmtDate, projectStatusTone } from './ui';
import { EngStepBrief } from './EngStepBrief';
import { EngStepVerticals } from './EngStepVerticals';
import { EngStepLetters } from './EngStepLetters';
import { EngStepBases } from './EngStepBases';
import { EngStepReview } from './EngStepReview';

const POLL_INTERVAL_MS = 4000;

const STEPS = [
  { id: 1, label: 'Brief' },
  { id: 2, label: 'Verticals' },
  { id: 3, label: 'Letters' },
  { id: 4, label: 'Bases & Launch' },
  { id: 5, label: 'Review & Launch' },
] as const;

export type EngDetail = EngProjectDetailResponse & { project: EngProject };

export function EngProjectWizard({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<EngDetail | null>(null);
  const [error, setError] = useState('');
  // Глубокая ссылка вида ?step=3 (дашборд ведёт на нужный шаг по этапу
  // вертикали); вне диапазона — стартовый шаг 1.
  const [step, setStep] = useState<number>(() => {
    const raw = Number(searchParams?.get('step'));
    return Number.isInteger(raw) && raw >= 1 && raw <= STEPS.length ? raw : 1;
  });
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const loadingRef = useRef(false);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      // Тихий полл не должен плодить параллельные запросы при медленной БД.
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const data = await fetchEngProjectDetail(projectId);
        if (data.project) {
          setDetail(data as EngDetail);
          setError('');
        } else if (!opts.silent) {
          setError(data.error ?? 'Project not found');
        }
      } catch (e) {
        if (!opts.silent) {
          setError(e instanceof Error ? e.message : 'Failed to load the project');
        }
      } finally {
        loadingRef.current = false;
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const jobs = useMemo(() => detail?.jobs ?? [], [detail]);
  /**
   * Занят ли проект — ОТВЕТОМ СЕРВЕРА (`has_active_jobs`, отдельный ids-only
   * запрос в роуте деталки), а не пересчётом по `jobs`.
   *
   * Список `jobs` капнут тридцатью самыми свежими строками, и проект,
   * накопивший больше тридцати новых записей, пока идёт долгая сборка базы,
   * читался отсюда как простаивающий. Ценой этого были не только «working…» и
   * поллинг: этот же флаг — вторая граница обеих карточек автопилота ниже,
   * то есть кабинет показывал старую паузу или «ничего не идёт» поверх
   * работающего конвейера.
   *
   * Запасной путь — прежний подсчёт по списку: ключа нет там, где сервер факт
   * не прочитал, и в демо-выдаче.
   */
  const hasActiveJobs =
    detail?.has_active_jobs ?? jobs.some((j) => j.status === 'pending' || j.status === 'running');

  // Поллим, пока есть активные джобы — прогресс шагов подъезжает сам.
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => void load({ silent: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveJobs, load]);

  /**
   * Подтверждение обязательно: отмена не только останавливает идущее, но и
   * выключает автопилот и ночной добор, а добор клиент обратно не включит —
   * снимает его паузу только сотрудник (staff-кнопка refill-pause). Каждая
   * фраза подтверждения проверена по роуту отмены:
   *  - «stops the work running on it now» — джобы pending/running →
   *    cancelled, базы collecting/analyzing → failed, researching → draft;
   *  - «turns its autopilot off» — первая запись роута (не легла — 500,
   *    отмены нет);
   *  - «stops its daily refill if it has one» — пауза добора
   *    (pauseHeRefillForClientCancel); конфига нет — добора и не было.
   *    Без миграции 20260930_0005 паузу записать нечем — это условие выката,
   *    а не форма, которую экран обязан пережить;
   *  - «Finished bases, letters and templates are kept» — роут трогает только
   *    базы в работе, цепочек и шаблонов не трогает;
   *  - «campaigns already launched are left as they are» — роут рассыльщика не
   *    зовёт, а кампании ENG создаются на паузе и сами не активируются
   *    (launchHandoff.ts), так что их состояние отмена не меняет;
   *  - ««Start outreach» turns the autopilot back on» — POST .../autopilot;
   *    паузу добора он не снимает, отсюда «only your manager».
   * Сбой отмены печатается: молча проглоченный отказ выглядел бы как
   * сработавшая отмена. Ноль отменённых джоб — штатный успех (остановлены
   * автопилот, добор и застрявшие базы), 409 у роута больше нет.
   */
  const onCancel = async () => {
    if (cancelling) return;
    if (
      !window.confirm(
        'Cancel all jobs on this project? This stops the work running on it now, turns its autopilot off ' +
          'and stops its daily refill if it has one. Finished bases, letters and templates are kept, and ' +
          'campaigns already launched are left as they are. «Start outreach» turns the autopilot back on; ' +
          'only your manager can restart the daily refill.',
      )
    ) {
      return;
    }
    setCancelling(true);
    setCancelError('');
    try {
      await cancelEngProject(projectId);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : 'Failed to cancel the running jobs');
    } finally {
      await load({ silent: true });
      setCancelling(false);
    }
  };

  const project = detail?.project;
  /**
   * Есть ли что отменять — шире, чем «есть активные джобы»: отмена с нулём джоб
   * штатная и нужна ровно там, где джобы нет, а работа «идёт» — база застряла
   * в 'collecting'/'analyzing' без джобы или проект висит в 'researching'.
   * Роут переводит и то, и другое (базы → failed, проект → draft), а без
   * кнопки такую базу с экрана было не остановить. Иначе кнопки нет: на
   * простаивающем проекте отменять нечего.
   */
  const hasCancellableWork =
    hasActiveJobs ||
    project?.status === 'researching' ||
    (detail?.bases ?? []).some((b) => b.status === 'collecting' || b.status === 'analyzing');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
        <Link
          href={'/client/eng' as Route}
          prefetch={false}
          className="inline-flex items-center gap-1 hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Outreach
        </Link>
        <Link
          href={'/client/eng/dashboard' as Route}
          prefetch={false}
          className="inline-flex items-center gap-1 hover:underline"
        >
          <LayoutDashboard className="h-3 w-3" /> Command Center
        </Link>
      </div>

      {error && !detail ? (
        <div className="ds-card p-5 text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      ) : !detail ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner /> Loading project…
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
              {project?.name}
            </h1>
            {project && <EngBadge label={project.status} tone={projectStatusTone(project.status)} />}
            {hasActiveJobs && (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
                <EngSpinner className="h-3 w-3" /> working…
              </span>
            )}
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              {project?.website_url}
            </span>
            {hasCancellableWork && (
              <button
                type="button"
                onClick={() => void onCancel()}
                disabled={cancelling}
                className="ds-btn-secondary ml-auto inline-flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--cp-red)' }}
                title="Stop the work running on this project, turn its autopilot off and stop its daily refill if it has one. Campaigns already launched are left as they are."
              >
                <Ban className="h-3 w-3" />
                {cancelling ? 'Cancelling…' : 'Cancel all jobs'}
              </button>
            )}
          </header>

          {cancelError && (
            <div className="ds-card p-3 text-xs" style={{ color: 'var(--cp-red)' }}>
              {cancelError}
            </div>
          )}

          {/* Русской прозаики стадии здесь нет ни на экране, ни в теле ответа:
              роут отдаёт код причины (toClientEngStageErrorCode), экран
              разворачивает его в английский текст. Отмена до шапки проекта не
              доходит — cancel-роут ставит he_projects.error = null и возвращает
              проект в 'draft', — поэтому префикс «Last error» здесь честен. */}
          {project?.error_code && (
            <div className="ds-card p-3 text-xs" style={{ color: 'var(--cp-red)' }}>
              Last error: {engStageErrorText(project.error_code, 'research')}
            </div>
          )}

          {/* ЧТО С АВТОПИЛОТОМ. Три границы, и каждая обязательная:
              1) только на проекте с ВКЛЮЧЁННЫМ автопилотом — у ручного прогона
                 (RU-режим) координатор ничего не ставит, и паузы у него нет по
                 построению;
              2) только когда активных джоб НЕТ. Запись причины остаётся в
                 колонке и после того, как конвейер снова поехал, и «мы не
                 смогли» поверх идущей стадии было бы враньём — шапка в этот
                 момент уже показывает «working…»;
              3) НЕЙТРАЛЬНАЯ ветка — только когда у проекта нет и кода сбоя
                 стадии. Причина (`error_code`) и пауза (`autopilot_hold`)
                 пишутся РАЗНЫМИ путями: код стадии кладёт failJob воркера, и
                 только для research-стадий (RESEARCH_STAGES,
                 worker/hypothesisEngine.ts), а паузу — координатор после
                 done-джобы, само нажатие «Start outreach» (реконсилер в режиме
                 client пишет причину и снимает её) и ночной проход. Пересечься
                 они могут, и без этого гейта нейтральная карточка вставала
                 ПРЯМО ПОД красной «Last error», отменяя её словами.

              Пауза и её отсутствие — РАЗНЫЕ ветки, а не два оттенка одной:
              «что-то у нас не сработало» приезжает записанной причиной
              (янтарь), «делать нечего, ждём» — её отсутствием (нейтральный
              текст). Красного здесь нет ни у одной: ничего не потеряно, а
              красный в кабинете закреплён за сбоем стадии выше. */}
          {project?.autopilot === true &&
            !hasActiveJobs &&
            (project.autopilot_hold ? (
              <div className="ds-card p-3 text-xs" style={{ color: 'var(--cp-amber)' }}>
                {engAutopilotHoldText(project.autopilot_hold.code)}
                {project.autopilot_hold.at && (
                  <span style={{ color: 'var(--cp-text-l)' }}> · {fmtDate(project.autopilot_hold.at)}</span>
                )}
              </div>
            ) : !project.error_code ? (
              <div className="ds-card p-3 text-xs" style={{ color: 'var(--cp-text-m)' }}>
                {engAutopilotIdleText()}
              </div>
            ) : null)}
          {/* Пауза по потолку расхода ('spend_paused'; потолок по умолчанию
              выключен) — единственная, которая пишется и БЕЗ автопилота:
              отказ кнопки ручного режима, в том числе старта исследования
              («Re-run research»; потолок проверяет только СТАРТ, начатую
              цепочку research он не обрывает). Те же границы, что выше, кроме первой: без активных джоб и тем же
              янтарём. Нейтральной ветки у неё нет — без автопилота «делать
              нечего» не наш текст. */}
          {project &&
            project.autopilot !== true &&
            !hasActiveJobs &&
            project.autopilot_hold?.code === 'spend_paused' && (
              <div className="ds-card p-3 text-xs" style={{ color: 'var(--cp-amber)' }}>
                {engAutopilotHoldText(project.autopilot_hold.code)}
                {project.autopilot_hold.at && (
                  <span style={{ color: 'var(--cp-text-l)' }}> · {fmtDate(project.autopilot_hold.at)}</span>
                )}
              </div>
            )}

          <nav className="flex flex-wrap gap-1.5" aria-label="Wizard steps">
            {STEPS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                className={`ds-nav-item ${step === s.id ? 'active' : ''}`}
                aria-current={step === s.id ? 'step' : undefined}
              >
                {String(s.id).padStart(2, '0')} · {s.label}
              </button>
            ))}
          </nav>

          {step === 1 && <EngStepBrief detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 2 && <EngStepVerticals detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 3 && <EngStepLetters detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 4 && <EngStepBases detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 5 && <EngStepReview detail={detail} onChanged={() => void load({ silent: true })} />}

          <div className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            Updated {fmtDate(project?.updated_at)}
            {hasActiveJobs ? ' · auto-refreshing every 4s' : ''}
          </div>
        </>
      )}
    </div>
  );
}
