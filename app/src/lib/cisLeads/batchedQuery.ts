import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

const IN_CHUNK_SIZE = 200;

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * PostgREST has a URL length limit (~8 KB). With 1000+ UUIDs in `.in()`,
 * the URL exceeds this limit and returns 400.
 * This helper splits the IDs into chunks and merges results.
 */
export async function getCompanyIdsForJob(
  db: SupabaseClient,
  jobId: string,
  userId: string,
): Promise<string[]> {
  const { data: leads } = await db
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  return Array.from(
    new Set(
      (leads ?? [])
        .map((r) => String((r as { company_id?: unknown }).company_id ?? ''))
        .filter(Boolean),
    ),
  );
}

export { IN_CHUNK_SIZE };
