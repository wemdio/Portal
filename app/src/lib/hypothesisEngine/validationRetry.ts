/**
 * Восстановление адресов авто-базы БЕЗ новой сборки (P-C-validation-retry-
 * without-recollect). Только market='us', только staff-роут
 * api/tools/hypothesis-engine/bases/[id]/revalidate. Клиентской кнопки нет:
 * роут, который ставит работу провайдеров из кабинета, — решение владельца.
 *
 * ЗАЧЕМ. До этого модуля у оплаченной сборки было два тупика, и выход из обоих
 * был один — новая платная сборка той же вертикали:
 *  1. Джоба конструктора завершилась ПОСЛЕ того, как стадия перестала её ждать
 *     (джоба сборки исчерпала попытки и ремонт воркера закрыл базу, отмена
 *     джобы конструктора на таймауте не легла или проиграла гонку
 *     завершению). База стоит 'failed' без строк, а готовая сетка лежит в
 *     base_constructor_jobs.
 *  2. Конструктор дошёл до конца, но валидатор лежал: массовые 'unknown' /
 *     'error'. Запуск такие строки не берёт (только 'ok'), а компании уже
 *     исключены из будущих сборок проекта (база не 'failed').
 *
 * ПОЗДНИЙ ИМПОРТ (importHeLateConstructForBase). Принимает ТОЛЬКО то, что
 * стадия приняла бы сама, дождись она джобы:
 *  - база 'failed', строк нет, collect_info.construct = 'dispatched' с id
 *    джобы (id резервируется ДО вставки — его и берём), кап «адресов на
 *    компанию» записан (контракт «один адрес на строку»), гейт релевантности до
 *    конструктора отработал (иначе нужен платный суд после импорта);
 *  - джоба конструктора 'completed' и в её шагах есть split_emails. Частичную
 *    сетку failed/cancelled-джобы (её как раз и оставляет отмена на таймауте)
 *    этот путь НЕ берёт: обрыв посреди поиска адресов оставляет найденные
 *    адреса в отдельной колонке и склеенные ячейки — импорт их потерял бы, а
 *    компании выжег;
 *  - последняя джоба сборки этой базы 'failed' (сборку бросили), живой нет,
 *    отменённой нет, отметка отмены проекта не новее базы (отмену решает
 *    человек — её не перебиваем; без колонки отметки, то есть без миграции
 *    20261009_0002, — отказ), проект не в повторном исследовании, у
 *    вертикали нет другой идущей сборки (её импорт сверялся бы с нашей
 *    базой вслепую), другой auto-базы (не долива) в 'analyzing'/'analyzed'
 *    и более молодой не-refill базы — те же границы, что у автоподъёма,
 *    автопилота и реконсилера (verticalSiblingRefusal): анализ вертикали,
 *    который уже есть или идёт, второй раз не оплачиваем. Вертикаль
 *    перепроверяется прямо перед записью и ещё раз прямо перед постановкой
 *    base_analyze.
 * Сам импорт — prepareHeLateConstructImport (stages/baseCollect.ts): тот же
 * разбор сетки, сверка с другими базами проекта и кап, что у стадии. Запись —
 * CAS по (id, 'failed', прочитанный updated_at) → 'analyzing', затем постановка
 * base_analyze с дедупом, как у стадии.
 * ОТКАТ. Между записью и постановкой клиент может нажать «Collect base» или
 * отменить проект; тогда анализ не ставится, и база, оставшись 'analyzing',
 * висела бы так навсегда: без анализа, со строками, исключёнными из всех
 * будущих сборок проекта. Поэтому отказ ПОСЛЕ своей записи откатывает её — CAS
 * по (id, 'analyzing', updated_at = момент нашей записи) обратно в 'failed' с
 * прежней причиной, прежним updated_at и без строк (revertHeLateImport). Это
 * и есть состояние до импорта: 'failed' не держит компании исключёнными
 * (loadOtherBaseExclusionKeys берёт только не-'failed' базы), граница отмены
 * (cancelled_at против updated_at) та же, что была, а строк у такой базы не
 * было (импорт берёт только базу без строк). Что откатывать, запись импорта
 * кладёт рядом с собой (construct.late_import_undo): так откатить может и
 * повторный вызов, если первый умер между записью и постановкой.
 *
 * ПЕРЕПРОВЕРКА АДРЕСОВ (advanceHeBaseRevalidation). Конструктор умеет
 * список шагов, и шаг validate_emails работает один — так же сохранённые
 * адреса перепроверяет V2. Раунд — одна джоба конструктора на
 * HE_REVALIDATION_BATCH адресов: такую джобу (validate_emails одна, ≤ 200
 * строк) воркер конструктора через раз берёт раньше общей FIFO
 * (worker/baseConstructor.ts: preferPreview → nextPendingConstructor), то есть
 * раунд не ждёт всю ночную очередь, и каждый раунд показывает, жив ли
 * валидатор, прежде чем проверять следующие адреса.
 * Кандидат — строка с ОДНИМ адресом, без пометки «вне вертикали», с вердиктом
 * НЕ из {ok, invalid, disposable, catch_all} (то есть unknown, error, пусто,
 * незнакомое слово). Один вызов роута — один шаг:
 *  - раунд в полёте → ждём (или 6 ч прошло — джоба отменяется, раунд закрыт);
 *  - раунд закончился (completed / failed / cancelled) → вердикты сетки ложатся
 *    на строки (адрес, которого в сетке нет, вердикт не меняет: конструктор
 *    выбрасывает строки invalid/disposable, а у оборванной джобы — ещё и
 *    непроверенные), пересчитываются construct.valid_count и
 *    stats.ok_contacts; запись — CAS по прочитанному updated_at. Курсор
 *    прохода сдвигается только за 'completed'-раундом;
 *  - затем, если запуска у базы нет, ставится следующий раунд.
 * Проход — курсор по строкам `data`: раунд берёт адреса, начиная с курсора, и
 * сдвигает его за последнюю взятую строку. Без курсора повторный вызов при
 * лежащем валидаторе брал бы те же 200 адресов снова и до остальных не дошёл
 * бы никогда. Проход закончен — новых раундов нет, пока сотрудник не начнёт
 * новый (`restart`). Курсор, а не пометка на строке: строки целиком уходят в
 * промпт классификатора сегментов (segmentClassify), и новая служебная ячейка
 * удорожала бы ПЛАТНЫЙ вызов.
 * Запуска у базы быть не должно (heTemplateLaunchMarked по её шаблонам):
 * законченный запуск новых строк не досылает, а у незаконченного досылка — это
 * поимённый список launch_info.pending, куда перепроверенные адреса не входят.
 * Проверять адреса, которые никто не отправит, — тратить пробы впустую. Раунд,
 * который закончился уже после запуска, применяется (это правда о строках), но
 * следующего не будет.
 *
 * ЦЕНА. Ни одного платного вызова (Requesty, Serper) здесь нет:
 *  - перепроверка — DNS публичных резолверов и SMTP-проба через НАШ прокси
 *    (lib/emailValidation/validator.ts, SMTP_PROXY_URL[S]) — инфраструктура:
 *    ≤ HE_REVALIDATION_BATCH адресов за раунд, ≤ EMAIL_VALIDATION_MAX_ATTEMPTS (2)
 *    пробы на адрес в джобе; за проход каждый кандидат уходит в раунд один раз;
 *  - поздний импорт — чтения и одна запись; дальше база идёт тем же путём, что
 *    после импорта стадией: base_analyze (один вызов bulk-модели по 30
 *    строкам-образцам). Это анализ, который оплатила бы и сама сборка, дождись
 *    она конструктора, и который оплатит любая повторная сборка вертикали —
 *    единственный выход сегодня, где сверх анализа платятся план, проба среза,
 *    гейт релевантности, обход сайтов и пробы заново.
 *
 * Строки базы читаются и пишутся целиком (`data`, до 50 000 строк) — тем же
 * клиентом, что у роутов (supabaseAdmin). Состояние — he_bases.collect_info
 * (`revalidation`, `construct.late_import_at`): в БД, не в памяти процесса, и в
 * клиентскую проекцию не входит.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { extractEmails } from '@/lib/tools/dfybUtils';

import { heConstructContactCap, heLaunchEmailVerdict, type HeLaunchEmailPolicy } from './launchHandoff';
import { readHeEngEmailPolicy } from './engEmailPolicy';
import { HE_TEMPLATE_LAUNCH_MARK_COLUMNS, heTemplateLaunchMarked, type HeTemplateLaunchMark } from './launchTemplate';
import { normalizeHeMarket, type HeMarket } from './market';
import { isHeMissingColumnError } from './projectCancelMarker';
import {
  ensureHeBaseAnalyzeQueued,
  prepareHeLateConstructImport,
  SAMPLE_ROWS,
  type HeCollectInfo,
  type HeConstructInfo,
} from './stages/baseCollect';
import type { HeStageContext } from './stages/shared';

/** Адресов в одном раунде — порог «малой» джобы очереди конструктора. */
export const HE_REVALIDATION_BATCH = 200;

/** Сколько ждём раунд, прежде чем закрыть его и отменить джобу (как у V2). */
export const HE_REVALIDATION_WAIT_MS = 6 * 60 * 60 * 1000;

/** Колонка сетки раунда с ключом адреса: вердикт принимается только по своей строке. */
const KEY_HEADER = 'HE Key';
/** Колонка адреса и колонка вердикта, которую пишет validate_emails (`${адрес} Статус`). */
const EMAIL_HEADER = 'Email';
const STATUS_HEADER = 'Email Статус';

/** Вердикты, после которых повторная проба ничего не скажет. */
const TERMINAL_VERDICTS = new Set(['ok', 'invalid', 'disposable', 'catch_all']);
/** Словарь вердиктов шага validate_emails; незнакомое слово читаем как unknown. */
const KNOWN_VERDICTS = new Set(['ok', 'invalid', 'disposable', 'catch_all', 'unknown', 'error']);

/** Тексты he_bases.error роутов отмены (клиент / staff). */
const CANCELLED_BASE_ERRORS = new Set(['Cancelled by user', 'Отменено пользователем']);

/* ───────────────────────────── Состояние ───────────────────────────── */

/** Раунд перепроверки в полёте. */
export interface HeRevalidationRound {
  /** id джобы конструктора — резерв ДО вставки (повтор вставляет тот же id). */
  bc_job_id: string;
  /** Строка джобы точно вставлена; false — вставку повторяет следующий вызов. */
  inserted: boolean;
  /** Адреса раунда (lowercase): по ним разбирается сетка. */
  emails: string[];
  /** Когда раунд поставлен (окно HE_REVALIDATION_WAIT_MS). */
  dispatched_at: string;
  /** Курсор после раунда: строки data[0..end) этим проходом уже отданы. */
  end: number;
}

/** Итог последнего закрытого раунда — для ответа роута и его GET. */
export interface HeRevalidationLast {
  at: string;
  outcome: 'applied' | 'failed';
  bc_job_id: string;
  /** Статус джобы конструктора, с которым раунд закрыт. */
  bc_status?: string;
  /** Адресов в раунде. */
  sent: number;
  /** Вердикты сетки по адресам раунда. */
  verdicts?: Record<string, number>;
  /** Адресов раунда, которых в сетке нет (вердикт строки не менялся). */
  absent?: number;
  /** Строк, у которых вердикт стал 'ok'. */
  recovered?: number;
  /** Почему раунд закрыт без применения (outcome='failed'). */
  error?: string;
}

/** collect_info.revalidation. */
export interface HeRevalidationState {
  /** Курсор прохода по строкам `data` (см. шапку). */
  cursor: number;
  round?: HeRevalidationRound;
  last?: HeRevalidationLast;
}

function readRevalidationState(raw: unknown): HeRevalidationState {
  if (!raw || typeof raw !== 'object') return { cursor: 0 };
  const value = raw as Partial<HeRevalidationState>;
  const cursor = typeof value.cursor === 'number' && Number.isInteger(value.cursor) && value.cursor >= 0 ? value.cursor : 0;
  const round = value.round;
  const validRound =
    round &&
    typeof round === 'object' &&
    typeof round.bc_job_id === 'string' &&
    Array.isArray(round.emails) &&
    typeof round.dispatched_at === 'string' &&
    typeof round.end === 'number'
      ? {
          bc_job_id: round.bc_job_id,
          inserted: round.inserted === true,
          emails: round.emails.filter((e): e is string => typeof e === 'string'),
          dispatched_at: round.dispatched_at,
          end: round.end,
        }
      : undefined;
  return {
    cursor,
    ...(validRound ? { round: validRound } : {}),
    ...(value.last && typeof value.last === 'object' ? { last: value.last } : {}),
  };
}

/* ───────────────────────────── Строки ───────────────────────────── */

/**
 * Адрес строки, который стоит перепроверить, или null. Строка вне вертикали
 * в рассылку не идёт — её пробы не оплачиваем. Несколько адресов в ячейке —
 * вердикт был бы ничей (у ENG-сетки их не бывает: split_emails).
 */
export function heRevalidationAddress(row: Record<string, unknown>): string | null {
  if (row._low_relevance === true) return null;
  const status = typeof row._email_status === 'string' ? row._email_status.trim().toLowerCase() : '';
  if (TERMINAL_VERDICTS.has(status)) return null;
  const emails = extractEmails(String(row.email ?? ''));
  return emails.length === 1 ? emails[0] : null;
}

/** Уникальных адресов-кандидатов в строках начиная с `from`. */
function countCandidates(rows: Array<Record<string, unknown>>, from: number): number {
  const seen = new Set<string>();
  for (let i = Math.max(0, from); i < rows.length; i += 1) {
    const address = heRevalidationAddress(rows[i]);
    if (address) seen.add(address);
  }
  return seen.size;
}

/**
 * Раунд с курсора: до `batch` уникальных адресов-кандидатов. `end` — индекс
 * строки, на которой раунд остановился (следующий кандидат не влез), или конец
 * строк. Чистая функция.
 */
export function pickHeRevalidationRound(
  rows: Array<Record<string, unknown>>,
  cursor: number,
  batch: number = HE_REVALIDATION_BATCH,
): { emails: string[]; end: number; remaining: number } {
  const emails: string[] = [];
  const seen = new Set<string>();
  let i = Math.min(Math.max(0, cursor), rows.length);
  for (; i < rows.length; i += 1) {
    const address = heRevalidationAddress(rows[i]);
    if (!address || seen.has(address)) continue;
    if (emails.length >= batch) break;
    seen.add(address);
    emails.push(address);
  }
  return { emails, end: i, remaining: countCandidates(rows, i) };
}

function revalidationKey(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}

/**
 * Сетка джобы раунда → вердикт по адресу. Строка принимается, только если её
 * адрес из раунда и ключ совпал с адресом. Пустая ячейка вердикта — адрес не
 * проверен (оборванная джоба): вердикта нет. Два разных вердикта одного адреса
 * — unknown. Чистая функция.
 */
export function parseHeRevalidationGrid(grid: unknown, emails: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(grid) || !Array.isArray(grid[0])) return out;
  const header = (grid[0] as unknown[]).map((cell) => String(cell ?? '').trim());
  const emailIdx = header.indexOf(EMAIL_HEADER);
  const keyIdx = header.indexOf(KEY_HEADER);
  const statusIdx = header.indexOf(STATUS_HEADER);
  if (emailIdx < 0 || keyIdx < 0 || statusIdx < 0) return out;
  const expected = new Set(emails);
  const conflicting = new Set<string>();
  for (const raw of grid.slice(1)) {
    if (!Array.isArray(raw)) continue;
    const email = String(raw[emailIdx] ?? '').trim().toLowerCase();
    if (!expected.has(email) || raw[keyIdx] !== revalidationKey(email)) continue;
    const status = String(raw[statusIdx] ?? '').trim().toLowerCase();
    if (!status) continue;
    const verdict = KNOWN_VERDICTS.has(status) ? status : 'unknown';
    if (out.has(email) && out.get(email) !== verdict) conflicting.add(email);
    out.set(email, conflicting.has(email) ? 'unknown' : verdict);
  }
  return out;
}

/**
 * Вердикты раунда → строки. Меняются только строки-кандидаты (см.
 * heRevalidationAddress) с адресом из `verdicts`. Чистая функция.
 */
export function applyHeRevalidationVerdicts(
  rows: Array<Record<string, unknown>>,
  verdicts: Map<string, string>,
  policy: HeLaunchEmailPolicy = {},
): { rows: Array<Record<string, unknown>>; changed: number; recovered: number } {
  let changed = 0;
  let recovered = 0;
  const next = rows.map((row) => {
    const address = heRevalidationAddress(row);
    const verdict = address ? verdicts.get(address) : undefined;
    if (!verdict) return row;
    const before = typeof row._email_status === 'string' ? row._email_status.trim().toLowerCase() : '';
    if (before === verdict) return row;
    changed += 1;
    if (heLaunchEmailVerdict(verdict, policy) === 'accepted') recovered += 1;
    return { ...row, _email_status: verdict };
  });
  return { rows: next, changed, recovered };
}

/** Числа, которые кабинет и журнал читают рядом со строками (как у финала стадии). */
function verdictCounts(rows: Array<Record<string, unknown>>, policy: HeLaunchEmailPolicy = {}): { valid: number; okContacts: number } {
  let valid = 0;
  let okContacts = 0;
  for (const row of rows) {
    if (heLaunchEmailVerdict(row._email_status, policy) !== 'accepted') continue;
    valid += 1;
    if (row._low_relevance !== true) okContacts += 1;
  }
  return { valid, okContacts };
}

/* ───────────────────────────── Чтения ───────────────────────────── */

export type HeRecoveryRefusalCode =
  | 'base_not_found'
  | 'not_auto'
  | 'not_us'
  | 'refill_base'
  | 'research_running'
  | 'project_cancelled'
  | 'cancel_marker_missing'
  | 'base_status'
  | 'base_has_rows'
  | 'no_constructor_job'
  | 'legacy_contract'
  | 'relevance_not_judged'
  | 'collect_job_state'
  | 'constructor_running'
  | 'constructor_not_completed'
  | 'vertical_collecting'
  | 'vertical_ready'
  | 'superseded'
  | 'constructor_empty'
  | 'all_rows_in_other_bases'
  /** Строк не осталось, и главная причина — список Do not contact клиента (§1B). */
  | 'all_rows_do_not_contact'
  | 'launched'
  | 'no_owner'
  | 'raced';

export interface HeRecoveryRefusal {
  code: HeRecoveryRefusalCode;
  /** Текст для сотрудника. */
  message: string;
}

const refuse = (code: HeRecoveryRefusalCode, message: string): HeRecoveryRefusal => ({ code, message });

interface HeRecoveryBase {
  id: string;
  project_id: string;
  vertical_id: string;
  filename: string | null;
  status: string;
  source: string | null;
  error: string | null;
  row_count: number;
  collect_info: HeCollectInfo;
  created_at: string;
  updated_at: string;
}

const BASE_FIELDS =
  'id, project_id, vertical_id, filename, status, source, error, row_count, collect_info, created_at, updated_at';

async function readRecoveryBase(
  supabase: SupabaseClient,
  baseId: string,
  withData: boolean,
): Promise<{ base: HeRecoveryBase; rows: Array<Record<string, unknown>> } | null> {
  const { data, error } = await supabase
    .from('he_bases')
    .select(withData ? `${BASE_FIELDS}, data` : BASE_FIELDS)
    .eq('id', baseId)
    .maybeSingle();
  if (error) throw new Error(`he_bases ${baseId} read: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  const info = row.collect_info && typeof row.collect_info === 'object' ? (row.collect_info as HeCollectInfo) : {};
  return {
    base: {
      id: String(row.id),
      project_id: String(row.project_id),
      vertical_id: String(row.vertical_id),
      filename: typeof row.filename === 'string' ? row.filename : null,
      status: String(row.status ?? ''),
      source: typeof row.source === 'string' ? row.source : null,
      error: typeof row.error === 'string' ? row.error : null,
      row_count: typeof row.row_count === 'number' ? row.row_count : 0,
      collect_info: info,
      created_at: typeof row.created_at === 'string' ? row.created_at : '',
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
    },
    rows: Array.isArray(row.data) ? (row.data as Array<Record<string, unknown>>) : [],
  };
}

interface HeRecoveryProject {
  market: HeMarket;
  status: string;
  createdBy: string | null;
  /** null — проект не отменяли ИЛИ колонки нет (cancelMarker='unsupported'). */
  cancelledAt: string | null;
  /** 'unsupported' — миграция 20261009_0002 не применена: отмену без джоб не видно. */
  cancelMarker: 'read' | 'unsupported';
}

async function readRecoveryProject(supabase: SupabaseClient, projectId: string): Promise<HeRecoveryProject> {
  let cancelMarker: HeRecoveryProject['cancelMarker'] = 'read';
  let res = await supabase
    .from('he_projects')
    .select('market, status, created_by, cancelled_at')
    .eq('id', projectId)
    .maybeSingle();
  if (res.error && isHeMissingColumnError(res.error)) {
    cancelMarker = 'unsupported';
    res = await supabase.from('he_projects').select('market, status, created_by').eq('id', projectId).maybeSingle();
  }
  if (res.error) throw new Error(`he_projects ${projectId} read: ${res.error.message}`);
  if (!res.data) throw new Error(`he_projects ${projectId}: not found`);
  const row = res.data as Record<string, unknown>;
  return {
    market: normalizeHeMarket(row.market),
    status: String(row.status ?? ''),
    createdBy: typeof row.created_by === 'string' && row.created_by ? row.created_by : null,
    cancelledAt: typeof row.cancelled_at === 'string' && row.cancelled_at ? row.cancelled_at : null,
    cancelMarker,
  };
}

function isRefillBase(base: HeRecoveryBase): boolean {
  return base.collect_info.refill === true || (base.filename ?? '').startsWith('auto-refill');
}

/** Отказы, общие для обоих путей. */
function commonRefusal(base: HeRecoveryBase, project: HeRecoveryProject): HeRecoveryRefusal | null {
  if (base.source !== 'auto') return refuse('not_auto', 'База загружена файлом, а не собрана движком — восстанавливать нечего');
  if (project.market !== 'us') {
    return refuse('not_us', 'Только проекты market=us: RU-инструмент этим путём не трогаем');
  }
  if (isRefillBase(base)) {
    return refuse(
      'refill_base',
      'Это прогон ночного долива: его строки уходят в кампанию только самим доливом (бронь дня, гейт писем, ' +
        'отмена, ёмкость). Ручного пути к рассыльщику для них нет',
    );
  }
  if (project.status === 'researching') {
    return refuse('research_running', 'У проекта идёт повторное исследование — вертикали и шаблоны пересоздаются');
  }
  return null;
}

/** У шаблонов базы есть запуск (законченный, незаконченный или идущий). */
async function baseLaunchMarked(supabase: SupabaseClient, baseId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('he_templates')
    .select(HE_TEMPLATE_LAUNCH_MARK_COLUMNS)
    .eq('base_id', baseId);
  if (error) throw new Error(`he_templates launch read: ${error.message}`);
  const now = Date.now();
  return ((data ?? []) as unknown as HeTemplateLaunchMark[]).some((row) => heTemplateLaunchMarked(row, now));
}

interface ConstructorJobRow {
  id: string;
  status: string;
  selected_steps: string[] | null;
  initial_row_count: number | null;
}

async function readConstructorJob(supabase: SupabaseClient, id: string, withData = false) {
  const { data, error } = await supabase
    .from('base_constructor_jobs')
    .select(withData ? 'id, status, selected_steps, initial_row_count, data' : 'id, status, selected_steps, initial_row_count')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs ${id} read: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  const job: ConstructorJobRow & { data?: unknown } = {
    id: String(row.id),
    status: String(row.status ?? ''),
    selected_steps: Array.isArray(row.selected_steps) ? row.selected_steps.map((s) => String(s)) : null,
    initial_row_count: typeof row.initial_row_count === 'number' ? row.initial_row_count : null,
    ...(withData ? { data: row.data } : {}),
  };
  return job;
}

/**
 * Остановить джобу раунда, чей результат никто не применит. Та же запись, что у
 * кнопки «Отменить» конструктора и у cancelAbandonedConstructJob стадии: только
 * поверх pending/processing. Не бросает — несостоявшаяся отмена стоит одного
 * раунда проб впустую.
 */
async function cancelConstructorJob(supabase: SupabaseClient, id: string, log: (m: string) => void): Promise<void> {
  try {
    const { error } = await supabase
      .from('base_constructor_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'processing']);
    if (error) throw new Error(error.message);
  } catch (e) {
    log(`[revalidate] отмена джобы конструктора ${id} не записалась: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ───────────────────────────── Поздний импорт ───────────────────────────── */

/**
 * created_at в микросекундах. Postgres хранит µs, Date.parse — только мс, а
 * граница «моложе» должна совпадать с той, что у автоподъёма (пара
 * (created_at, id) в he_auto_resume_transient_bases). null — не разобрать.
 */
function timestampMicros(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return ms * 1000 + Number(`${fraction}000000`.slice(3, 6));
}

/**
 * Занята ли вертикаль другой базой — те же границы, по которым вторую сборку
 * вертикали не оплачивает никто другой: автоподъём упавших баз
 * (he_auto_resume_transient_bases, 20261009_0002: 'vertical_collecting' /
 * 'vertical_analyzing' / 'vertical_analyzed' / 'superseded'), дочейн
 * автопилота (autopilotNext.afterChainDone: 'base_ready') и реконсилер. Без
 * них поздний импорт заплатил бы второй base_analyze вертикали, у которой
 * анализ уже есть или идёт:
 *  - 'collecting' — любая другая база вертикали (её импорт сверялся бы с нашей
 *    вслепую) → 'vertical_collecting';
 *  - 'analyzing' / 'analyzed' — другая auto-база вертикали, не долив:
 *    сборка вертикали уже удалась (клиент нажал «Collect base» после отказа,
 *    автопилот или реконсилер собрали её заново) → 'vertical_ready'. Долив
 *    «auto-refill: …» не в счёт, как у реконсилера: base_analyze у него нет, а
 *    основная база у запущенной вертикали и так 'analyzed';
 *  - у вертикали есть БОЛЕЕ МОЛОДАЯ не-refill база в любом статусе и из любого
 *    источника (пара (created_at, id), как в SQL автоподъёма) → 'superseded':
 *    клиент уже перезапустил шаг, и поднимать нужно самую свежую попытку, а не
 *    всю их череду.
 * Зовётся и в проверке импорта (её же показывает GET-диагноз), и прямо перед
 * вставкой base_analyze (queueLateImportAnalysis): между проверкой и
 * постановкой клиент мог нажать «Collect base». Сбой чтения — бросок.
 */
async function verticalSiblingRefusal(
  supabase: SupabaseClient,
  base: Pick<HeRecoveryBase, 'id' | 'vertical_id' | 'created_at'>,
): Promise<HeRecoveryRefusal | null> {
  const { data, error } = await supabase
    .from('he_bases')
    .select('id, status, source, filename, created_at, refill:collect_info->>refill')
    .eq('vertical_id', base.vertical_id)
    .neq('id', base.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`he_bases vertical read: ${error.message}`);
  const siblings = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id ?? ''),
    status: String(row.status ?? ''),
    source: typeof row.source === 'string' ? row.source : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    refill:
      row.refill === 'true' || row.refill === true || String(row.filename ?? '').startsWith('auto-refill'),
  }));

  const collecting = siblings.find((s) => s.status === 'collecting');
  if (collecting) {
    return refuse(
      'vertical_collecting',
      `У вертикали идёт другая сборка (база ${collecting.id}) — повторите после неё (её импорт сверится с этой базой)`,
    );
  }
  const ready =
    siblings.find((s) => s.source === 'auto' && !s.refill && s.status === 'analyzing') ??
    siblings.find((s) => s.source === 'auto' && !s.refill && s.status === 'analyzed');
  if (ready) {
    return refuse(
      'vertical_ready',
      `У вертикали уже есть собранная база ${ready.id} ('${ready.status}') — второй анализ вертикали не оплачиваем`,
    );
  }
  // Не разобрать время своей базы или сестры — считаем сестру моложе: лишний
  // отказ бесплатен, лишний импорт стоит анализа.
  const own = timestampMicros(base.created_at);
  const younger = siblings.find((s) => {
    if (s.refill) return false;
    const at = timestampMicros(s.createdAt);
    if (own === null || at === null) return true;
    return at > own || (at === own && s.id > base.id);
  });
  if (younger) {
    return refuse(
      'superseded',
      `У вертикали есть более молодая база ${younger.id} ('${younger.status}') — шаг уже перезапускали, ` +
        'эту попытку не возвращаем',
    );
  }
  return null;
}

interface HeLateImportCheck {
  construct: HeConstructInfo & { bc_job_id: string };
  contactCap: number;
  gridInputRows: number | null;
}

/** Проверки позднего импорта без записей (см. шапку). Сбой чтения — бросок. */
async function checkHeLateImport(
  supabase: SupabaseClient,
  base: HeRecoveryBase,
  project: HeRecoveryProject,
): Promise<{ ok: true; check: HeLateImportCheck } | { ok: false; refusal: HeRecoveryRefusal }> {
  const common = commonRefusal(base, project);
  if (common) return { ok: false, refusal: common };
  if (base.status !== 'failed') {
    const why =
      base.status === 'collecting'
        ? 'сборка ещё идёт — результат конструктора импортирует сама стадия'
        : `у базы статус '${base.status}' — строки у неё уже есть или она не из сборки`;
    return { ok: false, refusal: refuse('base_status', `Поздний импорт только для упавшей базы: ${why}`) };
  }
  if (base.row_count > 0) {
    return { ok: false, refusal: refuse('base_has_rows', 'У упавшей базы уже записаны строки — импорт поверх не делаем') };
  }
  const construct = base.collect_info.construct;
  if (!construct || construct.status !== 'dispatched' || typeof construct.bc_job_id !== 'string' || !construct.bc_job_id) {
    return {
      ok: false,
      refusal: refuse('no_constructor_job', 'Сборка не оставила ожидаемой джобы конструктора — импортировать нечего'),
    };
  }
  const contactCap = heConstructContactCap(base.collect_info);
  if (contactCap === null) {
    return {
      ok: false,
      refusal: refuse('legacy_contract', 'Джобу ставил прежний контракт (без разноса адресов) — запуск её строки не возьмёт'),
    };
  }
  if (base.collect_info.relevance_gate?.ran !== true) {
    return {
      ok: false,
      refusal: refuse(
        'relevance_not_judged',
        'Гейт релевантности до конструктора не отработал: импорт потребовал бы платного суда строк — не делаем',
      ),
    };
  }
  if (base.error && CANCELLED_BASE_ERRORS.has(base.error)) {
    return { ok: false, refusal: refuse('project_cancelled', 'Базу закрыла отмена — её не возвращаем') };
  }
  // Без колонки отметки отмена при нуле активных джоб не оставляет следа, и
  // базу, упавшую до неё, импорт вернул бы — как автоподъём (baseAutoResume.ts
  // без колонки бросает) и ремонт сирот (без неё 'left'), здесь отказ.
  if (project.cancelMarker === 'unsupported') {
    return {
      ok: false,
      refusal: refuse(
        'cancel_marker_missing',
        'Миграция 20261009_0002 (he_projects.cancelled_at) не применена: отмену проекта без активных джоб не видно — ' +
          'упавшую базу не возвращаем, пока её нет',
      ),
    };
  }
  if (project.cancelledAt && Date.parse(project.cancelledAt) >= Date.parse(base.updated_at)) {
    return {
      ok: false,
      refusal: refuse('project_cancelled', `Проект отменён ${project.cancelledAt}, после того как база упала — её не возвращаем`),
    };
  }

  const { data: jobs, error: jobsErr } = await supabase
    .from('he_jobs')
    .select('id, status, created_at')
    .eq('project_id', base.project_id)
    .eq('stage', 'base_collect')
    .eq('payload->>base_id', base.id)
    .order('created_at', { ascending: false });
  if (jobsErr) throw new Error(`he_jobs base_collect read: ${jobsErr.message}`);
  const jobRows = (jobs ?? []) as Array<{ status?: unknown }>;
  if (jobRows.some((j) => j.status === 'pending' || j.status === 'running')) {
    return { ok: false, refusal: refuse('collect_job_state', 'По базе есть живая джоба сборки — она и доведёт импорт') };
  }
  if (jobRows.some((j) => j.status === 'cancelled')) {
    return { ok: false, refusal: refuse('project_cancelled', 'Сборку этой базы отменили — её не возвращаем') };
  }
  if (jobRows.length === 0 || jobRows[0].status !== 'failed') {
    return {
      ok: false,
      refusal: refuse('collect_job_state', 'Последняя джоба сборки базы не упала — это не брошенная сборка'),
    };
  }

  const bc = await readConstructorJob(supabase, construct.bc_job_id);
  if (!bc) {
    return { ok: false, refusal: refuse('constructor_not_completed', `Джобы конструктора ${construct.bc_job_id} нет`) };
  }
  if (bc.status === 'pending' || bc.status === 'processing') {
    return {
      ok: false,
      refusal: refuse('constructor_running', `Джоба конструктора ${bc.id} ещё идёт (${bc.status}) — дождитесь конца`),
    };
  }
  if (bc.status !== 'completed') {
    return {
      ok: false,
      refusal: refuse(
        'constructor_not_completed',
        `Джоба конструктора ${bc.id} закончилась со статусом ${bc.status}: частичную сетку этот путь не берёт`,
      ),
    };
  }
  if (bc.selected_steps && !bc.selected_steps.includes('split_emails')) {
    return {
      ok: false,
      refusal: refuse('legacy_contract', `Джоба конструктора ${bc.id} без split_emails — вердикты не поадресные`),
    };
  }

  const sibling = await verticalSiblingRefusal(supabase, base);
  if (sibling) return { ok: false, refusal: sibling };

  return {
    ok: true,
    check: {
      construct: { ...construct, bc_job_id: construct.bc_job_id },
      contactCap,
      gridInputRows: bc.initial_row_count,
    },
  };
}

/**
 * Что поздний импорт ЗАМЕНИЛ своей записью — то, что нужно вернуть, если
 * анализ ставить нельзя (откат, revertHeLateImport). Лежит в
 * collect_info.construct.late_import_undo и пишется ТОЙ ЖЕ записью, что и
 * импорт: откатить может и повторный вызов. Строк здесь нет: импорт берёт только
 * базу без строк (row_count 0, data и sample_rows пусты —
 * recheckHeLateImportBeforeWrite), и откат возвращает пустые. Харвест задач и
 * flagged_keys гейта, которые импорт снимает (dropCollectWorkState), здесь не
 * хранятся — их возвращает только откат того же вызова (он помнит collect_info
 * целиком); повторный вызов откатывает без них. На отказах, ради которых откат
 * существует (вертикаль занята, проект отменён), их никто не читает:
 * автоподъём такую базу не поднимет по тем же причинам.
 */
export interface HeLateImportUndo {
  /** he_bases.error до импорта. */
  error: string | null;
  /** he_bases.updated_at до импорта — от него считается граница отмены проекта. */
  updated_at: string;
  /** he_bases.columns до импорта. */
  columns: unknown;
  /** collect_info.construct до импорта ('dispatched', без late_import_at). */
  construct: HeConstructInfo;
  /** collect_info.stats до импорта; null — их не было. */
  stats: HeCollectInfo['stats'] | null;
}

/** Состояние базы, в которое её возвращает откат (кроме статуса и пустых строк). */
interface HeLateImportRestore {
  error: string | null;
  updated_at: string;
  columns: unknown;
  collect_info: HeCollectInfo;
}

/** Откат из записи импорта: collect_info текущий, с прежними construct и stats. */
function lateImportRestoreFromUndo(info: HeCollectInfo, undo: HeLateImportUndo): HeLateImportRestore {
  const { construct: _construct, stats: _stats, ...rest } = info;
  return {
    error: undo.error,
    updated_at: undo.updated_at,
    columns: undo.columns,
    collect_info: { ...rest, construct: undo.construct, ...(undo.stats ? { stats: undo.stats } : {}) },
  };
}

/**
 * Откатить запись позднего импорта (см. «ОТКАТ» в шапке): CAS по (id,
 * 'analyzing', updated_at = момент нашей записи) → 'failed' с прежней
 * причиной, прежним updated_at и без строк. 'moved' — базу уже переписал кто-то
 * другой (отмена перевела её в 'failed', base_analyze или перепроверка
 * записали своё): откатывать нечего, их запись главнее. Сбой записи не
 * бросается — его текст вызывающий отдаёт сотруднику (повтор вызова откатит).
 */
async function revertHeLateImport(
  supabase: SupabaseClient,
  baseId: string,
  writtenAt: string,
  restore: HeLateImportRestore,
): Promise<'reverted' | 'moved' | { error: string }> {
  try {
    const { data, error } = await supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: restore.error,
        row_count: 0,
        data: [],
        sample_rows: [],
        columns: restore.columns,
        collect_info: restore.collect_info,
        updated_at: restore.updated_at,
      })
      .eq('id', baseId)
      .eq('status', 'analyzing')
      .eq('updated_at', writtenAt)
      .select('id');
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0 ? 'reverted' : 'moved';
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Отказ постановки анализа ПОСЛЕ записи импорта → откат (revertHeLateImport) и
 * ответ сотруднику. Откат лёг — импорта как не было: 'refused' с причиной
 * отказа. Базу уже переписали — тоже 'refused', с пометкой. Откат не записался —
 * прежний ответ (`kept`) с analysis 'not_queued' и текстом: повторный вызов
 * пойдёт путём «своя запись» и откатит её.
 */
async function undoLateImportAfterRefusal(
  supabase: SupabaseClient,
  args: {
    baseId: string;
    writtenAt: string;
    restore: HeLateImportRestore;
    refusal: HeRecoveryRefusal;
    kept: Extract<HeLateImportOutcome, { kind: 'imported' | 'already_imported' }>;
  },
  log: (m: string) => void,
): Promise<HeLateImportOutcome> {
  const { baseId, refusal } = args;
  const reverted = await revertHeLateImport(supabase, baseId, args.writtenAt, args.restore);
  if (reverted === 'reverted') {
    log(
      `[late_import] база ${baseId}: анализ не ставим (${refusal.message}) — импорт откатан: база снова 'failed' ` +
        'с прежней причиной и без строк, её компании вернулись в пул проекта',
    );
    return {
      kind: 'refused',
      refusal: {
        code: refusal.code,
        message: `${refusal.message} — импорт откатан: база снова 'failed' с прежней причиной, её компании вернулись в пул проекта`,
      },
    };
  }
  if (reverted === 'moved') {
    log(`[late_import] база ${baseId}: анализ не ставим (${refusal.message}); базу уже переписали после импорта — не откатываем`);
    return {
      kind: 'refused',
      refusal: {
        code: refusal.code,
        message: `${refusal.message} — базу уже переписали после импорта (отмена или другой шаг), откатывать нечего`,
      },
    };
  }
  log(`[late_import] база ${baseId}: анализ не ставим (${refusal.message}); откат не записался: ${reverted.error}`);
  return {
    ...args.kept,
    analysis: 'not_queued',
    analysisError:
      `[${refusal.code}] ${refusal.message}; откат импорта не записался (${reverted.error}) — ` +
      "повторите вызов: он вернёт базу в 'failed'",
  };
}

/**
 * Отказ проверки перед вставкой base_analyze: вертикаль занята или проект
 * отменён. Отличается от сбоя чтения (обычный Error): отказ — решение,
 * после которого своя запись импорта откатывается; сбой — повод повторить.
 */
class HeLateImportAnalysisRefused extends Error {
  constructor(readonly refusal: HeRecoveryRefusal) {
    super(`[${refusal.code}] ${refusal.message} — анализ не ставим`);
    this.name = 'HeLateImportAnalysisRefused';
  }
}

/**
 * Последняя проверка ПЕРЕД записью импорта: подготовка (сетка конструктора и
 * `data` всех баз проекта) идёт секунды, и за это время клиент мог нажать
 * «Collect base» или отменить проект. Те же отказы, что у проверки импорта
 * (commonRefusal, отметка отмены, verticalSiblingRefusal), плюс прообраз базы:
 * статус и updated_at те же, что прочитаны (иначе 'raced' — CAS всё равно не
 * лёг бы), и строк у неё нет (откат возвращает пустые строки — это и есть
 * её состояние). Окно до записи сужается до одного запроса; то, что
 * успевает в него, ловит проверка перед постановкой анализа и откат.
 */
async function recheckHeLateImportBeforeWrite(
  supabase: SupabaseClient,
  base: HeRecoveryBase,
): Promise<{ kind: 'ok'; columns: unknown } | { kind: 'refused'; refusal: HeRecoveryRefusal } | { kind: 'raced' }> {
  const project = await readRecoveryProject(supabase, base.project_id);
  const common = commonRefusal(base, project);
  if (common) return { kind: 'refused', refusal: common };
  if (project.cancelMarker === 'unsupported') {
    return {
      kind: 'refused',
      refusal: refuse('cancel_marker_missing', 'Миграция 20261009_0002 (he_projects.cancelled_at) не применена — упавшую базу не возвращаем'),
    };
  }
  if (project.cancelledAt && Date.parse(project.cancelledAt) >= Date.parse(base.updated_at)) {
    return {
      kind: 'refused',
      refusal: refuse('project_cancelled', `Проект отменён ${project.cancelledAt}, после того как база упала — её не возвращаем`),
    };
  }
  const sibling = await verticalSiblingRefusal(supabase, base);
  if (sibling) return { kind: 'refused', refusal: sibling };
  const { data, error } = await supabase
    .from('he_bases')
    .select('status, updated_at, columns, sample_rows, data')
    .eq('id', base.id)
    .maybeSingle();
  if (error) throw new Error(`he_bases ${base.id} pre-write read: ${error.message}`);
  const row = data as Record<string, unknown> | null;
  if (!row || row.status !== 'failed' || row.updated_at !== base.updated_at) return { kind: 'raced' };
  const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;
  if (nonEmpty(row.data) || nonEmpty(row.sample_rows)) {
    return {
      kind: 'refused',
      refusal: refuse('base_has_rows', 'У упавшей базы записаны строки (data/sample_rows) — импорт поверх не делаем'),
    };
  }
  return { kind: 'ok', columns: row.columns ?? [] };
}

export type HeLateImportOutcome =
  | { kind: 'refused'; refusal: HeRecoveryRefusal }
  /** Базу записал кто-то другой между чтением и записью — ничего не записано. */
  | { kind: 'raced' }
  | {
      kind: 'imported' | 'already_imported';
      baseId: string;
      rows: number;
      /** Только у 'imported' — числа импорта. */
      companies?: number;
      validCount?: number;
      droppedInOtherBases?: number;
      droppedOverContactCap?: number;
      droppedOverCompanyCap?: number;
      /** Постановка анализа: 'not_queued' — базу закрыли раньше или вставка упала. */
      analysis: 'enqueued' | 'existing' | 'not_queued';
      analysisError?: string;
    };

/**
 * Постановка анализа после позднего импорта — владение перед вставкой, как у
 * стадии (там assertOwnRunningJob): база всё ещё 'analyzing' (отмена, легшая
 * после нашей записи, переводит её в 'failed') и проект не отменён с момента
 * `failedAt` (отмена, легшая между проверкой и записью, базу в 'failed' не
 * трогала — она уже была 'failed'). И вертикаль не занята другой базой
 * (verticalSiblingRefusal): клиент мог нажать «Collect base» между проверкой и
 * постановкой, а повтор после импорта (`already_imported`) проверки импорта не
 * проходит вовсе — без этого он доставил бы второй анализ вертикали, которую
 * уже собрали заново. Отказ (HeLateImportAnalysisRefused → `refusal`) —
 * анализ не ставится, модель не зовётся, а вызывающий откатывает свою запись
 * импорта (undoLateImportAfterRefusal: база снова 'failed'). Сбой чтения или
 * вставки — 'not_queued' без `refusal`: база остаётся 'analyzing', повтор
 * вызова доставит анализ.
 */
async function queueLateImportAnalysis(
  ctx: HeStageContext,
  base: Pick<HeRecoveryBase, 'id' | 'project_id' | 'vertical_id' | 'created_at'>,
  failedAt: string | null,
): Promise<{
  analysis: 'enqueued' | 'existing' | 'not_queued';
  analysisError?: string;
  /** Отказ проверки (вертикаль занята, проект отменён) — повод откатить свою запись. */
  refusal?: HeRecoveryRefusal;
}> {
  const baseId = base.id;
  try {
    const analysis = await ensureHeBaseAnalyzeQueued(ctx, base.project_id, baseId, async () => {
      const { data, error } = await ctx.supabase.from('he_bases').select('status').eq('id', baseId).maybeSingle();
      if (error) throw new Error(`he_bases ${baseId} status read: ${error.message}`);
      const status = (data as { status?: unknown } | null)?.status;
      if (status !== 'analyzing') throw new Error(`база уже '${String(status ?? 'нет строки')}' — анализ не ставим`);
      if (failedAt) {
        const project = await readRecoveryProject(ctx.supabase, base.project_id);
        if (project.cancelledAt && Date.parse(project.cancelledAt) >= Date.parse(failedAt)) {
          throw new HeLateImportAnalysisRefused(refuse('project_cancelled', `Проект отменён ${project.cancelledAt}`));
        }
      }
      const sibling = await verticalSiblingRefusal(ctx.supabase, base);
      if (sibling) throw new HeLateImportAnalysisRefused(sibling);
    });
    return { analysis };
  } catch (e) {
    return {
      analysis: 'not_queued',
      analysisError: e instanceof Error ? e.message : String(e),
      ...(e instanceof HeLateImportAnalysisRefused ? { refusal: e.refusal } : {}),
    };
  }
}

/** Поздний импорт результата конструктора (см. шапку). Сбой чтения — бросок. */
export async function importHeLateConstructForBase(
  supabase: SupabaseClient,
  baseId: string,
  log: (m: string) => void,
): Promise<HeLateImportOutcome> {
  const read = await readRecoveryBase(supabase, baseId, false);
  if (!read) return { kind: 'refused', refusal: refuse('base_not_found', 'База не найдена') };
  const { base } = read;
  const project = await readRecoveryProject(supabase, base.project_id);
  const ctx: HeStageContext = { supabase, market: 'us', log };

  // Повтор после собственной записи: строки уже наши, второй раз не импортируем —
  // только доставляем анализ, если первая постановка не легла. Граница отмены —
  // момент падения базы до импорта (его хранит late_import_undo); у записи без
  // него — строже, создание базы: отмена проекта после него анализ не ставит.
  // Отказ проверки — откат своей записи (первый вызов мог умереть между
  // записью и постановкой или не записать откат).
  const own = base.collect_info.construct?.late_import_at;
  if (base.status === 'analyzing' && typeof own === 'string' && !commonRefusal(base, project)) {
    const undo = base.collect_info.construct?.late_import_undo ?? null;
    const { refusal, ...queued } = await queueLateImportAnalysis(ctx, base, undo?.updated_at || base.created_at || own);
    const kept = { kind: 'already_imported' as const, baseId: base.id, rows: base.row_count, ...queued };
    if (refusal && undo) {
      return await undoLateImportAfterRefusal(
        supabase,
        {
          baseId: base.id,
          writtenAt: own,
          restore: lateImportRestoreFromUndo(base.collect_info, undo),
          refusal,
          kept,
        },
        log,
      );
    }
    return kept;
  }

  const checked = await checkHeLateImport(supabase, base, project);
  if (!checked.ok) return { kind: 'refused', refusal: checked.refusal };
  const { construct, contactCap, gridInputRows } = checked.check;

  const at = new Date().toISOString();
  const prepared = await prepareHeLateConstructImport(ctx, {
    baseId: base.id,
    projectId: base.project_id,
    info: base.collect_info,
    construct,
    contactCap,
    gridInputRows,
    at,
  });
  if (prepared.kind === 'empty') {
    return {
      kind: 'refused',
      refusal: refuse('constructor_empty', `Джоба конструктора ${construct.bc_job_id} вернула пустую сетку — импортировать нечего`),
    };
  }
  if (prepared.kind === 'all_in_other_bases') {
    return {
      kind: 'refused',
      refusal: refuse(
        'all_rows_in_other_bases',
        `Все ${prepared.gridRows} строк сетки — домены или адреса, которые уже лежат в других базах проекта`,
      ),
    };
  }
  // Тот же отказ, что выше, но главная причина — список Do not contact клиента
  // (§1B плана docs/handoff/2026-10-16-eng-countries): снято по нему не меньше,
  // чем по другим базам. Импортировать нечего, база остаётся как есть.
  if (prepared.kind === 'all_do_not_contact') {
    return {
      kind: 'refused',
      refusal: refuse(
        'all_rows_do_not_contact',
        `Все ${prepared.gridRows} строк сетки сняты: ${prepared.droppedDoNotContact} — домены в списке Do not contact ` +
          'клиента, остальные уже лежат в других базах проекта',
      ),
    };
  }

  // Вертикаль и отмена — ещё раз, прямо перед записью (подготовка шла секунды).
  const pre = await recheckHeLateImportBeforeWrite(supabase, base);
  if (pre.kind === 'refused') return { kind: 'refused', refusal: pre.refusal };
  if (pre.kind === 'raced') return { kind: 'raced' };
  const undo: HeLateImportUndo = {
    error: base.error,
    updated_at: base.updated_at,
    columns: pre.columns,
    construct,
    stats: base.collect_info.stats ?? null,
  };
  const importedInfo: HeCollectInfo = {
    ...prepared.patch.collect_info,
    construct: { ...(prepared.patch.collect_info.construct as HeConstructInfo), late_import_undo: undo },
  };
  const { data: written, error: writeErr } = await supabase
    .from('he_bases')
    .update({ ...prepared.patch, collect_info: importedInfo, status: 'analyzing', error: null, updated_at: at })
    .eq('id', base.id)
    .eq('status', 'failed')
    .eq('updated_at', base.updated_at)
    .select('id');
  if (writeErr) throw new Error(`he_bases ${base.id} late import write: ${writeErr.message}`);
  if ((written ?? []).length === 0) return { kind: 'raced' };
  log(
    `[late_import] база ${base.id}: принята сетка джобы ${construct.bc_job_id} — ${prepared.patch.row_count} строк, ` +
      `${prepared.companies} компаний, валидных ${prepared.validCount}; снято как уже лежащие в других базах ` +
      `${prepared.droppedInOtherBases}, сверх капа адресов ${prepared.droppedOverContactCap}, ` +
      `сверх лимита компаний ${prepared.droppedOverCompanyCap}`,
  );

  const { refusal, ...queued } = await queueLateImportAnalysis(ctx, base, base.updated_at || null);
  const kept = {
    kind: 'imported' as const,
    baseId: base.id,
    rows: prepared.patch.row_count,
    companies: prepared.companies,
    validCount: prepared.validCount,
    droppedInOtherBases: prepared.droppedInOtherBases,
    droppedOverContactCap: prepared.droppedOverContactCap,
    droppedOverCompanyCap: prepared.droppedOverCompanyCap,
    ...queued,
  };
  if (!refusal) return kept;
  // Клиент успел между проверкой и постановкой: откатываем свою запись, вернув
  // базу ровно какой она была (collect_info целиком — с харвестом, если был).
  return await undoLateImportAfterRefusal(
    supabase,
    {
      baseId: base.id,
      writtenAt: at,
      restore: { error: base.error, updated_at: base.updated_at, columns: pre.columns, collect_info: base.collect_info },
      refusal,
      kept,
    },
    log,
  );
}

/* ───────────────────────────── Перепроверка ───────────────────────────── */

/** Проверки ПОСТАНОВКИ раунда (применение готового раунда их не требует). */
async function checkHeRevalidationStart(
  supabase: SupabaseClient,
  base: HeRecoveryBase,
  project: HeRecoveryProject,
): Promise<HeRecoveryRefusal | null> {
  const common = commonRefusal(base, project);
  if (common) return common;
  if (base.status !== 'analyzed' && base.status !== 'analyzing') {
    return refuse('base_status', `Перепроверка только у собранной базы (analyzing/analyzed), а у этой '${base.status}'`);
  }
  if (heConstructContactCap(base.collect_info) === null) {
    return refuse('legacy_contract', 'База собрана прежним контрактом (без разноса адресов) — запуск её строки не возьмёт');
  }
  if (!project.createdBy) return refuse('no_owner', 'У проекта нет владельца — джобе конструктора некому принадлежать');
  if (await baseLaunchMarked(supabase, base.id)) {
    return refuse(
      'launched',
      'У шаблона этой базы есть запуск: перепроверенные адреса никто не дошлёт — пробы были бы впустую',
    );
  }
  return null;
}

export interface HeRevalidationRoundView {
  bc_job_id: string;
  emails: number;
  dispatched_at: string;
  /** Статус джобы конструктора на момент ответа. */
  bc_status: string;
}

export type HeRevalidationOutcome =
  | { kind: 'refused'; refusal: HeRecoveryRefusal }
  | { kind: 'raced' }
  | {
      kind: 'advanced';
      /** Раунд, закрытый этим вызовом (применён или закрыт с причиной). */
      closed: HeRevalidationLast | null;
      /** Раунд в полёте после вызова (только что поставлен или ещё идёт). */
      round: HeRevalidationRoundView | null;
      /** Кандидатов прохода после курсора (без раунда в полёте). */
      remaining: number;
      /** Проход закончен: всё непроверенное на его старте уже отдано. */
      pass_complete: boolean;
      /** Почему новый раунд не поставлен. */
      start_refused?: HeRecoveryRefusal;
    };

async function writeRevalidation(
  supabase: SupabaseClient,
  base: HeRecoveryBase,
  seenUpdatedAt: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const at = new Date().toISOString();
  const { data, error } = await supabase
    .from('he_bases')
    .update({ ...patch, updated_at: at })
    .eq('id', base.id)
    .in('status', ['analyzing', 'analyzed'])
    .eq('updated_at', seenUpdatedAt)
    .select('id');
  if (error) throw new Error(`he_bases ${base.id} revalidation write: ${error.message}`);
  return (data ?? []).length > 0 ? at : null;
}

/** Один шаг перепроверки (см. шапку). Сбой чтения или вставки — бросок. */
export async function advanceHeBaseRevalidation(
  supabase: SupabaseClient,
  baseId: string,
  options: { restart?: boolean },
  log: (m: string) => void,
): Promise<HeRevalidationOutcome> {
  const read = await readRecoveryBase(supabase, baseId, true);
  if (!read) return { kind: 'refused', refusal: refuse('base_not_found', 'База не найдена') };
  const { base } = read;
  let rows = read.rows;
  const project = await readRecoveryProject(supabase, base.project_id);
  const common = commonRefusal(base, project);
  if (common) return { kind: 'refused', refusal: common };
  const allowCatchAll = await readHeEngEmailPolicy(supabase, { market: project.market, created_by: project.createdBy });

  let info: HeCollectInfo = base.collect_info;
  let state = readRevalidationState(info.revalidation);
  let seen = base.updated_at;

  if (base.status !== 'analyzed' && base.status !== 'analyzing') {
    // База закрыта (отмена, сбой анализа): раунд, если он в полёте, больше никто
    // не применит — останавливаем его джобу. Состояние не пишем: эта база
    // перепроверку больше не принимает.
    if (state.round?.inserted) await cancelConstructorJob(supabase, state.round.bc_job_id, log);
    return {
      kind: 'refused',
      refusal: refuse('base_status', `Перепроверка только у собранной базы (analyzing/analyzed), а у этой '${base.status}'`),
    };
  }

  let closed: HeRevalidationLast | null = null;
  const round = state.round;
  if (round) {
    if (!round.inserted) {
      // Резерв без подтверждённой вставки: повторяем ТУ ЖЕ вставку — но только
      // если раунд ещё кому-то нужен.
      const refusal = await checkHeRevalidationStart(supabase, base, project);
      if (refusal) {
        closed = {
          at: new Date().toISOString(),
          outcome: 'failed',
          bc_job_id: round.bc_job_id,
          sent: round.emails.length,
          error: refusal.message,
        };
        const next: HeRevalidationState = { cursor: state.cursor, last: closed };
        const written = await writeRevalidation(supabase, base, seen, { collect_info: { ...info, revalidation: next } });
        if (!written) return { kind: 'raced' };
        await cancelConstructorJob(supabase, round.bc_job_id, log);
        return {
          kind: 'advanced',
          closed,
          round: null,
          remaining: countCandidates(rows, state.cursor),
          pass_complete: false,
          start_refused: refusal,
        };
      }
      await insertRevalidationJob(supabase, base, project, round);
      await markRoundInserted(supabase, base, info, state, seen);
      return {
        kind: 'advanced',
        closed: null,
        round: { bc_job_id: round.bc_job_id, emails: round.emails.length, dispatched_at: round.dispatched_at, bc_status: 'pending' },
        remaining: countCandidates(rows, round.end),
        pass_complete: false,
      };
    }

    const child = await readConstructorJob(supabase, round.bc_job_id, true);
    const validOnly =
      child?.selected_steps?.length === 1 && child.selected_steps[0] === 'validate_emails';
    if (child && validOnly && (child.status === 'pending' || child.status === 'processing')) {
      const started = Date.parse(round.dispatched_at);
      if (Number.isFinite(started) && Date.now() - started <= HE_REVALIDATION_WAIT_MS) {
        return {
          kind: 'advanced',
          closed: null,
          round: { bc_job_id: round.bc_job_id, emails: round.emails.length, dispatched_at: round.dispatched_at, bc_status: child.status },
          remaining: countCandidates(rows, round.end),
          pass_complete: false,
        };
      }
      // Окно вышло: раунд закрываем, джобу отменяем. Курсор не двигаем — адреса
      // раунда остаются в проходе, следующий вызов поставит их заново.
      closed = {
        at: new Date().toISOString(),
        outcome: 'failed',
        bc_job_id: round.bc_job_id,
        bc_status: child.status,
        sent: round.emails.length,
        error: `джоба конструктора не закончилась за ${HE_REVALIDATION_WAIT_MS / 3_600_000} ч — отменена`,
      };
      const next: HeRevalidationState = { cursor: state.cursor, last: closed };
      const written = await writeRevalidation(supabase, base, seen, { collect_info: { ...info, revalidation: next } });
      if (!written) return { kind: 'raced' };
      await cancelConstructorJob(supabase, round.bc_job_id, log);
      // Новый раунд сразу не ставим: очередь конструктора стоит, и сотрудник
      // должен это увидеть, прежде чем отдать ей ещё адреса.
      return {
        kind: 'advanced',
        closed,
        round: null,
        remaining: countCandidates(rows, state.cursor),
        pass_complete: false,
      };
    }

    if (!child || !validOnly) {
      closed = {
        at: new Date().toISOString(),
        outcome: 'failed',
        bc_job_id: round.bc_job_id,
        ...(child ? { bc_status: child.status } : {}),
        sent: round.emails.length,
        error: child ? 'строка джобы не похожа на перепроверку (шаги не validate_emails)' : 'строки джобы конструктора нет',
      };
      state = { cursor: state.cursor, last: closed };
    } else {
      // Джоба закончилась (completed / failed / cancelled / иной статус): берём
      // то, что в сетке есть.
      const verdicts = parseHeRevalidationGrid(child.data, round.emails);
      const applied = applyHeRevalidationVerdicts(rows, verdicts, { allowCatchAll });
      rows = applied.rows;
      const tally: Record<string, number> = {};
      for (const verdict of verdicts.values()) tally[verdict] = (tally[verdict] ?? 0) + 1;
      closed = {
        at: new Date().toISOString(),
        outcome: 'applied',
        bc_job_id: round.bc_job_id,
        bc_status: child.status,
        sent: round.emails.length,
        verdicts: tally,
        absent: round.emails.length - verdicts.size,
        recovered: applied.recovered,
      };
      // Курсор двигается только за ЗАКОНЧЕННЫМ раундом: у оборванной джобы
      // часть адресов не проверена, и следующий раунд возьмёт их снова (адреса,
      // уже получившие окончательный вердикт, кандидатами быть перестали).
      state = { cursor: child.status === 'completed' ? round.end : state.cursor, last: closed };
      const counts = verdictCounts(rows, { allowCatchAll });
      info = {
        ...info,
        ...(info.construct ? { construct: { ...info.construct, valid_count: counts.valid } } : {}),
        ...(info.stats ? { stats: { ...info.stats, ok_contacts: counts.okContacts } } : {}),
      };
      log(
        `[revalidate] база ${base.id}: раунд ${round.bc_job_id} (${child.status}) — адресов ${round.emails.length}, ` +
          `вердиктов ${verdicts.size}, изменено строк ${applied.changed}, допущено ${applied.recovered}; ` +
          `валидных в базе ${counts.valid}`,
      );
    }
    const patch: Record<string, unknown> = { collect_info: { ...info, revalidation: state } };
    if (closed.outcome === 'applied') {
      patch.data = rows;
      patch.sample_rows = rows.slice(0, SAMPLE_ROWS);
    }
    const written = await writeRevalidation(supabase, base, seen, patch);
    if (!written) return { kind: 'raced' };
    seen = written;
    info = patch.collect_info as HeCollectInfo;
  }

  // ─── Постановка следующего раунда ───
  const cursor = options.restart ? 0 : state.cursor;
  const refusal = await checkHeRevalidationStart(supabase, base, project);
  if (refusal) {
    return {
      kind: 'advanced',
      closed,
      round: null,
      remaining: countCandidates(rows, cursor),
      pass_complete: false,
      start_refused: refusal,
    };
  }
  const pick = pickHeRevalidationRound(rows, cursor);
  if (pick.emails.length === 0) {
    return { kind: 'advanced', closed, round: null, remaining: 0, pass_complete: true };
  }
  const nextRound: HeRevalidationRound = {
    bc_job_id: randomUUID(),
    inserted: false,
    emails: pick.emails,
    dispatched_at: new Date().toISOString(),
    end: pick.end,
  };
  const reserved: HeRevalidationState = { cursor, round: nextRound, ...(state.last ? { last: state.last } : {}) };
  // Резерв id — ДО вставки: потерянный ответ на вставку повторяется тем же id,
  // второй джобы на те же адреса не бывает.
  const reservedAt = await writeRevalidation(supabase, base, seen, { collect_info: { ...info, revalidation: reserved } });
  if (!reservedAt) {
    return {
      kind: 'advanced',
      closed,
      round: null,
      remaining: countCandidates(rows, cursor),
      pass_complete: false,
      start_refused: refuse('raced', 'Базу записали между чтением и постановкой раунда — повторите вызов'),
    };
  }
  await insertRevalidationJob(supabase, base, project, nextRound);
  await markRoundInserted(supabase, base, info, reserved, reservedAt);
  log(`[revalidate] база ${base.id}: поставлен раунд ${nextRound.bc_job_id} на ${pick.emails.length} адресов`);
  return {
    kind: 'advanced',
    closed,
    round: {
      bc_job_id: nextRound.bc_job_id,
      emails: pick.emails.length,
      dispatched_at: nextRound.dispatched_at,
      bc_status: 'pending',
    },
    remaining: pick.remaining,
    pass_complete: false,
  };
}

/**
 * Вставка джобы раунда: upsert по зарезервированному id без перезаписи
 * существующей строки (как dispatchConstructJob стадии). workload_origin
 * 'automation' — как у джоб стадии: ручной лимит сотрудника она не занимает.
 */
async function insertRevalidationJob(
  supabase: SupabaseClient,
  base: HeRecoveryBase,
  project: HeRecoveryProject,
  round: HeRevalidationRound,
): Promise<void> {
  if (!project.createdBy) throw new Error('he_projects.created_by пуст — джобе конструктора некому принадлежать');
  const { error } = await supabase.from('base_constructor_jobs').upsert(
    {
      id: round.bc_job_id,
      user_id: project.createdBy,
      workload_origin: 'automation',
      file_name: `HE · перепроверка адресов · ${base.filename ?? base.id}`,
      status: 'pending',
      locale: 'en',
      selected_steps: ['validate_emails'],
      step_config: {},
      data: [[EMAIL_HEADER, KEY_HEADER], ...round.emails.map((email) => [email, revalidationKey(email)])],
      initial_row_count: round.emails.length,
      total_steps: 1,
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (error) throw new Error(`base_constructor_jobs insert: ${error.message}`);
}

/** Отметка «строка джобы вставлена». Потеря бесплатна: следующий вызов повторит тот же upsert. */
async function markRoundInserted(
  supabase: SupabaseClient,
  base: HeRecoveryBase,
  info: HeCollectInfo,
  state: HeRevalidationState,
  seenUpdatedAt: string,
): Promise<void> {
  if (!state.round) return;
  const next: HeRevalidationState = { ...state, round: { ...state.round, inserted: true } };
  try {
    await writeRevalidation(supabase, base, seenUpdatedAt, { collect_info: { ...info, revalidation: next } });
  } catch {
    // См. докблок: следующий вызов увидит inserted=false и повторит upsert.
  }
}

/* ───────────────────────────── Диагноз (GET) ───────────────────────────── */

export interface HeBaseRecoveryDiagnosis {
  base: { id: string; status: string; source: string | null; market: HeMarket; refill: boolean; row_count: number };
  late_import: { available: true } | { available: false; refusal: HeRecoveryRefusal };
  revalidation: {
    start: { available: true } | { available: false; refusal: HeRecoveryRefusal };
    /** Строк-кандидатов во всей базе (уникальных адресов). */
    unverified_addresses: number;
    /** Кандидатов после курсора прохода. */
    remaining_in_pass: number;
    round: HeRevalidationRound | null;
    last: HeRevalidationLast | null;
  };
  /** 'unsupported' — без миграции 20261009_0002 отмену проекта без джоб не видно. */
  cancel_marker: 'read' | 'unsupported';
}

/** Что можно восстановить у базы — без записей. */
export async function diagnoseHeBaseRecovery(
  supabase: SupabaseClient,
  baseId: string,
): Promise<HeBaseRecoveryDiagnosis | null> {
  const read = await readRecoveryBase(supabase, baseId, true);
  if (!read) return null;
  const { base, rows } = read;
  const project = await readRecoveryProject(supabase, base.project_id);
  const late = await checkHeLateImport(supabase, base, project);
  const startRefusal = await checkHeRevalidationStart(supabase, base, project);
  const state = readRevalidationState(base.collect_info.revalidation);
  return {
    base: {
      id: base.id,
      status: base.status,
      source: base.source,
      market: project.market,
      refill: isRefillBase(base),
      row_count: base.row_count,
    },
    late_import: late.ok ? { available: true } : { available: false, refusal: late.refusal },
    revalidation: {
      start: startRefusal ? { available: false, refusal: startRefusal } : { available: true },
      unverified_addresses: countCandidates(rows, 0),
      remaining_in_pass: countCandidates(rows, state.round ? state.round.end : state.cursor),
      round: state.round ?? null,
      last: state.last ?? null,
    },
    cancel_marker: project.cancelMarker,
  };
}
