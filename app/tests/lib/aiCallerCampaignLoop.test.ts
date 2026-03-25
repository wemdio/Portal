import { resetStuckContacts } from '@/lib/ai-caller/campaignLoop';

function makeMockDb(contacts: { id: string; status: string }[] = []) {
  const updates: Record<string, unknown>[] = [];

  const chainable = () => {
    let filterCampaign: string | null = null;
    let filterStatus: string | null = null;

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: string) => {
        if (col === 'campaign_id') filterCampaign = val;
        if (col === 'status') filterStatus = val;
        return chain;
      },
      update: (data: Record<string, unknown>) => {
        updates.push(data);
        return chain;
      },
      then: (resolve: (val: unknown) => void) => {
        const filtered = contacts.filter(
          (c) =>
            (!filterCampaign || true) &&
            (!filterStatus || c.status === filterStatus),
        );
        resolve({ data: filtered, error: null });
      },
    };
    return chain;
  };

  return {
    db: { from: () => chainable() } as unknown,
    updates,
  };
}

describe('aiCallerCampaignLoop', () => {
  describe('resetStuckContacts', () => {
    it('resets calling contacts to pending', async () => {
      const stuckContacts = [
        { id: 'c1', status: 'calling' },
        { id: 'c2', status: 'calling' },
      ];
      const { db, updates } = makeMockDb(stuckContacts);
      const log = jest.fn();

      await resetStuckContacts(db as never, 'camp-1', log);

      expect(log).toHaveBeenCalledWith(
        'info',
        'Resetting 2 stuck calling contacts to pending',
      );
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates[0]).toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
    });

    it('does nothing when no stuck contacts', async () => {
      const { db } = makeMockDb([]);
      const log = jest.fn();

      await resetStuckContacts(db as never, 'camp-1', log);

      expect(log).not.toHaveBeenCalled();
    });
  });
});
