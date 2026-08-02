import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// POST — запустить авто-сборку базы под вертикаль (стадия base_collect: план
// источников → коллекторы → harvest в he_bases). Создаёт he_bases
// (source='auto', status='collecting') + he_jobs (stage='base_collect').
// Тело опционально: {limit?: 2000 | 10000 | 50000, hypothesis_ids?: string[]}.
// limit — лимит строк сборки (практический предохранитель от раздутого data
// jsonb; выбор — за пользователем, дефолт 10000). hypothesis_ids — выбранные
// в UI гипотезы: массив непустых строк (иначе 400); пустой массив равноценен
// отсутствию поля. Лимит и непустой hypothesis_ids едут в payload джобы (их
// читают totalRowsCap и buildPlan в стадии) и в he_bases.collect_info (его
// показывает UI).
// Дедуп: активная (pending/running) base_collect-задача этой вертикали или
// собирающаяся auto-база уже есть → возвращаем её со статусом 200 и флагом
// existing: true (UI показывает «уже собирается», а не молча продолжает;
// collect_info в выборке — ради collect_info.limit в этом уведомлении).
// Гонку двух параллельных POST (оба прошли проверки до insert) закрывает
// partial unique index he_bases_one_collecting_per_vertical: проигравший
// insert получает 23505 и тоже отвечает 200 + existing с чужой
// collecting-базой.
/** Допустимые лимиты строк авто-сборки (см. UI Step4Base). */
const ALLOWED_LIMITS: readonly number[] = [2000, 10000, 50000];
const DEFAULT_LIMIT = 10000;
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.collect.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      // Тело опционально (пустое/не-JSON — ок): лимит строк из выбора
      // пользователя, любое значение вне ALLOWED_LIMITS — 400.
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      let limit = DEFAULT_LIMIT;
      if (body && typeof body === 'object' && 'limit' in body) {
        const raw = (body as { limit?: unknown }).limit;
        if (raw !== undefined) {
          if (typeof raw !== 'number' || !ALLOWED_LIMITS.includes(raw)) {
            return jsonError('limit должен быть одним из: 2000, 10000, 50000', 400);
          }
          limit = raw;
        }
      }

      // Выбор гипотез из UI (шаг 4): массив непустых строк или отсутствие
      // поля; пустой массив трактуем как «поля нет» (стадия фильтрует план
      // только по непустому массиву — иначе «снял все галочки» молча собирало
      // бы по всем гипотезам, а UI в таком состоянии кнопку блокирует).
      let hypothesisIds: string[] | null = null;
      if (body && typeof body === 'object' && 'hypothesis_ids' in body) {
        const raw = (body as { hypothesis_ids?: unknown }).hypothesis_ids;
        if (raw !== undefined) {
          if (
            !Array.isArray(raw) ||
            raw.some((v) => typeof v !== 'string' || v.length === 0)
          ) {
            return jsonError('hypothesis_ids должен быть массивом непустых строк', 400);
          }
          hypothesisIds = raw.length > 0 ? raw : null;
        }
      }

      const { data: vertical, error: vertErr } = await supabaseAdmin
        .from('he_verticals')
        .select('id, project_id, name')
        .eq('id', id)
        .single();
      if (vertErr) {
        return jsonError(
          vertErr.code === 'PGRST116' ? 'Вертикаль не найдена' : vertErr.message,
          vertErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      // Дедуп 1: уже собирающаяся auto-база этой вертикали.
      const { data: collecting, error: collErr } = await supabaseAdmin
        .from('he_bases')
        .select('id, status, collect_info')
        .eq('vertical_id', id)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (collErr) return jsonError(collErr.message, 500);
      if (collecting) return NextResponse.json({ ok: true, existing: true, base: collecting });

      // Дедуп 2: pending/running base_collect-задача на базу этой вертикали
      // (база могла уже выйти из collecting, пока джоба ещё активна).
      const { data: active, error: activeErr } = await supabaseAdmin
        .from('he_jobs')
        .select('id, payload')
        .eq('project_id', vertical.project_id)
        .eq('stage', 'base_collect')
        .in('status', ['pending', 'running']);
      if (activeErr) return jsonError(activeErr.message, 500);
      const baseIds = (active ?? [])
        .map((j) => (j.payload as { base_id?: string } | null)?.base_id)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (baseIds.length > 0) {
        const { data: existingBase, error: baseErr } = await supabaseAdmin
          .from('he_bases')
          .select('id, status, collect_info')
          .eq('vertical_id', id)
          .in('id', baseIds)
          // Упавшая сборка не блокирует повторный запуск: failed-базу
          // не считаем конфликтом, даём создать новую.
          .neq('status', 'failed')
          .limit(1)
          .maybeSingle();
        if (baseErr) return jsonError(baseErr.message, 500);
        if (existingBase) return NextResponse.json({ ok: true, existing: true, base: existingBase });
      }

      const { data: base, error: baseInsertErr } = await supabaseAdmin
        .from('he_bases')
        .insert({
          project_id: vertical.project_id,
          vertical_id: id,
          source: 'auto',
          status: 'collecting',
          filename: `auto: ${vertical.name}`,
          row_count: 0,
          columns: [],
          data: [],
          // Лимит и выбранные гипотезы — сразу в collect_info: прогресс-карта
          // показывает лимит, пока стадия ещё не перезаписала collect_info
          // планом (поля живут дальше — стадия мержит collect_info, а не
          // заменяет).
          collect_info: hypothesisIds ? { limit, hypothesis_ids: hypothesisIds } : { limit },
        })
        .select('id, status')
        .single();
      if (baseInsertErr || !base) {
        // 23505 = unique_violation на he_bases_one_collecting_per_vertical:
        // параллельный POST успел вставить collecting-базу раньше. Это тот же
        // дедуп, только пойманный индексом, — отвечаем 200 + existing с чужой базой.
        if (baseInsertErr?.code === '23505') {
          const { data: conflict, error: conflictErr } = await supabaseAdmin
            .from('he_bases')
            .select('id, status, collect_info')
            .eq('vertical_id', id)
            .eq('source', 'auto')
            .eq('status', 'collecting')
            .limit(1)
            .maybeSingle();
          if (conflictErr) return jsonError(conflictErr.message, 500);
          if (conflict) return NextResponse.json({ ok: true, existing: true, base: conflict });
        }
        await logError('tools.hypothesis-engine.collect.insert_failed', baseInsertErr, {
          userId,
          verticalId: id,
        });
        return jsonError(baseInsertErr?.message ?? 'Не удалось создать базу', 500);
      }

      const { error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({
          project_id: vertical.project_id,
          stage: 'base_collect',
          status: 'pending',
          payload: hypothesisIds
            ? { base_id: base.id, limit, hypothesis_ids: hypothesisIds }
            : { base_id: base.id, limit },
        });
      if (jobErr) {
        await logError('tools.hypothesis-engine.collect.enqueue_failed', jobErr, {
          userId,
          verticalId: id,
          baseId: base.id,
        });
        return jsonError(jobErr.message, 500);
      }

      void logAudit('tools.hypothesis-engine.collect.enqueued', 'Hypothesis engine auto-collect enqueued', {
        userId,
        verticalId: id,
        baseId: base.id,
      });

      return NextResponse.json({ ok: true, base }, { status: 201 });
    },
  );
}
