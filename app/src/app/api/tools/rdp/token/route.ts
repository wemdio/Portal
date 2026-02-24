import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';

const admin = supabaseAdmin!;

const RDP_WS_SECRET = process.env.RDP_WS_SECRET ?? '';

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

function encryptToken(connectionParams: Record<string, unknown>, secret: string): string {
  // guacamole-lite's Crypt.decrypt() decodes the IV via .toString('ascii'), which strips the
  // high bit of bytes > 127. Using only 7-bit bytes makes the round-trip lossless.
  const iv = Buffer.from(crypto.randomBytes(16).map((b: number) => b & 0x7F));
  // guacamole-lite passes crypt.key directly to createDecipheriv, so the key must be 32 bytes.
  // RDP_WS_SECRET is a base64-encoded 32-byte value; decode it to get the raw key.
  const key = Buffer.from(secret, 'base64');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(connectionParams), 'utf8', 'binary');
  encrypted += cipher.final('binary');
  return JSON.stringify({
    iv: iv.toString('base64'),
    value: Buffer.from(encrypted, 'binary').toString('base64'),
  });
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!RDP_WS_SECRET) {
    return NextResponse.json({ error: 'RDP not configured' }, { status: 503 });
  }

  const { data: session } = await admin
    .from('rdp_sessions')
    .select('id')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (!session) {
    return NextResponse.json(
      { error: 'Сначала начните сессию' },
      { status: 403 },
    );
  }

  const connectionParams = {
    connection: {
      type: 'rdp',
    },
  };

  const token = encryptToken(connectionParams, RDP_WS_SECRET);

  return NextResponse.json({ token: btoa(token) });
}
