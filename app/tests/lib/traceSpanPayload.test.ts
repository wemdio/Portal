import { buildTraceSpanInsertPayload } from '@/lib/tracing/traceSpanPayload';

describe('traceSpanPayload', () => {
  it('builds payload for parser_jobs trace (job_id)', () => {
    const payload = buildTraceSpanInsertPayload({
      traceId: '00000000-0000-0000-0000-000000000001',
      parentSpanId: null,
      name: 'hh.execute',
      input: { a: 1 },
      message: 'hello',
      userId: '00000000-0000-0000-0000-000000000002',
      jobId: '00000000-0000-0000-0000-000000000003',
    });

    expect(payload.trace_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(payload.parent_span_id).toBeNull();
    expect(payload.name).toBe('hh.execute');
    expect(payload.input).toEqual({ a: 1 });
    expect(payload.message).toBe('hello');
    expect(payload.user_id).toBe('00000000-0000-0000-0000-000000000002');
    expect(payload.job_id).toBe('00000000-0000-0000-0000-000000000003');
    expect(payload.search_job_id).toBeNull();
  });

  it('builds payload for search_parser_jobs trace (search_job_id)', () => {
    const payload = buildTraceSpanInsertPayload({
      traceId: '00000000-0000-0000-0000-000000000011',
      parentSpanId: null,
      name: 'search.execute',
      searchJobId: '00000000-0000-0000-0000-000000000012',
    });

    expect(payload.job_id).toBeNull();
    expect(payload.search_job_id).toBe('00000000-0000-0000-0000-000000000012');
  });

  it('throws when both jobId and searchJobId are provided', () => {
    expect(() =>
      buildTraceSpanInsertPayload({
        traceId: '00000000-0000-0000-0000-000000000021',
        parentSpanId: null,
        name: 'x',
        jobId: '00000000-0000-0000-0000-000000000022',
        searchJobId: '00000000-0000-0000-0000-000000000023',
      }),
    ).toThrow('Provide either jobId or searchJobId, not both');
  });
});

