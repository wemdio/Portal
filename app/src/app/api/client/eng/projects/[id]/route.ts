import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadHeProjectDetail } from '@/lib/hypothesisEngine/projectDetail';
import { loadClientHeProject } from '@/lib/hypothesisEngine/apiGuards';
import {
  patchHeProjectBrief,
  type HeBriefPatchBody,
} from '@/lib/hypothesisEngine/projectBriefPatch';

export const dynamic = 'force-dynamic';

// GET — полная деталка СВОЕГО проекта (та же сборка, что у staff-роута,
// но со скоупом владельца: чужой проект отвечает 404, существование не раскрываем).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const detail = await loadHeProjectDetail(supabaseAdmin, id, { scopeCreatedBy: result.auth.userId });
  if (!detail.ok) {
    return jsonError(
      detail.reason === 'not_found' ? 'Project not found' : (detail.message ?? 'Failed to load the project'),
      detail.reason === 'not_found' ? 404 : 500,
    );
  }

  return NextResponse.json(detail.detail);
}

// PATCH — offer_override / style_override / signature_override мержатся в
// he_projects.brief (та же логика, что у staff, со скоупом владельца до записи).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

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
        return jsonError('Provide offer_override, style_override or signature_override', 400);
      case 'bad_type':
        return jsonError(`${err.field} must be a string`, 400);
      case 'too_long':
        return jsonError(`${err.field}: maximum ${err.max} characters`, 413);
      case 'not_found':
        return jsonError('Project not found', 404);
      default:
        return jsonError(err.message, 500);
    }
  }

  return NextResponse.json({ project: patch.project });
}
