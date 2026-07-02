import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-transcribe.senders.get' },
    async () => {
      
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
          // Match the History list — only completed transcripts are shown
          // there, so error/skipped rows shouldn't inflate the chip counts.
          .eq('status', 'completed')
          .order('sender_name');
      
        if (error) {
          return jsonError(error.message, 500);
        }
      
        const uniqueSenders = [...new Set((data ?? []).map((r) => r.sender_name))];
      
        return NextResponse.json({ senders: uniqueSenders });
    },
  );
}
