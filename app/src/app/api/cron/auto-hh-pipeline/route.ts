import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { runAutoPipelineForClient } from '@/lib/jobs/autoPipelineRunner';

export const dynamic = 'force-dynamic';
// Один тик авто-пайплайна для одного клиента состоит из HH-парсинга +
// сотен HTTP-запросов (scrape сайтов + endpoint клиента) + загрузки в
// Instantly. Реалистичный максимум — несколько минут. Vercel Hobby plan
// держит cron'ы до 60s, Pro — до 300s. Если в проекте окажется
// >5-7 клиентов в авто-режиме одновременно, придётся разделять на
// несколько cron-эндпоинтов или переходить на фоновую очередь.
export const maxDuration = 300;

/**
 * GET /api/cron/auto-hh-pipeline
 *
 * Ежедневный прогон авто-пайплайна для каждого клиента, у которого:
 *   - profiles.auto_pipeline_enabled = true
 *   - client_auto_pipeline_configs.enabled = true
 *
 * Защищён CRON_SECRET (паттерн как в /api/cron/auto-renew). Vercel-планировщик
 * выставляет токен через query-параметр `?secret=...` или заголовок
 * `x-vercel-cron-secret`. Принимаем оба.
 *
 * Schedule: 0 4 * * *  (07:00 МСК = 04:00 UTC).
 */
export async function GET(req: NextRequest) {
  // 1. Auth.
  const url = new URL(req.url);
  const querySecret = url.searchParams.get('secret');
  const headerSecret = req.headers.get('x-vercel-cron-secret') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = querySecret ?? headerSecret;

  if (process.env.CRON_SECRET && provided !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // 2. Найти всех клиентов в авто-режиме.
  //    Условия: profiles.auto_pipeline_enabled=true И существует config с enabled=true.
  //    Стартуем с configs.enabled=true — это узкая выборка (1-3 строки на старте).
  const { data: configs, error: configsErr } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('client_user_id')
    .eq('enabled', true);

  if (configsErr) {
    await logError('cron.auto-hh-pipeline.configs.failed', configsErr, {});
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const clientIds = (configs ?? [])
    .map((c) => (c as { client_user_id: string }).client_user_id)
    .filter(Boolean);

  if (clientIds.length === 0) {
    await logAudit('cron.auto-hh-pipeline.no-clients', 'No clients in auto-pipeline mode', {});
    return NextResponse.json({ ok: true, processed: 0, results: [] });
  }

  // Дополнительная проверка флага на profiles — чтобы один из источников мог
  // отключить пайплайн целиком (например, при сбое биллинга админ выключает
  // флаг, и cron перестаёт что-либо делать без правки configs).
  const { data: profiles, error: profilesErr } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .in('id', clientIds)
    .eq('auto_pipeline_enabled', true);

  if (profilesErr) {
    await logError('cron.auto-hh-pipeline.profiles.failed', profilesErr, {});
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  const eligibleClientIds = (profiles ?? []).map((p) => (p as { id: string }).id);

  await logAudit(
    'cron.auto-hh-pipeline.start',
    'Auto pipeline cron started',
    {
      totalConfigs: clientIds.length,
      eligibleClients: eligibleClientIds.length,
    },
  );

  // 3. Прогоняем последовательно. Параллельность здесь опасна — каждый клиент
  //    делает сотни HTTP-запросов к HH/scrape/endpoint, не хочется DDoS'ить
  //    HH или клиентский API. Vercel maxDuration=300s, при 5 клиентах это
  //    ~60s на каждого. Для большего числа клиентов перейдём на очередь.
  const results: Array<{ client_user_id: string; ok: boolean; summary: unknown; error?: string }> = [];

  for (const clientId of eligibleClientIds) {
    try {
      const summary = await runAutoPipelineForClient(clientId);
      results.push({
        client_user_id: clientId,
        ok: summary.status === 'completed',
        summary,
        error: summary.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logError('cron.auto-hh-pipeline.client.failed', err, { client_user_id: clientId });
      results.push({ client_user_id: clientId, ok: false, summary: null, error: msg });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  await logAudit(
    'cron.auto-hh-pipeline.done',
    'Auto pipeline cron finished',
    { processed: results.length, ok, failed },
  );

  return NextResponse.json({
    ok: true,
    processed: results.length,
    succeeded: ok,
    failed,
    results,
  });
}
