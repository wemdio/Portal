import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import { ACCOUNT_PUBLIC_COLUMNS } from '../route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const update: Record<string, unknown> = {};
  if ('label' in body && (typeof body.label === 'string' || body.label === null)) {
    update.label = body.label;
  }
  if ('status' in body) {
    // Через API можно только включить/выключить захват. auth_error ставит воркер.
    if (body.status === 'active' || body.status === 'disabled') {
      update.status = body.status;
    } else {
      return jsonError('status может быть только active или disabled', 400);
    }
  }
  if (Object.keys(update).length === 0) return jsonError('Нет полей для обновления', 400);

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_accounts')
    .update(update)
    .eq('id', id)
    .select(ACCOUNT_PUBLIC_COLUMNS)
    .single();

  if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);
  return NextResponse.json({ account: data });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const { error } = await supabaseAdmin!.from('sales_chat_accounts').delete().eq('id', id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
