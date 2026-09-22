import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { FileParseError, parseMailboxFile } from '@/lib/sender/fileParse';
import { describeRecipientColumns, parseRecipientRows } from '@/lib/sender/recipientImport';
import { applyVars, followUpSubject, recipientVars } from '@/lib/sender/template';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SAMPLE = 2;
const MAX_STEPS = 5;

/**
 * POST — разбор базы получателей без записи: какие колонки нашлись и какие
 * переменные можно подставить в письмо. Форма кампании зовёт его сразу после
 * выбора файла, чтобы письмо писалось уже с подсказками по этой базе.
 * Сама загрузка — /campaigns/[id]/recipients, тем же разбором.
 *
 * С полем steps (JSON-массив {subject, body}) ответ дополняется предпросмотром
 * на реальных строках файла (задача 5.6): что фактически уедет лиду, с учётом
 * пустых переменных — агрегат по колонкам этого не показывает.
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

    // Необязательные шаги письма для предпросмотра; битый JSON молча игнорируем —
    // разбор файла важнее, форма покажет свою ошибку про переменные.
    let steps: { subject?: string; body?: string }[] = [];
    const rawSteps = form.get('steps');
    if (typeof rawSteps === 'string' && rawSteps.trim()) {
      try {
        const parsed = JSON.parse(rawSteps) as unknown;
        if (Array.isArray(parsed)) {
          steps = (parsed as { subject?: unknown; body?: unknown }[])
            .slice(0, MAX_STEPS)
            .map((s) => ({ subject: typeof s.subject === 'string' ? s.subject : '', body: typeof s.body === 'string' ? s.body : '' }))
            .filter((s) => s.body.trim());
        }
      } catch {
        /* предпросмотр не обязательная часть ответа */
      }
    }

    try {
      const parsedFile = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      const columns = describeRecipientColumns(parsedFile.rows);

      let samples: { email: string; steps: { subject: string; body: string }[] }[] | undefined;
      if (steps.length) {
        const parsed = parseRecipientRows(parsedFile.rows);
        samples = parsed.recipients.slice(0, SAMPLE).map((recipient) => {
          const vars = recipientVars(recipient);
          const firstSubject = applyVars(steps[0].subject ?? '', vars);
          return {
            email: recipient.email,
            steps: steps.map((step, index) => ({
              subject: index === 0
                ? firstSubject
                : followUpSubject(applyVars(step.subject ?? '', vars), firstSubject),
              body: applyVars(step.body ?? '', vars),
            })),
          };
        });
      }

      return NextResponse.json({
        ...columns,
        fileRows: parsedFile.totalRows,
        truncated: parsedFile.totalRows > parsedFile.rows.length ? parsedFile.rows.length : null,
        samples,
      });
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }
  });
}
