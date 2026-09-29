import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { stripTaskHarvest } from '@/lib/hypothesisEngine/projectDetail';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/** Причина в he_bases.error у базы, которую остановила отмена клиентом. */
const CANCELLED_BY_USER = 'Cancelled by user';

/**
 * Сколько отменённых баз чистит ОДИН запрос отмены (см. dropCancelledBaseHarvest).
 *
 * Уборка идёт ВНУТРИ пользовательского запроса, а весит она как данные, которые
 * читает: `collect_info` базы, отменённой посреди сборки, — до 10,26 МБ (лимит
 * кабинета 10 000 компаний, 4 задачи плана). У проекта с четырьмя такими базами
 * неограниченный проход тянул ≈41 МБ jsonb и столько же отправлял назад, а своего
 * срока у роута нет: на медленном канале клиент увидел бы отказ отмены, хотя сама
 * отмена уже записана (джобы и статусы пишутся ДО уборки).
 *
 * Две базы за вызов — это ≤20,5 МБ, причём читаются они по одной (см. ниже), то
 * есть разом в памяти лежит не больше одной. Кто добирает остальные: следующая
 * отмена этого же проекта — барьер уборки (`status='failed'` +
 * `error='Cancelled by user'`) держится вечно, и база остаётся её кандидатом,
 * пока харвест не снят. Ночного прохода, который делал бы это сам, в движке нет
 * (heAutoPipelineCron `collect_info` не трогает) — то есть база, до которой этот
 * вызов не дошёл, весит ровно столько же, сколько весила ДО волны 4b, и не больше.
 */
const CANCEL_HARVEST_CLEANUP_BASES = 2;

/**
 * Сколько отменённых баз проекта ОСМАТРИВАЕТСЯ за вызов (см. ниже, почему это
 * отдельное число от бюджета обрезки). Осмотр уже чистой базы — чтение 3,3 КБ;
 * двадцать пять таких — 82 КБ, и столько отменённых авто-баз у одного проекта
 * ещё не было: в вертикали одновременно собирается одна база
 * (he_bases_one_collecting_per_vertical).
 */
const CANCEL_HARVEST_SCAN_BASES = 25;

/**
 * POST — отменить все активные задачи СВОЕГО проекта (research, цепочки,
 * сборка/анализ баз, шаблоны). Зеркалит staff-роут: pending/running джобы →
 * 'cancelled', базы 'collecting'/'analyzing' → 'failed' («Cancelled by user»),
 * проект 'researching' → 'draft' (исследование можно запустить заново).
 * Уже завершённые джобы и готовые артефакты не трогаем.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.cancel.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const now = new Date().toISOString();
    const { data: cancelledJobs, error: jobsErr } = await supabaseAdmin
      .from('he_jobs')
      .update({ status: 'cancelled', finished_at: now, updated_at: now })
      .eq('project_id', id)
      .in('status', ['pending', 'running'])
      .select('id');
    if (jobsErr) {
      return engServerError('client.eng.cancel.jobs_failed', jobsErr, 'Failed to cancel the running jobs', {
        userId: result.auth.userId,
        projectId: id,
      });
    }
    const cancelled = (cancelledJobs ?? []).length;
    if (cancelled === 0) {
      return jsonError('No active jobs — nothing to cancel', 409);
    }

    // Базы, которые ждали отменённые джобы, — в failed, чтобы не висели «в
    // работе» вечно и не держали слот автосборки вертикали.
    const { error: basesErr } = await supabaseAdmin
      .from('he_bases')
      .update({ status: 'failed', error: CANCELLED_BY_USER, updated_at: now })
      .eq('project_id', id)
      .in('status', ['collecting', 'analyzing']);
    if (basesErr) {
      await logError('client.eng.cancel.bases_failed', basesErr, { userId: result.auth.userId, projectId: id });
    } else {
      await dropCancelledBaseHarvest(id, result.auth.userId);
    }

    // Research-пайплайн отменён — проект можно запустить заново с шага Brief.
    if ((owned.project as { status?: string }).status === 'researching') {
      const { error: updErr } = await supabaseAdmin
        .from('he_projects')
        .update({ status: 'draft', error: null, updated_at: now })
        .eq('id', id);
      if (updErr) {
        await logError('client.eng.cancel.project_failed', updErr, { userId: result.auth.userId, projectId: id });
      }
    }

    void logAudit('client.eng.cancelled', 'ENG cabinet project jobs cancelled', {
      userId: result.auth.userId,
      projectId: id,
      cancelled,
    });

    return NextResponse.json({ ok: true, cancelled });
  });
}

/**
 * Снять `collect_info.tasks[].harvest` с баз, остановленных отменой.
 *
 * Зачем. Отменённая база остаётся в проекте навсегда, а деталка кабинета
 * перечитывает `collect_info` ВСЕХ баз проекта каждые 4 секунды. У базы,
 * отменённой посреди сборки, там лежит предмерж-харвест задач: замер на форме,
 * которую пишет стадия, — 10,26 МБ при лимите 10 000 и четырёх задачах плана
 * (у staff-лимита 50 000 это до 82 МБ, но staff отменяет своим роутом). Наружу
 * из него не уходит ни байта — и дашборд, и деталка режут харвест на выходе, —
 * то есть эти мегабайты пересылаются из БД в Node на каждый полл до конца
 * жизни проекта.
 *
 * Почему это ничего не переплачивает: харвест — чекпойнт НЕЗАВЕРШЁННОЙ сборки,
 * а start-guard стадии требует статус 'collecting' (база уже 'failed'), а
 * автоподъём (`he_auto_resume_transient_bases`) базу с отменённой джобой
 * исключает навсегда — по статусу джобы, а не по тексту. Повторный сбор
 * клиент запускает кнопкой, и она создаёт НОВУЮ базу.
 *
 * Fail-soft: отмена к этому моменту уже состоялась (джобы и статусы
 * записаны), и неудачная уборка объёма не должна превращаться в отказ отмены —
 * поэтому ошибки только журналируются. `updated_at` НЕ трогаем: он должен
 * остаться временем отмены, а не уборки.
 *
 * Проход ОГРАНИЧЕН и идёт от самых свежих: `updated_at` только что стал временем
 * отмены у всех баз, которые остановил ЭТОТ запрос, поэтому первыми чистятся
 * именно они — те, чей харвест максимален и чью деталку клиент прямо сейчас
 * поллит. Ограничений два, и они разные:
 *  - CANCEL_HARVEST_CLEANUP_BASES — сколько баз реально ОБРЕЗАЕТСЯ за вызов. Это
 *    и есть бюджет объёма;
 *  - CANCEL_HARVEST_SCAN_BASES — сколько кандидатов вообще ОСМАТРИВАЕТСЯ. Уже
 *    обрезанная база остаётся кандидатом навсегда (барьер уборки — только статус
 *    и текст причины), и если бы она тратила бюджет, лишние базы одной большой
 *    отмены не дочистились бы никогда: следующий вызов раз за разом упирался бы в
 *    те же две самые свежие. Осмотр чистой базы стоит 3,3 КБ и бюджета НЕ тратит,
 *    поэтому очередь честно доходит до жирных.
 *
 * `collect_info` читается ПО ОДНОЙ базе (список — только id), иначе в памяти
 * роута оказывались бы все жирные строки сразу; на обычной отмене это два чтения
 * и два обрезающих запроса. Частичный проход безопасен: функция идемпотентна
 * (второй раз снимать нечего — см. проверку идентичности ниже).
 */
async function dropCancelledBaseHarvest(projectId: string, userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from('he_bases')
    .select('id')
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'failed')
    .eq('error', CANCELLED_BY_USER)
    .order('updated_at', { ascending: false })
    // Детерминированный порядок внутри одной отмены: `updated_at` у её баз
    // совпадает до миллисекунды.
    .order('created_at', { ascending: false })
    .limit(CANCEL_HARVEST_SCAN_BASES);
  if (error) {
    await logError('client.eng.cancel.harvest_read_failed', error, { userId, projectId });
    return;
  }
  let trimmed = 0;
  for (const row of data ?? []) {
    if (trimmed >= CANCEL_HARVEST_CLEANUP_BASES) break;
    const baseId = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null;
    if (!baseId) continue;
    const { data: full, error: readErr } = await supabaseAdmin
      .from('he_bases')
      .select('collect_info')
      .eq('id', baseId)
      .maybeSingle();
    if (readErr) {
      await logError('client.eng.cancel.harvest_read_failed', readErr, { userId, projectId, baseId });
      continue;
    }
    const info = (full as { collect_info?: unknown } | null)?.collect_info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    // `stripTaskHarvest` отдаёт ТОТ ЖЕ объект, когда харвеста нет, — по
    // идентичности и решаем, нужна ли запись: у баз, отменённых до этой правки
    // или ещё до фазы сбора, запроса не будет.
    const thin = stripTaskHarvest({ collect_info: info });
    if (thin.collect_info === info) continue;
    trimmed += 1;
    const { error: writeErr } = await supabaseAdmin
      .from('he_bases')
      .update({ collect_info: thin.collect_info })
      .eq('id', baseId)
      // Второй барьер между чтением и записью: пишем только пока база всё ещё
      // отменена — иначе уборка могла бы обрезать чекпойнт ожившей сборки.
      .eq('status', 'failed')
      .eq('error', CANCELLED_BY_USER);
    if (writeErr) {
      await logError('client.eng.cancel.harvest_write_failed', writeErr, { userId, projectId, baseId });
    }
  }
}
