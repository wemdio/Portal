import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadHeProjectDetail } from '@/lib/hypothesisEngine/projectDetail';
import {
  patchHeProjectBrief,
  type HeBriefPatchBody,
} from '@/lib/hypothesisEngine/projectBriefPatch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — деталка проекта: гипотезы, вертикали, цепочки, вокабуляр, базы,
// шаблоны, досье вертикалей, банк кейсов и последние jobs. Сборка — в
// lib/hypothesisEngine/projectDetail.ts (её же использует клиентский
// ENG-контур со скоупом владельца).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.detail' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const result = await loadHeProjectDetail(supabaseAdmin, id);
      if (!result.ok) {
        return jsonError(
          result.reason === 'not_found' ? 'Проект не найден' : (result.message ?? 'Ошибка чтения проекта'),
          result.reason === 'not_found' ? 404 : 500,
        );
      }

      return NextResponse.json(result.detail);
    },
  );
}

// PATCH — точечное обновление проекта: offer_override / style_override /
// signature_override (хотя бы одно обязано присутствовать) мержатся в
// he_projects.brief и уточняют генерацию цепочек. Логика — в
// lib/hypothesisEngine/projectBriefPatch.ts (её же использует клиентский
// ENG-контур); здесь — auth и RU-тексты ошибок.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.patch' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: HeBriefPatchBody;
      try {
        body = (await req.json()) as HeBriefPatchBody;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const result = await patchHeProjectBrief(supabaseAdmin, id, body);
      if (!result.ok) {
        const err = result.error;
        switch (err.code) {
          case 'no_fields':
            return jsonError('Нужен offer_override, style_override, signature_override или business_override', 400);
          case 'bad_type':
            return jsonError(`${err.field} должен быть строкой`, 400);
          case 'too_long':
            return jsonError(`${err.field}: максимум ${err.max} символов`, 413);
          case 'not_found':
            return jsonError('Проект не найден', 404);
          default:
            return jsonError(err.message, 500);
        }
      }

      return NextResponse.json({ project: result.project });
    },
  );
}
