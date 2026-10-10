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
import type {
  HeLaunchPresetOption,
  HeTemplateLaunchCampaign,
  HeTemplateLaunchInfo,
} from '@/lib/hypothesisEngine/launchHandoff';
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
import type { EngResearchRetryVerdict } from '@/lib/hypothesisEngine/researchJob';
// Тоже только типы: этап и причина карточки дашборда — один словарь на роут
// (lib/hypothesisEngine/engDashboard) и на экран.
import type {
  EngDashAnalysisStopped,
  EngDashAttention,
  EngDashAttentionInfo,
  EngDashSelection,
  EngDashStage,
} from '@/lib/hypothesisEngine/engDashboard';

// `HeBaseSummary`/`HeProjectDetailResponse` отсюда БОЛЬШЕ НЕ реэкспортируются:
// оба обещают `error: string` — сырой текст стадии, которого в ответе кабинета
// нет. Их суженные пары — `EngBaseSummary` и `EngProjectDetailResponse` ниже.
// Письмо цепочки у обоих контуров одно и то же, его реэкспорт остаётся.
export type { HeChainLetterDto } from '@/components/hypothesis-engine/api';
export type { HeLaunchPresetOption };

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
 * Имя прежнее: под ним тип импортируют EngStepBrief/EngStepLetters/
 * EngStepReview — файлы чужой полосы, переименование это их правка.
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
};

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

/**
 * collect_info с полями ENG-конвейера (construct + stats). Только то, что
 * отдаёт проекция (COLLECT_STATS_FIELDS / CONSTRUCT_FIELDS): поле, которого
 * в ответе нет, здесь не объявляется.
 */
export interface EngCollectInfo extends HeCollectInfo {
  construct?: EngConstructInfo;
  stats?: {
    tasks_total?: number;
    tasks_done?: number;
    tasks_failed?: number;
    rows_total?: number;
    /** Строк, которые гейт релевантности пометил как вне вертикали. */
    low_relevance?: number;
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
   * ANALYZING_ORPHAN_GRACE_MS), тем же, что у Command Center и «Start
   * outreach». Финальный фейл анализа статус базы не меняет, поэтому статус
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
};

interface EngProjectsResponse {
  projects?: EngProjectListItem[];
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

interface EngPresetsResponse {
  presets?: HeLaunchPresetOption[];
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
   * Отказ ядра запуска с машинным кодом (409 или 503 с `code`,
   * launchTemplate.ts): запуск не состоялся, кампания не создана, `error` —
   * английский текст ядра. Только у этих кодов launchEngTemplate отвечает
   * значением, а не бросает: «Launch all» обходится с ними по-разному
   * (EngStepReview, LaunchAllPanel).
   */
  refusal?: EngLaunchRefusalCode;
}

/**
 * Машинные коды отказов, которые экран различает, — копия части
 * HE_LAUNCH_REFUSAL_CODES и HE_LAUNCH_PREFLIGHT_REFUSAL_CODES (launchTemplate.ts):
 * сам модуль ядра в клиентский бандл не едет.
 *  - sibling_template_launched — у другого шаблона той же базы уже есть запуск;
 *  - research_running — у проекта идёт повторное исследование;
 *  - preset_no_mailboxes — в пресете нет ни одного ящика отправки (пресет
 *    один на всю пачку «Launch all», следующий шаблон получил бы то же);
 *  - segment_classification_incomplete — 503: классификатор сегментов не
 *    ответил по слишком большой доле адресов. Он общий у всех шаблонов, и
 *    следующий шаблон с сегментами снова оплатил бы классификацию всей своей
 *    аудитории ради того же отказа. Отказ лимита неудачных запусков шаблона
 *    (тоже 503) приходит БЕЗ кода — это EngLaunchServerError.
 * template_unresolved_operators экрану различать незачем: это ошибка одного
 * шаблона (бросается), а шаблоны, которые она ждёт, «Launch all» и не берёт
 * (`needs_rewrite`, engTemplateNeedsRewrite).
 */
export type EngLaunchRefusalCode =
  | 'sibling_template_launched'
  | 'research_running'
  | 'preset_no_mailboxes'
  | 'segment_classification_incomplete';

function isEngLaunchRefusalCode(raw: unknown): raw is EngLaunchRefusalCode {
  return (
    raw === 'sibling_template_launched' ||
    raw === 'research_running' ||
    raw === 'preset_no_mailboxes' ||
    raw === 'segment_classification_incomplete'
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
 * тогда шаг 5 о подстановках ничего не утверждает.
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
 * (engPaidApiFetch: создание проекта, «Start outreach», «Collect again»,
 * «Resume auto-refill»). Они ходят через engApiFetchRaw и доводят тексты теми
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

export async function fetchEngProjects(): Promise<EngProjectListItem[]> {
  const data = await engApiFetch<EngProjectsResponse>('/eng/projects');
  return data.projects ?? [];
}

/**
 * Создание проекта. `business_override` и `icp` — ответы, которые читает само
 * исследование (описание бизнеса и рамка ЦА — те же ключи brief, что правит
 * шаг «Brief»); шлётся только заполненное. Отказ «один аккаунт — один сайт»
 * приходит отказом гейта (EngPaidAccessError, код project_limit).
 */
export async function createEngProject(input: {
  website_url: string;
  name?: string;
  business_override?: string;
  icp?: Partial<HeIcpFrame>;
}): Promise<EngProjectCreateResponse> {
  return engPaidApiFetch<EngProjectCreateResponse>('/eng/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
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
 * делает `satisfies`.
 */
const ENG_PAID_ACCESS_CODES = [
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

/* ── Автопилот (POST /eng/projects/[id]/autopilot) ── */

export interface EngAutopilotResponse {
  ok?: boolean;
  chains_enqueued?: number;
  collects_enqueued?: number;
  templates_enqueued?: number;
  /** Осиротевшим базам доставлен пропавший анализ — тоже поставленная стадия. */
  analyses_requeued?: number;
  verticals_skipped?: number;
  /**
   * Сколько выбранных вертикалей нажатие НЕ собрало заново, потому что их
   * последняя база остановилась решением, которое повторится
   * (HE_COLLECT_STOP_REPEATS_CODES). Повтор — «Collect again» на шаге 4. Нет
   * ключа — ответ старше этого поля.
   */
  collect_again_verticals?: number;
  /**
   * Пауза, записанная этим же нажатием: `null`/нет ключа — проект не на
   * паузе. КОД, а не причина движка и не текст — тот же закрытый словарь, что
   * у `EngProject.autopilot_hold`. Метки времени здесь нет намеренно: нажатие
   * только что произошло, и второй источник её значения экрану не нужен —
   * карточку паузы со временем рисует мастер по деталке проекта.
   */
  autopilot_hold_code?: HeClientAutopilotHoldCode | null;
  error?: string;
}

export async function startEngAutopilot(projectId: string): Promise<EngAutopilotResponse> {
  return engPaidApiFetch<EngAutopilotResponse>(`/eng/projects/${projectId}/autopilot`, { method: 'POST' });
}

/* ── Превью строк базы (GET /eng/bases/[id]/rows) ── */

export interface EngBaseRowsResponse {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  total?: number;
  status?: string;
  row_count?: number;
  error?: string;
}

export async function fetchEngBaseRows(
  baseId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<EngBaseRowsResponse> {
  const qs = new URLSearchParams();
  if (opts.offset) qs.set('offset', String(opts.offset));
  if (opts.limit) qs.set('limit', String(opts.limit));
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
 * «Collect again» шага 4 — новая сборка вертикали (до 2 000 компаний, по
 * гипотезам, принятым на шаге 2: лимит и гипотезы решает сервер, тело пустое).
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

export async function fetchEngLaunchPresets(templateId: string): Promise<HeLaunchPresetOption[]> {
  const data = await engApiFetch<EngPresetsResponse>(`/eng/templates/${templateId}/launch`);
  return data.presets ?? [];
}

/**
 * Запуск шаблона не прошёл на нашей стороне: 5xx роута запуска без кода
 * отказа (сбой ядра или рассыльщика, лимит неудачных запусков шаблона за
 * час). «Launch all» на нём останавливает прогон (EngStepReview): сбой после
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
 */
export async function launchEngTemplate(
  templateId: string,
  body: { preset_id: string; schedule?: EngSendingWindow },
): Promise<EngLaunchResponse> {
  const { res, body: data } = await engApiFetchRaw(`/eng/templates/${templateId}/launch`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const out = (data ?? {}) as EngLaunchResponse;
    if (typeof out.error === 'string') out.error = engErrorText(out.error);
    return out;
  }
  if ((res.status === 409 || res.status === 503) && isEngLaunchRefusalCode(data?.code)) {
    return { ok: false, error: engRawErrorText(res, data), refusal: data.code };
  }
  const paidAccess = engPaidAccessErrorFrom(res, data);
  if (paidAccess) throw paidAccess;
  if (res.status >= 500) throw new EngLaunchServerError(engRawErrorText(res, data), res.status);
  throw new Error(engRawErrorText(res, data));
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
 * (`heLaunchIsIncomplete`): его достраивают на шаге 5.
 */
export type { EngDashAnalysisStopped, EngDashAttention, EngDashAttentionInfo, EngDashSelection, EngDashStage };

export interface EngDashboardVertical {
  id: string;
  project_id: string;
  name: string;
  stage: EngDashStage;
  /** Короткая строка этапа ('email enrichment: 87/147 valid'). */
  stageDetail: string;
  /**
   * Пять точек прогресса: research → letters → base → template → sending.
   * Пятую не ставит ни один этап: статус кампании у рассыльщика кабинет не
   * читает (engDashboard.ts, EngDashDots).
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
   * Почему вертикаль стоит (этап `attention`); у других этапов `null`. Поля
   * нет у ответа старше этого этапа — карточка тогда печатает этап как есть.
   */
  attention?: EngDashAttentionInfo | null;
  /** Выбор вертикали клиентом (EngDashSelection); `null` или нет поля — не прочитан. */
  selection?: EngDashSelection | null;
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
  error?: string;
}

export async function fetchEngDashboard(): Promise<EngDashboardResponse> {
  return engApiFetch<EngDashboardResponse>('/eng/dashboard');
}
