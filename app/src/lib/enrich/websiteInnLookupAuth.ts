import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function getWebsiteInnLookupUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!token || !supabaseAdmin) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user;
}
