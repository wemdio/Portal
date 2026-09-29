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
import { engErrorText, localizeEngError } from './engText';
import type { HeChainLetterDto, HeProjectDetailResponse } from '@/components/hypothesis-engine/api';
import type { HeChain, HeHypothesis, HeJob, HeProject } from '@/lib/hypothesisEngine/types';
import type {
  HeLaunchPresetOption,
  HeTemplateLaunchCampaign,
  HeTemplateLaunchInfo,
} from '@/lib/hypothesisEngine/launchHandoff';
// Только тип — см. пояснение в engText.ts: словарь кодов один на оба конца
// провода, а сам модуль проекции в клиентский бандл не уезжает.
import type {
  ClientEngAutopilotHold,
  HeClientAutopilotHoldCode,
  HeClientStageErrorCode,
} from '@/lib/hypothesisEngine/clientEngProjection';

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
 * Джоба движка в ответах кабинета: деталка проекта и четыре мутирующих роута.
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
  dispatched_at?: string;
  /** Почт найдено конструктором. */
  emails_found?: number;
  /** Почт с вердиктом ok после валидации. */
  valid_count?: number;
  note?: string;
}

/** collect_info с полями ENG-конвейера (construct + stats). */
export interface EngCollectInfo extends HeCollectInfo {
  construct?: EngConstructInfo;
  stats?: {
    tasks_total?: number;
    tasks_done?: number;
    tasks_failed?: number;
    rows_total?: number;
    finished_at?: string;
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
  /** Сохранённый выбор клиента; null — ещё не выбирал. */
  schedule?: EngSendingWindow | null;
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
  /** Окно отправки, с которым уехали созданные кампании. */
  schedule?: EngSendingWindow;
  warnings?: string[];
  error?: string;
}

interface EngChainPatchResponse {
  letters?: HeChainLetterDto[];
  error?: string;
}

/**
 * Единственная дверь кабинета в /api/client: поверх общего фетча доводим текст
 * до английского (см. engText) — и у брошенной ошибки, и у поля `error` в теле
 * ответа, которое роуты отдают вместе с 200-м статусом (частичный запуск).
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

export async function createEngProject(input: {
  website_url: string;
  name?: string;
}): Promise<EngProjectCreateResponse> {
  return engApiFetch<EngProjectCreateResponse>('/eng/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchEngProjectDetail(projectId: string): Promise<EngProjectDetailResponse> {
  return engApiFetch<EngProjectDetailResponse>(`/eng/projects/${projectId}`);
}

export async function patchEngProject(
  projectId: string,
  body: { offer_override?: string; style_override?: string; signature_override?: string; business_override?: string },
): Promise<EngPatchResponse> {
  return engApiFetch<EngPatchResponse>(`/eng/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function startEngResearch(projectId: string): Promise<EngJobResponse> {
  return engApiFetch<EngJobResponse>(`/eng/projects/${projectId}/research`, { method: 'POST' });
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
  return engApiFetch<EngAutopilotResponse>(`/eng/projects/${projectId}/autopilot`, { method: 'POST' });
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

export async function collectEngBase(
  verticalId: string,
  body: { limit: number; hypothesis_ids?: string[] },
): Promise<EngBaseCollectResponse> {
  return engApiFetch<EngBaseCollectResponse>(`/eng/verticals/${verticalId}/collect`, {
    method: 'POST',
    body: JSON.stringify(body),
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

export async function launchEngTemplate(
  templateId: string,
  body: { preset_id: string; force?: boolean; schedule?: EngSendingWindow },
): Promise<EngLaunchResponse> {
  return engApiFetch<EngLaunchResponse>(`/eng/templates/${templateId}/launch`, {
    method: 'POST',
    body: JSON.stringify(body),
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

/** Этап вертикали на дашборде (порядок конвейера research → … → launched). */
export type EngDashStage =
  | 'research'
  | 'letters'
  | 'collecting'
  | 'construct'
  | 'analyzing'
  | 'analyzed'
  | 'template'
  | 'launched';

export interface EngDashboardVertical {
  id: string;
  project_id: string;
  name: string;
  stage: EngDashStage;
  /** Короткая живой строки этапа ('constructor: 87/147 valid'). */
  stageDetail: string;
  /** Пять точек прогресса: research → letters → base → template → launched. */
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
  /** Прогноз движка (potential_pct), если был выставлен. */
  forecast: { pct: number } | null;
  /** Факт по запущенной кампании (петля actualsReconcile, свежесть 24ч). */
  actual: { reply_pct: number; sent: number; measured_at: string } | null;
}

export interface EngDashboardEvent {
  type:
    | 'letters_ready'
    | 'base_collected'
    | 'base_analyzed'
    | 'template_ready'
    | 'launched'
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
  }>;
  verticals?: EngDashboardVertical[];
  today?: { appended: number; valid: number; collected: number };
  autoRefill?: { enabled: boolean; next_run_at: string; daily_cap: number };
  events?: EngDashboardEvent[];
  activeJobs?: EngDashboardActiveJob[];
  error?: string;
}

export async function fetchEngDashboard(): Promise<EngDashboardResponse> {
  return engApiFetch<EngDashboardResponse>('/eng/dashboard');
}
