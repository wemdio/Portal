import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { data: bases, error } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name, notes, created_at')
        .order('created_at', { ascending: false });
      if (error) return jsonError(error.message, 500);

      // Счётчики по состояниям — то, ради чего оператор открывает список.
      const items = [];
      for (const base of bases ?? []) {
        const b = base as { id: string };
        const { data: rows } = await auth.supabase
          .from('tg_outreach_base_contacts')
          .select('status')
          .eq('base_id', b.id);
        const counts = { total: 0, pending: 0, sent: 0, replied: 0, failed: 0, skipped: 0 };
        for (const r of (rows ?? []) as Array<{ status: keyof typeof counts }>) {
          counts.total++;
          if (r.status in counts) counts[r.status]++;
        }
        items.push({ ...base, counts });
      }

      return NextResponse.json({ items });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const body = (await req.json().catch(() => null)) as { name?: string; notes?: string } | null;
      const name = body?.name?.trim();
      if (!name) return jsonError('Укажите название базы', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_bases')
        .insert({ user_id: auth.user.id, name, notes: body?.notes?.trim() ?? '' })
        .select()
        .single();
      if (error) return jsonError(error.message, 500);

      return NextResponse.json(data, { status: 201 });
    },
  );
}
