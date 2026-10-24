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
 *   - Кампании своей «Рассылки» (запуски Движка вертикалей) — по привязке
 *     `project_sender_campaigns` (main DB) к проекту, но не по baseline: у
 *     «Рассылки» есть время каждого письма, и период считает первые письма,
 *     ушедшие с его открытия (sender_campaign_first_contacted_since). Без
 *     активного периода — за всё время. Кампания прошлого периода так сама
 *     переходит в новый, но берёт факт периода, только если она к нему
 *     привязана или в нём писала: иначе молчащая старая кампания каждую ночь
 *     затирала бы ручной факт нового периода нулём. Не прочитались — прогон
 *     падает до записи: меньшая сумма затёрла бы факт.
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
  /** Сколько кампаний «Рассылки» посчитано. */
  senderCampaignsResolved: number;
}

interface LinkRow {
  project_id: string;
  campaign_id: string;
}

interface PeriodLinkRow extends LinkRow {
  period_id: string;
  baseline_contacts: number | null;
}

interface ActivePeriodRow {
  id: string;
  project_id: string;
  created_at?: string | null;
}

interface SenderLinkRow {
  id: string;
  project_id: string;
  period_id: string | null;
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

async function fetchActivePeriods(db: SupabaseClient): Promise<Map<string, ActivePeriodRow>> {
  const { data, error } = await db
    .from('project_periods')
    .select('id, project_id, created_at')
    .eq('status', 'active');
  if (error) throw new Error(`project_periods read: ${error.message}`);

  const map = new Map<string, ActivePeriodRow>();
  for (const row of (data ?? []) as ActivePeriodRow[]) {
    map.set(row.project_id, row);
  }
  return map;
}

async function fetchAllPeriodLinks(db: SupabaseClient): Promise<PeriodLinkRow[]> {
  const out: PeriodLinkRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('project_period_instantly_campaigns')
      .select('project_id, period_id, campaign_id, baseline_contacts')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`project_period_instantly_campaigns read: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as PeriodLinkRow[]));
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

/** Привязки кампаний «Рассылки». Страницы по id: без порядка строки на границе
 * страниц могли бы прочитаться дважды и сложиться дважды. */
async function fetchAllSenderLinks(db: SupabaseClient): Promise<SenderLinkRow[]> {
  const byId = new Map<string, SenderLinkRow>();
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('project_sender_campaigns')
      .select('id, project_id, period_id, campaign_id')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`project_sender_campaigns read: ${error.message}`);
    if (!data?.length) break;
    for (const row of data as SenderLinkRow[]) byId.set(row.id, row);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return [...byId.values()];
}

/** Первые письма кампаний «Рассылки» с момента (null — за всё время); у
 * каждой кампании обязана быть строка. */
async function fetchSenderContacts(
  db: SupabaseClient,
  requests: Array<{ campaignId: string; since: string | null }>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const CHUNK = 100;
  for (let i = 0; i < requests.length; i += CHUNK) {
    const part = requests.slice(i, i + CHUNK);
    const chunk = part.map((request) => request.campaignId);
    const { data, error } = await db.rpc('sender_campaign_first_contacted_since', {
      p_campaign_ids: chunk,
      p_since: part.map((request) => request.since),
    });
    if (error) throw new Error(`sender_campaign_first_contacted_since: ${error.message}`);
    if (!Array.isArray(data)) throw new Error('sender_campaign_first_contacted_since: invalid response');
    for (const row of data as Array<{ campaign_id?: unknown; first_contacted?: unknown }>) {
      const n = Number(row.first_contacted);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`sender campaign ${String(row.campaign_id)}: invalid first-contacted count`);
      map.set(String(row.campaign_id), n);
    }
    for (const id of chunk) {
      if (!map.has(id)) throw new Error(`sender campaign ${id}: no first-contacted row`);
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
  const [activePeriods, legacyLinks, periodLinks, senderLinks] = await Promise.all([
    fetchActivePeriods(mainDb),
    fetchAllLinks(instantlyDb),
    fetchAllPeriodLinks(instantlyDb),
    fetchAllSenderLinks(mainDb),
  ]);
  const activePeriodIds = new Set([...activePeriods.values()].map((p) => p.id));
  const activePeriodLinks = periodLinks.filter((link) => {
    const active = activePeriods.get(link.project_id);
    return active?.id === link.period_id && activePeriodIds.has(link.period_id);
  });
  const links = legacyLinks.filter((link) => !activePeriods.has(link.project_id));
  // NB: even when there are no Instantly links at all, we DO NOT early-return
  // anymore — Колди/Тригга и прочие "ручные" проекты должны получить
  // ежедневный snapshot из projects.contacts_done / kpi_fact (Bug 2).

  // 2. Аналитика по уникальным campaign_id.
  const allCampaignIds = [...new Set([...links, ...activePeriodLinks].map((l) => l.campaign_id))];
  const contactsByCampaign =
    allCampaignIds.length > 0
      ? await fetchCampaignContacts(instantlyDb, allCampaignIds)
      : new Map<string, number>();
  const campaignsMissing = allCampaignIds.filter((id) => !contactsByCampaign.has(id));

  // «Рассылка»: каждая кампания проекта — один раз, с открытия активного
  // периода или за всё время. Открытие периода не прочиталось — ошибка:
  // «за всё время» задвоило бы прошлые периоды.
  const senderProjectByCampaign = new Map<string, string>();
  for (const link of senderLinks) senderProjectByCampaign.set(link.campaign_id, link.project_id);
  const senderRequests = [...senderProjectByCampaign].map(([campaignId, projectId]) => {
    const active = activePeriods.get(projectId);
    if (active && !(typeof active.created_at === 'string' && Number.isFinite(Date.parse(active.created_at)))) {
      throw new Error(`project_periods ${active.id}: created_at is unavailable`);
    }
    return { campaignId, since: active ? active.created_at as string : null };
  });
  const senderContacts = senderRequests.length > 0
    ? await fetchSenderContacts(mainDb, senderRequests)
    : new Map<string, number>();

  // 3. SUM по project_id.
  const sumByProject = new Map<string, number>();
  const periodIdByProject = new Map<string, string>();
  for (const link of activePeriodLinks) {
    const contacts = contactsByCampaign.get(link.campaign_id);
    if (contacts === undefined) continue;
    const baseline = Number(link.baseline_contacts ?? 0);
    const periodContacts = Math.max(0, contacts - (Number.isFinite(baseline) ? baseline : 0));
    sumByProject.set(link.project_id, (sumByProject.get(link.project_id) ?? 0) + periodContacts);
    periodIdByProject.set(link.project_id, link.period_id);
  }
  for (const link of links) {
    const contacts = contactsByCampaign.get(link.campaign_id);
    if (contacts === undefined) continue; // catalog не дотянулся — пропускаем эту кампанию
    sumByProject.set(link.project_id, (sumByProject.get(link.project_id) ?? 0) + contacts);
  }
  const senderLinkedToActive = new Set(senderLinks
    .filter((link) => link.period_id !== null && activePeriods.get(link.project_id)?.id === link.period_id)
    .map((link) => link.campaign_id));
  for (const [campaignId, projectId] of senderProjectByCampaign) {
    const contacts = senderContacts.get(campaignId)!;
    const active = activePeriods.get(projectId);
    if (active && contacts === 0 && !senderLinkedToActive.has(campaignId)) continue;
    sumByProject.set(projectId, (sumByProject.get(projectId) ?? 0) + contacts);
    if (active) periodIdByProject.set(projectId, active.id);
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
    const periodId = periodIdByProject.get(projectId);
    if (periodId) {
      const { error: periodUpdateErr } = await mainDb
        .from('project_periods')
        .update({
          contacts_done: String(sum),
          contacts_done_synced_at: syncedAtIso,
        })
        .eq('id', periodId);
      if (periodUpdateErr) {
        log('error', `project_periods update failed for ${periodId}: ${periodUpdateErr.message}`);
        throw new Error(`project_periods update (${periodId}): ${periodUpdateErr.message}`);
      }
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
      period_id: string | null;
      contacts_done: number;
      kpi_fact: number | null;
      recorded_at: string;
    }> = [];

    for (const p of allProjects ?? []) {
      const contacts = parseInt(p.contacts_done ?? '', 10);
      if (!Number.isFinite(contacts)) continue;
      const kpi = parseInt(p.kpi_fact ?? '', 10);
      const activePeriod = activePeriods.get(p.id);
      historyRows.push({
        project_id: p.id,
        period_id: activePeriod?.id ?? null,
        contacts_done: contacts,
        kpi_fact: Number.isFinite(kpi) ? kpi : null,
        recorded_at: today,
      });
    }

    if (historyRows.length > 0) {
      // Единый upsert по unique(project_id, recorded_at): одна строка на проект
      // в день, period_id — атрибут строки, не ключ конфликта.
      //
      // НЕ переводить arbiter на (period_id, recorded_at): idx_pch_period_date
      // исторически был частичным (WHERE period_id IS NOT NULL), а PostgREST
      // не передаёт WHERE-предикат в ON CONFLICT — Postgres отвечает 42P10,
      // и снапшоты проектов с активным периодом молча теряются (так period_id
      // и не записывался ни разу до 2026-07). Плюс period-строка за день, когда
      // legacy-строка уже существует, конфликтует именно по (project_id,
      // recorded_at) — этот arbiter разрешает и её.
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
    senderCampaignsResolved: senderContacts.size,
    historyWritten,
  });

  return {
    projectsWithLinks: sumByProject.size,
    campaignsResolved: contactsByCampaign.size,
    projectsUpdated: updated,
    projectsMissing: missing,
    campaignsMissing,
    senderCampaignsResolved: senderContacts.size,
  };
}
