import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
// «Блип БД или приговор» — нейтральный предикат (lib/db/transientError.ts).
import { isTransientDbError } from '@/lib/db/transientError';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const MAX_ROWS = 10000;
const SAMPLE_ROWS = 30;

/**
 * Повторы вставки джобы анализа при блипе БД: паузы 300мс → 600мс, всего ≤0,9 с
 * при maxDuration 30 с — в бюджет ответа укладывается с запасом.
 */
const ANALYZE_ENQUEUE_ATTEMPTS = 3;
const ANALYZE_ENQUEUE_RETRY_MS = 300;

// POST — загрузка базы специалиста под вертикаль (строки парсятся из CSV/XLSX
// на клиенте, как в /client/launch). После сохранения ставится стадия
// base_analyze — профиль базы считает воркер.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.bases.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: {
        vertical_id?: unknown;
        filename?: unknown;
        columns?: unknown;
        rows?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const verticalId = typeof body?.vertical_id === 'string' ? body.vertical_id : '';
      if (!verticalId) return jsonError('Укажите vertical_id', 400);

      const columns = Array.isArray(body?.columns)
        ? (body.columns as unknown[]).filter((c): c is string => typeof c === 'string')
        : null;
      if (!columns || columns.length === 0) {
        return jsonError('columns должен быть непустым массивом строк', 400);
      }

      if (!Array.isArray(body?.rows) || body.rows.length === 0) {
        return jsonError('rows должен быть непустым массивом объектов', 400);
      }
      const rows = body.rows as Array<Record<string, unknown>>;
      if (rows.length > MAX_ROWS) {
        return jsonError(`Слишком много строк: ${rows.length}. Максимум — ${MAX_ROWS}`, 413);
      }

      const filename =
        typeof body?.filename === 'string' && body.filename.trim()
          ? body.filename.trim().slice(0, 500)
          : null;

      // Проект существует?
      const { error: projErr } = await supabaseAdmin
        .from('he_projects')
        .select('id')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      // Вертикаль принадлежит именно этому проекту?
      const { error: vertErr } = await supabaseAdmin
        .from('he_verticals')
        .select('id')
        .eq('id', verticalId)
        .eq('project_id', id)
        .single();
      if (vertErr) {
        return jsonError(
          vertErr.code === 'PGRST116' ? 'Вертикаль не найдена в этом проекте' : vertErr.message,
          vertErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('he_bases')
        .insert({
          project_id: id,
          vertical_id: verticalId,
          filename,
          row_count: rows.length,
          columns,
          sample_rows: rows.slice(0, SAMPLE_ROWS),
          data: rows,
          status: 'uploaded',
        })
        .select('id, status')
        .single();
      if (baseErr || !base) {
        await logError('tools.hypothesis-engine.bases.insert_failed', baseErr, { userId, projectId: id });
        return jsonError(baseErr?.message ?? 'Не удалось сохранить базу', 500);
      }

      /**
       * Постановка анализа при БЛИПЕ БД повторяется, а при постоянном отказе —
       * компенсируется.
       *
       * База и её джоба анализа — две вставки в две таблицы, транзакции у
       * PostgREST нет. Строка базы при этом уже полностью готова (строки,
       * колонки, row_count), то есть порядок «сначала джоба» здесь невозможен:
       * payload джобы требует id базы. Значит остаётся повторить саму вставку,
       * пока отказ похож на блип — но КАЖДЫЙ повтор сперва проверяет, не легла
       * ли предыдущая (см. ниже: потерянный ответ шлюза не значит, что INSERT
       * не закоммитился).
       *
       * Повтор вставки здесь СВОЙ: постановка авто-сборки
       * (lib/hypothesisEngine/baseCollectEnqueue) его не делает — её вставка
       * одна, а гонку за неё держит уникальный индекс вертикали ('existing' на
       * 23505). Общее с ней другое и главное: перед компенсацией базы она
       * перечитывает джобы, потому что «неизвестно» ≠ «не легла».
       *
       * Дальше два РАЗНЫХ исхода, и путать их нельзя:
       *  - дедуп ОТВЕТИЛ и джобы нет → вставка действительно не легла: базу
       *    компенсируем терминальным статусом (CAS по 'uploaded'), чтобы она не
       *    осталась в мастере вечным «в процессе» без единой джобы. Строки при
       *    этом не теряются: они остаются в he_bases, специалист загружает файл
       *    заново и получает рабочую базу;
       *  - дедуп НЕ ОТВЕТИЛ (сбой чтения) → «легла ли» осталось НЕИЗВЕСТНЫМ, и
       *    базу не трогаем вовсе. Если вставка всё-таки закоммитилась, воркер
       *    заберёт джобу, оплатит модель и напишет базе 'analyzed' — а
       *    компенсация в 'failed' сказала бы специалисту неправду («анализ не
       *    поставлен»), он залил бы файл заново и получил вторую базу и ВТОРОЙ
       *    платный анализ. Ответ поэтому говорит именно то, что известно:
       *    подтвердить постановку не удалось, сначала проверьте список баз.
       */
      let jobErrMsg: string | null = null;
      /** Дедуп не ответил: «легла ли вставка» неизвестно — не компенсируем. */
      let enqueueUnconfirmed = false;
      /** Последний отказ вставки похож на блип: ответ мог потеряться. */
      let lastErrTransient = false;
      for (let attempt = 1; attempt <= ANALYZE_ENQUEUE_ATTEMPTS; attempt += 1) {
        /**
         * ПЕРЕД повтором проверяем, не легла ли предыдущая вставка.
         *
         * Транзиентный отказ шлюза (502/504, обрыв соединения) означает «ответ
         * потерян», а НЕ «строка не вставилась»: INSERT мог закоммититься на
         * сервере. Строку base_analyze не держит ни одно уникальное ограничение
         * (у he_jobs их два: PK по id и partial unique index
         * he_jobs_one_active_site_profile этой же волны, который покрывает
         * ТОЛЬКО стадию site_profile), поэтому слепой повтор давал бы ВТОРУЮ
         * джобу base_analyze, а это второй ПЛАТНЫЙ вызов модели:
         * stages/baseAnalyze.ts гейта готовности не имеет — безусловно ставит
         * базе 'analyzing', платит и пишет 'analyzed'.
         * При включённом автопилоте к нему добавился бы и второй платный
         * template: afterBaseAnalyzeDone дедупит только АКТИВНЫЕ template-джобы,
         * а первая к тому моменту уже завершена.
         *
         * Статус джобы в проверке не участвует намеренно: база создана этой же
         * обработкой запроса, поэтому любая джоба base_analyze по её base_id
         * может быть только той, которую мы сейчас вставляем.
         */
        if (attempt > 1) {
          const { data: landed, error: dedupErr } = await supabaseAdmin
            .from('he_jobs')
            .select('id')
            .eq('project_id', id)
            .eq('stage', 'base_analyze')
            .eq('payload->>base_id', base.id)
            .limit(1);
          // «Неизвестно» ≠ «не легла»: без ответа дедупа не вставляем (второй
          // оплаченный анализ дороже отказа загрузки) и не компенсируем базу —
          // ровно потому же, см. докблок выше.
          if (dedupErr) {
            jobErrMsg = `${jobErrMsg ?? 'unknown'}; he_jobs base_analyze dedup read: ${dedupErr.message}`;
            enqueueUnconfirmed = true;
            break;
          }
          if ((landed ?? []).length > 0) {
            jobErrMsg = null;
            break;
          }
        }
        const { error } = await supabaseAdmin
          .from('he_jobs')
          .insert({
            project_id: id,
            stage: 'base_analyze',
            status: 'pending',
            payload: { base_id: base.id },
          });
        if (!error) {
          jobErrMsg = null;
          break;
        }
        jobErrMsg = error.message;
        lastErrTransient = isTransientDbError(error);
        if (attempt >= ANALYZE_ENQUEUE_ATTEMPTS || !lastErrTransient) break;
        await new Promise((r) => setTimeout(r, ANALYZE_ENQUEUE_RETRY_MS * attempt));
      }
      /**
       * ПОСЛЕДНЯЯ попытка подтверждения не получала: проверка «не легла ли
       * предыдущая вставка» стоит в начале СЛЕДУЮЩЕЙ итерации, а после
       * последней итерации её нет. Между тем потерянный ответ шлюза на
       * последней вставке — тот же случай, что и на первых: INSERT мог
       * закоммититься. Поэтому при похожем на блип отказе перечитываем джобы
       * ещё раз, ПЕРЕД компенсацией: иначе база с живой джобой анализа
       * получила бы 'failed', а специалист — неправду «анализ не поставлен».
       * При ПОСТОЯННОМ отказе (строка лечь не могла) чтения нет: лишний select
       * на этом пути ничего не решает, а сбой этого чтения отменил бы
       * компенсацию, которая здесь правильна.
       */
      if (jobErrMsg && !enqueueUnconfirmed && lastErrTransient) {
        const { data: landed, error: dedupErr } = await supabaseAdmin
          .from('he_jobs')
          .select('id')
          .eq('project_id', id)
          .eq('stage', 'base_analyze')
          .eq('payload->>base_id', base.id)
          .limit(1);
        if (dedupErr) {
          jobErrMsg = `${jobErrMsg}; he_jobs base_analyze dedup read: ${dedupErr.message}`;
          enqueueUnconfirmed = true;
        } else if ((landed ?? []).length > 0) {
          jobErrMsg = null;
        }
      }
      if (jobErrMsg) {
        await logError(
          enqueueUnconfirmed
            ? 'tools.hypothesis-engine.bases.enqueue_unconfirmed'
            : 'tools.hypothesis-engine.bases.enqueue_failed',
          new Error(jobErrMsg),
          { userId, projectId: id, baseId: base.id },
        );
        if (enqueueUnconfirmed) {
          // Базу НЕ трогаем: она могла остаться с живой джобой анализа. Ответ
          // говорит ровно то, что известно, — иначе специалист перезальёт файл и
          // оплатит второй анализ той же базы.
          return jsonError(
            `База сохранена, но постановку анализа не удалось подтвердить: ${jobErrMsg}. ` +
              'Проверьте список баз проекта перед повторной загрузкой: если анализ уже идёт, ' +
              'повторная загрузка создаст вторую базу и второй платный анализ.',
            500,
          );
        }
        // CAS по 'uploaded': если базу уже увели (параллельная правка) — не
        // перетираем. Сбой самой компенсации только логируем: ответ специалисту
        // и так отказ, и он один и тот же.
        const { error: cleanupErr } = await supabaseAdmin
          .from('he_bases')
          .update({
            status: 'failed',
            error: `he_jobs base_analyze enqueue: ${jobErrMsg}`.slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq('id', base.id)
          .eq('status', 'uploaded');
        if (cleanupErr) {
          await logError('tools.hypothesis-engine.bases.cleanup_failed', cleanupErr, {
            userId,
            projectId: id,
            baseId: base.id,
          });
        }
        return jsonError(`База сохранена, но анализ не поставлен: ${jobErrMsg}`, 500);
      }

      void logAudit('tools.hypothesis-engine.bases.uploaded', 'Hypothesis engine base uploaded', {
        userId,
        projectId: id,
        baseId: base.id,
        verticalId,
        rowCount: rows.length,
      });

      return NextResponse.json({ base }, { status: 201 });
    },
  );
}
