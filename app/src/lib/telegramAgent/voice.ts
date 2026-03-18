import { extractOrConvertToMp3 } from '@/lib/transcription';
import { downloadVoiceFile } from './telegram';
import { logError, logAudit } from '@/lib/loggerServer';

const MAX_DURATION_SECONDS = 300;

function getAgentApiKey(): string {
  return (process.env.OPENROUTER_AGENT_API_KEY ?? '').trim();
}

async function whisperTranscribe(mp3: Buffer): Promise<string | null> {
  const apiKey = getAgentApiKey();
  if (!apiKey) return null;

  const blob = new Blob([mp3], { type: 'audio/mpeg' });
  const form = new FormData();
  form.append('file', blob, 'voice.mp3');
  form.append('model', 'openai/whisper-large-v3');
  form.append('language', 'ru');

  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    await logError('telegram-agent.voice.whisper-error', new Error(`Whisper ${res.status}: ${raw}`));
    return null;
  }

  const json = (await res.json()) as { text?: string };
  return json.text?.trim() || null;
}

async function chatCompletionTranscribe(mp3: Buffer): Promise<string | null> {
  const apiKey = (process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY ?? '').trim()
    || getAgentApiKey();
  if (!apiKey) return null;

  const base64 = mp3.toString('base64');
  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'policy/transcription',
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe this Russian voice message. Output ONLY the exact transcript in Russian. No commentary, no formatting.',
          },
          { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } },
        ],
      }],
    }),
  });

  if (!res.ok) return null;

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
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

export async function transcribeVoiceMessage(
  fileId: string,
  duration: number,
): Promise<string | null> {
  if (duration > MAX_DURATION_SECONDS) return null;

  try {
    const oggBuffer = await downloadVoiceFile(fileId);
    if (!oggBuffer) return null;

    const mp3 = await extractOrConvertToMp3({ bytes: oggBuffer, inputExt: '.ogg' });

    const whisperResult = await whisperTranscribe(mp3);
    if (whisperResult) {
      await logAudit('telegram-agent.voice.transcribed', `Whisper: ${whisperResult.length} chars`, {});
      return whisperResult;
    }

    const fallbackResult = await chatCompletionTranscribe(mp3);
    if (fallbackResult) {
      await logAudit('telegram-agent.voice.transcribed', `Fallback: ${fallbackResult.length} chars`, {});
      return fallbackResult;
    }

    return null;
  } catch (err) {
    await logError('telegram-agent.voice.transcribe-failed', err);
    return null;
  }
}
