import { pickRecordingUrl, getCall } from '@/lib/vapi';

/**
 * Vapi отдаёт recordingUrl как «сырую» ссылку на приватный R2-бакет.
 * Без подписи R2 отвечает 400 InvalidArgument/Authorization — плеер молчит,
 * «Скачать запись» открывает XML-ошибку. Рабочие ссылки лежат в
 * artifact.presigned*Url.
 */
const RAW_URL =
  'https://acc.r2.cloudflarestorage.com/hipaa-recordings/call-1-mono.wav';
const PRESIGNED_MONO =
  'https://hipaa-recordings.acc.r2.cloudflarestorage.com/call-1-mono.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';
const PRESIGNED_STEREO =
  'https://hipaa-recordings.acc.r2.cloudflarestorage.com/call-1-stereo.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=def';

describe('pickRecordingUrl', () => {
  it('prefers the presigned mono URL over the raw R2 URL', () => {
    const call = {
      recordingUrl: RAW_URL,
      artifact: {
        recordingUrl: RAW_URL,
        presignedMonoUrl: PRESIGNED_MONO,
        presignedStereoUrl: PRESIGNED_STEREO,
      },
    };

    expect(pickRecordingUrl(call)).toBe(PRESIGNED_MONO);
  });

  it('falls back to the presigned stereo URL when mono is missing', () => {
    const call = {
      recordingUrl: RAW_URL,
      artifact: { presignedStereoUrl: PRESIGNED_STEREO },
    };

    expect(pickRecordingUrl(call)).toBe(PRESIGNED_STEREO);
  });

  it('falls back to the plain recordingUrl when there are no presigned URLs', () => {
    expect(pickRecordingUrl({ recordingUrl: RAW_URL })).toBe(RAW_URL);
    expect(pickRecordingUrl({ artifact: { recordingUrl: RAW_URL } })).toBe(RAW_URL);
  });

  it('returns an empty string when there is no recording', () => {
    expect(pickRecordingUrl({})).toBe('');
    expect(pickRecordingUrl(undefined)).toBe('');
  });
});

describe('getCall', () => {
  const originalKey = process.env.VAPI_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.VAPI_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env.VAPI_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  it('rewrites recordingUrl to the signed URL clients can actually open', async () => {
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

  it('leaves a call without a recording untouched', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'call-2', status: 'queued' }),
    }) as unknown as typeof fetch;

    const call = (await getCall('call-2')) as Record<string, unknown>;

    expect(call.recordingUrl).toBeUndefined();
    expect(call.id).toBe('call-2');
  });
});
