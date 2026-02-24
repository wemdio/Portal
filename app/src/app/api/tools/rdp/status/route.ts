import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: activeSession } = await admin
    .from('rdp_sessions')
    .select('id, user_id, started_at, profiles(full_name)')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();

  const { data: upcomingBookings } = await admin
    .from('rdp_bookings')
    .select('id, user_id, starts_at, ends_at, status, notes, profiles(full_name)')
    .in('status', ['pending', 'active'])
    .gt('ends_at', now)
    .order('starts_at', { ascending: true })
    .limit(50);

  type BookingRow = {
    id: string;
    user_id: string;
    starts_at: string;
    ends_at: string;
    status: string;
    notes: string | null;
    profiles?: { full_name?: string } | null;
  };

  return NextResponse.json({
    activeSession: activeSession
      ? {
          id: activeSession.id,
          userId: activeSession.user_id,
          userName:
            (activeSession as { profiles?: { full_name?: string } | null }).profiles?.full_name ??
            null,
          startedAt: activeSession.started_at,
          isOwn: activeSession.user_id === user.id,
        }
      : null,
    bookings: (upcomingBookings ?? []).map((b: BookingRow) => ({
      id: b.id,
      userId: b.user_id,
      userName: b.profiles?.full_name ?? null,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      status: b.status,
      notes: b.notes,
      isOwn: b.user_id === user.id,
    })),
    currentUserId: user.id,
  });
}
