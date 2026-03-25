import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';
import { chunkText, chunkDialogue } from '@/lib/knowledgeBase/chunker';
import { parseChatCsv } from '@/lib/knowledgeBase/csvParser';
import { embedChunksBatch } from '@/lib/knowledgeBase/embeddings';
import type { KbCategory, KbSourceType } from '@/lib/knowledgeBase/types';

export const GET = withKbAuth(async (req, { supabase }) => {
  const url = new URL(req.url);
  const category = url.searchParams.get('category') as KbCategory | null;
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '50')));

  let query = supabase
    .from('kb_documents')
    .select('id, title, category, source_type, description, original_filename, token_count, status, metadata, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  if (category) query = query.eq('category', category);

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ documents: data ?? [], total: count ?? 0, page, per_page: perPage });
});

export const POST = withKbAuth(async (req, { supabase, userId }) => {
  const contentType = req.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    return handleFileUpload(req, supabase, userId);
  }

  return handleManualCreate(req, supabase, userId);
});

async function handleManualCreate(
  req: NextRequest,
  supabase: ReturnType<typeof import('@/lib/supabaseRouteClient').createAuthedSupabaseClient>,
  userId: string,
) {
  const body = await req.json();
  const {
    title,
    category = 'other',
    description = '',
    content_text = '',
  } = body as {
    title: string;
    category?: KbCategory;
    description?: string;
    content_text?: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 });
  }
  if (!content_text?.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 });
  }

  const tokenCount = Math.ceil(content_text.length / 4);

  const { data: doc, error: docErr } = await supabase
    .from('kb_documents')
    .insert({
      user_id: userId,
      title: title.trim(),
      category,
      source_type: 'manual' as KbSourceType,
      description: description.trim(),
      content_text,
      token_count: tokenCount,
      status: 'ready',
    })
    .select('id')
    .single();

  if (docErr) return NextResponse.json({ error: docErr.message }, { status: 500 });

  const chunks = chunkText(content_text);
  if (chunks.length > 0) {
    const rows = chunks.map((c, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content: c.content,
      token_count: c.tokenCount,
      metadata: c.metadata,
    }));
    const { data: inserted, error: chunkErr } = await supabase.from('kb_chunks').insert(rows).select('id, content');
    if (chunkErr) {
      console.error('Chunk insert error:', chunkErr);
    }
    if (inserted?.length) {
      embedChunksBatch(supabase, inserted).catch(() => {});
    }
  }

  return NextResponse.json({ id: doc.id, chunks_created: chunks.length }, { status: 201 });
}

async function handleFileUpload(
  req: NextRequest,
  supabase: ReturnType<typeof import('@/lib/supabaseRouteClient').createAuthedSupabaseClient>,
  userId: string,
) {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const title = (formData.get('title') as string)?.trim() || file?.name || 'Untitled';
  const category = (formData.get('category') as KbCategory) || 'other';
  const description = (formData.get('description') as string)?.trim() || '';

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const ext = file.name.split('.').pop()?.toLowerCase();
  const isCsv = ext === 'csv' || file.type === 'text/csv';
  const isText = ext === 'txt' || ext === 'md' || file.type.startsWith('text/');

  if (!isCsv && !isText) {
    return NextResponse.json({ error: 'Only CSV and text files are supported' }, { status: 400 });
  }

  const rawText = await file.text();

  const storagePath = `${userId}/${Date.now()}_${file.name}`;
  const { error: uploadErr } = await supabase.storage
    .from('knowledge-base')
    .upload(storagePath, file, { contentType: file.type });

  if (uploadErr) {
    console.error('Storage upload error:', uploadErr);
  }

  let contentText: string;
  let chunks: ReturnType<typeof chunkText>;
  let metadata: Record<string, unknown> = {};

  if (isCsv) {
    const parsed = parseChatCsv(rawText, file.name);
    metadata = { manager_names: parsed.managerNames, message_count: parsed.messages.length };
    contentText = parsed.messages.map(m =>
      m.date ? `[${m.date}] ${m.speaker}: ${m.text}` : `${m.speaker}: ${m.text}`
    ).join('\n');
    chunks = chunkDialogue(parsed.messages);
  } else {
    contentText = rawText;
    chunks = chunkText(rawText);
  }

  const tokenCount = Math.ceil(contentText.length / 4);

  const { data: doc, error: docErr } = await supabase
    .from('kb_documents')
    .insert({
      user_id: userId,
      title,
      category: isCsv ? 'chat_export' : category,
      source_type: 'upload' as KbSourceType,
      description,
      file_path: uploadErr ? null : storagePath,
      original_filename: file.name,
      content_text: contentText,
      token_count: tokenCount,
      metadata,
      status: 'ready',
    })
    .select('id')
    .single();

  if (docErr) return NextResponse.json({ error: docErr.message }, { status: 500 });

  if (chunks.length > 0) {
    const rows = chunks.map((c, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content: c.content,
      token_count: c.tokenCount,
      metadata: c.metadata,
    }));
    const { data: inserted2, error: chunkErr } = await supabase.from('kb_chunks').insert(rows).select('id, content');
    if (chunkErr) console.error('Chunk insert error:', chunkErr);
    if (inserted2?.length) {
      embedChunksBatch(supabase, inserted2).catch(() => {});
    }
  }

  return NextResponse.json({
    id: doc.id,
    chunks_created: chunks.length,
    token_count: tokenCount,
  }, { status: 201 });
}
