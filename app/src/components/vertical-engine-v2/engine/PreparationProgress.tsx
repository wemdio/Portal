'use client';

import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import { getVeCollectionFailure } from '@/lib/verticalEngineV2/collectionErrors';
import type { VeBaseSummary, VeCollectInfo, VeJobSummary } from './api';
import { collectCount, getCollectionProgress } from './collectionProgress';
import { HE, StatusDot } from './design';

interface PreparationProgressProps {
  preparation?: VeOutreachPreparation | null;
  base?: VeBaseSummary | null;
  /** Project detail supplies jobs newest first; its history is intentionally bounded. */
  jobs: readonly VeJobSummary[];
}

interface PreparationPresentation {
  title: string;
  description: string;
  currentStep: number | null;
  tone: 'info' | 'muted' | 'err' | 'ok';
}

const STEPS = ['Сбор и проверка базы', 'Разбор состава базы', 'Подготовка A/B-писем'];

function preparationError(message: string): string {
  const failure = getVeCollectionFailure(message);
  return ['billing', 'configuration', 'provider'].includes(failure.kind) ? failure.message : message;
}
const COLLECT_PHASES: Record<ReturnType<typeof getCollectionProgress>['phase'], [string, string]> = {
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
export function getPreparationPresentation({ preparation, base, jobs }: PreparationProgressProps): PreparationPresentation {
  if (!preparation) return {
    title: 'Подготовка ещё не запущена',
    description: 'Выберите гипотезы и запустите подготовку. Система соберёт и проверит базу, разберёт её состав и подготовит письма.',
    currentStep: null, tone: 'muted',
  };
  if (preparation.status === 'error') return {
    title: 'Подготовка остановлена',
    description: preparation.last_error ? preparationError(preparation.last_error) : 'Не удалось завершить подготовку. Нажмите «Продолжить подготовку», чтобы повторить остановленный этап.',
    currentStep: null, tone: 'err',
  };
  if (preparation.status === 'ready') return {
    title: 'Письма и база готовы',
    description: 'Можно выбрать и отредактировать письма, затем проверить и одобрить базу.',
    currentStep: STEPS.length, tone: 'ok',
  };
  if (preparation.status === 'pending') return {
    title: 'Подготовка в очереди',
    description: 'Запрос принят. Система начнёт подготовку автоматически и продолжит с сохранённого этапа. Здесь появится текущий этап работы; страницу можно закрыть.',
    currentStep: null, tone: 'muted',
  };

  // The response contains only recent jobs. A missing job is not evidence of a
  // running worker, a failed worker, or the project's position in the queue.
  const baseId = preparation.base_id;
  const jobFor = (stage: VeJobSummary['stage']) => baseId
    ? jobs.find((job) => job.payload?.base_id === baseId && job.stage === stage)
    : undefined;
  const templateJob = jobFor('template');
  const letters = preparation.status === 'generating'
    || (base?.status === 'analyzed' && templateJob && ['pending', 'running'].includes(templateJob.status));
  const analyzing = base?.status === 'analyzing';
  const job = letters ? templateJob : base?.status === 'analyzed' ? undefined : jobFor(analyzing ? 'base_analyze' : 'base_collect');
  const currentStep = letters ? 2 : analyzing ? 1 : 0;

  if (base?.status === 'failed' || (job && ['failed', 'cancelled'].includes(job.status))) return {
    title: 'Подготовка остановлена',
    description: preparationError(preparation.last_error || base?.error || job?.error || 'Этап не завершился. Состояние подготовки обновится автоматически.'),
    currentStep: null, tone: 'err',
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
  const info = base?.collect_info as (VeCollectInfo & { validation_retry?: boolean }) | null | undefined;
  const savedReview = info?.validation_retry || info?.relevance_review_requested || info?.saved_email_review_pending
    || info?.company_name_recovery || job?.payload?.review_relevance;
  if (info?.waiting_for_base_id) return {
    title: 'Ждём завершения другой базы проекта',
    description: 'Базы этого проекта собираются по очереди, чтобы исключать повторные контакты. Эта база продолжится автоматически.',
    currentStep: 0, tone: 'muted',
  };
  if (job?.status === 'pending' && getVeCollectionFailure(job.error).kind === 'provider') return {
    title: 'Проверка продолжится автоматически после сбоя поиска',
    description: 'Сервис поиска Serper временно не ответил. Повторная попытка поставлена в очередь с паузой. Система продолжит с сохранённого этапа; повторно нажимать кнопку не нужно.',
    currentStep: 0, tone: 'muted',
  };
  if (job?.status !== 'running') return {
    title: job?.status === 'pending'
      ? savedReview ? 'Проверка сохранённой базы в очереди' : 'Сбор базы в очереди'
      : job?.status === 'done' ? 'Проверка завершена, обновляем результат' : 'Ожидаем обновления состояния базы',
    description: job?.status === 'pending'
      ? 'Задача создана. Обработка начнётся автоматически, когда освободится обработчик. Затем система разберёт состав базы и подготовит письма.'
      : job?.status === 'done'
        ? 'Задача сбора и проверки завершилась. Ждём обновления результата базы, чтобы перейти к следующему этапу.'
        : 'Подготовка базы запрошена. Ждём подтверждения начала обработки; состояние здесь обновляется автоматически.',
    currentStep: 0, tone: 'muted',
  };
  const phase = getCollectionProgress(info, job).phase;
  const [title, description] = info?.validation_retry && !info.company_name_recovery && !info.saved_email_review_pending
    ? ['Продолжаем проверку сохранённых контактов', 'Система продолжает автоматическую проверку уже найденных контактов: соответствие компаний гипотезе и пригодность email для рассылки. После проверки начнётся разбор базы.']
    : COLLECT_PHASES[phase];
  return { title, description, currentStep: 0, tone: phase === 'construct_failed' ? 'err' : phase === 'construct_queued' ? 'muted' : 'info' };
}

export function PreparationProgress(props: PreparationProgressProps) {
  const state = getPreparationPresentation(props);
  const target = props.base?.collect_info?.target_progress;
  const savedCandidates = collectCount(target?.candidates_processed);
  const savedReady = collectCount(target?.ready_rows);
  const showSaved = savedCandidates !== null && savedCandidates > 0;
  return (
    <div className="ve2-preparation" role={state.tone === 'err' ? 'alert' : 'status'} aria-live="polite">
      <div className="ve2-preparation-head">
        <StatusDot tone={state.tone} />
        <h3 className={HE.cardTitle}>{state.title}</h3>
      </div>
      <p className={HE.muted}>{state.description}</p>
      <ol className="ve2-preparation-steps" aria-label="Этапы подготовки">
        {STEPS.map((label, index) => (
          <li key={label} data-state={state.currentStep === index ? 'current' : state.currentStep !== null && state.currentStep > index ? 'done' : 'pending'} aria-current={state.currentStep === index ? 'step' : undefined}>
            <span className="ve2-preparation-step-num" aria-hidden="true">{index + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      {showSaved ? (
        <p className={HE.muted}>
          Сохранённые результаты: {savedCandidates.toLocaleString('ru-RU')} кандидатов
          {savedReady !== null ? `, ${savedReady.toLocaleString('ru-RU')} готовых контактов` : ''}.
        </p>
      ) : null}
    </div>
  );
}
