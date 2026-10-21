'use client';

/**
 * Fetch-обёртка и DTO клиентского ENG-кабинета «Движка вертикалей».
 * Кодируется строго под контракт /api/client/eng/*.
 *
 * DTO staff-мастера (components/hypothesis-engine/api) переиспользуются только
 * там, где контракт совпал. Совпадает он не везде: клиентские роуты отдают
 * строки через проекцию (lib/hypothesisEngine/clientEngProjection), и типы
 * staff обещают то, чего в ответе кабинета нет, — `tokens_used`/`cost_usd` у
 * джобы и цепочки, `error`/`progress` у джобы, `evidence` у гипотезы,
 * `campaign_url`/`preset_id` у записи о запуске, `plan` у collect_info.
 * Такие типы сужены ниже поимённо.
 */

import { clientApiFetch } from '@/lib/clientFetcher';
import { AuthExpiredError, authFetch } from '@/lib/authFetch';
import { engErrorText, localizeEngError } from './engText';
import type { HeChainLetterDto, HeProjectDetailResponse } from '@/components/hypothesis-engine/api';
import type { HeChain, HeHypothesis, HeJob, HeProject } from '@/lib/hypothesisEngine/types';
import type { HeIcpFrame } from '@/lib/hypothesisEngine/icpFrame';
import type { HeTemplateLaunchCampaign, HeTemplateLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
// Только типы: сводка отправки запуска и коды неудачного старта — один словарь
// на роуты (lib/hypothesisEngine/engCampaignStatus) и на экран.
import type {
  HeEngSendingAction,
  HeEngSendingSecondaryAction,
  HeEngSendingSummary,
  HeEngStartErrorCode,
} from '@/lib/hypothesisEngine/engCampaignStatus';
// Только тип — см. пояснение в engText.ts: словарь кодов один на оба конца
// провода, а сам модуль проекции в клиентский бандл не уезжает.
import type {
  ClientEngAutopilotHold,
  ClientEngTemplatePlaceholder,
  HeClientAutopilotHoldCode,
  HeClientRefillState,
  HeClientStageErrorCode,
} from '@/lib/hypothesisEngine/clientEngProjection';
// Только тип: код отказа гейта платных шагов (lib/hypothesisEngine/engPaidAccess)
// — один словарь на роуты и на экран; сам модуль в клиентский бандл не едет.
import type { EngPaidAccessCode } from '@/lib/hypothesisEngine/engPaidAccess';
import type { EngCollectionProgress, EngCompanyQualificationSummary } from '@/lib/hypothesisEngine/engCollectionProgress';
import type { HeBrandInputLeak } from '@/lib/hypothesisEngine/letterBrandGuard';
import type { EngResearchRetryVerdict } from '@/lib/hypothesisEngine/researchJob';
// Только типы автозапуска (S3) — см. «Запуск проекта одной кнопкой» ниже.
import type {
  EngAutoLaunchDetail,
  EngAutoLaunchMarket,
  HeEngAutoLaunchCode,
  HeEngAutoLaunchState,
} from '@/lib/hypothesisEngine/engAutoLaunch';
// Тоже только типы: этап и причина карточки дашборда — один словарь на роут
// (lib/hypothesisEngine/engDashboard) и на экран.
import type {
  EngDashAnalysisStopped,
  EngDashAttention,
  EngDashAutoLaunch,
  EngDashAttentionInfo,
  EngDashSelection,
  EngDashStage,
  EngDashTeamFix,
  EngDashTopUp,
  EngDashTopUpVerdict,
  EngTeamFixStop,
} from '@/lib/hypothesisEngine/engDashboard';

// `HeBaseSummary`/`HeProjectDetailResponse` отсюда БОЛЬШЕ НЕ реэкспортируются:
// оба обещают `error: string` — сырой текст стадии, которого в ответе кабинета
// нет. Их суженные пары — `EngBaseSummary` и `EngProjectDetailResponse` ниже.
// Письмо цепочки у обоих контуров одно и то же, его реэкспорт остаётся.
export type { HeChainLetterDto } from '@/components/hypothesis-engine/api';
export type { HeEngSendingAction, HeEngSendingSecondaryAction, HeEngSendingSummary, HeEngStartErrorCode };
export type { EngCollectionProgress, EngCollectionStep } from '@/lib/hypothesisEngine/engCollectionProgress';

import type { HeBaseSummary as HeBaseSummaryDto } from '@/components/hypothesis-engine/api';

/**
 * ДТО кабинета описывают ответ ПОСЛЕ клиентской проекции
 * (`lib/hypothesisEngine/clientEngProjection`), а не строку таблицы. Тип шире
 * ответа — это не мелочь: компилятор пропускает чтение поля, которого в JSON
 * нет, и экран молча получает `undefined` вместо значения. Поэтому staff-DTO
 * (`components/hypothesis-engine/api`) тут переиспользуются только там, где
 * контракт совпадает, а остальные сужены поимённо.
 */

/**
 * Джоба движка в ответах кабинета: деталка проекта и три мутирующих роута
 * (создание проекта, цепочка, шаблон).
 *
 * Уже staff-DTO на `error` (сырой текст стадии, его показывать нельзя),
 * `progress` (подпись прогресса) и всё, чего нет в JOB_FIELDS, — включая
 * `tokens_used`/`cost_usd`, из-за которых волна и переписывала эти роуты.
 *
 * Имя прежнее: под ним тип импортируют шаги мастера (EngStepBrief,
 * EngStepLaunch).
 */
export type HeJobSummary = Pick<HeJob, 'id' | 'stage' | 'status' | 'attempts' | 'started_at'> & {
  /** Колонки в HeJob нет (как и в staff-DTO), а в выдаче она есть. */
  finished_at?: string | null;
  /** Вход стадии, суженный до привязки джобы (JOB_PAYLOAD_FIELDS). */
  payload?: { vertical_id?: string; base_id?: string } | null;
};

/**
 * Проект кабинета: без `created_by`, себестоимости и модели
 * (PROJECT_FIELDS). `brief` отдаёт только PATCH брифа — в списке и в ответе на
 * создание его нет.
 *
 * `error` из `HeProject` НЕ берём: роут отдаёт вместо текста стадии машинный
 * код причины. Тип поля здесь — не косметика: пока он обещал `string`,
 * компилятор пропускал `{project.error}` прямо в JSX.
 */
export type EngProject = Pick<
  HeProject,
  'id' | 'name' | 'website_url' | 'status' | 'market' | 'autopilot' | 'created_at' | 'updated_at'
> & {
  brief?: HeProject['brief'];
  /** Причина падения research-пайплайна; `null`/нет ключа — падения не было. */
  error_code?: HeClientStageErrorCode | null;
  /**
   * Почему автопилот не продвинул проект на последней сверке; `null` — паузы
   * нет. Ключа НЕТ в ответах, которые колонку не читают (список проектов и
   * ответ на создание идут по `HE_PROJECT_CLIENT_COLUMNS`, куда
   * `autopilot_error` не добавлен) — поэтому поле опциональное, а не
   * `| null`: обещать в типе то, чего в JSON нет, значит разрешить
   * компилятору молча прочитать `undefined`.
   */
  autopilot_hold?: ClientEngAutopilotHold | null;
  /**
   * Можно ли сейчас выбирать страны сбора (выключатель HE_ENG_COLLECT_COUNTRIES,
   * план §1A). Ключа нет — сервер старше: карточку «Countries» не рисуем.
   * Сам список — в `brief.collect_countries` (engCollectCountriesOf).
   */
  collect_countries_enabled?: boolean;
};

/**
 * Страны сбора проекта из `brief` (план §1A): `collect_countries` — значения
 * каталога, `unavailable` — сохранённые, которых каталог больше не знает
 * (сборка по ним ничего не находит). Ключей нет — список пуст.
 */
export function engCollectCountriesOf(brief: unknown): { countries: string[]; unavailable: string[] } {
  const b = brief && typeof brief === 'object' ? (brief as Record<string, unknown>) : null;
  const strings = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  return { countries: strings(b?.collect_countries), unavailable: strings(b?.collect_countries_unavailable) };
}

/** Гипотеза после разметки: без `evidence` (цитаты и ссылки стадии). */
export type EngHypothesis = Pick<
  HeHypothesis,
  | 'id'
  | 'project_id'
  | 'vertical_id'
  | 'tier'
  | 'title'
  | 'description'
  | 'fit_rationale'
  | 'potential_pct'
  | 'status'
>;

/** Цепочка писем кабинета: без `tokens_used`/`cost_usd` (CHAIN_FIELDS). */
export type HeChainDto = Pick<
  HeChain,
  'id' | 'vertical_id' | 'language' | 'status' | 'created_at' | 'updated_at'
> & {
  letters: HeChainLetterDto[];
};

/**
 * Запись о запуске в ответах кабинета: без `campaign_url` (ссылка на панель
 * рассыльщика — кабинет white-label) и без `preset_id`. `campaign_id` остаётся:
 * по нему `parseLaunchInfo` отличает уже запущенный шаблон, иначе шаг «Review &
 * Launch» предложит второй запуск по той же аудитории.
 */
export type EngTemplateLaunchInfo = Omit<
  HeTemplateLaunchInfo,
  'campaign_url' | 'preset_id' | 'campaigns'
> & {
  campaigns?: Array<Omit<HeTemplateLaunchCampaign, 'campaign_url'>>;
};

/**
 * collect_info кабинета. `plan` (срезы каталога с `pdl_filters` и поисковые
 * запросы) и `hypothesis_ids` из staff-DTO здесь отсутствуют намеренно:
 * проекция их вырезает.
 */
export interface HeCollectInfo {
  /** Лимит строк, выбранный при запуске сборки (у старых записей поля нет). */
  limit?: number | null;
  tasks?: Array<{ status?: string; rows?: number; source?: string }> | null;
  plan_repair?: { reason?: string; outcome?: string } | null;
  slice_probe?: {
    outcome?: string;
    hit_rate?: number;
    sampled?: number;
    first_hit_rate?: number;
    off_target_examples?: string[];
    replaced_tasks?: number;
  } | null;
}

/**
 * Состояние фазы CONSTRUCT в collect_info — зеркало HeConstructInfo стадии
 * base_collect, но только той части, что доезжает до кабинета.
 *
 * `bc_job_id` здесь нет намеренно: клиентская проекция (CONSTRUCT_FIELDS в
 * `lib/hypothesisEngine/clientEngProjection`) вырезает id внутренней джобы, и
 * обязательное поле в DTO обещало бы то, чего в ответе нет, — компилятор такое
 * чтение пропустил бы, а в рантайме пришёл бы undefined.
 */
export interface EngConstructInfo {
  status: 'dispatched' | 'done' | 'failed' | 'cancelled';
  /** Почт найдено конструктором. */
  emails_found?: number;
  /** Почт с вердиктом ok после валидации. */
  valid_count?: number;
  note?: string;
  /**
   * Вердикты построчные (контракт «один адрес на строку»). `false` — базу
   * собирал прежний контракт, и us-запуск её откажет (baseCollectedBeforeSplit).
   * Считает проекция тем же маркером, что и запуск.
   */
  per_address_verdicts?: boolean;
}

/** Actual checked contacts, not an estimate of the audience still available. */
export interface EngCollectionTarget {
  version: 1;
  ready_target: number;
  reserve_target: number;
  ready_count: number;
  reserve_count: number;
  total_ready: number;
  phase: 'collecting' | 'building_reserve' | 'complete' | 'stopped';
  stop_reason: 'budget_limit' | 'sources_exhausted' | 'low_yield' | 'safety_limit' | 'error' | null;
  rounds_completed: number;
}

/**
 * collect_info с полями ENG-конвейера (construct + stats). Только то, что
 * отдаёт проекция (COLLECT_STATS_FIELDS / CONSTRUCT_FIELDS): поле, которого
 * в ответе нет, здесь не объявляется.
 */
export interface EngCollectInfo extends HeCollectInfo {
  construct?: EngConstructInfo;
  /** New target-based collections only; older bases have no target metadata. */
  eng_collection_target?: EngCollectionTarget;
  /** Aggregate company checks only; the underlying verdicts stay on the server. */
  company_qualification?: EngCompanyQualificationSummary;
  stats?: {
    tasks_total?: number;
    tasks_done?: number;
    tasks_failed?: number;
    rows_total?: number;
    /** Строк, которые гейт релевантности пометил как вне вертикали. */
    low_relevance?: number;
    /** Компаний, пропущенных сборкой: они в списке Do not contact клиента (план §1B). */
    excluded_do_not_contact?: number;
  };
}

/**
 * Строка базы в деталке проекта кабинета. `sample_rows` убран: превью строк
 * идёт отдельным роутом bases/[id]/rows, а BASE_FIELDS этого поля не отдаёт.
 * `error` — тоже: вместо текста стадии роут отдаёт код причины.
 */
/**
 * Разбор базы в ответе кабинета: проекция отдаёт только два списка, которые
 * экран и рисует, и выбрасывает из них русские пункты исторических разборов
 * (см. toClientEngBaseAnalysis). Четыре распределения и data_quality_notes из
 * staff-типа сюда не приходят.
 */
export interface EngBaseAnalysis {
  notable_segments: string[];
  recommended_angles: string[];
}

export type EngBaseSummary = Omit<
  HeBaseSummaryDto,
  'collect_info' | 'sample_rows' | 'error' | 'analysis'
> & {
  analysis: EngBaseAnalysis | null;
  collect_info?: EngCollectInfo | null;
  /** Live constructor metadata in ENG detail; null means the snapshot could not be read. */
  collection_progress?: EngCollectionProgress | null;
  /**
   * Причина падения сборки. Обязательна на экране с тех пор, как автопилот
   * умеет осознанно НЕ строить базу (проба среза): один статус 'failed'
   * читается как поломка. Ключа нет у ответов, которые саму колонку не читают
   * (дедуп-ветка POST /verticals/[id]/collect).
   */
  error_code?: HeClientStageErrorCode | null;
  /**
   * Прогон ежедневного долива («auto-refill: …»), а не база под запуск: его
   * строки уходят прямо в идущую кампанию. Ключа нет у ответов без
   * `collect_info` и `filename`.
   */
  refill?: boolean;
  /**
   * Только у 'analyzing'-базы в деталке проекта (GET /eng/projects/[id]): идёт
   * ли её анализ — ответ СЕРВЕРА общим предикатом isAnalyzingBaseLive
   * (активная джоба на её base_id или окно постановки
   * ANALYZING_ORPHAN_GRACE_MS), тем же, что у Command Center и «Launch»
   * шага 3. Финальный фейл анализа статус базы не меняет, поэтому статус
   * на этот вопрос не отвечает. Ключа нет — живость не прочитана (сбой
   * чтения, демо, ответ старше): экран читает анализ идущим.
   */
  analysis_live?: boolean;
};

/** Строка списка проектов кабинета (GET /eng/projects). */
export interface EngProjectListItem {
  id: string;
  name: string;
  website_url: string;
  status: string;
  error_code: HeClientStageErrorCode | null;
  created_at: string;
  vertical_count: number;
  base_count: number;
  /** Выбор стран сбора включён (строка идёт той же проекцией, что проект); нет ключа — не сказано. */
  collect_countries_enabled?: boolean;
}

/**
 * Деталка проекта в кабинете (GET /eng/projects/[id]).
 *
 * Staff-тип `HeProjectDetailResponse` описывает выдачу ЛЕГАСИ-инструмента, а
 * кабинет получает её через `toClientEngProjectDetail`, и три расхождения там
 * не косметические: `project`/`bases` несут код причины вместо текста стадии, а
 * `vocabs`/`dossiers`/`cases` (словарь таргетинга, досье вертикалей, разбор
 * датасета агентства) не отдаются вовсе. Обещать их в типе — значит разрешить
 * компилятору чтение поля, которого в JSON нет.
 *
 * `verticals`/`chains`/`templates`/`jobs` пока переиспользуются из staff-типа:
 * проекция их тоже сужает, но ни одно из срезанных полей кабинет не читает.
 */
export type EngProjectDetailResponse = Omit<
  HeProjectDetailResponse,
  'project' | 'bases' | 'vocabs' | 'dossiers' | 'cases'
> & {
  project?: EngProject;
  bases?: EngBaseSummary[];
  /**
   * Идёт ли по проекту хоть одна задача (pending/running) — ответ СЕРВЕРА
   * отдельным запросом, а не вывод из `jobs`: тот список капнут тридцатью
   * самыми свежими строками и на занятом проекте с длинной очередью врёт
   * «простаивает». Ключа нет, когда сервер этот факт не прочитал (сбой
   * вспомогательного запроса) и в демо-выдаче — тогда экран считает по `jobs`,
   * как считал раньше.
   */
  has_active_jobs?: boolean;
  /**
   * Положен ли клиенту повтор research — вердикт СЕРВЕРА, посчитанный тем же
   * чтением и той же функцией (engResearchRetryVerdict, researchJob.ts), что у
   * POST /research: «Try again» шага 1 рисуется ровно там, где роут его примет.
   * `latest_job_status` — статус последней research-джобы проекта (без капа
   * списка `jobs`), null — research-джоб не было. Ключа нет, когда сервер не
   * прочитал джобу, и в демо-выдаче — тогда шаг 1 считает осторожно.
   */
  research_retry?: { verdict: EngResearchRetryVerdict; latest_job_status: string | null };
  /**
   * Автозапуск рынков проекта (S3, readHeEngAutoLaunchDetail): желание
   * клиента «запускай сам» и строка автозапуска по каждому готовому рынку.
   * null — сервер его не прочитал; ключа нет — ответ старше S3. Оба экран
   * читает как «автозапуска нет»: у готового рынка тогда «Launch now».
   */
  auto_launch?: EngAutoLaunchDetail | null;
  /** Типичные сроки по недавним проектам (engEstimates); null — данных мало. */
  estimates?: EngEstimates;
  /**
   * Остановки стадий рынков, которые чинит только команда (EngTeamFixStop,
   * engDashboard.ts): последний прогон писем рынка, проверки контактов или
   * итоговых писем базы упал отказом 'billing' / 'configuration' — только вид,
   * без текста ошибки. Карточка тогда зовёт сначала в Support, потом к кнопке
   * (как письмо об этой остановке). Ключа нет — не прочитано или проект не
   * исследован: карточки как раньше.
   */
  team_fix_stops?: EngTeamFixStop[];
  /**
   * Выключатель отправки аккаунта — тем же чтением, что у GET …/launch, но с
   * каждым опросом деталки (мастер перечитывает её сам): 'revoked' —
   * выключен сотрудником (так и после разблокировки, пока сотрудник не
   * включит отправку), 'not_enabled' — ждёт разовой проверки командой, null —
   * включён или не требуется. Ключа нет — не прочитан (сбой чтения, нет
   * таблицы), проект не 'researched' или ответ старше: экран берёт чтение
   * GET …/launch (engSendingAccessOf).
   */
  account_access?: 'not_enabled' | 'revoked' | null;
  /**
   * Ночной добор по рынку: доработавшие прогоны и сколько адресов прогоны
   * добавили в его кампании. Закончившиеся прогоны в `bases` не приходят (роут
   * деталки, foldFinishedRefillBases); идущий прогон приходит базой. Рынка без
   * доработавшего прогона и без добавленных адресов в списке нет; ключа нет —
   * таких рынков нет вовсе (или ответ старше).
   */
  refill_totals?: EngRefillTotal[];
  /**
   * Выбор стран сбора включён (то же, что `project.collect_countries_enabled`;
   * экран читает оба места — engCollectCountriesEnabled).
   */
  collect_countries_enabled?: boolean;
};
export type { EngTeamFixStop };

/** Включён ли выбор стран сбора: ключ проекта или верхний ключ деталки; нет ни одного — нет. */
export function engCollectCountriesEnabled(detail: {
  project?: { collect_countries_enabled?: boolean } | null;
  collect_countries_enabled?: boolean;
}): boolean {
  return detail.project?.collect_countries_enabled === true || detail.collect_countries_enabled === true;
}

/** Итог ночного добора одного рынка (GET /eng/projects/[id], `refill_totals`). */
export interface EngRefillTotal {
  vertical_id: string;
  /** Доработавших прогонов добора ('appended' / 'no_new'); упавшие не считаются. */
  runs: number;
  /** Адресов, которые прогоны добавили в кампании рынка (и упавшие, успевшие отдать часть). */
  added: number;
}

/**
 * Примерный срок отправки запущенного рынка в днях (`launch_info.run_days`
 * записи о запуске; роут деталки отдаёт его, только пока он посчитан для
 * текущего числа адресов записи). null — срока нет.
 */
export function engLaunchRunDays(template: { launch_info?: unknown }): number | null {
  const info = template.launch_info;
  const days = info && typeof info === 'object' ? (info as { run_days?: unknown }).run_days : undefined;
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 ? days : null;
}

/* ── Запуск проекта одной кнопкой (S3) ── */

/**
 * Автозапуск рынков: состояние и код строки, строка рынка и сводка проекта —
 * РЕЭКСПОРТ типов модуля автозапуска (lib/hypothesisEngine/engAutoLaunch), а
 * не копия: словарь кодов один на роут и на экран, расхождение ловит
 * компилятор. `import type` стирается целиком — серверный модуль в бандл
 * кабинета не едет. Кандидат без строки сервер отдаёт синтезированным
 * `waiting` с `created_at` шаблона.
 */
export type EngAutoLaunchState = HeEngAutoLaunchState;
export type EngAutoLaunchCode = HeEngAutoLaunchCode;
export type { EngAutoLaunchDetail, EngAutoLaunchMarket };

export interface EngEstimates {
  /** Медиана минут исследования по недавним проектам; null — мало данных. */
  research_minutes: number | null;
  /** Медиана часов от писем до готовых итоговых писем; null — мало данных. */
  prepare_hours: number | null;
}

/** Выключатель отправки аккаунта, как его видит запуск проекта. */
export type EngSendingAccessState = 'enabled' | 'not_required' | 'not_enabled' | 'revoked' | 'unknown';

/**
 * Выключатель отправки аккаунта для шагов мастера: свежее чтение деталки
 * (`account_access`, перечитывается опросом мастера), а без её ключа — чтение
 * GET …/launch (`fromLaunch`, один раз при открытии шага и после нажатий).
 * null деталки — включён или не требуется: 'enabled' (экраны различают только
 * 'revoked' и 'not_enabled'). undefined — не прочитан нигде.
 */
export function engSendingAccessOf(
  fromDetail: 'not_enabled' | 'revoked' | null | undefined,
  fromLaunch: EngSendingAccessState | null | undefined,
): EngSendingAccessState | undefined {
  if (fromDetail === 'revoked' || fromDetail === 'not_enabled') return fromDetail;
  if (fromDetail === null) return 'enabled';
  return fromLaunch ?? undefined;
}

/** GET /eng/projects/[id]/launch — что показать до и после «Launch». */
export interface EngProjectLaunchInfo {
  available: boolean;
  requested: boolean;
  requested_at: string | null;
  /** Когда «Cancel all jobs» выключил автозапуск; null — не выключали. */
  cancelled_at: string | null;
  /** Часы отправки, сохранённые с «Launch»; null — «Launch» ещё не нажимали. */
  schedule: EngSendingWindow | null;
  default: EngSendingWindow;
  /** Прежние 8 поясов: из них и только из них — подбор по поясу браузера. */
  timezones: EngSendingWindowTimezoneOption[];
  /**
   * Полный список поясов с группами (план §1C, выключатель HE_ENG_TIMEZONES_ALL).
   * Нет ключа — выпадашка рисует `timezones`.
   */
  timezone_options?: EngSendingWindowTimezoneOption[];
  /**
   * Пояс по странам сбора проекта (suggestEngTimezoneForCountries): все страны
   * в одном часовом классе и США среди них нет. Нет ключа — подсказки нет.
   */
  suggested_timezone?: string;
  weekdays: EngSendingWindowWeekdayOption[];
  sending_access: EngSendingAccessState;
}

/** POST /eng/projects/[id]/launch — 200. */
export interface EngProjectLaunchResponse {
  ok: true;
  /** 'unavailable' — желание не записалось (таблиц нет): готовые рынки ждут «Launch now». */
  auto_launch: 'on' | 'unavailable';
  sending_access: EngSendingAccessState;
  schedule: EngSendingWindow;
  chains_enqueued: number;
  collects_enqueued: number;
  templates_enqueued: number;
  analyses_requeued: number;
  verticals_skipped: number;
  collect_again_verticals: number;
  autopilot_hold_code: HeClientAutopilotHoldCode | null;
  /**
   * Рынки, которым это нажатие не поставило письма: поле брифа шага 1
   * называет наш бренд (реконсилер, причина 'brand_input'), и сами поля. Нет
   * поля — сервер старше этого признака.
   */
  brand_input_markets?: number;
  brand_inputs?: HeBrandInputLeak[];
}

export async function fetchEngProjectLaunch(projectId: string): Promise<EngProjectLaunchInfo> {
  return engApiFetch<EngProjectLaunchInfo>(`/eng/projects/${projectId}/launch`);
}

/**
 * «Launch» шага 3: записывает желание «запускай сам» с часами отправки и
 * ставит работу тем же реконсилером, что прежняя кнопка автопилота (POST
 * .../autopilot). Отказ
 * гейта платных шагов — EngPaidAccessError; прочие отказы (не исследован, нет
 * рынков, отправка выключена) — Error с английским текстом роута.
 */
export async function launchEngProject(
  projectId: string,
  body: { schedule?: EngSendingWindow },
): Promise<EngProjectLaunchResponse> {
  return engPaidApiFetch<EngProjectLaunchResponse>(`/eng/projects/${projectId}/launch`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * POST /eng/projects/[id]/launch {markets} — 200 «Launch N more markets»: та же
 * форма, что у «Launch», плюс id рынков, начатых этим нажатием, и рынков,
 * которые к нажатию уже были начаты (их роут пропустил).
 */
export interface EngProjectLaunchMoreResponse extends EngProjectLaunchResponse {
  markets_started: string[];
  markets_already_started: string[];
}

/**
 * «Launch N more markets» шага 3: начинает только перечисленные рынки,
 * отмеченные после «Launch» и ещё не тронутые; намерение «запускай сам» и
 * строки других рынков не трогает. Отказ гейта платных шагов —
 * EngPaidAccessError; 409 markets_changed / not_launched и прочие — Error с
 * английским текстом роута.
 */
export async function launchEngProjectMarkets(
  projectId: string,
  markets: string[],
): Promise<EngProjectLaunchMoreResponse> {
  return engPaidApiFetch<EngProjectLaunchMoreResponse>(`/eng/projects/${projectId}/launch`, {
    method: 'POST',
    body: JSON.stringify({ markets }),
  });
}

/** Часы отправки для рынков, которые запустятся дальше (после «Launch»). */
export async function updateEngProjectLaunchSchedule(
  projectId: string,
  schedule: EngSendingWindow,
): Promise<{ ok?: boolean; schedule?: EngSendingWindow; error?: string }> {
  return engApiFetch<{ ok?: boolean; schedule?: EngSendingWindow; error?: string }>(
    `/eng/projects/${projectId}/launch`,
    { method: 'PATCH', body: JSON.stringify({ schedule }) },
  );
}

/**
 * «Continue» шага 2: выбранные рынки проекта (вертикали). Отказ — Error с
 * английским текстом роута (в том числе «нельзя снять рынок в работе»).
 */
export async function saveEngMarkets(
  projectId: string,
  verticalIds: string[],
): Promise<{ ok?: boolean; selected?: string[]; error?: string }> {
  return engApiFetch<{ ok?: boolean; selected?: string[]; error?: string }>(`/eng/projects/${projectId}/markets`, {
    method: 'PUT',
    body: JSON.stringify({ vertical_ids: verticalIds }),
  });
}

/**
 * «Rewrite letters»: новые итоговые письма вместо тех, что не прошли
 * автоматическую проверку. Платный шаг: отказ гейта — EngPaidAccessError,
 * прочие отказы — Error с английским текстом роута.
 */
export async function rewriteEngTemplateLetters(templateId: string): Promise<EngJobResponse> {
  return engPaidApiFetch<EngJobResponse>(`/eng/templates/${templateId}/rewrite`, { method: 'POST', body: '{}' });
}

/** GET того же роута — попытки писем аудитории шаблона (тот же бюджет, что решает «Rewrite letters»). */
export interface EngRewriteTries {
  tries_used: number;
  tries_max: number;
  tries_left: number;
}

export async function fetchEngTemplateRewriteTries(templateId: string): Promise<EngRewriteTries> {
  return engApiFetch<EngRewriteTries>(`/eng/templates/${templateId}/rewrite`);
}

interface EngProjectsResponse {
  projects?: EngProjectListItem[];
  /** Выбор стран сбора включён — если роут списка отдаёт его верхним ключом. */
  collect_countries_enabled?: boolean;
  error?: string;
}

interface EngProjectCreateResponse {
  project?: EngProject;
  job?: HeJobSummary;
  error?: string;
}

interface EngPatchResponse {
  project?: EngProject;
  error?: string;
}

/** Ответ постановки джобы: тот же конверт, что у staff, но с суженной джобой. */
export interface EngJobResponse {
  ok?: boolean;
  job?: HeJobSummary;
  error?: string;
}

/** Разметка гипотезы: пересчитанные вертикали — только id + новые pct/rank. */
export interface EngHypothesisResponse {
  hypothesis?: EngHypothesis;
  verticals?: Array<{ id: string; potential_pct: number; rank: number }> | null;
  error?: string;
}

/**
 * POST /verticals/[id]/collect → 201 { ok, base } либо 200 { ok, existing,
 * base } на дедупе. `collect_info` идёт через ту же проекцию, что и деталка.
 */
export interface EngBaseCollectResponse {
  ok?: boolean;
  existing?: boolean;
  base?: { id: string; status: string; collect_info?: EngCollectInfo | null };
  error?: string;
}

interface EngCancelResponse {
  ok?: boolean;
  cancelled?: number;
  error?: string;
}

/* ── Окно отправки (sending window) ── */

/**
 * Окно отправки кампании: пояс, часы и дни недели. Клиент выбирает его при
 * запуске и может поменять после (роуты `/eng/templates/[id]/launch` и
 * `/eng/templates/[id]/schedule`).
 *
 * `days` — нумерация рассыльщика (0=Sunday … 6=Saturday), как её отдаёт и
 * принимает API; порядок показа задаёт список `weekdays` ответа.
 */
export interface EngSendingWindow {
  timezone: string;
  /** 'HH:MM', 24 часа. */
  from: string;
  /** 'HH:MM', 24 часа. */
  to: string;
  days: number[];
}

/** Пункт выпадашки поясов: подпись человеческая, value — то, что шлём обратно. */
export interface EngSendingWindowTimezoneOption {
  value: string;
  label: string;
  /** Группа выпадашки (`<optgroup>`) у полного списка; у прежних 8 её нет. */
  group?: string;
}

export interface EngSendingWindowWeekdayOption {
  value: number;
  label: string;
}

/**
 * GET /eng/templates/[id]/schedule. Списки приходят С СЕРВЕРА, а не лежат в
 * бандле: принимаемый рассыльщиком набор поясов — серверный контракт, и вторая
 * его копия на фронте разъехалась бы с первой (клиент выбрал бы пояс, на который
 * запуск отвечает отказом). Пустой ответ (демо-фикстура) — поле отсутствует.
 */
export interface EngSendingWindowResponse {
  /**
   * Окно, которое печатать текущим: у запущенного шаблона — сохранённый выбор
   * клиента, если он новее записи о запуске, иначе окно, прочитанное у
   * кампаний запуска; до запуска — сохранённый выбор. null — выбора нет.
   */
  schedule?: EngSendingWindow | null;
  /**
   * true — кампании запуска сейчас НЕ все на окне `schedule`: у части другое
   * окно или его не удалось прочитать (частичная перестановка окна). Нет поля —
   * `schedule` стоит у всех кампаний запуска (или запуска нет).
   */
  mixed?: boolean;
  default?: EngSendingWindow;
  timezones?: EngSendingWindowTimezoneOption[];
  /** Полный список поясов с группами (план §1C); нет ключа — рисуем `timezones`. */
  timezone_options?: EngSendingWindowTimezoneOption[];
  weekdays?: EngSendingWindowWeekdayOption[];
  launched?: boolean;
  error?: string;
}

export interface EngSendingWindowUpdateResponse {
  ok?: boolean;
  schedule?: EngSendingWindow;
  /** Сколько кампаний запуска приняли новое окно (id кампаний кабинету не отдаются). */
  campaigns_updated?: number;
  campaigns_total?: number;
  warnings?: string[];
  error?: string;
}

export interface EngLaunchResponse {
  ok?: boolean;
  launch?: EngTemplateLaunchInfo;
  /**
   * Окно отправки, которое стоит у ВСЕХ кампаний запуска. Нет поля — окно
   * встало не у всех (их называет предупреждение) или ни у одной.
   */
  schedule?: EngSendingWindow;
  warnings?: string[];
  error?: string;
  /**
   * Отказ запуска с машинным кодом (ядро: 409 / 503 с `code`, launchTemplate.ts;
   * роут: выключатель отправки аккаунта и ящики пула — 403 / 404 / 409 / 503):
   * запуск не состоялся, кампания не создана, `error` — английский текст. Только
   * у этих кодов launchEngTemplate отвечает значением, а не бросает: «Launch
   * all» обходится с ними по-разному (EngStepReview, LaunchAllPanel).
   */
  refusal?: EngLaunchRefusalCode;
  /** Старт созданных кампаний этим запуском (только у ответа 200). */
  sending?: EngLaunchSendingResult;
  /**
   * Свежая сводка отправки этого запуска (как `sending` ответа POST
   * .../sending): по ней фраза итога называет кнопку, которая на карточке.
   * Нет / null — сводки нет (кэш не читается).
   */
  sending_summary?: HeEngSendingSummary | null;
}

/**
 * Старт кампаний после ядра запуска (роут запуска, блок «Отправка»):
 *  - 'done'          — старт сделан по кампаниям записи: сколько начали,
 *                      сколько уже отправляли, какие не стартовали (коды) и
 *                      сколько не успели начать (`not_attempted`);
 *  - 'skipped'       — старт не делался: предупреждение запуска говорит, что
 *                      кампании не стартованы (`launch_problem`), окно
 *                      отправки не доехало до всех (`window_not_applied`) или
 *                      запрос пришёл без `start_sending: true`
 *                      (`not_requested` — страница старше S2; этот экран его
 *                      шлёт всегда);
 *  - 'refused'       — проверка старта отказала (`refusal.message` — фраза);
 *  - 'client_paused' — клиент поставил этот запуск на паузу, запуск её не снял;
 *                      или (`paused_found` > 0) кампании записи стоят на паузе
 *                      у рассыльщика, и запуск не стартовал ничего.
 * `unconfirmed` — старт неясен (кампания могла начать отправку): не входит ни
 * в `started`, ни в `failed`.
 */
export interface EngLaunchSendingResult {
  outcome: 'done' | 'skipped' | 'refused' | 'client_paused';
  skip_reason?: 'launch_problem' | 'window_not_applied' | 'not_requested';
  refusal?: { code: string; message: string };
  campaigns: number;
  started: number;
  already_sending: number;
  completed: number;
  failed: HeEngStartErrorCode[];
  not_attempted: number;
  unconfirmed: number;
  paused_found: number;
  compensated: number;
  /**
   * Клиент нажал Pause во время старта, а пауза части кампаний, которые этот
   * старт начинал, не подтвердилась — они могут отправлять (команде — алерт).
   */
  compensation_failed: number;
}

/**
 * Машинные коды отказов, которые экран различает, — копия части
 * HE_LAUNCH_REFUSAL_CODES и HE_LAUNCH_PREFLIGHT_REFUSAL_CODES (launchTemplate.ts):
 * сам модуль ядра в клиентский бандл не едет.
 *  - sibling_template_launched — у другого шаблона той же базы уже есть запуск;
 *  - research_running — у проекта идёт повторное исследование;
 *  - preset_no_mailboxes — в пресете нет ни одного ящика отправки (пресет
 *    один на проект, следующий шаблон получил бы то же);
 *  - segment_classification_incomplete — 503: классификатор сегментов не
 *    ответил по слишком большой доле адресов. Он общий у всех шаблонов, и
 *    следующий шаблон с сегментами снова оплатил бы классификацию всей своей
 *    аудитории ради того же отказа. Отказ лимита неудачных запусков шаблона
 *    (тоже 503) приходит БЕЗ кода — это EngLaunchServerError.
 * template_unresolved_operators экрану различать незачем: это ошибка одного
 * шаблона (бросается), а шаблоны, которые она ждёт, шаг 3 и не запускает
 * (`needs_rewrite`, engTemplateNeedsRewrite).
 */
export type EngLaunchRefusalCode =
  | 'sibling_template_launched'
  | 'research_running'
  | 'preset_no_mailboxes'
  | 'segment_classification_incomplete'
  | EngLaunchSendingRefusalCode;

/**
 * Отказы роута запуска ДО ядра, одинаковые для каждого шаблона пачки «Launch
 * all» (про аккаунт и его ящики, а не про шаблон): выключатель отправки
 * аккаунта (engSendingAccess) и ящики пула проекта (engSendingPreset).
 */
export type EngLaunchSendingRefusalCode =
  | 'sending_not_enabled'
  | 'sending_turned_off'
  | 'sending_access_unavailable'
  | 'sending_mailboxes_shortage'
  | 'sending_setup_unavailable'
  | 'sending_setup_failed'
  | 'sending_not_available';

const ENG_LAUNCH_SENDING_REFUSAL_CODES: readonly string[] = [
  'sending_not_enabled',
  'sending_turned_off',
  'sending_access_unavailable',
  'sending_mailboxes_shortage',
  'sending_setup_unavailable',
  'sending_setup_failed',
  'sending_not_available',
] satisfies readonly EngLaunchSendingRefusalCode[];

export function isEngLaunchSendingRefusalCode(raw: unknown): raw is EngLaunchSendingRefusalCode {
  return typeof raw === 'string' && ENG_LAUNCH_SENDING_REFUSAL_CODES.includes(raw);
}

function isEngLaunchRefusalCode(raw: unknown): raw is EngLaunchRefusalCode {
  return (
    raw === 'sibling_template_launched' ||
    raw === 'research_running' ||
    raw === 'preset_no_mailboxes' ||
    raw === 'segment_classification_incomplete' ||
    isEngLaunchSendingRefusalCode(raw)
  );
}

/**
 * Признак проекции `needs_rewrite` (clientEngProjection, heTemplateNeedsRewrite):
 * письма ready-шаблона ядро запуска откажет гейтом писем. Нет поля (демо,
 * старый ответ) — false: тогда о письмах скажет сам отказ запуска.
 */
export function engTemplateNeedsRewrite(template: unknown): boolean {
  return (template as { needs_rewrite?: unknown } | null)?.needs_rewrite === true;
}

export type EngTemplatePlaceholder = ClientEngTemplatePlaceholder;

/**
 * Подстановки отправляемых писем шаблона и чем каждая наполнится у получателя
 * (clientEngProjection, toClientEngTemplatePlaceholders). null — сервер их не
 * посчитал (базы шаблона нет в деталке) или поля нет вовсе (ответ старше):
 * тогда «Preview letters» о подстановках ничего не утверждает.
 */
export function engTemplatePlaceholders(template: unknown): EngTemplatePlaceholder[] | null {
  const raw = (template as { placeholders?: unknown } | null)?.placeholders;
  return Array.isArray(raw) ? (raw as EngTemplatePlaceholder[]) : null;
}

interface EngChainPatchResponse {
  letters?: HeChainLetterDto[];
  error?: string;
}

/**
 * Дверь кабинета в /api/client: поверх общего фетча доводим текст до
 * английского (см. engText) — и у брошенной ошибки, и у поля `error` в теле
 * ответа, которое роуты отдают вместе с 200-м статусом (частичный запуск).
 * Исключения — вызовы, которым нужен машинный код отказа из тела не-2xx,
 * который этот фетч выбрасывает: startEngResearch и launchEngTemplate (свои
 * 409) и все вызовы, которые может остановить гейт платных шагов
 * (engPaidApiFetch: создание проекта, «Launch», «Collect again»,
 * «Resume daily top-up»). Они ходят через engApiFetchRaw и доводят тексты теми
 * же функциями engText.
 *
 * Здесь именно `engErrorText`, а не `engStageErrorText`: это ЖИВОЙ ответ, где
 * `error` — английская константа роута (`api/client/eng/_shared.ts`). Ошибки
 * стадий из `he_*.error` приезжают полем данных и локализуются в компонентах.
 */
async function engApiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let data: T;
  try {
    data = await clientApiFetch<T>(path, init);
  } catch (e) {
    throw localizeEngError(e);
  }
  const body = data as { error?: unknown } | null;
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    body.error = engErrorText(body.error);
  }
  return data;
}

/**
 * Список проектов и выключатель выбора стран (для формы создания): верхний
 * ключ ответа или ключ любой строки. null — сервер не сказал (строк нет, ключа
 * нет): форма рисует выбор стран свёрнутым и переживает 400
 * `countries_unavailable` (EngCountriesUnavailableError).
 */
export async function fetchEngProjectsPage(): Promise<{
  projects: EngProjectListItem[];
  collectCountriesEnabled: boolean | null;
}> {
  const data = await engApiFetch<EngProjectsResponse>('/eng/projects');
  const projects = data.projects ?? [];
  const flag =
    typeof data.collect_countries_enabled === 'boolean'
      ? data.collect_countries_enabled
      : projects.find((p) => typeof p.collect_countries_enabled === 'boolean')?.collect_countries_enabled;
  return { projects, collectCountriesEnabled: typeof flag === 'boolean' ? flag : null };
}

/**
 * Создание проекта. `business_override` и `icp` — ответы, которые читает само
 * исследование (описание бизнеса и рамка ЦА — те же ключи brief, что правит
 * шаг «Brief»); шлётся только заполненное. Отказ «один аккаунт — один сайт»
 * приходит отказом гейта (EngPaidAccessError, код project_limit).
 *
 * `collect_countries` — страны сбора (план §1A), шлётся только непустым.
 * Пока выбор стран выключен, роут отвечает 400 `countries_unavailable` —
 * тогда бросаем EngCountriesUnavailableError: проект НЕ создан, экран
 * повторяет создание без стран.
 */
export async function createEngProject(input: {
  website_url: string;
  name?: string;
  business_override?: string;
  icp?: Partial<HeIcpFrame>;
  collect_countries?: string[] | null;
}): Promise<EngProjectCreateResponse> {
  const { res, body } = await engApiFetchRaw('/eng/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const paid = engPaidAccessErrorFrom(res, body);
    if (paid) throw paid;
    if (isEngCountriesUnavailable(res, body)) throw new EngCountriesUnavailableError();
    throw new Error(engRawErrorText(res, body));
  }
  const out = (body ?? {}) as EngProjectCreateResponse;
  if (typeof out.error === 'string') out.error = engErrorText(out.error);
  return out;
}

/** Текст отказа, когда выбор стран выключен (400 `countries_unavailable`). */
export const ENG_COUNTRIES_UNAVAILABLE_TEXT = 'Choosing countries is not available yet.';

/** Создание проекта отказано: выбор стран сбора сейчас выключен (план §1A, флаг записи). */
export class EngCountriesUnavailableError extends Error {
  constructor() {
    super(ENG_COUNTRIES_UNAVAILABLE_TEXT);
    this.name = 'EngCountriesUnavailableError';
  }
}

/**
 * 400 «выбор стран выключен»: код приходит полем `code` или самим `error`
 * (роут отдаёт машинный код, текст строит экран).
 */
function isEngCountriesUnavailable(res: Response, body: Record<string, unknown> | null): boolean {
  return res.status === 400 && (body?.code === 'countries_unavailable' || body?.error === 'countries_unavailable');
}

/** Текст ошибки PATCH стран для экрана: машинный код отказа — своей фразой. */
export function engCountriesErrorText(message: string): string {
  return /countries_unavailable/.test(message) ? ENG_COUNTRIES_UNAVAILABLE_TEXT : message;
}

export async function fetchEngProjectDetail(projectId: string): Promise<EngProjectDetailResponse> {
  return engApiFetch<EngProjectDetailResponse>(`/eng/projects/${projectId}`);
}

/**
 * Тело PATCH брифа. Каждое поле — «заменить»; пустая строка удаляет override.
 * Шлётся только то, что клиент изменил (EngStepBrief): присланное поле роут
 * перезаписывает, в том числе пустым.
 *
 * `icp` — частичная правка рамки ЦА (`brief.icp`, lib/hypothesisEngine/icpFrame):
 * присланные подполя заменяются, остальные сохраняются; null — снять рамку
 * целиком. В ответе brief.icp приходит рамкой нужной формы или null.
 */
export interface EngBriefPatch {
  offer_override?: string;
  style_override?: string;
  signature_override?: string;
  business_override?: string;
  icp?: Partial<HeIcpFrame> | null;
  /**
   * Страны сбора (план §1A): список значений каталога целиком; null или [] —
   * снять ограничение. Карточка «Countries» шлёт только это поле.
   */
  collect_countries?: string[] | null;
}

export async function patchEngProject(
  projectId: string,
  body: EngBriefPatch,
): Promise<EngPatchResponse> {
  return engApiFetch<EngPatchResponse>(`/eng/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Что удалит повтор research («Try again» шага 1) — числа из 409 роута
 * (api/client/eng/projects/[id]/research). Тексты из них собирает экран.
 * Здесь ровно то, что экран печатает: запущенные шаблоны и идущая работа в
 * 'confirm'-ответ не попадают (при них роут отказывает другим кодом), и разбирать
 * их незачем.
 */
export interface EngResearchRerunConsequences {
  audiences: number;
  /** Строки баз (адреса), а не компании. */
  rows: number;
  templates: number;
  letter_sequences: number;
  /** Вокабуляры вертикалей (he_vocab). */
  vocabularies: number;
  /** Досье вертикалей (he_vertical_dossiers). */
  dossiers: number;
}

/**
 * Итог «Try again» шага 1: поставлено — или сервер просит подтверждения
 * (409 research_rerun_confirm_required) и перечисляет, что будет удалено.
 * Остальные отказы (уже идёт, запущено, идёт работа по вертикалям) — брошенная
 * ошибка с английским текстом роута, как у прочих вызовов кабинета.
 */
export type EngResearchStartResult =
  | { kind: 'started' }
  | { kind: 'confirm_required'; consequences: EngResearchRerunConsequences };

function rerunCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * Вызов кабинета, которому нужно ТЕЛО не-2xx ответа — машинный код отказа рядом
 * с текстом. Мимо engApiFetch намеренно: его фетч (authFetchJson) на не-2xx
 * бросает только текст. authFetch тот же, что под ним: токен, повтор на 401 и
 * заголовок демо-вкладки ставит он сам; 401 после повтора — та же
 * AuthExpiredError, тексты доводятся до английского тем же
 * localizeEngError/engErrorText (engRawErrorText ниже). Зовут его
 * startEngResearch, launchEngTemplate, engPaidApiFetch и вызовы подтверждения
 * почты.
 */
async function engApiFetchRaw(
  path: string,
  init: RequestInit,
): Promise<{ res: Response; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await authFetch(`/api/client${path}`, init);
  } catch (e) {
    throw localizeEngError(e);
  }
  if (res.status === 401) throw localizeEngError(new AuthExpiredError());
  const parsed: unknown = await res.json().catch(() => null);
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  return { res, body };
}

/** Английский текст ошибки из тела engApiFetchRaw. */
function engRawErrorText(res: Response, body: Record<string, unknown> | null): string {
  return engErrorText(typeof body?.error === 'string' ? body.error : `Error ${res.status}`);
}

/* ── Отказ гейта платных шагов (requireEngPaidAccess) ── */

export type { EngPaidAccessCode };

/**
 * Коды отказа гейта (engPaidAccess.ts). Копия словаря значениями: модуль гейта
 * серверный, в бандл кабинета едет только его тип, а сверку значений с типом
 * делает `satisfies`. 'account_blocked' — аккаунт заблокирован или не активен
 * (сессия пережила блокировку): экран показывает текст роута «Your account is
 * not active.» без кнопки действия.
 */
const ENG_PAID_ACCESS_CODES = [
  'account_blocked',
  'email_not_verified',
  'project_limit',
  'research_limit',
  'spend_limit',
  'spend_day_limit',
  'unavailable',
] as const satisfies readonly EngPaidAccessCode[];

/**
 * Платный шаг не начат: гейт отказал (почта не подтверждена, лимит проектов
 * или стартов исследования, потолок расхода, гейт не прочитал свои данные).
 * `message` — английский текст роута с действием; `code` — по нему экран
 * рисует кнопку действия (EngPaidAccessNotice: «Send confirmation link» у
 * неподтверждённой почты).
 */
export class EngPaidAccessError extends Error {
  readonly code: EngPaidAccessCode;
  /** Секунд до повтора (research_limit — до 00:00 UTC); null — не задано. */
  readonly retryAfterSeconds: number | null;
  /**
   * email_not_verified: в профиле нет адреса (`email_missing` гейта) — ссылку
   * послать некуда, кнопки отправки нет.
   */
  readonly emailMissing: boolean;

  constructor(
    message: string,
    code: EngPaidAccessCode,
    retryAfterSeconds: number | null,
    flags: { emailMissing?: boolean } = {},
  ) {
    super(message);
    this.name = 'EngPaidAccessError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.emailMissing = flags.emailMissing ?? false;
  }
}

/**
 * Отказ гейта из тела не-2xx ответа; null — это не он. Код 'unavailable'
 * засчитывается только с 503: этим же словом роуты подтверждения почты
 * называют свой отказ, а гейт отвечает им только 503.
 */
function engPaidAccessErrorFrom(res: Response, body: Record<string, unknown> | null): EngPaidAccessError | null {
  const code = body?.code;
  if (typeof code !== 'string' || !(ENG_PAID_ACCESS_CODES as readonly string[]).includes(code)) return null;
  if (code === 'unavailable' && res.status !== 503) return null;
  const retry = body?.retry_after_seconds;
  return new EngPaidAccessError(
    engRawErrorText(res, body),
    code as EngPaidAccessCode,
    typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? retry : null,
    { emailMissing: body?.email_missing === true },
  );
}

/**
 * Вызов кабинета, который может упереться в гейт платных шагов: как
 * engApiFetch, но отказ гейта бросается EngPaidAccessError с кодом (общий
 * фетч код выбросил бы). Остальные отказы — Error с английским текстом роута.
 */
async function engPaidApiFetch<T>(path: string, init: RequestInit): Promise<T> {
  const { res, body } = await engApiFetchRaw(path, init);
  if (!res.ok) {
    throw engPaidAccessErrorFrom(res, body) ?? new Error(engRawErrorText(res, body));
  }
  const out = (body ?? {}) as T & { error?: unknown };
  if (typeof out.error === 'string') out.error = engErrorText(out.error);
  return out;
}

/* ── Подтверждение почты (/api/client/eng-email/status и /resend) ── */

/** Ответ GET /eng-email/status (роут verify-guard: 'unavailable' — сказать нельзя). */
export interface EngEmailStatus {
  state: 'verified' | 'pending' | 'not_required' | 'unavailable';
  email: string | null;
  /** Когда ушла ссылка, которая ещё действует (срок считает сервер). */
  last_sent_at: string | null;
  /** Когда ушла ссылка, срок которой вышел; задано не больше одного из двух. */
  expired_link_sent_at: string | null;
}

/** Статус подтверждения почты; null — не прочитан (сбой сети, не-2xx, чужая форма). */
export async function fetchEngEmailStatus(): Promise<EngEmailStatus | null> {
  try {
    const { res, body } = await engApiFetchRaw('/eng-email/status', { method: 'GET' });
    const state = body?.state;
    if (!res.ok || (state !== 'verified' && state !== 'pending' && state !== 'not_required' && state !== 'unavailable')) {
      return null;
    }
    return {
      state,
      email: typeof body?.email === 'string' ? body.email : null,
      last_sent_at: typeof body?.last_sent_at === 'string' ? body.last_sent_at : null,
      expired_link_sent_at: typeof body?.expired_link_sent_at === 'string' ? body.expired_link_sent_at : null,
    };
  } catch {
    return null;
  }
}

/**
 * Итог «Send confirmation link»: ушла (на какой адрес), отправлять не нужно
 * (почта уже подтверждена или этому аккаунту не требуется) — либо отказ с
 * английским текстом роута (слишком рано, отправка не удалась, недоступно).
 */
export type EngEmailResendResult =
  | { kind: 'sent'; email: string | null }
  | { kind: 'not_needed' }
  | { kind: 'failed'; text: string };

const RESEND_FAILED_EN = 'We could not send the email. Try again in a few minutes.';

export async function resendEngEmailLink(): Promise<EngEmailResendResult> {
  try {
    const { res, body } = await engApiFetchRaw('/eng-email/resend', { method: 'POST', body: '{}' });
    if (res.ok && body?.status === 'sent') {
      return { kind: 'sent', email: typeof body.email === 'string' ? body.email : null };
    }
    if (res.ok && (body?.status === 'already_verified' || body?.status === 'not_required')) {
      return { kind: 'not_needed' };
    }
    return { kind: 'failed', text: typeof body?.error === 'string' ? engErrorText(body.error) : RESEND_FAILED_EN };
  } catch (e) {
    return { kind: 'failed', text: e instanceof Error ? e.message : RESEND_FAILED_EN };
  }
}

/**
 * POST /eng/projects/[id]/research (через engApiFetchRaw: экрану нужно тело 409
 * — код и список последствий для диалога).
 *
 * confirm: true — повтор после диалога подтверждения. Флаг принимается только
 * для 'confirm'-последствий: запуск или идущую работу он не снимает.
 */
export async function startEngResearch(
  projectId: string,
  opts?: { confirm?: boolean },
): Promise<EngResearchStartResult> {
  const { res, body } = await engApiFetchRaw(`/eng/projects/${projectId}/research`, {
    method: 'POST',
    body: JSON.stringify(opts?.confirm === true ? { confirm: true } : {}),
  });
  if (res.ok) return { kind: 'started' };
  if (res.status === 409 && body?.code === 'research_rerun_confirm_required' && body.requires_confirm === true) {
    const raw = body.consequences;
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return {
      kind: 'confirm_required',
      consequences: {
        audiences: rerunCount(c.audiences),
        rows: rerunCount(c.rows),
        templates: rerunCount(c.templates),
        letter_sequences: rerunCount(c.letter_sequences),
        vocabularies: rerunCount(c.vocabularies),
        dossiers: rerunCount(c.dossiers),
      },
    };
  }
  throw engPaidAccessErrorFrom(res, body) ?? new Error(engRawErrorText(res, body));
}

export async function cancelEngProject(projectId: string): Promise<EngCancelResponse> {
  return engApiFetch<EngCancelResponse>(`/eng/projects/${projectId}/cancel`, { method: 'POST' });
}

/* ── Превью строк базы (GET /eng/bases/[id]/rows) ── */

/**
 * Счёт запуска по строкам базы (GET /eng/bases/[id]/rows?ready=1): сколько
 * адресов запуск отправил бы сейчас из проверенных и почему остальные не уйдут.
 * Числа складываются: checked = to_send + flagged + failed + unusable +
 * repeated + blocked + over_limit.
 */
export interface EngReadyToSend {
  to_send: number;
  checked: number;
  flagged: number;
  failed: number;
  unusable: number;
  repeated: number;
  blocked: number;
  over_limit: number;
  /** Потолок адресов одного запуска. */
  limit: number;
}

export interface EngBaseRowsResponse {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  total?: number;
  status?: string;
  row_count?: number;
  /** Только с `ready: true`; null — честно посчитать нельзя (см. роут). */
  ready?: EngReadyToSend | null;
  error?: string;
}

export async function fetchEngBaseRows(
  baseId: string,
  opts: { offset?: number; limit?: number; ready?: boolean } = {},
): Promise<EngBaseRowsResponse> {
  const qs = new URLSearchParams();
  if (opts.offset) qs.set('offset', String(opts.offset));
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.ready) qs.set('ready', '1');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return engApiFetch<EngBaseRowsResponse>(`/eng/bases/${baseId}/rows${suffix}`);
}

export async function patchEngHypothesis(
  hypothesisId: string,
  verdict: 'accept' | 'reject',
): Promise<EngHypothesisResponse> {
  return engApiFetch<EngHypothesisResponse>(`/eng/hypotheses/${hypothesisId}`, {
    method: 'PATCH',
    body: JSON.stringify({ verdict }),
  });
}

export async function generateEngChain(verticalId: string, language?: string): Promise<EngJobResponse> {
  return engApiFetch<EngJobResponse>(`/eng/verticals/${verticalId}/chain`, {
    method: 'POST',
    body: JSON.stringify(language ? { language } : {}),
  });
}

/**
 * «Collect again» шага 3 — новая сборка вертикали (до 2 000 компаний, по
 * гипотезам рынка, выбранного на шаге 2: лимит и гипотезы решает сервер, тело пустое).
 */
export async function collectEngBase(verticalId: string): Promise<EngBaseCollectResponse> {
  return engPaidApiFetch<EngBaseCollectResponse>(`/eng/verticals/${verticalId}/collect`, {
    method: 'POST',
    body: '{}',
  });
}

/* ── Возврат вертикали в ночной добор (POST /eng/verticals/[id]/refill) ── */

/**
 * Отменяет решение правила сухой вертикали: ночной проход снял её с добора
 * после N подряд ночей без единого добавленного контакта. Ответ пустой (только
 * `ok`) намеренно: состояние экран перечитывает деталкой проекта, а второго
 * источника у пометки быть не должно.
 */
export async function resumeEngVerticalRefill(verticalId: string): Promise<{ ok?: boolean; error?: string }> {
  return engPaidApiFetch<{ ok?: boolean; error?: string }>(`/eng/verticals/${verticalId}/refill`, {
    method: 'POST',
  });
}

/* ── Переключатель «Daily top-up» проекта (POST /eng/projects/[id]/refill) ── */

/**
 * Исход переключателя — копия словаря switchHeUsRefill (autoPipeline.ts)
 * значениями, которые роут отдаёт с 200: отказы ('no_launch', 'not_us',
 * 'unsupported', 'failed') приходят не-2xx и бросаются ошибкой с текстом роута.
 */
export type EngTopUpSwitchOutcome =
  | 'created'
  | 'turned_on'
  | 'resumed'
  | 'already_on'
  | 'turned_off'
  | 'already_off';

export interface EngTopUpSwitchResponse {
  ok: true;
  outcome: EngTopUpSwitchOutcome;
  /** Состояние ночного добора проекта после переключения (та же проекция, что `projects[].refill`). */
  refill: HeClientRefillState;
}

/**
 * Включить («on») или выключить («off») ежедневный добор проекта. «on» может
 * остановить гейт платных шагов — EngPaidAccessError; прочие отказы — Error с
 * английским текстом роута.
 */
export async function setEngProjectTopUp(projectId: string, enabled: boolean): Promise<EngTopUpSwitchResponse> {
  return engPaidApiFetch<EngTopUpSwitchResponse>(`/eng/projects/${projectId}/refill`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export async function patchEngChain(
  chainId: string,
  letters: HeChainLetterDto[],
): Promise<EngChainPatchResponse> {
  return engApiFetch<EngChainPatchResponse>(`/eng/chains/${chainId}`, {
    method: 'PATCH',
    body: JSON.stringify({ letters }),
  });
}

export async function buildEngTemplate(baseId: string): Promise<EngJobResponse> {
  return engApiFetch<EngJobResponse>(`/eng/bases/${baseId}/template`, { method: 'POST' });
}

/**
 * Запуск шаблона не прошёл на нашей стороне: 5xx роута запуска без кода
 * отказа (сбой ядра или рассыльщика, лимит неудачных запусков шаблона за
 * час). «Launch now» показывает его текстом (EngStepLaunch): сбой после
 * классификатора сегментов следующий шаблон оплатил бы заново, не узнав
 * ничего нового. `message` — английский текст роута.
 */
export class EngLaunchServerError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EngLaunchServerError';
    this.status = status;
  }
}

/**
 * POST /eng/templates/[id]/launch. Через engApiFetchRaw — ради кода отказа
 * (409 защиты аудитории и пресета, 503 классификатора; `refusal`, см.
 * EngLaunchResponse): его тело engApiFetch выбросил бы вместе с исключением.
 * Остальное — как у engApiFetch: успех отдаёт тело с английским `error`;
 * отказ гейта платных шагов бросается EngPaidAccessError, прочий 5xx —
 * EngLaunchServerError, любой другой отказ — Error с английским текстом.
 *
 * `start_sending: true` — подтверждение, что этот экран знает: запуск стартует
 * кампании (кнопка «Launch now», а не прежний запуск «на паузе»). Без него
 * роут запуска НЕ отказывает: он создаёт кампании на паузе, как до S2, и не
 * стартует их (ответ 200, `sending.outcome 'skipped'`, `skip_reason
 * 'not_requested'`): страница, загруженная до S2, обещала клиенту кампании на
 * паузе, и её нажатие отправку не начинает.
 */
export async function launchEngTemplate(
  templateId: string,
  body: { schedule?: EngSendingWindow },
): Promise<EngLaunchResponse> {
  const { res, body: data } = await engApiFetchRaw(`/eng/templates/${templateId}/launch`, {
    method: 'POST',
    body: JSON.stringify({ ...body, start_sending: true }),
  });
  if (res.ok) {
    const out = (data ?? {}) as EngLaunchResponse;
    if (typeof out.error === 'string') out.error = engErrorText(out.error);
    return out;
  }
  if (
    (res.status === 409 || res.status === 503 || (isEngLaunchSendingRefusalCode(data?.code) && res.status < 500)) &&
    isEngLaunchRefusalCode(data?.code)
  ) {
    return { ok: false, error: engRawErrorText(res, data), refusal: data.code };
  }
  const paidAccess = engPaidAccessErrorFrom(res, data);
  if (paidAccess) throw paidAccess;
  if (res.status >= 500) throw new EngLaunchServerError(engRawErrorText(res, data), res.status);
  throw new Error(engRawErrorText(res, data));
}

/* ── Отправка кампаний запуска (GET/POST /eng/templates/[id]/sending) ── */

/**
 * Сводка отправки запуска шаблона; null — шаблон не запущен или ответ без
 * сводки (демо). Бросает на сбое (engApiFetch).
 */
export async function fetchEngTemplateSending(templateId: string): Promise<HeEngSendingSummary | null> {
  const data = await engApiFetch<{ sending?: HeEngSendingSummary | null }>(`/eng/templates/${templateId}/sending`);
  return data.sending ?? null;
}

/** Ответ POST .../sending: что сделано и свежая сводка. */
export interface EngSendingActionResponse {
  action: 'start' | 'pause';
  result:
    | {
        campaigns: number;
        started: number;
        already_sending: number;
        completed: number;
        failed: HeEngStartErrorCode[];
        not_attempted: number;
        unconfirmed: number;
        compensated: number;
        compensation_failed: number;
      }
    | { campaigns: number; paused: number; failed: number; not_attempted: number; state_recorded: boolean };
  sending: HeEngSendingSummary | null;
}

/**
 * «Start sending» / «Start the rest» / «Resume» (action 'start') или «Pause».
 * Отказ гейта платных шагов бросается EngPaidAccessError, прочие отказы —
 * Error с английским текстом роута.
 */
export async function postEngTemplateSending(
  templateId: string,
  action: 'start' | 'pause',
): Promise<EngSendingActionResponse> {
  return engPaidApiFetch<EngSendingActionResponse>(`/eng/templates/${templateId}/sending`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

/** Что предложить клиенту в окне отправки (работает и до запуска шаблона). */
export async function fetchEngSendingWindow(templateId: string): Promise<EngSendingWindowResponse> {
  return engApiFetch<EngSendingWindowResponse>(`/eng/templates/${templateId}/schedule`);
}

/** Поменять окно отправки у уже созданных кампаний запуска. */
export async function updateEngSendingWindow(
  templateId: string,
  schedule: EngSendingWindow,
): Promise<EngSendingWindowUpdateResponse> {
  return engApiFetch<EngSendingWindowUpdateResponse>(`/eng/templates/${templateId}/schedule`, {
    method: 'PATCH',
    body: JSON.stringify({ schedule }),
  });
}

/* ── ENG Command Center (GET /eng/dashboard) ── */

/**
 * Этап вертикали на дашборде (порядок конвейера research → … → launched, плюс
 * `attention` — дальше без человека не двинуться, и `not_selected` — клиент
 * вертикаль не выбрал). Типы — РЕЭКСПОРТ роутовых
 * (lib/hypothesisEngine/engDashboard), а не копия: копия отстала от роута на
 * этап `attention`, и компилятор этого не видел.
 * `launch_unfinished` — запись о запуске есть, но часть аудитории не уехала
 * (`heLaunchIsIncomplete`): его достраивает шаг 3.
 */
export type {
  EngDashAnalysisStopped,
  EngDashAttention,
  EngDashAutoLaunch,
  EngDashAttentionInfo,
  EngDashSelection,
  EngDashStage,
  EngDashTopUp,
  EngDashTopUpVerdict,
};

export interface EngDashboardVertical {
  id: string;
  project_id: string;
  name: string;
  stage: EngDashStage;
  /** Короткая строка этапа ('email enrichment: 87/147 valid'). */
  stageDetail: string;
  /**
   * Пять точек прогресса: research → letters → base → template → sending.
   * Пятую ставит роут по прочитанному статусу кампаний (`sending.state ===
   * 'sending'`, engDashboard.ts, EngDashDots).
   */
  dots: boolean[];
  /**
   * Числа карточки. Этот DTO написан руками и компилятором с роутом НЕ сверяется
   * (`/eng/dashboard` отдаёт `NextResponse.json`), поэтому имена полей здесь —
   * копия имён роута: `companies`, `rows`.
   */
  stats: {
    /**
     * КОМПАНИИ в базе (`collect_info.stats.companies_total`, пишет стадия при
     * финализации). 0 = не знаем: у баз, собранных до 26.09.2026, ключа нет.
     * Компаниями считать `rows` нельзя — см. ниже.
     */
    companies: number;
    /**
     * СТРОКИ базы (`he_bases.row_count`). Строка ≠ компания: ENG-сборка
     * разносит один адрес на строку (шаг `split_emails` у market='us'), у
     * компании с пятью адресами строк пять. Годится как честная замена
     * `companies`, когда тех нет, но только под своим именем («rows»).
     */
    rows: number;
    /** Адреса, найденные конструктором (не компании). */
    emails_found: number;
    /** Из них с допущенным вердиктом валидации (тоже адреса). */
    valid_count: number;
    appended_today: number;
    leads_launched: number;
  };
  /** Только имя кампании: ссылка наружу — бренд рассыльщика, в кабинет не едет. */
  launch: { campaign_name: string } | null;
  /**
   * Оценка модели 0–100 (potential_pct, подпись «market fit»), а не прогноз
   * доли ответов. null — оценки нет, вертикаль не выбрана или выбор не прочитан.
   */
  forecast: { pct: number } | null;
  /** Факт по запущенной кампании (петля actualsReconcile, свежесть 24ч). */
  actual: { reply_pct: number; sent: number; measured_at: string } | null;
  /**
   * Ночной добор снял ЭТУ вертикаль правилом сухой вертикали
   * (`he_verticals.refill_dry_since`): проект может идти, а она — нет. Поля
   * нет (ответ старше) либо `false` — пометки нет или её не прочитали.
   */
  refill_dry?: boolean;
  /**
   * Письма шаблона этапа запуск откажет: роут ставит признак проекции
   * `needs_rewrite` (heTemplateNeedsRewrite) шаблону этапа 'template' или
   * 'launch_unfinished'. Поля нет (ответ старше) либо `false` — подписи
   * карточки прежние.
   */
  letters_need_rewrite?: boolean;
  /**
   * Итоговые письма сняты «Rewrite letters», а новых нет и генерация не идёт
   * (EngDashStageInfo.lettersRetired): «Launch» рынок не двигает, путь —
   * «Rewrite letters» или Support на шаге 3. Поля нет — не этот случай.
   */
  letters_retired?: boolean;
  /**
   * Автопилот проекта вертикали: false — следующую стадию после писем и
   * проверки контактов никто не поставит до «Launch» шага 3. `null` или нет
   * поля — не прочитан.
   */
  autopilot?: boolean | null;
  /**
   * У проекта вертикали записана пауза по потолку расхода ('spend_paused'):
   * «Launch» шага 3 ничего платного не поставит. `null` или нет поля — паузы
   * не прочитаны.
   */
  spend_paused?: boolean | null;
  /**
   * Почему вертикаль стоит (этап `attention`); у других этапов `null`. Поля
   * нет у ответа старше этого этапа — карточка тогда печатает этап как есть.
   */
  attention?: EngDashAttentionInfo | null;
  /** Выбор вертикали клиентом (EngDashSelection); `null` или нет поля — не прочитан. */
  selection?: EngDashSelection | null;
  /**
   * Отправка запущенного шаблона вертикали: настоящий статус кампаний,
   * счётчики и кнопка (HeEngSendingSummary). `null` или нет поля — запуска
   * нет (или ответ старше S2).
   */
  sending?: HeEngSendingSummary | null;
  /** Шаблон, к которому относится `sending` (для кнопки); null — сводки нет. */
  sending_template_id?: string | null;
  /**
   * Возьмёт ли вертикаль ближайшая ночь добора — по основной кампании запуска,
   * как решает гейт ночи (deriveEngTopUpVerdict). `null` или нет поля —
   * запуска нет (или ответ старше этой правки: тогда кабинет судит по `sending`).
   */
  top_up?: EngDashTopUp | null;
  /**
   * Автозапуск шаблона этапа (S3, EngDashAutoLaunch): состояние и код его
   * строки. `null` или нет поля — автозапуска у рынка нет (не нажат «Launch»,
   * таблиц нет, не прочитан, ответ старше S3): готовый рынок тогда ждёт
   * «Launch now» на шаге 3.
   */
  auto_launch?: EngDashAutoLaunch | null;
  /** Шаблон, к которому относится `auto_launch`; null — автозапуска нет. */
  auto_launch_template_id?: string | null;
  /**
   * Остановку этапа чинит только команда (EngDashTeamFix): строка «next»
   * зовёт сначала в Support, потом к кнопке. `null` или нет поля — не этот
   * случай или не прочитано.
   */
  team_fix?: EngDashTeamFix | null;
}

export interface EngDashboardEvent {
  type:
    | 'letters_ready'
    | 'base_collected'
    | 'base_analyzed'
    | 'template_ready'
    | 'launched'
    | 'launch_unfinished'
    | 'refill_appended'
    | 'refill_empty'
    | 'needs_input'
    | 'failed';
  text: string;
  at: string;
}

export interface EngDashboardActiveJob {
  id: string;
  project_id: string;
  stage: string;
  status: string;
  vertical_id: string | null;
  progress: { done?: number; total?: number; label?: string } | null;
}

export interface EngDashboardResponse {
  projects?: Array<{
    id: string;
    name: string;
    status: string;
    /**
     * Research ждёт описания бизнеса (упал кодом website_thin) — пауза до
     * ответа клиента на шаге 1, не сбой. Нет поля — ответ старше правки: false.
     */
    awaits_description?: boolean;
    /**
     * Пауза автопилота проекта; `null` — паузы нет либо колонки ещё нет в БД
     * (роут читает её отдельным best-effort запросом и при отказе молча
     * отдаёт `null` — дашборд выдуманного состояния не показывает).
     */
    autopilot_hold?: ClientEngAutopilotHold | null;
    /**
     * Состояние ночного добора ЭТОГО проекта — `off` / `running` / `paused` /
     * `spend_paused` / `stopped` (см. `HeClientRefillState`: `paused` — пауза
     * по ёмкости, `spend_paused` — пауза по потолку расхода проекта, `stopped`
     * — отмена проекта кнопкой «Cancel all jobs»). Поля может не быть только у
     * ответа старше этой волны; тогда экран читает его как `off`. Вкладка,
     * открытая до выката раунда 4, значения `spend_paused` не знает, и до
     * перезагрузки страницы подписи добора такого проекта у неё неверны
     * (потолок расхода по умолчанию выключен — значения нет вовсе).
     */
    refill?: HeClientRefillState;
  }>;
  verticals?: EngDashboardVertical[];
  /**
   * Счётчики дня. `collected` — СТРОКИ сборок (в том числе пустые строки
   * компаний без найденного адреса); `collected_companies` — компании, 0 =
   * «не знаем» (база без счётчика компаний), тогда правду говорят только строки.
   */
  today?: { appended: number; valid: number; collected: number; collected_companies?: number };
  /**
   * Про АККАУНТ целиком, а не про проект: момент следующей ночи и суммарный
   * дневной кап ТОЛЬКО тех проектов, которые в неё пойдут (проект на паузе в
   * сумму не входит — его кап сегодня не потратится).
   *
   * Булева `enabled` здесь больше НЕТ: «включён ли добор» перестало быть
   * ответом на вопрос экрана, потому что у включённого добора появилось два
   * разных состояния. Сколько проектов идёт и сколько стоит, экран считает по
   * `projects[].refill` — один источник правды, а не два.
   */
  autoRefill?: { next_run_at: string; daily_cap: number };
  events?: EngDashboardEvent[];
  activeJobs?: EngDashboardActiveJob[];
  /**
   * Выключатель отправки аккаунта, когда он держит «Launch now»: 'not_enabled'
   * (ждёт разовой проверки командой) или 'revoked' (выключен). `null` или нет
   * поля — включён, не требуется или не прочитан: строки «next» как раньше.
   * Приходит и у кабинета без проектов: 'revoked' меняет абзац пустого
   * состояния (в нём «Launch» шага 3).
   */
  account_access?: 'not_enabled' | 'revoked' | null;
  error?: string;
}

export async function fetchEngDashboard(): Promise<EngDashboardResponse> {
  return engApiFetch<EngDashboardResponse>('/eng/dashboard');
}

/* ── «Do not contact» (GET/POST /blocklist, DELETE /blocklist/[id]) ── */

/**
 * Строка списка «Do not contact». Хранилище и роуты — общий чёрный список
 * клиента (`client_blocked_contacts`, `api/client/blocklist`); на запрос
 * ENG-кабинета роуты отвечают своей веткой (`api/client/blocklist/_eng.ts`):
 * постранично, с точным счётом и английскими текстами.
 */
export interface EngBlockedAddress {
  id: string;
  /** Как хранит список: адрес или '@домен' у строки компании. */
  email: string;
  created_at: string;
  /** 'domain' — строка блокирует компанию целиком (план §1B); нет ключа — адрес. */
  kind?: 'email' | 'domain';
  /** Что показать: адрес или домен без '@'; нет ключа — `email`. */
  value?: string;
}

/** Строка — домен компании (по `kind`, а у ответа старше — по '@' в начале). */
export function engBlockedIsDomain(item: EngBlockedAddress): boolean {
  return item.kind === 'domain' || (item.kind === undefined && item.email.startsWith('@'));
}

/** Текст строки списка: `value`, а без него — адрес / домен без '@'. */
export function engBlockedValue(item: EngBlockedAddress): string {
  if (typeof item.value === 'string' && item.value) return item.value;
  return engBlockedIsDomain(item) ? item.email.replace(/^@/, '') : item.email;
}

/**
 * Снятие людей из списка с идущих кампаний клиента (engDncRemoval.ts, за
 * выключателем HE_ENG_DNC_REMOVE). 'off' — выключено: список только не пускает
 * адреса в новые загрузки. Ответ без поля (сервер старше снятия) — тоже 'off':
 * такой сервер с кампаний никого не снимает.
 */
export type EngDncRemovalMode = 'off' | 'on';

export interface EngBlockedListPage {
  items: EngBlockedAddress[];
  /** Весь список клиента. */
  total: number;
  /** Под поиском `q`; без поиска равен `total`. */
  matching: number;
  offset: number;
  /** Следующая страница; null — дальше строк нет. */
  next_offset: number | null;
  in_campaign_removal: EngDncRemovalMode;
  /**
   * Разных адресов ждут проверки кампаний / снять не удалось (только то, с чем
   * клиент ещё может что-то сделать: адрес в списке, кампания его и не
   * завершена). null — снятие выключено или сводка не прочиталась (при 'on').
   */
  pending: number | null;
  failed: number | null;
  /** До 10 адресов из `failed`, по алфавиту. */
  failed_examples: string[];
  /** `failed` — нижняя граница (неудач больше, чем отдала сводка). */
  failed_at_least: boolean;
  /**
   * Строк-доменов во всём списке; null — сервер не прочитал счёт, нет ключа
   * (сервер старше доменов) — 0.
   */
  domains_total: number | null;
  /** Можно ли добавлять домены (выключатель HE_ENG_DNC_DOMAINS); нет ключа — нельзя. */
  domains_enabled: boolean;
}

function dncCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function dncExamples(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string' && e.length > 0).slice(0, 10) : [];
}

export async function fetchEngBlockedList(opts: { offset?: number; q?: string } = {}): Promise<EngBlockedListPage> {
  const qs = new URLSearchParams();
  if (opts.offset) qs.set('offset', String(opts.offset));
  if (opts.q) qs.set('q', opts.q);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const page = await engApiFetch<EngBlockedListPage>(`/blocklist${suffix}`);
  const on = page.in_campaign_removal === 'on';
  const failed = on ? dncCount(page.failed) : null;
  return {
    ...page,
    in_campaign_removal: on ? 'on' : 'off',
    pending: on ? dncCount(page.pending) : null,
    failed,
    failed_examples: failed ? dncExamples(page.failed_examples) : [],
    failed_at_least: failed !== null && page.failed_at_least === true,
    domains_total: page.domains_total === undefined ? 0 : dncCount(page.domains_total),
    domains_enabled: page.domains_enabled === true,
  };
}

/** Страниц поиска, которые findEngBlockedAddress читает в поисках точного адреса. */
const FIND_PAGES_MAX = 3;

export type EngBlockedFindResult =
  | { kind: 'found'; entry: EngBlockedAddress }
  | { kind: 'absent' }
  /** Подстроку содержат больше адресов, чем прочитано страниц: точного среди них не видно. */
  | { kind: 'not_checked' };

/**
 * Строка списка с ТОЧНО этим адресом (для «Remove from Do not contact» на
 * Replies: DELETE берёт id строки, а добавление id не возвращает). Ищет
 * поиском роута (`q` — подстрока), сверяет адрес целиком, до FIND_PAGES_MAX
 * страниц. `email` — уже нормализованный (trim + lowercase, как хранит
 * список). Бросает на сбое чтения (engApiFetch).
 */
export async function findEngBlockedAddress(email: string): Promise<EngBlockedFindResult> {
  let offset = 0;
  for (let page = 0; page < FIND_PAGES_MAX; page += 1) {
    const res = await fetchEngBlockedList({ offset, q: email });
    const entry = res.items.find((item) => item.email === email);
    if (entry) return { kind: 'found', entry };
    if (res.next_offset === null) return { kind: 'absent' };
    offset = res.next_offset;
  }
  return { kind: 'not_checked' };
}

/** Недобавленное из вставки: сколько и до 10 примеров как есть. */
export interface EngBlockedRejected {
  count: number;
  examples: string[];
}

export interface EngBlockedAddResult {
  added: number;
  already_listed: number;
  /** Сайты, домены и шаблоны с явным признаком — список берёт только точные адреса. */
  domains: EngBlockedRejected;
  /** Не адреса (имена, обрывки, слова с точкой). */
  invalid: EngBlockedRejected;
  /** Размер списка после добавления; null — адресов во вставке не было. */
  total: number | null;
  /**
   * Снятие адресов вставки с идущих кампаний (engDncRemoval.HeEngDncRemovalView):
   *  - 'off' — выключено (или поля нет: сервер старше снятия, или во вставке
   *    не было адресов);
   *  - 'none_running' — кампаний у клиента нет, снимать неоткуда;
   *  - 'removing' — адреса разложены по `removal_campaigns` кампаниям клиента,
   *    их проверяют и снимают найденных;
   *  - 'deferred' — кампании сейчас не прочитались, проверку разложат позже;
   *  - 'not_scheduled' — проверка не заявилась: кампании не проверяются, пока
   *    адреса не добавят ещё раз.
   */
  removal: EngDncAddRemoval;
  /** Сколько кампаний клиента проверяется (только при 'removing'; null — число не пришло). */
  removal_campaigns: number | null;
  /**
   * Только при 'removing' / 'none_running': у клиента в этот момент шёл
   * запуск — он ещё может добавить этих людей в кампанию, и кампании клиента
   * проверятся ещё раз, когда он кончится.
   */
  removal_after_launch: boolean;
  /**
   * Только при 'removing' / 'none_running' и только у Block на Replies:
   * кампания, на которую человек ответил, не проверяется (она перестала ему
   * писать, когда он ответил), `removal_campaigns` — остальные.
   */
  removal_skipped_reply_campaign: boolean;
}

export type EngDncAddRemoval = 'off' | 'none_running' | 'removing' | 'deferred' | 'not_scheduled';

const ADD_REMOVAL_VALUES: readonly EngDncAddRemoval[] = ['none_running', 'removing', 'deferred', 'not_scheduled'];

function addRemovalOf(raw: unknown): EngDncAddRemoval {
  return ADD_REMOVAL_VALUES.find((v) => v === raw) ?? 'off';
}

/**
 * Итог добавления. Отказ несёт английский текст роута; `reload` — состав
 * списка после ответа неизвестен или он длиннее потолка (коды
 * `add_unconfirmed`, `over_limit_stuck`, `list_over_limit`), экран
 * перечитывает список. `code` — машинный код отказа роута (null — 4xx без
 * кода): Replies по нему отличает «добавлен ли адрес, неизвестно»
 * (`add_unconfirmed`), где текст роута отсылает к списку «below».
 *
 * `error: null` — читаемого ответа нет: не-JSON (502/504 nginx во время
 * деплоя или по таймауту), 5xx без кода, 2xx без итога. Роут мог успеть
 * записать строки, поэтому исход неизвестен: экран говорит это своей фразой и
 * перечитывает список (`reload` тогда всегда true).
 */
export type EngBlockedAddOutcome =
  | { ok: true; result: EngBlockedAddResult }
  | { ok: false; error: string; code: string | null; reload: boolean }
  | { ok: false; error: null; code: null; reload: true };

const BLOCKED_ADD_RELOAD_CODES: readonly string[] = ['add_unconfirmed', 'over_limit_stuck', 'list_over_limit'];

function rejectedOf(raw: unknown): EngBlockedRejected {
  const r = raw as Partial<EngBlockedRejected> | null;
  return {
    count: typeof r?.count === 'number' ? r.count : 0,
    examples: Array.isArray(r?.examples) ? r.examples.filter((e): e is string => typeof e === 'string') : [],
  };
}

/**
 * Число кампаний — только у 'removing' и только положительное; иначе null
 * (текст тогда без числа). Признаки запуска и кампании ответа — только у
 * 'removing' / 'none_running' и только `true` (иначе false: сервер старше —
 * про них не говорим).
 */
function addRemovalFields(
  body: Record<string, unknown>,
): Pick<EngBlockedAddResult, 'removal' | 'removal_campaigns' | 'removal_after_launch' | 'removal_skipped_reply_campaign'> {
  const removal = addRemovalOf(body.removal);
  const campaigns = removal === 'removing' ? dncCount(body.removal_campaigns) : null;
  const laidOut = removal === 'removing' || removal === 'none_running';
  return {
    removal,
    removal_campaigns: campaigns && campaigns > 0 ? campaigns : null,
    removal_after_launch: laidOut && body.removal_after_launch === true,
    removal_skipped_reply_campaign: laidOut && body.removal_skipped_reply_campaign === true,
  };
}

/**
 * `replyId` — только «Block» на Replies: id ответа, на карточке которого
 * нажали (`text` — ровно его адрес). Сервер по нему не проверяет кампанию
 * этого ответа (см. `removal_skipped_reply_campaign`).
 */
export async function addEngBlockedAddresses(text: string, opts: { replyId?: string } = {}): Promise<EngBlockedAddOutcome> {
  const { res, body } = await engApiFetchRaw('/blocklist', {
    method: 'POST',
    body: JSON.stringify(opts.replyId ? { text, reply_id: opts.replyId } : { text }),
  });
  if (res.ok && body && typeof body.added === 'number') {
    return {
      ok: true,
      result: {
        added: body.added,
        already_listed: typeof body.already_listed === 'number' ? body.already_listed : 0,
        domains: rejectedOf(body.domains),
        invalid: rejectedOf(body.invalid),
        total: typeof body.total === 'number' ? body.total : null,
        ...addRemovalFields(body),
      },
    };
  }
  // Ответ-отказ — с машинным кодом (коды роута, DEMO_READONLY) или 4xx с
  // текстом. Всё прочее — исход неизвестен (см. EngBlockedAddOutcome).
  const refused =
    !res.ok &&
    body !== null &&
    (typeof body.code === 'string' || (res.status < 500 && typeof body.error === 'string'));
  if (!refused) return { ok: false, error: null, code: null, reload: true };
  const code = typeof body.code === 'string' ? body.code : null;
  return {
    ok: false,
    error: engRawErrorText(res, body),
    code,
    reload: code !== null && BLOCKED_ADD_RELOAD_CODES.includes(code),
  };
}

/**
 * Итог добавления доменов компаний (POST /blocklist {kind:'domains'}, план §1B).
 * Отказы нормализации — `invalid` (не домен), `personal` (почтовый сервис
 * для частных лиц), `not_company` (публичный суффикс, конструктор сайтов,
 * соцсеть); `subdomains` — добавлены как набраны, но это поддомены.
 */
export interface EngBlockedDomainsResult {
  added: number;
  already_listed: number;
  invalid: EngBlockedRejected;
  personal: EngBlockedRejected;
  not_company: EngBlockedRejected;
  subdomains: EngBlockedRejected;
  /** Размер списка после добавления; null — не пришёл. */
  total: number | null;
}

export type EngBlockedDomainsOutcome =
  | { ok: true; result: EngBlockedDomainsResult }
  | { ok: false; error: string; code: string | null; reload: boolean }
  | { ok: false; error: null; code: null; reload: true };

/** Отказ нормализации — объектом {count, examples} или голым числом (сервер вправе отдать и так). */
function rejectedLooseOf(raw: unknown): EngBlockedRejected {
  if (typeof raw === 'number') return { count: Number.isSafeInteger(raw) && raw > 0 ? raw : 0, examples: [] };
  const r = rejectedOf(raw);
  return { count: Math.max(r.count, 0), examples: r.examples.slice(0, 10) };
}

/**
 * «Company domains» на странице Do not contact. Тот же роут и те же отказы,
 * что у addEngBlockedAddresses; домены проверяет и нормализует сервер
 * (blockedDomains.ts), экран печатает его итог. Отказы с кодом —
 * `domains_unavailable` (выключатель погас) и `not_eng_market` — английским
 * текстом роута, как прочие.
 */
export async function addEngBlockedDomains(text: string): Promise<EngBlockedDomainsOutcome> {
  const { res, body } = await engApiFetchRaw('/blocklist', {
    method: 'POST',
    body: JSON.stringify({ text, kind: 'domains' }),
  });
  if (res.ok && body && typeof body.added === 'number') {
    return {
      ok: true,
      result: {
        added: body.added,
        already_listed: typeof body.already_listed === 'number' ? body.already_listed : 0,
        invalid: rejectedLooseOf(body.invalid),
        personal: rejectedLooseOf(body.personal),
        not_company: rejectedLooseOf(body.not_company),
        subdomains: rejectedLooseOf(body.subdomains),
        total: typeof body.total === 'number' ? body.total : null,
      },
    };
  }
  const refused =
    !res.ok &&
    body !== null &&
    (typeof body.code === 'string' || (res.status < 500 && typeof body.error === 'string'));
  if (!refused) return { ok: false, error: null, code: null, reload: true };
  const code = typeof body.code === 'string' ? body.code : null;
  return {
    ok: false,
    error: engRawErrorText(res, body),
    code,
    reload: code !== null && BLOCKED_ADD_RELOAD_CODES.includes(code),
  };
}

/**
 * Итог удаления. `removed: 0` — строки уже нет (удалена в другой вкладке).
 * `error: null` — читаемого ответа нет (не-JSON 502/504): удалилась ли строка,
 * неизвестно, экран говорит это своей фразой. Отказ роута — его английский
 * текст (повтор удаления безопасен: уже удалённая строка даст removed: 0).
 */
export type EngBlockedRemoveOutcome =
  | { ok: true; removed: number }
  | { ok: false; error: string | null };

export async function removeEngBlockedAddress(id: string): Promise<EngBlockedRemoveOutcome> {
  const { res, body } = await engApiFetchRaw(`/blocklist/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok && body && typeof body.removed === 'number') return { ok: true, removed: body.removed };
  return { ok: false, error: body && typeof body.error === 'string' ? engRawErrorText(res, body) : null };
}
