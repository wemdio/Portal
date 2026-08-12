import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { collectPages } from '@/lib/collectPages';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  TALENT_RESERVE_PROJECTION,
  authenticateTalentReserveRequest,
  currentMoscowDate,
  databaseErrorForLog,
  jsonError,
  logMeta,
  parseTalentReserveInput,
  sortTalentReserveRows,
  talentReserveEntryToApi,
  talentReserveSummary,
  type TalentReserveRow,
} from './helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateTalentReserveRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;
  const admin = supabaseAdmin;
  let rows: TalentReserveRow[];
  try {
    rows = await collectPages(async (from, to) => {
      const page = await admin
        .from('team_talent_reserve_entries')
        .select(TALENT_RESERVE_PROJECTION)
        .order('updated_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to);
      return {
        data: (page.data ?? []) as TalentReserveRow[],
        error: page.error ? { message: page.error.message } : null,
      };
    });
  } catch {
    await logError(
      'team.talent_reserve.list.failed',
      databaseErrorForLog('Talent reserve list query failed'),
      {},
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load talent reserve', 500);
  }

  const asOf = currentMoscowDate();
  const orderedRows = sortTalentReserveRows(rows, asOf);
  return NextResponse.json({
    entries: orderedRows.map(talentReserveEntryToApi),
    summary: talentReserveSummary(rows, asOf),
    asOf,
    canManage: actor.canManage,
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateTalentReserveRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { actor } = auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const parsed = parseTalentReserveInput(body, { partial: false });
  if ('error' in parsed) return jsonError(parsed.error, 400);

  const row = {
    ...parsed.value,
    created_by: actor.userId,
    updated_by: actor.userId,
  };
  const { data, error } = await supabaseAdmin
    .from('team_talent_reserve_entries')
    .insert(row)
    .select(TALENT_RESERVE_PROJECTION)
    .single();

  if (error || !data) {
    await logError(
      'team.talent_reserve.create.failed',
      databaseErrorForLog('Talent reserve create query failed'),
      { stage: parsed.value.stage },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to create talent reserve entry', 500);
  }

  await logAudit(
    'team.talent_reserve.create.success',
    'Talent reserve entry created',
    { entryId: String(data.id), stage: parsed.value.stage },
    logMeta(req, actor.userId),
  );

  return NextResponse.json(
    { entry: talentReserveEntryToApi(data as TalentReserveRow) },
    { status: 201 },
  );
}
