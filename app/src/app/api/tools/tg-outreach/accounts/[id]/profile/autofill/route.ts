import { NextRequest, NextResponse } from 'next/server';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';
import { loadAccountForProfile, connectAccount } from '@/lib/tgOutreach/profile/session';
import {
  buildBio,
  companyFromCampaign,
  isValidUsername,
  normalizeUsername,
  pickIdentity,
  usernameCandidates,
  type Identity,
} from '@/lib/tgOutreach/profile/autofill';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Ник, который Telegram согласен отдать.
 *
 * Проверяем именно у Telegram, а не по своей базе: занятость ника — факт на его
 * стороне, и предложить занятый значит подсунуть оператору кнопку «Сохранить»,
 * которая упадёт. Требование «только свободный» и есть смысл этой ручки.
 *
 * `CHANNELS_TOO_MUCH` и прочие отказы трактуем как «занят»: нам нужен ответ
 * «можно взять», и всё, что им не является, одинаково не подходит.
 */
async function firstFreeUsername(
  client: TelegramClient,
  candidates: string[],
): Promise<{ username: string | null; checked: number }> {
  let checked = 0;
  for (const candidate of candidates) {
    checked += 1;
    try {
      const ok = await client.invoke(new Api.account.CheckUsername({ username: candidate }));
      if (ok === true) return { username: candidate, checked };
    } catch {
      // USERNAME_INVALID / USERNAME_OCCUPIED / флуд — пробуем следующий.
    }
  }
  return { username: null, checked };
}

/**
 * Автозаполнение профиля: имя, фамилия, свободный ник и описание.
 *
 * Ничего не записывает в Telegram — только предлагает. Оператор видит
 * предложение в модалке, при желании правит и сохраняет обычной кнопкой: так
 * автозаполнение нельзя случайно применить к аккаунту, который уже настроен.
 *
 * Тело запроса необязательное:
 *   - `first_name`/`last_name` — оставить имя как есть и подобрать только ник
 *     (кнопка «перегенерировать ник»);
 *   - `username` — проверить конкретный ник, ничего не выдумывая.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.profile.autofill.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      let body: { first_name?: unknown; last_name?: unknown; username?: unknown } = {};
      try {
        body = await req.json();
      } catch {
        // Пустое тело — обычное автозаполнение с нуля.
      }

      const loaded = await loadAccountForProfile(auth.supabase, id);
      if ('error' in loaded) return loaded.error;

      const { data: campaign } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('name, telegram_settings')
        .eq('id', loaded.account.campaign_id)
        .maybeSingle();
      const settings = (campaign as { telegram_settings?: { company_name?: string } } | null)
        ?.telegram_settings;
      const company = companyFromCampaign(
        settings?.company_name,
        (campaign as { name?: string } | null)?.name,
      );

      const wanted = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
      if (wanted && !isValidUsername(wanted)) {
        return jsonError(
          'Ник не подходит по правилам Telegram: 5–32 символа, латиница, цифры и «_», начинается с буквы.',
          400,
        );
      }

      const keepName = typeof body.first_name === 'string' && body.first_name.trim();
      const identity: Identity = keepName
        ? {
            firstName: (body.first_name as string).trim(),
            lastName: typeof body.last_name === 'string' ? body.last_name.trim() : '',
          }
        : pickIdentity();

      /**
       * Кампания работает — предлагаем без похода в Telegram.
       *
       * Подключиться нельзя: сессию держит круг. Проверить занятость ника
       * поэтому не выйдет — но и не нужно: заказ на применение уносит с собой
       * список запасных, и круг сам возьмёт первый свободный. Оператор при этом
       * не ждёт своей очереди, чтобы просто увидеть предложение.
       */
      if (loaded.busy) {
        const candidates = usernameCandidates(identity);
        return NextResponse.json({
          first_name: identity.firstName,
          last_name: identity.lastName,
          username: wanted || candidates[0] || null,
          bio: buildBio(company),
          available: null,
          queued_check: true,
          note:
            'Кампания работает, ник в Telegram сейчас не проверить. Он проверится при применении: '
            + 'если окажется занят, рассылка возьмёт следующий вариант и напишет, какой поставила.',
        });
      }

      let client;
      try {
        client = await connectAccount(auth.supabase, loaded.account);
      } catch (e) {
        return jsonError(`Аккаунт не подключился через свой прокси: ${describeTelegramError(e)}`, 502);
      }

      try {
        if (wanted) {
          const { username } = await firstFreeUsername(client, [wanted]);
          return NextResponse.json({ username: username ?? null, available: Boolean(username) });
        }

        // Двадцать вариантов: у распространённых имён первые обычно заняты, а
        // каждая проверка — отдельный вызов через мобильный прокси, и бесконечно
        // перебирать дороже, чем предложить оператору нажать ещё раз.
        const candidates = [
          ...usernameCandidates(identity),
          ...usernameCandidates(identity),
          ...usernameCandidates(identity),
        ];
        const { username, checked } = await firstFreeUsername(client, candidates);

        return NextResponse.json({
          first_name: identity.firstName,
          last_name: identity.lastName,
          username,
          bio: buildBio(company),
          checked,
          available: Boolean(username),
        });
      } catch (e) {
        return jsonError(`Не удалось подобрать ник: ${describeTelegramError(e)}`, 502);
      } finally {
        try { await client.disconnect(); } catch { /* соединение уже закрыто */ }
      }
    },
  );
}
