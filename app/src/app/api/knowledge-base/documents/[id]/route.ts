import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';

export const GET = withKbAuth(async (_req, { supabase }, params) => {
  const docId = params?.id;
  if (!docId) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data: doc, error: docErr } = await supabase
    .from('kb_documents')
    .select('*')
    .eq('id', docId)
    .single();

  if (docErr || !doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

  const { data: chunks } = await supabase
    .from('kb_chunks')
    .select('id, chunk_index, content, token_count, metadata')
    .eq('document_id', docId)
    .order('chunk_index', { ascending: true });

  return NextResponse.json({ document: doc, chunks: chunks ?? [] });
});

export const DELETE = withKbAuth(async (_req, { supabase }, params) => {
  const docId = params?.id;
  if (!docId) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data: doc } = await supabase
    .from('kb_documents')
    .select('file_path')
    .eq('id', docId)
    .single();

  if (doc?.file_path) {
    await supabase.storage.from('knowledge-base').remove([doc.file_path]);
  }

  const { error } = await supabase
    .from('kb_documents')
    .delete()
    .eq('id', docId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
});
