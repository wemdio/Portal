import { runOwnReplyLeadsPass } from '@/lib/ownReplyLeads/process';
import { runSenderLeadsPass, senderLeadsAi } from '@/lib/senderLeads/process';
import { leadTelegramConfig } from '@/lib/senderLeads/telegram';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

/**
 * Квалификатор ответов «Рассылки»: живые ответы → оценка ИИ → лиды в ТГ-чат;
 * лиды RU/EN автоаутрича после доставки в General передаются в AMO
 * (docs/superpowers/specs/2026-09-29-sender-reply-leads-design.md).
 *
 * Здесь же — ответы наших email-кампаний «N. Polza_…» из Instantly → оценка →
 * сделка в нашей AMO → сообщение в чат (lib/ownReplyLeads, с 11.10.2026): тот
 * же ключ ИИ и тот же бот. Блок «Instantly · X. Polza» вкладки «Квалификация».
 *
 * Отдельный воркер на 139, а не цикл в воркере Instantly: свой ключ ИИ
 * (SENDER_LEADS_AI_API_KEY — расходы на квалификацию видны отдельно) и сбой
 * здесь не трогает автопередачу Instantly. Воркер «Рассылки» живёт на
 * изолированных почтовых хостах без ключей ИИ, поэтому оценка не там.
 *
 * Настройки (правило «что считать лидом», вкл/выкл, слать ли в чат) — в базе
 * у папки рассылок; круг перечитывает их каждый раз, перезапуск не нужен.
 */

const WORKER_ID = `sender-leads-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

function envMs(name: string, fallback: number, min: number): number {
  const env = process.env[name];
  const raw = env === undefined || env === '' ? NaN : Number(env);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

const INTERVAL_MS = envMs('SENDER_LEADS_INTERVAL_MS', 60_000, 10_000);

async function main(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  // Без ключа или токена воркер не падает: так видно в логах, чего не хватает,
  // а контейнер не уходит в перезапуски.
  log('info', `Старт квалификатора ответов «Рассылки» (круг ${INTERVAL_MS} мс)`);
  if (!senderLeadsAi()) log('warn', 'SENDER_LEADS_AI_API_KEY не задан — ответы не оцениваются');
  if (!leadTelegramConfig()) log('warn', 'SENDER_LEADS_TELEGRAM_BOT_TOKEN не задан — лиды в чат не уходят');
  if (!supabaseInstantly) log('warn', 'База Instantly не настроена — ответы «N. Polza» не оцениваются');

  while (!shouldStop()) {
    try {
      const pass = await runSenderLeadsPass(db, log);
      if (pass.qualified || pass.delivered || pass.crm) {
        log('info', `Оценено ${pass.qualified}, лидов ${pass.leads}, в чат ушло ${pass.delivered}, AMO обработано ${pass.crm}`);
      }
    } catch (err) {
      log('error', 'Круг квалификатора упал', err);
    }
    // Отдельный try: сбой ответов «N. Polza» не трогает квалификацию «Рассылки» и её шаг в AMO.
    try {
      const own = await runOwnReplyLeadsPass(db, supabaseInstantly, log);
      if (own.claimed || own.qualified || own.pushed || own.delivered) {
        log('info', `X. Polza: взято ${own.claimed}, оценено ${own.qualified}, лидов ${own.leads}, в AMO ${own.pushed}, в чат ${own.delivered}`);
      }
    } catch (err) {
      log('error', 'Круг ответов «N. Polza» упал', err);
    }
    await sleep(INTERVAL_MS);
  }
  log('info', 'Воркер остановлен');
}

main().catch((err) => {
  log('error', 'Воркер упал', err);
  process.exit(1);
});
