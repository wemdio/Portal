import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';
import { getRelevantContext } from '@/lib/knowledgeBase/contextRetriever';
import type { KbCategory } from '@/lib/knowledgeBase/types';

export const GET = withKbAuth(async (req, { supabase }) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();
  const category = url.searchParams.get('category') as KbCategory | null;
  const maxChunks = Math.min(10, Math.max(1, Number(url.searchParams.get('max_chunks') ?? '5')));
  const maxTokens = Math.min(4000, Math.max(100, Number(url.searchParams.get('max_tokens') ?? '2000')));

  if (!q) return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });

  const context = await getRelevantContext(supabase, q, {
    category: category ?? undefined,
    maxChunks,
    maxTokens,
  });

  return NextResponse.json({ context, has_content: context.length > 0 });
});
