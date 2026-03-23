import {
  filterAllowedIds,
  isResourceAllowed,
  scopeAutoReportCampaignIds,
  type ClientAccessRow,
} from '@/lib/clientAccess';

describe('client Instantly access helpers', () => {
  const rows: ClientAccessRow[] = [
    { resource_type: 'campaign', resource_id: 'camp-1' },
    { resource_type: 'campaign', resource_id: 'camp-2' },
    { resource_type: 'lead_list', resource_id: 'list-a' },
    { resource_type: 'lead_list', resource_id: 'list-b' },
  ];

  describe('filterAllowedIds', () => {
    it('returns only IDs present in allowed set', () => {
      const result = filterAllowedIds(
        ['camp-1', 'camp-3', 'camp-2'],
        rows,
        'campaign',
      );
      expect(result).toEqual(['camp-1', 'camp-2']);
    });

    it('returns empty array when no overlap', () => {
      const result = filterAllowedIds(['camp-99'], rows, 'campaign');
      expect(result).toEqual([]);
    });

    it('works for lead_list type', () => {
      const result = filterAllowedIds(['list-a', 'list-x'], rows, 'lead_list');
      expect(result).toEqual(['list-a']);
    });

    it('returns all allowed IDs when requested is empty (means "give me everything")', () => {
      const result = filterAllowedIds([], rows, 'campaign');
      expect(result).toEqual(['camp-1', 'camp-2']);
    });
  });

  describe('isResourceAllowed', () => {
    it('returns true for an assigned campaign', () => {
      expect(isResourceAllowed('camp-1', rows, 'campaign')).toBe(true);
    });

    it('returns false for an unassigned campaign', () => {
      expect(isResourceAllowed('camp-99', rows, 'campaign')).toBe(false);
    });

    it('returns true for an assigned lead list', () => {
      expect(isResourceAllowed('list-b', rows, 'lead_list')).toBe(true);
    });

    it('returns false for an unassigned lead list', () => {
      expect(isResourceAllowed('list-z', rows, 'lead_list')).toBe(false);
    });
  });

  describe('scopeAutoReportCampaignIds', () => {
    it('intersects requested campaign IDs with allowed ones', () => {
      const result = scopeAutoReportCampaignIds(['camp-1', 'camp-3'], rows);
      expect(result).toEqual(['camp-1']);
    });

    it('returns all allowed campaigns when none requested', () => {
      const result = scopeAutoReportCampaignIds([], rows);
      expect(result).toEqual(['camp-1', 'camp-2']);
    });

    it('returns empty array when no campaigns assigned', () => {
      const onlyLists: ClientAccessRow[] = [
        { resource_type: 'lead_list', resource_id: 'list-a' },
      ];
      const result = scopeAutoReportCampaignIds(['camp-1'], onlyLists);
      expect(result).toEqual([]);
    });
  });
});
