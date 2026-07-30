import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** A/B-вариант письма по контракту данных (генерацию делает отдельная стадия). */
interface LetterVariant {
  subject: string | null;
  body: string;
}

/** Форма jsonb-письма he_chains.letters: основной вариант = «A», рядом variants. */
interface ChainLetterRow {
  subject: string | null;
  body: string;
  wait_days?: number;
  variants?: LetterVariant[];
  segment_variants?: unknown[];
}

function isVariant(v: unknown): v is LetterVariant {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as LetterVariant).body === 'string' &&
    ((v as LetterVariant).subject === null || typeof (v as LetterVariant).subject === 'string')
  );
}

// PATCH — сделать A/B-вариант письма основным: меняет местами subject/body
// письма letters[letter_index] с letters[letter_index].variants[variant_index]
// (прежний основной уходит в variants на место выбранного). Остальные письма
// и поля (wait_days, segment_variants) не трогаем.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.chains.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { letter_index?: unknown; variant_index?: unknown };
      try {
        body = (await req.json()) as { letter_index?: unknown; variant_index?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

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
        .from('he_chains')
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
        ? (chain.letters as ChainLetterRow[])
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
      if (!isVariant(variant)) {
        return jsonError('Вариант письма имеет неверный формат', 400);
      }

      const nextVariants = variants.slice();
      nextVariants[variantIndex] = { subject: letter.subject ?? null, body: letter.body };
      const nextLetters = letters.slice();
      nextLetters[letterIndex] = {
        ...letter,
        subject: variant.subject,
        body: variant.body,
        variants: nextVariants,
      };

      const { error: updateError } = await supabaseAdmin
        .from('he_chains')
        .update({ letters: nextLetters })
        .eq('id', id);
      if (updateError) {
        await logError('tools.hypothesis-engine.chains.variant_swap_failed', updateError, {
          chainId: id,
        });
        return jsonError(updateError.message, 500);
      }

      return NextResponse.json({ letters: nextLetters });
    },
  );
}
