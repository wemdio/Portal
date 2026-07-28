/**
 * Общий helper для складирования HH-вакансий в общий архив `hh_vacancies`
 * из клиентских автоматизаций (Mailganer через auto-pipeline, OutreachOS
 * через свой daily-pipeline).
 *
 * Обе автоматизации под капотом дёргают `hhAutoParser.findNewHhEmployers`,
 * который может отдать сырые items наружу через callback `onVacancies`.
 * Раньше этот колбэк был реализован inline в autoPipelineRunner.ts —
 * работал только для Mailganer. OutreachOS-пайплайн проходил мимо → его
 * ежедневный поток (~10-30К вакансий/день) в `hh_vacancies` не попадал,
 * парсер «HH архив» его не видел.
 *
 * Теперь: любой пайплайн вызывает `ensureArchiveSinkJob(userId)` +
 * `buildHhArchiveSinkCallback(sinkJobId)` и передаёт результат в
 * `findNewHhEmployers({ onVacancies })`. Sink parser_jobs хранится один
 * навсегда на пользователя (upsert по (user_id, parser_type)), дедуп
 * между запусками — через UNIQUE(job_id, vacancy_id) в hh_vacancies.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { HhArchiveSinkVacancy } from '@/lib/jobs/hhAutoParser';

const SINK_PARSER_TYPE = 'hh_vacancies_autopipeline';

/**
 * Возвращает id единственной sink-`parser_jobs` записи для клиента.
 * Создаётся один раз при первом прогоне и переиспользуется вечно;
 * hh_vacancies дедупит через UNIQUE(job_id, vacancy_id), так что повторные
 * upsert'ы одной и той же вакансии в разные дни не плодят дубли. Возвращает
 * `null`, если БД недоступна или INSERT упал — вызывающий пайплайн должен
 * это тихо принять и не передавать колбэк (парсер продолжит работать без
 * складирования).
 */
export async function ensureArchiveSinkJob(clientUserId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data: existing } = await supabaseAdmin
      .from('parser_jobs')
      .select('id')
      .eq('user_id', clientUserId)
      .eq('parser_type', SINK_PARSER_TYPE)
      .limit(1)
      .maybeSingle();
    if (existing && (existing as { id?: string }).id) {
      return (existing as { id: string }).id;
    }
    const { data: created, error } = await supabaseAdmin
      .from('parser_jobs')
      .insert({
        user_id: clientUserId,
        parser_type: SINK_PARSER_TYPE,
        status: 'running',
        config: { source: 'auto_pipeline_sink' },
      })
      .select('id')
      .single();
    if (error || !created) {
      console.warn(`[hh-archive-sink] ensureArchiveSinkJob insert failed for ${clientUserId}:`, error?.message);
      return null;
    }
    return (created as { id: string }).id;
  } catch (e) {
    console.warn(`[hh-archive-sink] ensureArchiveSinkJob threw for ${clientUserId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Собирает готовый callback для передачи в findNewHhEmployers({onVacancies}).
 * Возвращает `undefined`, если sinkJobId=null — parser в этом случае просто
 * не будет передавать items наружу (сохранённое поведение до этого фикса).
 */
export function buildHhArchiveSinkCallback(
  sinkJobId: string | null,
): ((batch: HhArchiveSinkVacancy[]) => Promise<void>) | undefined {
  if (!sinkJobId) return undefined;
  return async (batch: HhArchiveSinkVacancy[]) => {
    if (!supabaseAdmin || batch.length === 0) return;
    const rows = batch.map((v) => ({
      job_id: sinkJobId,
      vacancy_id: v.vacancy_id,
      name: v.name,
      url: v.url,
      salary_from: v.salary_from,
      salary_to: v.salary_to,
      salary_currency: v.salary_currency,
      company_name: v.company_name,
      company_url: v.company_url,
      area: v.area,
      industries: [] as string[],
      published_at: v.published_at,
    }));
    const { error: upErr } = await supabaseAdmin
      .from('hh_vacancies')
      .upsert(rows, { onConflict: 'job_id,vacancy_id' });
    if (upErr) {
      console.warn('[hh-archive-sink] hh_vacancies upsert failed:', upErr.message);
    }
  };
}

/**
 * Ищет user_id по email — используется OutreachOS-пайплайном, у которого
 * нет client_user_id в контексте (пайплайн общий для агентства, не per-client).
 * Кэшируется в модульной scope: email OutreachOS сервисного юзера не меняется.
 */
const cachedUserIds: Map<string, string> = new Map();

export async function getUserIdByEmail(email: string): Promise<string | null> {
  const cached = cachedUserIds.get(email);
  if (cached) return cached;
  if (!supabaseAdmin) return null;
  try {
    // profiles-таблица закрыта RLS, но supabaseAdmin bypass'ит; auth.users
    // напрямую недоступна через supabase-js — идём через profiles.
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id ?? null;
    if (id) cachedUserIds.set(email, id);
    return id;
  } catch {
    return null;
  }
}
