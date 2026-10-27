import { runOutreachOsLeadsPass } from '@/lib/outreachOsLeads/process';
import { runOwnReplyLeadsPass } from '@/lib/ownReplyLeads/process';
import { runSenderLeadsPass, senderLeadsAi, SENDER_LEADS_RECOVERY_INTERVAL_MS } from '@/lib/senderLeads/process';
import { runSenderProjectLeadCardsPass } from '@/lib/senderLeads/projectLeadCards';
import { leadTelegramConfig } from '@/lib/senderLeads/telegram';
import { runAgencyLeadHandoffs } from '@/lib/agencyLeadHandoff/process';
import { recordSenderHandoffs } from '@/lib/sender/clientHandoff';
import { syncSenderStopLists } from '@/lib/sender/stopLists';
import { syncInstantlyMailboxNames } from '@/lib/sender/instantlyNameSync';
import { BackgroundLane } from '@/lib/sender/backgroundLane';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

/**
 * Квалификатор ответов «Рассылки»: живые ответы → оценка ИИ → лиды в ТГ-чат;
 * лиды RU/EN автоаутрича после доставки в General передаются в AMO
 * (docs/superpowers/specs/2026-09-29-sender-reply-leads-design.md).
 *
 * Здесь же — заявки OutreachOS (lib/outreachOsLeads, с 16.10.2026): лиды
 * кабинета и регистрации → сделка в AMO → General со ссылкой на сделку.
 *
 * И ответы наших email-кампаний «N. Polza_…» из Instantly → оценка →
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
// Сверка живых кампаний «Рассылки» со стоп-листами клиента и проекта: адрес,
// закрытый после заливки, снимается не позже чем через этот срок.
const STOPLIST_SYNC_INTERVAL_MS = envMs('SENDER_STOPLIST_SYNC_INTERVAL_MS', 5 * 60_000, 60_000);
// Ключи Instantly остаются на центральном воркере: почтовые хосты читают уже
// сохранённое имя из sender_mailboxes, без доступа к внешнему API.
const NAME_SYNC_INTERVAL_MS = envMs('SENDER_NAME_SYNC_INTERVAL_MS', 15 * 60_000, 60_000);
const NAME_SYNC_DRAIN_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  // Первый обход — сразу после старта. Расписание каждой повторной попытки
  // хранится в БД, поэтому redeploy не обнуляет час ожидания после ошибки.
  let nextRecoveryAt = 0;
  let nextStopListSyncAt = 0;

  // Без ключа или токена воркер не падает: так видно в логах, чего не хватает,
  // а контейнер не уходит в перезапуски.
  log('info', `Старт квалификатора ответов «Рассылки» (круг ${INTERVAL_MS} мс)`);
  if (!senderLeadsAi()) log('warn', 'SENDER_LEADS_AI_API_KEY не задан — ответы не оцениваются');
  if (!leadTelegramConfig()) log('warn', 'SENDER_LEADS_TELEGRAM_BOT_TOKEN не задан — лиды в чат не уходят');
  if (!supabaseInstantly) log('warn', 'База Instantly не настроена — ответы «N. Polza» не оцениваются');

  // Отдельная дорожка и таймер: долгий проход квалификатора не задерживает
  // имена, а медленный Instantly не задерживает ответы и передачи лидов.
  const nameSyncLane = new BackgroundLane('Имена отправителей Instantly', NAME_SYNC_INTERVAL_MS, log);
  const kickNameSync = () => {
    if (shouldStop()) return;
    nameSyncLane.kick(async () => {
      const sync = await syncInstantlyMailboxNames({ db, log });
      if (sync.updated || sync.conflicts || sync.failed) {
        log(sync.conflicts || sync.failed ? 'warn' : 'info',
          `Имена отправителей Instantly: обновлено ${sync.updated}, совпадений ${sync.matched}, конфликтов ${sync.conflicts}, ошибок ${sync.failed}`);
      }
    });
  };
  kickNameSync();
  // Дорожка сама соблюдает интервал; минутный тик не переполняет setInterval
  // даже при большом значении SENDER_NAME_SYNC_INTERVAL_MS.
  const nameSyncTimer = setInterval(kickNameSync, 60_000);
  nameSyncTimer.unref();

  try {
    while (!shouldStop()) {
      try {
        const recoverErrors = Date.now() >= nextRecoveryAt;
        const pass = await runSenderLeadsPass(db, log, recoverErrors);
        if (recoverErrors && !pass.recoveryHasMore) nextRecoveryAt = Date.now() + SENDER_LEADS_RECOVERY_INTERVAL_MS;
        if (pass.qualified || pass.delivered || pass.crm) {
          log('info', `Оценено ${pass.qualified}, лидов ${pass.leads}, в чат ушло ${pass.delivered}, AMO обработано ${pass.crm}`);
        }
        if (pass.ai.started || pass.ai.letters || pass.ai.closed) {
          log('info', `ИИ-квалификатор: начато ${pass.ai.started}, писем ${pass.ai.letters}, передано ${pass.ai.handedOff}, закрыто ${pass.ai.closed}`);
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
      // Agency email replies: only API/queue work here; SMTP stays on isolated sender hosts.
      try {
        await runAgencyLeadHandoffs(db, log);
      } catch (err) {
        log('error', 'Передача лидов по email упала', err);
      }
      // Стоп-листы клиента и проекта: базу Instantly видит только этот воркер, не
      // почтовые хосты, поэтому сверка здесь, а планировщик читает её итог —
      // стоп-лист кампании.
      if (Date.now() >= nextStopListSyncAt) {
        nextStopListSyncAt = Date.now() + STOPLIST_SYNC_INTERVAL_MS;
        try {
          const sync = await syncSenderStopLists({ db, instantlyDb: supabaseInstantly, log });
          if (sync.stopped) log('info', `Стоп-листы клиента и проекта: снято получателей ${sync.stopped} в ${sync.campaigns} кампаниях`);
        } catch (err) {
          log('error', 'Сверка стоп-листов клиента и проекта упала', err);
        }
      }
      // Передачи лида из «Рассылки»: письмо ушло — лид в кабинет клиента.
      // Почтовые хосты базу Instantly не видят, поэтому запись здесь.
      try {
        const recorded = await recordSenderHandoffs({ db, instantlyDb: supabaseInstantly, log });
        if (recorded) log('info', `Передачи «Рассылки»: в кабинет клиента записано лидов ${recorded}`);
      } catch (err) {
        log('error', 'Запись передач «Рассылки» в кабинет клиента упала', err);
      }
      // Лиды кампаний Движка вертикалей: карточка специалисту проекта, доска
      // лидов, передача клиенту. После записи передач — чтобы видеть ушедшие.
      try {
        const cards = await runSenderProjectLeadCardsPass({ db, instantlyDb: supabaseInstantly, log });
        if (cards.created || cards.delivered || cards.events) {
          log('info', `Лиды проектов «Рассылки»: заведено карточек ${cards.created}, доставлено ${cards.delivered}, шагов ${cards.events}`);
        }
      } catch (err) {
        log('error', 'Круг карточек лидов проектов «Рассылки» упал', err);
      }
      // Заявки OutreachOS (лиды кабинета, регистрации) → AMO → General со ссылкой на сделку.
      try {
        const oos = await runOutreachOsLeadsPass(db, log);
        if (oos.pushed || oos.delivered) log('info', `OutreachOS: в AMO ${oos.pushed}, в чат ${oos.delivered}`);
      } catch (err) {
        log('error', 'Круг заявок OutreachOS упал', err);
      }
      if (!shouldStop()) await sleep(INTERVAL_MS);
    }
  } finally {
    clearInterval(nameSyncTimer);
    if (!(await nameSyncLane.drain(NAME_SYNC_DRAIN_TIMEOUT_MS))) {
      log('warn', 'Синхронизация имён не закончилась за минуту — останавливаюсь без ожидания её итога');
    }
  }
  log('info', 'Воркер остановлен');
}

main().catch((err) => {
  log('error', 'Воркер упал', err);
  process.exit(1);
});
