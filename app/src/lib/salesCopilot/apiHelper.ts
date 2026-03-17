import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import type { SupabaseClient } from '@supabase/supabase-js';

interface AuthContext {
  supabase: SupabaseClient;
  userId: string;
}

type HandlerFn = (req: NextRequest, ctx: AuthContext, params?: Record<string, string>) => Promise<NextResponse>;

export function withCopilotAuth(handler: HandlerFn) {
  return async (req: NextRequest, routeCtx?: { params: Promise<Record<string, string>> }) => {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
      const params = routeCtx?.params ? await routeCtx.params : undefined;
      return await handler(req, { supabase, userId: user.id }, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  };
}
