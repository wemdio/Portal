import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { data: job, error } = await admin
    .from('dfyb_jobs')
    .select('user_id, data')
    .eq('id', id)
    .single();

  if (error || !job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (job.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json({ data: job.data || [] });
}
