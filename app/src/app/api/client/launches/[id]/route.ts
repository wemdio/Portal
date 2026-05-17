import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const { id } = await ctx.params;

  const { data: launch, error } = await supabaseInstantly
    .from('client_campaign_launches')
    .select('*')
    .eq('id', id)
    .eq('client_user_id', userId)
    .maybeSingle();

  if (error) {
    await logError('client.launches.get.failed', error, { userId, id });
    return jsonError('Не удалось загрузить запуск', 500);
  }

  if (!launch) return jsonError('Запуск не найден', 404);

  return NextResponse.json({ launch });
}
