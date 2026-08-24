import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getWebsiteInnLookupUser } from '@/lib/enrich/websiteInnLookupAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

async function ownedJob(req: NextRequest, id: string) {
  const user = await getWebsiteInnLookupUser(req);
  if (!user || !supabaseAdmin) return { user: null, job: null };
  const { data: job } = await supabaseAdmin
    .from('website_inn_lookup_jobs')
    .select('id, user_id, status, total, processed, found, cancel_requested')
    .eq('id', id)
    .maybeSingle();
  return { user, job: job?.user_id === user.id ? job : null };
}

export async function PATCH(req: NextRequest, context: Context) {
  const { id } = await context.params;
  const ownership = await ownedJob(req, id);
  if (!ownership.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!ownership.job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let action = '';
  try {
    action = String(((await req.json()) as { action?: string }).action ?? '');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (action !== 'cancel') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin!
    .from('website_inn_lookup_jobs')
    .update({ cancel_requested: true, updated_at: now })
    .eq('id', id)
    .in('status', ['pending', 'running'])
    .select('id, status, total, processed, found, cancel_requested')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: data ?? ownership.job });
}
