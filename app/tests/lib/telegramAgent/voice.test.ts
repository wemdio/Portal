/** @jest-environment node */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('@/lib/transcription', () => ({
  extractOrConvertToMp3: jest.fn().mockResolvedValue(Buffer.from('mp3')),
}));

jest.mock('../../../src/lib/telegramAgent/telegram', () => ({
  downloadVoiceFile: jest.fn().mockResolvedValue(Buffer.from('ogg-data')),
}));

jest.mock('@/lib/loggerServer', () => ({
  logError: jest.fn(),
  logAudit: jest.fn(),
}));

import { transcribeVoiceMessage } from '@/lib/telegramAgent/voice';
import { downloadVoiceFile } from '@/lib/telegramAgent/telegram';
import { extractOrConvertToMp3 } from '@/lib/transcription';

function whisperOk(text: string) {
  return new Response(JSON.stringify({ text }), { status: 200 });
}

function chatOk(text: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
    { status: 200 },
  );
}

function fail(status = 500) {
  return new Response('error', { status });
}

describe('telegramAgent/voice', () => {
  beforeEach(() => {
    process.env.OPENROUTER_AGENT_API_KEY = 'test-key';
    process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY = 'test-video-key';
  });

  afterEach(() => jest.clearAllMocks());

  it('transcribes via Whisper (primary)', async () => {
    mockFetch.mockResolvedValueOnce(whisperOk('привет'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('привет');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('requesty.ai');
    expect(url).toContain('/audio/transcriptions');
  });

  it('falls back to Gemini if Whisper fails', async () => {
    mockFetch
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(chatOk('через гемини'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('через гемини');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to policy/transcription if both Whisper and Gemini fail', async () => {
    mockFetch
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(chatOk('через полиси'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('через полиси');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns null when all methods fail', async () => {
    mockFetch
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(fail(500));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });

  it('returns null for duration over limit', async () => {
    const result = await transcribeVoiceMessage('file-123', 600);
    expect(result).toBeNull();
    expect(downloadVoiceFile).not.toHaveBeenCalled();
  });

  it('returns null when download fails', async () => {
    (downloadVoiceFile as jest.Mock).mockResolvedValueOnce(null);
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });

  it('returns null on ffmpeg conversion error', async () => {
    (extractOrConvertToMp3 as jest.Mock).mockRejectedValueOnce(new Error('ffmpeg failed'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });

  it('skips empty whisper result and tries next method', async () => {
    mockFetch
      .mockResolvedValueOnce(whisperOk('   '))
      .mockResolvedValueOnce(chatOk('текст из гемини'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('текст из гемини');
  });
});
