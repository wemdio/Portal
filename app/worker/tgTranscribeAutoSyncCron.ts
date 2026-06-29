/**
 * One-shot cron entry for daily tg-transcribe auto-sync.
 *
 * Запускается system crontab'ом раз в сутки в 01:00 МСК (= 22:00 UTC).
 * Идея: каждый чат / подчат в tg_bot_chats должен получать новый full-scan
 * каждую ночь — портал сам подтягивает свежие видео без участия админа.
 * Уже расшифрованные сообщения скан пропускает (alreadyProcessed Set по
 * tg_video_transcripts), так что повторный прогон стоит ровно столько,
 * сколько появилось новых видео.
 *
 * Что делает:
 *   1. Берёт все строки из tg_bot_chats.
 *   2. Пропускает (chat, topic) пары, у которых уже есть pending/running
 *      job в tg_scan_jobs — на случай если предыдущий запуск ещё крутится.
 *   3. Инсертит новые tg_scan_jobs с scan_mode='full' и user_id=NULL
 *      (cron-инициированный, нет авторизованного админа).
 *   4. Выходит. Долгоживущий portal-worker-tg-transcribe сам подхватит
 *      эти джобы через свой обычный poll-loop.
 *
 * Деплой:
 *   1. Бандл собирается в /app/workers/tgTranscribeAutoSyncCron.js при сборке
 *      portal-worker:prod (см. Dockerfile.worker — этот файл добавлен в
 *      esbuild-список билдер-стейджа).
 *   2. В host crontab под root (или пользователем, который может docker):
 *
 *        0 22 * * * docker exec portal-worker-tg-transcribe node /app/workers/tgTranscribeAutoSyncCron.js >> /var/log/portal/tg-transcribe-sync.log 2>&1
 *
 *      22:00 UTC = 01:00 МСК. Контейнер уже имеет все env-переменные
 *      (Supabase ключи, TG_TARGET_*). Создать /var/log/portal/ если нет.
 *
 * Ручной прогон для теста:
 *   docker exec portal-worker-tg-transcribe node /app/workers/tgTranscribeAutoSyncCron.js
 */

import { createWorkerLogger, requireSupabaseAdmin } from './_shared';

const WORKER_ID = 'tg-transcribe-auto-sync-cron';

async function main(): Promise<number> {
  const log = createWorkerLogger(WORKER_ID);
  const db = requireSupabaseAdmin(log);

  log('info', 'Loading registered tg_bot_chats…');
  const { data: chats, error: chatsErr } = await db
    .from('tg_bot_chats')
    .select('chat_id, topic_id, title, topic_name');

  if (chatsErr) {
    log('error', `Failed to load tg_bot_chats: ${chatsErr.message}`);
    return 1;
  }
  if (!chats || chats.length === 0) {
    log('info', 'No chats registered — nothing to sync, exiting clean.');
    return 0;
  }

  log('info', `Found ${chats.length} chat/topic row(s) to consider.`);

  // Don't double-queue (chat, topic) pairs that still have a previous
  // job in flight — otherwise we'd stack scans on top of yesterday's
  // unfinished work and burn API quota.
  const { data: existingJobs, error: jobsErr } = await db
    .from('tg_scan_jobs')
    .select('tg_chat_id, topic_id')
    .in('status', ['pending', 'running']);

  if (jobsErr) {
    log('error', `Failed to load in-flight tg_scan_jobs: ${jobsErr.message}`);
    return 1;
  }

  const inFlight = new Set<string>();
  for (const j of existingJobs ?? []) {
    const tid = (j.topic_id as number | null) ?? 0;
    inFlight.add(`${j.tg_chat_id}:${tid}`);
  }

  const rowsToInsert: Array<Record<string, unknown>> = [];
  const labels: string[] = [];
  let skipped = 0;
  for (const c of chats) {
    const chatId = Number(c.chat_id);
    const topicId = (c.topic_id as number | null) ?? null;
    const key = `${chatId}:${topicId ?? 0}`;
    if (inFlight.has(key)) {
      skipped++;
      continue;
    }
    rowsToInsert.push({
      tg_chat_id: chatId,
      topic_id: topicId,
      video_count: 0,         // sentinel for full scans
      scan_mode: 'full',
      user_id: null,          // cron-initiated, no human
    });
    const label = c.topic_name
      ? `${c.title} → ${c.topic_name}`
      : (c.title as string) || `Chat ${chatId}`;
    labels.push(label);
  }

  if (rowsToInsert.length === 0) {
    log(
      'info',
      `All ${chats.length} chats already have in-flight scans — nothing new to queue.`,
    );
    return 0;
  }

  const { error: insertErr } = await db.from('tg_scan_jobs').insert(rowsToInsert);
  if (insertErr) {
    log('error', `Failed to queue scan jobs: ${insertErr.message}`);
    return 1;
  }

  log(
    'info',
    `Queued ${rowsToInsert.length} full-scan job(s) (skipped ${skipped} already in-flight). Targets: ${labels.slice(0, 10).join('; ')}${labels.length > 10 ? `; +${labels.length - 10} more` : ''}`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[worker][tg-transcribe-auto-sync-cron][FATAL]', err);
    process.exit(1);
  });
