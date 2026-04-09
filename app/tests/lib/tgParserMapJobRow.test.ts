import { tgParserApiRowToUi } from '@/lib/tgParser/mapJobRow';
import type { TgParserJobApiRow } from '@/lib/tgParser/mapJobRow';

describe('tgParserApiRowToUi', () => {
  it('maps pending to running UI status', () => {
    const row: TgParserJobApiRow = {
      id: 'a',
      user_id: 'user-a',
      created_at: '2025-01-01T00:00:00Z',
      status: 'pending',
      config: { links: ['https://t.me/x'], account_label: 'Test', links_summary: '(https://t.me/x)' },
      account_id: null,
      result_users: null,
      stop_reason: null,
      error_message: null,
      started_at: null,
      completed_at: null,
    };
    const ui = tgParserApiRowToUi(row);
    expect(ui.status).toBe('running');
    expect(ui.linkCount).toBe(1);
  });

  it('maps done + stop_reason to warning', () => {
    const row: TgParserJobApiRow = {
      id: 'b',
      user_id: 'user-b',
      created_at: '2025-01-01T00:00:00Z',
      status: 'done',
      config: { links: [], links_summary: '' },
      account_id: null,
      result_users: [],
      stop_reason: 'contact_limit',
      error_message: null,
      started_at: '2025-01-01T00:00:01Z',
      completed_at: '2025-01-01T00:01:00Z',
    };
    const ui = tgParserApiRowToUi(row);
    expect(ui.status).toBe('done');
    expect(ui.warning).toContain('лимит');
  });
});
