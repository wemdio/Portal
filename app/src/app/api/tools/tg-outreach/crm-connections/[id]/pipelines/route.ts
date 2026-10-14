/**
 * Воронки и этапы подключения — для выпадающих списков блока «Передавать в
 * CRM» в настройках кампании. `id = 'polza'` — наша AMO.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveCrmConnection } from '@/lib/crm/connections';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.crm-connections.pipelines.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Сервер не настроен (service role)', 500);
      const { id } = await ctx.params;

      try {
        const { client } = await resolveCrmConnection(supabaseAdmin, id);
        const pipelines = await client.listPipelines();
        return NextResponse.json({ pipelines });
      } catch (err) {
        return jsonError(`Не удалось получить воронки: ${err instanceof Error ? err.message : String(err)}`, 502);
      }
    },
  );
}
