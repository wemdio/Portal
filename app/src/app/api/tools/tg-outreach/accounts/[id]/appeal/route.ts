import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { parseAppealTarget } from '@/lib/tgOutreach/freezeAppeal';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Заказать обжалование заморозки.
 *
 * Здесь только очередь: само обращение отправляет воркер тем соединением,
 * которое уже держит. Подключиться из приложения нельзя — второе подключение к
 * той же сессии Telegram встречает AUTH_KEY_DUPLICATED и выключает аккаунт.
 *
 * Отказываем заранее, если писать некуда: обжалование подают один раз и ждут
 * ответа неделями, поэтому «поставлено в очередь» на аккаунте без адреса было
 * бы обманом — оператор ушёл бы ждать несуществующего ответа.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.by-id.appeal.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      let body: { text?: unknown; requested_by_name?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return jsonError('Текст обращения обязателен', 400);
      if (text.length > 4000) return jsonError('Текст обращения длиннее 4000 символов', 400);

      const { data: account, error: aErr } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('id, session_name, freeze_appeal_url, check_status')
        .eq('id', id)
        .maybeSingle();
      if (aErr) return jsonError(aErr.message, 500);
      if (!account) return jsonError('Аккаунт не найден', 404);

      const target = parseAppealTarget(
        (account as { freeze_appeal_url?: string | null }).freeze_appeal_url,
      );
      if (target.kind === 'web') {
        return jsonError(
          `Telegram предлагает обжаловать на странице ${target.url} — из аккаунта туда не написать. Откройте ссылку в браузере.`,
          409,
        );
      }
      if (target.kind === 'unknown') {
        return jsonError(
          'У аккаунта нет адреса обжалования. Нажмите «Проверить» — адрес приходит вместе с заморозкой.',
          409,
        );
      }

      const { error } = await auth.supabase
        .from('tg_outreach_accounts')
        .update({
          appeal_requested_at: new Date().toISOString(),
          appeal_requested_by_name:
            typeof body.requested_by_name === 'string' ? body.requested_by_name.slice(0, 100) : null,
          appeal_text: text,
          appeal_status: null,
          appeal_detail: null,
        })
        .eq('id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ queued: true, target: target.peer });
    },
  );
}
