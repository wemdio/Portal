import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Проверка дублей «сайт уже прогоняли в v1» для движка v2.
 *
 * Сверяемся ТОЛЬКО с внутренними прогонами he_projects (не ENG): признак —
 * роль создателя (`he_projects.created_by → profiles.role`). `role='client'`
 * = ENG-прогон, его НЕ считаем дублем. `created_by IS NULL` (старое легаси)
 * трактуем как внутренний — консервативно.
 *
 * Матчинг — по нормализованному домену (lowercase, без `www.`, без trailing
 * dot), точная сверка в JS после грубого префильтра по подстроке домена.
 */

export interface LegacyDuplicateProject {
  id: string;
  name: string;
  website_url: string;
}

/** Домен для сравнения: lowercase, без www., без точки в конце. */
export function normalizeDomain(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

function domainOfUrl(url: string): string | null {
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)
      ? url
      : `https://${url}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return normalizeDomain(parsed.hostname);
  } catch {
    return null;
  }
}

export async function findInternalLegacyDuplicates(
  supabase: SupabaseClient,
  hostname: string,
): Promise<LegacyDuplicateProject[]> {
  const domain = normalizeDomain(hostname);
  if (!domain) return [];

  // Грубый префильтр по подстроке домена (ловит и https://www.…), точная
  // сверка домена ниже в JS.
  const { data: rows, error } = await supabase
    .from('he_projects')
    .select('id, name, website_url, created_by')
    .ilike('website_url', `%${domain}%`)
    .limit(300);
  if (error || !rows || rows.length === 0) return [];

  const typed = rows as Array<Record<string, unknown>>;
  const createdByIds = Array.from(
    new Set(
      typed
        .map((r) => r.created_by)
        .filter((v): v is string => typeof v === 'string'),
    ),
  );

  // Роль создателя: 'client' → ENG (не дубль), остальное/null → внутренний.
  const roleByUser = new Map<string, string | null>();
  if (createdByIds.length > 0) {
    const { data: profiles, error: profilesErr } = await supabase
      .from('profiles')
      .select('id, role')
      .in('id', createdByIds);
    if (!profilesErr && profiles) {
      for (const p of profiles as Array<Record<string, unknown>>) {
        roleByUser.set(
          String(p.id),
          typeof p.role === 'string' ? (p.role as string) : null,
        );
      }
    }
  }

  const duplicates: LegacyDuplicateProject[] = [];
  for (const row of typed) {
    const createdBy = typeof row.created_by === 'string' ? row.created_by : null;
    const role = createdBy ? (roleByUser.get(createdBy) ?? null) : null;
    if (role === 'client') continue;
    const url = typeof row.website_url === 'string' ? row.website_url : '';
    if (domainOfUrl(url) !== domain) continue;
    duplicates.push({
      id: String(row.id),
      name: typeof row.name === 'string' ? row.name : '',
      website_url: url,
    });
  }
  return duplicates;
}
