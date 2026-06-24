import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { listCalls, createCall } from '@/lib/ai-caller-provider';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';
import { normalizeRuPhoneNumber } from '@/lib/phone-normalization';
import { blockNonInternal } from '@/lib/ai-caller/requireInternal';

export const dynamic = 'force-dynamic';

/** GET — список звонков из Vapi */
export async function GET(req: NextRequest) {
  const blocked = await blockNonInternal(req);
  if (blocked) return blocked;

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const assistantId = searchParams.get('assistantId') ?? undefined;
  const limit = parseInt(searchParams.get('limit') ?? '30', 10);
  const provider = resolveAiCallerProvider(req);

  try {
    const calls = await listCalls({ assistantId, limit }, provider);
    return NextResponse.json({ calls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/** POST — создать (инициировать) звонок */
export async function POST(req: NextRequest) {
  const blocked = await blockNonInternal(req);
  if (blocked) return blocked;

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
  const provider = resolveAiCallerProvider(req);

  if (!assistantId || !phoneNumberId || !customerNumber) {
    return NextResponse.json(
      { error: 'Обязательные поля: assistantId, phoneNumberId, customerNumber' },
      { status: 400 },
    );
  }

  const normalized = normalizeRuPhoneNumber(customerNumber);
  if (!normalized) {
    return NextResponse.json(
      { error: 'Некорректный номер. Используйте формат +7XXXXXXXXXX.' },
      { status: 400 },
    );
  }

  try {
    const call = await createCall({
      assistantId,
      phoneNumberId,
      customer: { number: normalized },
    }, provider);
    return NextResponse.json({ call }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
