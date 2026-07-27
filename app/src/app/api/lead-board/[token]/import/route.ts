import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { resolveBoard, jsonBoardError as jsonError } from '@/lib/leadBoard/boardResolver';
import { parseImportedFile } from '@/lib/leadBoard/importLeads';

export const dynamic = 'force-dynamic';

/**
 * Импорт лидов файлом (CSV / XLSX) на гостевую доску — для проектов, где спецы
 * вели таблицу вручную в Google Sheets. Та же capability-авторизация по токену.
 *
 * POST multipart/form-data, поле `file` (≤2 МБ, ≤1000 строк данных).
 * Маппинг — по русским заголовкам колонок (см. importLeads.ts); неизвестные
 * колонки игнорируются. Дедуп: строка с email, уже присутствующим на доске,
 * пропускается. Клиентские колонки (quality/comment/taken) берутся ИЗ файла —
 * в этом смысл импорта ведённых таблиц. Ответ: { imported, skipped, warnings,
 * ignoredColumns }.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const token = (await ctx.params).token;
  const r = await resolveBoard(token);
  if (r.error) return r.error;
  const { projectId, db } = r.board!;

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (f && typeof f !== 'string') file = f;
  } catch {
    return jsonError('expected multipart/form-data with a file', 400);
  }
  if (!file) return jsonError('file is required', 400);
  if (file.size > MAX_FILE_BYTES) return jsonError('file too large (max 2 MB)', 400);

  let parsed;
  try {
    parsed = parseImportedFile(file.name || 'upload', Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    return jsonError(`failed to parse file: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  if (parsed.rows.length === 0) {
    return jsonError(
      `no importable rows${parsed.warnings.length ? `: ${parsed.warnings.join('; ')}` : ''}`,
      400,
    );
  }

  // Дедуп по email: уже лежащие на доске пропускаем (в т.ч. бэкфилл/воркер-строки).
  const emails = [
    ...new Set(parsed.rows.map((row) => row.lead_email).filter((e): e is string => Boolean(e))),
  ];
  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += 50) {
    const { data, error } = await db
      .from('project_lead_board_rows')
      .select('lead_email')
      .eq('project_id', projectId)
      .in('lead_email', emails.slice(i, i + 50));
    if (error) return jsonError(error.message, 500);
    for (const row of data ?? []) existing.add((row as { lead_email: string }).lead_email);
  }

  const toInsert: Record<string, unknown>[] = [];
  const skipped = [...parsed.skipped];
  for (const row of parsed.rows) {
    if (row.lead_email && existing.has(row.lead_email)) {
      skipped.push({ index: row.sourceIndex ?? 0, reason: `дубликат: ${row.lead_email} уже на доске` });
      continue;
    }
    const rest = { ...row } as Record<string, unknown>;
    delete rest.sourceIndex; // служебное поле отчёта, в БД не пишется
    toInsert.push({ project_id: projectId, ...rest });
  }

  let imported = 0;
  for (let i = 0; i < toInsert.length; i += 50) {
    const chunk = toInsert.slice(i, i + 50);
    const { error } = await db.from('project_lead_board_rows').insert(chunk);
    if (error) return jsonError(error.message, 500);
    imported += chunk.length;
  }

  return NextResponse.json({
    ok: true,
    imported,
    skipped,
    warnings: parsed.warnings,
    ignoredColumns: parsed.ignoredColumns,
  });
}
