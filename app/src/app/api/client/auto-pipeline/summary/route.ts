import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/auto-pipeline/summary
 *
 * Краткая сводка по авто-пайплайну для дашборда клиента. Возвращает:
 *   - enabled: true/false (из client_auto_pipeline_configs)
 *   - last_run: данные последнего прогона (status, started_at, метрики)
 *   - totals_30d: совокупные метрики за 30 дней
 *   - stored_count: сколько лидов в storage-only состоянии (висят без отправки)
 *
 * Возвращает enabled=false (и null-ы) для клиентов, у которых нет конфига
 * или он отключён. Дашборд по этому полю решает, рендерить ли блок.
 */
export async function GET(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

    // Конфиг.
    const { data: config } = await supabaseAdmin
      .from('client_auto_pipeline_configs')
      .select('enabled, last_run_at, last_run_status, daily_limit')
      .eq('client_user_id', user.id)
      .maybeSingle();

    if (!config || !(config as { enabled?: boolean }).enabled) {
      return NextResponse.json({
        enabled: false,
        last_run: null,
        totals_30d: null,
        stored_count: 0,
      });
    }

    // Последний УСПЕШНЫЙ прогон — главные цифры в плитке. completed = это
    // тот, который реально дошёл до finishRunRow и обновил счётчики. Failed
    // прогоны (killed by redeploy, network errors etc) — это технические
    // факты, которые не должны драматизировать UX клиента.
    //
    // was_dry_run + воронка-поля (with_site/with_score/with_email/email_valid)
    // нужны UI чтобы в dry_run показать «сколько обработано / валидно» вместо
    // routing-нулей.
    const { data: lastCompletedRun } = await supabaseAdmin
      .from('client_auto_pipeline_runs')
      .select(
        'status, started_at, finished_at, parsed_count, new_count, new_from_hh, new_from_bob, routed_count, stored_count, skipped_count, failed_count, was_dry_run, with_site, with_score, with_email, email_valid',
      )
      .eq('client_user_id', user.id)
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Отдельно — самый последний прогон (любого статуса). Используется
    // только для тонкого индикатора «есть прерванный прогон» если он
    // failed/running и свежее completed. error_message в UI не выходит —
    // показываем дружелюбное сообщение.
    const { data: lastAttemptedRun } = await supabaseAdmin
      .from('client_auto_pipeline_runs')
      .select('status, started_at, finished_at')
      .eq('client_user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Метрики за 30 дней.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: monthRuns } = await supabaseAdmin
      .from('client_auto_pipeline_runs')
      .select('routed_count, stored_count, skipped_count, failed_count')
      .eq('client_user_id', user.id)
      .gte('started_at', thirtyDaysAgo);

    const totals30d = (monthRuns ?? []).reduce(
      (acc, r) => {
        const row = r as Record<string, number | null>;
        acc.routed += row.routed_count ?? 0;
        acc.stored += row.stored_count ?? 0;
        acc.skipped += row.skipped_count ?? 0;
        acc.failed += row.failed_count ?? 0;
        return acc;
      },
      { routed: 0, stored: 0, skipped: 0, failed: 0 },
    );

    // Stored employers — общее количество в текущей очереди.
    const { count: storedCount } = await supabaseAdmin
      .from('client_auto_pipeline_seen_employers')
      .select('id', { count: 'exact', head: true })
      .eq('client_user_id', user.id)
      .eq('status', 'stored');

    // Готовый резерв — активные домены (score > 0) в общем Mailganer-кэше,
    // который фоновый сборщик наполняет из «базы баз». Это запас, из которого
    // ежедневный добор берёт лидов, когда HH дал меньше нормы. Кэш портал-wide
    // (один Mailganer на портал), для единственного auto-клиента это и есть
    // его резерв.
    const { count: reserveActive } = await supabaseAdmin
      .from('mailganer_domain_scores')
      .select('domain', { count: 'exact', head: true })
      .gt('score', 0);

    // Если последний прогон НЕ completed и НЕ совпадает с last_completed_run —
    // у нас есть прерванный/работающий прогон поверх успешного. Возвращаем
    // флаг для UI чтобы показал тонкий индикатор.
    const lastCompletedStartedAt = (lastCompletedRun as { started_at?: string } | null)?.started_at ?? null;
    const lastAttempted = lastAttemptedRun as { status?: string; started_at?: string; finished_at?: string | null } | null;
    const lastAttemptedIsFresher =
      lastAttempted &&
      lastAttempted.status !== 'completed' &&
      lastAttempted.started_at &&
      (!lastCompletedStartedAt || lastAttempted.started_at > lastCompletedStartedAt);

    return NextResponse.json({
      enabled: true,
      daily_limit: (config as { daily_limit?: number | null }).daily_limit ?? null,
      // Главная плитка — последний completed (или null если ни одного не было).
      last_run: lastCompletedRun ?? null,
      // Тонкий индикатор «есть прерванный прогон поверх» — UI рисует
      // мини-badge без error_message; что именно случилось (zombie, network)
      // клиент видеть не должен.
      pending_attempt: lastAttemptedIsFresher
        ? {
            status: lastAttempted.status,
            started_at: lastAttempted.started_at,
          }
        : null,
      totals_30d: totals30d,
      stored_count: storedCount ?? 0,
      reserve_active: reserveActive ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
