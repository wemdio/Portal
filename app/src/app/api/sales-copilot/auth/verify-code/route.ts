import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';
import { pendingAuths } from '@/lib/salesCopilot/authStore';
import {
  DEFAULT_REACTIVE_PROMPT,
  DEFAULT_PROACTIVE_PROMPT,
} from '@/lib/salesCopilot/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TelegramClient } = require('telegram');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.TG_API_ID ?? '0');
const API_HASH = process.env.TG_API_HASH ?? '';

export const POST = withCopilotAuth(async (req, { supabase, userId }) => {
  const { phone, code, password } = (await req.json()) as {
    phone: string;
    code: string;
    password?: string;
  };

  if (!phone || !code) {
    return NextResponse.json({ error: 'phone and code are required' }, { status: 400 });
  }

  const pending = pendingAuths.get(phone);
  if (!pending) {
    return NextResponse.json(
      { error: 'Сессия авторизации истекла. Запросите код повторно.' },
      { status: 410 },
    );
  }

  let client: InstanceType<typeof TelegramClient> | null = null;
  try {
    client = new TelegramClient(
      new StringSession(pending.sessionString),
      API_ID,
      API_HASH,
      { connectionRetries: 3 },
    );
    await client.connect();

    try {
      await client.invoke(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        new (require('telegram/tl').Api.auth.SignIn)({
          phoneNumber: phone,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (signInErr: unknown) {
      const errMsg = signInErr instanceof Error ? signInErr.message : String(signInErr);

      if (errMsg.includes('SESSION_PASSWORD_NEEDED')) {
        if (!password) {
          return NextResponse.json(
            { error: '2FA_REQUIRED', needs_password: true },
            { status: 400 },
          );
        }
        await client.signIn({
          phoneNumber: phone,
          phoneCode: code,
          phoneCodeHash: pending.phoneCodeHash,
          password: async () => password,
        });
      } else if (errMsg.includes('PHONE_CODE_INVALID')) {
        return NextResponse.json({ error: 'Неверный код' }, { status: 400 });
      } else if (errMsg.includes('PHONE_CODE_EXPIRED')) {
        pendingAuths.delete(phone);
        return NextResponse.json({ error: 'Код истёк. Запросите новый.' }, { status: 410 });
      } else {
        throw signInErr;
      }
    }

    const me = await client.getMe();
    const sessionString: string = client.session.save() as string;
    const tgFirstName: string = me?.firstName ?? '';
    const tgUsername: string = me?.username ?? '';

    pendingAuths.delete(phone);

    const { data: existingConfig } = await supabase
      .from('sales_copilot_configs')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (existingConfig) {
      const { error: updateErr } = await supabase
        .from('sales_copilot_configs')
        .update({
          session_data: { session_string: sessionString },
          phone,
          tg_first_name: tgFirstName,
          tg_username: tgUsername,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingConfig.id);

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        config_id: existingConfig.id,
        tg_first_name: tgFirstName,
        tg_username: tgUsername,
      });
    }

    const { data: newConfig, error: insertErr } = await supabase
      .from('sales_copilot_configs')
      .insert({
        user_id: userId,
        session_data: { session_string: sessionString },
        phone,
        tg_first_name: tgFirstName,
        tg_username: tgUsername,
        reactive_system_prompt: DEFAULT_REACTIVE_PROMPT,
        proactive_system_prompt: DEFAULT_PROACTIVE_PROMPT,
      })
      .select('id')
      .single();

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      config_id: newConfig.id,
      tg_first_name: tgFirstName,
      tg_username: tgUsername,
    }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
});
