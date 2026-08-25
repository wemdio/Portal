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
 * Гонку двух параллельных запусков (оба прошли проверки до insert) закрывает
 * partial unique index ve_bases_one_collecting_per_vertical: проигравший
 * insert получает 23505 и тоже отвечает 'existing' с чужой collecting-базой.
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

  for (const target of targets) {
    const hypothesisId = target.hypothesisId;

    // Дедуп 1: уже собирающаяся auto-база этой гипотезы (или вертикали, когда
    // гипотезы нет — легаси-путь).
    let collecting: Record<string, unknown> | null = null;
    if (hypothesisId) {
      const { data, error } = await supabase
        .from('ve_bases')
        .select('id, status, collect_info')
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
        .select('id, status, collect_info')
        .eq('vertical_id', verticalId)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, message: error.message };
      collecting = data as Record<string, unknown> | null;
    }
    if (collecting) return { ok: true, created: false, base: collecting };

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
    const baseIds = (active ?? [])
      .map((j) => j.payload as { base_id?: string; hypothesis_id?: string | null } | null)
      // При per-hypothesis берём только джобы этой гипотезы; при легаси — без
      // hypothesis_id (джобы вертикали). Чужие гипотезы не блокируют.
      .filter((p) => (hypothesisId ? p?.hypothesis_id === hypothesisId : !p?.hypothesis_id))
      .map((p) => p?.base_id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (baseIds.length > 0) {
      const existingQ = supabase
        .from('ve_bases')
        .select('id, status, collect_info')
        .in('id', baseIds)
        .neq('status', 'failed')
        .limit(1);
      const { data: existingBase, error: baseErr } = await existingQ.maybeSingle();
      if (baseErr) return { ok: false, message: baseErr.message };
      if (existingBase) return { ok: true, created: false, base: existingBase as Record<string, unknown> };
    }

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
              .select('id, status, collect_info')
              .eq('hypothesis_id', hypothesisId)
              .eq('source', 'auto')
              .eq('status', 'collecting')
              .limit(1)
          : supabase
              .from('ve_bases')
              .select('id, status, collect_info')
              .eq('vertical_id', verticalId)
              .eq('source', 'auto')
              .eq('status', 'collecting')
              .limit(1);
        const { data: conflict, error: conflictErr } = await conflictQ.maybeSingle();
        if (conflictErr) return { ok: false, message: conflictErr.message };
        if (conflict) return { ok: true, created: false, base: conflict as Record<string, unknown> };
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
      return { ok: false, message: jobErr.message };
    }

    created.push(base as Record<string, unknown>);
  }

  return { ok: true, created: true, base: created[0], bases: created };
}
