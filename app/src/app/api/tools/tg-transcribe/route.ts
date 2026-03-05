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

  const url = new URL(req.url);
  const sender = url.searchParams.get('sender')?.trim() || null;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

  let query = supabase
    .from('tg_video_transcripts')
    .select('id, created_at, tg_chat_id, tg_message_id, tg_sender_id, sender_name, filename, file_size_bytes, duration_seconds, text, length, status, error_text', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (sender) {
    query = query.eq('sender_name', sender);
  }

  const { data, error, count } = await query;

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    items: data ?? [],
    total: count ?? 0,
  });
}
