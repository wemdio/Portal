import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadHeProjectDetail } from '@/lib/hypothesisEngine/projectDetail';
import {
  toClientEngProjectDetail,
  toClientEngProjectRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  patchHeProjectBrief,
  type HeBriefPatchBody,
} from '@/lib/hypothesisEngine/projectBriefPatch';
import { engServerError } from '../../_shared';

export const dynamic = 'force-dynamic';

const PROJECT_LOAD_FAILED = 'Failed to load the project';
const BRIEF_SAVE_FAILED = 'Failed to save the brief';

// GET — деталка СВОЕГО проекта (та же сборка, что у staff-роута, но со скоупом
// владельца: чужой проект отвечает 404, существование не раскрываем) —
// суженная клиентской проекцией. Поллится каждые 4 секунды из мастера, поэтому
// withToolTrace здесь НЕТ: два лишних запроса к trace_spans на каждый полл.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  // Проверка формата ДО обращения к БД: иначе Postgres отвечает 22P02
  // «invalid input syntax for type uuid: …» и этот текст уезжал клиенту 500-й.
  if (!isValidUuid(id)) return jsonError('Invalid id', 400);

  const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  const detail = await loadHeProjectDetail(supabaseAdmin, id, { scopeCreatedBy: result.auth.userId });
  if (!detail.ok) {
    if (detail.reason === 'not_found') return jsonError('Project not found', 404);
    return engServerError('client.eng.projects.detail_failed', new Error(detail.message ?? 'db error'), PROJECT_LOAD_FAILED, {
      userId: result.auth.userId,
      projectId: id,
    });
  }

  // Белый список полей: себестоимость, модели, план сорсинга и id внутренних
  // джоб в кабинет не едут (lib/hypothesisEngine/clientEngProjection).
  return NextResponse.json(toClientEngProjectDetail(detail.detail));
}

// PATCH — offer_override / style_override / signature_override / business_override мержатся в
// he_projects.brief (та же логика, что у staff, со скоупом владельца до записи).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.project.patch' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    let body: HeBriefPatchBody;
    try {
      body = (await req.json()) as HeBriefPatchBody;
    } catch {
      return jsonError('Invalid body', 400);
    }

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const patch = await patchHeProjectBrief(supabaseAdmin, id, body);
    if (!patch.ok) {
      const err = patch.error;
      switch (err.code) {
        case 'no_fields':
          return jsonError('Provide offer_override, style_override, signature_override or business_override', 400);
        case 'bad_type':
          return jsonError(`${err.field} must be a string`, 400);
        case 'too_long':
          return jsonError(`${err.field}: maximum ${err.max} characters`, 413);
        case 'not_found':
          return jsonError('Project not found', 404);
        default:
          return engServerError('client.eng.projects.brief_patch_failed', new Error(err.message), BRIEF_SAVE_FAILED, {
            userId: result.auth.userId,
            projectId: id,
          });
      }
    }

    // patchHeProjectBrief отдаёт строку из .select() целиком — проецируем, как
    // и деталку: cost_usd/tokens_used/llm_model кабинету не нужны.
    return NextResponse.json({ project: toClientEngProjectRow(patch.project) });
  });
}
