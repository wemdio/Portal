import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const url = new URL(req.url);
      const campaignId = url.searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const status = url.searchParams.get('status');
      /**
       * Поиск по собеседнику: никнейм или числовой id.
       *
       * Без него найти конкретного человека в кампании на несколько сотен
       * диалогов можно было только листая страницы по тридцать штук. Ищем на
       * сервере, а не в уже загруженной странице: искомый диалог почти всегда
       * лежит не на ней.
       *
       * `@` и регистр съедаем: оператор копирует ник из Telegram как есть, а в
       * базе он лежит без собачки.
       */
      const q = (url.searchParams.get('q') ?? '').trim().replace(/^@/, '');
      const canSendParam = url.searchParams.get('can_send');
      const isBotParam = url.searchParams.get('tg_is_bot');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

      let query = auth.supabase
        .from('tg_outreach_dialogs')
        .select('*', { count: 'exact' })
        .eq('campaign_id', campaignId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);

      if (status) {
        query = query.eq('status', status);
      }
      if (canSendParam === 'true' || canSendParam === 'false') {
        query = query.eq('can_send', canSendParam === 'true');
      }
      if (isBotParam === 'true' || isBotParam === 'false') {
        query = query.eq('tg_is_bot', isBotParam === 'true');
      }
      if (q) {
        // Запятая разделяет условия в `or`, а внутри неё она сломала бы разбор
        // фильтра. Ник с запятой невозможен, поэтому просто вырезаем.
        const safe = q.replace(/[,()]/g, '');
        if (safe) {
          const digits = /^\d+$/.test(safe);
          // Числовой ввод ищем и как id, и как часть ника: у части контактов
          // ник — это номер телефона.
          query = digits
            ? query.or(`tg_username.ilike.%${safe}%,tg_user_id.eq.${safe}`)
            : query.ilike('tg_username', `%${safe}%`);
        }
      }

      const { data, error, count } = await query;
      if (error) return jsonError(error.message, 500);

      /**
       * Состояние передачи для каждого диалога на странице.
       *
       * Кнопки «передать лида/партнёра» взаимоисключающие, и оператор должен
       * видеть это до клика: узнавать о запрете из ошибки после подтверждения —
       * значит каждый раз собирать предпросмотр впустую.
       */
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const ids = rows.map((r) => r.id as string);
      if (ids.length) {
        // Берём и упавшие: причина сбоя нужна оператору прямо в строке
        // человека — по ней он и чинит. Уходить за ней в общий журнал, где она
        // тонет среди сотен строк круга, — плохой обмен.
        const { data: forwards } = await auth.supabase
          .from('tg_outreach_lead_forwards')
          .select('dialog_id, kind, status, sent_at, error_message, requested_at')
          .in('dialog_id', ids)
          .order('requested_at', { ascending: false });

        /**
         * На диалог может быть несколько записей: упавшие попытки и одна живая.
         * Живая важнее — она определяет, можно ли передавать. Если живой нет,
         * показываем последнюю упавшую с её причиной.
         */
        const active = (status: unknown) => status === 'pending' || status === 'sent';
        const byDialog = new Map<string, Record<string, unknown>>();
        for (const f of (forwards ?? []) as Array<Record<string, unknown>>) {
          const key = f.dialog_id as string;
          const current = byDialog.get(key);
          // Живая побеждает любую отработавшую — не только упавшую, но и снятую
          // оператором: иначе свежая отмена закрыла бы собой передачу, которая
          // на этом диалоге ещё висит.
          if (!current || (active(f.status) && !active(current.status))) byDialog.set(key, f);
        }
        for (const row of rows) {
          const f = byDialog.get(row.id as string);
          if (f) {
            row.forward = {
              kind: f.kind,
              status: f.status,
              sent_at: f.sent_at,
              error_message: f.error_message ?? null,
            };
          }
        }
      }

      return NextResponse.json({ items: rows, total: count ?? 0 });
    },
  );
}
