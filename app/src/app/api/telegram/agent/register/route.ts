import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { deriveTelegramWebhookSecret } from '@/lib/telegram/webhookSecret';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const botToken = process.env.TG_AGENT_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: 'TG_AGENT_BOT_TOKEN not configured' }, { status: 500 });

  // Prod sets PORTAL_PUBLIC_URL (not NEXT_PUBLIC_SITE_URL) — accept either, same
  // as the client-replies register route. Without this fallback, re-registering
  // the agent webhook 500s on prod (NEXT_PUBLIC_SITE_URL is empty there).
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.PORTAL_PUBLIC_URL;
  if (!siteUrl) return NextResponse.json({ error: 'NEXT_PUBLIC_SITE_URL / PORTAL_PUBLIC_URL not configured' }, { status: 500 });

  const webhookUrl = `${siteUrl.replace(/\/+$/, '')}/api/telegram/agent/webhook`;

  // Install the derived webhook secret automatically — enforced once
  // TELEGRAM_WEBHOOK_SECRET_ENFORCED=1 (see telegram/webhookSecret).
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: deriveTelegramWebhookSecret(botToken) }),
  });

  const data = await res.json();
  return NextResponse.json({ ok: true, webhook_url: webhookUrl, telegram_response: data });
}
