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

function whisperFail() {
  return new Response('error', { status: 500 });
}

function chatOk(text: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
    { status: 200 },
  );
}

describe('telegramAgent/voice', () => {
  beforeEach(() => {
    process.env.OPENROUTER_AGENT_API_KEY = 'test-key';
    process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY = 'test-video-key';
  });

  afterEach(() => jest.clearAllMocks());

  it('transcribes via Whisper API (primary)', async () => {
    mockFetch.mockResolvedValueOnce(whisperOk('привет как дела'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('привет как дела');
    expect(downloadVoiceFile).toHaveBeenCalledWith('file-123');
    expect(extractOrConvertToMp3).toHaveBeenCalledWith({ bytes: expect.any(Buffer), inputExt: '.ogg' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/audio/transcriptions');
  });

  it('falls back to chat completions if Whisper fails', async () => {
    mockFetch
      .mockResolvedValueOnce(whisperFail())
      .mockResolvedValueOnce(chatOk('результат из фоллбека'));

    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('результат из фоллбека');
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

  it('returns null when both methods return empty', async () => {
    mockFetch
      .mockResolvedValueOnce(whisperOk('   '))
      .mockResolvedValueOnce(chatOk(''));

    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });

  it('returns null on conversion error', async () => {
    (extractOrConvertToMp3 as jest.Mock).mockRejectedValueOnce(new Error('ffmpeg failed'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });
});
