import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { getBlockedEmailSet, normalizeBlockedEmail } from '@/lib/clientBlocklist/blockedContacts';
import { buildBaseCsv, safeBaseFilename } from '@/lib/verticalEngineV2/baseCsv';
import type { VeBase, VeSegmentationAudit, VeTemplate } from '@/lib/verticalEngineV2/types';
import { validateStoredAuditSnapshot } from '@/lib/verticalEngineV2/stages/segmentationAudit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type BaseExportMode = 'raw' | 'launch-ready';

function exportMode(req: NextRequest): BaseExportMode | null {
  const requested = req.nextUrl.searchParams.get('mode');
  if (requested === null || requested === '' || requested === 'raw') return 'raw';
  if (requested === 'launch-ready') return 'launch-ready';
  return null;
}

function launchContext(req: NextRequest): {
  templateId: string;
  auditId: string;
  presetId: string;
} | null {
  const templateId = req.nextUrl.searchParams.get('template_id')?.trim() ?? '';
  const auditId = req.nextUrl.searchParams.get('segmentation_audit_id')?.trim() ?? '';
  const presetId = req.nextUrl.searchParams.get('preset_id')?.trim() ?? '';
  return templateId && auditId && presetId ? { templateId, auditId, presetId } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// GET — скачать raw-базу целиком или только launch-ready аудиторию как CSV
// (разделитель ';', BOM — под Excel-RU). Отсутствующий mode остаётся raw для
// обратной совместимости со старыми ссылками.
// Пустая база (row_count=0, напр. сборка упала или файл только загрузили) →
// 409: отдавать CSV из одних заголовков было бы молчаливой потерей данных.
// data ≤ 50 000 строк (кап автосборки; ручная загрузка — 10 000), поэтому
// собираем в буфер.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.bases.export.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);
      const mode = exportMode(req);
      if (!mode) return jsonError('Неизвестный режим выгрузки', 400);
      const context = mode === 'launch-ready' ? launchContext(req) : null;
      if (mode === 'launch-ready' && !context) {
        return jsonError('Для CSV запуска нужны шаблон, свежий аудит и клиентский пресет', 400);
      }

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('ve_bases')
        .select('id, project_id, vertical_id, hypothesis_id, filename, row_count, columns, data, source')
        .eq('id', id)
        .single();
      if (baseErr) {
        return jsonError(
          baseErr.code === 'PGRST116' ? 'База не найдена' : baseErr.message,
          baseErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
      if (rowCount <= 0) {
        return jsonError('База пустая — нечего выгружать', 409);
      }

      const columns = Array.isArray(base.columns)
        ? (base.columns as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
      const rows = Array.isArray(base.data)
        ? (base.data as unknown[]).filter(isRecord)
        : [];
      // row_count>0, но data пуст/не массив (битая запись) — тот же 409:
      // row_count здесь только счётчик, экспортировать по факту нечего.
      if (rows.length === 0) {
        return jsonError('База пустая — нечего выгружать', 409);
      }

      let exportRows = rows;
      let exportColumns = columns;
      if (mode === 'launch-ready' && context) {
        if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

        const [{ data: templateRow, error: templateErr }, { data: auditRow, error: auditErr }] =
          await Promise.all([
            supabaseAdmin.from('ve_templates').select('*').eq('id', context.templateId).maybeSingle(),
            supabaseAdmin.from('ve_segmentation_audits').select('*').eq('id', context.auditId).maybeSingle(),
          ]);
        if (templateErr || !templateRow) {
          return jsonError(templateErr?.message ?? 'Шаблон не найден', templateErr ? 500 : 404);
        }
        if (auditErr || !auditRow) {
          return jsonError(auditErr?.message ?? 'Аудит сегментации устарел', auditErr ? 500 : 409);
        }

        const template = templateRow as VeTemplate;
        const audit = auditRow as VeSegmentationAudit;
        if (template.status !== 'ready') {
          return jsonError('Шаблон ещё не готов к запуску', 409);
        }
        const validation = validateStoredAuditSnapshot({
          audit,
          template,
          base: base as unknown as VeBase,
        });
        if (validation.state !== 'current') {
          return jsonError(
            validation.state === 'incomplete'
              ? 'Аудит сегментации не завершён полностью'
              : 'Аудит сегментации устарел',
            409,
          );
        }

        const { data: presetRow, error: presetErr } = await supabaseInstantly
          .from('client_campaign_presets')
          .select('id, client_user_id')
          .eq('id', context.presetId)
          .maybeSingle();
        if (presetErr || !presetRow) {
          return jsonError(presetErr?.message ?? 'Клиентский пресет не найден', presetErr ? 500 : 404);
        }
        const clientUserId = typeof presetRow.client_user_id === 'string'
          ? presetRow.client_user_id.trim()
          : '';
        if (!clientUserId) return jsonError('У клиентского пресета не указан владелец', 409);

        let blockedEmails: Set<string>;
        try {
          blockedEmails = await getBlockedEmailSet(supabaseInstantly, clientUserId);
        } catch {
          return jsonError('Не удалось полностью проверить чёрный список клиента', 500);
        }

        exportRows = [];
        validation.snapshot.audience.leads.forEach((lead, leadIndex) => {
          const email = normalizeBlockedEmail(lead.email);
          if (!email || blockedEmails.has(email)) return;
          const row = validation.snapshot.audience.rows[leadIndex];
          if (!row) return;
          exportRows.push({
            ...row,
            _ve_segment: validation.assignments.get(leadIndex) ?? '',
          });
        });
        exportColumns = [...columns.filter((column) => column !== '_ve_segment'), '_ve_segment'];
      }
      if (exportRows.length === 0) {
        return jsonError('В базе нет строк, готовых к запуску', 409);
      }

      const csv = buildBaseCsv(exportColumns, exportRows);
      const requestedMode = req.nextUrl.searchParams.get('mode');
      const filename = safeBaseFilename(
        typeof base.filename === 'string' ? base.filename : null,
        id,
        requestedMode ? mode : undefined,
      );

      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    },
  );
}
