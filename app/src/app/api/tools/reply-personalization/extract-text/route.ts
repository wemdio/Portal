import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { extractTextFromBriefFile } from '@/lib/emailSequenceV2/briefExtractor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Те же форматы и лимит, что у загрузки брифа в Vertical Engine v2. */
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * POST — извлечь текст из загруженного файла (PDF/DOCX/TXT/MD) для полей
 * базы знаний проекта. Stateless: ничего не пишет в БД, просто возвращает
 * текст — фронт кладёт его в соответствующее поле формы, сотрудник правит
 * и сохраняет как обычно.
 */
export const POST = withAuth(async (req: NextRequest) => {
  let file: File | null = null;
  try {
    const form = await req.formData();
    const value = form.get('file');
    if (value instanceof File) file = value;
  } catch {
    return NextResponse.json({ error: 'Ожидается multipart-форма с полем file' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'Файл не передан' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'Файл больше 20 МБ' }, { status: 400 });

  const lowerName = file.name.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return NextResponse.json(
      { error: `Поддерживаются только ${SUPPORTED_EXTENSIONS.join(', ')} — пересохраните файл` },
      { status: 400 },
    );
  }

  try {
    const { text } = await extractTextFromBriefFile(file);
    if (!text.trim()) {
      return NextResponse.json({ error: 'В файле не нашлось текста — возможно, это скан' }, { status: 400 });
    }
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Не удалось прочитать файл' },
      { status: 400 },
    );
  }
});
