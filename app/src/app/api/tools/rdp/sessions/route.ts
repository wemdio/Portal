import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.rdp.sessions.post' },
    async () => {
      
        const user = await getUser(req);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const { data: activeSession } = await admin
          .from('rdp_sessions')
          .select('id, user_id, profiles(full_name)')
          .eq('status', 'active')
          .limit(1)
          .maybeSingle();
      
        if (activeSession) {
          if (activeSession.user_id === user.id) {
            return NextResponse.json({ error: 'У вас уже есть активная сессия' }, { status: 409 });
          }
          const name =
            (activeSession as { profiles?: { full_name?: string } | null })?.profiles?.full_name ??
            'другой пользователь';
          return NextResponse.json(
            { error: `Удалённый ПК занят: ${name}` },
            { status: 409 },
          );
        }
      
        const { data: session, error } = await admin
          .from('rdp_sessions')
          .insert({
            user_id: user.id,
            booking_id: null,
          })
          .select('id, user_id, booking_id, started_at, status')
          .single();
      
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ session });
    },
  );
}

export async function PATCH(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.rdp.sessions.heartbeat' },
    async () => {
      const user = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const now = new Date().toISOString();
      const { data: session } = await admin
        .from('rdp_sessions')
        .update({ last_activity_at: now })
        .eq('user_id', user.id)
        .eq('status', 'active')
        .select('id')
        .maybeSingle();

      if (!session) {
        return NextResponse.json({ error: 'Нет активной сессии' }, { status: 404 });
      }

      return NextResponse.json({ ok: true });
    },
  );
}

export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.rdp.sessions.delete' },
    async () => {
      
        const user = await getUser(req);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const { data: session } = await admin
          .from('rdp_sessions')
          .select('id')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .limit(1)
          .maybeSingle();
      
        if (!session) {
          return NextResponse.json({ error: 'Нет активной сессии' }, { status: 404 });
        }
      
        const now = new Date().toISOString();
        await admin
          .from('rdp_sessions')
          .update({ status: 'ended', ended_at: now })
          .eq('id', session.id);
      
        return NextResponse.json({ ok: true });
    },
  );
}
