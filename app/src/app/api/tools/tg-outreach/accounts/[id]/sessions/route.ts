import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { downloadSessionToTemp } from '@/lib/tgOutreach/campaignLoop';
import {
  checkAccount,
  classifyCheckError,
  describeResetError,
  resetOtherSessions,
} from '@/lib/tgOutreach/accountCheck';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Завершить все сеансы аккаунта, кроме нашего.
 *
 * Гейт по статусу кампании тот же, что у проверки и профиля: пока идёт рассылка
 * или прогрев, аккаунт занят воркером, и второе подключение через мобильный
 * прокси — лишний повод для сбоя.
 *
 * После сброса сразу перечитываем состояние аккаунта тем же `checkAccount`:
 * иначе в списке остался бы старый счётчик чужих сеансов, и оператор не понял
 * бы, сработало или нет.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.sessions.delete' },
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
          `Кампания сейчас в состоянии «${status}». Остановите её, чтобы завершить чужие сеансы: во время работы аккаунты заняты.`,
          409,
        );
      }

      const hasSession = Boolean(account.session_data?.trim() || account.session_file_path);
      if (!hasSession) {
        return jsonError('В портале нет сессии этого аккаунта — перезалейте файл', 409);
      }

      const { data: proxyRow } = account.proxy_id
        ? await auth.supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
        : { data: null };

      let client;
      try {
        client = await createGramClient(
          account,
          (proxyRow as OutreachProxy) ?? null,
          (storagePath) => downloadSessionToTemp(supabaseAdmin ?? auth.supabase, storagePath),
        );
      } catch (e) {
        const result = classifyCheckError(e instanceof Error ? e.message : String(e));
        return jsonError(result.detail, 502);
      }

      try {
        await resetOtherSessions(client);
      } catch (e) {
        try {
          await client.disconnect();
        } catch {
          /* соединение и так рвётся */
        }
        return jsonError(describeResetError(e), 400);
      }

      // Перечитываем на том же живом клиенте — наш сеанс сброс пережил.
      try {
        const fresh = await checkAccount(client);
        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            check_status: fresh.status,
            check_detail: fresh.detail.slice(0, 500),
            checked_at: new Date().toISOString(),
            other_sessions: fresh.other_sessions ?? [],
          })
          .eq('id', id);
        return NextResponse.json(fresh);
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
