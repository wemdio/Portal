import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { listCalls, createCall } from '@/lib/vapi';

export const dynamic = 'force-dynamic';

/** GET — список звонков из Vapi */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const assistantId = searchParams.get('assistantId') ?? undefined;
  const limit = parseInt(searchParams.get('limit') ?? '30', 10);

  try {
    const calls = await listCalls({ assistantId, limit });
    return NextResponse.json({ calls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/** POST — создать (инициировать) звонок */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { assistantId?: string; phoneNumberId?: string; customerNumber?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { assistantId, phoneNumberId, customerNumber } = body;

  if (!assistantId || !phoneNumberId || !customerNumber) {
    return NextResponse.json(
      { error: 'Обязательные поля: assistantId, phoneNumberId, customerNumber' },
      { status: 400 },
    );
  }

  // Normalize phone number
  let normalized = customerNumber.replace(/[\s\-()]/g, '');
  if (normalized.startsWith('8') && normalized.length === 11) {
    normalized = '+7' + normalized.slice(1);
  }
  if (!normalized.startsWith('+')) {
    normalized = '+' + normalized;
  }

  try {
    const call = await createCall({
      assistantId,
      phoneNumberId,
      customer: { number: normalized },
    });
    return NextResponse.json({ call }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
