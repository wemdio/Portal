import { getAdminIds, isAdmin } from '@/lib/leadsReport/subscribers';

describe('leads report admins', () => {
  const previous = process.env.LEADS_REPORT_TG_ADMIN_IDS;

  afterAll(() => {
    if (previous === undefined) {
      delete process.env.LEADS_REPORT_TG_ADMIN_IDS;
    } else {
      process.env.LEADS_REPORT_TG_ADMIN_IDS = previous;
    }
  });

  it('парсит, фильтрует и дедуплицирует chat_id', () => {
    process.env.LEADS_REPORT_TG_ADMIN_IDS = '123, 456,invalid,123,0';
    expect(getAdminIds()).toEqual([123, 456]);
    expect(isAdmin(456)).toBe(true);
    expect(isAdmin(789)).toBe(false);
  });
});
