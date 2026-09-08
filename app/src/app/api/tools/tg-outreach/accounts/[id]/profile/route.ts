import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { validateProfile } from '@/lib/tgOutreach/profile/validateProfile';
import { applyProfile, describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';
import { readProfile } from '@/lib/tgOutreach/profile/readProfile';
import { storeAccountAvatar } from '@/lib/tgOutreach/profile/avatarStorage';
import { loadAccountForProfile, connectAccount } from '@/lib/tgOutreach/profile/session';
import { usernameCandidates } from '@/lib/tgOutreach/profile/autofill';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Аватарку крупнее этого Telegram всё равно не примет без пережатия. */
const MAX_AVATAR_BYTES = 1024 * 1024;

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
      // Чтение остаётся только на свободном аккаунте: заказывать поход в
      // Telegram ради обновления карточки незачем, портал показывает
      // сохранённое.
      if (loaded.busy) {
        return jsonError(
          'Кампания сейчас работает — прочитать профиль из Telegram нельзя: аккаунт занят рассылкой. '
          + 'Карточка показывает сохранённое в портале.',
          409,
        );
      }

      let client;
      try {
        client = await connectAccount(auth.supabase, loaded.account);
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeTelegramError(e)}`, 502);
      }

      try {
        const current = await readProfile(client);
        const stored = current.avatar ? await storeAccountAvatar(id, current.avatar) : null;
        if (stored?.error) {
          // В лог — чтобы причину было видно и без открытого экрана: оператор
          // читает профили пачкой и на каждую строку не смотрит.
          console.error(`[tg-outreach] аватарка аккаунта ${id} не сохранена: ${stored.error}`);
        }

        const patch = {
          first_name: current.first_name,
          last_name: current.last_name,
          bio: current.bio,
          tg_username: current.tg_username,
          ...(current.tg_user_id != null ? { tg_user_id: current.tg_user_id } : {}),
          // Телефона в tdata нет, он приходит только от Telegram. Пустой ответ
          // не повод затирать номер, который портал уже знает.
          ...(current.phone ? { phone: current.phone } : {}),
          // Ссылку трогаем, только когда точно знаем, что показывать: фото нет —
          // чистим (иначе в списке осталась бы картинка от профиля, который в
          // Telegram уже без аватарки), хранилище сбойнуло — оставляем прежнюю,
          // потому что про сам Telegram это ничего не говорит.
          ...(stored?.error ? {} : { avatar_url: stored?.url ?? '' }),
          profile_synced_at: new Date().toISOString(),
        };
        await auth.supabase.from('tg_outreach_accounts').update(patch).eq('id', id);

        // avatar_error — не колонка аккаунта, а объяснение для экрана, поэтому
        // едет отдельно от того, что записали в БД.
        return NextResponse.json(stored?.error ? { ...patch, avatar_error: stored.error } : patch);
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
      // username отсутствует в форме — поле не редактировали, трогать нельзя.
      // Пустая строка, наоборот, значит «снять юзернейм»: разница существенная,
      // поэтому здесь не подставляем '' по умолчанию, как остальным полям.
      const rawUsername = form.get('username');
      const profile = {
        first_name: String(form.get('first_name') ?? ''),
        last_name: String(form.get('last_name') ?? ''),
        bio: String(form.get('bio') ?? ''),
        ...(rawUsername === null ? {} : { username: String(rawUsername) }),
      };

      const check = validateProfile(profile);
      if (!check.ok) return jsonError(check.reason, 400);

      const loaded = await loadAccountForProfile(auth.supabase, id);
      if ('error' in loaded) return loaded.error;
      const account = loaded.account;

      /**
       * Кампания работает — заказ вместо записи.
       *
       * Подключаться нельзя: сессию держит круг. Заказ применит он же, дойдя до
       * аккаунта, и результат вернёт в те же поля карточки.
       *
       * Аватарку в заказ не берём: она весит до мегабайта, а очередь живёт в
       * строке аккаунта. Аватарку по-прежнему меняют на остановленной кампании,
       * и это честно сказано в ответе.
       */
      if (loaded.busy) {
        const candidates = usernameCandidates({
          firstName: profile.first_name,
          lastName: profile.last_name,
        });
        const { error: qErr } = await auth.supabase
          .from('tg_outreach_accounts')
          .update({
            profile_requested_at: new Date().toISOString(),
            profile_payload: { ...profile, username_candidates: candidates },
            profile_status: null,
            profile_detail: null,
          })
          .eq('id', id);
        if (qErr) return jsonError(qErr.message, 500);

        const avatarAsked = (form.get('avatar') as File | null)?.size;
        return NextResponse.json({
          queued: true,
          message:
            'Кампания работает, поэтому профиль встал в очередь — рассылка применит его, когда дойдёт до аккаунта в круге.'
            + (avatarAsked ? ' Аватарка в очередь не идёт: её меняют на остановленной кампании.' : ''),
        });
      }

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
        const applied = await applyProfile({
          client,
          profile,
          avatar,
          currentUsername: account.tg_username ?? '',
        });

        // Ту же картинку кладём в хранилище портала, чтобы список показал новую
        // аватарку сразу — без отдельного похода в Telegram за ней.
        const stored = avatar ? await storeAccountAvatar(id, avatar.buffer) : null;
        if (stored?.error) {
          console.error(`[tg-outreach] аватарка аккаунта ${id} не сохранена: ${stored.error}`);
        }
        const avatarUrl = stored?.url ?? null;

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

        // Аватарка в Telegram уже уехала: если её не принял портал, это касается
        // только картинки в списке — так и говорим, а не молчим.
        return NextResponse.json({
          ...applied,
          avatar_url: avatarUrl ?? undefined,
          ...(stored?.error ? { avatar_error: stored.error } : {}),
        });
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
