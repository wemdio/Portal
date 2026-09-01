import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import {
  buildDialogBaseIndex,
  type DialogBaseContact,
  type DialogBaseRef,
} from '@/lib/tgOutreach/dialogBase';
import { usernameKey } from '@/lib/tgOutreach/report';

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
      /**
       * Чей это диалог с нашей стороны.
       *
       * Фильтруем на сервере, а не в уже загруженной странице: список идёт по
       * тридцать штук, и отбор внутри страницы показывал бы «диалогов этого
       * аккаунта — три», хотя их полторы сотни на следующих страницах.
       */
      const accountId = url.searchParams.get('account_id');
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
      if (accountId) {
        query = query.eq('account_id', accountId);
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

      /**
       * Из какой базы («гипотезы») пришёл каждый собеседник.
       *
       * Оператор размечает диалоги подряд, и вопрос «а это чья гипотеза»
       * возникает на каждом втором. Без подписи ответ добывался вручную:
       * выгрузить базы вкладкой «Базы» и поискать ник в каждой.
       *
       * Считаем только по странице, которую отдаём: контакты кампании — это
       * тысячи строк, тянуть их целиком ради тридцати подписей незачем.
       */
      const { data: baseRows, error: basesError } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name')
        .eq('campaign_id', campaignId);
      // Подпись — украшение списка, а не его смысл: если базы не прочитались,
      // отдаём диалоги без неё, а не пятисотку на весь экран.
      const bases = (basesError ? [] : (baseRows ?? [])) as DialogBaseRef[];

      if (bases.length && rows.length) {
        const baseIds = bases.map((b) => b.id);
        const usernames = [...new Set(
          rows.map((r) => usernameKey(r.tg_username as string | null)).filter(Boolean),
        )];
        const tgIds = [...new Set(
          rows.map((r) => r.tg_user_id as number | null).filter((v): v is number => typeof v === 'number'),
        )];

        // Два запроса вместо одного `or`: юзернеймы и id — разные колонки, а
        // склейка их в один фильтр требует экранирования пользовательских
        // строк внутри строки фильтра.
        const contactSelect = 'base_id, username, tg_user_id, sent_at';
        const [byUsername, byTgId] = await Promise.all([
          usernames.length
            ? auth.supabase.from('tg_outreach_base_contacts').select(contactSelect)
                .in('base_id', baseIds).in('username', usernames)
            : Promise.resolve({ data: [] as unknown[] }),
          tgIds.length
            ? auth.supabase.from('tg_outreach_base_contacts').select(contactSelect)
                .in('base_id', baseIds).in('tg_user_id', tgIds)
            : Promise.resolve({ data: [] as unknown[] }),
        ]);

        const contacts = [
          ...((byUsername.data ?? []) as DialogBaseContact[]),
          ...((byTgId.data ?? []) as DialogBaseContact[]),
        ];
        const matchBase = buildDialogBaseIndex(bases, contacts);
        for (const row of rows) {
          const match = matchBase({
            tg_username: row.tg_username as string | null,
            tg_user_id: row.tg_user_id as number | null,
          });
          if (match) row.base = match;
        }
      }

      return NextResponse.json({ items: rows, total: count ?? 0 });
    },
  );
}
