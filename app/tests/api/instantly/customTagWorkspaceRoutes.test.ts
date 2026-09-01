/** @jest-environment node */

import type { NextRequest } from 'next/server';

type Handler = (req: NextRequest) => Promise<Response>;

jest.mock('@/lib/instantly/apiRouteHelper', () => ({
  withAuth: (handler: Handler) => async (req: NextRequest) => handler(req),
}));

jest.mock('@/lib/instantly/client', () => ({
  listAllCustomTags: jest.fn(),
  listCustomTags: jest.fn(),
  listAllCustomTagMappings: jest.fn(),
  listCustomTagMappings: jest.fn(),
}));

import * as instantly from '@/lib/instantly/client';
import { GET as getTags } from '@/app/api/instantly/tags/route';
import { GET as getTagMappings } from '@/app/api/instantly/tag-mappings/route';

const mockListAllCustomTags = instantly.listAllCustomTags as jest.Mock;
const mockListCustomTags = instantly.listCustomTags as jest.Mock;
const mockListAllCustomTagMappings = instantly.listAllCustomTagMappings as jest.Mock;
const mockListCustomTagMappings = instantly.listCustomTagMappings as jest.Mock;

const WORKSPACE_ID = 'workspace-b';

function request(path: string): NextRequest {
  return new Request(`http://portal.test${path}`) as unknown as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListAllCustomTags.mockResolvedValue([]);
  mockListCustomTags.mockResolvedValue({ items: [], next_starting_after: null });
  mockListAllCustomTagMappings.mockResolvedValue([]);
  mockListCustomTagMappings.mockResolvedValue({ items: [], next_starting_after: null });
});

describe('generic Instantly custom-tag routes — workspace forwarding', () => {
  it('forwards account_id to paginated and all-pages custom tag reads', async () => {
    await getTags(request(`/api/instantly/tags?limit=20&account_id=${WORKSPACE_ID}`));
    await getTags(request(`/api/instantly/tags?limit=all&account_id=${WORKSPACE_ID}`));

    expect(mockListCustomTags).toHaveBeenCalledWith(
      { limit: 20, starting_after: undefined },
      { accountId: WORKSPACE_ID },
    );
    expect(mockListAllCustomTags).toHaveBeenCalledWith({ accountId: WORKSPACE_ID });
  });

  it('forwards account_id to paginated and all-pages account tag-mapping reads', async () => {
    await getTagMappings(request(
      `/api/instantly/tag-mappings?resource_type=account&tag_id=tag-1&account_id=${WORKSPACE_ID}`,
    ));
    await getTagMappings(request(
      `/api/instantly/tag-mappings?limit=all&resource_type=account&account_id=${WORKSPACE_ID}`,
    ));

    expect(mockListCustomTagMappings).toHaveBeenCalledWith(
      {
        limit: 100,
        starting_after: undefined,
        tag_id: 'tag-1',
        resource_type: 'account',
      },
      { accountId: WORKSPACE_ID },
    );
    expect(mockListAllCustomTagMappings).toHaveBeenCalledWith(
      'account',
      { accountId: WORKSPACE_ID },
    );
  });
});
