import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { extractOrConvertToMp3, callOpenRouterTranscription } from '@/lib/transcription';
import { startTrace } from '@/lib/tracer';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.mp4', '.avi']);
const MAX_FILE_SIZE_BYTES = 600 * 1024 * 1024; // 600 MB

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getExtension(filename: string | null): string {
  if (!filename) return '';
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
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

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = getIp(req);
  const logMeta = { userId: user.id, requestId, route, ip };
  let trace: Awaited<ReturnType<typeof startTrace>> | null = await startTrace({
    name: 'audio_transcribe.process',
    input: { requestId, route, ip, userId: user.id },
    message: 'Запуск расшифровки аудио/видео',
    userId: user.id,
  });

  let file;
  try {
    file = await readFileFromRequest(req);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Не удалось прочитать тело запроса (formData)';
    await trace?.fail(err, { stage: 'read_form_data' });
    await logError('audio.transcribe.read.failed', err, { stage: 'read_form_data' }, logMeta);
    return jsonError(message, 400);
  }
  if (!file.ok || !file.bytes || !file.filename) {
    const message = file.error ?? 'Неверный файл';
    const err = new Error(message);
    await trace?.fail(err, { stage: 'validate_file' });
    await logError(
      'audio.transcribe.validation.failed',
      err,
      { stage: 'validate_file' },
      logMeta,
    );
    return jsonError(message, 400);
  }

  try {
    await logInfo(
      'audio.transcribe.start',
      'Audio transcription started',
      { filename: file.filename, inputBytes: file.bytes.byteLength, extension: file.ext ?? null },
      logMeta,
    );
    const mp3 = await extractOrConvertToMp3({
      bytes: file.bytes,
      inputExt: file.ext ?? getExtension(file.filename),
    });
    await trace?.setOutput({
      filename: file.filename,
      inputBytes: file.bytes.byteLength,
      mp3Bytes: mp3.byteLength,
    });
    const text = await callOpenRouterTranscription({ audioMp3: mp3 });

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

    await trace?.end(
      {
        filename: file.filename,
        inputBytes: file.bytes.byteLength,
        mp3Bytes: mp3.byteLength,
        textLength: text.length,
      },
      'Расшифровка завершена',
    );
    await logInfo(
      'audio.transcribe.success',
      'Audio transcription completed',
      {
        filename: file.filename,
        inputBytes: file.bytes.byteLength,
        mp3Bytes: mp3.byteLength,
        textLength: text.length,
      },
      logMeta,
    );

    return NextResponse.json({
      text,
      filename: file.filename,
      length: text.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Неизвестная ошибка при расшифровке аудио';
    await trace?.fail(err, {
      stage: 'transcribe',
      filename: file.filename,
      inputBytes: file.bytes.byteLength,
    });
    await logError(
      'audio.transcribe.failed',
      err,
      {
        stage: 'transcribe',
        filename: file.filename,
        inputBytes: file.bytes.byteLength,
      },
      logMeta,
    );
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
