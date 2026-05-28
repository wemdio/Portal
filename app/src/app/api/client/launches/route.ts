import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
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
  const headers = isStringArray(body.headers) ? body.headers : [];
  const rawRows = Array.isArray(body.rows) ? body.rows : [];

  const rows: string[][] = rawRows.map((r) =>
    Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [],
  );

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
    return jsonError('В файле нет валидных email-адресов', 400);
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
