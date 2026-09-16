import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { FileParseError, parseMailboxFile } from '@/lib/sender/fileParse';
import { parseRecipientRows } from '@/lib/sender/recipientImport';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const INSERT_CHUNK = 500;

/**
 * POST — загрузка базы получателей файлом (CSV/XLSX).
 * Адреса из стоп-листа в кампанию не попадают, повторная загрузка того же
 * файла не создаёт дублей: адрес уникален в пределах кампании.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.recipients.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id: campaignId } = await params;
    const { data: campaign } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id, status')
      .eq('id', campaignId)
      .maybeSingle();
    if (!campaign) return jsonError('Кампания не найдена', 404);
    // База, долитая в уже идущую кампанию, должна поехать сразу: у черновика
    // очередь выставляется в момент запуска.
    const nextStepAt = campaign.status === 'running' ? new Date().toISOString() : null;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError('Ожидается файл с получателями', 400);
    }

    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('Добавьте файл базы (CSV или XLSX)', 400);
    if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 20 МБ', 400);

    let parsed;
    try {
      const rows = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      parsed = parseRecipientRows(rows);
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }

    if (!parsed.recipients.length) {
      return jsonError('В файле не нашлось ни одного корректного адреса', 400);
    }

    const emails = parsed.recipients.map((r) => r.email);
    const suppressed = new Set<string>();
    for (let i = 0; i < emails.length; i += INSERT_CHUNK) {
      const { data } = await supabaseAdmin
        .from('sender_suppressions')
        .select('email')
        .in('email', emails.slice(i, i + INSERT_CHUNK));
      for (const row of data ?? []) suppressed.add(String(row.email));
    }

    const rows = parsed.recipients
      .filter((recipient) => !suppressed.has(recipient.email))
      .map((recipient) => ({
        campaign_id: campaignId,
        email: recipient.email,
        name: recipient.name,
        vars: recipient.vars,
        status: 'active',
        next_step_at: nextStepAt,
      }));

    let imported = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const { data, error } = await supabaseAdmin
        .from('sender_recipients')
        .upsert(chunk, { onConflict: 'campaign_id,email', ignoreDuplicates: true })
        .select('id');
      if (error) return jsonError(error.message, 500);
      imported += data?.length ?? 0;
    }

    return NextResponse.json({
      imported,
      skippedInvalid: parsed.invalid,
      skippedDuplicates: parsed.duplicates,
      skippedSuppressed: suppressed.size,
    });
  });
}
