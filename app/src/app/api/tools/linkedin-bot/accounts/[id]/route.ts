import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withToolTrace(
    { request: req, operation: 'tools.linkedin-bot.accounts.by-id.patch' },
    async () => {
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);

        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);

        const { id } = await params;
        if (!id) return jsonError('Missing id', 400);

        let body: { name?: string; is_active?: boolean };
        try {
          body = await req.json();
        } catch {
          return jsonError('Invalid JSON body', 400);
        }

        const updates: Record<string, unknown> = {};
        if (typeof body.name === 'string') updates.name = body.name.trim();
        if (typeof body.is_active === 'boolean') updates.is_active = body.is_active;

        if (Object.keys(updates).length === 0) {
          return jsonError('No valid fields to update', 400);
        }

        const { data, error } = await supabase
          .from('linkedin_accounts')
          .update(updates)
          .eq('id', id)
          .eq('user_id', user.id)
          .select('id, name, login, is_active, created_at')
          .single();

        if (error) return jsonError(error.message, 500);
        if (!data) return jsonError('Account not found', 404);
        return NextResponse.json(data);
    },
  );
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withToolTrace(
    { request: _req, operation: 'tools.linkedin-bot.accounts.by-id.delete' },
    async () => {
        const token = getBearerToken(_req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);

        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);

        const { id } = await params;
        if (!id) return jsonError('Missing id', 400);

        const { error } = await supabase
          .from('linkedin_accounts')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);

        if (error) return jsonError(error.message, 500);
        return new NextResponse(null, { status: 204 });
    },
  );
}
