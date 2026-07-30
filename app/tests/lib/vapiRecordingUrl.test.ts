import { pickRecordingUrl, getCall } from '@/lib/vapi';

const RAW_URL =
  'https://acc.r2.cloudflarestorage.com/hipaa-recordings/call-1-mono.wav';
const PRESIGNED_MONO =
  'https://hipaa-recordings.acc.r2.cloudflarestorage.com/call-1-mono.wav?X-Amz-Signature=abc';
const PRESIGNED_STEREO =
  'https://hipaa-recordings.acc.r2.cloudflarestorage.com/call-1-stereo.wav?X-Amz-Signature=def';

describe('pickRecordingUrl', () => {
  it('prefers the presigned mono URL over the private raw URL', () => {
    expect(pickRecordingUrl({
      recordingUrl: RAW_URL,
      artifact: {
        recordingUrl: RAW_URL,
        presignedMonoUrl: PRESIGNED_MONO,
        presignedStereoUrl: PRESIGNED_STEREO,
      },
    })).toBe(PRESIGNED_MONO);
  });

  it('falls back to stereo and then the plain recording URL', () => {
    expect(pickRecordingUrl({
      recordingUrl: RAW_URL,
      artifact: { presignedStereoUrl: PRESIGNED_STEREO },
    })).toBe(PRESIGNED_STEREO);
    expect(pickRecordingUrl({ recordingUrl: RAW_URL })).toBe(RAW_URL);
  });

  it('returns an empty string when the call has no recording', () => {
    expect(pickRecordingUrl({})).toBe('');
    expect(pickRecordingUrl(undefined)).toBe('');
  });
});

describe('getCall recording normalization', () => {
  const originalKey = process.env.VAPI_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.VAPI_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.VAPI_API_KEY;
    else process.env.VAPI_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  it('exposes the signed URL to all call-detail consumers', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'call-1',
        recordingUrl: RAW_URL,
        artifact: { recordingUrl: RAW_URL, presignedMonoUrl: PRESIGNED_MONO },
      }),
    }) as unknown as typeof fetch;

    const call = (await getCall('call-1')) as Record<string, unknown>;
    const artifact = call.artifact as Record<string, unknown>;

    expect(call.recordingUrl).toBe(PRESIGNED_MONO);
    expect(artifact.recordingUrl).toBe(PRESIGNED_MONO);
  });
});
