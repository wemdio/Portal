import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { loadClientHeChain } from '@/lib/hypothesisEngine/apiGuards';
import { normalizeHeChainLetters } from '@/lib/hypothesisEngine/chainLetters';

export const dynamic = 'force-dynamic';

// PATCH — полная замена писем цепочки { letters: [...] } из инлайн-редактора
// шага Letters кабинета. Валидация/нормализация — общая со staff
// (normalizeHeChainLetters); A/B-swap-контракт staff-роута кабинету не нужен.
// Скоуп: цепочка → вертикаль → проект-владелец, чужая — 404.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  let body: { letters?: unknown };
  try {
    body = (await req.json()) as { letters?: unknown };
  } catch {
    return jsonError('Invalid body', 400);
  }

  if (!Array.isArray(body?.letters)) {
    return jsonError('letters must be an array', 400);
  }
  const { letters: nextLetters, error: normError } = normalizeHeChainLetters(body.letters);
  if (!nextLetters) {
    // Детальная RU-формулировка валидатора остаётся серверной, клиенту —
    // обобщённая EN-ошибка (UI кабинета английский).
    void normError;
    return jsonError('Invalid letters payload — check letter subjects and bodies', 400);
  }

  const owned = await loadClientHeChain(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const { error: updateError } = await supabaseAdmin
    .from('he_chains')
    .update({ letters: nextLetters })
    .eq('id', id);
  if (updateError) {
    await logError('client.eng.chains.letters_replace_failed', updateError, { chainId: id });
    return jsonError(updateError.message, 500);
  }

  return NextResponse.json({ letters: nextLetters });
}
