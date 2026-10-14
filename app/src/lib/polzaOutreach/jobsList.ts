import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Список запусков автоаутрича — общий у русского и английского. Запуски видят
 * все сотрудники (миграция 20261005_0010), а колонка слева умеет показать
 * только свои: `?scope=mine`. У каждого запуска — имя автора, чтобы в общем
 * списке было видно, чей он.
 */

export type OutreachJobsScope = 'mine' | 'all';

export function parseJobsScope(value: string | null): OutreachJobsScope {
  return value === 'mine' ? 'mine' : 'all';
}

export async function listOutreachJobs(
  supabase: SupabaseClient,
  opts: { userId: string; parserType: string; scope: OutreachJobsScope; limit: number },
) {
  let query = supabase
    .from('parser_jobs')
    .select('*')
    .eq('parser_type', opts.parserType)
    .order('created_at', { ascending: false })
    .limit(opts.limit);
  if (opts.scope === 'mine') query = query.eq('user_id', opts.userId);
  const { data, error } = await query;
  if (error) return { jobs: null, error };

  const jobs = (data ?? []) as Array<Record<string, unknown> & { user_id?: string | null }>;
  const userIds = Array.from(new Set(jobs.map((j) => j.user_id).filter((id): id is string => typeof id === 'string')));
  const names = new Map<string, string>();
  if (userIds.length) {
    // Имя — украшение списка: без него запуски всё равно показываем.
    const { data: profiles } = await supabase.from('profiles').select('id,full_name,email').in('id', userIds);
    for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
      const name = (p.full_name ?? '').trim() || (p.email ?? '').split('@')[0];
      if (name) names.set(p.id, name);
    }
  }
  return {
    jobs: jobs.map((j) => ({ ...j, author_name: (j.user_id && names.get(j.user_id)) || null })),
    error: null,
  };
}
