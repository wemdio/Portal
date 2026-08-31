import type { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { safeEqual } from '@/lib/crypto/safeEqual';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { createBenchDb } from './db';
import { benchError } from './errors';
import { hashBenchKey } from './keys';

const KEY_COLUMNS =
  'id, name, key_hash, key_last4, robot_user_id, allowed_tools, rpm_limit, daily_jobs_limit, daily_rows_limit, max_active_jobs, revoked_at';

export interface BenchKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_last4: string;
  robot_user_id: string;
  allowed_tools: string[];
  rpm_limit: number;
  daily_jobs_limit: number;
  daily_rows_limit: number;
  max_active_jobs: number;
  revoked_at: string | null;
}

export interface BenchAuth {
  key: BenchKeyRow;
  db: SupabaseClient;
}

/**
 * Проверка ключа идёт в базу на КАЖДОМ запросе, без кэша.
 *
 * «Отозвать за минуту» должно означать, что следующий же запрос получает
 * отказ. Кэш даже на минуту превращает отзыв в обещание ровно тогда, когда он
 * нужен всерьёз — при утечке ключа, где счёт идёт на секунды. Один точечный
 * поиск по уникальному индексу того стоит.
 */
export async function authenticateBench(
  req: NextRequest,
): Promise<BenchAuth | NextResponse> {
  const raw =
    getBearerToken(req.headers.get('authorization')) ?? req.headers.get('x-api-key');
  if (!raw) {
    return benchError(
      'unauthorized',
      'Нужен ключ: заголовок Authorization: Bearer bench_live_…',
    );
  }
  if (!supabaseAdmin) {
    return benchError('server_error', 'Bench API не настроен');
  }

  // В базу уходит отпечаток, а не ключ: сам ключ не должен оказаться ни в
  // запросе, ни в логах медленных запросов Postgres.
  const hash = hashBenchKey(raw);
  const { data } = await supabaseAdmin
    .from('bench_api_keys')
    .select(KEY_COLUMNS)
    .eq('key_hash', hash)
    .maybeSingle();

  const key = data as BenchKeyRow | null;
  if (!key || !safeEqual(key.key_hash, hash)) {
    return benchError('unauthorized', 'Ключ не найден');
  }
  if (key.revoked_at) {
    return benchError('unauthorized', 'Ключ отозван');
  }

  return { key, db: createBenchDb(key.robot_user_id) };
}

export function isBenchAuth(value: BenchAuth | NextResponse): value is BenchAuth {
  return 'key' in value;
}

/**
 * Инструмент, которого нет в списке ключа, для него не существует.
 *
 * Отвечаем внятным 403, а не 404: свой список владелец ключа и так видит в
 * GET /tools, скрывать нечего, а честный отказ экономит часы догадок.
 */
export function assertToolAllowed(
  key: BenchKeyRow,
  toolId: string,
): NextResponse | null {
  if (key.allowed_tools.includes(toolId)) return null;
  return benchError('tool_not_allowed', `Инструмент «${toolId}» не открыт этому ключу`);
}
