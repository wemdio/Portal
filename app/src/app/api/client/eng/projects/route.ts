import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { withToolTrace } from '@/lib/toolTrace';
import { engPaidAccessResponse, requireEngMarket, requireEngPaidAccess } from '@/lib/hypothesisEngine/apiGuards';
import { createEngProjectLocked, engCreateProjectUnavailableRefusal } from '@/lib/hypothesisEngine/engPaidAccess';
import { normalizeWebsiteInput } from '@/lib/hypothesisEngine/websiteUrl';
import { buildHeEngCreateBrief } from '@/lib/hypothesisEngine/projectBriefPatch';
import { heIcpFrameInputErrorText, parseHeIcpFramePatch, type HeIcpFramePatch } from '@/lib/hypothesisEngine/icpFrame';
import { enqueueHeResearchJob } from '@/lib/hypothesisEngine/researchJob';
import {
  HE_PROJECT_CLIENT_COLUMNS,
  toClientEngJobRow,
  toClientEngProjectRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { engServerError } from '../_shared';

export const dynamic = 'force-dynamic';
// normalizeWebsiteInput тянет node:url (domainToUnicode) — как у staff-роута.
export const runtime = 'nodejs';

/**
 * Клиентский ENG-контур «Движка вертикалей» (кабинет с EN-UI):
 * проекты всегда market='us' и строго свои (created_by = user id).
 * Рыночный гейт (ru-клиент сюда не ходит) — requireEngMarket. Создание проекта
 * сразу ставит ПЛАТНОЕ исследование, поэтому POST проходит и гейт платных
 * шагов (requireEngPaidAccess, действие 'create_project'): подтверждённая
 * почта, «один аккаунт — один сайт» (у клиента нет ни одного проекта) и
 * потолок расхода клиента (engPaidAccess.ts). «Один сайт» клиент проходит
 * второй раз под замком на пользователя, вместе со вставкой проекта и его
 * исследования (createEngProjectLocked); без функции под замком (миграция
 * 20261010_0002 не применена) клиенту — 503, без вставки: чтение без замка
 * пропускает параллельные создания. Удалить проект клиент не может —
 * DELETE у роута проекта нет. Оплаты (тарифа) ENG-продукта пока нет — гейт по
 * оплате появится вместе с ней.
 */

/** Тексты 5xx — константы контура: ни Postgres, ни провайдер наружу не едут. */
const PROJECTS_LOAD_FAILED = 'Failed to load your projects';
const PROJECT_CREATE_FAILED = 'Failed to create the project';
const RESEARCH_START_FAILED = 'Failed to start research';

/**
 * Строка в колонках `HE_PROJECT_CLIENT_COLUMNS` — та же форма, что отдаёт
 * `.select(HE_PROJECT_CLIENT_COLUMNS)`: функция под замком возвращает строку
 * he_projects целиком, а проектор по наличию ключей (`brief`,
 * `autopilot_error`) добавил бы в ответ создания поля, которых в нём не было.
 */
function inClientProjectColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of HE_PROJECT_CLIENT_COLUMNS.split(',')) {
    const key = column.trim();
    if (key in row) out[key] = row[key];
  }
  return out;
}

/** 201 создания: проект, только что поставленный в research, и его джоба. */
function projectCreatedResponse(
  userId: string,
  websiteUrl: string,
  project: Record<string, unknown>,
  job: Record<string, unknown>,
): NextResponse {
  void logAudit('client.eng.projects.created', 'ENG cabinet project created', {
    userId,
    projectId: project.id,
    websiteUrl,
  });

  return NextResponse.json(
    {
      // Проекция как у деталки: в строке из insert().select() едут
      // cost_usd/tokens_used/llm_model, кабинету они не нужны. Причина
      // падения — код (`error_code`), а не текст стадии; у свежего проекта
      // её нет.
      project: {
        ...toClientEngProjectRow(project),
        status: 'researching',
        error_code: null,
      },
      // Строку джобы оба пути читают целиком (enqueueHeResearchJob —
      // researchJob.ts:50, функция под замком — to_jsonb) — сужаем на границе
      // контура.
      job: toClientEngJobRow(job),
    },
    { status: 201 },
  );
}

// GET — список СВОИХ проектов со счётчиками вертикалей и баз.
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  // Тот же белый список, что и у проектора: свой набор колонок в роуте — это
  // копия, которая рано или поздно разойдётся. `created_by` из выборки убран:
  // он только фильтр (ниже), в ответе его никто не читал.
  const { data: projects, error } = await supabaseAdmin
    .from('he_projects')
    .select(HE_PROJECT_CLIENT_COLUMNS)
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return engServerError('client.eng.projects.list_failed', error, PROJECTS_LOAD_FAILED, { userId });

  const rows = projects ?? [];
  const verticalCounts = new Map<string, number>();
  const baseCounts = new Map<string, number>();
  if (rows.length > 0) {
    const ids = rows.map((p) => p.id as string);
    const [verticalsRes, basesRes] = await Promise.all([
      supabaseAdmin.from('he_verticals').select('project_id').in('project_id', ids),
      supabaseAdmin.from('he_bases').select('project_id').in('project_id', ids),
    ]);
    if (verticalsRes.error) {
      return engServerError('client.eng.projects.list_failed', verticalsRes.error, PROJECTS_LOAD_FAILED, { userId });
    }
    if (basesRes.error) {
      return engServerError('client.eng.projects.list_failed', basesRes.error, PROJECTS_LOAD_FAILED, { userId });
    }
    for (const v of verticalsRes.data ?? []) {
      const pid = v.project_id as string;
      verticalCounts.set(pid, (verticalCounts.get(pid) ?? 0) + 1);
    }
    for (const b of basesRes.data ?? []) {
      const pid = b.project_id as string;
      baseCounts.set(pid, (baseCounts.get(pid) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    projects: rows.map((p) => ({
      ...toClientEngProjectRow(p as Record<string, unknown>),
      vertical_count: verticalCounts.get(p.id as string) ?? 0,
      base_count: baseCounts.get(p.id as string) ?? 0,
    })),
  });
}

// POST — создать проект { website_url, name?, business_override?, icp? }:
// market='us' принудительно, имя по умолчанию — hostname; research
// (site_profile) ставится сразу, чтобы мастер кабинета начинал с прогресса
// исследования. business_override и icp — ответы формы создания, которые
// читает само исследование (buildHeEngCreateBrief, projectBriefPatch.ts):
// повторить его кликом клиент не может, поэтому они нужны до старта и
// ложатся в he_projects.brief той же вставкой, что и проект.
export async function POST(req: NextRequest) {
  // Трассируем только мутирующие роуты кабинета: withToolTrace — это INSERT +
  // UPDATE в trace_spans вокруг каждого запроса, а мастер и дашборд поллят
  // свои GET'ы каждые 4 и 15 секунд (EngProjectWizard/EngDashboard).
  return withToolTrace({ request: req, operation: 'client.eng.projects.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { userId } = result.auth;
    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    let body: { website_url?: unknown; name?: unknown; business_override?: unknown; icp?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }

    const rawUrl = typeof body?.website_url === 'string' ? body.website_url : '';
    const normalized = normalizeWebsiteInput(rawUrl);
    if (!normalized) {
      return jsonError('Invalid website_url — enter the domain or URL of your site', 400);
    }

    const name =
      typeof body?.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 300)
        : normalized.hostname;

    // Ответы для исследования — до гейта и до БД, строго: лишнее отклоняется,
    // а не режется молча. Тексты отказов — те же, что у PATCH проекта; форма
    // кабинета проверяет те же лимиты до отправки.
    let icpPatch: HeIcpFramePatch | null | undefined;
    if (body?.icp !== undefined) {
      const parsed = parseHeIcpFramePatch(body.icp);
      if (!parsed.ok) return jsonError(heIcpFrameInputErrorText(parsed.error), 400);
      icpPatch = parsed.patch;
    }
    const built = buildHeEngCreateBrief(body, { icp: icpPatch });
    if (!built.ok) {
      return built.error.code === 'bad_type'
        ? jsonError(`${built.error.field} must be a string`, 400)
        : jsonError(`${built.error.field}: maximum ${built.error.max} characters`, 413);
    }
    const brief = built.brief;

    // ДО вставки he_projects: проект, вставленный до отказа, сам занял бы
    // единственное место аккаунта. Здесь проверки читают, а не бронируют.
    const access = await requireEngPaidAccess(supabaseAdmin, userId, { action: 'create_project' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    // Клиент (access.limits) — «один сайт» решается ещё раз ПОД ЗАМКОМ на
    // пользователя, и проект с брифом и его site_profile вставляется той же
    // транзакцией (he_eng_create_project, миграция 20261010_0002): из N
    // одновременных запросов проходит один, остальные получают тот же отказ.
    // Функции нет (миграция не применена) — клиенту 503 'unavailable', и
    // НИЧЕГО не вставляется: «один аккаунт — один сайт» — жёсткое правило, а
    // чтение выше без замка пропускает параллельные создания (двойной клик —
    // два проекта и два платных исследования). Прежний путь ниже — только для
    // сотрудника (limits === null): лимитов у него нет, гонке нечего нарушать.
    if (access.limits) {
      const locked = await createEngProjectLocked(supabaseAdmin, userId, {
        name,
        websiteUrl: normalized.url,
        brief,
      });
      if (locked.kind === 'refused') return engPaidAccessResponse(locked.refusal);
      if (locked.kind === 'rpc_missing') return engPaidAccessResponse(engCreateProjectUnavailableRefusal(userId));
      if (locked.kind === 'error') {
        return engServerError('client.eng.projects.create_failed', new Error(locked.message), PROJECT_CREATE_FAILED, {
          userId,
        });
      }
      return projectCreatedResponse(userId, normalized.url, inClientProjectColumns(locked.project), locked.job);
    }

    // Сотрудник (отладка ENG-кабинета): прежний путь — вставка, затем
    // постановка исследования отдельной записью.
    const { data: project, error } = await supabaseAdmin
      .from('he_projects')
      .insert({
        created_by: userId,
        name,
        website_url: normalized.url,
        status: 'draft',
        market: 'us',
        // Ответов нет — ключа нет, колонка пустая, как до этой правки.
        ...(brief ? { brief } : {}),
      })
      .select(HE_PROJECT_CLIENT_COLUMNS)
      .single();
    if (error || !project) {
      return engServerError('client.eng.projects.create_failed', error, PROJECT_CREATE_FAILED, { userId });
    }

    // Для свежего проекта активных research-джоб нет — конфликт невозможен,
    // но постановку делаем тем же helper'ом, что и повтор research («Try again»). Unique
    // index he_jobs_one_active_site_profile этого не меняет: id проекта только
    // что выдан gen_random_uuid(), сослаться на него никакая джоба не может.
    const enqueue = await enqueueHeResearchJob(supabaseAdmin, project.id as string);
    if (!enqueue.ok) {
      // `message` есть только у reason:'db'; у 'conflict' его нет, и
      // `new Error(undefined)` записал бы в журнал пустую причину.
      return engServerError(
        'client.eng.projects.research_enqueue_failed',
        new Error(enqueue.message ?? `research enqueue refused: ${enqueue.reason}`),
        RESEARCH_START_FAILED,
        { userId, projectId: project.id },
      );
    }

    return projectCreatedResponse(userId, normalized.url, project as Record<string, unknown>, enqueue.job);
  });
}
