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

/* ── Полная замена letters (инлайн-редактор шага 3) ── */

const MAX_LETTERS = 6;
const MAX_BODY_LEN = 50_000;
const MAX_SUBJECT_LEN = 500;
const MAX_WAIT_DAYS = 90;

interface SegmentVariantRow {
  when: string;
  text: string;
}

/** wait_days: приводим к целому и клампим в 0..90; нечисловое → 0. */
function clampWaitDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_WAIT_DAYS, Math.max(0, Math.trunc(n)));
}

/** subject: null или строка ≤500 символов. */
function normalizeSubject(value: unknown): { ok: boolean; subject: string | null } {
  if (value === null || value === undefined) return { ok: true, subject: null };
  if (typeof value !== 'string' || value.length > MAX_SUBJECT_LEN) {
    return { ok: false, subject: null };
  }
  return { ok: true, subject: value };
}

/** body: непустая строка ≤50000 символов. */
function isValidBody(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_BODY_LEN;
}

function normalizeVariant(v: unknown): LetterVariant | null {
  if (typeof v !== 'object' || v === null) return null;
  const { subject, body } = v as { subject?: unknown; body?: unknown };
  if (!isValidBody(body)) return null;
  const s = normalizeSubject(subject);
  if (!s.ok) return null;
  return { subject: s.subject, body };
}

function normalizeSegmentVariant(v: unknown): SegmentVariantRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const { when, text } = v as { when?: unknown; text?: unknown };
  if (typeof when !== 'string' || when.trim() === '' || typeof text !== 'string') return null;
  return { when, text };
}

/**
 * Валидация + нормализация полной замены letters: 1..6 писем, у первого
 * wait_days всегда 0. Неизвестные поля письма ОТБРАСЫВАЕМ (не отклоняем),
 * невалидные значения — 400 по всему запросу.
 */
function normalizeLetters(input: unknown[]): { letters?: ChainLetterRow[]; error?: string } {
  if (input.length < 1 || input.length > MAX_LETTERS) {
    return { error: `Писем в цепочке должно быть от 1 до ${MAX_LETTERS}` };
  }
  const out: ChainLetterRow[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (typeof raw !== 'object' || raw === null) {
      return { error: `Письмо ${i + 1} имеет неверный формат` };
    }
    const { subject, body, wait_days, variants, segment_variants } = raw as Record<
      string,
      unknown
    >;
    if (!isValidBody(body)) {
      return { error: `Тело письма ${i + 1} пустое или длиннее ${MAX_BODY_LEN} символов` };
    }
    const s = normalizeSubject(subject);
    if (!s.ok) {
      return {
        error: `Тема письма ${i + 1} должна быть строкой до ${MAX_SUBJECT_LEN} символов или null`,
      };
    }
    const letter: ChainLetterRow = {
      subject: s.subject,
      body,
      wait_days: i === 0 ? 0 : clampWaitDays(wait_days),
    };
    if (variants !== undefined) {
      if (!Array.isArray(variants)) {
        return { error: `variants письма ${i + 1} должен быть массивом` };
      }
      const norm: LetterVariant[] = [];
      for (const v of variants) {
        const nv = normalizeVariant(v);
        if (!nv) return { error: `A/B-вариант письма ${i + 1} имеет неверный формат` };
        norm.push(nv);
      }
      letter.variants = norm;
    }
    if (segment_variants !== undefined) {
      if (!Array.isArray(segment_variants)) {
        return { error: `segment_variants письма ${i + 1} должен быть массивом` };
      }
      const norm: SegmentVariantRow[] = [];
      for (const v of segment_variants) {
        const nv = normalizeSegmentVariant(v);
        if (!nv) return { error: `Сегментный вариант письма ${i + 1} имеет неверный формат` };
        norm.push(nv);
      }
      letter.segment_variants = norm;
    }
    out.push(letter);
  }
  return { letters: out };
}

// PATCH — два контракта:
// 1) { letters: [...] } — полная замена массива писем цепочки (инлайн-редактор
//    шага 3): валидация + нормализация через normalizeLetters, ответ { letters }.
// 2) { letter_index, variant_index } — сделать A/B-вариант письма основным:
//    меняет местами subject/body письма letters[letter_index] с
//    letters[letter_index].variants[variant_index] (прежний основной уходит в
//    variants на место выбранного). Остальные письма и поля (wait_days,
//    segment_variants) не трогаем.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.chains.patch' },
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
        const { letters: nextLetters, error: normError } = normalizeLetters(body.letters);
        if (!nextLetters) return jsonError(normError ?? 'Неверный формат писем', 400);

        const { error: fetchError } = await supabaseAdmin
          .from('he_chains')
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
          .from('he_chains')
          .update({ letters: nextLetters })
          .eq('id', id);
        if (updateError) {
          await logError('tools.hypothesis-engine.chains.letters_replace_failed', updateError, {
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
