/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCampaignProjectOwners } from '@/lib/instantly/campaignProjectOwnerResolver';

type LinkRow = { campaign_id: string; project_id: string };

function makeDb(options: {
  period?: LinkRow[];
  legacy?: LinkRow[];
  periodError?: string;
  legacyError?: string;
}) {
  const calls: Array<{ table: string; column: string; values: string[]; projection: string }> = [];
  const rowsByTable: Record<string, LinkRow[]> = {
    project_period_instantly_campaigns: options.period ?? [],
    project_instantly_campaigns: options.legacy ?? [],
  };
  const errorsByTable: Record<string, string | undefined> = {
    project_period_instantly_campaigns: options.periodError,
    project_instantly_campaigns: options.legacyError,
  };

  const db = {
    from(table: string) {
      return {
        select(projection: string) {
          return {
            async in(column: string, values: string[]) {
              calls.push({ table, column, values, projection });
              const message = errorsByTable[table];
              return {
                data: message
                  ? null
                  : (rowsByTable[table] ?? []).filter((row) => values.includes(row.campaign_id)),
                error: message ? { message } : null,
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { db, calls };
}

describe('resolveCampaignProjectOwners', () => {
  it('resolves a batch with exactly two bounded reads and preserves fail-closed ownership semantics', async () => {
    const { db, calls } = makeDb({
      period: [
        { campaign_id: 'campaign-a', project_id: 'project-a' },
        { campaign_id: 'campaign-b', project_id: 'project-a' },
        { campaign_id: 'outside-batch', project_id: 'project-x' },
      ],
      legacy: [
        { campaign_id: 'campaign-a', project_id: 'project-a' },
        { campaign_id: 'campaign-b', project_id: 'project-b' },
      ],
    });

    const owners = await resolveCampaignProjectOwners(db, [
      'campaign-a',
      'campaign-b',
      'campaign-none',
      'campaign-a',
    ]);

    expect(owners.get('campaign-a')).toEqual({ status: 'resolved', projectId: 'project-a' });
    expect(owners.get('campaign-b')).toEqual({
      status: 'ambiguous',
      projectIds: ['project-a', 'project-b'],
    });
    expect(owners.get('campaign-none')).toEqual({ status: 'none' });
    expect(owners.has('outside-batch')).toBe(false);
    expect(calls).toEqual([
      {
        table: 'project_period_instantly_campaigns',
        column: 'campaign_id',
        values: ['campaign-a', 'campaign-b', 'campaign-none'],
        projection: 'campaign_id, project_id',
      },
      {
        table: 'project_instantly_campaigns',
        column: 'campaign_id',
        values: ['campaign-a', 'campaign-b', 'campaign-none'],
        projection: 'campaign_id, project_id',
      },
    ]);
  });

  it.each([
    ['period', { periodError: 'period unavailable' }],
    ['legacy', { legacyError: 'legacy unavailable' }],
  ] as const)('fails the whole batch when the %s read fails', async (_label, failure) => {
    const { db } = makeDb(failure);

    await expect(resolveCampaignProjectOwners(db, ['campaign-a', 'campaign-b'])).rejects.toThrow(
      /lookup failed/,
    );
  });
});
