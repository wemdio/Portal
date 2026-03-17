import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';
import { pendingAuths } from '@/lib/salesCopilot/authStore';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TelegramClient } = require('telegram');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.TG_API_ID ?? '0');
const API_HASH = process.env.TG_API_HASH ?? '';

export const POST = withCopilotAuth(async (req, { supabase, userId }) => {
  const { phone } = (await req.json()) as { phone: string };
  if (!phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 });
  if (!API_ID || !API_HASH) {
    return NextResponse.json({ error: 'TG_API_ID / TG_API_HASH not configured' }, { status: 500 });
  }

  const { count } = await supabase
    .from('sales_copilot_configs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if ((count ?? 0) > 0) {
    const { data: existing } = await supabase
      .from('sales_copilot_configs')
      .select('id, phone')
      .eq('user_id', userId)
      .single();

    if (existing?.phone && existing.phone === phone) {
      return NextResponse.json({ error: 'Этот номер уже подключён' }, { status: 409 });
    }
  }

  let client: InstanceType<typeof TelegramClient> | null = null;
  try {
    client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 3,
    });
    await client.connect();

    const sendResult = await client.sendCode(
      { apiId: API_ID, apiHash: API_HASH },
      phone,
    );

    const sessionString: string = client.session.save() as string;

    pendingAuths.set(phone, {
      phoneCodeHash: sendResult.phoneCodeHash,
      sessionString,
      createdAt: Date.now(),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('PHONE_NUMBER_INVALID')) {
      return NextResponse.json({ error: 'Неверный номер телефона' }, { status: 400 });
    }
    if (msg.includes('PHONE_NUMBER_FLOOD')) {
      return NextResponse.json({ error: 'Слишком много попыток, попробуйте позже' }, { status: 429 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
});
