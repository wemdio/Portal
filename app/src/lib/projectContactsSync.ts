/**
 * Daily sync of `projects.contacts_done` from Instantly campaign analytics.
 *
 * For every project that has at least one row in `project_instantly_campaigns`
 * (PolzaInstantlyDB), we sum `instantly_campaign_catalog.new_leads_contacted_count`
 * across the linked campaigns and write the result to `projects.contacts_done`
 * in the main DB. This is the same number that `summary.totalContacts` shows
 * in the auto-report tool (см. autoReportBuilder.ts → buildReportFromNormalized
 * и instantlyCampaignCatalog.ts → buildClientReport).
 *
 * Behaviour the user agreed to (вариант A + scope ограничение):
 *   - Поле `contacts_done` остаётся редактируемым: кнопки в UI не трогаем.
 *     Если специалист заметил ошибку и поправил руками — его правка
 *     продержится до следующего запуска крона (то есть до 10:00 МСК).
 *   - Проекты, у которых нет привязок в `project_instantly_campaigns`
 *     (Колди, Тригга и пр.) — не трогаем вообще. `contacts_done` для них
 *     заполняет специалист.
 *   - Если у проекта есть привязки, но сумма равна 0, всё равно записываем
 *     "0" (например, кампании поставили на паузу до отправок).
 *
 * Шейп БД:
 *   - main DB: `projects.contacts_done` (text), `projects.contacts_done_synced_at` (timestamptz)
 *   - instantly DB: `project_instantly_campaigns(project_id, campaign_id)`,
 *                   `instantly_campaign_catalog(id, new_leads_contacted_count)`
 *
 * Два DB-клиента: main DB и PolzaInstantlyDB — это разные Supabase-инстансы,
 * поэтому JOIN нельзя сделать одним SQL'ом. Делаем три запроса
 * и агрегируем в JS — данных тут максимум сотни проектов и тысячи кампаний,
 * нагрузки нет.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProjectContactsSyncDeps {
  /** Main Supabase (projects). Service role. */
  mainDb: SupabaseClient;
  /** PolzaInstantlyDB. Service role. */
  instantlyDb: SupabaseClient;
  /** When the run started — written to contacts_done_synced_at. */
  now: Date;
  /** Hook for tests / observability. Default: noop. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface ProjectContactsSyncResult {
  /** Сколько проектов из `project_instantly_campaigns` имеют привязки. */
  projectsWithLinks: number;
  /** Сколько кампаний всего удалось прочитать в каталоге. */
  campaignsResolved: number;
  /** Сколько проектов реально обновлено (UPDATE сработал по существующему id). */
  projectsUpdated: number;
  /** Привязанные project_id, которых нет в таблице projects (например, удалённые). */
  projectsMissing: string[];
  /** Привязанные campaign_id, которых нет в каталоге аналитики (синхронизация ещё не дотянула). */
  campaignsMissing: string[];
}

interface LinkRow {
  project_id: string;
  campaign_id: string;
}

interface CampaignAnalyticsRow {
  id: string;
  new_leads_contacted_count: number | null;
}

const PAGE_SIZE = 1000;

async function fetchAllLinks(db: SupabaseClient): Promise<LinkRow[]> {
  const out: LinkRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('project_instantly_campaigns')
      .select('project_id, campaign_id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`project_instantly_campaigns read: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as LinkRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function fetchCampaignContacts(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;

  // Размер чанка ограничен не PostgREST'ом, а Node native fetch (undici):
  // его дефолтный --max-http-header-size = 16 KB включает request line.
  // UUID длиной 36 символов + URL-кодирование запятой (`%2C`) даёт ≈40 байт
  // на id, плюс остальной URL. 100 id → URL ≈ 4 KB, с большим запасом.
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('instantly_campaign_catalog')
      .select('id, new_leads_contacted_count')
      .in('id', chunk);
    if (error) throw new Error(`instantly_campaign_catalog read: ${error.message}`);
    for (const row of (data ?? []) as CampaignAnalyticsRow[]) {
      const n = Number(row.new_leads_contacted_count);
      map.set(row.id, Number.isFinite(n) ? n : 0);
    }
  }
  return map;
}

export async function syncProjectContactsFromInstantly(
  deps: ProjectContactsSyncDeps,
): Promise<ProjectContactsSyncResult> {
  const { mainDb, instantlyDb, now } = deps;
  const log = deps.log ?? (() => {});

  // 1. All project↔campaign links.
  const links = await fetchAllLinks(instantlyDb);
  // NB: even when there are no Instantly links at all, we DO NOT early-return
  // anymore — Колди/Тригга и прочие "ручные" проекты должны получить
  // ежедневный snapshot из projects.contacts_done / kpi_fact (Bug 2).

  // 2. Аналитика по уникальным campaign_id.
  const allCampaignIds = [...new Set(links.map((l) => l.campaign_id))];
  const contactsByCampaign =
    allCampaignIds.length > 0
      ? await fetchCampaignContacts(instantlyDb, allCampaignIds)
      : new Map<string, number>();
  const campaignsMissing = allCampaignIds.filter((id) => !contactsByCampaign.has(id));

  // 3. SUM по project_id.
  const sumByProject = new Map<string, number>();
  for (const link of links) {
    const contacts = contactsByCampaign.get(link.campaign_id);
    if (contacts === undefined) continue; // catalog не дотянулся — пропускаем эту кампанию
    sumByProject.set(link.project_id, (sumByProject.get(link.project_id) ?? 0) + contacts);
  }

  // 4. Записываем в projects.contacts_done. Один UPDATE на проект — щадяще
  // и не риск получить INSERT (.upsert() мог бы вставить призрачный проект,
  // если связка указывает на удалённый project_id).
  const syncedAtIso = now.toISOString();
  let updated = 0;
  const missing: string[] = [];

  for (const [projectId, sum] of sumByProject) {
    const { data, error } = await mainDb
      .from('projects')
      .update({
        contacts_done: String(sum),
        contacts_done_synced_at: syncedAtIso,
      })
      .eq('id', projectId)
      .select('id');

    if (error) {
      log('error', `projects update failed for ${projectId}: ${error.message}`);
      throw new Error(`projects update (${projectId}): ${error.message}`);
    }
    if (!data?.length) {
      missing.push(projectId);
      continue;
    }
    updated += 1;
  }

  // 5. Write daily snapshot for pace/velocity analysis (contacts + kpi).
  //
  // Important: we snapshot ALL projects, not just the ones with Instantly
  // links. Колди/Тригга и прочие "ручные" проекты обновляются специалистом
  // 1-2 раза в неделю — без ежедневного снапшота tooltip "Темп" на странице
  // "Проекты" видит максимум одну точку и говорит "недостаточно данных".
  //
  // Source of truth per project:
  //   - Instantly-linked: projects.contacts_done was just UPDATEd above to
  //     the synced sum, so reading projects.* gives the canonical value.
  //   - Non-linked: projects.contacts_done is whatever the specialist last
  //     wrote — that's exactly what we want to record.
  //
  // We skip projects whose contacts_done is empty / non-numeric (brand-new
  // rows the specialist hasn't filled yet) — `contacts_done` in
  // project_contacts_history is NOT NULL.
  const today = now.toISOString().slice(0, 10);
  const { data: allProjects, error: projErr } = await mainDb
    .from('projects')
    .select('id, contacts_done, kpi_fact');

  let historyWritten = 0;
  if (projErr) {
    log('error', `projects read for history snapshot failed: ${projErr.message}`);
  } else {
    const historyRows: Array<{
      project_id: string;
      contacts_done: number;
      kpi_fact: number | null;
      recorded_at: string;
    }> = [];

    for (const p of allProjects ?? []) {
      const contacts = parseInt(p.contacts_done ?? '', 10);
      if (!Number.isFinite(contacts)) continue;
      const kpi = parseInt(p.kpi_fact ?? '', 10);
      historyRows.push({
        project_id: p.id,
        contacts_done: contacts,
        kpi_fact: Number.isFinite(kpi) ? kpi : null,
        recorded_at: today,
      });
    }

    if (historyRows.length > 0) {
      const { error: histErr } = await mainDb
        .from('project_contacts_history')
        .upsert(historyRows, { onConflict: 'project_id,recorded_at', ignoreDuplicates: false });
      if (histErr) {
        log('error', `contacts history upsert failed: ${histErr.message}`);
      } else {
        historyWritten = historyRows.length;
      }
    }
  }

  log('info', 'project contacts sync complete', {
    projectsWithLinks: sumByProject.size,
    campaignsResolved: contactsByCampaign.size,
    projectsUpdated: updated,
    projectsMissing: missing.length,
    campaignsMissing: campaignsMissing.length,
    historyWritten,
  });

  return {
    projectsWithLinks: sumByProject.size,
    campaignsResolved: contactsByCampaign.size,
    projectsUpdated: updated,
    projectsMissing: missing,
    campaignsMissing,
  };
}
