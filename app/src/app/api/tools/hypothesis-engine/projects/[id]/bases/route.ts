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

/**
 * HTTP-статусы ответа на вставку, при которых ОТВЕТА PostgREST мы не получили
 * и судьба INSERT неизвестна: 0 — запрос оборвался у нас (обрыв сети, отмена,
 * собственный срок fetch клиента supabaseAdmin; postgrest-js отдаёт такой
 * отказ со status 0), 502 и 504 — шлюз потерял или не дождался ответа уже
 * переданного запроса, и PostgREST мог закоммитить строку позже. Любой другой
 * статус — ответ самого PostgREST, а отказ PostgREST означает откат его
 * транзакции: строки нет.
 *
 * Вопрос здесь ДРУГОЙ, чем у isTransientDbError («стоит ли повторить запрос»),
 * и путать их нельзя: тот предикат по тексту узнаёт одни тела шлюза и не
 * узнаёт другие (таймаут клиента supabaseAdmin блипом не считает вовсе), а
 * после любого из этих статусов строка может лечь ПОЗЖЕ — и пустое
 * перечитывание сразу после отказа этого не опровергает. Поэтому такой отказ
 * и не повторяется, и не компенсируется (см. цикл ниже).
 */
const INSERT_OUTCOME_UNKNOWN_STATUSES = new Set([0, 502, 504]);

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
       * Постановка анализа при БЛИПЕ БД повторяется, при постоянном отказе —
       * компенсируется, а при отказе без ответа PostgREST — ни то, ни другое.
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
       *  - дедуп ОТВЕТИЛ, джобы нет, И на КАЖДУЮ вставку ответил сам PostgREST
       *    (ни одного статуса из INSERT_OUTCOME_UNKNOWN_STATUSES) →
       *    вставка действительно не легла: базу компенсируем терминальным
       *    статусом (CAS по 'uploaded'), чтобы она не осталась в мастере вечным
       *    «в процессе» без единой джобы. Строки при этом не теряются: они
       *    остаются в he_bases, специалист загружает файл заново и получает
       *    рабочую базу;
       *  - дедуп НЕ ОТВЕТИЛ (сбой чтения) ИЛИ хотя бы на одну вставку ответа
       *    PostgREST не было вовсе (обрыв, таймаут клиента, 502/504 шлюза) →
       *    «легла ли» осталось НЕИЗВЕСТНЫМ, и базу не трогаем вовсе. Если
       *    вставка всё-таки закоммитилась, воркер заберёт джобу, оплатит модель
       *    и напишет базе 'analyzed' — а компенсация в 'failed' сказала бы
       *    специалисту неправду («анализ не поставлен»), он залил бы файл
       *    заново и получил вторую базу и ВТОРОЙ платный анализ. Ответ поэтому
       *    говорит именно то, что известно: подтвердить постановку не удалось,
       *    сначала проверьте список баз. Цена: при настоящем обрыве база
       *    остаётся 'uploaded' без джобы — так, как она оставалась при любом
       *    сбое постановки до этой ветки; денег это не стоит.
       */
      let jobErrMsg: string | null = null;
      /** Дедуп не ответил: «легла ли вставка» неизвестно — не компенсируем. */
      let enqueueUnconfirmed = false;
      /**
       * Хотя бы на одну вставку ответа PostgREST не было: легла ли она —
       * неизвестно. Флаг липкий: вставка первой попытки, потерянная шлюзом,
       * может закоммититься и после того, как вторая получила честный отказ.
       */
      let someOutcomeUnknown = false;
      for (let attempt = 1; attempt <= ANALYZE_ENQUEUE_ATTEMPTS; attempt += 1) {
        /**
         * ПЕРЕД повтором проверяем, не легла ли предыдущая вставка.
         *
         * Отказ шлюза без ответа PostgREST (502/504, обрыв соединения, таймаут
         * клиента) означает «ответ потерян», а НЕ «строка не вставилась»:
         * INSERT мог закоммититься на сервере — и не обязательно ДО этой
         * проверки. Строку base_analyze уникальное ограничение держит только
         * пока она АКТИВНА (he_jobs_one_active_base_analyze_per_base,
         * 20261008_0001; до этой миграции — никакое: PK по id и
         * he_jobs_one_active_site_profile её не касаются), а первая вставка к
         * повтору может уже закончиться, поэтому повтор после такого отказа мог
         * дать ВТОРУЮ джобу base_analyze, а это второй ПЛАТНЫЙ вызов модели:
         * stages/baseAnalyze.ts гейта готовности не имеет — её записи статуса
         * (CAS) пускают и 'uploaded', и 'analyzing', и 'analyzed', так что
         * вторая джоба той же базы снова платит и переписывает 'analyzed'. При
         * включённом автопилоте к нему мог добавиться и второй платный template:
         * afterBaseAnalyzeDone не ставит письма базе, у которой шаблон уже есть
         * или генерация идёт, но если первая генерация упала, второй done-анализ
         * начинает бюджет писем заново. Поэтому после такого отказа повтора НЕТ
         * вовсе (см. условие выхода ниже), а повтор идёт только после отказа,
         * который вернул сам PostgREST, — строки тогда нет, и эта проверка
         * остаётся страховкой от гонки, а не единственной защитой.
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
        const { error, status } = await supabaseAdmin
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
        const outcomeUnknown = INSERT_OUTCOME_UNKNOWN_STATUSES.has(status);
        if (outcomeUnknown) someOutcomeUnknown = true;
        // Повтор — только когда PostgREST ОТВЕТИЛ отказом, похожим на блип
        // (503/429, PGRST00x, обрыв его связи с БД): строки нет, повторить
        // можно. isTransientDbError решает ТОЛЬКО это; легла ли строка после
        // ответа, которого не было, — вопрос перечитывания ниже.
        if (attempt >= ANALYZE_ENQUEUE_ATTEMPTS || outcomeUnknown || !isTransientDbError(error, status)) break;
        await new Promise((r) => setTimeout(r, ANALYZE_ENQUEUE_RETRY_MS * attempt));
      }
      /**
       * Перед компенсацией джобы перечитываются ВСЕГДА, каким бы ни был класс
       * отказа. Проверка «не легла ли предыдущая вставка» в начале итерации
       * последней вставки не касается, а «блип или нет» (isTransientDbError) —
       * вопрос о повторе, не о судьбе строки: таймаут клиента supabaseAdmin он
       * блипом не считает вовсе, хотя после него INSERT мог закоммититься.
       * Раньше перечитывание шло только после «блипа», и после такого отказа
       * база с живой джобой анализа получала 'failed', а специалист — неправду
       * «анализ не поставлен» (и платил второй анализ, перезалив файл).
       *
       * Пустой ответ компенсацию разрешает не всегда: если хотя бы на одну
       * вставку ответа PostgREST не было (someOutcomeUnknown), строка может
       * лечь ПОСЛЕ этого чтения, и исход остаётся «не подтверждено».
       */
      if (jobErrMsg && !enqueueUnconfirmed) {
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
        } else if (someOutcomeUnknown) {
          jobErrMsg = `${jobErrMsg}; ответа на вставку не было — она могла лечь позже`;
          enqueueUnconfirmed = true;
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
