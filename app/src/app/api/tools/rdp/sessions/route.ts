import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function POST(req: NextRequest) {
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

  const now = new Date();

  const { data: otherBooking } = await admin
    .from('rdp_bookings')
    .select('id, user_id')
    .in('status', ['pending', 'active'])
    .lte('starts_at', now.toISOString())
    .gt('ends_at', now.toISOString())
    .neq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (otherBooking) {
    return NextResponse.json(
      { error: 'Сейчас действует бронь другого пользователя' },
      { status: 409 },
    );
  }

  let bookingId: string | null = null;
  const { data: myBooking } = await admin
    .from('rdp_bookings')
    .select('id')
    .eq('user_id', user.id)
    .in('status', ['pending', 'active'])
    .lte('starts_at', now.toISOString())
    .gt('ends_at', now.toISOString())
    .limit(1)
    .maybeSingle();

  if (myBooking) {
    bookingId = myBooking.id;
    await admin
      .from('rdp_bookings')
      .update({ status: 'active' })
      .eq('id', myBooking.id);
  }

  const { data: session, error } = await admin
    .from('rdp_sessions')
    .insert({
      user_id: user.id,
      booking_id: bookingId,
    })
    .select('id, user_id, booking_id, started_at, status')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ session });
}

export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: session } = await admin
    .from('rdp_sessions')
    .select('id, booking_id')
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

  if (session.booking_id) {
    await admin
      .from('rdp_bookings')
      .update({ status: 'completed' })
      .eq('id', session.booking_id);
  }

  return NextResponse.json({ ok: true });
}
