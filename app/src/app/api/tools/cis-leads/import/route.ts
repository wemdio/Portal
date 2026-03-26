import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { buildCisLeadImportObjectName, getFilenameExtension } from '@/lib/cisLeads/cisLeadImportStoragePath';
import { runLeadImportJob } from '@/lib/cisLeads/leadImportWorker';

export const dynamic = 'force-dynamic';

const BUCKET = 'cis-lead-imports';
const MAX_FILE_SIZE_BYTES = 60 * 1024 * 1024; // 60 MB
const SUPPORTED_EXTENSIONS = new Set(['.csv', '.xls', '.xlsx']);

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.import.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

      const contentType = req.headers.get('content-type') ?? '';
      if (!contentType.startsWith('multipart/form-data')) {
        return jsonError('Ожидается multipart/form-data с файлом в поле "file"', 400);
      }

      const formData = await req.formData();
      const file = formData.get('file');
      const sourceLabel = (formData.get('source_label') as string | null)?.trim() || null;

      if (!(file instanceof File)) {
        return jsonError('Поле "file" обязательно', 400);
      }

      const filename = file.name?.trim() || 'leads';
      const ext = getFilenameExtension(filename);
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return jsonError('Неверный формат файла. Поддерживаются: CSV, XLS, XLSX', 400);
      }

      const arrayBuffer = await file.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
        return jsonError('Файл слишком большой (лимит 60 МБ)', 400);
      }

      const now = new Date().toISOString();

      const { data: job, error: jobError } = await supabaseAdmin
        .from('lead_import_jobs')
        .insert({
          user_id: auth.user.id,
          status: 'pending',
          source_filename: filename,
          source_label: sourceLabel,
          total_rows: 0,
          processed_rows: 0,
          created_at: now,
        })
        .select('id')
        .single<{ id: string }>();

      if (jobError || !job) return jsonError(jobError?.message ?? 'Failed to create import job', 500);

      const filePath = `${auth.user.id}/${job.id}/${buildCisLeadImportObjectName(filename)}`;
      const uploadRes = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(filePath, arrayBuffer, { contentType: file.type || 'application/octet-stream', upsert: true });

      if (uploadRes.error) {
        await supabaseAdmin
          .from('lead_import_jobs')
          .update({ status: 'failed', error_message: uploadRes.error.message, completed_at: new Date().toISOString() })
          .eq('id', job.id);
        return jsonError(`Не удалось загрузить файл: ${uploadRes.error.message}`, 500);
      }

      await supabaseAdmin
        .from('lead_import_jobs')
        .update({
          file_path: filePath,
          file_mime: file.type || null,
          file_size_bytes: arrayBuffer.byteLength,
        })
        .eq('id', job.id);

      // Start processing right away so the job does not stay in pending.
      void runLeadImportJob(job.id).catch((error) => {
        console.error('CIS lead import worker failed:', error);
      });

      return NextResponse.json({ job_id: job.id }, { status: 201 });
    },
  );
}

