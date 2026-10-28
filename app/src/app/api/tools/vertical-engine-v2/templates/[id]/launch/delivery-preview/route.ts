import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { buildVeContactDeliveryPreview } from '@/lib/verticalEngineV2/contactDeliveryPreview';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import { attachVeSenderPool } from '@/lib/verticalEngineV2/senderTransport/senderPool';
import { resolveRequestedVeLaunchTransport } from '@/lib/verticalEngineV2/senderTransport/transport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(error: string, status: number, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.launch.delivery-preview' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin || !supabaseInstantly) {
        return jsonError('Server misconfigured', 500, 'SERVER_MISCONFIGURED');
      }

      const { id: templateId } = await params;
      if (!templateId) return jsonError('Не указан шаблон', 400, 'TEMPLATE_ID_REQUIRED');

      let body: Record<string, unknown>;
      try {
        const parsed = await req.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        return jsonError('Некорректное тело запроса', 400, 'INVALID_BODY');
      }

      // Способ отправки — выбор специалиста (этап 7). «Рассылку» проверяем до
      // обзора: не разрешена — отказ с причиной, а не тихий обзор Instantly.
      let requestedTransport: 'instantly' | 'sender' = 'instantly';
      if (body.expected_transport !== undefined && body.expected_transport !== null) {
        if (body.expected_transport !== 'instantly' && body.expected_transport !== 'sender') {
          return jsonError('Некорректный способ отправки', 400, 'VE_LAUNCH_TRANSPORT_INVALID');
        }
        if (body.expected_transport === 'sender') {
          const { data: template, error: templateError } = await supabaseAdmin.from('ve_templates')
            .select('base_id').eq('id', templateId).maybeSingle();
          const { data: base, error: baseError } = template?.base_id
            ? await supabaseAdmin.from('ve_bases').select('project_id').eq('id', template.base_id).maybeSingle()
            : { data: null, error: null };
          if (templateError || baseError) return jsonError('Не удалось проверить, доступна ли «Рассылка». Повторите.', 503, 'VE_LAUNCH_TRANSPORT_UNAVAILABLE');
          if (!base?.project_id) return jsonError('Шаблон не найден', 404, 'TEMPLATE_NOT_FOUND');
          const resolved = await resolveRequestedVeLaunchTransport(supabaseAdmin, base.project_id, 'sender');
          if (!resolved.ok) return jsonError(resolved.error, resolved.status, resolved.code);
          requestedTransport = 'sender';
        }
      }

      // Записанный запуск в «Рассылку»: план показывает её ящики, как GET /launch (только показ).
      let recordedSender = false;
      if (requestedTransport === 'instantly') {
        const { data: recorded } = await supabaseAdmin.from('ve_templates').select('launch_info').eq('id', templateId).maybeSingle();
        recordedSender = parseLaunchInfo((recorded as { launch_info?: unknown } | null)?.launch_info)?.transport === 'sender';
      }

      const presetId = stringField(body.preset_id);
      const result = await attachVeSenderPool(supabaseAdmin, supabaseInstantly, await buildVeContactDeliveryPreview(supabaseAdmin, supabaseInstantly, {
        templateId,
        portalProjectId: stringField(body.portal_project_id),
        // Явный null — проект без периодов; отсутствующее поле даёт 400.
        expectedPortalPeriodId:
          body.expected_portal_period_id === null ? null : stringField(body.expected_portal_period_id),
        targetContacts:
          typeof body.target_contacts === 'number' ? body.target_contacts : Number.NaN,
        presetId,
        segmentationAuditId: stringField(body.segmentation_audit_id) || null,
        requestedTransport,
      }), { templateId, presetId, recordedSender });
      return NextResponse.json(result.body, { status: result.status });
    },
  );
}
