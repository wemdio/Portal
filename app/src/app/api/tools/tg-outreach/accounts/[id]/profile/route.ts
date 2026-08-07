import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { downloadSessionToTemp } from '@/lib/tgOutreach/campaignLoop';
import { validateProfile } from '@/lib/tgOutreach/profile/validateProfile';
import { applyProfile, describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';
import { readProfile } from '@/lib/tgOutreach/profile/readProfile';
import { storeAccountAvatar } from '@/lib/tgOutreach/profile/avatarStorage';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Аватарку крупнее этого Telegram всё равно не примет без пережатия. */
const MAX_AVATAR_BYTES = 1024 * 1024;

/**
 * Аккаунт + гейт по статусу кампании.
 *
 * Работающая кампания уже держит соединение с этим аккаунтом; второе
 * подключение через мобильный прокси — лишний повод для сбоя. Правило одно и
 * для записи профиля, и для чтения: пока идёт рассылка или прогрев, в Telegram
 * не ходим, карточка показывает сохранённое в портале.
 */
async function loadAccountForProfile(
  supabase: SupabaseClient,
  id: string,
): Promise<{ account: OutreachAccount } | { error: NextResponse }> {
  const { data: accountRow } = await supabase
    .from('tg_outreach_accounts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!accountRow) return { error: jsonError('Аккаунт не найден', 404) };
  const account = accountRow as OutreachAccount;

  const { data: campaign } = await supabase
    .from('tg_outreach_campaigns')
    .select('status')
    .eq('id', account.campaign_id)
    .maybeSingle();
  const status = (campaign as { status?: string } | null)?.status;
  if (status && status !== 'stopped' && status !== 'error') {
    return {
      error: jsonError(
        `Кампания сейчас в состоянии «${status}». Остановите её, чтобы работать с профилем аккаунта: во время работы аккаунт занят.`,
        409,
      ),
    };
  }
  return { account };
}

/**
 * Подключиться аккаунтом через его прокси.
 *
 * downloadSessionFile обязателен: у аккаунтов, залитых парами `.json`+`.session`
 * без успешной конверсии SQLite в StringSession, `session_data` пустой, а
 * `session_file_path` заполнен. Без функции скачивания createGramClient падает
 * ещё до подключения — «Нет session_data или session_file_path».
 */
async function connectAccount(supabase: SupabaseClient, account: OutreachAccount) {
  const { data: proxyRow } = account.proxy_id
    ? await supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
    : { data: null };
  return createGramClient(
    account,
    (proxyRow as OutreachProxy) ?? null,
    (storagePath) => downloadSessionToTemp(supabase, storagePath),
  );
}

/**
 * Прочитать профиль из Telegram и сохранить в портал.
 *
 * Отдельная ручка, а не часть списка аккаунтов: список читается на каждом
 * открытии вкладки, а поход в Telegram — дорогая операция через мобильный
 * прокси, её оператор запускает осознанно.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.profile.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const loaded = await loadAccountForProfile(auth.supabase, id);
      if ('error' in loaded) return loaded.error;

      let client;
      try {
        client = await connectAccount(auth.supabase, loaded.account);
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeTelegramError(e)}`, 502);
      }

      try {
        const current = await readProfile(client);
        const avatarUrl = current.avatar
          ? await storeAccountAvatar(id, current.avatar)
          : null;

        const patch = {
          first_name: current.first_name,
          last_name: current.last_name,
          bio: current.bio,
          tg_username: current.tg_username,
          ...(current.tg_user_id != null ? { tg_user_id: current.tg_user_id } : {}),
          // Фото нет — чистим ссылку: иначе в списке осталась бы картинка от
          // профиля, который в Telegram уже без аватарки.
          avatar_url: avatarUrl ?? '',
          profile_synced_at: new Date().toISOString(),
        };
        await auth.supabase.from('tg_outreach_accounts').update(patch).eq('id', id);

        return NextResponse.json(patch);
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

      const loaded = await loadAccountForProfile(auth.supabase, id);
      if ('error' in loaded) return loaded.error;
      const account = loaded.account;

      const avatarFile = form.get('avatar') as File | null;
      let avatar: { buffer: Buffer; name: string } | undefined;
      if (avatarFile && avatarFile.size > 0) {
        if (avatarFile.size > MAX_AVATAR_BYTES) {
          return jsonError(`Картинка больше 1 МБ (${Math.round(avatarFile.size / 1024)} КБ)`, 400);
        }
        avatar = { buffer: Buffer.from(await avatarFile.arrayBuffer()), name: avatarFile.name || 'avatar.jpg' };
      }

      let client;
      try {
        client = await connectAccount(auth.supabase, account);
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeTelegramError(e)}`, 502);
      }

      try {
        const applied = await applyProfile({ client, profile, avatar });

        // Ту же картинку кладём в хранилище портала, чтобы список показал новую
        // аватарку сразу — без отдельного похода в Telegram за ней.
        const avatarUrl = avatar ? await storeAccountAvatar(id, avatar.buffer) : null;

        await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            first_name: applied.first_name,
            last_name: applied.last_name,
            bio: applied.bio,
            tg_username: applied.tg_username,
            ...(applied.tg_user_id != null ? { tg_user_id: applied.tg_user_id } : {}),
            ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
            profile_synced_at: new Date().toISOString(),
          })
          .eq('id', id);

        return NextResponse.json({ ...applied, avatar_url: avatarUrl ?? undefined });
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
