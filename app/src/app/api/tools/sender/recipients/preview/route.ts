import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { FileParseError, parseMailboxFile } from '@/lib/sender/fileParse';
import { describeRecipientColumns } from '@/lib/sender/recipientImport';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * POST — разбор базы получателей без записи: какие колонки нашлись и какие
 * переменные можно подставить в письмо. Форма кампании зовёт его сразу после
 * выбора файла, чтобы письмо писалось уже с подсказками по этой базе.
 * Сама загрузка — /campaigns/[id]/recipients, тем же разбором.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.recipients.preview' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError('Ожидается файл с получателями', 400);
    }

    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('Добавьте файл базы (CSV или XLSX)', 400);
    if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 20 МБ', 400);

    try {
      const rows = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      return NextResponse.json(describeRecipientColumns(rows));
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }
  });
}
