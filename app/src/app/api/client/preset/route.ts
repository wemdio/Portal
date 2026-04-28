import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data: preset, error } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('id, email_account_ids, daily_limit, daily_max_leads, email_gap_minutes, open_tracking, link_tracking, stop_on_reply, text_only, schedule_from, schedule_to, schedule_days, schedule_timezone, updated_at')
    .eq('client_user_id', userId)
    .maybeSingle();

  if (error) {
    await logError('client.preset.get.failed', error, { userId });
    return jsonError('Не удалось загрузить пресет', 500);
  }

  return NextResponse.json({ preset: preset ?? null });
}
