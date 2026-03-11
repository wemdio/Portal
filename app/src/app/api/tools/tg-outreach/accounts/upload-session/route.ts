import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  const formData = await req.formData();
  const accountId = formData.get('account_id') as string | null;
  const sessionData = formData.get('session_data') as string | null;

  if (!accountId) return jsonError('account_id обязателен', 400);
  if (!sessionData) return jsonError('session_data обязателен', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_accounts')
    .update({ session_data: sessionData })
    .eq('id', accountId)
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}
