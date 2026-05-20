/**
 * Pins the contract for the daily Instantly → projects.contacts_done sync
 * (см. app/src/lib/projectContactsSync.ts).
 *
 * Tests use the in-memory Supabase mock (tests/helpers/mockSupabase.ts).
 * One mock instance per "DB" — main and instantly — since the production
 * code talks to two physically separate Supabase projects.
 */

import { createMockSupabase } from '../helpers/mockSupabase';
import { syncProjectContactsFromInstantly } from '@/lib/projectContactsSync';

const NOW = new Date('2026-04-26T07:00:00Z'); // 10:00 MSK

describe('syncProjectContactsFromInstantly', () => {
  it('sums new_leads_contacted_count across linked campaigns and writes contacts_done', async () => {
    const mainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'p1', name: 'Acme', contacts_done: '0', contacts_done_synced_at: null },
          { id: 'p2', name: 'Bravo', contacts_done: null, contacts_done_synced_at: null },
        ],
      },
    });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'p1', campaign_id: 'c1' },
          { project_id: 'p1', campaign_id: 'c2' },
          { project_id: 'p2', campaign_id: 'c3' },
        ],
        instantly_campaign_catalog: [
          { id: 'c1', new_leads_contacted_count: 120 },
          { id: 'c2', new_leads_contacted_count: 80 },
          { id: 'c3', new_leads_contacted_count: 45 },
        ],
      },
    });

    const result = await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    expect(result.projectsWithLinks).toBe(2);
    expect(result.projectsUpdated).toBe(2);
    expect(result.campaignsResolved).toBe(3);
    expect(result.projectsMissing).toEqual([]);
    expect(result.campaignsMissing).toEqual([]);

    const projects = mainDb.getRows('projects');
    const p1 = projects.find((p) => p.id === 'p1');
    const p2 = projects.find((p) => p.id === 'p2');
    expect(p1?.contacts_done).toBe('200');
    expect(p1?.contacts_done_synced_at).toBe(NOW.toISOString());
    expect(p2?.contacts_done).toBe('45');
    expect(p2?.contacts_done_synced_at).toBe(NOW.toISOString());
  });

  it('uses active project period links and subtracts the saved campaign baseline', async () => {
    const mainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'p1', name: 'Acme', contacts_done: '0', contacts_done_synced_at: null },
        ],
        project_periods: [
          {
            id: 'period-1',
            project_id: 'p1',
            status: 'closed',
            period_start: '2026-04-01',
            period_end: '2026-04-30',
          },
          {
            id: 'period-2',
            project_id: 'p1',
            status: 'active',
            period_start: '2026-05-01',
            period_end: null,
          },
        ],
        project_contacts_history: [],
      },
    });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          // Legacy project-level link from the previous implementation must not
          // make the active period count the whole campaign lifetime.
          { project_id: 'p1', campaign_id: 'c1' },
        ],
        project_period_instantly_campaigns: [
          {
            project_id: 'p1',
            period_id: 'period-2',
            campaign_id: 'c1',
            baseline_contacts: 1000,
          },
        ],
        instantly_campaign_catalog: [
          { id: 'c1', new_leads_contacted_count: 1250 },
        ],
      },
    });

    const result = await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    expect(result.projectsWithLinks).toBe(1);
    expect(result.projectsUpdated).toBe(1);

    const p1 = mainDb.getRows('projects').find((p) => p.id === 'p1');
    expect(p1?.contacts_done).toBe('250');

    const period = mainDb.getRows('project_periods').find((p) => p.id === 'period-2');
    expect(period?.contacts_done).toBe('250');

    const history = mainDb.getRows('project_contacts_history');
    expect(history).toContainEqual(
      expect.objectContaining({
        project_id: 'p1',
        period_id: 'period-2',
        contacts_done: 250,
        recorded_at: '2026-04-26',
      }),
    );
  });

  it('does not touch projects without any project_instantly_campaigns row', async () => {
    // Колди/Тригга кейс — у проекта нет привязок, специалист сам ведёт contacts_done.
    const mainDb = createMockSupabase({
      tables: {
        projects: [
          // Колди — не должен быть тронут.
          {
            id: 'koldi',
            name: 'Колди',
            contacts_done: '777',
            contacts_done_synced_at: null,
          },
          // Аутрич — должен быть обновлён.
          {
            id: 'outr',
            name: 'Аутрич',
            contacts_done: '0',
            contacts_done_synced_at: null,
          },
        ],
      },
    });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [{ project_id: 'outr', campaign_id: 'c1' }],
        instantly_campaign_catalog: [{ id: 'c1', new_leads_contacted_count: 50 }],
      },
    });

    await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    const projects = mainDb.getRows('projects');
    const koldi = projects.find((p) => p.id === 'koldi');
    const outr = projects.find((p) => p.id === 'outr');
    expect(koldi?.contacts_done).toBe('777'); // нетронут
    expect(koldi?.contacts_done_synced_at).toBeNull();
    expect(outr?.contacts_done).toBe('50');
    expect(outr?.contacts_done_synced_at).toBe(NOW.toISOString());
  });

  it('overwrites manual specialist edits — variant A semantics', async () => {
    // Спец вписал 999, но крон должен перезаписать на актуальную сумму.
    const mainDb = createMockSupabase({
      tables: {
        projects: [{ id: 'p1', name: 'Acme', contacts_done: '999' }],
      },
    });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [{ project_id: 'p1', campaign_id: 'c1' }],
        instantly_campaign_catalog: [{ id: 'c1', new_leads_contacted_count: 12 }],
      },
    });

    await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    const p1 = mainDb.getRows('projects').find((p) => p.id === 'p1');
    expect(p1?.contacts_done).toBe('12');
  });

  it('treats missing or null new_leads_contacted_count as 0 but still writes the project', async () => {
    const mainDb = createMockSupabase({
      tables: {
        projects: [{ id: 'p1', name: 'Acme', contacts_done: null }],
      },
    });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'p1', campaign_id: 'c1' },
          { project_id: 'p1', campaign_id: 'c2' },
        ],
        instantly_campaign_catalog: [
          { id: 'c1', new_leads_contacted_count: null },
          { id: 'c2', new_leads_contacted_count: 0 },
        ],
      },
    });

    const result = await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    expect(result.projectsUpdated).toBe(1);
    const p1 = mainDb.getRows('projects').find((p) => p.id === 'p1');
    expect(p1?.contacts_done).toBe('0');
  });

  it('reports campaigns that catalog has no analytics row for', async () => {
    const mainDb = createMockSupabase({
      tables: { projects: [{ id: 'p1', contacts_done: null }] },
    });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'p1', campaign_id: 'c1' },
          { project_id: 'p1', campaign_id: 'c-missing' },
        ],
        instantly_campaign_catalog: [{ id: 'c1', new_leads_contacted_count: 10 }],
      },
    });

    const result = await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    expect(result.campaignsMissing).toEqual(['c-missing']);
    const p1 = mainDb.getRows('projects').find((p) => p.id === 'p1');
    // c-missing skipped, c1 contributed 10
    expect(p1?.contacts_done).toBe('10');
  });

  it('records project_id from links that no longer exist in projects', async () => {
    const mainDb = createMockSupabase({ tables: { projects: [] } });
    const instantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [{ project_id: 'ghost', campaign_id: 'c1' }],
        instantly_campaign_catalog: [{ id: 'c1', new_leads_contacted_count: 5 }],
      },
    });

    const result = await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    expect(result.projectsUpdated).toBe(0);
    expect(result.projectsMissing).toEqual(['ghost']);
    // Phantom project не появился — UPDATE без INSERT.
    expect(mainDb.getRows('projects')).toHaveLength(0);
  });

  it('returns zero counters when there are no links at all', async () => {
    const mainDb = createMockSupabase({
      tables: { projects: [{ id: 'p1', contacts_done: '50' }] },
    });
    const instantlyDb = createMockSupabase({
      tables: { project_instantly_campaigns: [], instantly_campaign_catalog: [] },
    });

    const result = await syncProjectContactsFromInstantly({
      mainDb: mainDb as never,
      instantlyDb: instantlyDb as never,
      now: NOW,
    });

    expect(result).toEqual({
      projectsWithLinks: 0,
      campaignsResolved: 0,
      projectsUpdated: 0,
      projectsMissing: [],
      campaignsMissing: [],
    });
    // Никаких UPDATE по contacts_done не должно произойти.
    expect(mainDb.getRows('projects')[0].contacts_done).toBe('50');
  });

  /* ── History snapshot contract (Bug 2: пиши снапшоты и для не-Instantly проектов) ── */

  describe('project_contacts_history daily snapshot', () => {
    const TODAY = '2026-04-26';

    it('writes a snapshot for an Instantly-linked project using the synced sum', async () => {
      const mainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'p1', name: 'Acme', contacts_done: '0', kpi_fact: '5' },
          ],
          project_contacts_history: [],
        },
      });
      const instantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'p1', campaign_id: 'c1' },
            { project_id: 'p1', campaign_id: 'c2' },
          ],
          instantly_campaign_catalog: [
            { id: 'c1', new_leads_contacted_count: 120 },
            { id: 'c2', new_leads_contacted_count: 80 },
          ],
        },
      });

      await syncProjectContactsFromInstantly({
        mainDb: mainDb as never,
        instantlyDb: instantlyDb as never,
        now: NOW,
      });

      const history = mainDb.getRows('project_contacts_history');
      const p1Snap = history.find((h) => h.project_id === 'p1');
      expect(p1Snap).toBeDefined();
      expect(p1Snap?.contacts_done).toBe(200);
      expect(p1Snap?.kpi_fact).toBe(5);
      expect(p1Snap?.recorded_at).toBe(TODAY);
    });

    it('writes a snapshot for projects WITHOUT Instantly links from manual contacts_done/kpi_fact', async () => {
      // Колди / Тригга кейс: специалист руками заполняет поля 1-2 раза в неделю.
      // Cron должен пиннить эти значения как ежедневные снапшоты, чтобы tooltip
      // на странице "Проекты" мог показывать темп.
      const mainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'koldi', name: 'Колди', contacts_done: '777', kpi_fact: '42' },
            { id: 'trigga', name: 'Тригга', contacts_done: '500', kpi_fact: null },
          ],
          project_contacts_history: [],
        },
      });
      const instantlyDb = createMockSupabase({
        tables: { project_instantly_campaigns: [], instantly_campaign_catalog: [] },
      });

      await syncProjectContactsFromInstantly({
        mainDb: mainDb as never,
        instantlyDb: instantlyDb as never,
        now: NOW,
      });

      const history = mainDb.getRows('project_contacts_history');
      const koldi = history.find((h) => h.project_id === 'koldi');
      const trigga = history.find((h) => h.project_id === 'trigga');
      expect(koldi).toEqual(
        expect.objectContaining({
          project_id: 'koldi',
          contacts_done: 777,
          kpi_fact: 42,
          recorded_at: TODAY,
        }),
      );
      expect(trigga).toEqual(
        expect.objectContaining({
          project_id: 'trigga',
          contacts_done: 500,
          kpi_fact: null,
          recorded_at: TODAY,
        }),
      );
    });

    it('skips projects whose contacts_done is empty / non-numeric (nothing to snapshot)', async () => {
      const mainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'p1', contacts_done: '', kpi_fact: null }, // brand-new project
            { id: 'p2', contacts_done: null, kpi_fact: '10' },
            { id: 'p3', contacts_done: 'foo', kpi_fact: null },
          ],
          project_contacts_history: [],
        },
      });
      const instantlyDb = createMockSupabase({
        tables: { project_instantly_campaigns: [], instantly_campaign_catalog: [] },
      });

      await syncProjectContactsFromInstantly({
        mainDb: mainDb as never,
        instantlyDb: instantlyDb as never,
        now: NOW,
      });

      expect(mainDb.getRows('project_contacts_history')).toHaveLength(0);
    });

    it('upserts on (project_id, recorded_at) so re-running the cron is idempotent', async () => {
      const mainDb = createMockSupabase({
        tables: {
          projects: [{ id: 'p1', contacts_done: '100', kpi_fact: '7' }],
          // Same-day snapshot already recorded earlier in the day.
          project_contacts_history: [
            { project_id: 'p1', contacts_done: 90, kpi_fact: 6, recorded_at: TODAY },
          ],
        },
      });
      const instantlyDb = createMockSupabase({
        tables: { project_instantly_campaigns: [], instantly_campaign_catalog: [] },
      });

      await syncProjectContactsFromInstantly({
        mainDb: mainDb as never,
        instantlyDb: instantlyDb as never,
        now: NOW,
      });

      const history = mainDb.getRows('project_contacts_history');
      const p1Snaps = history.filter((h) => h.project_id === 'p1' && h.recorded_at === TODAY);
      expect(p1Snaps).toHaveLength(1);
      expect(p1Snaps[0]).toEqual(
        expect.objectContaining({ contacts_done: 100, kpi_fact: 7 }),
      );
    });
  });
});
