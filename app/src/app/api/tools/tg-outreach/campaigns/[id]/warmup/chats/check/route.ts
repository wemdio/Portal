import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { downloadSessionToTemp } from '@/lib/tgOutreach/campaignLoop';
import { describeChatError, resolveChat } from '@/lib/tgOutreach/warmup/chatOps';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';
import type { WarmupChat } from '@/lib/tgOutreach/warmup/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Проверить чаты списка: существуют ли, публичные ли, как называются.
 *
 * Проверку делает один аккаунт кампании — резолв не оставляет следа и ничего не
 * меняет ни в чате, ни в аккаунте, поэтому гонять всю партию незачем.
 *
 * Гейт по статусу кампании тот же, что у профиля: пока идёт рассылка или
 * прогрев, аккаунты заняты, и второе подключение через мобильный прокси — лишний
 * повод для сбоя.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.chats.check' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: campaign } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('status')
        .eq('id', id)
        .maybeSingle();
      const status = (campaign as { status?: string } | null)?.status;
      if (status && status !== 'stopped' && status !== 'error') {
        return jsonError(
          `Кампания сейчас в состоянии «${status}». Остановите её, чтобы проверить чаты: во время работы аккаунты заняты.`,
          409,
        );
      }

      const { data: chatRows } = await auth.supabase
        .from('tg_outreach_warmup_chats')
        .select('*')
        .eq('campaign_id', id)
        .neq('status', 'resolved');
      const chats = (chatRows ?? []) as WarmupChat[];
      if (!chats.length) return NextResponse.json({ checked: 0, resolved: 0 });

      const { data: accountRows } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('*')
        .eq('campaign_id', id)
        .eq('is_active', true)
        .limit(1);
      const account = (accountRows ?? [])[0] as OutreachAccount | undefined;
      if (!account) return jsonError('В кампании нет активных аккаунтов', 400);

      const { data: proxyRow } = account.proxy_id
        ? await auth.supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
        : { data: null };

      let client;
      try {
        client = await createGramClient(
          account,
          (proxyRow as OutreachProxy) ?? null,
          // Служебным ключом: бакет с сессиями приватный, пользовательскому
          // клиенту хранилище отвечает «Object not found».
          (storagePath) => downloadSessionToTemp(supabaseAdmin ?? auth.supabase, storagePath),
        );
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeChatError(e)}`, 502);
      }

      let resolved = 0;
      try {
        for (const chat of chats) {
          if (!chat.username) {
            await auth.supabase
              .from('tg_outreach_warmup_chats')
              .update({
                status: 'unresolvable',
                error_reason: 'не удалось разобрать ссылку',
                checked_at: new Date().toISOString(),
              })
              .eq('id', chat.id);
            continue;
          }

          try {
            const info = await resolveChat(client, chat.username);
            await auth.supabase
              .from('tg_outreach_warmup_chats')
              .update({
                status: 'resolved',
                tg_chat_id: info.tgChatId,
                title: info.title,
                participants_count: info.participantsCount,
                error_reason: null,
                checked_at: new Date().toISOString(),
              })
              .eq('id', chat.id);
            resolved++;
          } catch (e) {
            await auth.supabase
              .from('tg_outreach_warmup_chats')
              .update({
                status: 'unresolvable',
                error_reason: describeChatError(e).slice(0, 500),
                checked_at: new Date().toISOString(),
              })
              .eq('id', chat.id);
          }
        }
      } finally {
        try {
          await client.disconnect();
        } catch {
          /* соединение и так рвётся */
        }
      }

      return NextResponse.json({ checked: chats.length, resolved });
    },
  );
}
