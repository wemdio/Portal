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

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.rdp.status.get' },
    async () => {
      
        const user = await getUser(req);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      
        const userRole = await getUserRole(user.id);
      
        const { data: activeSession } = await admin
          .from('rdp_sessions')
          .select('id, user_id, started_at, profiles(full_name)')
          .eq('status', 'active')
          .limit(1)
          .maybeSingle();
      
        type SessionProfiles = { full_name?: string }[] | { full_name?: string } | null;
        const profileName = (p: SessionProfiles): string | null =>
          p == null ? null : Array.isArray(p) ? (p[0]?.full_name ?? null) : (p.full_name ?? null);
      
        return NextResponse.json({
          activeSession: activeSession
            ? {
                id: activeSession.id,
                userId: activeSession.user_id,
                userName: profileName(activeSession.profiles as SessionProfiles),
                startedAt: activeSession.started_at,
                isOwn: activeSession.user_id === user.id,
              }
            : null,
          currentUserId: user.id,
          isAdmin: isAdmin(userRole),
        });
    },
  );
}
