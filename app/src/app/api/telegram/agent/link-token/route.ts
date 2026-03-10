import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { createLinkToken } from '@/lib/telegramAgent/linkToken';

export const dynamic = 'force-dynamic';

const BOT_USERNAME = 'Polza_portal_bot';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const botToken = process.env.TG_AGENT_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: 'Bot not configured' }, { status: 500 });

  const linkToken = createLinkToken(user.id, botToken);
  const deeplink = `https://t.me/${BOT_USERNAME}?start=lnk${linkToken}`;

  return NextResponse.json({ deeplink, expires_in: 600 });
}
