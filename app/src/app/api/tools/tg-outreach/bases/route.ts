import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type BaseRow = { id: string; name: string; notes: string; created_at: string; campaign_id: string | null };

/** Счётчики по состояниям — то, ради чего оператор открывает список. */
async function withCounts(supabase: SupabaseClient, bases: BaseRow[]) {
  const out = [];
  for (const base of bases) {
    const { data: rows } = await supabase
      .from('tg_outreach_base_contacts')
      .select('status')
      .eq('base_id', base.id);
    const counts = { total: 0, pending: 0, sent: 0, replied: 0, failed: 0, skipped: 0 };
    for (const r of (rows ?? []) as Array<{ status: string }>) {
      counts.total++;
      if (r.status in counts) counts[r.status as keyof typeof counts]++;
    }
    out.push({ ...base, counts });
  }
  return out;
}

/**
 * Базы кампании.
 *
 * `campaign_id` обязателен: до 12.08.2026 роут отдавал ВСЕ базы портала, и во
 * вкладке любой кампании лежали чужие — со своими счётчиками и в одной галочке
 * от запуска. База теперь принадлежит кампании.
 *
 * Отдельно возвращаем `orphans` — базы без кампании. Они остались от кнопки
 * «Создать базу», которая кампанию не спрашивала; портал показывает их
 * отдельным списком, чтобы оператор перенёс их руками, а не чтобы они тихо
 * пропали с экрана.
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const campaignId = new URL(req.url).searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const { data: bases, error } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name, notes, created_at, campaign_id')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false });
      if (error) return jsonError(error.message, 500);

      const { data: orphanRows, error: oErr } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name, notes, created_at, campaign_id')
        .is('campaign_id', null)
        .order('created_at', { ascending: false });
      if (oErr) return jsonError(oErr.message, 500);

      return NextResponse.json({
        items: await withCounts(auth.supabase, (bases ?? []) as BaseRow[]),
        orphans: await withCounts(auth.supabase, (orphanRows ?? []) as BaseRow[]),
      });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const body = (await req.json().catch(() => null)) as
        { name?: string; notes?: string; campaign_id?: string } | null;
      const name = body?.name?.trim();
      if (!name) return jsonError('Укажите название базы', 400);

      // Кампания обязательна: именно её отсутствие здесь и породило базы без
      // владельца, которые светились во вкладке каждой кампании портала.
      const campaignId = body?.campaign_id?.trim();
      if (!campaignId) return jsonError('campaign_id обязателен: база создаётся внутри кампании', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_bases')
        .insert({
          user_id: auth.user.id,
          campaign_id: campaignId,
          name,
          notes: body?.notes?.trim() ?? '',
        })
        .select()
        .single();
      if (error) return jsonError(error.message, 500);

      return NextResponse.json(data, { status: 201 });
    },
  );
}
