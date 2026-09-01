/**
 * Ядро запуска авто-сборки базы под вертикаль «Движка вертикалей» (стадия
 * base_collect: план источников → коллекторы → harvest в ve_bases).
 *
 * Вынесено из POST api/tools/vertical-engine-v2/verticals/[id]/collect —
 * клиентский ENG-контур запускает сборку тем же кодом (со своими лимитами).
 * Здесь: дедупы и вставки. Валидация тела, загрузка вертикали (со скоупом
 * владельца в клиентском контуре) и аудит остаются в роутах.
 *
 * Создаёт ve_bases (source='auto', status='collecting') + ve_jobs
 * (stage='base_collect'). Лимит и непустой hypothesis_ids едут в payload
 * джобы (их читают totalRowsCap и buildPlan в стадии) и в
 * ve_bases.collect_info (его показывает UI).
 *
 * Дедуп: активная (pending/running) base_collect-задача этой вертикали или
 * собирающаяся auto-база уже есть → outcome 'existing' (UI показывает «уже
 * собирается», а не молча продолжает; collect_info в выборке — ради
 * collect_info.limit в этом уведомлении).
 * Гонку двух параллельных запусков (оба прошли проверки до insert) закрывают
 * partial unique index'ы: ve_bases_one_collecting_per_hypothesis (базы с
 * гипотезой) и ve_bases_one_collecting_per_vertical (легаси/refill, где
 * hypothesis_id IS NULL). Проигравший insert получает 23505 и тоже отвечает
 * 'existing' с чужой collecting-базой.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeBaseCollectInput {
  verticalId: string;
  projectId: string;
  /** Имя вертикали — в filename авто-базы («auto: <name>»). */
  verticalName: string;
  /** Лимит строк сборки (практический предохранитель от раздутого data jsonb). */
  limit: number;
  /** Выбранные в UI гипотезы; null — собирать по всем. */
  hypothesisIds: string[] | null;
  /**
   * Переопределение filename авто-базы (по умолчанию «auto: <name>»).
   * ENG auto-pipeline пишет «auto-refill: <name> · <дата>».
   */
  filename?: string;
  /**
   * Refill-режим (ENG auto-pipeline): после сборки и конструктора стадия
   * НЕ ставит base_analyze/template, а доливает валидные строки лидaми в
   * уже запущенную кампанию campaignId (см. stages/baseCollectRefill.ts).
   * campaign_id дублируется в collect_info — на момент постановки это
   * снапшот launch_info, стадия умеет и фолбэк на последний launched шаблон.
   */
  refill?: { campaignId: string };
}

export type VeBaseCollectResult =
  /** Сборка стартовала: созданы базы + джобы (по одной на гипотезу либо одна). */
  | { ok: true; created: true; bases: Array<Record<string, unknown>>; base: Record<string, unknown> }
  /** Дедуп: сборка уже идёт (существующая collecting-база). */
  | { ok: true; created: false; base: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Rebuild a lost job exclusively from the persisted base snapshot. The
 * retrying caller may be normal or refill and must never change that mode.
 */
function repairJobPayload(base: Record<string, unknown>): Record<string, unknown> {
  const info = base.collect_info && typeof base.collect_info === 'object'
    ? base.collect_info as Record<string, unknown>
    : {};
  const payload: Record<string, unknown> = {};
  if (
    typeof info.limit === 'number'
    && Number.isSafeInteger(info.limit)
    && info.limit > 0
  ) {
    payload.limit = info.limit;
  }

  if (info.refill === true) {
    payload.refill = true;
    return payload;
  }

  const hypothesisId = typeof base.hypothesis_id === 'string' && base.hypothesis_id
    ? base.hypothesis_id
    : typeof info.hypothesis_id === 'string' && info.hypothesis_id
      ? info.hypothesis_id
      : null;
  if (hypothesisId) {
    payload.hypothesis_id = hypothesisId;
    return payload;
  }

  if (
    Array.isArray(info.hypothesis_ids)
    && info.hypothesis_ids.length > 0
    && info.hypothesis_ids.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    payload.hypothesis_ids = info.hypothesis_ids;
  }
  return payload;
}

export async function enqueueVeBaseCollect(
  supabase: SupabaseClient,
  input: VeBaseCollectInput,
): Promise<VeBaseCollectResult> {
  const { verticalId, projectId, verticalName, limit, hypothesisIds, filename, refill } = input;

  // Base-per-hypothesis: непустой выбор гипотез → по одной базе на каждую.
  // hypothesisIds = null/пусто → прежний путь «одна база на вертикаль» (легаси
  // и ENG-refill: refill не использует hypothesis_ids, план строится по
  // неотклонённым гипотезам, как без явного выбора).
  const perHypothesis = !refill && Array.isArray(hypothesisIds) && hypothesisIds.length > 0;

  // Заголовки гипотез → различающий суффикс filename авто-базы. Гипотеза
  // показывается заголовком на карточке (Phase 3), но filename одинаков у всех
  // баз вертикали — без суффикса карточки неразличимы и экспорт путается.
  let hypothesisTitle: Record<string, string> = {};
  if (perHypothesis) {
    const ids = hypothesisIds as string[];
    const { data: hypRows, error: hypErr } = await supabase
      .from('ve_hypotheses')
      .select('id, title')
      .in('id', ids);
    if (hypErr) return { ok: false, message: hypErr.message };
    hypothesisTitle = Object.fromEntries(
      (hypRows ?? []).map((h) => [String(h.id), String(h.title ?? '').trim() || String(h.id)]),
    );
  }

  const targets: Array<{ hypothesisId: string | null }> = perHypothesis
    ? (hypothesisIds as string[]).map((id) => ({ hypothesisId: id }))
    : [{ hypothesisId: null }];

  const created: Array<Record<string, unknown>> = [];
  const existing: Array<Record<string, unknown>> = [];

  for (const target of targets) {
    const hypothesisId = target.hypothesisId;

    // collect_info/payload джобы: у refill-сборки свой снапшот полей (кампания
    // долива), hypothesis_ids в нём не используется. У per-hypothesis — одна
    // hypothesis_id; у легаси — hypothesis_ids или только limit.
    const collectInfo: Record<string, unknown> = refill
      ? { limit, refill: true, campaign_id: refill.campaignId }
      : hypothesisId
        ? { limit, hypothesis_id: hypothesisId }
        : hypothesisIds
          ? { limit, hypothesis_ids: hypothesisIds }
          : { limit };
    const jobPayload: Record<string, unknown> = refill
      ? { limit, refill: true }
      : hypothesisId
        ? { limit, hypothesis_id: hypothesisId }
        : hypothesisIds
          ? { limit, hypothesis_ids: hypothesisIds }
          : { limit };

    // Дедуп 1: уже собирающаяся auto-база этой гипотезы (или вертикали, когда
    // гипотезы нет — легаси-путь).
    let collecting: Record<string, unknown> | null = null;
    if (hypothesisId) {
      const { data, error } = await supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, collect_info')
        .eq('hypothesis_id', hypothesisId)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, message: error.message };
      collecting = data as Record<string, unknown> | null;
    } else {
      const { data, error } = await supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, collect_info')
        .eq('vertical_id', verticalId)
        .is('hypothesis_id', null)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, message: error.message };
      collecting = data as Record<string, unknown> | null;
    }
    // Дедуп 2: pending/running base_collect-задача ЭТОЙ гипотезы (или вертикали,
    // когда гипотезы нет). База могла уже выйти из collecting, пока джоба ещё
    // активна. Фильтруем по hypothesis_id в payload — иначе своя же джоба первой
    // гипотезы заблокировала бы создание базы второй (multi-hypothesis).
    const { data: active, error: activeErr } = await supabase
      .from('ve_jobs')
      .select('id, payload')
      .eq('project_id', projectId)
      .eq('stage', 'base_collect')
      .in('status', ['pending', 'running']);
    if (activeErr) return { ok: false, message: activeErr.message };
    const allActiveBaseIds = (active ?? [])
      .map((j) => j.payload as { base_id?: string } | null)
      .map((payload) => payload?.base_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const baseIds = (active ?? [])
      .map((j) => j.payload as { base_id?: string; hypothesis_id?: string | null } | null)
      // При per-hypothesis берём только джобы этой гипотезы; при легаси — без
      // hypothesis_id (джобы вертикали). Чужие гипотезы не блокируют.
      .filter((p) => (hypothesisId ? p?.hypothesis_id === hypothesisId : !p?.hypothesis_id))
      .map((p) => p?.base_id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (collecting) {
      const collectingId = typeof collecting.id === 'string' ? collecting.id : '';
      if (!collectingId) return { ok: false, message: 'collecting base has no id' };

      // База могла остаться orphan между INSERT ve_bases и INSERT ve_jobs.
      // Повторный enqueue чинит её той же pending-задачей вместо вечного
      // ответа «уже собирается» без фактического воркера.
      if (!allActiveBaseIds.includes(collectingId)) {
        const storedPayload = repairJobPayload(collecting);
        const { error: repairErr } = await supabase.from('ve_jobs').insert({
          project_id: projectId,
          stage: 'base_collect',
          status: 'pending',
          payload: { base_id: collectingId, ...storedPayload },
        });
        if (repairErr) {
          // A concurrent retry may have won the unique-index race (or the
          // insert response may have been lost after commit). Re-read the
          // exact base before deciding that repair failed.
          const { data: repairRaceJobs, error: repairRaceErr } = await supabase
            .from('ve_jobs')
            .select('id, payload')
            .eq('project_id', projectId)
            .eq('stage', 'base_collect')
            .in('status', ['pending', 'running']);
          const repairedConcurrently = !repairRaceErr && (repairRaceJobs ?? []).some((candidate) => {
            const payload = candidate.payload as { base_id?: unknown } | null;
            return payload?.base_id === collectingId;
          });
          if (!repairedConcurrently) return { ok: false, message: repairErr.message };
        }
      }
      existing.push(collecting);
      continue;
    }
    if (baseIds.length > 0) {
      let existingQ = supabase
        .from('ve_bases')
        .select('id, status, hypothesis_id, vertical_id, collect_info')
        .in('id', baseIds)
        .neq('status', 'failed');
      existingQ = hypothesisId
        ? existingQ.eq('hypothesis_id', hypothesisId)
        : existingQ.eq('vertical_id', verticalId).is('hypothesis_id', null);
      existingQ = existingQ.limit(1);
      const { data: existingBase, error: baseErr } = await existingQ.maybeSingle();
      if (baseErr) return { ok: false, message: baseErr.message };
      if (existingBase) {
        existing.push(existingBase as Record<string, unknown>);
        continue;
      }
    }

    const { data: base, error: baseInsertErr } = await supabase
      .from('ve_bases')
      .insert({
        project_id: projectId,
        vertical_id: verticalId,
        hypothesis_id: hypothesisId,
        source: 'auto',
        status: 'collecting',
        // Уникальность по гипотезе: «auto: <вертикаль> — <гипотеза>». Только
        // для per-hypothesis (у легаси/refill гипотезы нет — прежнее имя).
        filename: filename ?? (hypothesisId && hypothesisTitle[hypothesisId]
          ? `auto: ${verticalName} — ${hypothesisTitle[hypothesisId]}`
          : `auto: ${verticalName}`),
        row_count: 0,
        columns: [],
        data: [],
        // Лимит и гипотеза — сразу в collect_info: прогресс-карта показывает
        // лимит, пока стадия ещё не перезаписала collect_info планом (поля
        // живут дальше — стадия мержит collect_info, а не заменяет).
        collect_info: collectInfo,
      })
      .select('id, status')
      .single();
    if (baseInsertErr || !base) {
      // 23505 = unique_violation на ve_bases_one_collecting_per_hypothesis /
      // ve_bases_one_collecting_per_vertical: параллельный запуск успел вставить
      // collecting-базу раньше. Это тот же дедуп, только пойманный индексом, —
      // отвечаем 'existing' с чужой базой.
      if (baseInsertErr?.code === '23505') {
        const conflictQ = hypothesisId
          ? supabase
              .from('ve_bases')
              .select('id, status, hypothesis_id, collect_info')
              .eq('hypothesis_id', hypothesisId)
              .eq('source', 'auto')
              .eq('status', 'collecting')
              .limit(1)
          : supabase
              .from('ve_bases')
              .select('id, status, hypothesis_id, collect_info')
              .eq('vertical_id', verticalId)
              .is('hypothesis_id', null)
              .eq('source', 'auto')
              .eq('status', 'collecting')
              .limit(1);
        const { data: conflict, error: conflictErr } = await conflictQ.maybeSingle();
        if (conflictErr) return { ok: false, message: conflictErr.message };
        if (conflict) {
          existing.push(conflict as Record<string, unknown>);
          continue;
        }
      }
      return { ok: false, message: baseInsertErr?.message ?? 'base insert failed' };
    }

    const { error: jobErr } = await supabase
      .from('ve_jobs')
      .insert({
        project_id: projectId,
        stage: 'base_collect',
        status: 'pending',
        payload: { base_id: base.id, ...jobPayload },
      });
    if (jobErr) {
      // Компенсация fail-closed: новая база без worker-job не должна навсегда
      // занимать partial unique index и блокировать следующие сборки.
      const { data: rescueJobs, error: rescueErr } = await supabase
        .from('ve_jobs')
        .select('id, payload')
        .eq('project_id', projectId)
        .eq('stage', 'base_collect')
        .in('status', ['pending', 'running']);
      if (!rescueErr) {
        const repairedConcurrently = (rescueJobs ?? []).some((candidate) => {
          const payload = candidate.payload as { base_id?: unknown } | null;
          return payload?.base_id === base.id;
        });
        if (repairedConcurrently) {
          created.push(base as Record<string, unknown>);
          continue;
        }
      }
      const { error: cleanupErr } = await supabase
        .from('ve_bases')
        .update({
          status: 'failed',
          error: `base_collect enqueue: ${jobErr.message}`.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', base.id)
        .eq('status', 'collecting');
      if (cleanupErr) {
        return {
          ok: false,
          message: `${jobErr.message}; не удалось пометить orphan-базу failed: ${cleanupErr.message}`,
        };
      }
      return { ok: false, message: jobErr.message };
    }

    created.push(base as Record<string, unknown>);
  }

  if (created.length > 0) {
    return { ok: true, created: true, base: created[0], bases: created };
  }
  if (existing.length > 0) {
    return { ok: true, created: false, base: existing[0] };
  }
  return { ok: false, message: 'base collect targets are empty' };
}
