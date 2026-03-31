import { extractOrConvertToMp3 } from '@/lib/transcription';
import { downloadVoiceFile } from './telegram';
import { logError, logAudit } from '@/lib/loggerServer';

const MAX_DURATION_SECONDS = 300;
const FETCH_TIMEOUT_MS = 30_000;
const REQUESTY_BASE = 'https://router.requesty.ai/v1';
const TRANSCRIBE_MODEL = 'openai/gpt-4o-mini-transcribe';

function getTranscriptApiKey(): string {
  return (process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY ?? '').trim()
    || (process.env.OPENROUTER_AGENT_API_KEY ?? '').trim();
}

async function asrTranscribe(mp3: Buffer): Promise<string | null> {
  const apiKey = getTranscriptApiKey();
  if (!apiKey) return null;

  const blob = new Blob([Uint8Array.from(mp3)], { type: 'audio/mpeg' });
  const form = new FormData();
  form.append('file', blob, 'voice.mp3');
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'ru');

  const res = await fetch(`${REQUESTY_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: form,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    await logAudit('telegram-agent.voice.asr-fail', `${res.status}: ${raw.slice(0, 200)}`, {});
    return null;
  }

  const json = (await res.json()) as { text?: string };
  return json.text?.trim() || null;
}

function extractText(json: { choices?: Array<{ message?: { content?: unknown } }> }): string | null {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
      .trim() || null;
  }
  return null;
}

async function chatTranscribe(mp3: Buffer): Promise<string | null> {
  const apiKey = getTranscriptApiKey();
  if (!apiKey) return null;

  const base64 = mp3.toString('base64');
  const res = await fetch(`${REQUESTY_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: 'policy/transcription',
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe the provided audio into plain text. Output ONLY the transcript. '
              + 'Preserve punctuation, numbers, and proper names. Language: Russian.',
          },
          { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    await logAudit('telegram-agent.voice.chat-fail', `${res.status}: ${raw.slice(0, 200)}`, {});
    return null;
  }

  return extractText(await res.json());
}

export async function transcribeVoiceMessage(
  fileId: string,
  duration: number,
): Promise<string | null> {
  if (duration > MAX_DURATION_SECONDS) return null;

  try {
    let oggBuffer: Buffer | null;
    try {
      oggBuffer = await downloadVoiceFile(fileId);
    } catch (dlErr) {
      await logError('telegram-agent.voice.download-error', dlErr);
      return null;
    }
    if (!oggBuffer) {
      await logAudit('telegram-agent.voice.download-fail', `fileId=${fileId}`, {});
      return null;
    }

    let mp3: Buffer;
    try {
      mp3 = await extractOrConvertToMp3({ bytes: oggBuffer, inputExt: '.ogg' });
    } catch (err) {
      await logError('telegram-agent.voice.ffmpeg-fail', err);
      return null;
    }

    await logAudit('telegram-agent.voice.converted', `ogg=${oggBuffer.length}b mp3=${mp3.length}b dur=${duration}s`, {});

    const methods = [asrTranscribe, chatTranscribe] as const;
    const names = ['asr', 'chat'] as const;

    for (let i = 0; i < methods.length; i++) {
      try {
        const result = await methods[i](mp3);
        if (result) {
          await logAudit('telegram-agent.voice.transcribed', `${names[i]}: ${result.length} chars`, {});
          return result;
        }
      } catch (err) {
        await logError(`telegram-agent.voice.${names[i]}-error`, err);
      }
    }

    await logAudit('telegram-agent.voice.all-methods-failed', `fileId=${fileId} dur=${duration}s`, {});
    return null;
  } catch (err) {
    await logError('telegram-agent.voice.transcribe-failed', err);
    return null;
  }
}
