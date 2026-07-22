/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  recoverStalePreparingWebsiteEnrichmentJobs,
  type WebsiteEnrichmentDb,
} from '@/lib/enrich/websiteEnrichmentJobPublisher';

describe('website enrichment job publisher recovery', () => {
  it('publishes only a fully prepared stale queue and fails an incomplete one', async () => {
    const cutoff = '2026-07-22T05:00:00.000Z';
    const db = createMockSupabase({
      tables: {
        website_enrichment_jobs: [
          {
            id: 'complete-stale',
            status: 'preparing',
            total: 2,
            created_at: '2026-07-22T04:30:00.000Z',
            preparing_heartbeat_at: '2026-07-22T04:40:00.000Z',
          },
          {
            id: 'partial-stale',
            status: 'preparing',
            total: 2,
            created_at: '2026-07-22T04:31:00.000Z',
            preparing_heartbeat_at: '2026-07-22T04:41:00.000Z',
          },
          {
            id: 'fresh',
            status: 'preparing',
            total: 1,
            created_at: '2026-07-22T05:01:00.000Z',
            preparing_heartbeat_at: '2026-07-22T05:01:00.000Z',
          },
          {
            id: 'old-but-active',
            status: 'preparing',
            total: 2,
            created_at: '2026-07-22T04:00:00.000Z',
            preparing_heartbeat_at: '2026-07-22T05:01:00.000Z',
          },
        ],
        website_enrichment_queue: [
          { id: 'q1', job_id: 'complete-stale' },
          { id: 'q2', job_id: 'complete-stale' },
          { id: 'q3', job_id: 'partial-stale' },
        ],
      },
    });

    const result = await recoverStalePreparingWebsiteEnrichmentJobs(
      db as unknown as WebsiteEnrichmentDb,
      cutoff,
    );

    expect(result).toEqual({ published: 1, failed: 1 });
    expect(db.getRows('website_enrichment_jobs')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'complete-stale', status: 'pending' }),
        expect.objectContaining({
          id: 'partial-stale',
          status: 'failed',
          completed_at: expect.any(String),
          error_message: expect.stringContaining('1/2'),
        }),
        expect.objectContaining({ id: 'fresh', status: 'preparing' }),
        expect.objectContaining({ id: 'old-but-active', status: 'preparing' }),
      ]),
    );
  });

  it('does not recover a job whose publisher renewed the observed lease', async () => {
    const cutoff = '2026-07-22T05:00:00.000Z';
    const renewedHeartbeat = '2026-07-22T05:01:00.000Z';
    const db = createMockSupabase({
      tables: {
        website_enrichment_jobs: [
          {
            id: 'lease-race',
            status: 'preparing',
            total: 1,
            created_at: '2026-07-22T04:00:00.000Z',
            preparing_heartbeat_at: '2026-07-22T04:30:00.000Z',
          },
        ],
        website_enrichment_queue: [{ id: 'q1', job_id: 'lease-race' }],
      },
    });
    const baseFrom = db.from;
    let jobBuilderCalls = 0;
    db.from = ((table: string) => {
      if (table === 'website_enrichment_jobs') {
        jobBuilderCalls += 1;
        if (jobBuilderCalls === 2) {
          void baseFrom(table)
            .update({ preparing_heartbeat_at: renewedHeartbeat })
            .eq('id', 'lease-race')
            .then();
        }
      }
      return baseFrom(table);
    }) as typeof db.from;

    const result = await recoverStalePreparingWebsiteEnrichmentJobs(
      db as unknown as WebsiteEnrichmentDb,
      cutoff,
    );

    expect(result).toEqual({ published: 0, failed: 0 });
    expect(db.getRows('website_enrichment_jobs')[0]).toEqual(
      expect.objectContaining({
        status: 'preparing',
        preparing_heartbeat_at: renewedHeartbeat,
      }),
    );
  });
});
