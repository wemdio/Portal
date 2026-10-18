import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadHeProjectDetail } from '@/lib/hypothesisEngine/projectDetail';
import {
  toClientEngProjectDetail,
  toClientEngProjectRow,
  toClientEngStageErrorCode,
} from '@/lib/hypothesisEngine/clientEngProjection';
import {
  HE_RESEARCH_STALL_GRACE_MS,
  engResearchRetryVerdict,
  readLatestHeResearchJob,
} from '@/lib/hypothesisEngine/researchJob';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { isAnalyzingBaseLive, liveBaseIdsFromJobs } from '@/lib/hypothesisEngine/autopilotNext';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import {
  OFFER_OVERRIDE_MAX_LENGTH,
  heCollectCountriesBroadened,
  patchHeProjectBrief,
  resumeHeDryVerticalsAfterCountriesBroadened,
  type HeBriefField,
  type HeBriefPatchBody,
  type HeBriefPatchClientFields,
} from '@/lib/hypothesisEngine/projectBriefPatch';
import {
  heCollectCountriesErrorText,
  parseHeCollectCountries,
  readHeCollectCountries,
} from '@/lib/hypothesisEngine/engCountries';
import { heEngCollectCountriesEnabled } from '@/lib/hypothesisEngine/engRolloutFlags';
import { resumeHeVerticalNightlyRefill } from '@/lib/hypothesisEngine/autoPipeline';
import {
  heIcpFrameInputErrorText,
  parseHeIcpFramePatch,
  type HeIcpFramePatch,
} from '@/lib/hypothesisEngine/icpFrame';
import {
  HE_MAX_EMAILS_PER_COMPANY_MAX,
  HE_MAX_EMAILS_PER_COMPANY_MIN,
  normalizeHeMaxEmailsPerCompany,
} from '@/lib/hypothesisEngine/baseCollectEnqueue';
import { readHeEngAutoLaunchDetail } from '@/lib/hypothesisEngine/engAutoLaunch';
import { readHeEngTypicalDurations } from '@/lib/hypothesisEngine/engEstimates';
import { readHeEngSendingAccess } from '@/lib/hypothesisEngine/engSendingAccess';
import { readHeEngCollectionProgress } from '@/lib/hypothesisEngine/engCollectionProgress';
import { heBrandNeedsOwner, readHeBrandEngClient } from '@/lib/hypothesisEngine/letterBrandGuard';
import { heTeamFixableFailureOf } from '@/lib/hypothesisEngine/clientErrors';
import {
  ENG_TEAM_FIX_STAGES,
  engLatestFailedStageJobs,
  type EngTeamFixStop,
} from '@/lib/hypothesisEngine/engDashboard';
import { engServerError } from '../../_shared';

export const dynamic = 'force-dynamic';

/** Сколько закончившихся прогонов стадий рынков читает признак «чинит команда». */
const TEAM_FIX_JOBS_LIMIT = 500;

/**
 * Остановки стадий рынков проекта отказом, который чинит команда
 * (EngTeamFixStop): по каждой цели (рынок у писем, база у проверки и итоговых
 * писем) последний закончившийся прогон, и только если он упал отказом
 * heTeamFixableFailureOf ('billing' / 'configuration') — тот же предикат, по
 * которому письмо об остановке советует 'team_fix', а воркер шлёт алерт
 * команде. Наружу — только вид; текст ошибки не уходит. Два лёгких чтения:
 * закончившиеся прогоны без ошибки, затем ошибки только упавших последних
 * (обычно их нет — второго чтения нет). null — не прочиталось (ключа в ответе
 * нет, экран зовёт к кнопке, как раньше). Прогоны старше
 * TEAM_FIX_JOBS_LIMIT свежих не видны — у такой цели признака нет.
 */
async function readTeamFixStops(projectId: string): Promise<EngTeamFixStop[] | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('he_jobs')
      .select('id, stage, status, created_at, payload')
      .eq('project_id', projectId)
      .in('stage', [...ENG_TEAM_FIX_STAGES])
      .in('status', ['done', 'failed', 'cancelled'])
      .order('created_at', { ascending: false })
      .limit(TEAM_FIX_JOBS_LIMIT);
    if (error) return null;
    const failed = engLatestFailedStageJobs((data ?? []) as Array<Record<string, unknown>>);
    if (failed.length === 0) return [];
    const { data: errors, error: errorsErr } = await supabaseAdmin
      .from('he_jobs')
      .select('id, error')
      .in('id', failed.map((f) => f.id));
    if (errorsErr) return null;
    const errorById = new Map<string, unknown>();
    for (const row of (errors ?? []) as Array<{ id?: unknown; error?: unknown }>) {
      if (typeof row.id === 'string') errorById.set(row.id, row.error);
    }
    const stops: EngTeamFixStop[] = [];
    for (const f of failed) {
      const kind = heTeamFixableFailureOf(errorById.get(f.id));
      if (kind) stops.push({ stage: f.stage, vertical_id: f.vertical_id, base_id: f.base_id, kind });
    }
    return stops;
  } catch {
    return null;
  }
}

type DetailRow = Record<string, unknown>;

/** Итог ночного добора рынка в деталке: успешных прогонов и принятых адресов. */
interface EngRefillTotal {
  vertical_id: string;
  runs: number;
  added: number;
}

/**
 * ЗАКОНЧЕННЫЕ ПРОГОНЫ НОЧНОГО ДОБОРА — в кабинет не базами, а итогом на рынок.
 *
 * Каждая ночь добора — своя строка he_bases («auto-refill: …»), и общий со
 * staff загрузчик деталки (loadHeProjectDetail) отдаёт их все: ответ, который
 * мастер опрашивает раз в 4–30 с, рос на строку за ночь. Базами на экране их
 * нет давно (карточка рынка шага 3 берёт базу шаблона или последнюю свою
 * авто-базу, isOwnAutoBase), поэтому в ответе их тоже нет — вместо них по
 * рынку `refill_totals`:
 *  - `runs` — прогоны, которые ДОРАБОТАЛИ: `collect_info.refill_result.status`
 *    'appended' или 'no_new' (stages/baseCollectRefill.ts). Прогон 'failed'
 *    (наш сбой или сбой провайдера, нет места у рассыльщика, дневной бюджет
 *    занят, отмена клиентом) или без итога долива — не «добор, который
 *    ничего не нашёл», и в `runs` не идёт: иначе кабинет писал бы
 *    «N top-ups so far, no new contacts added yet» после ночей нашего сбоя
 *    (решение владельца 04.10.2026 — свой сбой клиенту не выдаётся за рынок).
 *    По той же причине не идёт и 'no_new', у которого упала хоть одна задача
 *    сборки (`collect_info.stats.tasks_failed` > 0): сборка пишет 'no_new' и
 *    тогда, когда строк нет потому, что источник не прочитался (ошибка чтения
 *    каталога, упавшая дочерняя сборка карт, «timeout:» ожидания), — это
 *    ночь нашего сбоя, а не рынок без новых компаний. Обе записи 'no_new'
 *    (completeHeRefillNoNew и долив без допущенных адресов) кладут рядом
 *    `stats` той же сборки; нет `stats` или поля — упавших задач не было;
 *  - `added` — адреса, принятые рассыльщиком, у ЛЮБОГО прогона (сумма
 *    `refill_result.stats.appended`; нет числа — 0): упавший прогон мог
 *    успеть отдать часть строк, и они уже в кампаниях рынка.
 * Рынок, у которого нет ни доработавшего прогона, ни принятого адреса, итога
 * не получает (ключа нет — строки на карточке нет).
 * Загрузчик staff не тронут: выдача /api/tools/hypothesis-engine прежняя.
 *
 * Остаются базами:
 *  - идущий прогон ('collecting' / 'analyzing') — по нему мастер держит
 *    частый опрос и кнопку «Cancel all jobs» (EngProjectWizard);
 *  - прогон, на котором построен шаблон (шаблоны до 0c802b2a4): карточка рынка
 *    и признак переписки писем ищут базу шаблона по id;
 *  - прогон рынка без единого шаблона в ответе: без него «рынок начат»
 *    (heEngMarketStarted) прочитался бы иначе. Добор бывает только у
 *    запущенного рынка, так что это оборона, а не путь.
 * Признак прогона — `refill` проекции (isHeRefillBaseRow: флаг постановки или
 * имя «auto-refill»), статус — тот же, что у базы.
 */
function foldFinishedRefillBases(
  bases: DetailRow[],
  rawBases: unknown[],
  templates: DetailRow[],
): { bases: DetailRow[]; totals: EngRefillTotal[] } {
  const templateBaseIds = new Set<string>();
  const verticalsWithTemplate = new Set<string>();
  for (const t of templates) {
    if (typeof t.base_id === 'string') templateBaseIds.add(t.base_id);
    if (typeof t.vertical_id === 'string') verticalsWithTemplate.add(t.vertical_id);
  }
  const appendedById = new Map<string, number>();
  const finishedIds = new Set<string>();
  for (const raw of rawBases) {
    const row = raw && typeof raw === 'object' ? (raw as DetailRow) : null;
    if (!row || typeof row.id !== 'string') continue;
    const info = row.collect_info && typeof row.collect_info === 'object' ? (row.collect_info as DetailRow) : null;
    const result = info?.refill_result && typeof info.refill_result === 'object' ? (info.refill_result as DetailRow) : null;
    const collectStats = info?.stats && typeof info.stats === 'object' ? (info.stats as DetailRow) : null;
    const tasksFailed = collectStats?.tasks_failed;
    const sourceFailed = typeof tasksFailed === 'number' && tasksFailed > 0;
    if (result?.status === 'appended' || (result?.status === 'no_new' && !sourceFailed)) finishedIds.add(row.id);
    const stats = result?.stats && typeof result.stats === 'object' ? (result.stats as DetailRow) : null;
    const appended = stats?.appended;
    if (typeof appended === 'number' && Number.isFinite(appended) && appended > 0) {
      appendedById.set(row.id, Math.floor(appended));
    }
  }
  const kept: DetailRow[] = [];
  const totals = new Map<string, EngRefillTotal>();
  for (const base of bases) {
    const id = typeof base.id === 'string' ? base.id : '';
    const verticalId = typeof base.vertical_id === 'string' ? base.vertical_id : '';
    const fold =
      base.refill === true &&
      base.status !== 'collecting' &&
      base.status !== 'analyzing' &&
      id !== '' &&
      !templateBaseIds.has(id) &&
      verticalId !== '' &&
      verticalsWithTemplate.has(verticalId);
    if (!fold) {
      kept.push(base);
      continue;
    }
    const total = totals.get(verticalId) ?? { vertical_id: verticalId, runs: 0, added: 0 };
    if (finishedIds.has(id)) total.runs += 1;
    total.added += appendedById.get(id) ?? 0;
    totals.set(verticalId, total);
  }
  return { bases: kept, totals: [...totals.values()].filter((t) => t.runs > 0 || t.added > 0) };
}

/**
 * Примерный срок отправки запущенного рынка (`launch_info.run_days`,
 * engClientLaunch.recordHeEngRunDays) — в запись о запуске шаблона ответа.
 * Проекция записи (toClientEngLaunchInfo) его не пропускает, поэтому поле
 * добавляется здесь, из сырой записи, и только пока срок посчитан для того же
 * числа адресов, что в записи (`run_days_leads` = `leads_count`): срок другой
 * попытки над другим числом адресов не всплывает. Целое ≥ 1, иначе поля нет.
 */
function withRunDays(templates: DetailRow[], rawTemplates: unknown[]): DetailRow[] {
  const runDaysById = new Map<string, number>();
  for (const raw of rawTemplates) {
    const row = raw && typeof raw === 'object' ? (raw as DetailRow) : null;
    const info = row?.launch_info && typeof row.launch_info === 'object' ? (row.launch_info as DetailRow) : null;
    if (!row || !info || typeof row.id !== 'string') continue;
    const days = info.run_days;
    if (
      typeof days === 'number' &&
      Number.isInteger(days) &&
      days >= 1 &&
      typeof info.leads_count === 'number' &&
      info.run_days_leads === info.leads_count
    ) {
      runDaysById.set(row.id, days);
    }
  }
  if (runDaysById.size === 0) return templates;
  return templates.map((t) => {
    const days = typeof t.id === 'string' ? runDaysById.get(t.id) : undefined;
    const info = t.launch_info;
    if (days === undefined || !info || typeof info !== 'object') return t;
    return { ...t, launch_info: { ...(info as DetailRow), run_days: days } };
  });
}

/** Поля брифа в тексте отказа 413 — как их подписывает шаг 1 кабинета (EngStepBrief). */
const BRIEF_FIELD_LABELS: Record<HeBriefField, string> = {
  business_override: 'Business description',
  offer_override: 'Offer',
  style_override: 'Style reference',
  signature_override: 'Sender signature',
};

const PROJECT_LOAD_FAILED = 'Failed to load the project';
const BRIEF_SAVE_FAILED = 'Failed to save the brief';
const SETTING_SAVE_FAILED = 'Failed to save the project setting';

/**
 * Тело PATCH: поля брифа (общие со staff), рамка ЦА клиента (`icp`, из
 * PATCH-роутов только этот) и настройка проекта «до N адресов одной компании». Значения
 * приходят `unknown` — проверяют их нормализаторы, а не тип запроса.
 */
type EngProjectPatchBody = HeBriefPatchBody & {
  max_emails_per_company?: unknown;
  icp?: unknown;
  collect_countries?: unknown;
};

/**
 * Единственный текст отказа по значению настройки. Границы подставляются из
 * констант движка (`baseCollectEnqueue`), а не переписываются цифрами: они же
 * стоят в check-ограничениях миграции 20260926_0001, и расхождение текста с
 * проверкой — это ложь клиенту.
 */
const CONTACT_CAP_RANGE =
  `max_emails_per_company must be a whole number from ${HE_MAX_EMAILS_PER_COMPANY_MIN}`
  + ` to ${HE_MAX_EMAILS_PER_COMPANY_MAX}, or null to use the default`;

const NO_FIELDS =
  'Provide offer_override, style_override, signature_override, business_override, icp, collect_countries'
  + ' or max_emails_per_company';

/**
 * Рамку ЦА читают только EN-промпты (рынок us): профиля сайта
 * (stages/siteProfile.ts, clientBriefForProfile) и гипотез
 * (stages/hypotheses.ts). На проекте другого рынка она легла бы в brief и не была бы прочитана
 * никогда, поэтому роут её там не принимает. Кабинет создаёт проекты только
 * с market='us' и форму рамки на другом рынке не показывает: сюда доходит
 * лишь запрос в обход формы.
 */
const ICP_MARKET_ONLY_US = 'The target audience fields apply only to projects in the US market';

/**
 * Страны сбора (brief.collect_countries) соблюдает только сборка рынка us
 * (план 2026-10-16-eng-countries, §1A): на проекте другого рынка список лёг бы
 * в brief и не читался бы никогда.
 */
const COUNTRIES_MARKET_ONLY_US = 'Countries apply only to projects in the US market';

/**
 * Запись списка стран выключена (HE_ENG_COLLECT_COUNTRIES): пока хоть один
 * контейнер работает на старой сборке, его воркер проигнорировал бы список
 * молча. Машинный код — чтобы экран отличал «недоступно» от ошибки ввода.
 */
const COUNTRIES_UNAVAILABLE = 'Choosing countries is not available yet.';

// GET — деталка СВОЕГО проекта (та же сборка, что у staff-роута, но со скоупом
// владельца: чужой проект отвечает 404, существование не раскрываем) —
// суженная клиентской проекцией. Поллится из мастера (каждые 4 с, пока по
// проекту идёт работа, иначе раз в 30 с), поэтому withToolTrace здесь НЕТ: два
// лишних запроса к trace_spans на каждый полл.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  // Проверка формата ДО обращения к БД: иначе Postgres отвечает 22P02
  // «invalid input syntax for type uuid: …» и этот текст уезжал клиенту 500-й.
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);

  const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const detail = await loadHeProjectDetail(supabaseAdmin, id, { scopeCreatedBy: result.auth.userId });
  if (!detail.ok) {
    if (detail.reason === 'not_found') return jsonError('Project not found', 404);
    return engServerError('client.eng.projects.detail_failed', new Error(detail.message ?? 'db error'), PROJECT_LOAD_FAILED, {
      userId: result.auth.userId,
      projectId: id,
    });
  }

  // «ПРОЕКТ СЕЙЧАС ЗАНЯТ?» — ОТДЕЛЬНЫМ крошечным запросом, а не выводом из
  // списка джоб в деталке.
  //
  // Список джоб общий со staff-роутом и капнут тридцатью САМЫМИ СВЕЖИМИ
  // строками (HE_JOB_LIST_COLUMNS, .limit(30) в projectDetail.ts): для витрины
  // «последние задачи» этого достаточно, для вопроса «идёт ли что-нибудь» —
  // нет. Проект, накопивший больше тридцати НОВЫХ строк, пока тянется долгая
  // base_collect, читается по такому списку как простаивающий, и мастер
  // показывает поверх работающего конвейера либо старую паузу автопилота, либо
  // нейтральную карточку «ничего не идёт». Тот же класс дефекта уже закрыт на
  // дашборде (api/client/eng/dashboard) и тем же способом.
  //
  // Выбран отдельный запрос, а не поднятие капа: кап там законный (витрина не
  // должна тянуть тысячу строк), поднимать его ради булева ответа значило бы
  // возить в браузер тем больше данных, чем хуже случай. Запрос читает ОДНУ
  // колонку и ограничен одной строкой — существование, а не пересчёт.
  //
  // Сбой запроса — не «не занят»: ключ тогда НЕ появляется вовсе, и мастер
  // остаётся на прежнем выводе по списку джоб. Выдумывать непрочитанное
  // состояние нельзя, а отвечать 500 на деталку из-за вспомогательного факта —
  // тем более.
  //
  // Общий с RU-инструментом loadHeProjectDetail при этом НЕ тронут: запрос
  // живёт в клиентском роуте, и выдача /api/tools/hypothesis-engine остаётся
  // байт-в-байт прежней.
  //
  // ПОВТОР RESEARCH — ВЕРДИКТОМ СЕРВЕРА (`research_retry`), а не выводом экрана.
  // «Try again» шага 1 обязан стоять ровно там, где роут исследования повтор
  // примет, а роут решает по последней research-джобе БЕЗ капа и по её
  // updated_at/created_at — ни того, ни другого в капнутом списке `jobs` нет
  // (HE_JOB_LIST_COLUMNS общий со staff). Поэтому то же чтение
  // (readLatestHeResearchJob) и та же функция (engResearchRetryVerdict) с тем же
  // окном, что у POST /research; экран рисует кнопку по вердикту, и она
  // появляется, когда истекло окно «цепочка встала», с ближайшим поллом
  // ('researching' мастер поллит каждые 4 с). `latest_job_status` — статус той
  // же джобы: по нему шаг 1 говорит «research отменён». Сбой чтения — ключа
  // нет, экран считает осторожно (кнопки у 'researching' без вердикта нет).
  const [busyRes, latestResearchJob] = await Promise.all([
    supabaseAdmin
      .from('he_jobs')
      .select('id')
      .eq('project_id', id)
      .in('status', ['pending', 'running'])
      .limit(1),
    readLatestHeResearchJob(supabaseAdmin, id),
  ]);
  const rawProject = (detail.detail.project ?? {}) as Record<string, unknown>;
  const researchRetry = latestResearchJob.ok
    ? {
        verdict: engResearchRetryVerdict({
          status: rawProject.status,
          errorCode: toClientEngStageErrorCode(rawProject.error),
          lastResearchJob: latestResearchJob.job,
          project: rawProject,
          now: Date.now(),
          graceMs: HE_RESEARCH_STALL_GRACE_MS,
        }),
        latest_job_status:
          typeof latestResearchJob.job?.status === 'string' ? latestResearchJob.job.status : null,
      }
    : null;

  // ИДЁТ ЛИ АНАЛИЗ 'analyzing'-БАЗ — тем же правилом, что у Command Center и
  // реконсилера «Launch» (шаг 3): общий предикат isAnalyzingBaseLive
  // (autopilotNext.ts) — активная джоба любой стадии на её base_id ИЛИ запись
  // строки в пределах окна постановки ANALYZING_ORPHAN_GRACE_MS (щель
  // harvest-финала между статусом 'analyzing' и вставкой base_analyze).
  // Финальный фейл анализа базу не трогает, поэтому статус базы на вопрос не
  // отвечает, а вывод на экране по капнутому списку `jobs` и без окна объявлял
  // свежую базу остановленной раньше, чем это сделали бы дашборд и кнопка.
  //
  // Оба чтения — только когда у проекта есть 'analyzing'-база (обычно её нет, и
  // лишнего запроса нет): активные джобы БЕЗ капа (одна колонка, строк столько,
  // сколько активных джоб проекта) и updated_at самих баз — его нет в общем со
  // staff списке колонок деталки (HE_BASE_LIST_COLUMNS), и выдачу легаси-
  // инструмента ради него не трогаем. Сбой любого чтения — признака нет вовсе:
  // экран читает базу идущей, как предикат читает «неизвестно».
  const analyzingBaseIds = (Array.isArray(detail.detail.bases) ? detail.detail.bases : [])
    .map((raw) => raw as { id?: unknown; status?: unknown })
    .filter((b) => b.status === 'analyzing' && typeof b.id === 'string' && b.id !== '')
    .map((b) => b.id as string);
  const analysisLive = new Map<string, boolean>();
  if (analyzingBaseIds.length > 0) {
    const [liveJobsRes, stampsRes] = await Promise.all([
      supabaseAdmin
        .from('he_jobs')
        .select('payload')
        .eq('project_id', id)
        .in('status', ['pending', 'running']),
      supabaseAdmin
        .from('he_bases')
        .select('id, updated_at')
        .eq('project_id', id)
        .in('id', analyzingBaseIds),
    ]);
    if (!liveJobsRes.error && !stampsRes.error) {
      const liveBaseIds = liveBaseIdsFromJobs((liveJobsRes.data ?? []) as Array<{ payload?: unknown }>);
      const updatedAtById = new Map<string, string | null>();
      for (const row of (stampsRes.data ?? []) as Array<{ id?: unknown; updated_at?: unknown }>) {
        if (typeof row.id === 'string') {
          updatedAtById.set(row.id, typeof row.updated_at === 'string' ? row.updated_at : null);
        }
      }
      for (const baseId of analyzingBaseIds) {
        analysisLive.set(
          baseId,
          isAnalyzingBaseLive({ id: baseId, updated_at: updatedAtById.get(baseId) ?? null }, liveBaseIds),
        );
      }
    }
  }

  // АВТОЗАПУСК (S3, engAutoLaunch): включён ли после «Launch» проекта и что с
  // каждым готовым рынком — строки he_eng_auto_launch шаблонов проекта плюс
  // кандидаты без строки ('waiting', дата шаблона). Без счётчиков и аренды.
  // Миграции нет — available:false (шаг 3 показывает «Launch now» у каждого
  // готового рынка); сбой чтения — ключ null, шаг 3 считает осторожно.
  //
  // ОЦЕНКИ ВРЕМЕНИ (engEstimates): медианы недавних проектов, кэш 15 минут,
  // меньше трёх замеров или сбой — null (экран числа не печатает).
  //
  // ОСТАНОВКИ, КОТОРЫЕ ЧИНИТ КОМАНДА (readTeamFixStops): только у исследованного
  // проекта — карточки рынков шага 3 и шапка мастера рисуются у него.
  //
  // ВЫКЛЮЧАТЕЛЬ ОТПРАВКИ АККАУНТА (readHeEngSendingAccess — то же чтение, что у
  // GET …/launch, без записи и алерта): тоже только у исследованного проекта.
  // При 'revoked' «Launch», «Launch now», «Rewrite letters» и «Collect again»
  // откажут 403 — шапка мастера и шаги 2–3 к ним не зовут, а шаг 3 их не
  // рисует или выключает; с опросом деталки экран видит включение и выключение
  // без перезагрузки. Сбой чтения и нет таблицы — ключа нет (экран берёт
  // чтение GET …/launch).
  const [autoLaunch, durations, teamFixStops, sendingAccess, collectionProgress] = await Promise.all([
    readHeEngAutoLaunchDetail(supabaseAdmin, id, {
      verticals: detail.detail.verticals as Array<Record<string, unknown>>,
      hypotheses: detail.detail.hypotheses as Array<Record<string, unknown>>,
      templates: detail.detail.templates as Array<Record<string, unknown>>,
    }),
    readHeEngTypicalDurations(supabaseAdmin),
    rawProject.status === 'researched' ? readTeamFixStops(id) : Promise.resolve(null),
    rawProject.status === 'researched' ? readHeEngSendingAccess(supabaseAdmin, result.auth.userId) : Promise.resolve(null),
    readHeEngCollectionProgress(supabaseAdmin, result.auth.userId, Array.isArray(detail.detail.bases) ? detail.detail.bases : []),
  ]);
  const accountAccess: 'not_enabled' | 'revoked' | null | undefined =
    sendingAccess === null || sendingAccess.state === 'error' || sendingAccess.state === 'unavailable'
      ? undefined
      : sendingAccess.state === 'not_enabled' || sendingAccess.state === 'revoked'
        ? sendingAccess.state
        : null;

  // Белый список полей: себестоимость, модели, план сорсинга и id внутренних
  // джоб в кабинет не едут (lib/hypothesisEngine/clientEngProjection).
  // Рамку ЦА (brief.icp) проектор ставит сам (toClientEngProjectRow,
  // readHeIcpFrame) — на всех трёх ответах роута с brief одинаково.
  // `analysis_live` — вычисленный булев признак, а не колонка: ключ только у
  // 'analyzing'-баз, чья живость прочитана.
  // Владелец (он же этот клиент) — клиент ENG-кабинета: причина 'brand' у
  // русских писем считается, как у запуска (letterBrandGuard). Профиль
  // читается, только когда хоть у одного шаблона он меняет ответ.
  const heEngClient = (detail.detail.templates as Array<Record<string, unknown>>).some((t) => heBrandNeedsOwner(t.letters))
    ? await readHeBrandEngClient(supabaseAdmin, result.auth.userId)
    : false;
  const projected = toClientEngProjectDetail(detail.detail, { heEngClient });
  // Законченные прогоны ночного добора — итогом на рынок (foldFinishedRefillBases),
  // срок отправки — в запись о запуске (withRunDays).
  const refill = foldFinishedRefillBases(
    projected.bases,
    Array.isArray(detail.detail.bases) ? detail.detail.bases : [],
    projected.templates,
  );
  return NextResponse.json({
    ...projected,
    bases: refill.bases.map((b) => {
      const baseId = typeof b.id === 'string' ? b.id : '';
      const live = analysisLive.get(baseId);
      return {
        ...b,
        ...(live === undefined ? {} : { analysis_live: live }),
        ...(collectionProgress.has(baseId) ? { collection_progress: collectionProgress.get(baseId) } : {}),
      };
    }),
    templates: withRunDays(projected.templates, Array.isArray(detail.detail.templates) ? detail.detail.templates : []),
    ...(refill.totals.length > 0 ? { refill_totals: refill.totals } : {}),
    ...(busyRes.error ? {} : { has_active_jobs: (busyRes.data ?? []).length > 0 }),
    ...(researchRetry ? { research_retry: researchRetry } : {}),
    auto_launch: autoLaunch,
    estimates: { research_minutes: durations.researchMinutes, prepare_hours: durations.prepareHours },
    ...(teamFixStops ? { team_fix_stops: teamFixStops } : {}),
    ...(accountAccess !== undefined ? { account_access: accountAccess } : {}),
  });
}

// PATCH — offer_override / style_override / signature_override / business_override мержатся в
// he_projects.brief (та же логика, что у staff, со скоупом владельца до записи),
// icp (рамка ЦА; из PATCH-роутов только этот) — частичной правкой в brief.icp той же
// записью, max_emails_per_company пишется колонкой проекта.
//
// Настройка «до N адресов одной компании» (волна 1: миграция 20260926_0001,
// штамп на постановке сборки, применение конструктором) до этой правки не
// имела ни одного writer'а — выставить её можно было только SQL'ем, хотя
// решение владельца было «клиент выбирает». Этот роут и есть тот writer:
// значение проекта = ДЕФОЛТ ДЛЯ БУДУЩИХ сборок, у уже поставленной базы
// действует лимит, проштампованный в he_bases.max_emails_per_company.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.project.patch' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    let body: EngProjectPatchBody;
    try {
      body = (await req.json()) as EngProjectPatchBody;
    } catch {
      return jsonError('Invalid body', 400);
    }

    // Значение проверяем ДО обращения к БД (как формат id выше): отказ по телу
    // запроса ничего не сообщает о существовании проекта.
    //
    // Границы НЕ переписываем — их знает только нормализатор сборки
    // (`normalizeHeMaxEmailsPerCompany`), там же, где их читает стадия. Мусор и
    // число вне диапазона он отдаёт одинаково (null), поэтому «убрать
    // настройку» выражается ЯВНЫМ null в теле, а не любым непонятным значением:
    // иначе опечатка молча сбрасывала бы выбор клиента.
    const capRaw = body?.max_emails_per_company;
    const capRequested = capRaw !== undefined;
    let cap: number | null = null;
    if (capRequested && capRaw !== null) {
      cap = normalizeHeMaxEmailsPerCompany(capRaw);
      if (cap === null) return jsonError(CONTACT_CAP_RANGE, 400);
    }

    // Рамка ЦА — тоже до БД и тоже строго: лишнее отклоняется, а не режется
    // молча (parseHeIcpFramePatch). `null` — снять рамку целиком.
    const icpRequested = body?.icp !== undefined;
    let icpPatch: HeIcpFramePatch | null = null;
    if (icpRequested) {
      const parsed = parseHeIcpFramePatch(body.icp);
      // Текст — общий с POST создания (icpFrame.ts): имена ключей тела, лимит
      // из ошибки; форма кабинета проверяет те же константы до отправки.
      if (!parsed.ok) return jsonError(heIcpFrameInputErrorText(parsed.error), 400);
      icpPatch = parsed.patch;
    }

    // Страны сбора — до БД и строго (parseHeCollectCountries): незнакомая или
    // скрытая страна — 400, а не тихий пропуск. null и [] — снять список.
    // Выключатель проверяется первым: при выключенном запись не принимается
    // вовсе, каким бы ни было значение.
    const countriesRequested = body?.collect_countries !== undefined;
    let countries: string[] = [];
    if (countriesRequested) {
      if (!heEngCollectCountriesEnabled()) {
        return NextResponse.json({ error: COUNTRIES_UNAVAILABLE, code: 'countries_unavailable' }, { status: 400 });
      }
      const parsed = parseHeCollectCountries(body.collect_countries);
      if (!parsed.ok) return jsonError(heCollectCountriesErrorText(parsed), 400);
      countries = parsed.countries;
    }

    // Поля брифа мержит общий со staff `patchHeProjectBrief`, и он же отвечает
    // `no_fields` на пустое тело. Звать его на запрос ТОЛЬКО с настройкой
    // нельзя — вернул бы 400 на корректный запрос, поэтому наличие полей
    // брифа роут проверяет сам.
    const briefRequested = body?.offer_override !== undefined
      || body?.style_override !== undefined
      || body?.signature_override !== undefined
      || body?.business_override !== undefined
      || icpRequested
      || countriesRequested;
    if (!capRequested && !briefRequested) return jsonError(NO_FIELDS, 400);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
    // До записи настройки: отказ по рамке не должен оставлять половину запроса
    // сохранённой.
    if (icpRequested && projectMarket(owned.project as { market?: string | null }) !== 'us') {
      return jsonError(ICP_MARKET_ONLY_US, 409);
    }
    if (countriesRequested && projectMarket(owned.project as { market?: string | null }) !== 'us') {
      return jsonError(COUNTRIES_MARKET_ONLY_US, 409);
    }

    // Настройка пишется ПЕРВОЙ: ответ обеих ветвей собирается из строки,
    // прочитанной после записи, поэтому кабинет не увидит старое значение.
    let projectRow = owned.project;
    if (capRequested) {
      const { data: stored, error: capErr } = await supabaseAdmin
        .from('he_projects')
        .update({ max_emails_per_company: cap })
        .eq('id', id)
        // Второй барьер к скоупу владельца, между чтением выше и записью.
        .eq('created_by', result.auth.userId)
        // Читаем ровно то, что БД сохранила, — одной колонкой: остальные поля
        // строки уже есть в `owned.project`, а лишние имена в `select`
        // клиентского контура не нужны.
        .select('max_emails_per_company')
        .single();
      if (capErr) {
        // PGRST116 — «строк нет»: проект исчез или сменил владельца между
        // чтением и записью. Наружу тот же 404, что у скоуп-гейта.
        if (capErr.code === 'PGRST116') return jsonError('Project not found', 404);
        // Сообщение Postgres (имя таблицы `he_projects`, текст
        // check-ограничения, тип колонки) наружу не уходит: английская
        // константа + машинный код причины, сырьё — в `application_logs`.
        return engServerError('client.eng.projects.contact_cap_patch_failed', capErr, SETTING_SAVE_FAILED, {
          userId: result.auth.userId,
          projectId: id,
        });
      }
      projectRow = {
        ...owned.project,
        // Через тот же нормализатор: если в колонке окажется что-то
        // неожидаемое, кабинет увидит null («дефолт»), а не мусор.
        max_emails_per_company: normalizeHeMaxEmailsPerCompany(
          (stored as { max_emails_per_company?: unknown } | null)?.max_emails_per_company,
        ),
      };
    }

    // Запрос только с настройкой: отвечаем той же проекцией, что и ниже.
    if (!briefRequested) {
      return NextResponse.json({ project: toClientEngProjectRow(projectRow) });
    }

    // Рамка ЦА уходит отдельным аргументом: overrides и рамка ложатся одной
    // записью brief (один read-merge-write), а staff-роут, который зовёт
    // ту же функцию без него, `icp` не пишет вовсе. Кап оффера этот роут
    // передаёт правилом (staff-PATCH правила не передаёт, и кап там решает
    // рынок проекта: 'us' — тот же отказ, RU — оффер любой длины, как до порта
    // ENG); проверка стоит в функции на прежнем месте, поэтому порядок отказов
    // кабинета прежний.
    // Страны — тем же аргументом и той же записью; без них аргумент прежний
    // (undefined, если нет и рамки).
    const clientFields: HeBriefPatchClientFields | undefined = icpRequested || countriesRequested
      ? {
        ...(icpRequested ? { icp: icpPatch } : {}),
        ...(countriesRequested ? { collect_countries: countries } : {}),
      }
      : undefined;
    const patch = await patchHeProjectBrief(
      supabaseAdmin,
      id,
      body,
      clientFields,
      { offerMaxLength: OFFER_OVERRIDE_MAX_LENGTH },
    );
    if (!patch.ok) {
      const err = patch.error;
      switch (err.code) {
        case 'no_fields':
          return jsonError(NO_FIELDS, 400);
        case 'bad_type':
          return jsonError(`${err.field} must be a string`, 400);
        case 'too_long':
          // Клиенту — имя поля, как его подписывает шаг 1, а не ключ брифа.
          return jsonError(`${BRIEF_FIELD_LABELS[err.field]}: up to ${err.max} characters.`, 413);
        case 'not_found':
          return jsonError('Project not found', 404);
        default:
          return engServerError('client.eng.projects.brief_patch_failed', new Error(err.message), BRIEF_SAVE_FAILED, {
            userId: result.auth.userId,
            projectId: id,
          });
      }
    }

    if (countriesRequested) {
      // «До» — сохранённое прочтение (fail-closed, как его видит сборка), «после» —
      // ровно то, что записано.
      const before = readHeCollectCountries(
        ((owned.project as { brief?: Record<string, unknown> | null }).brief ?? null)?.collect_countries,
      ).countries;
      void logAudit('client.eng.project.collect_countries_changed', 'ENG cabinet collection countries changed', {
        userId: result.auth.userId,
        projectId: id,
        before,
        after: countries,
      });
      // Расширение — новые компании: «сухие» ночные доборы рынков проекта снова
      // в деле (одна перепланировка на рынок). Best effort: запись уже прошла.
      if (heCollectCountriesBroadened(before, countries)) {
        const reset = await resumeHeDryVerticalsAfterCountriesBroadened(supabaseAdmin, id, resumeHeVerticalNightlyRefill);
        if (reset.failed.length > 0) {
          void logWarn('client.eng.project.collect_countries_dry_reset_failed', 'Dry refill reset after countries broadening failed', {
            userId: result.auth.userId,
            projectId: id,
            resumed: reset.resumed,
            failed: reset.failed,
          });
        }
      }
    }

    // patchHeProjectBrief отдаёт строку из .select() целиком — проецируем, как
    // и деталку: cost_usd/tokens_used/llm_model кабинету не нужны.
    return NextResponse.json({ project: toClientEngProjectRow(patch.project) });
  });
}
