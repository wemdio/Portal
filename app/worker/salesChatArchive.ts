/**
 * Воркер архивации sales-chat диалогов.
 *
 * Поллит `sales_chat_archive_jobs.status='pending'` и по каждому заданию:
 *   1) забирает список диалогов аккаунта,
 *   2) собирает DOCX по каждому диалогу (общая либа `dialogDocx`),
 *   3) стримит их в ZIP-архив, который параллельно multipart-загружается в S3,
 *   4) после каждого диалога обновляет `dialogs_done` — для прогресс-бара в UI,
 *   5) по завершении пишет `s3_key`, `file_size_bytes`, `status='done'`,
 *      на ошибке — `error_message`, `status='error'`.
 *
 * Параллельные задания на один аккаунт не плодятся (БД-индекс
 * `idx_sales_chat_archive_jobs_one_active`).
 */

import { PassThrough } from 'node:stream';

import archiver from 'archiver';
import { uploadMainS3Stream } from '@/lib/mainS3Server';
import {
  buildDialogDocx,
  fetchDialogAttachments,
  fetchDialogMessages,
  sanitizeFilename,
  type DialogRow,
} from '@/lib/salesChatAnalyzer/dialogDocx';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const WORKER_ID = `sales-chat-archive-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

interface ArchiveJob {
  id: string;
  account_id: string;
}

/** Возвращает 'running' жобы в 'pending' — рестарт воркера их не теряет. */
async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data, error } = await db
    .from('sales_chat_archive_jobs')
    .update({ status: 'pending', started_at: null, dialogs_done: 0 })
    .eq('status', 'running')
    .select('id');
  if (error) log('warn', 'startupRecovery failed', error);
  else if (data?.length) log('info', `Reset ${data.length} stuck running job(s) to pending`);
}

/** Атомарно забирает одно pending-задание. */
async function claimJob(): Promise<ArchiveJob | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('sales_chat_archive_jobs')
    .select('id, account_id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('sales_chat_archive_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), dialogs_done: 0 })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, account_id')
    .maybeSingle();
  return (claimed as ArchiveJob) ?? null;
}

/** Все диалоги аккаунта, в обратном хронологическом порядке (как в UI). */
async function fetchAccountDialogs(accountId: string): Promise<DialogRow[]> {
  const db = requireSupabaseAdmin(log);
  const PAGE = 500;
  const out: DialogRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('sales_chat_dialogs')
      .select('id, tg_peer_id, peer_title, peer_username')
      .eq('account_id', accountId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as DialogRow[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function runJob(job: ArchiveJob): Promise<void> {
  const db = requireSupabaseAdmin(log);
  log('info', `Archive job ${job.id} (account ${job.account_id})`);

  const dialogs = await fetchAccountDialogs(job.account_id);
  await db
    .from('sales_chat_archive_jobs')
    .update({ dialogs_total: dialogs.length })
    .eq('id', job.id);
  log('info', `Job ${job.id}: ${dialogs.length} dialogs to process`);

  if (dialogs.length === 0) {
    await db
      .from('sales_chat_archive_jobs')
      .update({
        status: 'error',
        error_message: 'У аккаунта нет диалогов для архивирования.',
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    return;
  }

  const s3Key = `sales-chat-analyzer/archives/${job.account_id}/${job.id}.zip`;

  // store: true — без сжатия. DOCX это уже ZIP-контейнер, повторная компрессия
  // даёт ~0% выигрыша и тратит CPU. Архив получается ровно сумма docx.
  const archive = archiver('zip', { store: true });
  archive.on('warning', (err: Error & { code?: string }) => {
    log('warn', `[zip warn] ${err.message}`, err);
  });

  // ВАЖНО: archiver@7 экстендит `readable-stream` (npm-пакет), а не нативный
  // `node:stream` — `@aws-sdk/lib-storage` Upload делает `instanceof Readable`
  // от node:stream и НЕ узнаёт archiver-Transform, кидая «Body Data is
  // unsupported format». Пропускаем через нативный PassThrough — он валидный
  // node:stream.Readable, SDK его принимает.
  const body = new PassThrough();
  archive.pipe(body);
  archive.on('error', (err) => body.destroy(err));

  // Стартуем S3-стрим заранее — Upload читает body по мере поступления.
  const uploadPromise = uploadMainS3Stream({
    key: s3Key,
    body,
    contentType: 'application/zip',
  });

  const usedNames = new Set<string>();
  let kept = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < dialogs.length; i++) {
      const dialog = dialogs[i];
      const [messages, attachments] = await Promise.all([
        fetchDialogMessages(db, dialog.id),
        fetchDialogAttachments(db, dialog.id),
      ]);

      if (messages.length === 0) {
        skipped += 1;
      } else {
        const buf = await buildDialogDocx({ dialog, messages, attachments });

        // Имя внутри ZIP: NNNN · peer_title · 8 первых символов dialog_id.
        // Индекс задаёт сортировку (как в UI — свежие сверху), shortId
        // защищает от коллизий «Александр × N».
        const baseTitle = dialog.peer_title?.trim() || dialog.peer_username?.trim() || `dialog_${dialog.tg_peer_id}`;
        const idx = String(i + 1).padStart(4, '0');
        const shortId = dialog.id.slice(0, 8);
        let name = sanitizeFilename(`${idx} · ${baseTitle} · ${shortId}.docx`);
        while (usedNames.has(name)) name = `${name.slice(0, -5)} (dup).docx`;
        usedNames.add(name);

        archive.append(buf, { name });
        kept += 1;
      }

      // Прогресс — после каждого диалога. ~1645 апдейтов на жоб у Егора —
      // не много, БД переживёт; UI получает плавную полосу.
      await db
        .from('sales_chat_archive_jobs')
        .update({ dialogs_done: i + 1 })
        .eq('id', job.id);
    }
  } catch (err) {
    archive.abort();
    throw err;
  }

  await archive.finalize();
  const uploadResult = await uploadPromise;
  log('info', `Job ${job.id}: zip uploaded kept=${kept} skipped=${skipped} size=${uploadResult.size}`);

  await db
    .from('sales_chat_archive_jobs')
    .update({
      status: 'done',
      s3_bucket: uploadResult.bucket,
      s3_key: uploadResult.key,
      file_size_bytes: uploadResult.size,
      finished_at: new Date().toISOString(),
    })
    .eq('id', job.id);
}

async function pollOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  try {
    await runJob(job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Archive job ${job.id} crashed`, err);
    await requireSupabaseAdmin(log)
      .from('sales_chat_archive_jobs')
      .update({
        status: 'error',
        error_message: msg.slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  }
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting Sales Chat archive worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  await startupRecovery();

  const shouldStop = setupGracefulShutdown(log);
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['sales_chat_archive_jobs'],
  });
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
