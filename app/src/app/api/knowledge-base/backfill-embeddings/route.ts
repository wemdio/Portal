import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';
import { embedChunksBatch } from '@/lib/knowledgeBase/embeddings';

const BATCH_SIZE = 500;

export const POST = withKbAuth(async (_req, { supabase }) => {
  const { count } = await supabase
    .from('kb_chunks')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  if (!count) return NextResponse.json({ message: 'All chunks already embedded', remaining: 0 });

  const { data: batch } = await supabase
    .from('kb_chunks')
    .select('id, content')
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (!batch?.length) return NextResponse.json({ message: 'No chunks to embed', remaining: 0 });

  const processed = await embedChunksBatch(supabase, batch);

  return NextResponse.json({
    processed,
    remaining: count - processed,
    message: `Embedded ${processed} chunks. ${count - processed} remaining.`,
  });
});
