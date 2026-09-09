import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Контакты базы: посмотреть, поправить, удалить — не выгружая файл.
 *
 * Раньше базу можно было только скачать и залить заново. Чтобы убрать один
 * неверный ник или поправить опечатку в тексте, оператор выгружал триста строк,
 * правил в таблице и загружал обратно — а загрузка кладёт контакты заново, то
 * есть теряет статусы отправки по всей базе.
 */

/** Страница контактов. `q` ищет и по нику, и по тексту сообщения. */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.contacts.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const url = new URL(req.url);
      const q = (url.searchParams.get('q') ?? '').trim().replace(/^@/, '');
      const status = url.searchParams.get('status');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

      let query = auth.supabase
        .from('tg_outreach_base_contacts')
        .select('id, username, message, status, skip_reason, attempts, sent_at, created_at', { count: 'exact' })
        .eq('base_id', id)
        .order('created_at', { ascending: true })
        .range(offset, offset + limit - 1);

      if (status) query = query.eq('status', status);
      if (q) {
        // Экранируем `%` и `_`: без этого ник «a_b» превратился бы в маску и
        // выдал чужие строки, а искали конкретного человека.
        const safe = q.replace(/[%_\\]/g, (ch) => `\\${ch}`);
        query = query.or(`username.ilike.%${safe}%,message.ilike.%${safe}%`);
      }

      const { data, error, count } = await query;
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ items: data ?? [], total: count ?? 0 });
    },
  );
}

/**
 * Очистить базу — удалить все контакты, оставив саму базу.
 *
 * Именно очистить, а не удалить базу: у базы есть имя, чаты-источники и
 * привязка к кампании, и заводить её заново ради замены списка контактов
 * значит терять всё это. Требуем подтверждения числом строк: очистка
 * необратима, а кнопка стоит рядом с безобидными.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.contacts.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { count: total } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .select('id', { count: 'exact', head: true })
        .eq('base_id', id);

      const confirm = parseInt(new URL(req.url).searchParams.get('confirm_total') ?? '', 10);
      if (!Number.isFinite(confirm) || confirm !== (total ?? 0)) {
        return jsonError(
          `База изменилась: сейчас в ней ${total ?? 0} контактов. Обновите список и повторите.`,
          409,
        );
      }

      const { error } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .delete()
        .eq('base_id', id);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ deleted: total ?? 0 });
    },
  );
}
