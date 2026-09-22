/** @jest-environment node */

/**
 * Вкладка «Ответы» на странице кампании читает из людской доли бюджета.
 *
 * Одно чтение одной кампании на действие человека (открыть вкладку, поиск,
 * «ещё»). После 20260922_0001 фон держит не больше 15 из 18 слотов, и если
 * оставить вкладку на 'fresh', при насыщенном фоне она ловила бы
 * «email read deferred: budget» чаще, чем до появления доли.
 */

import { NextRequest } from 'next/server';

const CAMPAIGN_ID = 'cmp-1';
const listEmails = jest.fn(async (..._args: unknown[]) => ({ items: [], next_starting_after: null }));

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: {
        userId: 'user-A',
        accessRows: [{ resource_type: 'campaign', resource_id: CAMPAIGN_ID }],
        isDemo: false,
      },
    })),
  };
});
jest.mock('@/lib/clientDemo/demoResponse', () => ({ serveClientDemo: jest.fn() }));
jest.mock('@/lib/instantly/client', () => ({
  listEmails: (...args: unknown[]) => listEmails(...args),
}));
jest.mock('@/lib/clientCampaignReplies/foreignMailboxFilter', () => ({
  resolveClientMailboxes: jest.fn(async () => new Set<string>()),
  filterForeignEmails: jest.fn(async (items: unknown[]) => items),
}));
jest.mock('@/lib/clientCampaignReplies/clientEmailReads', () => ({
  getReadEmailIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('@/lib/loggerServer', () => ({ logError: jest.fn(async () => undefined) }));

it('GET /api/client/campaigns/[id]/replies читает с приоритетом interactive', async () => {
  const { GET } = await import('@/app/api/client/campaigns/[id]/replies/route');
  const res = await GET(
    new NextRequest(`http://localhost/api/client/campaigns/${CAMPAIGN_ID}/replies?search=цена`),
    { params: Promise.resolve({ id: CAMPAIGN_ID }) },
  );
  expect(res.status).toBe(200);
  expect(listEmails).toHaveBeenCalledWith(
    expect.objectContaining({ campaign_id: CAMPAIGN_ID, email_type: 'received', search: 'цена' }),
    expect.objectContaining({ consumer: 'client_campaign_feed', requestPriority: 'interactive' }),
  );
});
