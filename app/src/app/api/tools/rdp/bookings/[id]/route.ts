import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import { withToolTrace } from '@/lib/toolTrace';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

async function getUserRole(userId: string): Promise<UserRole | null> {
  const { data } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
  return (data?.role as UserRole) ?? null;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.rdp.bookings.by-id.delete' },
    async () => {
      
        const user = await getUser(req);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const { id } = await params;
        const userRole = await getUserRole(user.id);
      
        const { data: booking } = await admin
          .from('rdp_bookings')
          .select('id, user_id, status')
          .eq('id', id)
          .maybeSingle();
      
        if (!booking) {
          return NextResponse.json({ error: 'Бронь не найдена' }, { status: 404 });
        }
        const canRemove = booking.user_id === user.id || isAdmin(userRole);
        if (!canRemove) {
          return NextResponse.json({ error: 'Можно отменить только свою бронь' }, { status: 403 });
        }
        if (booking.status === 'cancelled' || booking.status === 'expired') {
          return NextResponse.json({ error: 'Бронь уже отменена' }, { status: 400 });
        }
      
        const { error } = await admin
          .from('rdp_bookings')
          .update({ status: 'cancelled' })
          .eq('id', id);
      
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
    },
  );
}
