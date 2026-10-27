import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from 'undici';
import {
  acquireGroqSlot,
  reportGroqRateLimit,
  estimateGroqWaitSeconds,
} from '@/lib/groqRateGate';

const OPENROUTER_VIDEO_TRANSCRIPT_API_KEY = (
  process.env.OPENROUTER_VIDEO_TRANSCRIPT_API_KEY ?? ''
).trim();
const OPENROUTER_MODEL = 'policy/transcription';

// Voxtral (Mistral) через Requesty — основной движок с 27.10.2026: делит
// звонок по собеседникам, ставит отметки времени и принимает словарь наших
// слов. Ключ тот же OPENROUTER_VIDEO_TRANSCRIPT_API_KEY — это ключ Requesty.
const VOXTRAL_MODEL =
  (process.env.VOXTRAL_MODEL ?? '').trim() || 'mistral/voxtral-mini-transcribe-3-0';
// Requesty принимает файл до 32 МБ; запас — на обвязку multipart.
const MAX_VOXTRAL_AUDIO_BYTES = 30 * 1024 * 1024;
// Звук сверх лимита пережимаем в 24 кбит/с: так в один запрос входит ~2,9 ч,
// и собеседники нумеруются по всему звонку сразу. Что длиннее — режем на
// куски по 2,5 ч, в каждом нумерация своя.
const VOXTRAL_SQUEEZED_BITRATE = '24k';
const VOXTRAL_CHUNK_SECONDS = 150 * 60;
const VOXTRAL_TIMEOUT_MS = 20 * 60 * 1000;
// Длинный монолог дробим на абзацы примерно такого размера, чтобы отметка
// времени встречалась чаще, чем раз в пять минут.
const TRANSCRIPT_PARAGRAPH_CHARS = 1200;

// Слова, которые модель без подсказки пишет с ошибками («вид магнит»,
// «контакты лета», «TGO3»). Дополняется без правки кода через
// TRANSCRIPTION_VOCABULARY (через запятую). Список держим коротким: звук и
// словарь вместе не должны превысить контекст модели, иначе Mistral ответит 400.
const BASE_TRANSCRIPTION_VOCABULARY = [
  'Polza Agency',
  'Польза',
  'лид',
  'лиды',
  'лид-магнит',
  'ЛПР',
  'MQL',
  'MQL-лид',
  'квалифицированный лид',
  'аутрич',
  'email-аутрич',
  'Telegram-аутрич',
  'LinkedIn-аутрич',
  'автоаутрич',
  'цепочка писем',
  'оффер',
  'бриф',
  'гипотезы',
  'соцдоказательства',
  'холодная рассылка',
  'прогрев почт',
  'Instantly',
  'LinkedIn',
  'Телемост',
  'amoCRM',
];
export const TRANSCRIPTION_VOCABULARY: readonly string[] = [
  ...new Set([
    ...BASE_TRANSCRIPTION_VOCABULARY,
    ...(process.env.TRANSCRIPTION_VOCABULARY ?? '')
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean),
  ]),
];

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

// Groq free tier: 7200 audio-seconds per rolling hour. A 60-min video sent
// as ONE request needs half of that budget free at once — the API keeps
// replying 429 until a near-empty window shows up. Splitting long audio into
// ~10-minute chunks lets each piece slip into whatever budget is currently
// free, so long videos drain the quota gradually instead of blocking on it.
const GROQ_CHUNK_SECONDS = (() => {
  const v = Number(process.env.GROQ_CHUNK_SECONDS);
  return Number.isFinite(v) && v >= 60 ? v : 600;
})();

// Opt-in hybrid mode: when the Groq queue is longer than this many minutes,
// send the file to the local faster-whisper worker instead of waiting.
// 0 / unset = disabled (local "small" model is noticeably weaker on Russian,
// so the trade-off is the user's call via env).
const GROQ_LOCAL_FALLBACK_MINUTES = (() => {
  const v = Number(process.env.GROQ_LOCAL_FALLBACK_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

// All mp3s we send to providers are produced by our own ffmpeg calls with
// "-b:a 48k" (CBR), so duration ≈ bytes * 8 / 48000. Used to book the right
// amount of Groq quota before dispatching a request.
const MP3_BITRATE_BPS = 48_000;

export function estimateMp3DurationSeconds(audioMp3: Buffer): number {
  return Math.max(1, Math.round((audioMp3.byteLength * 8) / MP3_BITRATE_BPS));
}

/**
 * "The audio contains no recognizable speech" — a PERMANENT outcome, not a
 * transient failure. Callers use it to mark the source file as processed so
 * nightly re-scans stop re-downloading and re-submitting it forever.
 */
export class NoSpeechError extends Error {
  constructor(message = 'Не удалось распознать речь в аудио (тишина или музыка без слов).') {
    super(message);
    this.name = 'NoSpeechError';
  }
}

const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

type TranscriptionProvider = 'local' | 'openrouter' | 'groq' | 'voxtral';

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

async function runFfmpeg(args: string[]): Promise<string> {
  const ff = await resolveFfmpegPath();
  if (!ff) {
    throw new Error(
      'FFmpeg не найден. Задайте FFMPEG_PATH в .env или установите ffmpeg в системе (PATH).',
    );
  }

  return new Promise<string>((resolve, reject) => {
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
      // ffmpeg writes ALL diagnostics (silencedetect stamps, Duration, etc.)
      // to stderr even on success — hand it to callers that parse it.
      if (code === 0) return resolve(stderr);
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? 'unknown'}`));
    });
  });
}

export interface AudioActivitySummary {
  durationSeconds: number;
  /** Seconds of audio louder than the silence threshold. */
  activeSeconds: number;
}

/**
 * Cheap pre-flight before burning transcription quota: decode the mp3 once
 * with ffmpeg silencedetect and measure how much of it is actually audible.
 * Runs at ~100x real time on one core. Stickers, muted screen recordings and
 * "camera on, mic off" videos come back with activeSeconds ≈ 0 — those files
 * used to go to Groq (wasting audio-seconds from the hourly budget), fail
 * with "не удалось распознать речь" and then get retried every nightly scan.
 */
export async function analyzeAudioActivity(audioMp3: Buffer): Promise<AudioActivitySummary> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-audio-vad-'));
  const inPath = path.join(tmpDir, 'in.mp3');
  try {
    await fs.writeFile(inPath, audioMp3);
    const stderr = await runFfmpeg([
      '-i',
      inPath,
      '-af',
      'silencedetect=noise=-40dB:d=2',
      '-f',
      'null',
      '-',
    ]);

    const durationSeconds = estimateMp3DurationSeconds(audioMp3);

    // Sum explicit silence intervals; an unterminated silence_start means
    // the file goes quiet until the end.
    let silence = 0;
    let openStart: number | null = null;
    const re = /silence_(start|end): ([\d.]+)(?: \| silence_duration: ([\d.]+))?/g;
    for (const m of stderr.matchAll(re)) {
      if (m[1] === 'start') {
        openStart = Number(m[2]);
      } else {
        silence += Number(m[3] ?? 0);
        openStart = null;
      }
    }
    if (openStart != null) {
      silence += Math.max(0, durationSeconds - openStart);
    }

    return {
      durationSeconds,
      activeSeconds: Math.max(0, durationSeconds - silence),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
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
  const estimateSeconds = estimateMp3DurationSeconds(input.audioMp3);

  // Every request goes through the process-wide quota gate (groqRateGate.ts):
  // it books `estimateSeconds` from the free-tier hourly budget BEFORE the
  // request goes out, so parallel pipelines queue up instead of stampeding
  // into 429s. Waiting for budget happens inside acquireGroqSlot — the retry
  // loop below only deals with genuinely unexpected failures.
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

    const slot = await acquireGroqSlot(estimateSeconds);

    let res: Response;
    try {
      res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (err) {
      slot.release({ refundQuota: true }); // nothing reached Groq's meter
      lastErr = err;
      if (attempt >= maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      continue;
    }

    if (res.status === 429) {
      // Still rate-limited despite our own accounting (another process on
      // the same key, or budget drift). Refund the booking and propagate
      // Groq's Retry-After into the gate so ALL queued requests hold off —
      // the next acquireGroqSlot call sleeps exactly as long as needed.
      const retryAfter = Math.min(
        Math.max(1, Number(res.headers.get('retry-after')) || 60),
        retryAfterCapSeconds,
      );
      const raw = await res.text().catch(() => '');
      slot.release({ refundQuota: true });
      reportGroqRateLimit(retryAfter);
      lastErr = new Error(`Groq rate limited: ${raw || res.statusText}`);
      if (attempt >= maxRetries) throw lastErr;
      continue;
    }

    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      // 5xx: request failed server-side, quota almost surely not counted.
      slot.release({ refundQuota: res.status >= 500 });
      if (res.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`Groq server error (${res.status}): ${raw || res.statusText}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
        continue;
      }
      throw new Error(`Groq API (${res.status}): ${raw || res.statusText || 'unknown error'}`);
    }

    slot.release(); // success — the booked seconds stay in the window

    const json = JSON.parse(raw) as { text?: string };
    // Empty text is a legitimate outcome for silent/music-only audio — the
    // caller aggregates chunks and decides whether the WHOLE file is
    // speechless (NoSpeechError), so don't treat one quiet chunk as a crash.
    return (json.text ?? '').trim();
  }
  throw lastErr instanceof Error ? lastErr : new Error('Groq transcription failed');
}

export async function callGroqTranscription(input: {
  audioMp3: Buffer;
  filename?: string;
  jobId?: string;
}): Promise<string> {
  const totalSeconds = estimateMp3DurationSeconds(input.audioMp3);

  // Hybrid mode (opt-in via GROQ_LOCAL_FALLBACK_MINUTES): when the Groq
  // queue+quota wait for this file is longer than the threshold, hand it to
  // the local faster-whisper worker that otherwise sits idle. Worse model,
  // but "готово через 20 минут" beats "идеально, но завтра".
  if (GROQ_LOCAL_FALLBACK_MINUTES > 0) {
    const waitSeconds = estimateGroqWaitSeconds(totalSeconds);
    if (waitSeconds > GROQ_LOCAL_FALLBACK_MINUTES * 60) {
      try {
        console.log(
          `[transcription] Groq queue ~${Math.round(waitSeconds / 60)} min for ` +
          `${input.filename ?? 'audio'} (${Math.round(totalSeconds / 60)} min audio) — ` +
          'routing to local whisper worker instead',
        );
        return await callLocalTranscription(input);
      } catch (err) {
        // Local worker down/failed — fall through to the normal Groq path.
        console.warn(
          '[transcription] Local fallback failed, falling back to Groq queue:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Fits in one request both by bytes and by quota granularity → send as is.
  // The 1.5× slack avoids silly splits like 11 min → 10 min + 1 min.
  if (
    input.audioMp3.byteLength <= MAX_GROQ_AUDIO_BYTES &&
    totalSeconds <= GROQ_CHUNK_SECONDS * 1.5
  ) {
    const text = await callGroqTranscriptionSingle(input);
    if (!text) throw new NoSpeechError();
    return text;
  }

  // Long audio: split into ~GROQ_CHUNK_SECONDS pieces. Each chunk books its
  // own slice of the hourly budget, so a 2-hour recording drains through
  // the free tier chunk by chunk instead of 429-ing as one giant request.
  const chunks = await splitMp3ForTranscription(input.audioMp3, GROQ_CHUNK_SECONDS);
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
    throw new NoSpeechError();
  }
  return merged;
}

async function splitMp3ForTranscription(
  audioMp3: Buffer,
  chunkSeconds: number = TRANSCRIPTION_CHUNK_SECONDS,
): Promise<Buffer[]> {
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
      String(chunkSeconds),
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
 * 'dialogue' — абзацы «[мм:сс] Спикер N: …» для звонков; 'plain' — сплошной
 * текст без подписей (голосовые в TG-аутриче: там один говорящий, а текст
 * уходит в промпт ИИ).
 */
export type TranscriptLayout = 'dialogue' | 'plain';

export interface TranscriptSegment {
  start: number;
  text: string;
  speaker?: string | null;
}

function formatTranscriptTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Склеивает сегменты в абзацы «[мм:сс] Спикер N: …». Новый абзац — при смене
 * собеседника и в длинном монологе примерно каждые TRANSCRIPT_PARAGRAPH_CHARS
 * знаков. Собеседники нумеруются по порядку появления; если говорит один,
 * подпись не нужна и остаются только отметки времени.
 */
export function formatTranscriptByTurns(segments: readonly TranscriptSegment[]): string {
  const numbers = new Map<string, number>();
  for (const segment of segments) {
    if (segment.speaker && !numbers.has(segment.speaker)) {
      numbers.set(segment.speaker, numbers.size + 1);
    }
  }
  const labelled = numbers.size > 1;

  type Paragraph = { speaker: string | null; start: number; parts: string[]; length: number };
  const paragraphs: string[] = [];
  const pushParagraph = (paragraph: Paragraph) => {
    const label = labelled && paragraph.speaker ? ` Спикер ${numbers.get(paragraph.speaker)}:` : '';
    paragraphs.push(`[${formatTranscriptTimestamp(paragraph.start)}]${label} ${paragraph.parts.join(' ')}`);
  };

  let current: Paragraph | null = null;
  for (const segment of segments) {
    const speaker = segment.speaker ?? null;
    if (!current || speaker !== current.speaker || current.length >= TRANSCRIPT_PARAGRAPH_CHARS) {
      if (current) pushParagraph(current);
      current = { speaker, start: segment.start, parts: [], length: 0 };
    }
    current.parts.push(segment.text);
    current.length += segment.text.length + 1;
  }
  if (current) pushParagraph(current);
  return paragraphs.join('\n\n');
}

async function recompressMp3(audioMp3: Buffer, bitrate: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-audio-squeeze-'));
  const inPath = path.join(tmpDir, 'in.mp3');
  const outPath = path.join(tmpDir, 'out.mp3');
  try {
    await fs.writeFile(inPath, audioMp3);
    await runFfmpeg(['-y', '-i', inPath, '-ac', '1', '-ar', '16000', '-b:a', bitrate, outPath]);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function callVoxtralTranscriptionSingle(input: {
  audioMp3: Buffer;
  filename?: string;
}): Promise<TranscriptSegment[]> {
  if (!OPENROUTER_VIDEO_TRANSCRIPT_API_KEY) {
    throw new Error(
      'Сервис расшифровки Voxtral не настроен (OPENROUTER_VIDEO_TRANSCRIPT_API_KEY отсутствует в окружении).',
    );
  }

  const blob = new Blob([Uint8Array.from(input.audioMp3)], { type: 'audio/mpeg' });
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Язык не передаём: Requesty отбивает language вместе с
    // timestamp_granularities (400), а без отметок времени нет и деления
    // по собеседникам. Русский модель определяет сама.
    const form = new FormData();
    form.append('file', blob, input.filename ?? 'audio.mp3');
    form.append('model', VOXTRAL_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('diarize', 'true');
    for (const term of TRANSCRIPTION_VOCABULARY) form.append('context_bias', term);

    let res: Response;
    try {
      res = await fetch('https://router.requesty.ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_VIDEO_TRANSCRIPT_API_KEY}`,
          'X-Title': 'Portal Audio Transcribe',
        },
        body: form,
        signal: AbortSignal.timeout(VOXTRAL_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      continue;
    }

    const raw = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Voxtral (${res.status}): ${raw || res.statusText}`);
      if (attempt >= maxAttempts) throw lastErr;
      await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Voxtral (${res.status}): ${raw || res.statusText || 'unknown error'}`);
    }

    const json = JSON.parse(raw) as {
      text?: string;
      segments?: Array<{ start?: number; text?: string; speaker?: string | null }>;
    };
    const segments = (json.segments ?? [])
      .map((segment) => ({
        start: Number(segment.start) || 0,
        text: (segment.text ?? '').trim(),
        speaker: segment.speaker ?? null,
      }))
      .filter((segment) => segment.text);
    if (segments.length === 0 && json.text?.trim()) {
      return [{ start: 0, text: json.text.trim(), speaker: null }];
    }
    return segments;
  }
  throw lastErr instanceof Error ? lastErr : new Error('Voxtral transcription failed');
}

export async function callVoxtralTranscription(input: {
  audioMp3: Buffer;
  filename?: string;
  layout?: TranscriptLayout;
}): Promise<string> {
  let audio = input.audioMp3;
  if (audio.byteLength > MAX_VOXTRAL_AUDIO_BYTES) {
    audio = await recompressMp3(audio, VOXTRAL_SQUEEZED_BITRATE);
  }
  const chunks = audio.byteLength > MAX_VOXTRAL_AUDIO_BYTES
    ? await splitMp3ForTranscription(audio, VOXTRAL_CHUNK_SECONDS)
    : [audio];

  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const part = await callVoxtralTranscriptionSingle({
      audioMp3: chunks[i],
      filename: chunks.length > 1 && input.filename
        ? input.filename.replace(/(\.[^.]+)$/, `-part${i + 1}$1`)
        : input.filename,
    });
    // В каждом куске Voxtral нумерует собеседников заново: помечаем кусок,
    // чтобы «speaker_1» из разных кусков не слился в одного человека.
    for (const segment of part) {
      segments.push({
        start: segment.start + i * VOXTRAL_CHUNK_SECONDS,
        text: segment.text,
        speaker: chunks.length > 1 && segment.speaker ? `${i + 1}:${segment.speaker}` : segment.speaker,
      });
    }
  }

  if (segments.length === 0) throw new NoSpeechError();
  return input.layout === 'plain'
    ? segments.map((segment) => segment.text).join(' ')
    : formatTranscriptByTurns(segments);
}

/**
 * Unified entry point: routes to the configured provider.
 *
 * TRANSCRIPTION_PROVIDER values:
 *   - "local"      → self-hosted whisper (portal-transcribe-worker)
 *   - "openrouter" → Requesty policy/transcription (fallback path)
 *   - "groq"       → Groq's Whisper Large v3 Turbo (fast, cheap, rate-limited)
 *   - "voxtral"    → Voxtral через Requesty: собеседники, отметки времени,
 *                    словарь; при любом сбое — запасной Groq (если есть ключ)
 */
export async function transcribeAudio(input: {
  audioMp3: Buffer;
  filename?: string;
  jobId?: string;
  layout?: TranscriptLayout;
}): Promise<string> {
  if (TRANSCRIPTION_PROVIDER === 'voxtral') {
    try {
      return await callVoxtralTranscription(input);
    } catch (err) {
      // Запасной путь и для «речи нет»: пустой ответ Voxtral на живой записи
      // иначе навсегда пометил бы звонок пропущенным. Тишину Groq тоже не
      // расслышит и сам выбросит NoSpeechError.
      if (!GROQ_API_KEY) throw err;
      console.warn(
        '[transcription] Voxtral failed, falling back to Groq:',
        err instanceof Error ? err.message : err,
      );
      return callGroqTranscription(input);
    }
  }
  if (TRANSCRIPTION_PROVIDER === 'local') {
    return callLocalTranscription(input);
  }
  if (TRANSCRIPTION_PROVIDER === 'groq') {
    return callGroqTranscription(input);
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
