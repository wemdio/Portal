'use client';

import { useEffect, useState } from 'react';
import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import { getVeCollectionFailure } from '@/lib/verticalEngineV2/collectionErrors';
import { veRequestyBillingWaitState } from '@/lib/verticalEngineV2/requestyBillingState';
import { veTwoGisSleepReasonLabel } from '@/lib/verticalEngineV2/twoGisMarker';
import type { VeBaseSummary, VeCollectInfo, VeJobSummary, VePreparationAction } from './api';
import { collectCount, describeCompletedCollection, describeReadyComposition, getCollectionProgress, isPartialPreview } from './collectionProgress';
import { HE, StatusDot } from './design';

interface PreparationProgressProps {
  context?: 'letters' | 'base';
  preparation?: VeOutreachPreparation | null;
  preparationSelected?: boolean;
  hypothesisTitle?: string;
  canPauseOrphan?: boolean;
  base?: VeBaseSummary | null;
  /** Project detail supplies jobs newest first; its history is intentionally bounded. */
  jobs: readonly VeJobSummary[];
  compact?: boolean;
  onStart?: () => void;
  onPause?: () => void;
  onContinue?: () => void;
  continueDisabled?: boolean;
  pauseDisabled?: boolean;
  pauseDisabledReason?: string;
  prepareDisabled?: boolean;
  approved?: boolean;
  /** «Рассылку» можно выбрать при запуске (этап 7) — подсказка одобренной базы говорит о выборе. */
  senderChoice?: boolean;
  actionNotice?: PreparationActionNotice | null;
}

export interface PreparationActionNotice { tone: 'info' | 'error'; message: string }
export interface PreparationRequestNotice extends PreparationActionNotice {
  hypothesisId: string | null;
  operation?: 'pause';
  checking?: boolean;
  keepUntilStateChanges?: boolean;
  stateKey?: string;
}

/** Fresh persisted progress supersedes a request receipt. A refusal stays
 * visible until the affected preparation changes, even across polling. */
export function refreshPreparationRequestNotice(
  notice: PreparationRequestNotice | null,
  snapshot: { preparations: readonly VeOutreachPreparation[]; bases: readonly VeBaseSummary[]; jobs: readonly VeJobSummary[] },
): PreparationRequestNotice | null {
  if (notice?.operation === 'pause' && snapshot.preparations.some((item) => item.hypothesis_id === notice.hypothesisId && item.paused_at)) return null;
  if (!notice || notice.checking) return notice;
  if (!notice.keepUntilStateChanges) return null;
  const preparations = snapshot.preparations.filter((item) => !notice.hypothesisId || item.hypothesis_id === notice.hypothesisId);
  const bases = snapshot.bases.filter((item) => !notice.hypothesisId || item.hypothesis_id === notice.hypothesisId
    || preparations.some((preparation) => preparation.base_id === item.id));
  const baseIds = new Set(bases.map((item) => item.id));
  if (notice.operation === 'pause') {
    const completed = preparations.length > 0 && preparations.every((item) => item.status === 'ready')
      && !snapshot.jobs.some((item) => baseIds.has(item.payload?.base_id ?? '') && ['pending', 'running'].includes(item.status));
    // Ordinary collection progress cannot confirm or dismiss a failed pause.
    return completed ? null : notice;
  }
  const stateKey = JSON.stringify({
    preparations: preparations.map((item) => [item.hypothesis_id, item.base_id, item.template_id, item.status, item.last_error, item.paused_at, item.cancelled_at]).sort(),
    bases: bases.map((item) => [item.id, item.status, item.updated_at, item.collection_continuation]).sort(),
    jobs: snapshot.jobs.filter((item) => baseIds.has(item.payload?.base_id ?? ''))
      .map((item) => [item.id, item.status, item.error]).sort(),
  });
  return notice.stateKey === undefined ? { ...notice, stateKey } : notice.stateKey === stateKey ? notice : null;
}

/** A successful HTTP response alone does not confirm a newly queued task. */
export function getPreparationActionNotice(outcome?: VePreparationAction): PreparationActionNotice {
  const messages = {
    queued: 'Подготовка поставлена в очередь.',
    already_running: 'Подготовка уже выполняется.',
    unavailable: 'Продолжение сейчас недоступно.',
    ready: 'База и письма уже готовы.',
  };
  return { tone: outcome?.status === 'unavailable' ? 'error' : 'info',
    message: outcome?.reason || (outcome ? messages[outcome.status] : 'Обновляем состояние подготовки.') };
}

export interface PreparationPresentation {
  title: string;
  description: string;
  readiness?: string;
  currentStep: number | null;
  tone: 'info' | 'muted' | 'err' | 'ok';
  canContinue?: boolean;
  /** Historical context only; collection actions remain visible separately. */
  collectionSummary?: string;
  continuationUnconfirmed?: boolean;
  continueLabel?: string;
  continueHint?: string;
  awaitingStatus?: boolean;
  continuationBlocked?: boolean;
  guidance?: {
    action: 'wait' | 'review' | 'launch' | 'continue' | 'start' | 'check';
    title: string;
    next: string;
  };
}

const STEPS = ['Сбор и проверка базы', 'Разбор состава базы', 'Подготовка A/B-писем'];
const CONSTRUCT_STEPS: Record<string, string> = {
  find_emails: 'Ищем email на сайтах компаний',
  split_emails: 'Разделяем найденные email',
  remove_empty: 'Исключаем строки без контактов',
  dedup: 'Исключаем повторные контакты',
  validate_emails: 'Проверяем email',
};

function preparationError(message: string): string {
  if (message.startsWith('Задача сбора завершилась, но база не готова.')) {
    return 'Продолжение подготовки прервалось. Сейчас база не обрабатывается. Сохранённые результаты не потеряны.';
  }
  const failure = getVeCollectionFailure(message);
  return failure.kind !== 'unknown' ? failure.message : message;
}
const COLLECT_PHASES: Record<ReturnType<typeof getCollectionProgress>['phase'], [string, string]> = {
  discovering_sites: ['Находим официальные сайты компаний', 'В источнике не было сайта. Ищем его по ИНН или названию и городу, затем проверим принадлежность компании и найдём email.'],
  planning: ['Подбираем источники компаний', 'Система подбирает источники под выбранную гипотезу. Затем соберёт кандидатов и проверит, подходят ли они для рассылки.'],
  collecting: ['Собираем компании и контакты', 'Получаем кандидатов из выбранных источников. Затем автоматически проверим соответствие гипотезе и email, исключим дубли.'],
  construct_queued: ['Обработка контактов в очереди', 'Кандидаты собраны. Поиск недостающих данных и проверка контактов начнутся автоматически, когда освободится обработчик.'],
  processing: ['Обогащаем и проверяем контакты', 'Ищем недостающие данные, проверяем email и исключаем дубли. В итоговую базу попадут только контакты, прошедшие все проверки.'],
  finishing: ['Проверяем соответствие гипотезе', 'Система автоматически проверяет, чем занимаются компании и соответствуют ли они выбранной гипотезе. Неподтверждённые контакты не входят в готовую базу.'],
  cleaning_names: ['Подготавливаем названия компаний для писем', 'Контакты уже отобраны. Приводим названия компаний к виду, который можно использовать в обращении, затем разберём состав базы.'],
  reviewing_relevance: ['Проверяем соответствие компаний гипотезе', 'Проверяем сведения о компаниях и подтверждения на их сайтах. Число готовых контактов обновится после завершения проверок. Контакты без подтверждения не попадут в готовую базу.'],
  reviewing_emails: ['Проверяем сохранённые email', 'Продолжаем проверку уже найденных адресов. После неё система завершит отбор компаний под гипотезу и разберёт состав базы.'],
  construct_failed: ['Обработка контактов остановлена', 'Обработчик сообщил об остановке. Причина появится после обновления состояния подготовки.'],
};

function hasActivePreparation({ base, jobs }: PreparationProgressProps): boolean {
  return base?.collection_continuation?.code === 'already_running' || (!!base?.id && jobs.some((job) =>
    job.payload?.base_id === base.id && ['pending', 'running'].includes(job.status)
    && ['base_collect', 'base_analyze', 'template', 'base_reproject_contacts'].includes(job.stage)));
}

function isLegacyPreparationIdle(props: PreparationProgressProps): boolean {
  return props.preparationSelected === false && !props.preparation?.independent_control
    && !!props.preparation && ['pending', 'collecting', 'generating'].includes(props.preparation.status)
    && !hasActivePreparation(props);
}

/** Queue evidence takes precedence over snapshots left by a previous attempt. */
function getPreparationStage(props: PreparationProgressProps): PreparationPresentation {
  const { preparation, base, jobs, context = 'base' } = props;
  if (!preparation && hasActivePreparation({ base, jobs })) return {
    title: 'Подготовка базы выполняется',
    description: 'Задача уже создана. Сохранённые контакты доступны ниже; состояние обновляется автоматически.',
    currentStep: 0, tone: 'info',
  };
  if (!preparation) return {
    title: 'Подготовка ещё не запущена',
    description: 'Система соберёт и проверит базу для этой гипотезы, разберёт её состав и подготовит письма.',
    currentStep: null, tone: 'muted',
  };
  if (preparation.paused_at || (preparation.status !== 'ready' && preparation.cancelled_at)) return {
    title: 'Подготовка на паузе',
    description: 'Контакты, письма и согласования сохранены. Остальные базы работают независимо.',
    currentStep: null, tone: 'muted', canContinue: true, continueLabel: 'Продолжить подготовку',
  };
  if (isLegacyPreparationIdle(props)) return {
    title: 'Подготовка приостановлена',
    description: 'Гипотеза была снята с подготовки. Сохранённые результаты доступны ниже.',
    currentStep: null, tone: 'muted', canContinue: true, continueLabel: 'Продолжить подготовку',
  };
  const baseId = preparation.base_id;
  const jobFor = (stage: VeJobSummary['stage']) => baseId
    ? jobs.find((job) => job.payload?.base_id === baseId && job.stage === stage)
    : undefined;
  const hasLiveJob = ['base_collect', 'base_analyze', 'template'].some((stage) => {
    const job = jobFor(stage as VeJobSummary['stage']);
    return job && ['pending', 'running'].includes(job.status);
  });
  if (base?.collection_continuation?.code === 'already_running' && !hasLiveJob) return {
    title: 'Подготовка продолжается', description: base.collection_continuation.reason,
    currentStep: null, tone: 'info',
  };
  if (base?.collection_continuation?.code === 'preparation_incomplete' && !hasLiveJob) return {
    title: 'Нужно завершить подготовку', description: base.collection_continuation.reason,
    currentStep: 2, tone: 'muted', canContinue: true, continueLabel: 'Продолжить подготовку',
  };
  const target = base?.collect_info?.target_progress;
  const composition = describeReadyComposition(target);
  const partialReady = preparation.status === 'ready' && (target?.ready_rows ?? 0) > 0
    && ['limited', 'exhausted'].includes(target?.status ?? '');
  if (base?.status === 'analyzed' && target && isPartialPreview(base) && !hasLiveJob
    && !['pending', 'error', 'generating'].includes(preparation.status)) return {
    title: partialReady ? 'База и письма готовы к согласованию'
      : target.status === 'error' ? 'Ошибка добора' : target.ready_rows > 0 ? 'Подготовка не завершена' : 'Готовых контактов пока нет',
    readiness: partialReady ? 'Контакты можно скачать. После согласования базы и писем можно перейти к запуску, не дожидаясь цели сбора.' : undefined,
    description: (partialReady ? describeCompletedCollection(target) + ' '
        : target.status === 'exhausted' ? 'Компании из текущего плана источников обработаны; это не оценка всего рынка. '
        : target.status === 'error' ? preparationError(target.reason ?? base.error ?? '') + ' '
          : target.reason?.startsWith('Нет подтверждённого продолжения источников')
            ? 'По текущему плану система не смогла продолжить добор. Это не означает, что подходящих компаний больше нет. '
            : (target.reason ? target.reason.replace(/[.\s]+$/, '') + '. ' : 'Цель превью пока не достигнута. '))
      + (composition ? composition + ' ' : '')
      + (target.ready_rows > 0 ? partialReady ? '' : 'Проверенная часть сохранена и доступна для скачивания. '
        : 'Кандидаты сохранены, но контактов, прошедших все проверки, пока нет. '),
    currentStep: partialReady ? STEPS.length : null,
    tone: partialReady ? 'ok' : target.status === 'error' ? 'err' : 'muted', canContinue: true,
    continueLabel: preparation.status === 'ready' && target.status !== 'error' ? 'Продолжить добор' : undefined,
  };
  if (context === 'letters' && base?.status === 'failed' && !hasLiveJob) return {
    title: 'Письма ждут завершения подготовки базы',
    description: 'Подготовка остановилась до генерации писем. Причина и продолжение сбора доступны на шаге «Базы и объём».',
    currentStep: 0, tone: 'muted',
  };
  if (preparation.status === 'error' && !hasLiveJob) return {
    title: 'Подготовка остановлена',
    description: preparation.last_error ? preparationError(preparation.last_error) : 'Не удалось завершить подготовку. Сохранённые результаты не потеряны.',
    currentStep: null, tone: 'err', canContinue: true,
  };
  if (preparation.status === 'ready' && !hasLiveJob) return {
    title: 'Письма и база готовы',
    description: 'Можно выбрать и отредактировать письма, затем проверить и одобрить базу.',
    currentStep: STEPS.length, tone: 'ok',
  };
  if (preparation.status === 'pending' && !hasLiveJob) return {
    title: 'Подготовка в очереди',
    description: 'Запрос принят. Система начнёт подготовку автоматически и продолжит с сохранённого этапа. Здесь появится текущий этап работы; страницу можно закрыть.',
    currentStep: null, tone: 'muted',
  };

  // The response contains only recent jobs. A missing job is not evidence of a
  // running worker, a failed worker, or the project's position in the queue.
  const templateJob = jobFor('template');
  const letters = preparation.status === 'generating'
    || (base?.status === 'analyzed' && templateJob && ['pending', 'running'].includes(templateJob.status));
  const analyzing = base?.status === 'analyzing';
  const job = letters ? templateJob : base?.status === 'analyzed' ? undefined : jobFor(analyzing ? 'base_analyze' : 'base_collect');
  const currentStep = letters ? 2 : analyzing ? 1 : 0;

  if ((!hasLiveJob && base?.status === 'failed') || (job && ['failed', 'cancelled'].includes(job.status))) return {
    title: 'Подготовка остановлена',
    description: preparationError(preparation.last_error || base?.error || job?.error || 'Этап не завершился. Состояние подготовки обновится автоматически.'),
    currentStep: null, tone: 'err', canContinue: true,
  };
  if (base?.status === 'analyzed' && base.row_count === 0) return {
    title: 'Сбор завершён без готовых контактов',
    description: 'Для подготовки писем нужна непустая база. Состояние подготовки обновится автоматически.',
    currentStep: null, tone: 'err',
  };
  if ((letters || analyzing) && job?.status === 'done') return {
    title: letters ? 'Генерация писем завершена' : 'Разбор базы завершён',
    description: letters
      ? 'Ждём обновления результата подготовки. После него здесь откроется редактор писем.'
      : 'Ждём обновления результата разбора. Затем система автоматически перейдёт к подготовке писем.',
    currentStep, tone: 'muted',
  };
  if ((letters || analyzing) && !job) return {
    title: letters ? 'Ожидаем обновления статуса писем' : 'Ожидаем обновления статуса разбора',
    description: 'Состояние этого этапа пока неизвестно. Статус обновится автоматически; повторно запускать подготовку не нужно.',
    currentStep, tone: 'muted', awaitingStatus: true,
  };
  if (letters) return {
    title: job?.status === 'running' ? 'Готовим A/B-письма' : 'Подготовка писем в очереди',
    description: job?.status === 'running'
      ? 'ИИ готовит письма по гипотезе и составу проверенной базы: разные заходы и призывы к действию, а также темы первого письма. После завершения откроется редактор.'
      : 'База проверена и разобрана. Следующий этап — генерация писем; он начнётся автоматически. После завершения откроется редактор.',
    currentStep, tone: job?.status === 'running' ? 'info' : 'muted',
  };
  if (analyzing) return {
    title: job?.status === 'running' ? 'Разбираем состав проверенной базы' : 'Разбор базы в очереди',
    description: job?.status === 'running'
      ? 'Система определяет, какие компании вошли в базу и почему подходят под гипотезу. Этот разбор будет использован для подготовки писем.'
      : 'Контакты собраны и проверены. Система автоматически разберёт состав базы, затем подготовит письма.',
    currentStep, tone: job?.status === 'running' ? 'info' : 'muted',
  };
  if (base?.status === 'analyzed') return {
    title: 'База разобрана, письма — следующий этап',
    description: 'Проверка и разбор базы завершены. Система автоматически перейдёт к подготовке писем.',
    currentStep: 2, tone: 'muted',
  };
  if (job?.status === 'done') return {
    title: 'Сбор сейчас не выполняется',
    description: 'Задача завершилась, но подготовка базы осталась незаконченной. Результаты сохранены.',
    currentStep: null, tone: 'muted', canContinue: true,
  };
  const info = base?.collect_info as (VeCollectInfo & { validation_retry?: boolean }) | null | undefined;
  const savedReview = info?.validation_retry || info?.relevance_review_requested || info?.saved_email_review_pending
    || info?.company_name_recovery || job?.payload?.review_relevance;
  if (info?.waiting_for_base_id) return {
    title: 'Ждём завершения другой базы проекта',
    description: 'Другая сборка по этой же гипотезе ещё работает. Эта база продолжится автоматически после неё.',
    currentStep: 0, tone: 'muted',
  };
  // Метку сна оставляют и упавшие, и отменённые базы: подпись — только у идущего сбора.
  if (base?.status === 'collecting' && info?.two_gis_sleep) {
    const sleep = info.two_gis_sleep;
    const since = typeof sleep.since === 'string' ? Date.parse(sleep.since) : Number.NaN;
    const from = Number.isFinite(since) ? ` с ${new Date(since).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК` : '';
    const label = veTwoGisSleepReasonLabel(sleep.reason);
    return {
      title: 'Ждём справочник организаций',
      description: `${label.charAt(0).toUpperCase()}${label.slice(1)}${from}. Сбор продолжится сам.`,
      currentStep: 0, tone: 'muted',
    };
  }
  if (job?.status === 'pending' && getVeCollectionFailure(job.error).kind === 'provider') return {
    title: 'Проверка продолжится автоматически после сбоя поиска',
    description: 'Сервис поиска Serper временно не ответил. Повторная попытка поставлена в очередь с паузой. Система продолжит с сохранённого этапа; повторно нажимать кнопку не нужно.',
    currentStep: 0, tone: 'muted',
  };
  // The coordinator requeues itself while a child works. Pending is not proof
  // that collection is idle; its saved child snapshot is the stronger evidence.
  const childStatus = info?.construct?.progress?.status;
  const hasChildState = job?.status === 'pending' && !savedReview
    && ['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(childStatus ?? '');
  if (job?.status !== 'running' && !hasChildState) return {
    title: job?.status === 'pending'
      ? savedReview ? 'Проверка сохранённой базы в очереди' : 'Сбор базы в очереди'
      : 'Ожидаем обновления состояния базы',
    description: job?.status === 'pending'
      ? 'Задача создана. Обработка начнётся автоматически, когда освободится обработчик. Затем система разберёт состав базы и подготовит письма.'
      : 'Подготовка базы запрошена. Ждём подтверждения начала обработки; состояние здесь обновляется автоматически.',
    currentStep: 0, tone: 'muted', awaitingStatus: job?.status !== 'pending',
  };
  const phase = getCollectionProgress(info, job).phase;
  if (phase === 'finishing' && job?.status !== 'running') return {
    title: 'Контакты обработаны, ожидают проверки соответствия гипотезе',
    description: 'Поиск и проверка email этого пакета завершены. Затем система проверит деятельность компаний. В готовую базу попадут контакты, прошедшие все проверки.',
    currentStep: 0, tone: 'muted',
  };
  if (phase === 'processing' && childStatus === 'processing') {
    const key = info?.construct?.progress?.current_step_key ?? '';
    return {
      title: CONSTRUCT_STEPS[key] ?? COLLECT_PHASES.processing[0],
      description: key === 'validate_emails'
        ? 'Проверяем найденные адреса. Ответы почтовых серверов и повторные проверки могут занимать время. Затем проверим соответствие компаний гипотезе; готовые контакты появятся после всех проверок.'
        : COLLECT_PHASES.processing[1],
      currentStep: 0, tone: 'info',
    };
  }
  const [title, description] = info?.validation_retry && phase !== 'reviewing_relevance' && !info.company_name_recovery && !info.saved_email_review_pending
    ? ['Продолжаем проверку сохранённых контактов', 'Система продолжает автоматическую проверку уже найденных контактов: соответствие компаний гипотезе и пригодность email для рассылки. После проверки начнётся разбор базы.']
    : COLLECT_PHASES[phase];
  return { title, description, currentStep: 0, tone: phase === 'construct_failed' ? 'err' : phase === 'construct_queued' ? 'muted' : 'info' };
}

/** Explain who acts next without treating missing queue evidence as active work. */
export function getPreparationPresentation(props: PreparationProgressProps): PreparationPresentation & Required<Pick<PreparationPresentation, 'guidance'>> {
  const paused = !!props.preparation?.paused_at || (props.preparation?.status !== 'ready' && !!props.preparation?.cancelled_at);
  const baseId = props.preparation?.base_id ?? props.base?.id;
  // Only the latest pending invocation of this base's stage can be waiting.
  // A cancelled/failed historical job never promises automatic continuation.
  const billingWait = !paused && baseId ? ['base_collect', 'base_analyze', 'template']
    .map((stage) => props.jobs.find((job) => job.payload?.base_id === baseId && job.stage === stage))
    .map((job) => job?.status === 'pending' ? veRequestyBillingWaitState(job.payload) : null)
    .find((wait) => wait !== null) : null;
  if (billingWait) return {
    title: billingWait.title, description: billingWait.description, currentStep: null, tone: 'muted',
    guidance: { action: billingWait.requiresAdmin ? 'check' : 'wait', title: billingWait.title, next: billingWait.description },
  };
  const state = getPreparationStage(props);
  const continuation = props.base?.collection_continuation;
  const target = props.base?.collect_info?.target_progress;
  const terminalCollection = !!target && ['limited', 'exhausted', 'error'].includes(target.status);
  const downstreamRetry = props.preparation?.status !== 'ready' && (props.base?.row_count ?? 0) > 0
    && ['template', 'base_analyze'].some((stage) => {
      const job = props.jobs.find((candidate) => candidate.payload?.base_id === props.base?.id && candidate.stage === stage);
      return job && ['failed', 'cancelled'].includes(job.status);
    });
  const hasLiveJob = ['base_collect', 'base_analyze', 'template'].some((stage) => {
    const job = props.jobs.find((candidate) => candidate.payload?.base_id === props.base?.id && candidate.stage === stage);
    return job && ['pending', 'running'].includes(job.status);
  });
  const canResumePreparedBase = !!props.preparation && props.preparation.status !== 'ready'
    && props.base?.status === 'analyzed' && props.base.row_count > 0 && !hasLiveJob
    && continuation?.code !== 'already_running'
    && (continuation?.action === 'resume_preparation' || target?.status === 'target_reached');
  if (canResumePreparedBase) {
    state.canContinue = true;
    state.continueLabel = 'Продолжить подготовку';
    if (state.tone !== 'err' && continuation?.code !== 'preparation_incomplete') {
      state.title = 'База собрана, письма ещё не готовы';
      state.description = 'Проверенные контакты сохранены.';
      state.currentStep = 2;
      state.tone = 'muted';
    }
  }
  if (terminalCollection && !downstreamRetry && !canResumePreparedBase && !hasLiveJob && continuation?.code !== 'already_running'
    && ['pending', 'collecting'].includes(props.preparation?.status ?? '')) {
    // A stale preparation row is not evidence of queued work. The complete
    // server decision, rather than a past request, controls the next action.
    state.title = 'Подготовка сейчас не выполняется';
    state.description = 'Результаты предыдущей попытки сохранены.';
    state.currentStep = null;
    state.tone = 'muted';
    state.canContinue = true;
  }
  if (state.canContinue && !downstreamRetry && !canResumePreparedBase) {
    if (continuation) {
      state.continuationUnconfirmed = continuation.code === 'state_unchecked';
      state.canContinue = !state.continuationUnconfirmed && continuation.available && continuation.action !== null;
      state.continuationBlocked = !state.canContinue && !state.continuationUnconfirmed;
      state.continueLabel = continuation.action === 'resume_collection' ? 'Собрать ещё контакты' : 'Продолжить подготовку';
      state.continueHint = state.continuationUnconfirmed ? undefined : continuation.reason;
    } else if (terminalCollection) {
      // Older API snapshots omit the full saved state. Do not guess that an
      // exhausted plan has another paid or productive pass left.
      state.canContinue = false;
      state.continuationUnconfirmed = true;
    }
  }
  if (state.tone === 'ok') {
    if (terminalCollection) {
      state.collectionSummary = [state.description, state.continueHint].filter(Boolean).join(' ');
    }
    // A finished base needs no retry. The only optional action is confirmed
    // collection; an unknown cache is resolved automatically by the parent.
    state.canContinue = continuation?.available === true && continuation.action === 'resume_collection'
      && continuation.code !== 'state_unchecked';
    if (state.canContinue) state.continueLabel = 'Собрать ещё контакты';
    state.continuationBlocked = false;
    state.continueHint = undefined;
  }
  if (paused) {
    state.title = 'Подготовка на паузе';
    state.description = 'Контакты, письма и согласования сохранены. Остальные базы работают независимо.';
    state.currentStep = null;
    state.tone = 'muted';
    // A new explicit pause fences unfinished work. Older cancellations still
    // need a full continuation verdict, especially after an exhausted attempt.
    if (props.preparation?.paused_at) {
      state.canContinue = true;
      state.continuationBlocked = false;
      state.continuationUnconfirmed = false;
      state.continueLabel = 'Продолжить подготовку';
      state.continueHint = undefined;
    }
  }
  let guidance: NonNullable<PreparationPresentation['guidance']>;
  if (!props.preparation && hasActivePreparation(props)) {
    guidance = { action: 'wait', title: 'Подготовка базы выполняется', next: 'Повторно начинать подготовку не нужно. Статус обновляется автоматически.' };
  } else if (!props.preparation) {
    guidance = { action: 'start', title: 'Подготовка ещё не начата', next: 'Нажмите «Начать подготовку» для этой гипотезы.' };
  } else if (paused && state.canContinue) {
    guidance = { action: 'continue', title: 'Подготовка на паузе', next: 'Продолжите, когда эта база понадобится. Работа начнётся с сохранённого этапа.' };
  } else if (state.tone === 'ok' && props.approved) {
    guidance = { action: 'launch', title: 'База и письма одобрены', next: props.senderChoice
      ? 'Перейдите к запуску этой базы. Кампании будут созданы в Instantly на паузе или черновиками в «Рассылке» — выберите при запуске.'
      : 'Перейдите к запуску этой базы. Система подготовит кампанию в Instantly; отправку вы включите там сами.' };
  } else if (state.tone === 'ok') {
    guidance = { action: 'review', title: 'База и письма готовы', next: 'Скачайте контакты или проверьте базу и письма для запуска. После проверки одобрите базу.' };
  } else if (props.context === 'letters' && props.base?.status === 'failed' && state.tone === 'muted') {
    guidance = { action: 'check', title: 'Нужно проверить состояние базы', next: 'Откройте «Базы и объём»: там указаны причина остановки и доступные действия.' };
  } else if (state.continuationUnconfirmed) {
    guidance = { action: 'check', title: 'Подготовка не завершена', next: 'Возможность продолжения пока не подтверждена. Новый сбор не запускается.' };
  } else if (state.canContinue) {
    guidance = { action: 'continue', title: 'Можно продолжить подготовку',
      next: `Нажмите «${state.continueLabel ?? 'Продолжить подготовку'}» ниже. Работа продолжится с сохранённого этапа.` };
  } else if (state.continuationBlocked) {
    guidance = { action: 'check', title: 'Добор сейчас недоступен', next: 'Новый сбор сейчас не выполняется.' };
  } else if (state.tone === 'err') {
    guidance = { action: 'check', title: 'Подготовка не завершена', next: 'Проверьте причину ниже. Если кнопка продолжения не появится после обновления статуса, сообщите об этом администратору.' };
  } else if (state.awaitingStatus) {
    guidance = { action: 'check', title: 'Уточняем состояние подготовки', next: 'Пока не можем подтвердить, что обработка идёт. Повторно запускать её не нужно. Если статус не обновляется, сообщите администратору.' };
  } else {
    guidance = { action: 'wait', title: 'От вас сейчас ничего не требуется', next: 'Можно закрыть страницу. Когда база и письма будут готовы, здесь появится действие для проверки и одобрения.' };
  }
  return { ...state, guidance };
}

/** One preparation action, separate from downloads, approval and campaign launch. */
export function getPreparationControl(props: PreparationProgressProps): { action: 'start' | 'pause' | 'continue'; label: string } | null {
  if (props.base?.collection_continuation?.code === 'launched') return null;
  const state = getPreparationPresentation(props);
  if (!props.preparation) return hasActivePreparation(props)
    ? props.canPauseOrphan ? { action: 'pause', label: 'Приостановить' } : null
    : { action: 'start', label: 'Начать подготовку' };
  if (props.preparation.paused_at || props.preparation.cancelled_at) {
    return state.canContinue ? { action: 'continue', label: state.continueLabel ?? 'Продолжить подготовку' } : null;
  }
  if (hasActivePreparation(props)) return { action: 'pause', label: 'Приостановить' };
  if (state.canContinue) return { action: 'continue', label: state.continueLabel ?? 'Продолжить подготовку' };
  if (isLegacyPreparationIdle(props)) return null;
  const terminal = ['target_reached', 'limited', 'exhausted', 'error'].includes(props.base?.collect_info?.target_progress?.status ?? '');
  if (['pending', 'collecting', 'generating'].includes(props.preparation.status) && !terminal && !state.awaitingStatus) {
    return { action: 'pause', label: 'Приостановить' };
  }
  return null;
}

export function PreparationProgress(props: PreparationProgressProps) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
  const state = getPreparationPresentation(props);
  const control = getPreparationControl(props);
  const onAction = control?.action === 'start' ? props.onStart : control?.action === 'pause' ? props.onPause : props.onContinue;
  const action = control && onAction ? <button type="button" className={HE.btnGhost}
    disabled={control.action === 'pause' ? (props.pauseDisabled ?? props.continueDisabled) : props.continueDisabled || props.prepareDisabled}
    aria-label={props.hypothesisTitle ? `${control.label}: ${props.hypothesisTitle}` : undefined} onClick={onAction}>{control.label}</button> : null;
  const completed = state.tone === 'ok';
  const job = props.jobs.find(candidate => candidate.stage === 'base_collect' && candidate.payload?.base_id === props.base?.id);
  const progress = getCollectionProgress(props.base?.collect_info, job);
  const target = props.base?.collect_info?.target_progress;
  const savedCandidates = collectCount(target?.candidates_processed);
  const savedReady = collectCount(target?.ready_contacts) ?? collectCount(target?.ready_rows);
  const composition = describeReadyComposition(target);
  const collecting = props.base?.status === 'collecting' && state.tone !== 'err'
    && !props.preparation?.paused_at && !props.preparation?.cancelled_at && !isLegacyPreparationIdle(props);
  const stepPercent = collecting && state.tone === 'info' ? progress.stepPercent : null;
  const started = Date.parse(job?.status === 'running' ? job.started_at ?? '' : '');
  const updated = progress.relevanceUpdatedAt ?? Date.parse(props.base?.updated_at ?? '');
  const minutes = now !== null && Number.isFinite(started) && now >= started ? Math.floor((now - started) / 60_000) : null;
  const elapsed = minutes === null ? null : minutes < 1 ? 'меньше минуты' : minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  if (props.compact) return <div className="space-y-2" role={state.tone === 'err' ? 'alert' : 'status'} aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-center gap-2 font-medium"><StatusDot tone={state.tone} />
        {state.guidance.action === 'wait' ? state.title : state.guidance.title}</p>
      {action}
    </div>
    <p className={HE.muted}>{state.guidance.action === 'wait' ? state.description : state.guidance.next}</p>
    {state.tone === 'err' || props.preparation?.paused_at || props.preparation?.cancelled_at ? <p className={HE.muted}>{state.description}</p> : null}
    {state.continueHint ? <p className={HE.muted}>{state.continueHint}</p> : null}
    {control?.action === 'pause' && props.pauseDisabledReason ? <p className={HE.muted}>{props.pauseDisabledReason}</p> : null}
    {collecting && savedReady !== null ? <p className={HE.muted}>Прошли все проверки: {savedReady.toLocaleString('ru-RU')}{composition ? ` · ${composition}` : ''}</p> : null}
    {props.actionNotice ? <p role={props.actionNotice.tone === 'error' ? 'alert' : 'status'}
      className={props.actionNotice.tone === 'error' ? 've2-t-dan' : HE.muted}>{props.actionNotice.message}</p> : null}
  </div>;
  return (
    <div className="ve2-preparation" role={state.tone === 'err' ? 'alert' : 'status'} aria-live="polite">
      <div className="ve2-preparation-head">
        <StatusDot tone={state.tone} />
        <h3 className={HE.cardTitle}>{state.guidance.title}</h3>
      </div>
      {!completed && state.title !== state.guidance.title ? <p className="font-medium">{state.title}</p> : null}
      <p>{state.guidance.next}</p>
      {completed && state.collectionSummary ? <p className={HE.muted}>Подготовка завершена ниже цели. Эти контакты можно использовать, добор не обязателен.</p> : null}
      {!completed && state.readiness ? <p>{state.readiness}</p> : null}
      {completed || state.description === state.guidance.next ? null : state.guidance?.action === 'wait' ? <details>
        <summary className="ve2-link cursor-pointer">Что происходит на этом этапе</summary>
        <p className={`${HE.muted} mt-2 max-w-[70ch]`}>{state.description}</p>
      </details> : <p className={HE.muted}>{state.description}</p>}
      {stepPercent !== null ? <div className="space-y-2">
        <p className={HE.muted}>Текущий этап обработки: {stepPercent}% · это не готовность всей базы</p>
        <progress className="w-full h-2" max={100} value={stepPercent} aria-label="Прогресс текущего этапа обработки" />
      </div> : null}
      {collecting ? <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {progress.candidates !== null ? <span>Кандидатов: {progress.candidates.toLocaleString('ru-RU')}</span> : null}
        {savedReady !== null ? <span>Прошли все проверки: {savedReady.toLocaleString('ru-RU')}</span> : null}
        {composition ? <span>{composition}</span> : null}
      </div> : null}
      {collecting && savedReady === 0 && state.guidance?.action === 'wait' ? (
        <p className={HE.muted}>Проверенных контактов пока нет. Найденные кандидаты появятся в готовой базе только после всех проверок.</p>
      ) : null}
      {collecting && (elapsed || Number.isFinite(updated)) ? <p className={HE.muted}>
        {elapsed ? `Текущая попытка: ${elapsed}. ` : ''}
        {Number.isFinite(updated) ? `${progress.relevanceUpdatedAt !== null ? 'Последнее сохранение проверки:' : 'Статус обновлён'} ${new Date(updated).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...(progress.relevanceUpdatedAt !== null ? { second: '2-digit' } : {}) })} МСК. ` : ''}
        Время завершения пока неизвестно.
      </p> : null}
      <ol className="ve2-preparation-steps" aria-label="Этапы подготовки">
        {STEPS.map((label, index) => (
          <li key={label} data-state={state.currentStep === index ? 'current' : state.currentStep !== null && state.currentStep > index ? 'done' : 'pending'} aria-current={state.currentStep === index ? 'step' : undefined}>
            <span className="ve2-preparation-step-num" aria-hidden="true">{state.currentStep !== null && state.currentStep > index ? '✓' : index + 1}</span>
            <span>{state.currentStep !== null && state.currentStep > index ? <span className="sr-only">Завершено: </span> : null}{label}</span>
          </li>
        ))}
      </ol>
      {!collecting && state.currentStep !== STEPS.length && savedCandidates !== null && savedCandidates > 0 ? (
        <p className={HE.muted}>
          Сохранённые результаты: {savedCandidates.toLocaleString('ru-RU')} кандидатов
          {savedReady !== null ? `; проверенных контактов: ${savedReady.toLocaleString('ru-RU')}` : ''}.
        </p>
      ) : null}
      {props.actionNotice ? <p role={props.actionNotice.tone === 'error' ? 'alert' : 'status'}
        className={props.actionNotice.tone === 'error' ? 've2-t-dan' : HE.muted}>{props.actionNotice.message}</p> : null}
      {action}
      {control?.action === 'pause' && props.pauseDisabledReason ? <p className={HE.muted}>{props.pauseDisabledReason}</p> : null}
      {state.continueHint ? <p className={HE.muted}>{state.continueHint}</p> : null}
      {state.collectionSummary ? <details>
        <summary className="ve2-link cursor-pointer">О сборе базы</summary>
        <p className={`${HE.muted} mt-2 max-w-[70ch]`}>{state.collectionSummary}</p>
      </details> : null}
    </div>
  );
}
