import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { downloadSessionToTemp } from '@/lib/tgOutreach/campaignLoop';
import { checkAccount, classifyCheckError } from '@/lib/tgOutreach/accountCheck';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Кто заказал проверку — то же правило, что у передачи лида. */
function operatorName(user: { email?: string | null; user_metadata?: Record<string, unknown> | null }): string {
  const meta = user.user_metadata ?? {};
  const named = [meta.full_name, meta.name, meta.username].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return named ?? user.email ?? 'сотрудник портала';
}

/**
 * Проверить, жив ли аккаунт и кто в нём ещё сидит.
 *
 * Два пути, и выбирает между ними состояние кампании.
 *
 * Кампания остановлена — подключаемся отсюда и отвечаем результатом сразу.
 *
 * Кампания работает — не подключаемся вовсе, а ставим заказ в очередь
 * (`check_requested_at`). Сессию держит воркер, и второе подключение к ней даёт
 * AUTH_KEY_DUPLICATED, то есть выключенный аккаунт. Раньше здесь стоял простой
 * отказ «остановите кампанию» — и оператор, разумеется, её не останавливал, а
 * «жив/не жив» на экране устаревал неделями. Теперь проверку выполнит воркер
 * своим уже открытым соединением, дойдя до аккаунта в круге.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.check.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: accountRow } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!accountRow) return jsonError('Аккаунт не найден', 404);
      const account = accountRow as OutreachAccount;

      const { data: campaign } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('status')
        .eq('id', account.campaign_id)
        .maybeSingle();
      const status = (campaign as { status?: string } | null)?.status;
      /**
       * Занят воркером только включённый аккаунт: выключенные круг не берёт
       * вовсе. А диагностировать чаще всего нужно именно их — аккаунт и
       * выключился обычно потому, что с ним что-то не так. Поэтому такие
       * проверяем сразу, не дожидаясь круга, который до них никогда не дойдёт.
       */
      const busyWithWorker = account.is_active
        && status !== undefined && status !== 'stopped' && status !== 'error';
      if (busyWithWorker) {
        // Уже стоит в очереди — второй заказ ничего не меняет, но отвечать
        // «поставлено» на каждое нажатие честнее, чем ошибкой: результат для
        // оператора один и тот же.
        const requestedAt = account.check_requested_at ?? new Date().toISOString();
        if (!account.check_requested_at) {
          const { error: queueErr } = await auth.supabase
            .from('tg_outreach_accounts')
            .update({
              check_requested_at: requestedAt,
              check_requested_by_name: operatorName(auth.user),
            })
            .eq('id', id);
          if (queueErr) return jsonError(queueErr.message, 500);
        }
        return NextResponse.json({
          queued: true,
          requested_at: requestedAt,
          detail: 'Проверка поставлена в очередь: её выполнит рассылка, когда дойдёт до этого аккаунта в круге (обычно несколько минут). Останавливать кампанию не нужно.',
        });
      }

      const save = async (result: {
        status: string;
        detail: string;
        other_sessions?: unknown[];
        tg_user_id?: number | null;
        tg_username?: string | null;
        phone?: string | null;
      }) => {
        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            check_status: result.status,
            check_detail: result.detail.slice(0, 500),
            checked_at: new Date().toISOString(),
            other_sessions: result.other_sessions ?? [],
            // Заказ на проверку снимаем: он выполнен, пусть и не воркером.
            check_requested_at: null,
            check_requested_by_name: null,
            ...(result.tg_user_id != null ? { tg_user_id: result.tg_user_id } : {}),
            ...(result.tg_username != null ? { tg_username: result.tg_username } : {}),
            // Телефона в tdata нет — он приходит только от Telegram, и это
            // единственное место, где портал его узнаёт.
            ...(result.phone ? { phone: result.phone } : {}),
          })
          .eq('id', id);
      };

      // Нет данных сессии — до Telegram даже не идём: это состояние портала, а
      // не аккаунта, и лечится перезаливкой файла, а не проверкой.
      const hasSession = Boolean(account.session_data?.trim() || account.session_file_path);
      if (!hasSession) {
        const result = { status: 'no_session', detail: 'в портале нет сессии — перезалейте файл' };
        await save(result);
        return NextResponse.json(result);
      }

      const { data: proxyRow } = account.proxy_id
        ? await auth.supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
        : { data: null };

      let client;
      try {
        client = await createGramClient(
          account,
          (proxyRow as OutreachProxy) ?? null,
          // Служебным ключом: бакет с сессиями приватный, и пользовательскому
          // клиенту хранилище отвечает «Object not found» — тем же текстом, что
          // и на реально отсутствующий файл.
          (storagePath) => downloadSessionToTemp(supabaseAdmin ?? auth.supabase, storagePath),
        );
      } catch (e) {
        // Не дошли до Telegram — разбор ошибки тот же, что и внутри проверки:
        // «прокси мёртв» и «сессия отозвана» одинаково важны и различаются
        // только текстом ошибки.
        const result = classifyCheckError(e instanceof Error ? e.message : String(e));
        await save(result);
        return NextResponse.json(result);
      }

      try {
        // К @SpamBot идём только если аккаунт уже числится ограниченным: у
        // здорового ответ предсказуем и не стоит лишнего исходящего сообщения
        // с боевого номера.
        const result = await checkAccount(client, {
          askSpamBotWhenRestricted: account.check_status === 'restricted',
        });
        await save(result);
        return NextResponse.json(result);
      } finally {
        try {
          await client.disconnect();
        } catch {
          /* соединение и так рвётся */
        }
      }
    },
  );
}
