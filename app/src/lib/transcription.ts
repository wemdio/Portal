import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from 'undici';

const OPENROUTER_VIDEO_TRANSCRIPT_API_KEY = (
  process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY ?? ''
).trim();
const OPENROUTER_MODEL = 'policy/transcription';

const GROQ_API_KEY = (process.env.GROQ_API_KEY ?? '').trim();
// whisper-large-v3-turbo: ~190x real-time, tiny quality drop vs large-v3.
// whisper-large-v3: ~165x real-time, best quality. Override via env if needed.
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
// Hint the recognizer with the source language when we know it — saves the
// auto-detect pass and slightly improves accuracy on non-English audio.
// Empty string = auto-detect. Common values: 'ru', 'en'.
const GROQ_LANGUAGE = (process.env.GROQ_LANGUAGE ?? '').trim();
// Groq's whisper endpoint accepts up to 25 MB per request.
export const MAX_GROQ_AUDIO_BYTES = 25 * 1024 * 1024;

export const MAX_OPENROUTER_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPTION_CHUNK_SECONDS = 40 * 60;

const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

type TranscriptionProvider = 'local' | 'openrouter' | 'groq';

const TRANSCRIPTION_PROVIDER: TranscriptionProvider =
  (process.env.TRANSCRIPTION_PROVIDER as TranscriptionProvider) || 'local';

const TRANSCRIPTION_WORKER_URL =
  process.env.TRANSCRIPTION_WORKER_URL || 'http://transcribe-worker:8070';

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 180 * 60 * 1000;

const transcribeAgent = new Agent({
  headersTimeout: LOCAL_TRANSCRIBE_TIMEOUT_MS,
  bodyTimeout: LOCAL_TRANSCRIBE_TIMEOUT_MS,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 10_000,
});

type LocalProgressStage =
  | 'preparing'
  | 'queued'
  | 'converting'
  | 'transcribing'
  | 'done'
  | 'cancelled'
  | 'error';

export interface LocalTranscriptionProgress {
  jobId: string;
  stage: LocalProgressStage;
  progressPercent: number;
  processedSeconds: number | null;
  audioDurationSeconds: number | null;
  error: string | null;
  /** 1-based position in the worker's pending queue. Set only while stage='queued'. */
  queuePosition?: number;
  /** Total jobs the worker is tracking (pending + active). */
  queueTotal?: number;
  /** How many jobs are currently being transcribed (semaphore taken). */
  activeCount?: number;
}

/**
 * In-process state for stages that happen on the Next.js side BEFORE the file is
 * shipped to the transcribe-worker (upload buffer, ffmpeg conversion). Without
 * this map polling sees 404s during that whole window and the UI is stuck at
 * "Подготовка файла…" with no signal whether anything is happening.
 *
 * Caveat: portal Next.js runs in cluster mode (scripts/cluster.js spawns
 * WEB_CONCURRENCY=8 workers in prod), so this Map is per-process. POST and
 * GET requests may land on different cluster workers. Polling that misses
 * just returns "not found" → UI keeps the previous hint and retries, so it
 * degrades to "no extra info while waiting for first hit" rather than wrong
 * info. Hit rate on a random poll is ~1/N, so within ~N×1.2s the right
 * process answers and the UI updates. Good enough until/unless we add Redis.
 */
interface ServerProgressEntry {
  stage: 'preparing' | 'converting';
  progressPercent: number;
  updatedAt: number;
}
const SERVER_PROGRESS = new Map<string, ServerProgressEntry>();
const SERVER_PROGRESS_TTL_MS = 30 * 60 * 1000;

function evictStaleServerProgress(now: number): void {
  for (const [jobId, entry] of SERVER_PROGRESS.entries()) {
    if (now - entry.updatedAt > SERVER_PROGRESS_TTL_MS) {
      SERVER_PROGRESS.delete(jobId);
    }
  }
}

export function setServerSideProgress(
  jobId: string,
  stage: 'preparing' | 'converting',
  percent: number,
): void {
  if (!jobId) return;
  const now = Date.now();
  evictStaleServerProgress(now);
  SERVER_PROGRESS.set(jobId, {
    stage,
    progressPercent: Math.max(0, Math.min(100, Math.round(percent))),
    updatedAt: now,
  });
}

export function clearServerSideProgress(jobId: string): void {
  if (!jobId) return;
  SERVER_PROGRESS.delete(jobId);
}

export function getServerSideProgress(jobId: string): ServerProgressEntry | null {
  if (!jobId) return null;
  evictStaleServerProgress(Date.now());
  return SERVER_PROGRESS.get(jobId) ?? null;
}

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

/**
 * Extract audio from a video file already on disk.
 * Avoids loading the full video into memory — only the resulting MP3 is read.
 */
export async function extractMp3FromFile(inputPath: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-audio-'));
  const outPath = path.join(tmpDir, 'out.mp3');
  try {
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      outPath,
    ]);
    return await fs.readFile(outPath);
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

async function callOpenRouterTranscriptionSingle(input: { audioMp3: Buffer }): Promise<string> {
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

  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
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

/**
 * Send an mp3 to Groq's Whisper endpoint and get plain text back.
 *
 * Groq's whisper-large-v3-turbo runs at ~190x real-time on their inference
 * hardware — an hour of audio comes back in ~20 seconds, and typical
 * 20-minute call recordings finish in 5-10 s. Rate limits on the free
 * tier are 25 requests/min and 7200 audio-seconds/min. When we hit them
 * the API replies with HTTP 429 + Retry-After; we wait and retry rather
 * than surfacing an error to the user.
 */
async function callGroqTranscriptionSingle(input: {
  audioMp3: Buffer;
  filename?: string;
}): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error(
      'Сервис распознавания Groq не настроен (GROQ_API_KEY отсутствует в окружении).',
    );
  }
  if (input.audioMp3.byteLength > MAX_GROQ_AUDIO_BYTES) {
    const mb = (input.audioMp3.byteLength / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Аудио-фрагмент слишком большой для Groq (${mb} МБ, лимит 25 МБ). ` +
      'Разбейте на части через splitMp3ForTranscription.',
    );
  }

  const audioBytes = Uint8Array.from(input.audioMp3);
  const blob = new Blob([audioBytes], { type: 'audio/mpeg' });

  // On the free tier Groq caps at 7200 audio-seconds/hour ("ASPH"). A queue
  // of hour-long videos burns through the budget in minutes, and their
  // Retry-After comes back at 15-25 min. We need to actually respect that,
  // otherwise we spin, fail, and hand the file back to the scan worker for
  // no reason. Two retry knobs:
  //   - maxRetries=12 gives us ~2 h of possible wait per file, enough to
  //     ride through 2-3 rate-limit windows if the queue is deep.
  //   - retryAfterCapSeconds=1800 (30 min) trusts Groq's Retry-After hint
  //     but keeps a ceiling in case a stuck header would wedge us forever.
  const maxRetries = 12;
  const retryAfterCapSeconds = 30 * 60;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    // Rebuild the form each attempt — some fetch implementations invalidate
    // the multipart stream after the first send.
    const form = new FormData();
    form.append('file', blob, input.filename ?? 'audio.mp3');
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'json');
    if (GROQ_LANGUAGE) form.append('language', GROQ_LANGUAGE);

    let res: Response;
    try {
      res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      continue;
    }

    if (res.status === 429) {
      // Rate-limited — Groq returns Retry-After in seconds. Respect the
      // value, only cap at retryAfterCapSeconds so a broken header can't
      // freeze the worker for an hour+.
      const retryAfter = Math.min(
        Math.max(1, Number(res.headers.get('retry-after')) || 60),
        retryAfterCapSeconds,
      );
      const raw = await res.text().catch(() => '');
      lastErr = new Error(`Groq rate limited: ${raw || res.statusText}`);
      if (attempt >= maxRetries) throw lastErr;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      // 5xx: retry once with backoff; 4xx: fail fast.
      if (res.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`Groq server error (${res.status}): ${raw || res.statusText}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
        continue;
      }
      throw new Error(`Groq API (${res.status}): ${raw || res.statusText || 'unknown error'}`);
    }

    const json = JSON.parse(raw) as { text?: string };
    const text = (json.text ?? '').trim();
    if (!text) {
      throw new Error('Groq не вернул текст расшифровки');
    }
    return text;
  }
  throw lastErr instanceof Error ? lastErr : new Error('Groq transcription failed');
}

export async function callGroqTranscription(input: {
  audioMp3: Buffer;
  filename?: string;
}): Promise<string> {
  if (input.audioMp3.byteLength <= MAX_GROQ_AUDIO_BYTES) {
    return callGroqTranscriptionSingle(input);
  }
  // Long audio: split into <40-min mp3 chunks (same helper OpenRouter uses)
  // and glue the transcripts back together in order.
  const chunks = await splitMp3ForTranscription(input.audioMp3);
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const partFilename = input.filename
      ? input.filename.replace(/(\.[^.]+)$/, `-part${i + 1}$1`)
      : `audio-part${i + 1}.mp3`;
    const text = await callGroqTranscriptionSingle({
      audioMp3: chunks[i],
      filename: partFilename,
    });
    if (text) parts.push(text.trim());
  }
  const merged = parts.join('\n\n').trim();
  if (!merged) {
    throw new Error('Не удалось получить текст при расшифровке фрагментов через Groq.');
  }
  return merged;
}

async function splitMp3ForTranscription(audioMp3: Buffer): Promise<Buffer[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-audio-split-'));
  const inPath = path.join(tmpDir, 'in.mp3');
  const outPattern = path.join(tmpDir, 'chunk_%03d.mp3');
  try {
    await fs.writeFile(inPath, audioMp3);
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-f',
      'segment',
      '-segment_time',
      String(TRANSCRIPTION_CHUNK_SECONDS),
      '-c',
      'copy',
      outPattern,
    ]);
    const files = (await fs.readdir(tmpDir))
      .filter((name) => /^chunk_\d{3}\.mp3$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) {
      throw new Error('Не удалось разбить аудио на части для расшифровки.');
    }
    const chunks = await Promise.all(files.map((name) => fs.readFile(path.join(tmpDir, name))));
    return chunks;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function callOpenRouterTranscription(input: { audioMp3: Buffer }): Promise<string> {
  if (input.audioMp3.byteLength <= MAX_OPENROUTER_AUDIO_BYTES) {
    return callOpenRouterTranscriptionSingle(input);
  }
  const chunks = await splitMp3ForTranscription(input.audioMp3);
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const text = await callOpenRouterTranscriptionSingle({ audioMp3: chunks[i] });
    if (text) parts.push(text.trim());
  }
  const merged = parts.join('\n\n').trim();
  if (!merged) {
    throw new Error('Не удалось получить текст при расшифровке фрагментов аудио.');
  }
  return merged;
}

async function callLocalTranscription(input: {
  audioMp3: Buffer;
  filename?: string;
  jobId?: string;
}): Promise<string> {
  const audioBytes = Uint8Array.from(input.audioMp3);
  const blob = new Blob([audioBytes], { type: 'audio/mpeg' });
  const form = new FormData();
  form.append('file', blob, input.filename ?? 'audio.mp3');

  const res = await fetch(`${TRANSCRIPTION_WORKER_URL}/transcribe`, {
    method: 'POST',
    body: form,
    headers: input.jobId ? { 'x-transcribe-job-id': input.jobId } : undefined,
    signal: AbortSignal.timeout(LOCAL_TRANSCRIBE_TIMEOUT_MS),
    // @ts-expect-error -- undici dispatcher option; bypasses default 5-min headersTimeout
    dispatcher: transcribeAgent,
  });

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Локальный транскрибатор (${res.status}): ${raw || res.statusText}`);
  }

  const json = JSON.parse(raw) as { text?: string; audio_duration_sec?: number; processing_time_sec?: number };
  const text = (json.text ?? '').trim();
  if (!text) {
    throw new Error('Локальный транскрибатор не вернул текст расшифровки');
  }
  return text;
}

/**
 * Unified entry point: routes to the configured provider.
 *
 * TRANSCRIPTION_PROVIDER values:
 *   - "local"      → self-hosted whisper (portal-transcribe-worker)
 *   - "openrouter" → Requesty policy/transcription (fallback path)
 *   - "groq"       → Groq's Whisper Large v3 Turbo (fast, cheap, rate-limited)
 */
export async function transcribeAudio(input: { audioMp3: Buffer; filename?: string; jobId?: string }): Promise<string> {
  if (TRANSCRIPTION_PROVIDER === 'local') {
    return callLocalTranscription(input);
  }
  if (TRANSCRIPTION_PROVIDER === 'groq') {
    return callGroqTranscription({ audioMp3: input.audioMp3, filename: input.filename });
  }
  return callOpenRouterTranscription(input);
}

export async function getLocalTranscriptionProgress(jobId: string): Promise<LocalTranscriptionProgress | null> {
  if (!jobId.trim()) return null;
  if (TRANSCRIPTION_PROVIDER !== 'local') return null;

  let res: Response;
  try {
    res = await fetch(`${TRANSCRIPTION_WORKER_URL}/progress/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Worker unreachable / DNS / TCP — fall through to server-side state if any.
    res = new Response(null, { status: 404 });
  }

  if (res.status === 404) {
    // Worker hasn't seen the job yet (file still uploading / converting on the
    // Next.js side). Surface our own pre-worker stage so the UI shows progress
    // instead of treating the job as missing.
    const serverState = getServerSideProgress(jobId);
    if (serverState) {
      return {
        jobId,
        stage: serverState.stage,
        progressPercent: serverState.progressPercent,
        processedSeconds: null,
        audioDurationSeconds: null,
        error: null,
      };
    }
    return null;
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Local progress error (${res.status}): ${raw || res.statusText}`);
  }

  const json = (await res.json()) as {
    job_id?: string;
    stage?: LocalProgressStage;
    progress_percent?: number;
    processed_seconds?: number | null;
    audio_duration_seconds?: number | null;
    error?: string | null;
    queue_position?: number;
    queue_total?: number;
    active_count?: number;
  };

  return {
    jobId: json.job_id ?? jobId,
    stage: json.stage ?? 'queued',
    progressPercent: Math.max(0, Math.min(100, Number(json.progress_percent ?? 0))),
    processedSeconds:
      typeof json.processed_seconds === 'number' ? json.processed_seconds : null,
    audioDurationSeconds:
      typeof json.audio_duration_seconds === 'number' ? json.audio_duration_seconds : null,
    error: typeof json.error === 'string' ? json.error : null,
    queuePosition: typeof json.queue_position === 'number' ? json.queue_position : undefined,
    queueTotal: typeof json.queue_total === 'number' ? json.queue_total : undefined,
    activeCount: typeof json.active_count === 'number' ? json.active_count : undefined,
  };
}

export async function cancelLocalTranscription(jobId: string): Promise<{ ok: boolean; message?: string }> {
  if (!jobId.trim()) return { ok: false, message: 'jobId is required' };
  if (TRANSCRIPTION_PROVIDER !== 'local') return { ok: false, message: 'Cancel is supported only for local mode' };

  const res = await fetch(`${TRANSCRIPTION_WORKER_URL}/cancel/${encodeURIComponent(jobId)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Local cancel error (${res.status}): ${raw || res.statusText}`);
  }

  const json = (await res.json()) as { ok?: boolean; message?: string };
  return {
    ok: Boolean(json.ok),
    message: typeof json.message === 'string' ? json.message : undefined,
  };
}
