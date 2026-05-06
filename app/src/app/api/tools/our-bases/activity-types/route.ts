import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await admin
    .from('companies_directory')
    .select('activity_type')
    .not('activity_type', 'is', null)
    .limit(50000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const set = new Set<string>();
  for (const row of data ?? []) {
    const v = (row as { activity_type: string | null }).activity_type;
    if (v && v.trim()) set.add(v.trim());
  }

  const types = Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  return NextResponse.json({ types });
}
