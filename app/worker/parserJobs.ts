import { requireSupabaseAdmin, type WorkerLogger } from './_shared';

export async function recoverRunningParserJobs(
  log: WorkerLogger,
  parserTypes: readonly string[],
  label = 'parser_jobs',
): Promise<number> {
  const db = requireSupabaseAdmin(log);
  const query = db
    .from('parser_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running');

  const { data, error } = parserTypes.length === 1
    ? await query.eq('parser_type', parserTypes[0]).select('id')
    : await query.in('parser_type', [...parserTypes]).select('id');

  if (error) {
    log('warn', `Startup recovery: ${label} update failed`, error);
    return 0;
  }
  if (data?.length) log('info', `Startup recovery: reset ${data.length} ${label} to pending`);
  return data?.length ?? 0;
}

export async function claimParserJob(log: WorkerLogger, parserType: string): Promise<string | null> {
  const db = requireSupabaseAdmin(log);

  const { data: pending } = await db
    .from('parser_jobs')
    .select('id')
    .eq('status', 'pending')
    .eq('parser_type', parserType)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('parser_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}
