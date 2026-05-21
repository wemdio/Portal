import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { streamColdyReport } from '@/lib/tools/polzaReports/client';
import { unsealColdyCredentials } from '@/lib/tools/polzaReports/credentials';
import {
  buildReportFilename,
  getReportDownloadUrl,
  uploadReportXlsx,
} from '@/lib/tools/polzaReports/storage';

export const dynamic = 'force-dynamic';
// Coldy scrape can take 2-3 minutes for accounts with many campaigns.
// Vercel Pro caps at 300 — we run under our own infra so we can use it fully.
export const maxDuration = 300;

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseError(message: string, status = 200) {
  return new Response(sseEvent({ type: 'error', message }), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}

interface ColdyStreamBody {
  detailed?: boolean;
  include_created?: boolean;
  include_base_left?: boolean;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return sseError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return sseError('Необходима авторизация', 401);

  let body: ColdyStreamBody;
  try {
    body = (await req.json()) as ColdyStreamBody;
  } catch {
    body = {};
  }

  const detailed = body.detailed !== false;
  const include_created = body.include_created !== false;
  const include_base_left = body.include_base_left !== false;

  // Pull and unseal the user's Coldy credentials. RLS already constrains the
  // row to this user, so no extra filter is needed beyond user_id.
  const { data: credRow, error: credErr } = await supabase
    .from('polza_coldy_credentials')
    .select('sealed_credentials')
    .eq('user_id', user.id)
    .maybeSingle();

  if (credErr) return sseError(credErr.message, 500);
  if (!credRow?.sealed_credentials) {
    return sseError(
      'Не найдены сохранённые данные Coldy. Заполните логин и пароль в форме.',
      400,
    );
  }

  let credentials;
  try {
    credentials = unsealColdyCredentials(credRow.sealed_credentials);
  } catch (err) {
    return sseError(
      `Не удалось расшифровать сохранённые данные: ${err instanceof Error ? err.message : 'unknown'}. ` +
        'Сохраните логин/пароль заново.',
      500,
    );
  }

  // Create the job row up front so the UI can also load it from history later.
  const { data: job, error: jobErr } = await supabase
    .from('polza_report_jobs')
    .insert({
      user_id: user.id,
      source: 'coldy',
      status: 'running',
      detailed,
      include_created,
      include_base_left,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (jobErr || !job) {
    return sseError(jobErr?.message || 'Не удалось создать задачу отчёта', 500);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(data)));
        } catch {
          // browser closed the connection
        }
      };

      send({ type: 'start', jobId: job.id });

      try {
        const { xlsx, campaignsCount } = await streamColdyReport(
          credentials,
          { detailed, include_created, include_base_left },
          async (event) => {
            send(event);
            if (event.type === 'progress') {
              // Persist last known progress for the history view; best effort,
              // we don't await/retry on failure.
              await supabase
                .from('polza_report_jobs')
                .update({ progress: event })
                .eq('id', job.id);
            }
          },
          req.signal,
        );

        const createdAt = new Date();
        const filename = buildReportFilename('coldy', createdAt);
        const key = await uploadReportXlsx({
          userId: user.id,
          jobId: job.id,
          xlsx,
        });

        await supabase
          .from('polza_report_jobs')
          .update({
            status: 'completed',
            result_xlsx_path: key,
            result_filename: filename,
            campaigns_count: campaignsCount,
            completed_at: createdAt.toISOString(),
          })
          .eq('id', job.id);

        const downloadUrl = await getReportDownloadUrl({ key, filename });

        send({
          type: 'result',
          jobId: job.id,
          campaigns_count: campaignsCount,
          downloadUrl,
          filename,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
        await supabase
          .from('polza_report_jobs')
          .update({
            status: 'failed',
            error_message: message,
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        send({ type: 'error', message, jobId: job.id });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
