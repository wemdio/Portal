import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildBaseCsv, safeBaseFilename } from '@/lib/verticalEngineV2/baseCsv';
import { loadVeVerifiedContactsExport } from '@/lib/verticalEngineV2/verifiedContactsExport';

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
  const hypothesisId = req.nextUrl.searchParams.get('hypothesis_id') ?? '';
  if (!uuid.test(id) || !uuid.test(hypothesisId)) return failure('Некорректный проект или гипотеза.', 400);
  try {
    const [project, hypothesis] = await Promise.all([
      supabaseAdmin.from('ve_projects').select('id,name').eq('id', id).maybeSingle(),
      supabaseAdmin.from('ve_hypotheses').select('id,title').eq('id', hypothesisId).eq('project_id', id).maybeSingle(),
    ]);
    if (project.error || hypothesis.error) return failure('Не удалось проверить проект и гипотезу. Повторите скачивание.', 503);
    if (!project.data || !hypothesis.data) return failure('Проект или гипотеза не найдены.', 404);
    const capturedAt = new Date().toISOString();
    const snapshot = await loadVeVerifiedContactsExport(supabaseAdmin, id, hypothesisId, capturedAt);
    if (!snapshot.rows.length) return failure('Проверенных контактов с учётом исключений пока нет.', 409);
    const title = [project.data.name, hypothesis.data.title]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map(value => value.slice(0, 80)).join(' - ');
    const filename = safeBaseFilename(`${title || hypothesisId}-all-verified-${capturedAt.slice(0, 10)}`, hypothesisId);
    return new NextResponse(buildBaseCsv(snapshot.columns, snapshot.rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
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
