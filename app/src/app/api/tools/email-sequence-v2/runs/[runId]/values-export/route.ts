import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function sanitizeFilename(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

async function buildDocx(values: string, companyName: string | null): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');

  const title = companyName ? `Ценности ${companyName}` : 'Ценности продукта';
  const lines = values.split('\n');

  const children: InstanceType<typeof Paragraph>[] = [];
  children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: '' }));

  for (const line of lines) {
    if (!line.trim()) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }
    const headingMatch = line.match(/^(\d+\.\s.+)$/);
    if (headingMatch) {
      children.push(new Paragraph({ text: line, heading: HeadingLevel.HEADING_2 }));
      continue;
    }
    children.push(new Paragraph({ children: [new TextRun({ text: line })] }));
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBuffer(doc);
  return Buffer.from(blob);
}

/**
 * GET ?format=docx — отдаёт DOCX файл с ценностями.
 * PDF-вариант делается на клиенте через window.print() (см. UI), потому что
 * генерировать PDF с поддержкой кириллицы на сервере без TTF-шрифтов
 * нетривиально, а DOCX свободно открывается и редактируется в Word/Pages.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  const format = (req.nextUrl.searchParams.get('format') ?? 'docx').toLowerCase();
  if (format !== 'docx') {
    return jsonError('Поддерживается только формат docx (PDF — через печать на клиенте).', 400);
  }

  const { data: run, error } = await supabase
    .from('email_sequence_v2_runs')
    .select('id,user_id,company_name,values_text')
    .eq('id', runId)
    .single();
  if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);
  if (run.user_id !== user.id) return jsonError('Forbidden', 403);
  if (!run.values_text) return jsonError('Ценности ещё не сгенерированы.', 400);

  const baseName = sanitizeFilename(`Ценности ${run.company_name ?? 'компании'}`);
  const buffer = await buildDocx(run.values_text, run.company_name);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baseName + '.docx')}`,
    },
  });
}
