import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { DEFAULT_OPENAI_SETTINGS, DEFAULT_TELEGRAM_SETTINGS } from '@/lib/tgOutreach/types';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;

      const { data, error } = await supabase
        .from('tg_outreach_campaigns')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) return jsonError(error.message, 500);
      const items = (data ?? []) as Record<string, unknown>[];

      /**
       * Сколько аккаунтов кампании сейчас греется.
       *
       * Нужно шапке: с тех пор как прогрев перестал останавливать кампанию
       * (миграция 20260907_0001), «Запущена» перестала быть полным ответом —
       * часть аккаунтов может греться параллельно, и это стоит показать рядом
       * со статусом, а не прятать во вкладку «Аккаунты».
       *
       * Одним запросом на весь список: кампаний единицы, отдельный поход за
       * каждой стоил бы дороже самой страницы.
       */
      const { data: warmingRows } = await supabase
        .from('tg_outreach_accounts')
        .select('campaign_id')
        .eq('is_active', true)
        .gt('warmup_until', new Date().toISOString());

      const warmingByCampaign = new Map<string, number>();
      for (const row of (warmingRows ?? []) as { campaign_id: string }[]) {
        warmingByCampaign.set(row.campaign_id, (warmingByCampaign.get(row.campaign_id) ?? 0) + 1);
      }
      for (const c of items) {
        c.warming_accounts = warmingByCampaign.get(c.id as string) ?? 0;
      }

      return NextResponse.json({ items });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.create' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase, user } = auth;

      let body: { name?: string; openai_settings?: Record<string, unknown>; telegram_settings?: Record<string, unknown> };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const name = body.name?.trim();
      if (!name) return jsonError('Название кампании обязательно', 400);

      const { data, error } = await supabase
        .from('tg_outreach_campaigns')
        .insert({
          user_id: user.id,
          name,
          status: 'stopped',
          openai_settings: body.openai_settings ?? DEFAULT_OPENAI_SETTINGS,
          telegram_settings: body.telegram_settings ?? DEFAULT_TELEGRAM_SETTINGS,
        })
        .select()
        .single();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(data, { status: 201 });
    },
  );
}
