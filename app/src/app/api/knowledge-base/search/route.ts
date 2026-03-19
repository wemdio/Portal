import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';
import { searchChunks } from '@/lib/knowledgeBase/contextRetriever';
import type { KbCategory } from '@/lib/knowledgeBase/types';

export const GET = withKbAuth(async (req, { supabase }) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();
  const category = url.searchParams.get('category') as KbCategory | null;
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '20')));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));

  if (!q) return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });

  const result = await searchChunks(supabase, q, {
    category: category ?? undefined,
    limit,
    offset,
  });

  return NextResponse.json(result);
});
