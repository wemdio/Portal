/**
 * API для управления Background BoB Scorer'ом.
 *
 * GET  → читает background_scorer_state — для UI progress bar и счётчиков
 * POST → toggle / reset / config update — только для admin/client'а с
 *        соответствующими permissions
 *
 * Authentication: и admin и client — оба роли. Scorer глобальный (один на
 * весь портал), поэтому управление общее. В будущем можно сделать
 * per-client скоры если несколько клиентов с разными нишами.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface ScorerState {
  enabled: boolean;
  current_offset: number;
  domains_scored_total: number;
  domains_active_total: number;
  last_tick_at: string | null;
  last_tick_batch_size: number | null;
  last_error: string | null;
  last_error_at: string | null;
  batch_size: number;
  sleep_between_batches_ms: number;
  revenue_from: number;
}

interface ScorerResponse extends ScorerState {
  /** Сколько строк в mailganer_domain_scores сейчас. */
  cached_domains: number;
  cached_active: number;
  /** Возраст последнего тика в секундах — для UI «живой ли воркер». */
  seconds_since_last_tick: number | null;
}

async function loadFullState(): Promise<ScorerResponse | null> {
  if (!supabaseAdmin) return null;

  const [stateRes, cacheRes, activeRes] = await Promise.all([
    supabaseAdmin
      .from('background_scorer_state')
      .select('*')
      .eq('id', 1)
      .single(),
    supabaseAdmin
      .from('mailganer_domain_scores')
      .select('domain', { count: 'exact', head: true }),
    supabaseAdmin
      .from('mailganer_domain_scores')
      .select('domain', { count: 'exact', head: true })
      .gt('score', 0),
  ]);

  if (stateRes.error || !stateRes.data) return null;

  const state = stateRes.data as ScorerState;
  const lastTickAge = state.last_tick_at
    ? Math.round((Date.now() - new Date(state.last_tick_at).getTime()) / 1000)
    : null;

  return {
    ...state,
    cached_domains: cacheRes.count ?? 0,
    cached_active: activeRes.count ?? 0,
    seconds_since_last_tick: lastTickAge,
  };
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  const state = await loadFullState();
  if (!state) {
    return NextResponse.json({ error: 'Не удалось загрузить состояние' }, { status: 500 });
  }

  return NextResponse.json(state);
}

interface PostBody {
  action?: 'toggle' | 'enable' | 'disable' | 'reset' | 'update_config';
  // для update_config
  batch_size?: number;
  sleep_between_batches_ms?: number;
  revenue_from?: number;
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Сервер не настроен' }, { status: 500 });
  }

  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  // Проверяем что пользователь — admin или client (auto-pipeline-enabled)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, auto_pipeline_enabled')
    .eq('id', user.id)
    .single();

  const isAdmin = profile?.role === 'admin' || profile?.role === 'director';
  const isClient = profile?.auto_pipeline_enabled === true;

  if (!isAdmin && !isClient) {
    return NextResponse.json({ error: 'Нет прав' }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  try {
    if (body.action === 'toggle') {
      const { data: current } = await supabaseAdmin
        .from('background_scorer_state')
        .select('enabled')
        .eq('id', 1)
        .single();
      const newEnabled = !((current as { enabled: boolean } | null)?.enabled ?? false);
      await supabaseAdmin
        .from('background_scorer_state')
        .update({ enabled: newEnabled })
        .eq('id', 1);
      await logAudit('background-scorer.toggle', `User ${user.id} → enabled=${newEnabled}`, { userId: user.id });
    } else if (body.action === 'enable' || body.action === 'disable') {
      const enabled = body.action === 'enable';
      await supabaseAdmin
        .from('background_scorer_state')
        .update({ enabled })
        .eq('id', 1);
      await logAudit('background-scorer.set', `User ${user.id} → enabled=${enabled}`, { userId: user.id });
    } else if (body.action === 'reset') {
      // Только админ может ресетнуть прогресс
      if (!isAdmin) {
        return NextResponse.json({ error: 'Только админ может сбросить прогресс' }, { status: 403 });
      }
      await supabaseAdmin
        .from('background_scorer_state')
        .update({
          current_offset: 0,
          domains_scored_total: 0,
          domains_active_total: 0,
          last_error: null,
          last_error_at: null,
        })
        .eq('id', 1);
      await logAudit('background-scorer.reset', `Admin ${user.id} reset offset to 0`, { userId: user.id });
    } else if (body.action === 'update_config') {
      if (!isAdmin) {
        return NextResponse.json({ error: 'Только админ может менять конфиг' }, { status: 403 });
      }
      const update: Record<string, unknown> = {};
      if (typeof body.batch_size === 'number' && body.batch_size > 0 && body.batch_size <= 500) {
        update.batch_size = Math.floor(body.batch_size);
      }
      if (typeof body.sleep_between_batches_ms === 'number' && body.sleep_between_batches_ms >= 100) {
        update.sleep_between_batches_ms = Math.floor(body.sleep_between_batches_ms);
      }
      if (typeof body.revenue_from === 'number' && body.revenue_from >= 0) {
        update.revenue_from = Math.floor(body.revenue_from);
      }
      if (Object.keys(update).length === 0) {
        return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 });
      }
      await supabaseAdmin
        .from('background_scorer_state')
        .update(update)
        .eq('id', 1);
      await logAudit('background-scorer.config', `Admin ${user.id} updated config`, { userId: user.id, update });
    } else {
      return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
    }
  } catch (err) {
    await logError('background-scorer.api.failed', err, { userId: user.id, action: body.action });
    return NextResponse.json({ error: 'Не удалось обновить состояние' }, { status: 500 });
  }

  const state = await loadFullState();
  return NextResponse.json(state);
}
