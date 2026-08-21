/**
 * @jest-environment node
 *
 * runInnEnrichJob: скачать source → распарсить CSV → RPC → залить result.xlsx.
 */

const mockJobFrom = jest.fn();
const mockJobRpc = jest.fn();
const mockStorageDownload = jest.fn();
const mockStorageUpload = jest.fn();
const updatePayloads: unknown[] = [];

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockJobFrom(...args),
    rpc: (...args: unknown[]) => mockJobRpc(...args),
    storage: {
      from: () => ({
        download: (...args: unknown[]) => mockStorageDownload(...args),
        upload: (...args: unknown[]) => mockStorageUpload(...args),
      }),
    },
  },
}));

function thenable(resolved: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['select', 'eq', 'in']) b[m] = self;
  b.update = (payload: unknown) => {
    updatePayloads.push(payload);
    return b;
  };
  b.maybeSingle = async () => resolved;
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onF, onR);
  return b;
}

const CSV = 'Компания,ИНН\nООО А,7707083893\nООО Б,771234567890\n';

const JOB = {
  id: 'job-1',
  user_id: 'user-1',
  status: 'running',
  file_name: 'inns.csv',
  source_path: 'job-1/source.csv',
  column_index: 1,
  has_header: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  updatePayloads.length = 0;
  mockJobFrom.mockReturnValue(thenable({ data: JOB, error: null }));
  const bytes = new TextEncoder().encode(CSV);
  mockStorageDownload.mockResolvedValue({
    data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    error: null,
  });
  mockStorageUpload.mockResolvedValue({ error: null });
  mockJobRpc.mockImplementation((_fn: string, args: { p_inn_list: string[] }) =>
    Promise.resolve({
      data: args.p_inn_list.map((inn) => ({ inn, name: `Компания ${inn}`, phones: '1' })),
      error: null,
    }),
  );
});

describe('runInnEnrichJob', () => {
  it('completes with uploaded xlsx and completed status', async () => {
    const { runInnEnrichJob } = await import('@/lib/innEnrich/runJob');
    await runInnEnrichJob('job-1');

    expect(mockJobRpc).toHaveBeenCalledWith('inn_enrich_fetch', {
      p_inn_list: ['7707083893', '771234567890'],
    });
    expect(mockStorageUpload).toHaveBeenCalledWith(
      'job-1/result.xlsx',
      expect.any(Buffer),
      expect.objectContaining({ upsert: true }),
    );
    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'completed', result_path: 'job-1/result.xlsx' }),
      ]),
    );
  });

  it('marks failed when RPC errors and does not upload a result', async () => {
    mockJobRpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    const { runInnEnrichJob } = await import('@/lib/innEnrich/runJob');
    await runInnEnrichJob('job-1');
    expect(mockStorageUpload).not.toHaveBeenCalled();
    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', error_message: 'statement timeout' }),
      ]),
    );
  });
});
