import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
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
import {
  patchHeProjectBrief,
  type HeBriefPatchBody,
} from '@/lib/hypothesisEngine/projectBriefPatch';
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
 * Тело PATCH: поля брифа (общие со staff) плюс настройка проекта «до N адресов
 * одной компании». Значение приходит `unknown` — проверяет его нормализатор
 * сборки, а не тип запроса.
 */
type EngProjectPatchBody = HeBriefPatchBody & { max_emails_per_company?: unknown };

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
  'Provide offer_override, style_override, signature_override, business_override or max_emails_per_company';

// GET — деталка СВОЕГО проекта (та же сборка, что у staff-роута, но со скоупом
// владельца: чужой проект отвечает 404, существование не раскрываем) —
// суженная клиентской проекцией. Поллится каждые 4 секунды из мастера, поэтому
// withToolTrace здесь НЕТ: два лишних запроса к trace_spans на каждый полл.
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

  // Белый список полей: себестоимость, модели, план сорсинга и id внутренних
  // джоб в кабинет не едут (lib/hypothesisEngine/clientEngProjection).
  return NextResponse.json({
    ...toClientEngProjectDetail(detail.detail),
    ...(busyRes.error ? {} : { has_active_jobs: (busyRes.data ?? []).length > 0 }),
  });
}

// PATCH — offer_override / style_override / signature_override / business_override мержатся в
// he_projects.brief (та же логика, что у staff, со скоупом владельца до записи),
// max_emails_per_company пишется колонкой проекта.
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

    // Поля брифа мержит общий со staff `patchHeProjectBrief`, и он же отвечает
    // `no_fields` на пустое тело. Звать его на запрос ТОЛЬКО с настройкой
    // нельзя — вернул бы 400 на корректный запрос, поэтому наличие полей
    // брифа роут проверяет сам.
    const briefRequested = body?.offer_override !== undefined
      || body?.style_override !== undefined
      || body?.signature_override !== undefined
      || body?.business_override !== undefined;
    if (!capRequested && !briefRequested) return jsonError(NO_FIELDS, 400);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

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
    if (!briefRequested) return NextResponse.json({ project: toClientEngProjectRow(projectRow) });

    const patch = await patchHeProjectBrief(supabaseAdmin, id, body);
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
