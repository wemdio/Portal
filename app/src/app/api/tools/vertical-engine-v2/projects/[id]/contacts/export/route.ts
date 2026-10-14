import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildBaseCsv, safeBaseFilename } from '@/lib/verticalEngineV2/baseCsv';
import { loadVeVerifiedContactsExport, VE_VERIFIED_EXPORT_MAX_HYPOTHESES } from '@/lib/verticalEngineV2/verifiedContactsExport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (error: string, status: number) => NextResponse.json({ error }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

/** A fresh, read-only download. No launch, audit job, collection or provider call. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternalToolAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return failure('Сервис недоступен. Повторите скачивание позже.', 503);
  const { id } = await params;
  const query = req.nextUrl.searchParams;
  const single = query.getAll('hypothesis_id'), multiple = query.getAll('hypothesis_ids');
  if (single.length + multiple.length !== 1) return failure('Выберите гипотезы для скачивания.', 400);
  const hypothesisIds = (single[0] ?? multiple[0] ?? '').split(',');
  if (!uuid.test(id) || !hypothesisIds.length || hypothesisIds.length > VE_VERIFIED_EXPORT_MAX_HYPOTHESES
    || hypothesisIds.some(value => !uuid.test(value)) || new Set(hypothesisIds).size !== hypothesisIds.length
    || (single.length > 0 && hypothesisIds.length !== 1)) return failure('Некорректный проект или гипотезы.', 400);
  hypothesisIds.sort();
  try {
    const [project, hypotheses] = await Promise.all([
      supabaseAdmin.from('ve_projects').select('id,name').eq('id', id).maybeSingle(),
      supabaseAdmin.from('ve_hypotheses').select('id,title').in('id', hypothesisIds).eq('project_id', id).limit(VE_VERIFIED_EXPORT_MAX_HYPOTHESES),
    ]);
    if (project.error || hypotheses.error) return failure('Не удалось проверить проект и гипотезу. Повторите скачивание.', 503);
    if (!project.data || !Array.isArray(hypotheses.data) || hypotheses.data.length !== hypothesisIds.length
      || new Set(hypotheses.data.map(row => row.id)).size !== hypothesisIds.length
      || hypotheses.data.some(row => !hypothesisIds.includes(row.id))) return failure('Проект или гипотезы не найдены.', 404);
    const titles = Object.fromEntries(hypotheses.data.map(row => [row.id, String(row.title ?? '')]));
    const capturedAt = new Date().toISOString();
    const snapshot = await loadVeVerifiedContactsExport(supabaseAdmin, id, hypothesisIds, capturedAt, titles);
    if (!snapshot.rows.length) return failure('Проверенных контактов с учётом исключений пока нет.', 409);
    const title = [project.data.name, hypothesisIds.length === 1 ? titles[hypothesisIds[0]] : 'Объединённая выгрузка']
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map(value => value.slice(0, 80)).join(' - ');
    const filename = safeBaseFilename(`${title || id}-all-verified-${capturedAt.slice(0, 10)}`, id);
    return new NextResponse(buildBaseCsv(snapshot.columns, snapshot.rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-VE-Exported-Hypotheses': String(hypothesisIds.length),
        'X-VE-Exported-Contacts': String(snapshot.rows.length),
        'X-VE-Project-Excluded': String(snapshot.excludedCount),
        'X-VE-Project-Unidentified': String(snapshot.unidentifiedCount),
        'X-VE-Exported-At': capturedAt,
      },
    });
  } catch {
    // Never return a partial file when one source or the exclusions could not
    // be read. Database messages can contain private identifiers.
    return failure('Не удалось сформировать полную выгрузку. Повторите скачивание.', 503);
  }
}
