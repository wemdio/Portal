/** @jest-environment node */

jest.mock('@/lib/transcription', () => ({
  extractOrConvertToMp3: jest.fn().mockResolvedValue(Buffer.from('mp3')),
  callOpenRouterTranscription: jest.fn().mockResolvedValue('привет как дела'),
}));

jest.mock('../../../src/lib/telegramAgent/telegram', () => ({
  downloadVoiceFile: jest.fn().mockResolvedValue(Buffer.from('ogg-data')),
}));

jest.mock('@/lib/loggerServer', () => ({
  logError: jest.fn(),
}));

import { transcribeVoiceMessage } from '@/lib/telegramAgent/voice';
import { downloadVoiceFile } from '@/lib/telegramAgent/telegram';
import { extractOrConvertToMp3, callOpenRouterTranscription } from '@/lib/transcription';

describe('telegramAgent/voice', () => {
  afterEach(() => jest.clearAllMocks());

  it('transcribes a voice message', async () => {
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBe('привет как дела');
    expect(downloadVoiceFile).toHaveBeenCalledWith('file-123');
    expect(extractOrConvertToMp3).toHaveBeenCalledWith({ bytes: expect.any(Buffer), inputExt: '.ogg' });
    expect(callOpenRouterTranscription).toHaveBeenCalled();
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

  it('returns null when transcription returns empty', async () => {
    (callOpenRouterTranscription as jest.Mock).mockResolvedValueOnce('   ');
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });

  it('returns null on transcription error', async () => {
    (extractOrConvertToMp3 as jest.Mock).mockRejectedValueOnce(new Error('ffmpeg failed'));
    const result = await transcribeVoiceMessage('file-123', 10);
    expect(result).toBeNull();
  });
});
