import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import {
  isVeLetterVariant,
  normalizeVeChainLetters,
  type VeChainLetterRow,
  type VeLetterVariantRow,
} from '@/lib/verticalEngineV2/chainLetters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// Валидация/нормализация писем — в lib/verticalEngineV2/chainLetters.ts
// (ею же пользуется клиентский ENG-контур).

// PATCH — два контракта:
// 1) { letters: [...] } — полная замена массива писем цепочки (инлайн-редактор
//    шага 3): валидация + нормализация через normalizeVeChainLetters, ответ { letters }.
// 2) { letter_index, variant_index } — сделать A/B-вариант письма основным:
//    меняет местами subject/body письма letters[letter_index] с
//    letters[letter_index].variants[variant_index] (прежний основной уходит в
//    variants на место выбранного). Остальные письма и поля (wait_days,
//    segment_variants) не трогаем.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.chains.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { letter_index?: unknown; variant_index?: unknown; letters?: unknown };
      try {
        body = (await req.json()) as {
          letter_index?: unknown;
          variant_index?: unknown;
          letters?: unknown;
        };
      } catch {
        return jsonError('Invalid body', 400);
      }

      // Контракт 1: полная замена массива писем.
      if (Array.isArray(body?.letters)) {
        const { letters: nextLetters, error: normError } = normalizeVeChainLetters(body.letters);
        if (!nextLetters) return jsonError(normError ?? 'Неверный формат писем', 400);

        const { error: fetchError } = await supabaseAdmin
          .from('ve_chains')
          .select('id')
          .eq('id', id)
          .single();
        if (fetchError) {
          return jsonError(
            fetchError.code === 'PGRST116' ? 'Цепочка не найдена' : fetchError.message,
            fetchError.code === 'PGRST116' ? 404 : 500,
          );
        }

        const { error: updateError } = await supabaseAdmin
          .from('ve_chains')
          .update({ letters: nextLetters })
          .eq('id', id);
        if (updateError) {
          await logError('tools.vertical-engine-v2.chains.letters_replace_failed', updateError, {
            chainId: id,
          });
          return jsonError(updateError.message, 500);
        }

        return NextResponse.json({ letters: nextLetters });
      }

      // Контракт 2: swap A/B-варианта.
      const letterIndex = body?.letter_index;
      const variantIndex = body?.variant_index;
      if (
        typeof letterIndex !== 'number' ||
        !Number.isInteger(letterIndex) ||
        letterIndex < 0 ||
        typeof variantIndex !== 'number' ||
        !Number.isInteger(variantIndex) ||
        variantIndex < 0
      ) {
        return jsonError('letter_index и variant_index должны быть неотрицательными целыми', 400);
      }

      const { data: chain, error } = await supabaseAdmin
        .from('ve_chains')
        .select('id, letters')
        .eq('id', id)
        .single();
      if (error) {
        return jsonError(
          error.code === 'PGRST116' ? 'Цепочка не найдена' : error.message,
          error.code === 'PGRST116' ? 404 : 500,
        );
      }

      const letters = Array.isArray(chain.letters)
        ? (chain.letters as VeChainLetterRow[])
        : [];
      const letter = letters[letterIndex];
      if (!letter || typeof letter !== 'object') {
        return jsonError('letter_index вне диапазона писем цепочки', 400);
      }
      const variants = Array.isArray(letter.variants) ? letter.variants : [];
      const variant = variants[variantIndex];
      if (!variant) {
        return jsonError('variant_index вне диапазона вариантов письма', 400);
      }
      if (!isVeLetterVariant(variant)) {
        return jsonError('Вариант письма имеет неверный формат', 400);
      }

      const nextVariants: VeLetterVariantRow[] = variants.slice();
      nextVariants[variantIndex] = { subject: letter.subject ?? null, body: letter.body };
      const nextLetters = letters.slice();
      nextLetters[letterIndex] = {
        ...letter,
        subject: variant.subject,
        body: variant.body,
        variants: nextVariants,
      };

      const { error: updateError } = await supabaseAdmin
        .from('ve_chains')
        .update({ letters: nextLetters })
        .eq('id', id);
      if (updateError) {
        await logError('tools.vertical-engine-v2.chains.variant_swap_failed', updateError, {
          chainId: id,
        });
        return jsonError(updateError.message, 500);
      }

      return NextResponse.json({ letters: nextLetters });
    },
  );
}
