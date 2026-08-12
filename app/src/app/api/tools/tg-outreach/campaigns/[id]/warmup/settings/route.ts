import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { normalizeWarmupSettings } from '@/lib/tgOutreach/warmup/settings';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Сохранить настройки прогрева.
 *
 * Пишем в кампанию — это то, что применится к следующему запуску. Если прогрев
 * идёт, пишем и в снимок прогона: воркер перечитывает его каждый круг, но план
 * дня строит один раз, поэтому новые числа вступят со следующего дня. Ответ
 * говорит об этом флагом `applies_next_day`, чтобы интерфейс не гадал.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.settings.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { settings?: unknown } | null;
      if (!body || typeof body !== 'object') return jsonError('Пустой запрос', 400);

      const settings = normalizeWarmupSettings(body.settings);

      const { error } = await supabase
        .from('tg_outreach_campaigns')
        .update({ warmup_settings: settings, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return jsonError(error.message, 500);

      const { data: active } = await supabase
        .from('tg_outreach_warmup_runs')
        .select('id, settings')
        .eq('campaign_id', id)
        .in('status', ['pending', 'running'])
        .limit(1)
        .maybeSingle();

      if (active) {
        // Старые ключи снимка не выбрасываем: по ним задним числом видно, по
        // какой кривой прогон начинался.
        const current = (active.settings ?? {}) as Record<string, unknown>;
        const { error: runError } = await supabase
          .from('tg_outreach_warmup_runs')
          .update({ settings: { ...current, ...settings } })
          .eq('id', active.id);
        if (runError) return jsonError(runError.message, 500);
      }

      return NextResponse.json({ settings, applies_next_day: Boolean(active) });
    },
  );
}
