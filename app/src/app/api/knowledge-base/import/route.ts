import { NextResponse } from 'next/server';
import { withKbAuth } from '@/lib/knowledgeBase/apiHelper';
import { chunkText } from '@/lib/knowledgeBase/chunker';

export const POST = withKbAuth(async (req, { supabase, userId }) => {
  const { source } = (await req.json()) as { source: 'audio_transcripts' | 'tg_video_transcripts' };

  if (source === 'audio_transcripts') {
    return importAudioTranscripts(supabase, userId);
  }
  if (source === 'tg_video_transcripts') {
    return importTgVideoTranscripts(supabase, userId);
  }

  return NextResponse.json({ error: 'Unknown source' }, { status: 400 });
});

async function importAudioTranscripts(
  supabase: Parameters<Parameters<typeof withKbAuth>[0]>[1]['supabase'],
  userId: string,
) {
  const { data: transcripts, error } = await supabase
    .from('audio_transcripts')
    .select('id, filename, text, length, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!transcripts?.length) return NextResponse.json({ imported: 0 });

  const { data: existing } = await supabase
    .from('kb_documents')
    .select('metadata')
    .eq('source_type', 'imported')
    .eq('category', 'transcript');

  const importedIds = new Set(
    (existing ?? []).map(d => (d.metadata as Record<string, unknown>)?.source_id).filter(Boolean),
  );

  let imported = 0;
  for (const t of transcripts) {
    if (importedIds.has(t.id)) continue;
    if (!t.text?.trim()) continue;

    const tokenCount = Math.ceil(t.text.length / 4);
    const { data: doc, error: docErr } = await supabase
      .from('kb_documents')
      .insert({
        user_id: userId,
        title: t.filename || `Audio transcript ${t.id.slice(0, 8)}`,
        category: 'transcript',
        source_type: 'imported',
        description: `Imported from audio_transcripts (${t.created_at})`,
        content_text: t.text,
        token_count: tokenCount,
        metadata: { source_table: 'audio_transcripts', source_id: t.id, duration: t.length },
        status: 'ready',
      })
      .select('id')
      .single();

    if (docErr || !doc) continue;

    const chunks = chunkText(t.text);
    if (chunks.length > 0) {
      await supabase.from('kb_chunks').insert(
        chunks.map((c, i) => ({
          document_id: doc.id,
          chunk_index: i,
          content: c.content,
          token_count: c.tokenCount,
          metadata: c.metadata,
        })),
      );
    }
    imported++;
  }

  return NextResponse.json({ imported });
}

async function importTgVideoTranscripts(
  supabase: Parameters<Parameters<typeof withKbAuth>[0]>[1]['supabase'],
  userId: string,
) {
  const { data: transcripts, error } = await supabase
    .from('tg_video_transcripts')
    .select('id, filename, sender_name, text, duration_seconds, created_at')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!transcripts?.length) return NextResponse.json({ imported: 0 });

  const { data: existing } = await supabase
    .from('kb_documents')
    .select('metadata')
    .eq('source_type', 'imported')
    .eq('category', 'transcript');

  const importedIds = new Set(
    (existing ?? []).map(d => (d.metadata as Record<string, unknown>)?.source_id).filter(Boolean),
  );

  let imported = 0;
  for (const t of transcripts) {
    if (importedIds.has(t.id)) continue;
    if (!t.text?.trim()) continue;

    const tokenCount = Math.ceil(t.text.length / 4);
    const { data: doc, error: docErr } = await supabase
      .from('kb_documents')
      .insert({
        user_id: userId,
        title: t.filename || `TG video by ${t.sender_name || 'Unknown'}`,
        category: 'transcript',
        source_type: 'imported',
        description: `TG video transcript by ${t.sender_name || 'Unknown'} (${t.created_at})`,
        content_text: t.text,
        token_count: tokenCount,
        metadata: {
          source_table: 'tg_video_transcripts',
          source_id: t.id,
          sender_name: t.sender_name,
          duration_seconds: t.duration_seconds,
        },
        status: 'ready',
      })
      .select('id')
      .single();

    if (docErr || !doc) continue;

    const chunks = chunkText(t.text);
    if (chunks.length > 0) {
      await supabase.from('kb_chunks').insert(
        chunks.map((c, i) => ({
          document_id: doc.id,
          chunk_index: i,
          content: c.content,
          token_count: c.tokenCount,
          metadata: { ...c.metadata, sender_name: t.sender_name },
        })),
      );
    }
    imported++;
  }

  return NextResponse.json({ imported });
}
