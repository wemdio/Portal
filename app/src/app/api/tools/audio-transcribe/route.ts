import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const OPENROUTER_VIDEO_TRANSCRIPT_API_KEY = (
  process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY ?? ''
).trim();
const OPENROUTER_MODEL = 'google/gemini-2.5-flash';

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.mp4', '.avi']);
const MAX_FILE_SIZE_BYTES = 600 * 1024 * 1024; // 600 MB
const MAX_OPENROUTER_AUDIO_BYTES = 25 * 1024 * 1024; // request-size safety

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getExtension(filename: string | null): string {
  if (!filename) return '';
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}

async function readFileFromRequest(req: NextRequest): Promise<{
  ok: boolean;
  error?: string;
  filename?: string;
  bytes?: Buffer;
  ext?: string;
}> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    return { ok: false, error: 'Ожидается multipart/form-data с файлом "file"' };
  }

  // NextRequest в app router поддерживает formData()
  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, error: 'Поле "file" обязательно' };
  }

  const filename = file.name ?? 'audio';
  const ext = getExtension(filename);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: 'Неверный формат файла. Поддерживаются: MP3, WAV, MP4, AVI.',
    };
  }

  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: 'Файл превышает лимит 600 МБ.' };
  }

  return {
    ok: true,
    filename,
    bytes: Buffer.from(arrayBuffer),
    ext,
  };
}

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

  // Явный поиск в node_modules (при бандлинге __dirname из ffmpeg-static может быть неверным)
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

async function extractOrConvertToMp3(input: {
  bytes: Buffer;
  inputExt: string;
}): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-audio-'));
  const inPath = path.join(tmpDir, `in${input.inputExt || '.bin'}`);
  const outPath = path.join(tmpDir, 'out.mp3');
  try {
    await fs.writeFile(inPath, input.bytes);
    // Унифицируем: извлекаем аудио (если видео) и перекодируем в компактный mp3
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

async function callOpenRouterTranscription(input: { audioMp3: Buffer }): Promise<string> {
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

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  // Проверка, что пользователь существует (как в auto-report)
  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  let file;
  try {
    file = await readFileFromRequest(req);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Не удалось прочитать тело запроса (formData)';
    return jsonError(message, 400);
  }
  if (!file.ok || !file.bytes || !file.filename) {
    return jsonError(file.error ?? 'Неверный файл', 400);
  }

  try {
    const mp3 = await extractOrConvertToMp3({
      bytes: file.bytes,
      inputExt: file.ext ?? getExtension(file.filename),
    });
    const text = await callOpenRouterTranscription({ audioMp3: mp3 });

    // Пишем в историю последних расшифровок пользователя.
    // Требуемая таблица в Supabase (создаётся через UI/миграции):
    //   audio_transcripts (
    //     id uuid default gen_random_uuid() primary key,
    //     user_id uuid not null references profiles(id),
    //     created_at timestamptz default now(),
    //     filename text not null,
    //     length integer not null,
    //     text text not null
    //   )
    void (async () => {
      try {
        await supabase.from('audio_transcripts').insert({
          user_id: user.id,
          filename: file.filename,
          length: text.length,
          text,
        });
      } catch {
        // swallow; история не должна ломать основной поток
      }
    })();

    return NextResponse.json({
      text,
      filename: file.filename,
      length: text.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Неизвестная ошибка при расшифровке аудио';
    return jsonError(message, 500);
  }
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const { data, error } = await supabase
    .from('audio_transcripts')
    .select('id, created_at, filename, length, text')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    items: data ?? [],
  });
}

