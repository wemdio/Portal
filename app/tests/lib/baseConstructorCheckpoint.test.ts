import {
  ENRICH_CHECKPOINT_ATTEMPTED_COL,
  stripEnrichCheckpointMetadata,
} from '@/lib/tools/baseConstructorCheckpoint';

describe('stripEnrichCheckpointMetadata', () => {
  it('removes every private marker column while preserving row order and values', () => {
    const rows = [
      ['Компания', ENRICH_CHECKPOINT_ATTEMPTED_COL, 'Сайт', ENRICH_CHECKPOINT_ATTEMPTED_COL],
      ['Alpha', '1', 'alpha.example', ''],
      ['Beta', '', 'beta.example', '1'],
    ];

    expect(stripEnrichCheckpointMetadata(rows)).toEqual([
      ['Компания', 'Сайт'],
      ['Alpha', 'alpha.example'],
      ['Beta', 'beta.example'],
    ]);
  });

  it('returns the original array when no checkpoint metadata exists', () => {
    const rows = [['Компания'], ['Alpha']];
    expect(stripEnrichCheckpointMetadata(rows)).toBe(rows);
  });
});
