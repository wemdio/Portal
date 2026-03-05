import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OPENROUTER_VIDEO_TRANSCRIPT_API_KEY = (
  process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY ?? ''
).trim();
const OPENROUTER_MODEL = 'google/gemini-2.5-flash';

export const MAX_OPENROUTER_AUDIO_BYTES = 25 * 1024 * 1024;

const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/**
 * Локально (npm run dev): ffmpeg-static или явные пути node_modules; иначе PATH или FFMPEG_PATH в .env.
 * В Docker: в образе установлен ffmpeg (apk add ffmpeg), используется системный бинарник.
 */
async function resolveFfmpegPath(): Promise<string> {
  const envPath = process.env.FFMPEG_PATH?.trim();
  if (envPath) return envPath;

  const staticPath = typeof ffmpegPath === 'string' ? ffmpegPath : null;
  if (staticPath) {
    try {
      await fs.access(staticPath);
      return staticPath;
    } catch {
      // ffmpeg-static path wrong after bundling (e.g. Turbopack/Next)
    }
  }

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'node_modules', 'ffmpeg-static', FFMPEG_EXE),
    path.join(cwd, 'app', 'node_modules', 'ffmpeg-static', FFMPEG_EXE),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* skip */
    }
  }

  return 'ffmpeg';
}

async function runFfmpeg(args: string[]): Promise<void> {
  const ff = await resolveFfmpegPath();
  if (!ff) {
    throw new Error(
      'FFmpeg не найден. Задайте FFMPEG_PATH в .env или установите ffmpeg в системе (PATH).',
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ff, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'FFmpeg не найден. Установите ffmpeg (https://ffmpeg.org) и добавьте в PATH либо укажите путь в переменной окружения FFMPEG_PATH.',
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function extractOrConvertToMp3(input: {
  bytes: Buffer;
  inputExt: string;
}): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-audio-'));
  const inPath = path.join(tmpDir, `in${input.inputExt || '.bin'}`);
  const outPath = path.join(tmpDir, 'out.mp3');
  try {
    await fs.writeFile(inPath, input.bytes);
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      outPath,
    ]);
    const mp3 = await fs.readFile(outPath);
    return mp3;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractTextFromOpenRouterContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content as Array<Record<string, unknown>>;
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  return texts.join('');
}

export async function callOpenRouterTranscription(input: { audioMp3: Buffer }): Promise<string> {
  if (!OPENROUTER_VIDEO_TRANSCRIPT_API_KEY) {
    throw new Error(
      'Сервис расшифровки не настроен (OPENROUTER_VIDEO_TRANSCRIPT_API_KEY отсутствует в окружении).',
    );
  }

  if (input.audioMp3.byteLength > MAX_OPENROUTER_AUDIO_BYTES) {
    const mb = (input.audioMp3.byteLength / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Аудио после конвертации слишком большое для отправки (${mb} МБ). Укоротите запись или сожмите видео.`,
    );
  }

  const base64 = input.audioMp3.toString('base64');
  const prompt =
    'Transcribe the provided audio into plain text. Output ONLY the transcript (no markdown). ' +
    'Preserve punctuation, numbers, and proper names. Language: auto-detect; if Russian is present, output Russian text.';

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_VIDEO_TRANSCRIPT_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Portal Audio Transcribe',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio',
              input_audio: { data: base64, format: 'mp3' },
            },
          ],
        },
      ],
    }),
  });

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Ошибка OpenRouter (${res.status}): ${raw || res.statusText || 'unknown error'}`);
  }

  const json = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: unknown;
  };

  const content = json.choices?.[0]?.message?.content;
  const text = extractTextFromOpenRouterContent(content).trim();
  if (!text) {
    throw new Error('OpenRouter не вернул текст расшифровки');
  }
  return text;
}
