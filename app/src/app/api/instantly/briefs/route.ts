import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { data, error } = await supabaseInstantly
    .from('instantly_briefs')
    .select('*, instantly_brief_campaigns(id, campaign_id)')
    .eq('uploaded_by', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
});

export const POST = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const contentType = req.headers.get('content-type') ?? '';
  let briefText: string;
  let name: string;
  let fileName: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    const file = formData.get('file');
    name = (formData.get('name') as string) ?? '';

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: 'file (PDF) is required' }, { status: 400 });
    }

    fileName = (file as File).name ?? 'brief.pdf';
    if (!fileName.toLowerCase().endsWith('.pdf') && !file.type.includes('pdf')) {
      return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 });
    }

    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 20MB)' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length < 4 || buffer.toString('utf8', 0, 4) !== '%PDF') {
      return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 });
    }

    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    briefText = result.text?.trim() ?? '';

    if (!briefText) {
      return NextResponse.json(
        { error: 'Could not extract text from PDF' },
        { status: 400 },
      );
    }
  } else {
    const body = (await req.json()) as {
      name?: string;
      brief_text?: string;
      file_name?: string;
    };
    name = body.name ?? '';
    briefText = body.brief_text ?? '';
    fileName = body.file_name ?? null;

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!briefText) {
      return NextResponse.json({ error: 'brief_text is required' }, { status: 400 });
    }
  }

  const { data, error } = await supabaseInstantly
    .from('instantly_briefs')
    .insert({
      name,
      brief_text: briefText,
      file_name: fileName,
      uploaded_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
});
