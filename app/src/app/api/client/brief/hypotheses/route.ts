import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { compileBriefText, normalizeBriefFields } from '@/lib/clientBrief';
import type { ClientBriefFields } from '@/lib/clientBrief';
import { generateLeadSourceHypotheses } from '@/lib/projectBriefHypotheses/generateHypotheses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const HYPOTHESES_TIMEOUT_MS = Number(process.env.PROJECT_HYPOTHESES_TIMEOUT_MS ?? '90000');
const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';

interface BriefRow {
  id: string;
  fields: ClientBriefFields;
  lead_source_hypotheses: string | null;
  lead_source_hypotheses_generated_at: string | null;
  lead_source_hypotheses_error: string | null;
  lead_source_hypotheses_stale: boolean;
}

async function loadBrief(userId: string): Promise<BriefRow | null> {
  if (!supabaseInstantly) return null;
  const { data } = await supabaseInstantly
    .from('client_briefs')
    .select('id, fields, lead_source_hypotheses, lead_source_hypotheses_generated_at, lead_source_hypotheses_error, lead_source_hypotheses_stale')
    .eq('client_user_id', userId)
    .maybeSingle();
  return (data as BriefRow | null) ?? null;
}

// GET — отдаёт уже сохранённые гипотезы (не генерирует).
export async function GET(req: NextRequest) {
  const auth = await requireClientAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const brief = await loadBrief(auth.auth.userId);
  return NextResponse.json({
    lead_source_hypotheses: brief?.lead_source_hypotheses ?? null,
    lead_source_hypotheses_generated_at: brief?.lead_source_hypotheses_generated_at ?? null,
    lead_source_hypotheses_error: brief?.lead_source_hypotheses_error ?? null,
    lead_source_hypotheses_stale: brief?.lead_source_hypotheses_stale ?? false,
  });
}

// POST — генерирует гипотезы из сохранённого брифа.
// ?regenerate=1 — перегенерировать, иначе вернёт ранее сохранённое.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientAuth(req);
    if ('error' in auth) return auth.error;
    if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
    if (!OPENROUTER_BRIEF_API_KEY) return jsonError('OPENROUTER_BRIEF_API_KEY не настроен на сервере', 500);

    const { userId } = auth.auth;
    const brief = await loadBrief(userId);
    if (!brief) return jsonError('Сначала заполните бриф', 400);

    const fields = normalizeBriefFields(brief.fields);
    const briefText = compileBriefText(fields).trim();
    if (!briefText) {
      return jsonError('Бриф пуст — нечего скармливать AI. Заполните хотя бы основные поля.', 400);
    }

    const url = new URL(req.url);
    const regenerate = url.searchParams.get('regenerate') === '1';
    if (brief.lead_source_hypotheses && !regenerate) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        lead_source_hypotheses: brief.lead_source_hypotheses,
        lead_source_hypotheses_generated_at: brief.lead_source_hypotheses_generated_at,
        lead_source_hypotheses_error: null,
        lead_source_hypotheses_stale: brief.lead_source_hypotheses_stale,
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HYPOTHESES_TIMEOUT_MS);

    let hypotheses: string | null = null;
    let errorMessage: string | null = null;
    try {
      hypotheses = await generateLeadSourceHypotheses({
        apiKey: OPENROUTER_BRIEF_API_KEY,
        briefText,
        signal: controller.signal,
        audience: 'client',
      });
    } catch (err) {
      errorMessage = err instanceof Error
        ? err.name === 'AbortError'
          ? 'Превышен таймаут генерации гипотез (90с). Попробуйте ещё раз.'
          : err.message
        : 'Не удалось сгенерировать гипотезы';
      await logError('client.brief.hypotheses.failed', err, { userId });
    } finally {
      clearTimeout(timeoutId);
    }

    const generatedAt = hypotheses ? new Date().toISOString() : null;

    const { error: updateError } = await supabaseInstantly
      .from('client_briefs')
      .update({
        lead_source_hypotheses: hypotheses,
        lead_source_hypotheses_generated_at: generatedAt ?? brief.lead_source_hypotheses_generated_at,
        lead_source_hypotheses_error: errorMessage,
        // Just (re)generated against the current brief → no longer stale.
        lead_source_hypotheses_stale: false,
      })
      .eq('client_user_id', userId);

    if (updateError) {
      await logError('client.brief.hypotheses.persist_failed', updateError, { userId });
      return NextResponse.json(
        {
          ok: false,
          error: `Гипотезы сгенерированы, но не сохранены: ${updateError.message}`,
          lead_source_hypotheses: hypotheses,
          lead_source_hypotheses_generated_at: generatedAt,
          lead_source_hypotheses_error: errorMessage,
        },
        { status: 500 },
      );
    }

    if (errorMessage) {
      return NextResponse.json(
        {
          ok: false,
          error: errorMessage,
          lead_source_hypotheses: hypotheses,
          lead_source_hypotheses_generated_at: generatedAt,
          lead_source_hypotheses_error: errorMessage,
        },
        { status: 502 },
      );
    }

    void logAudit('client.brief.hypotheses.success', 'Client lead-source hypotheses generated', { userId, regenerate });

    return NextResponse.json({
      ok: true,
      lead_source_hypotheses: hypotheses,
      lead_source_hypotheses_generated_at: generatedAt,
      lead_source_hypotheses_error: null,
      lead_source_hypotheses_stale: false,
      regenerated: regenerate,
    });
  } catch (err) {
    await logError('client.brief.hypotheses.unexpected', err);
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}
