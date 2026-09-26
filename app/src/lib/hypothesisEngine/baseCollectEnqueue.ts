/**
 * Ядро запуска авто-сборки базы под вертикаль «Движка вертикалей» (стадия
 * base_collect: план источников → коллекторы → harvest в he_bases).
 *
 * Вынесено из POST api/tools/hypothesis-engine/verticals/[id]/collect —
 * клиентский ENG-контур запускает сборку тем же кодом (со своими лимитами).
 * Здесь: дедупы и вставки. Валидация тела, загрузка вертикали (со скоупом
 * владельца в клиентском контуре) и аудит остаются в роутах.
 *
 * Создаёт he_bases (source='auto', status='collecting') + he_jobs
 * (stage='base_collect'). Лимит и непустой hypothesis_ids едут в payload
 * джобы (их читают totalRowsCap и buildPlan в стадии) и в
 * he_bases.collect_info (его показывает UI).
 *
 * Дедуп: активная (pending/running) base_collect-задача этой вертикали или
 * собирающаяся auto-база уже есть → outcome 'existing' (UI показывает «уже
 * собирается», а не молча продолжает; collect_info в выборке — ради
 * collect_info.limit в этом уведомлении).
 * Гонку двух параллельных запусков (оба прошли проверки до insert) закрывает
 * partial unique index he_bases_one_collecting_per_vertical: проигравший
 * insert получает 23505 и тоже отвечает 'existing' с чужой collecting-базой.
 *
 * Сбой вставки джобы ПОСЛЕ вставки базы компенсируется (см. хвост функции):
 * база уводится в 'failed', иначе осиротевшая 'collecting'-строка навсегда
 * держит дедуп и уникальный индекс вертикали. Компенсация срабатывает только
 * когда удалось УБЕДИТЬСЯ, что джобы нет: сбой самой проверки — отдельный
 * исход, статус базы в нём не пишется («неизвестно» ≠ «джобы нет»).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface HeBaseCollectInput {
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

export type HeBaseCollectResult =
  /** Сборка стартовала: создана новая база + джоба. */
  | { ok: true; created: true; base: Record<string, unknown> }
  /** Дедуп: сборка уже идёт (существующая collecting-база). */
  | { ok: true; created: false; base: Record<string, unknown> }
  | { ok: false; message: string };

export async function enqueueHeBaseCollect(
  supabase: SupabaseClient,
  input: HeBaseCollectInput,
): Promise<HeBaseCollectResult> {
  const { verticalId, projectId, verticalName, limit, hypothesisIds, filename, refill } = input;

  // Дедуп 1: уже собирающаяся auto-база этой вертикали.
  const { data: collecting, error: collErr } = await supabase
    .from('he_bases')
    .select('id, status, collect_info')
    .eq('vertical_id', verticalId)
    .eq('source', 'auto')
    .eq('status', 'collecting')
    .limit(1)
    .maybeSingle();
  if (collErr) return { ok: false, message: collErr.message };
  if (collecting) return { ok: true, created: false, base: collecting as Record<string, unknown> };

  // Дедуп 2: pending/running base_collect-задача на базу этой вертикали
  // (база могла уже выйти из collecting, пока джоба ещё активна).
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_collect')
    .in('status', ['pending', 'running']);
  if (activeErr) return { ok: false, message: activeErr.message };
  const baseIds = (active ?? [])
    .map((j) => (j.payload as { base_id?: string } | null)?.base_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (baseIds.length > 0) {
    const { data: existingBase, error: baseErr } = await supabase
      .from('he_bases')
      .select('id, status, collect_info')
      .eq('vertical_id', verticalId)
      .in('id', baseIds)
      // Упавшая сборка не блокирует повторный запуск: failed-базу
      // не считаем конфликтом, даём создать новую.
      .neq('status', 'failed')
      .limit(1)
      .maybeSingle();
    if (baseErr) return { ok: false, message: baseErr.message };
    if (existingBase) return { ok: true, created: false, base: existingBase as Record<string, unknown> };
  }

  // collect_info/payload джобы: у refill-сборки свой снапшот полей (кампания
  // долива), hypothesis_ids в нём не используется — план строится по
  // неотклонённым гипотезам, как без явного выбора.
  const collectInfo: Record<string, unknown> = refill
    ? { limit, refill: true, campaign_id: refill.campaignId }
    : hypothesisIds
      ? { limit, hypothesis_ids: hypothesisIds }
      : { limit };
  const jobPayload: Record<string, unknown> = refill
    ? { limit, refill: true }
    : hypothesisIds
      ? { limit, hypothesis_ids: hypothesisIds }
      : { limit };

  const { data: base, error: baseInsertErr } = await supabase
    .from('he_bases')
    .insert({
      project_id: projectId,
      vertical_id: verticalId,
      source: 'auto',
      status: 'collecting',
      filename: filename ?? `auto: ${verticalName}`,
      row_count: 0,
      columns: [],
      data: [],
      // Лимит и выбранные гипотезы — сразу в collect_info: прогресс-карта
      // показывает лимит, пока стадия ещё не перезаписала collect_info
      // планом (поля живут дальше — стадия мержит collect_info, а не
      // заменяет).
      collect_info: collectInfo,
    })
    .select('id, status')
    .single();
  if (baseInsertErr || !base) {
    // 23505 = unique_violation на he_bases_one_collecting_per_vertical:
    // параллельный запуск успел вставить collecting-базу раньше. Это тот же
    // дедуп, только пойманный индексом, — отвечаем 'existing' с чужой базой.
    if (baseInsertErr?.code === '23505') {
      const { data: conflict, error: conflictErr } = await supabase
        .from('he_bases')
        .select('id, status, collect_info')
        .eq('vertical_id', verticalId)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (conflictErr) return { ok: false, message: conflictErr.message };
      if (conflict) return { ok: true, created: false, base: conflict as Record<string, unknown> };
    }
    return { ok: false, message: baseInsertErr?.message ?? 'base insert failed' };
  }

  const { error: jobErr } = await supabase
    .from('he_jobs')
    .insert({
      project_id: projectId,
      stage: 'base_collect',
      status: 'pending',
      payload: { base_id: base.id, ...jobPayload },
    });
  if (jobErr) {
    // Компенсация fail-closed. Новая база без джобы воркера — осиротевшая
    // 'collecting'-строка, и вылечить её нечем: failJob воркера валит базу
    // только по своей джобе, а джобы нет. При этом она навсегда занимает и
    // дедуп 1 выше, и partial unique index he_bases_one_collecting_per_vertical
    // — ручная кнопка, автопилот и ночной refill вертикали после этого вечно
    // отвечают «уже собирается». Решение скопировано из V2
    // (verticalEngineV2/baseCollectEnqueue: перечитать, иначе база в failed).
    //
    // Сначала перечитываем активные base_collect-джобы: ответ мог не доехать
    // при состоявшейся вставке, и тогда сборка на самом деле идёт.
    const { data: rescueJobs, error: rescueErr } = await supabase
      .from('he_jobs')
      .select('id, payload')
      .eq('project_id', projectId)
      .eq('stage', 'base_collect')
      .in('status', ['pending', 'running']);
    if (rescueErr) {
      // Сбой САМОГО спасательного чтения — отдельный исход, а не «джобы нет».
      // Легла вставка или нет — неизвестно, и писать по «неизвестно»
      // терминальный статус нельзя: если легла, воркер придёт на живую сборку,
      // а стадия умрёт в своём start-guard («сборка уже завершена») из-за
      // чужой ошибки — оплаченный прогон превратится в базу без строк. Поэтому
      // статус базы не трогаем и называем состояние в ответе. Цена: если
      // вставка всё же не легла, 'collecting'-строка останется висеть и будет
      // держать дедуп вертикали (лечит ремонт сирот — roadmap
      // P-C-enqueue-orphan-repair, отдельная волна).
      return {
        ok: false,
        message:
          `${jobErr.message}; he_jobs rescue read: ${rescueErr.message} ` +
          `(he_bases ${base.id} left as-is: enqueue outcome unknown)`,
      };
    }
    const alive = (rescueJobs ?? []).some(
      (j) => (j.payload as { base_id?: unknown } | null)?.base_id === base.id,
    );
    if (alive) return { ok: true, created: true, base: base as Record<string, unknown> };
    // CAS по 'collecting': если базу уже увели (cancel, параллельный ремонт) —
    // её статус не перетираем.
    const { error: cleanupErr } = await supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: `he_jobs base_collect enqueue: ${jobErr.message}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', base.id)
      .eq('status', 'collecting');
    if (cleanupErr) {
      return {
        ok: false,
        message: `${jobErr.message}; he_bases orphan cleanup: ${cleanupErr.message}`,
      };
    }
    return { ok: false, message: jobErr.message };
  }

  return { ok: true, created: true, base: base as Record<string, unknown> };
}
