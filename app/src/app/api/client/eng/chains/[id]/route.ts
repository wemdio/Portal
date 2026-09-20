import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeChain, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { normalizeHeChainLetters } from '@/lib/hypothesisEngine/chainLetters';
import { engServerError } from '../../_shared';

export const dynamic = 'force-dynamic';

const LETTERS_SAVE_FAILED = 'Failed to save the letters';

// PATCH — полная замена писем цепочки { letters: [...] } из инлайн-редактора
// шага Letters кабинета. Валидация/нормализация — общая со staff
// (normalizeHeChainLetters); A/B-swap-контракт staff-роута кабинету не нужен.
// Скоуп: цепочка → вертикаль → проект-владелец, чужая — 404.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.chain.letters.patch' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

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
      return engServerError('client.eng.chains.letters_replace_failed', updateError, LETTERS_SAVE_FAILED, {
        userId: result.auth.userId,
        chainId: id,
      });
    }

    return NextResponse.json({ letters: nextLetters });
  });
}
