import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { downloadSessionToTemp } from '@/lib/tgOutreach/campaignLoop';
import { checkAccount, classifyCheckError } from '@/lib/tgOutreach/accountCheck';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Проверить, жив ли аккаунт и кто в нём ещё сидит.
 *
 * Гейт по статусу кампании тот же, что у профиля: пока идёт рассылка или
 * прогрев, аккаунт занят воркером, и второе подключение через мобильный прокси —
 * лишний повод для сбоя. Проверять на ходу всё равно бессмысленно: работающий
 * аккаунт по определению жив.
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
      if (status && status !== 'stopped' && status !== 'error') {
        return jsonError(
          `Кампания сейчас в состоянии «${status}». Остановите её, чтобы проверить аккаунты: во время работы они заняты.`,
          409,
        );
      }

      const save = async (result: {
        status: string;
        detail: string;
        other_sessions?: unknown[];
        tg_user_id?: number | null;
        tg_username?: string | null;
      }) => {
        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            check_status: result.status,
            check_detail: result.detail.slice(0, 500),
            checked_at: new Date().toISOString(),
            other_sessions: result.other_sessions ?? [],
            ...(result.tg_user_id != null ? { tg_user_id: result.tg_user_id } : {}),
            ...(result.tg_username != null ? { tg_username: result.tg_username } : {}),
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
          (storagePath) => downloadSessionToTemp(auth.supabase, storagePath),
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
        const result = await checkAccount(client);
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
