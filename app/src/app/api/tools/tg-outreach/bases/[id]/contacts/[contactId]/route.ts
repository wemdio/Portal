import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { normalizeUsername } from '@/lib/tgOutreach/firstTouch/normalizeUsername';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; contactId: string }> };

/**
 * Правка одного контакта базы.
 *
 * Меняются только ник и текст — то, что оператор видит и что мог ввести с
 * опечаткой. Статус отправки, счётчик попыток и отметку об отправке правке не
 * подлежат: это история работы, а не данные, и переписывать её руками значит
 * терять след того, что аккаунт уже делал.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.contacts.patch' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id, contactId } = await ctx.params;

      let body: { username?: unknown; message?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const patch: Record<string, string> = {};
      if (typeof body.username === 'string') {
        const username = normalizeUsername(body.username);
        if (!username) return jsonError('Юзернейм пустой или не разбирается', 400);
        patch.username = username;
      }
      if (typeof body.message === 'string') {
        const message = body.message.trim();
        if (!message) return jsonError('Текст сообщения пустой', 400);
        patch.message = message;
      }
      if (!Object.keys(patch).length) return jsonError('Нет полей для обновления', 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .update(patch)
        .eq('id', contactId)
        .eq('base_id', id)
        .select('id, username, message, status, skip_reason, attempts, sent_at, created_at')
        .maybeSingle();
      if (error) return jsonError(error.message, 500);
      if (!data) return jsonError('Контакт не найден в этой базе', 404);
      return NextResponse.json(data);
    },
  );
}

/**
 * Удалить контакт из базы.
 *
 * `base_id` в условии обязателен: идентификатор контакта приходит из браузера,
 * и без привязки к базе ручка позволила бы удалить строку чужой базы, зная
 * только её id.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.contacts.by-id.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id, contactId } = await ctx.params;

      const { error } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .delete()
        .eq('id', contactId)
        .eq('base_id', id);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ deleted: true });
    },
  );
}
