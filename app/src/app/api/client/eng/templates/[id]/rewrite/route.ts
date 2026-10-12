import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeTemplate,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import {
  HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS,
  heTemplateGenerationBudget,
} from '@/lib/hypothesisEngine/autopilotNext';
import {
  HE_JOB_CLIENT_COLUMNS,
  heTemplateNeedsRewrite,
  toClientEngJobRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { HE_SPEND_PAUSED_EN } from '@/lib/hypothesisEngine/clientErrors';
import {
  HE_TEMPLATE_LAUNCH_MARK_COLUMNS,
  heTemplateLaunchMarked,
  type HeTemplateLaunchMark,
} from '@/lib/hypothesisEngine/launchTemplate';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import { enforceHeSpendCeiling } from '@/lib/hypothesisEngine/spendCeiling';
import { engSendingSwitchRefusal } from '@/lib/hypothesisEngine/engSendingSwitchGuard';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const REWRITE_START_FAILED = 'Failed to start rewriting the letters';
const REWRITE_TRIES_FAILED = 'Failed to load how many letter-writing tries are left';
const REWRITE_NOT_RESEARCHED =
  'Letters are rewritten only on a project whose research has finished. Step 1 «Your business» shows its state.';
const REWRITE_NOT_READY = 'These letters are not finished yet, so there is nothing to rewrite.';
const REWRITE_AUDIENCE_NOT_READY =
  'The contacts for these letters are not ready, so the letters cannot be rewritten now. Refresh the page later.';
const REWRITE_LAUNCHED = 'These letters are already in a campaign, so they are not rewritten.';
const REWRITE_SIBLING_LAUNCHED = 'This market already has letters in a campaign, so these letters are not rewritten.';
const REWRITE_LETTERS_OK = 'These letters passed the automatic check, so they are not rewritten.';
const REWRITE_STARTING =
  'Sending for this market is starting right now, so its letters are not rewritten. Refresh the page in a few minutes.';
const REWRITE_EXHAUSTED =
  `All ${HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS} letter-writing tries for this audience are used, so the letters are ` +
  'not rewritten again. Message Support if you need new letters for it.';
const REWRITE_BUSY =
  'Letters for this market are being written right now, so these were not rewritten. Refresh the page in a few ' +
  'minutes to see them.';
const REWRITE_NEWER = 'Newer letters for this market already exist, so these were not rewritten. Refresh the page.';
const REWRITE_OTHER_READY =
  'This market has other final letters ready, so these were not rewritten. Message Support if you need new letters.';
const REWRITE_CHANGED = 'These letters changed while you pressed the button, so they were not rewritten. Refresh the page.';
const REWRITE_RACE_FINISHED = 'Another request for these letters has just finished. Refresh the page to see its result.';

/**
 * Таблица автозапуска (миграция 20261012_0001_he_eng_auto_launch.sql; то же
 * имя — HE_ENG_AUTO_LAUNCH_TABLE в engAutoLaunch.ts). Миграция пишется, но
 * не применяется вместе с кодом: пока таблицы (или колонки) нет, строки
 * автозапуска нет ни у одного шаблона — и «идёт запуск» роут не видит.
 */
const AUTO_LAUNCH_TABLE = 'he_eng_auto_launch';
const MISSING_RELATION_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204']);

/** Колонки шаблона: признак запуска (без самой записи — у недостроенного запуска в ней тысячи адресов) и письма. */
const TEMPLATE_COLUMNS = `${HE_TEMPLATE_LAUNCH_MARK_COLUMNS}, vertical_id, status, letters, personalization_plan, created_at`;
/** Соседи по рынку: только признак запуска, статус и порядок. */
const SIBLING_COLUMNS = `${HE_TEMPLATE_LAUNCH_MARK_COLUMNS}, status, created_at`;

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Попытки писем поколения анализа базы (heTemplateGenerationBudget) — то, что видит клиент. */
interface LettersTries {
  used: number;
  max: number;
  left: number;
}

async function readLettersTries(db: SupabaseClient, projectId: string, baseId: string): Promise<LettersTries> {
  const budget = await heTemplateGenerationBudget(db, { projectId, baseId });
  const max = HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS;
  return { used: budget.paidRuns, max, left: budget.allowed ? Math.max(0, max - budget.paidRuns) : 0 };
}

/** Активная (pending/running) template-джоба базы в клиентских колонках. */
async function findActiveTemplateJob(
  db: SupabaseClient,
  projectId: string,
  baseId: string,
): Promise<{ job: Row | null; error: unknown }> {
  const { data, error } = await db
    .from('he_jobs')
    .select(HE_JOB_CLIENT_COLUMNS)
    .eq('project_id', projectId)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (error) return { job: null, error };
  const job = ((data ?? []) as Row[]).find((j) => (j.payload as { base_id?: unknown } | null)?.base_id === baseId);
  return { job: job ?? null, error: null };
}

/** Автозапуск держит этот шаблон прямо сейчас: строка 'running' с живой арендой. */
async function autoLaunchStarting(
  db: SupabaseClient,
  templateId: string,
): Promise<{ starting: boolean; error: unknown }> {
  const { data, error } = await db
    .from(AUTO_LAUNCH_TABLE)
    .select('state, lease_until')
    .eq('template_id', templateId)
    .maybeSingle();
  if (error) {
    if (MISSING_RELATION_CODES.has(str((error as { code?: unknown }).code))) return { starting: false, error: null };
    return { starting: false, error };
  }
  const row = (data ?? null) as Row | null;
  if (!row || row.state !== 'running') return { starting: false, error: null };
  const until = Date.parse(str(row.lease_until));
  return { starting: Number.isFinite(until) && until > Date.now(), error: null };
}

function refusal(status: number, error: string, code: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

// GET — сколько попыток писем осталось у аудитории шаблона: тот же тормоз
// heTemplateGenerationBudget (HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS засчитанных
// прогонов на поколение анализа базы), что решает POST. Экран печатает число
// рядом с «Rewrite letters» (или Support, когда их 0). Попытка — засчитанный
// прогон генерации: упавший прогон воркер повторяет сам, и повтор тратит ещё
// одну, поэтому одно нажатие может съесть больше одной.
//
// Ответ — { tries_used, tries_max, tries_left }. Только чтение.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const db = supabaseAdmin;
  const { userId } = result.auth;

  const { id } = await params;
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);

  const gate = await requireEngMarket(db, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const owned = await loadClientHeTemplate(db, id, userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const { data: template, error: templateErr } = await db
    .from('he_templates')
    .select('id, base_id')
    .eq('id', id)
    .maybeSingle();
  if (templateErr) {
    return engServerError('client.eng.template_rewrite.tries_read_failed', templateErr, REWRITE_TRIES_FAILED, {
      userId,
      templateId: id,
    });
  }
  const baseId = str((template as Row | null)?.base_id);
  if (!baseId) return jsonError('Template not found', 404);

  try {
    const tries = await readLettersTries(db, owned.project.id as string, baseId);
    return NextResponse.json({ tries_used: tries.used, tries_max: tries.max, tries_left: tries.left });
  } catch (budgetErr) {
    return engServerError('client.eng.template_rewrite.tries_read_failed', budgetErr, REWRITE_TRIES_FAILED, {
      userId,
      templateId: id,
    });
  }
}

// POST — «Rewrite letters»: новые итоговые письма рынка вместо писем, которые
// автоматическая проверка запуска не пропустит (подстановка, которую база не
// наполнит — шаг 4b″ ядра запуска, код template_unresolved_operators).
//
// ПРОВЕРКА ТА ЖЕ, ЧТО У ЗАПУСКА, И ПО ТЕМ ЖЕ СТРОКАМ: heTemplateNeedsRewrite
// по ВСЕЙ базе шаблона (колонки + data), а не по sample_rows деталки. Иначе
// шаблон, который ядро отказало по строке дальше выборки (автозапуск держит
// его кодом letters_need_rewrite), получал бы здесь «letters passed» — тупик.
// Отсюда же безопасность от гонки с запуском: письма, которым этот роут
// разрешает перезапись, ядро откажет на 4b″ — до классификатора, до
// рассыльщика и до первой записи launch_info, — так что запустить их
// параллельно с перезаписью не может никто.
//
// ЧТО ДЕЛАЕТ. Шаблон 'ready' без записи о запуске переводится в 'failed'
// условной записью (CAS ready→failed where launch_info is null): эти письма
// запуститься не могут, а стадия template без форса возвращает ГОТОВЫЙ шаблон
// базы вместо генерации (stages/template.ts, findReusableTemplate), так что
// без снятия статуса новой генерации не было бы. Затем ставится обычная
// template-джоба по базе шаблона (без force): стадия пишет новые письма через
// тот же гейт подстановок, новый 'ready' шаблон становится кандидатом
// автозапуска. 'failed' у he_templates пишет только этот роут — значит
// 'failed' шаблон и есть письма, снятые перезаписью.
//
// ПОВТОР ПОСЛЕ НЕУДАЧНОЙ ПЕРЕЗАПИСИ. Если новая генерация упала, у базы
// остаётся только снятый шаблон, а реконсилер и дочейн считают «шаблон у базы
// есть» по ЛЮБОМУ статусу и новую генерацию не ставят. Поэтому роут принимает и
// снятый ('failed') шаблон — когда у рынка нет более новых готовых писем и
// генерация по базе не идёт; статус при этом не трогается.
//
// ТОРМОЗА (каждый — до денег): проект исследован; письма не в кампании, и ни
// одни письма рынка не в кампании (одна кампания на рынок — ядро откажет
// новым письмам sibling_template_launched); база проверена ('analyzed');
// генерация по базе не идёт (иначе 200 с ней для снятого шаблона, 409 для
// готового); автозапуск не держит шаблон прямо сейчас; бюджет писем поколения
// анализа (heTemplateGenerationBudget, HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS
// засчитанных прогонов); выключатель отправки аккаунта (engSendingSwitchRefusal,
// как у «Launch» проекта); гейт платных шагов ('letters'); потолок расхода.
// Отказы — 409 { error, code } с кодами not_ready | launched | letters_ok |
// starting | letters_exhausted | changed.
//
// Ответ 201 { ok, job, tries: { used, max } } — used: засчитанные прогоны ДО
// этой генерации. Генерация по базе уже стоит — 200 { ok, existing: true, job }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.template_rewrite.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const db = supabaseAdmin;
    const { userId } = result.auth;

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(db, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeTemplate(db, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
    const projectId = owned.project.id as string;
    const logContext = { userId, templateId: id, projectId };

    if (owned.project.status !== 'researched') return refusal(409, REWRITE_NOT_RESEARCHED, 'not_ready');

    const { data: templateData, error: templateErr } = await db
      .from('he_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (templateErr) {
      return engServerError('client.eng.template_rewrite.template_read_failed', templateErr, REWRITE_START_FAILED, logContext);
    }
    const template = (templateData ?? null) as unknown as Row | null;
    if (!template) return jsonError('Template not found', 404);
    const status = template.status;
    if (status !== 'ready' && status !== 'failed') return refusal(409, REWRITE_NOT_READY, 'not_ready');
    const retired = status === 'failed';
    const baseId = str(template.base_id);
    const verticalId = str(template.vertical_id);
    const nowMs = Date.now();
    if (heTemplateLaunchMarked(template as HeTemplateLaunchMark, nowMs)) {
      return refusal(409, REWRITE_LAUNCHED, 'launched');
    }

    // Соседи по рынку: запущенный сосед (одна кампания на рынок) или другие
    // готовые письма — перезапись этих писем ничего не даст: автозапуск берёт
    // самые новые готовые письма рынка, и пока эти сняты, ушли бы соседние, а
    // новым ядро откажет sibling_template_launched. Два готовых шаблона у рынка
    // бывают только после ручной работы сотрудника — поэтому Support.
    const { data: siblingData, error: siblingErr } = await db
      .from('he_templates')
      .select(SIBLING_COLUMNS)
      .eq('vertical_id', verticalId)
      .neq('id', id)
      .limit(200);
    if (siblingErr) {
      return engServerError('client.eng.template_rewrite.siblings_read_failed', siblingErr, REWRITE_START_FAILED, logContext);
    }
    const siblings = (siblingData ?? []) as unknown as Row[];
    if (siblings.some((s) => heTemplateLaunchMarked(s as HeTemplateLaunchMark, nowMs))) {
      return refusal(409, REWRITE_SIBLING_LAUNCHED, 'launched');
    }
    const createdMs = Date.parse(str(template.created_at));
    const readySiblings = siblings.filter((s) => s.status === 'ready');
    if (readySiblings.some((s) => retired || !(Date.parse(str(s.created_at)) <= createdMs))) {
      return refusal(409, REWRITE_NEWER, 'changed');
    }
    if (readySiblings.length > 0) return refusal(409, REWRITE_OTHER_READY, 'changed');

    // База шаблона — со строками: проверка писем идёт по ней целиком (см. шапку).
    const { data: baseData, error: baseErr } = await db
      .from('he_bases')
      .select('id, project_id, status, columns, data')
      .eq('id', baseId)
      .maybeSingle();
    if (baseErr) {
      return engServerError('client.eng.template_rewrite.base_read_failed', baseErr, REWRITE_START_FAILED, logContext);
    }
    const base = (baseData ?? null) as Row | null;
    if (!base || base.project_id !== projectId || base.status !== 'analyzed') {
      return refusal(409, REWRITE_AUDIENCE_NOT_READY, 'not_ready');
    }

    const active = await findActiveTemplateJob(db, projectId, baseId);
    if (active.error) {
      return engServerError('client.eng.template_rewrite.active_lookup_failed', active.error, REWRITE_START_FAILED, logContext);
    }
    if (active.job) {
      if (retired) return NextResponse.json({ ok: true, existing: true, job: toClientEngJobRow(active.job) });
      return refusal(409, REWRITE_BUSY, 'changed');
    }

    if (!retired) {
      const needsRewrite = heTemplateNeedsRewrite(
        template,
        { columns: base.columns, sample_rows: base.data },
        projectMarket(owned.project as { market?: string | null }),
      );
      if (!needsRewrite) return refusal(409, REWRITE_LETTERS_OK, 'letters_ok');
    }

    const auto = await autoLaunchStarting(db, id);
    if (auto.error) {
      return engServerError('client.eng.template_rewrite.auto_launch_read_failed', auto.error, REWRITE_START_FAILED, logContext);
    }
    if (auto.starting) return refusal(409, REWRITE_STARTING, 'starting');

    // Сбой чтения бюджета — отказ, а не «потрачено ноль» (HeAutopilotReadError).
    let tries: LettersTries;
    try {
      tries = await readLettersTries(db, projectId, baseId);
    } catch (budgetErr) {
      return engServerError('client.eng.template_rewrite.budget_read_failed', budgetErr, REWRITE_START_FAILED, logContext);
    }
    if (tries.left === 0) return refusal(409, REWRITE_EXHAUSTED, 'letters_exhausted');

    const switchRefusal = await engSendingSwitchRefusal(db, userId, projectId, 'client.eng.template_rewrite.sending_access_unread');
    if (switchRefusal) return switchRefusal;

    const access = await requireEngPaidAccess(db, userId, { action: 'letters' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    // Потолок расхода us-проекта (spendCeiling.ts; ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН) —
    // как у остальных платных кнопок: достигнут — генерацию не ставим.
    const spend = await enforceHeSpendCeiling(db, {
      projectId,
      market: owned.project.market ?? null,
      stage: 'template',
      path: 'client_button',
      baseId,
      verticalId,
      warn: (msg) => void logWarn('client.eng.template_rewrite.spend_unknown', msg, logContext),
    });
    if (!spend.allowed) return jsonError(HE_SPEND_PAUSED_EN, 409);

    // Снять готовые письма: условно, только если они всё ещё 'ready' и без
    // записи о запуске. Ноль строк — между проверками и записью шаблон
    // изменился (запуск записал launch_info, второй клик успел раньше).
    if (!retired) {
      const { data: retiredRows, error: retireErr } = await db
        .from('he_templates')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'ready')
        .is('launch_info', null)
        .select('id');
      if (retireErr) {
        return engServerError('client.eng.template_rewrite.retire_failed', retireErr, REWRITE_START_FAILED, logContext);
      }
      if ((retiredRows ?? []).length === 0) return refusal(409, REWRITE_CHANGED, 'changed');
    }

    const { data: job, error: jobErr } = await db
      .from('he_jobs')
      .insert({ project_id: projectId, stage: 'template', status: 'pending', payload: { base_id: baseId } })
      .select(HE_JOB_CLIENT_COLUMNS)
      .single();
    // 23505 — he_jobs_one_active_template_per_base: генерацию по базе между
    // проверкой и вставкой поставил другой запрос. Готового шаблона у базы
    // уже нет (снят выше), значит эта генерация и пишет новые письма —
    // отвечаем ею. Её уже нет — она успела закончиться: смотреть её итог.
    if (jobErr?.code === '23505') {
      const raced = await findActiveTemplateJob(db, projectId, baseId);
      if (raced.error) {
        return engServerError('client.eng.template_rewrite.active_lookup_failed', raced.error, REWRITE_START_FAILED, logContext);
      }
      if (raced.job) return NextResponse.json({ ok: true, existing: true, job: toClientEngJobRow(raced.job) });
      return refusal(409, REWRITE_RACE_FINISHED, 'changed');
    }
    if (jobErr || !job) {
      // Генерация не встала — вернуть письмам 'ready', как было до нажатия
      // (условно: только снятые этим нажатием и всё ещё без записи о запуске).
      // Не вышло — шаблон остаётся снятым, и следующее нажатие примет его как
      // снятый (см. шапку): тупика нет.
      if (!retired) {
        const { error: restoreErr } = await db
          .from('he_templates')
          .update({ status: 'ready', updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('status', 'failed')
          .is('launch_info', null);
        if (restoreErr) await logError('client.eng.template_rewrite.restore_failed', restoreErr, logContext);
      }
      return engServerError('client.eng.template_rewrite.enqueue_failed', jobErr, REWRITE_START_FAILED, logContext);
    }

    void logAudit('client.eng.template_rewrite.enqueued', 'ENG cabinet letters rewrite enqueued', {
      ...logContext,
      baseId,
      jobId: (job as Row).id,
      retiredNow: !retired,
      triesUsed: tries.used,
    });

    return NextResponse.json(
      { ok: true, job: toClientEngJobRow(job as Row), tries: { used: tries.used, max: tries.max } },
      { status: 201 },
    );
  });
}
