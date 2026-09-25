'use client';

import { useEffect, useState } from 'react';
import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import { getVeCollectionFailure } from '@/lib/verticalEngineV2/collectionErrors';
import type { VeBaseSummary, VeCollectInfo, VeJobSummary } from './api';
import { collectCount, describeCompletedCollection, describeReadyComposition, getCollectionProgress, isPartialPreview } from './collectionProgress';
import { HE, StatusDot } from './design';

interface PreparationProgressProps {
  context?: 'letters' | 'base';
  preparation?: VeOutreachPreparation | null;
  base?: VeBaseSummary | null;
  /** Project detail supplies jobs newest first; its history is intentionally bounded. */
  jobs: readonly VeJobSummary[];
  onContinue?: () => void;
  continueDisabled?: boolean;
}

export interface PreparationPresentation {
  title: string;
  description: string;
  readiness?: string;
  currentStep: number | null;
  tone: 'info' | 'muted' | 'err' | 'ok';
  canContinue?: boolean;
  continueLabel?: string;
  continueHint?: string;
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
    return 'Продолжение подготовки прервалось. Сейчас база не обрабатывается. Нажмите «Продолжить подготовку», чтобы возобновить работу с сохранёнными результатами.';
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
  reviewing_relevance: ['Проверяем соответствие компаний гипотезе', 'Система автоматически проверяет сведения о сохранённых компаниях и подтверждения на их сайтах. Контакты без подтверждения не попадут в готовую базу.'],
  reviewing_emails: ['Проверяем сохранённые email', 'Продолжаем проверку уже найденных адресов. После неё система завершит отбор компаний под гипотезу и разберёт состав базы.'],
  construct_failed: ['Обработка контактов остановлена', 'Обработчик сообщил об остановке. Причина появится после обновления состояния подготовки.'],
};

/** Queue evidence takes precedence over snapshots left by a previous attempt. */
export function getPreparationPresentation({ preparation, base, jobs, context = 'base' }: PreparationProgressProps): PreparationPresentation {
  if (!preparation) return {
    title: 'Подготовка ещё не запущена',
    description: 'Выберите гипотезы и запустите подготовку. Система соберёт и проверит базу, разберёт её состав и подготовит письма.',
    currentStep: null, tone: 'muted',
  };
  const baseId = preparation.base_id;
  const jobFor = (stage: VeJobSummary['stage']) => baseId
    ? jobs.find((job) => job.payload?.base_id === baseId && job.stage === stage)
    : undefined;
  const hasLiveJob = ['base_collect', 'base_analyze', 'template'].some((stage) => {
    const job = jobFor(stage as VeJobSummary['stage']);
    return job && ['pending', 'running'].includes(job.status);
  });
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
    continueLabel: preparation.status === 'ready' && target.status !== 'error' ? 'Повторить добор' : undefined,
    continueHint: 'Повторная попытка продолжит работу с сохранёнными результатами. Если источники снова дадут только повторы, новых контактов не будет.',
  };
  if (context === 'letters' && base?.status === 'failed' && !hasLiveJob) return {
    title: 'Письма ждут завершения подготовки базы',
    description: 'Подготовка остановилась до генерации писем. Причина и продолжение сбора доступны на шаге «Базы и объём».',
    currentStep: 0, tone: 'muted',
  };
  if (preparation.status === 'error' && !hasLiveJob) return {
    title: 'Подготовка остановлена',
    description: preparation.last_error ? preparationError(preparation.last_error) : 'Не удалось завершить подготовку. Нажмите «Продолжить подготовку», чтобы повторить остановленный этап.',
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
    currentStep, tone: 'muted',
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
    description: 'Задача завершилась, но подготовка базы осталась незаконченной. Результаты сохранены. Нажмите «Продолжить подготовку», чтобы возобновить незавершённые этапы.',
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
    currentStep: 0, tone: 'muted',
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
  const [title, description] = info?.validation_retry && !info.company_name_recovery && !info.saved_email_review_pending
    ? ['Продолжаем проверку сохранённых контактов', 'Система продолжает автоматическую проверку уже найденных контактов: соответствие компаний гипотезе и пригодность email для рассылки. После проверки начнётся разбор базы.']
    : COLLECT_PHASES[phase];
  return { title, description, currentStep: 0, tone: phase === 'construct_failed' ? 'err' : phase === 'construct_queued' ? 'muted' : 'info' };
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
  const job = props.jobs.find(candidate => candidate.stage === 'base_collect' && candidate.payload?.base_id === props.base?.id);
  const progress = getCollectionProgress(props.base?.collect_info, job);
  const target = props.base?.collect_info?.target_progress;
  const savedCandidates = collectCount(target?.candidates_processed);
  const savedReady = collectCount(target?.ready_contacts) ?? collectCount(target?.ready_rows);
  const composition = describeReadyComposition(target);
  const collecting = props.base?.status === 'collecting' && state.tone !== 'err';
  const stepPercent = collecting && state.tone === 'info' ? progress.stepPercent : null;
  const started = Date.parse(props.base?.created_at ?? '');
  const updated = Date.parse(props.base?.updated_at ?? '');
  const minutes = now !== null && Number.isFinite(started) && now >= started ? Math.floor((now - started) / 60_000) : null;
  const elapsed = minutes === null ? null : minutes < 1 ? 'меньше минуты' : minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  return (
    <div className="ve2-preparation" role={state.tone === 'err' ? 'alert' : 'status'} aria-live="polite">
      <div className="ve2-preparation-head">
        <StatusDot tone={state.tone} />
        <h3 className={HE.cardTitle}>{state.title}</h3>
      </div>
      {state.readiness ? <p>{state.readiness}</p> : null}
      <p className={HE.muted}>{state.description}</p>
      {stepPercent !== null ? <div className="space-y-2">
        <p className={HE.muted}>Текущий этап обработки: {stepPercent}% · это не готовность всей базы</p>
        <progress className="w-full h-2" max={100} value={stepPercent} aria-label="Прогресс текущего этапа обработки" />
      </div> : null}
      {collecting ? <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {progress.candidates !== null ? <span>Кандидатов: {progress.candidates.toLocaleString('ru-RU')}</span> : null}
        {savedReady !== null ? <span>Прошли все проверки: {savedReady.toLocaleString('ru-RU')}</span> : null}
        {composition ? <span>{composition}</span> : null}
      </div> : null}
      {collecting && (elapsed || Number.isFinite(updated)) ? <p className={HE.muted}>
        {elapsed ? `С момента создания базы: ${elapsed}. ` : ''}
        {Number.isFinite(updated) ? `Статус обновлён ${new Date(updated).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК. ` : ''}
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
      {state.canContinue && props.onContinue ? <div className="space-y-2">
        <button type="button" className={state.continueLabel ? HE.btnGhost : HE.btnPrimary} disabled={props.continueDisabled} onClick={props.onContinue}>
          {state.continueLabel ?? 'Продолжить подготовку'}
        </button>
        {state.continueHint ? <p className={HE.faint}>{state.continueHint}</p> : null}
      </div> : null}
    </div>
  );
}
