import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logError } from '@/lib/loggerServer';
import { mapCsvRowsToLeads } from '@/lib/clientLaunch/mapRowsToLeads';
import { runClientLaunch, ClientLaunchError } from '@/lib/clientLaunch/runLaunch';
import type {
  ClientLaunchBehaviorOverride,
  ClientLaunchColumnMapping,
  ClientLaunchScheduleOverride,
  ClientLaunchSequence,
} from '@/lib/clientLaunch/types';
import { normalizeClientLaunchSequenceSteps } from '@/lib/clientLaunch/requestParsing';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import { getClientTariffUsage } from '@/lib/tariffs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface LaunchBody {
  campaign_name?: unknown;
  sequence_steps?: unknown;
  mapping?: unknown;
  headers?: unknown;
  rows?: unknown;
  schedule?: unknown;
  behavior?: unknown;
  /**
   * Optional per-launch subset of preset.email_account_ids. Pass as a
   * string array of mailbox IDs the client wants to USE for THIS campaign
   * (must be a subset of their preset). Omit to fall back to the full
   * preset pool. Empty array is rejected downstream (validates as a
   * usage error, not silent).
   */
  email_account_ids?: unknown;
  /**
   * Alternative lead source: a completed base-constructor run. When set,
   * `headers`/`rows` from the body are IGNORED — the server pulls the job's
   * result data itself (the blob can be tens of MB; it must never round-trip
   * through the browser). Ownership: the job's user_id must equal the caller.
   */
  base_constructor_job_id?: unknown;
}

function parseScheduleOverride(raw: unknown): ClientLaunchScheduleOverride | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const from = typeof obj.from === 'string' ? obj.from : undefined;
  const to = typeof obj.to === 'string' ? obj.to : undefined;
  const days = Array.isArray(obj.days)
    ? obj.days.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6)
    : undefined;
  const timezone = typeof obj.timezone === 'string' ? obj.timezone : undefined;
  if (from === undefined && to === undefined && days === undefined && timezone === undefined) {
    return undefined;
  }
  return {
    from: from ?? '',
    to: to ?? '',
    days: days ?? [],
    timezone: timezone ?? '',
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function parseBehaviorOverride(raw: unknown): ClientLaunchBehaviorOverride | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const openTracking = typeof obj.open_tracking === 'boolean' ? obj.open_tracking : undefined;
  const stopOnReply = typeof obj.stop_on_reply === 'boolean' ? obj.stop_on_reply : undefined;
  if (openTracking === undefined || stopOnReply === undefined) return undefined;
  return {
    open_tracking: openTracking,
    stop_on_reply: stopOnReply,
  };
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data: rows, error } = await supabaseInstantly
    .from('client_campaign_launches')
    .select('id, campaign_name, instantly_campaign_id, status, uploaded_rows, accepted_rows, skipped_rows, error_message, created_at')
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    await logError('client.launches.list.failed', error, { userId });
    return jsonError('Не удалось загрузить историю запусков', 500);
  }

  return NextResponse.json({ launches: rows ?? [] });
}

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const { userId } = result.auth;

  let body: LaunchBody;
  try {
    body = (await req.json()) as LaunchBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const campaignName = typeof body.campaign_name === 'string' ? body.campaign_name : '';
  const mapping = (body.mapping ?? {}) as ClientLaunchColumnMapping;
  const baseJobId =
    typeof body.base_constructor_job_id === 'string' ? body.base_constructor_job_id.trim() : '';

  let headers: string[];
  let rows: string[][];

  if (baseJobId) {
    // Source = completed base-constructor run. Load the result server-side —
    // the data blob can be tens of MB and must not round-trip via the browser.
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    // Ownership/status check WITHOUT the data column first — selecting `data`
    // de-TOASTs the blob (up to ~46 MB) before any check runs, so a cheap
    // request with someone's pending job id would ship megabytes between the
    // DB host and prod for a guaranteed error. Same two-step pattern as
    // tools/base-constructor/[id]/data.
    const { data: jobMeta, error: jobMetaError } = await supabaseAdmin
      .from('base_constructor_jobs')
      .select('user_id, status')
      .eq('id', baseJobId)
      .single<{ user_id: string; status: string }>();

    // Not-found and foreign jobs are indistinguishable on purpose.
    if (jobMetaError || !jobMeta || jobMeta.user_id !== userId) {
      return jsonError('База не найдена', 404);
    }
    if (jobMeta.status !== 'completed') {
      return jsonError('База ещё обрабатывается — дождитесь завершения в Конструкторе баз', 400);
    }

    const { data: jobData, error: jobDataError } = await supabaseAdmin
      .from('base_constructor_jobs')
      .select('data')
      .eq('id', baseJobId)
      .single<{ data: unknown }>();
    if (jobDataError || !jobData) {
      return jsonError('База не найдена', 404);
    }

    const allRows = Array.isArray(jobData.data) ? (jobData.data as unknown[]) : [];
    if (allRows.length < 2) {
      return jsonError('В выбранной базе нет данных', 400);
    }

    const toCells = (r: unknown): string[] =>
      Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [];
    headers = toCells(allRows[0]).map((h) => h.trim());
    rows = allRows.slice(1).map(toCells);
  } else {
    headers = isStringArray(body.headers) ? body.headers : [];
    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    rows = rawRows.map((r) =>
      Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [],
    );
  }

  // Cap on RAW rows, before email filtering. validateClientLaunchInput checks
  // the limit on valid leads only, so a 50k-row base with ≤10k valid emails
  // would otherwise slip past (the UI disables such bases in the picker, but
  // the API must hold on its own).
  if (rows.length > CLIENT_LAUNCH_ROW_LIMIT) {
    return jsonError(
      `Лимит ${CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк для одного запуска. ` +
        `${baseJobId ? 'В базе' : 'В файле'} ${rows.length.toLocaleString('ru-RU')} строк.`,
      400,
    );
  }

  const sequence: ClientLaunchSequence = {
    name: campaignName,
    steps: normalizeClientLaunchSequenceSteps(body.sequence_steps),
  };

  const scheduleOverride = parseScheduleOverride(body.schedule);
  const behaviorOverride = parseBehaviorOverride(body.behavior);
  // Per-launch mailbox subset (legacy: omit → full preset pool used).
  // Subset / non-empty validation happens in runLaunch where we have
  // the preset loaded to compare against.
  const emailAccountIdsOverride = isStringArray(body.email_account_ids)
    ? body.email_account_ids
    : undefined;

  const leads = mapCsvRowsToLeads({ headers, rows, mapping });
  if (leads.length === 0) {
    return jsonError(
      baseJobId ? 'В выбранной базе нет валидных email-адресов' : 'В файле нет валидных email-адресов',
      400,
    );
  }

  try {
    const launch = await runClientLaunch({
      userId,
      sequence,
      leads,
      scheduleOverride,
      behaviorOverride,
      emailAccountIdsOverride,
      uploadedRows: rows.length,
      columnMapping: mapping,
    });

    return NextResponse.json({
      launch,
      tariff_usage: await getClientTariffUsage(userId),
    });
  } catch (err) {
    if (err instanceof ClientLaunchError) {
      return jsonError(err.message, err.status);
    }
    await logError('client.launches.post.unexpected', err, {}, { userId });
    return jsonError(
      err instanceof Error ? err.message : 'Не удалось запустить кампанию',
      500,
    );
  }
}
