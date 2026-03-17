import { extractOrConvertToMp3, transcribeAudio } from '@/lib/transcription';
import { downloadVoiceFile } from './telegram';
import { logError } from '@/lib/loggerServer';

const MAX_DURATION_SECONDS = 300; // 5 minutes

export async function transcribeVoiceMessage(
  fileId: string,
  duration: number,
): Promise<string | null> {
  if (duration > MAX_DURATION_SECONDS) return null;

  try {
    const oggBuffer = await downloadVoiceFile(fileId);
    if (!oggBuffer) return null;

    const mp3 = await extractOrConvertToMp3({ bytes: oggBuffer, inputExt: '.ogg' });
    const text = await transcribeAudio({ audioMp3: mp3, filename: 'voice.ogg' });
    return text?.trim() || null;
  } catch (err) {
    await logError('telegram-agent.voice.transcribe-failed', err);
    return null;
  }
}
