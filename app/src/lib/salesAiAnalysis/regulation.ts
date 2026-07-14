/**
 * Синхронизация регламента продаж: embed-строка → активная строка в sales_regulation.
 *
 * При каждом запуске крона вызываем syncRegulation(). Если sha256 отличается
 * от текущей активной строки — вставляем новую версию, старую скидываем в
 * is_active=false. Каждый анализ ссылается на конкретную версию через
 * `sales_ai_deal_analysis.regulation_id` — трассируется, «под каким текстом
 * регламента был сделан этот разбор».
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REGULATION_CONTENT } from './regulationContent';

export interface ActiveRegulation {
  id: number;
  version: number;
  body: string;
  body_sha256: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

/**
 * Гарантирует, что в БД активна строка регламента с текущим контентом.
 * Возвращает активную строку.
 */
export async function syncRegulation(db: SupabaseClient): Promise<ActiveRegulation> {
  const body = REGULATION_CONTENT;
  const hash = sha256(body);

  const { data: active, error: selErr } = await db
    .from('sales_regulation')
    .select('id, version, body, body_sha256')
    .eq('is_active', true)
    .maybeSingle();

  if (selErr) throw new Error(`syncRegulation SELECT failed: ${selErr.message}`);

  if (active && active.body_sha256 === hash) {
    return active as ActiveRegulation;
  }

  // Найти максимальную версию, чтобы новая была version+1.
  const { data: maxRow, error: maxErr } = await db
    .from('sales_regulation')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) throw new Error(`syncRegulation max version failed: ${maxErr.message}`);
  const nextVersion = (maxRow?.version ?? 0) + 1;

  // Атомарно (best-effort в двух шагах): сбросить is_active у прежней активной, вставить новую.
  if (active) {
    const { error: updErr } = await db
      .from('sales_regulation')
      .update({ is_active: false })
      .eq('id', active.id);
    if (updErr) throw new Error(`syncRegulation deactivate failed: ${updErr.message}`);
  }

  const { data: inserted, error: insErr } = await db
    .from('sales_regulation')
    .insert({
      version: nextVersion,
      body,
      body_sha256: hash,
      is_active: true,
      source: 'file',
    })
    .select('id, version, body, body_sha256')
    .single();

  if (insErr || !inserted) {
    throw new Error(`syncRegulation INSERT failed: ${insErr?.message ?? 'no row returned'}`);
  }
  return inserted as ActiveRegulation;
}
