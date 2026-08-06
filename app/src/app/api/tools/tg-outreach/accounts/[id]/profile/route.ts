import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { validateProfile } from '@/lib/tgOutreach/profile/validateProfile';
import { applyProfile, describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Аватарку крупнее этого Telegram всё равно не примет без пережатия. */
const MAX_AVATAR_BYTES = 1024 * 1024;

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.profile.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const form = await req.formData();
      const profile = {
        first_name: String(form.get('first_name') ?? ''),
        last_name: String(form.get('last_name') ?? ''),
        bio: String(form.get('bio') ?? ''),
      };

      const check = validateProfile(profile);
      if (!check.ok) return jsonError(check.reason, 400);

      const { data: accountRow } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!accountRow) return jsonError('Аккаунт не найден', 404);
      const account = accountRow as OutreachAccount;

      // Гейт по статусу кампании. Работающая кампания уже держит соединение с
      // этим аккаунтом; второе подключение через мобильный прокси — лишний
      // повод для сбоя, а настройка профиля всё равно разовая.
      const { data: campaign } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('status, name')
        .eq('id', account.campaign_id)
        .maybeSingle();
      const status = (campaign as { status?: string } | null)?.status;
      if (status && status !== 'stopped' && status !== 'error') {
        return jsonError(
          `Кампания сейчас в состоянии «${status}». Остановите её, чтобы менять профиль аккаунта: во время работы аккаунт занят.`,
          409,
        );
      }

      const avatarFile = form.get('avatar') as File | null;
      let avatar: { buffer: Buffer; name: string } | undefined;
      if (avatarFile && avatarFile.size > 0) {
        if (avatarFile.size > MAX_AVATAR_BYTES) {
          return jsonError(`Картинка больше 1 МБ (${Math.round(avatarFile.size / 1024)} КБ)`, 400);
        }
        avatar = { buffer: Buffer.from(await avatarFile.arrayBuffer()), name: avatarFile.name || 'avatar.jpg' };
      }

      const { data: proxyRow } = account.proxy_id
        ? await auth.supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
        : { data: null };

      let client;
      try {
        client = await createGramClient(account, (proxyRow as OutreachProxy) ?? null);
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeTelegramError(e)}`, 502);
      }

      try {
        const applied = await applyProfile({ client, profile, avatar });

        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            first_name: applied.first_name,
            last_name: applied.last_name,
            bio: applied.bio,
            tg_username: applied.tg_username,
            ...(applied.tg_user_id != null ? { tg_user_id: applied.tg_user_id } : {}),
            profile_synced_at: new Date().toISOString(),
          })
          .eq('id', id);

        return NextResponse.json(applied);
      } catch (e) {
        return jsonError(describeTelegramError(e), 400);
      } finally {
        try {
          await client.disconnect();
        } catch {
          /* соединение и так рвётся, отдельная ошибка здесь ничего не меняет */
        }
      }
    },
  );
}
