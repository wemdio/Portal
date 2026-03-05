import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const { data, error } = await supabase
    .from('tg_video_transcripts')
    .select('sender_name')
    .order('sender_name');

  if (error) {
    return jsonError(error.message, 500);
  }

  const uniqueSenders = [...new Set((data ?? []).map((r) => r.sender_name))];

  return NextResponse.json({ senders: uniqueSenders });
}
