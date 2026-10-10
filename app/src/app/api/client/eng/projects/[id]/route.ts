import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
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
} from '@/lib/hypothesisEngine/clientEngProjection';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { isAnalyzingBaseLive, liveBaseIdsFromJobs } from '@/lib/hypothesisEngine/autopilotNext';
import { engProjectDeleteAvailable } from '@/lib/hypothesisEngine/engPaidAccess';
import { findHeEngRateHits } from '@/lib/hypothesisEngine/engRateLimit';
import { HE_LAUNCH_LEASE_MS } from '@/lib/hypothesisEngine/launchHandoff';
import {
  HE_TEMPLATE_LAUNCH_MARK_COLUMNS,
  heTemplateLaunchMarked,
  type HeTemplateLaunchMark,
} from '@/lib/hypothesisEngine/launchTemplate';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import {
  patchHeProjectBrief,
  type HeBriefPatchBody,
} from '@/lib/hypothesisEngine/projectBriefPatch';
import {
  parseHeIcpFramePatch,
  type HeIcpFrameInputError,
  type HeIcpFramePatch,
} from '@/lib/hypothesisEngine/icpFrame';
import {
  HE_MAX_EMAILS_PER_COMPANY_MAX,
  HE_MAX_EMAILS_PER_COMPANY_MIN,
  normalizeHeMaxEmailsPerCompany,
} from '@/lib/hypothesisEngine/baseCollectEnqueue';
import { engServerError } from '../../_shared';

export const dynamic = 'force-dynamic';

const PROJECT_LOAD_FAILED = 'Failed to load the project';
const BRIEF_SAVE_FAILED = 'Failed to save the brief';
const SETTING_SAVE_FAILED = 'Failed to save the project setting';

/**
 * Тело PATCH: поля брифа (общие со staff), рамка ЦА клиента (`icp`, только
 * этот роут) и настройка проекта «до N адресов одной компании». Значения
 * приходят `unknown` — проверяют их нормализаторы, а не тип запроса.
 */
type EngProjectPatchBody = HeBriefPatchBody & { max_emails_per_company?: unknown; icp?: unknown };

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
  'Provide offer_override, style_override, signature_override, business_override, icp or max_emails_per_company';

/**
 * Рамку ЦА читает только EN-промпт гипотез (рынок us, stages/hypotheses.ts).
 * На проекте другого рынка она легла бы в brief и не была бы прочитана
 * никогда, поэтому роут её там не принимает. Кабинет создаёт проекты только
 * с market='us' и форму рамки на другом рынке не показывает: сюда доходит
 * лишь запрос в обход формы.
 */
const ICP_MARKET_ONLY_US = 'The target audience fields apply only to projects in the US market';

/**
 * Отказ по рамке ЦА. Имена — ключи тела запроса (как у отказов по overrides
 * ниже), лимит — из ошибки нормализатора, а не цифрой: форма кабинета
 * проверяет те же константы (icpFrame.ts) до отправки, и сюда доходит только
 * запрос в обход формы.
 */
function icpInputErrorText(err: HeIcpFrameInputError): string {
  switch (err.code) {
    case 'bad_shape':
      return 'icp must be an object with include, exclude, size or geo, or null to clear it';
    case 'bad_type':
      return err.field === 'include' || err.field === 'exclude'
        ? `icp.${err.field} must be a list of strings`
        : `icp.${err.field} must be a string`;
    case 'too_many':
      return `icp.${err.field}: at most ${err.max} entries`;
    case 'too_long':
      return err.field === 'include' || err.field === 'exclude'
        ? `icp.${err.field}: each entry is at most ${err.max} characters`
        : `icp.${err.field}: maximum ${err.max} characters`;
  }
}

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
  const busyRes = await supabaseAdmin
    .from('he_jobs')
    .select('id')
    .eq('project_id', id)
    .in('status', ['pending', 'running'])
    .limit(1);

  // ИДЁТ ЛИ АНАЛИЗ 'analyzing'-БАЗ — тем же правилом, что у Command Center и
  // реконсилера «Start outreach»: общий предикат isAnalyzingBaseLive
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

  // Белый список полей: себестоимость, модели, план сорсинга и id внутренних
  // джоб в кабинет не едут (lib/hypothesisEngine/clientEngProjection).
  // Рамку ЦА (brief.icp) проектор ставит сам (toClientEngProjectRow,
  // readHeIcpFrame) — на всех трёх ответах роута с brief одинаково.
  // `analysis_live` — вычисленный булев признак, а не колонка: ключ только у
  // 'analyzing'-баз, чья живость прочитана.
  const projected = toClientEngProjectDetail(detail.detail);
  return NextResponse.json({
    ...projected,
    bases:
      analysisLive.size === 0
        ? projected.bases
        : projected.bases.map((b) => {
            const live = typeof b.id === 'string' ? analysisLive.get(b.id) : undefined;
            return live === undefined ? b : { ...b, analysis_live: live };
          }),
    ...(busyRes.error ? {} : { has_active_jobs: (busyRes.data ?? []).length > 0 }),
  });
}

// PATCH — offer_override / style_override / signature_override / business_override мержатся в
// he_projects.brief (та же логика, что у staff, со скоупом владельца до записи),
// icp (рамка ЦА, только этот роут) — частичной правкой в brief.icp той же
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
      if (!parsed.ok) return jsonError(icpInputErrorText(parsed.error), 400);
      icpPatch = parsed.patch;
    }

    // Поля брифа мержит общий со staff `patchHeProjectBrief`, и он же отвечает
    // `no_fields` на пустое тело. Звать его на запрос ТОЛЬКО с настройкой
    // нельзя — вернул бы 400 на корректный запрос, поэтому наличие полей
    // брифа роут проверяет сам.
    const briefRequested = body?.offer_override !== undefined
      || body?.style_override !== undefined
      || body?.signature_override !== undefined
      || body?.business_override !== undefined
      || icpRequested;
    if (!capRequested && !briefRequested) return jsonError(NO_FIELDS, 400);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
    // До записи настройки: отказ по рамке не должен оставлять половину запроса
    // сохранённой.
    if (icpRequested && projectMarket(owned.project as { market?: string | null }) !== 'us') {
      return jsonError(ICP_MARKET_ONLY_US, 409);
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
    // ту же функцию без него, `icp` не пишет вовсе.
    const patch = await patchHeProjectBrief(supabaseAdmin, id, body, icpRequested ? { icp: icpPatch } : undefined);
    if (!patch.ok) {
      const err = patch.error;
      switch (err.code) {
        case 'no_fields':
          return jsonError(NO_FIELDS, 400);
        case 'bad_type':
          return jsonError(`${err.field} must be a string`, 400);
        case 'too_long':
          return jsonError(`${err.field}: maximum ${err.max} characters`, 413);
        case 'not_found':
          return jsonError('Project not found', 404);
        default:
          return engServerError('client.eng.projects.brief_patch_failed', new Error(err.message), BRIEF_SAVE_FAILED, {
            userId: result.auth.userId,
            projectId: id,
          });
      }
    }

    // patchHeProjectBrief отдаёт строку из .select() целиком — проецируем, как
    // и деталку: cost_usd/tokens_used/llm_model кабинету не нужны.
    return NextResponse.json({ project: toClientEngProjectRow(patch.project) });
  });
}

/* ─────────────── DELETE: удаление проекта клиентом ─────────────── */

const PROJECT_DELETE_FAILED = 'Failed to delete the project';

/**
 * Тексты отказов DELETE. Каждый правдив для любой формы, которая до него
 * доходит, и называет, что делать:
 *  - SPEND_CAP — задан потолок расхода клиента (HE_US_CLIENT_SPEND_CAP_USD /
 *    HE_US_CLIENT_DAY_SPEND_CAP_USD, ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда отказа нет).
 *    Его сумма складывается по строкам he_projects клиента
 *    (he_client_provider_spend_sum, 20261010_0001), и удалённый проект унёс бы
 *    из неё свой расход — потолок перестал бы держать. Отказ любому проекту,
 *    пока потолок задан: расход есть у любого проекта, дошедшего до research;
 *  - LAUNCHED — в записи о запуске шаблона есть кампания (campaign_id
 *    he_templates.launch_info): кампании живут у рассыльщика, а запись о том,
 *    кто в них попал, ушла бы вместе с проектом. Отказ постоянный;
 *  - LAUNCHING — запуск шаблона идёт: живая аренда записи (running_until,
 *    heTemplateLaunchMarked — тот же признак, что у «Re-run research») или
 *    отметка 'launch_in_flight' роута запуска кабинета (engRateLimit). Обе
 *    гаснут не позже HE_LAUNCH_LEASE_MS после конца запуска, отсюда «or ended
 *    less than N minutes ago». Создаст запуск кампанию — дальше LAUNCHED;
 *  - RESEARCH_TODAY — у проекта есть site_profile, созданная с 00:00 UTC.
 *    Лимит исследований за UTC-сутки (engPaidAccess.ts и его замок) считает
 *    ровно эти строки he_jobs по проектам клиента, а каскад удалил бы их, и
 *    сегодняшний лимит отпустил бы новые платные исследования. С полуночи UTC
 *    строка в счёт не идёт, и её удаление ничего не отпускает;
 *  - BUSY — идёт работа (см. readDeleteSnapshot). Кнопка «Cancel all jobs»
 *    мастера рисуется не при каждой такой работе (engWizardLiveWork не видит
 *    джоб конструктора и Google Maps), поэтому — «when that button is shown»;
 *  - CHANGED — удаление условно (статус проекта тот, что судил снимок), и ноль
 *    строк при живом проекте значит, что статус сменился между снимком и
 *    удалением (например, началось исследование). Что именно — снимок уже не
 *    скажет, поэтому текст не называет причину, а просит перечитать.
 */
const DELETE_SPEND_CAP_TEXT =
  "Projects cannot be deleted on this account: it has a usage limit, and deleting a project would take that project's "
  + 'usage out of the total the limit counts. Message Support if you need room for another project.';
const DELETE_LAUNCHED_TEXT =
  'This project cannot be deleted because a campaign has already been launched from it — deleting it would delete '
  + 'the record of which contacts went into those campaigns. To make room for a new project, delete one without '
  + 'launched campaigns, or message Support to raise the limit.';
const LEASE_MINUTES = Math.round(HE_LAUNCH_LEASE_MS / 60_000);
const DELETE_LAUNCHING_TEXT =
  `A campaign launch from this project is running, or ended less than ${LEASE_MINUTES} minutes ago, so the project `
  + 'cannot be deleted yet. Try again later. If the launch created a campaign, the project cannot be deleted at all: '
  + 'deleting it would delete the record of which contacts went into that campaign.';
const DELETE_RESEARCH_TODAY_TEXT =
  'Research on this project was started today, and research started today counts toward your daily research limit '
  + 'until midnight UTC, so this project cannot be deleted before then.';
const DELETE_BUSY_TEXT =
  'Work on this project is still in progress, so it cannot be deleted yet. Wait until it finishes, or stop it with '
  + '«Cancel all jobs» on the project page when that button is shown, then delete the project.';
const DELETE_CHANGED_TEXT =
  'This project changed while it was being deleted, so it was not deleted. Reload the page to see its current '
  + 'state, then try again.';

/**
 * Позиции задач плана сборки с дочерней джобой парсера — те же, что у отмены
 * (cancel/route.ts, CANCEL_CHILD_TASK_SLOTS: ставят их только задачи
 * модели-планировщика, не больше четырёх, в начале списка).
 */
const DELETE_CHILD_TASK_SLOTS = [0, 1, 2, 3] as const;

/**
 * Поля базы для снимка: статус, updated_at (живость 'analyzing'), id джоб
 * конструктора — сборки (construct) и раунда перепроверки адресов
 * (validationRetry.ts, revalidation.round) — и дочерних джоб задач плана.
 * Без `data` и без самого collect_info: в них мегабайты строк и харвеста.
 */
const DELETE_BASE_COLUMNS = [
  'id',
  'status',
  'updated_at',
  'bc_job_id:collect_info->construct->>bc_job_id',
  'revalidation_bc_job_id:collect_info->revalidation->round->>bc_job_id',
  ...DELETE_CHILD_TASK_SLOTS.flatMap((i) => [
    `task${i}_source:collect_info->tasks->${i}->>source`,
    `task${i}_child:collect_info->tasks->${i}->>child_job_id`,
  ]),
].join(', ');

interface DeleteSnapshot {
  /** У шаблона проекта в записи о запуске есть кампания. */
  launched: boolean;
  /** Запуск шаблона идёт: живая аренда записи или отметка роута запуска. */
  launching: boolean;
  researchStartedToday: boolean;
  busy: boolean;
  /** Для аудита: что ушло каскадом. */
  verticals: number;
  bases: number;
  templates: number;
}

/**
 * Снимок проекта для отказов DELETE. «Идёт работа» (busy):
 *  - активные (pending/running) he_jobs проекта — любая стадия;
 *  - база 'collecting';
 *  - база 'analyzing', чей анализ жив (isAnalyzingBaseLive — тот же предикат,
 *    что у GET выше и у Command Center; активных джоб в этой ветке нет, так
 *    что живой её делает только окно постановки). Остановившийся анализ
 *    ничего не делает, и удалению не мешает;
 *  - джоба конструктора баз (base_constructor_jobs 'pending'/'processing') у
 *    сборки или перепроверки адресов любой базы проекта и дочерняя джоба
 *    Google Maps ('queued'/'running'/'paused') — те же записи и статусы, что
 *    останавливает отмена (cancel/route.ts, stopCancelledBaseWork). Они
 *    платят вне he_jobs, и удаление базы их не остановит: оплаченный итог
 *    лечь будет некуда. hh_live и yandex_maps ENG-план не ставит (там же).
 * Проект 'researching' — тоже работа; это решает роут по уже прочитанной строке.
 * Запуск шаблона — не he_job, у него свои признаки (launched / launching, см.
 * тексты выше). Отметку 'launch_in_flight' читает findHeEngRateHits: её нет в
 * БД (миграция 20261010_0001 не применена) — отметок не бывает, строка warn.
 * Сбой любого чтения — ошибка: «не знаю, идёт ли работа» не равно «не идёт».
 */
async function readDeleteSnapshot(
  db: SupabaseClient,
  projectId: string,
  now: Date,
): Promise<{ snapshot: DeleteSnapshot } | { error: unknown }> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [verticalsRes, basesRes, activeJobsRes, researchTodayRes] = await Promise.all([
    db.from('he_verticals').select('id').eq('project_id', projectId),
    db.from('he_bases').select(DELETE_BASE_COLUMNS).eq('project_id', projectId),
    db.from('he_jobs').select('id').eq('project_id', projectId).in('status', ['pending', 'running']).limit(1),
    db
      .from('he_jobs')
      .select('id')
      .eq('project_id', projectId)
      .eq('stage', 'site_profile')
      .gte('created_at', dayStart.toISOString())
      .limit(1),
  ]);
  if (verticalsRes.error) return { error: verticalsRes.error };
  if (basesRes.error) return { error: basesRes.error };
  if (activeJobsRes.error) return { error: activeJobsRes.error };
  if (researchTodayRes.error) return { error: researchTodayRes.error };

  const verticalIds = (verticalsRes.data ?? [])
    .map((v) => (v as { id?: unknown }).id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  let templates: HeTemplateLaunchMark[] = [];
  if (verticalIds.length > 0) {
    const templatesRes = await db.from('he_templates').select(HE_TEMPLATE_LAUNCH_MARK_COLUMNS).in('vertical_id', verticalIds);
    if (templatesRes.error) return { error: templatesRes.error };
    templates = (templatesRes.data ?? []) as HeTemplateLaunchMark[];
  }
  const nowMs = now.getTime();
  const templateIds = templates
    .map((t) => t.id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  // Первый запуск шаблона пишет запись только с первой кампанией, а платный
  // классификатор идёт раньше — до этого его видно только по отметке роута.
  const inFlight = await findHeEngRateHits(db, 'launch_in_flight', templateIds, nowMs - HE_LAUNCH_LEASE_MS);
  if (inFlight.kind === 'error') return { error: new Error(inFlight.message) };
  if (inFlight.kind === 'table_missing') {
    void logWarn(
      'client.eng.project.delete_in_flight_unreadable',
      'he_eng_rate_events is missing (migration 20261010_0001 not applied) — a first launch in progress is not seen by delete',
      { projectId },
    );
  }

  const bases = (basesRes.data ?? []) as unknown as Array<Record<string, unknown>>;
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
  let busy = (activeJobsRes.data ?? []).length > 0;
  if (!busy) {
    busy = bases.some((b) =>
      b.status === 'collecting'
      || (b.status === 'analyzing'
        && isAnalyzingBaseLive({ id: String(b.id ?? ''), updated_at: text(b.updated_at) }, new Set<string>())),
    );
  }
  if (!busy) {
    const constructorIds = new Set<string>();
    const mapsIds = new Set<string>();
    for (const b of bases) {
      for (const id of [text(b.bc_job_id), text(b.revalidation_bc_job_id)]) if (id) constructorIds.add(id);
      for (const i of DELETE_CHILD_TASK_SLOTS) {
        const child = text(b[`task${i}_child`]);
        if (child && b[`task${i}_source`] === 'google_maps') mapsIds.add(child);
      }
    }
    const [constructorRes, mapsRes] = await Promise.all([
      constructorIds.size > 0
        ? db.from('base_constructor_jobs').select('id').in('id', [...constructorIds]).in('status', ['pending', 'processing']).limit(1)
        : null,
      mapsIds.size > 0
        ? db.from('google_maps_jobs').select('id').in('id', [...mapsIds]).in('status', ['queued', 'running', 'paused']).limit(1)
        : null,
    ]);
    if (constructorRes?.error) return { error: constructorRes.error };
    if (mapsRes?.error) return { error: mapsRes.error };
    busy = (constructorRes?.data ?? []).length > 0 || (mapsRes?.data ?? []).length > 0;
  }

  return {
    snapshot: {
      launched: templates.some((t) => typeof t.launch_campaign_id === 'string' && t.launch_campaign_id.length > 0),
      launching: inFlight.kind === 'found' || templates.some((t) => heTemplateLaunchMarked(t, nowMs)),
      researchStartedToday: (researchTodayRes.data ?? []).length > 0,
      busy,
      verticals: verticalIds.length,
      bases: bases.length,
      templates: templates.length,
    },
  };
}

// DELETE — удалить СВОЙ проект целиком (кнопка «Delete project» в списке
// проектов кабинета). Лимит проектов (engPaidAccess.ts) считает строки
// he_projects клиента, и удаление — самостоятельный способ освободить место.
//
// ЧТО УДАЛЯЕТСЯ. Одна строка he_projects; остальное уходит каскадом внешних
// ключей (on delete cascade). Staff-роута удаления проекта нет — это та же
// цепочка каскадов, на которой стоит кластеризация «Re-run research»
// (researchJob.ts), только от проекта, а не от его вертикалей:
//   - от he_projects: he_jobs, he_hypotheses, he_verticals, he_bases,
//     he_cases, he_vertical_dossiers (20260724_0001, 20260728_0001),
//     he_auto_pipeline_configs → he_auto_pipeline_runs (20260804_0005),
//     he_refill_daily_budgets, he_refill_daily_reservations (20260930_0004),
//     he_refill_carryover (20261004_0001);
//   - от he_verticals: he_chains, he_vocab, he_bases, he_templates,
//     he_vertical_dossiers, he_catalog_cursors (20260930_0002),
//     he_refill_carryover;
//   - от he_bases и he_templates: he_templates, he_refill_carryover,
//     he_launch_schedule (20260926_0002).
// НЕ удаляется: журнал расхода и аудит (application_logs, request_id = id
// проекта), trace_spans, строки законченных джоб конструктора и парсеров
// (base_constructor_jobs, google_maps_jobs, parser_jobs) и кампании у
// рассыльщика. Проект, у шаблона которого в записи о запуске есть кампания
// или виден идущий запуск, не удаляется; кампания, которую создал запуск,
// невидимый удалению (ниже), остаётся у рассыльщика.
//
// Отказы 409 (тексты выше) — до удаления и в этом порядке: потолок клиента
// (без чтения БД), запуск (кампания в записи), идущий запуск, исследование
// сегодня, идущая работа. Постоянные причины — раньше временных, а
// «исследование сегодня» — раньше «идёт работа»: иначе клиент остановил бы
// идущую оплаченную работу ради удаления, которое до полуночи UTC всё равно
// не пройдёт.
//
// ЗАПУСК — НЕ he_job. Первый запуск шаблона пишет he_templates.launch_info
// только после того, как рассыльщик создал первую кампанию, а платный
// классификатор сегментов идёт раньше — минуты. Это окно удаление видит по
// отметке 'launch_in_flight', которую роут запуска кабинета ставит до ядра и
// снимает после (engRateLimit; гаснет сама через HE_LAUNCH_LEASE_MS); запуск
// поверх уже существующей записи — ещё и по её аренде. Не видны: запуск,
// который сотрудник жмёт из внутреннего инструмента (отметки нет), и запуск
// кабинета, чья отметка не легла в БД (миграции 20261010_0001 нет, блип — она
// осталась в памяти процесса). Удалённый посреди такого запуска проект запуск
// обнаружит на первой записи: шаблона нет — он останавливается, созданная
// кампания остаётся у рассыльщика на паузе и пустой (её id — в логе
// taken_over), а классификация оплачена зря.
//
// Остаток гонки: снимок и удаление — несколько запросов подряд, замка между
// ними нет. Само удаление условно: статус проекта — тот, что судил снимок;
// сменился (например, началось исследование) — ноль строк, проект перечитан,
// и живой проект получает 409 CHANGED, а не 404. То, что статус не меняет и
// появилось в миллисекунды между снимком и удалением, не видно: he_job
// (ночной проход, второй таб) либо уходит каскадом до оплаты (pending), либо,
// если воркер успел её взять, оплачивает одну стадию, итог которой записать
// некуда; запуск, прочитавший шаблон до удаления, идёт как сказано выше.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.project.delete' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const refuse = (verdict: string, text: string) => {
      void logAudit('client.eng.project.delete_refused', `ENG cabinet project delete refused: ${verdict}`, {
        userId: result.auth.userId,
        projectId: id,
        verdict,
      });
      return jsonError(text, 409);
    };

    // Тот же предикат решает текст отказа лимита проектов (engPaidAccess.ts).
    if (!engProjectDeleteAvailable()) return refuse('spend_cap', DELETE_SPEND_CAP_TEXT);

    const read = await readDeleteSnapshot(supabaseAdmin, id, new Date());
    if ('error' in read) {
      return engServerError('client.eng.projects.delete_snapshot_failed', read.error, PROJECT_DELETE_FAILED, {
        userId: result.auth.userId,
        projectId: id,
      });
    }
    const snapshot = read.snapshot;
    if (snapshot.launched) return refuse('launched', DELETE_LAUNCHED_TEXT);
    if (snapshot.launching) return refuse('launching', DELETE_LAUNCHING_TEXT);
    if (snapshot.researchStartedToday) return refuse('research_today', DELETE_RESEARCH_TODAY_TEXT);
    if (snapshot.busy || owned.project.status === 'researching') return refuse('busy', DELETE_BUSY_TEXT);

    // Удаление условно — по статусу, который судили выше (см. «Остаток гонки»).
    const judgedStatus = typeof owned.project.status === 'string' ? owned.project.status : null;
    let deleteQuery = supabaseAdmin
      .from('he_projects')
      .delete()
      .eq('id', id)
      // Второй барьер к скоупу владельца, между чтением выше и удалением.
      .eq('created_by', result.auth.userId);
    deleteQuery = judgedStatus === null ? deleteQuery.is('status', null) : deleteQuery.eq('status', judgedStatus);
    const { data: deleted, error: deleteErr } = await deleteQuery.select('id');
    if (deleteErr) {
      return engServerError('client.eng.projects.delete_failed', deleteErr, PROJECT_DELETE_FAILED, {
        userId: result.auth.userId,
        projectId: id,
      });
    }
    // Ноль строк — проект исчез, сменил владельца или статус между снимком и
    // удалением. Перечитываем: нет проекта — 404; есть — он изменился, 409.
    if ((deleted ?? []).length === 0) {
      const again = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
      if (!again.ok) return jsonError(again.failure.message, again.failure.status);
      return refuse('changed', DELETE_CHANGED_TEXT);
    }

    // След для разбора «куда делся проект»: что именно ушло каскадом.
    void logAudit('client.eng.project.deleted', 'ENG cabinet project deleted', {
      userId: result.auth.userId,
      projectId: id,
      name: typeof owned.project.name === 'string' ? owned.project.name : null,
      websiteUrl: typeof owned.project.website_url === 'string' ? owned.project.website_url : null,
      status: typeof owned.project.status === 'string' ? owned.project.status : null,
      verticals: snapshot.verticals,
      bases: snapshot.bases,
      templates: snapshot.templates,
    });
    return NextResponse.json({ ok: true });
  });
}
