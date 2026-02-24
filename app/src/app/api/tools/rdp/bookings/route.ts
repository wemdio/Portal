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

  const { data, error } = await admin
    .from('rdp_bookings')
    .select('id, user_id, starts_at, ends_at, status, notes, created_at, profiles(full_name)')
    .in('status', ['pending', 'active'])
    .order('starts_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bookings: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { starts_at, ends_at, notes } = body;

  if (!starts_at || !ends_at) {
    return NextResponse.json({ error: 'starts_at и ends_at обязательны' }, { status: 400 });
  }

  const start = new Date(starts_at);
  const end = new Date(ends_at);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return NextResponse.json({ error: 'Неверный формат даты' }, { status: 400 });
  }
  if (end <= start) {
    return NextResponse.json({ error: 'Конец должен быть после начала' }, { status: 400 });
  }
  if (start < new Date()) {
    return NextResponse.json({ error: 'Нельзя бронировать в прошлом' }, { status: 400 });
  }

  const { data: overlap } = await admin
    .from('rdp_bookings')
    .select('id')
    .not('status', 'in', '("cancelled","expired")')
    .lt('starts_at', end.toISOString())
    .gt('ends_at', start.toISOString())
    .limit(1)
    .maybeSingle();

  if (overlap) {
    return NextResponse.json({ error: 'Это время уже забронировано' }, { status: 409 });
  }

  const { data: booking, error } = await admin
    .from('rdp_bookings')
    .insert({
      user_id: user.id,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      notes: notes?.trim() || null,
    })
    .select('id, user_id, starts_at, ends_at, status, notes, created_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ booking });
}
