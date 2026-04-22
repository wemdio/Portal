import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { canEditProjects } from '@/lib/roles';
import type { UserRole } from '@/types';
import { generateLeadSourceHypotheses } from '@/lib/projectBriefHypotheses/generateHypotheses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Гипотезы — отдельный шаг после загрузки PDF. Может занимать до 60s,
// но не блокирует upload и не упирается в общий таймаут одного запроса.
export const maxDuration = 120;

const HYPOTHESES_TIMEOUT_MS = Number(process.env.PROJECT_HYPOTHESES_TIMEOUT_MS ?? '90000');

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface AuthContext {
  userId: string;
  role: UserRole | null;
}

async function authenticate(req: NextRequest): Promise<AuthContext | NextResponse> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single<{ role: UserRole | null }>();

  return { userId: user.id, role: profile?.role ?? null };
}

interface ProjectRow {
  id: string;
  brief_text: string | null;
  brief_file_path: string | null;
  lead_source_hypotheses: string | null;
  lead_source_hypotheses_generated_at: string | null;
  lead_source_hypotheses_error: string | null;
}

async function fetchProjectRow(projectId: string): Promise<ProjectRow | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('projects')
    .select(
      'id, brief_text, brief_file_path, lead_source_hypotheses, lead_source_hypotheses_generated_at, lead_source_hypotheses_error',
    )
    .eq('id', projectId)
    .single<ProjectRow>();
  return data ?? null;
}

// POST /api/projects/[id]/brief/hypotheses?regenerate=1
// Генерирует / пересоздаёт гипотезы по уже загруженному brief_text.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    if (!canEditProjects(auth.role)) return jsonError('Forbidden', 403);

    const { id: projectId } = await ctx.params;
    if (!projectId) return jsonError('Missing project id', 400);

    if (!OPENROUTER_BRIEF_API_KEY) {
      return jsonError('OPENROUTER_BRIEF_API_KEY не настроен на сервере', 500);
    }

    const project = await fetchProjectRow(projectId);
    if (!project) return jsonError('Project not found', 404);
    if (!project.brief_text || !project.brief_file_path) {
      return jsonError('Сначала загрузите бриф (PDF)', 400);
    }

    const url = new URL(req.url);
    const regenerate = url.searchParams.get('regenerate') === '1';
    if (project.lead_source_hypotheses && !regenerate) {
      // Уже есть результат — клиенту явно нужно ?regenerate=1
      return NextResponse.json({
        ok: true,
        lead_source_hypotheses: project.lead_source_hypotheses,
        lead_source_hypotheses_generated_at: project.lead_source_hypotheses_generated_at,
        lead_source_hypotheses_error: null,
        skipped: true,
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HYPOTHESES_TIMEOUT_MS);

    let hypotheses: string | null = null;
    let errorMessage: string | null = null;

    try {
      hypotheses = await generateLeadSourceHypotheses({
        apiKey: OPENROUTER_BRIEF_API_KEY,
        briefText: project.brief_text,
        signal: controller.signal,
      });
    } catch (err) {
      errorMessage =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Превышен таймаут генерации гипотез (90с). Попробуйте ещё раз.'
            : err.message
          : 'Не удалось сгенерировать гипотезы';
      await logError('projects.brief.hypotheses.failed', err, { projectId });
    } finally {
      clearTimeout(timeoutId);
    }

    const generatedAt = hypotheses ? new Date().toISOString() : null;

    const { error: updateError } = await supabaseAdmin
      .from('projects')
      .update({
        lead_source_hypotheses: hypotheses,
        lead_source_hypotheses_generated_at: generatedAt ?? project.lead_source_hypotheses_generated_at,
        lead_source_hypotheses_error: errorMessage,
      })
      .eq('id', projectId);

    if (updateError) {
      await logError('projects.brief.hypotheses.persist_failed', updateError, { projectId });
      // Если упало именно сохранение — отдадим клиенту сгенерированный текст,
      // чтобы он мог хотя бы увидеть результат.
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

    void logAudit('projects.brief.hypotheses.success', 'Lead-source hypotheses generated', {
      projectId,
      regenerate,
    });

    return NextResponse.json({
      ok: true,
      lead_source_hypotheses: hypotheses,
      lead_source_hypotheses_generated_at: generatedAt,
      lead_source_hypotheses_error: null,
      regenerated: regenerate,
    });
  } catch (err) {
    await logError('projects.brief.hypotheses.unexpected', err);
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}
