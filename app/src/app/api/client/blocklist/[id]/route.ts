import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/client/blocklist/[id] — убрать контакт из чёрного списка.
 *
 * Удаление строго скоупится client_user_id: клиент может удалить только
 * собственные записи, чужой id молча даёт removed:0 (а не 404-зонд).
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  // Мутации демо-аккаунта режутся в requireClientAuth (DEMO_READONLY).

  const db = supabaseInstantly;
  if (!db) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const { id } = await ctx.params;

  const { data, error } = await db
    .from('client_blocked_contacts')
    .delete()
    .eq('id', id)
    .eq('client_user_id', userId)
    .select('email');

  if (error) {
    await logError('client.blocklist.remove_failed', error, { id }, { userId });
    return jsonError('Не удалось удалить запись', 500);
  }

  const removed = (data ?? []).length;
  if (removed > 0) {
    await logAudit(
      'client.blocklist.removed',
      'Client unblocked a contact',
      { email: (data as { email: string }[])[0]?.email },
      { userId },
    );
  }

  return NextResponse.json({ removed });
}
