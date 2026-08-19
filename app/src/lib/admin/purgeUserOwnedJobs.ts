import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Job parents whose children (queues, map orgs/links, search results) are too
 * large for GoTrue's DELETE FROM auth.users cascade: nginx /auth/v1/ times out
 * at 60s, and queue.user_id has no index. Deleting the job row first cascades
 * through indexed job_id FKs, so the later auth delete is cheap.
 */
export const USER_DELETE_HEAVY_JOB_TABLES = [
  'email_validation_jobs',
  'website_enrichment_jobs',
  'yandex_maps_jobs',
  'search_parser_jobs',
] as const;

const JOB_PAGE_SIZE = 100;

type AdminError = { message: string };

export async function purgeUserOwnedJobs(
  admin: SupabaseClient,
  userId: string,
): Promise<AdminError | null> {
  for (const table of USER_DELETE_HEAVY_JOB_TABLES) {
    const error = await purgeJobTable(admin, table, userId);
    if (error) return error;
  }
  return null;
}

async function purgeJobTable(
  admin: SupabaseClient,
  table: (typeof USER_DELETE_HEAVY_JOB_TABLES)[number],
  userId: string,
): Promise<AdminError | null> {
  for (;;) {
    const { data, error: selectError } = await admin
      .from(table)
      .select('id')
      .eq('user_id', userId)
      .limit(JOB_PAGE_SIZE);
    if (selectError) return { message: selectError.message };

    const ids = (data ?? [])
      .map((row) => (typeof row.id === 'string' ? row.id : null))
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return null;

    const { error: deleteError } = await admin
      .from(table)
      .delete()
      .eq('user_id', userId)
      .in('id', ids);
    if (deleteError) return { message: deleteError.message };
  }
}
