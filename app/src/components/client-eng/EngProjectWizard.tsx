'use client';

/**
 * Мастер проекта клиентского ENG-кабинета: 5 шагов (Brief → Verticals →
 * Letters → Bases & Launch → Review & Launch) поверх деталки
 * GET /api/client/eng/projects/[id]. Шаг 5 — единое окно приёмки автопилота
 * («Start outreach» на шаге 2). Поллинг всегда, пока деталка загружена: каждые
 * 4с, пока по проекту идёт работа (engWizardLiveWork, плюс короткий запас на
 * зазор между стадиями автопилота — engAutopilotUnfinished), иначе раз в 30с;
 * в скрытой вкладке опроса нет, а при возврате в неё — сразу свежие данные.
 * «Cancel all jobs» останавливает идущую работу проекта, выключает автопилот и
 * ночной добор (роут api/client/eng/projects/[id]/cancel).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { EngSupportText, EngVerifyEmailBanner } from './EngPaidAccess';

/** Опрос деталки, пока по проекту идёт работа. */
const POLL_WORKING_MS = 4000;
/**
 * Опрос, когда работы не видно. Раньше его не было вовсе: мастер замирал на
 * последнем ответе, и то, что сдвинулось без него (починка застрявшей базы,
 * ночной проход, кнопка менеджера), клиент видел только после перезагрузки.
 */
const POLL_IDLE_MS = 30_000;
/**
 * Сколько опросов подряд мастер ещё держит частым после того, как живая
 * работа кончилась, если автопилот не довёл выбранные вертикали
 * (engAutopilotUnfinished). Следующую стадию координатор ставит сразу после
 * done-записи предыдущей (autopilotNext.ts), и опрос, попавший в этот зазор,
 * иначе сбросил бы мастер на 30 с. Счёт — опросами, а не часами: сравнивать
 * время браузера с метками БД нельзя (часы клиента могут уходить на минуты).
 * Пять опросов по 4 с — 20 с; не поставил автопилот за это время ничего —
 * значит, сам он следующую стадию не поставил (почему — говорит пауза
 * autopilot_hold, если он её записал: карточка ниже), и мастер уходит на 30 с.
 */
const AUTOPILOT_HANDOFF_POLLS = 5;

const STEPS = [
  { id: 1, label: 'Brief' },
  { id: 2, label: 'Verticals' },
  { id: 3, label: 'Letters' },
  { id: 4, label: 'Bases & Launch' },
  { id: 5, label: 'Review & Launch' },
] as const;

export type EngDetail = EngProjectDetailResponse & { project: EngProject };

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
function engHasActiveJobs(detail: EngDetail): boolean {
  return (
    detail.has_active_jobs ??
    (detail.jobs ?? []).some((j) => j.status === 'pending' || j.status === 'running')
  );
}

/**
 * Работа, видимая в данных: живая задача, research в ходу или база в сборке/
 * разборе. Тот же набор, что у «есть что отменять» (hasCancellableWork ниже):
 * база 'collecting'/'analyzing' без живой задачи (застряла, ждёт починки) — тоже
 * сюда, иначе мастер замирал ровно на ней.
 */
function engWizardLiveWork(detail: EngDetail): boolean {
  return (
    engHasActiveJobs(detail) ||
    detail.project.status === 'researching' ||
    (detail.bases ?? []).some((b) => b.status === 'collecting' || b.status === 'analyzing')
  );
}

/**
 * Автопилот включён, паузы не записал, и у него есть недоведённая ВЫБРАННАЯ
 * вертикаль: та, у которой есть принятая гипотеза (так вертикали выбирает и
 * сам автопилот, autopilotReconcile.ts), а готового шаблона ещё нет — шаблон
 * последняя стадия, которую автопилот ставит сам; запуск — уже кнопка клиента.
 * Только 'researched': до этого автопилот вертикали не ведёт.
 */
function engAutopilotUnfinished(detail: EngDetail): boolean {
  const project = detail.project;
  if (project.autopilot !== true || project.autopilot_hold || project.status !== 'researched') return false;
  const verticals = new Set((detail.verticals ?? []).map((v) => v.id));
  const ready = new Set((detail.templates ?? []).filter((t) => t.status === 'ready').map((t) => t.vertical_id));
  return (detail.hypotheses ?? []).some(
    (h) => h.status === 'accepted' && h.vertical_id !== null && verticals.has(h.vertical_id) && !ready.has(h.vertical_id),
  );
}

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
  // Вызов, пришедший, пока шло чтение (кроме тика таймера), — ещё одно тихое
  // чтение сразу после текущего (см. load).
  const reloadQueuedRef = useRef(false);
  // Частых опросов в запасе после конца живой работы (AUTOPILOT_HANDOFF_POLLS).
  const [handoffPolls, setHandoffPolls] = useState(0);
  // Была ли живая работа в прошлом ответе: зазор автопилота виден только как
  // переход «шла → не идёт».
  const wasLiveRef = useRef(false);

  /**
   * Чтение деталки; параллельно идёт не больше одного. Вызов, пришедший во
   * время чтения:
   *  - тик таймера (`tick`) отбрасывается — следующий придёт сам;
   *  - любой другой (обновление после кнопки шага или отмены, возврат во
   *    вкладку, монтирование) ставит ОДНО тихое чтение сразу после текущего.
   *    Текущее могло уйти на сервер ДО действия кнопки, и без повтора её
   *    результат экран показал бы только через интервал опроса (до 30 с).
   *    Несколько таких вызовов за одно чтение дают одно повторное.
   */
  const load = useCallback(
    async (opts: { silent?: boolean; tick?: boolean } = {}) => {
      if (loadingRef.current) {
        if (!opts.tick) reloadQueuedRef.current = true;
        return;
      }
      loadingRef.current = true;
      let silent = opts.silent === true;
      try {
        for (;;) {
          reloadQueuedRef.current = false;
          try {
            const data = await fetchEngProjectDetail(projectId);
            if (data.project) {
              const next = data as EngDetail;
              const live = engWizardLiveWork(next);
              const handoff = !live && wasLiveRef.current && engAutopilotUnfinished(next);
              wasLiveRef.current = live;
              setHandoffPolls((left) => (live ? 0 : handoff ? AUTOPILOT_HANDOFF_POLLS : Math.max(0, left - 1)));
              setDetail(next);
              setError('');
            } else if (!silent) {
              setError(data.error ?? 'Project not found');
            }
          } catch (e) {
            if (!silent) {
              setError(e instanceof Error ? e.message : 'Failed to load the project');
            }
          }
          if (!reloadQueuedRef.current) break;
          silent = true;
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

  // «working…» в шапке и границы карточек автопилота — по живым задачам
  // (engHasActiveJobs); частота опроса — по более широкому «идёт работа».
  const hasActiveJobs = detail ? engHasActiveJobs(detail) : false;
  const working = detail ? engWizardLiveWork(detail) || handoffPolls > 0 : false;
  const loaded = detail !== null;

  // Опрос — всегда, пока деталка загружена: 4 с при работе, 30 с без неё.
  // Без загруженной деталки (первая загрузка, проект не найден) не опрашиваем —
  // как и раньше. Скрытая вкладка сервер не дёргает (как дашборд).
  useEffect(() => {
    if (!loaded) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load({ silent: true, tick: true });
    }, working ? POLL_WORKING_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [loaded, working, load]);

  // Вкладку открыли снова — данные сразу, а не через полный интервал.
  useEffect(() => {
    if (!loaded || typeof document === 'undefined') return;
    const onVisible = () => {
      if (!document.hidden) void load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loaded, load]);

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
   *    паузу добора он не снимает — её снимает только staff-кнопка команды,
   *    отсюда «only by our team, through Support» (window.confirm — простой
   *    текст, ссылки в нём нет; Support — пункт меню кабинета).
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
          'the daily refill can be restarted only by our team, through Support.',
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
   * простаивающем проекте отменять нечего. Это тот же предикат, что держит
   * частый опрос (engWizardLiveWork), — один на оба места.
   */
  const hasCancellableWork = detail ? engWizardLiveWork(detail) : false;

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

      <EngVerifyEmailBanner />

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
              Last error: <EngSupportText text={engStageErrorText(project.error_code, 'research')} />
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
                <EngSupportText text={engAutopilotHoldText(project.autopilot_hold.code)} />
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
                <EngSupportText text={engAutopilotHoldText(project.autopilot_hold.code)} />
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
            {working ? ' · auto-refreshing every 4s' : ' · auto-refreshing every 30s'}
          </div>
        </>
      )}
    </div>
  );
}
