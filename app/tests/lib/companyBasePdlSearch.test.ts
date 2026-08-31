/** @jest-environment node */

import {
  PdlCompanyReadError,
  iteratePdlCompanyPages,
  readPdlCompanyPage,
} from '@/lib/companyBase/pdlSearch';

type RpcResult = { data: unknown; error: { message: string } | null };

function clientWith(handler: (params: Record<string, unknown>) => RpcResult | Promise<RpcResult>) {
  return {
    rpc: jest.fn(async (name: string, params: Record<string, unknown>) => {
      expect(name).toBe('search_pdl_companies');
      return handler(params);
    }),
  };
}

const ROWS = [
  { id: '001', name: 'Alpha', website: 'alpha.test', industry: 'software', size: '11-50', country: 'germany' },
  { id: '002', name: 'Beta', website: 'beta.test', industry: 'software', size: '11-50', country: 'germany' },
  { id: '003', name: 'Gamma', website: 'gamma.test', industry: 'software', size: '11-50', country: 'germany' },
];

describe('PDL company catalog reader', () => {
  it('uses the filter-first RPC with normalized filters instead of a table scan', async () => {
    const client = clientWith(() => ({ data: [ROWS[0]], error: null }));

    const rows = await readPdlCompanyPage(
      client,
      {
        industries: [' Software ', 'software'],
        sizes: ['11-50'],
        countries: [' Germany '],
        name: '  Acme%_  ',
        afterId: null,
        limit: 100,
      },
      { retryDelaysMs: [] },
    );

    expect(rows).toEqual([ROWS[0]]);
    expect(client.rpc).toHaveBeenCalledWith('search_pdl_companies', {
      p_industries: ['software'],
      p_sizes: ['11-50'],
      p_countries: ['germany'],
      p_name: 'Acme',
      p_after_id: null,
      p_limit: 100,
    });
  });

  it('retries a transient HTML gateway response and then returns the page', async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      if (calls === 1) {
        return {
          data: null,
          error: { message: '<!doctype html><html><title>Портал обновляется</title></html>' },
        };
      }
      return { data: [ROWS[0]], error: null };
    });

    const rows = await readPdlCompanyPage(
      client,
      { industries: ['software'], limit: 100 },
      { retryDelaysMs: [0] },
    );

    expect(rows).toEqual([ROWS[0]]);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it('never exposes the HTML maintenance page after retries are exhausted', async () => {
    const raw = '<!doctype html><html><title>Портал обновляется</title></html>';
    const client = clientWith(() => ({ data: null, error: { message: raw } }));

    let thrown: unknown;
    try {
      await readPdlCompanyPage(client, { limit: 100 }, { retryDelaysMs: [0] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PdlCompanyReadError);
    expect(thrown).toMatchObject({ retryable: true });
    expect(String((thrown as Error).message)).toContain('временно не ответила');
    expect(String((thrown as Error).message)).not.toContain('<html');
    expect(String((thrown as Error).message)).not.toContain('<!doctype');
  });

  it('paginates by id without duplicates and respects the requested maximum', async () => {
    const client = clientWith((params) => {
      const after = typeof params.p_after_id === 'string' ? params.p_after_id : '';
      const limit = Number(params.p_limit);
      return {
        data: ROWS.filter((row) => row.id > after).slice(0, limit),
        error: null,
      };
    });

    const pages: typeof ROWS[] = [];
    for await (const page of iteratePdlCompanyPages(
      client,
      { industries: ['software'] },
      { pageSize: 2, maxRows: 3, retryDelaysMs: [] },
    )) {
      pages.push(page as typeof ROWS);
    }

    expect(pages.flat().map((row) => row.id)).toEqual(['001', '002', '003']);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(client.rpc.mock.calls[1]?.[1]).toMatchObject({ p_after_id: '002', p_limit: 1 });
  });
});
