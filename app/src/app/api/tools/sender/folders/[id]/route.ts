import { NextRequest, NextResponse } from 'next/server';
import { logAudit } from '@/lib/loggerServer';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { SenderOpError } from '@/lib/sender/campaignOps';
import { updateFolder, type FolderPatchInput } from '@/lib/sender/folders';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * PATCH — настройки папки: ящики, окно отправки, пояс, паузы и задержки
 * писем 2–4. Меняется только присланное; проверки — lib/sender/folders.
 * Действует на рассылки, которые создаст следующая заливка из автоаутрича:
 * созданные раньше живут по своим настройкам.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.folders.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as FolderPatchInput | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Невалидный JSON', 400);

    try {
      const result = await updateFolder(id, body);
      // Папка решает, с каких ящиков уйдут будущие рассылки автоаутрича, —
      // кто и что в ней менял, должно быть видно в журнале.
      await logAudit(
        'sender.folder.updated',
        `Рассылка: изменены настройки папки «${result.folder.name}»`,
        { folderId: id, fields: Object.keys(body), droppedMailboxes: result.droppedMailboxes },
        { userId: auth.user.id },
      );
      return NextResponse.json(result);
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }
  });
}
