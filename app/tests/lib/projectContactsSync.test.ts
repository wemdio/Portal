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
});
