/**
 * Ночная проверка живости клиентских отправляющих ящиков.
 *
 * Зачем отдельная задача. Пароль приложения Google отзывается при ЛЮБОЙ смене
 * пароля пользователя, включая принудительный сброс админом домена. Отправка
 * после этого встаёт МОЛЧА: провайдер просто перестаёт слать с этого ящика.
 * Без проверки клиент узнаёт об этом по отсутствию ответов через неделю и
 * приходит с «у меня всё сломалось, я ничего не делал».
 *
 * Что делает: берёт зарегистрированные ящики (самые давно не проверенные
 * первыми), спрашивает у провайдера их состояние, пишет итог в БД и шлёт
 * алерт по ящикам, которые только что отвалились.
 *
 * Запуск: node dist/workers/mailboxHealthCron.js (крон на 139).
 */

import { createClient } from '@supabase/supabase-js';
import { checkMailboxVitals } from '../src/lib/byoMailbox/sendingProvider';

const BATCH = Number(process.env.MAILBOX_HEALTH_BATCH) || 50;

function log(level: 'info' | 'error', msg: string) {
  process.stdout.write(`${new Date().toISOString()} [${level}] mailbox-health: ${msg}\n`);
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from('client_mailbox_accounts')
    .select('id, email, client_user_id, instantly_vitals')
    .eq('instantly_status', 'registered')
    .order('instantly_checked_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) throw new Error(`чтение ящиков: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) {
    log('info', 'зарегистрированных ящиков нет, проверять нечего');
    return;
  }

  const vitals = await checkMailboxVitals(rows.map((r) => r.email as string));
  const nowIso = new Date().toISOString();
  const justDied: Array<{ email: string; clientUserId: string; detail: string }> = [];

  for (const row of rows) {
    const email = String(row.email);
    const v = vitals.get(email.toLowerCase());
    if (!v) continue;

    // Алертим только ПЕРЕХОД в мёртвое состояние: иначе каждую ночь будет
    // приходить одно и то же письмо про один и тот же отвалившийся ящик.
    const wasAlive = !String(row.instantly_vitals ?? '').startsWith('dead:');
    if (!v.alive && wasAlive) {
      justDied.push({ email, clientUserId: String(row.client_user_id), detail: v.detail });
    }

    await db
      .from('client_mailbox_accounts')
      .update({
        instantly_checked_at: nowIso,
        instantly_vitals: v.alive ? `ok: ${v.detail}`.slice(0, 300) : `dead: ${v.detail}`.slice(0, 300),
      })
      .eq('id', row.id as string);
  }

  log('info', `проверено ${rows.length}, отвалилось за эту ночь ${justDied.length}`);
  for (const d of justDied) {
    log('error', `ящик отвалился: ${d.email} (клиент ${d.clientUserId}) — ${d.detail}`);
  }

  // Уведомление клиента вешается на этот же список: письмо ушло бы «в никуда»,
  // если слать его на тот же отвалившийся ящик, поэтому канал — кабинет и TG,
  // как у остальных клиентских алертов. Ставится отдельным шагом, когда будет
  // решено, кому именно писать: клиенту или его менеджеру.
}

main().catch((e) => {
  log('error', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
