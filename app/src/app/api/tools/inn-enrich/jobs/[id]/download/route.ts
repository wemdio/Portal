import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getInnEnrichUser } from '@/lib/innEnrich/auth';
import { INN_ENRICH_BUCKET } from '@/lib/innEnrich/inn';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function downloadName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '') || 'export';
  return `${base}_обогащённый.xlsx`;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getInnEnrichUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const { data, error } = await supabaseAdmin!
    .from('inn_enrich_jobs')
    .select('id, user_id, status, file_name, result_path')
    .eq('id', id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (data.user_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (data.status !== 'completed' || !data.result_path) {
    return NextResponse.json({ error: 'Результат ещё не готов' }, { status: 409 });
  }

  const { data: blob, error: dlErr } = await supabaseAdmin!.storage
    .from(INN_ENRICH_BUCKET)
    .download(data.result_path);
  if (dlErr || !blob) {
    return NextResponse.json({ error: dlErr?.message ?? 'Файл результата не найден' }, { status: 500 });
  }

  const filename = downloadName(data.file_name ?? 'export');
  const stream = Readable.toWeb(Readable.from(Buffer.from(await blob.arrayBuffer())));
  return new NextResponse(stream as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
