/**
 * Напоминания о продлении технички.
 *
 * Живёт в том же десятиминутном прогоне, что и дедлайны: отдельный крон ради
 * одной выборки — лишняя движущаяся часть, которую пришлось бы отдельно
 * заводить в воркере и в Vercel.
 *
 * Два повода на цикл: `soon` — за три дня до списания, `due` — в день списания
 * и позже. Порог короче семидневного жёлтого статуса намеренно: экран
 * подсвечивает заранее, звенит портал ближе к дате.
 *
 * Уведомление ничем не гасится, кроме прочтения. Продление сервиса старые
 * уведомления не трогает: «уже кто-то продлил» знает только тот, кто продлил,
 * а остальные админы должны увидеть новость, а не пустой колокольчик.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { addDays, daysUntil, mskDateStr } from '@/lib/techCalendar/dates';
import { formatMoney } from '@/lib/techCalendar/money';
import { refreshPendingReview } from '@/lib/techCalendar/pending';
import type { Currency } from '@/lib/techCalendar/types';

export const RENEWAL_NOTIFY_DAYS = 3;

type Level = 'soon' | 'due';

export interface TechRenewalDeps {
  db: SupabaseClient;
  now: Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

export interface TechRenewalResult {
  processed: number;
  created: number;
}

interface SubRow {
  id: string;
  service_name: string;
  amount: number;
  currency: Currency;
  next_billing_date: string;
  status: string;
}

interface LogRow {
  subscription_id: string;
  billing_date: string;
  level: string;
}

function formatDay(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

function buildContent(sub: SubRow, level: Level): { title: string; body: string } {
  const money = formatMoney(sub.amount, sub.currency);
  const billing = `${money}, списание ${formatDay(sub.next_billing_date)}`;
  return {
    title: `Продление: ${sub.service_name}`,
    body: sub.status === 'keep'
      ? level === 'soon'
        ? `${billing}. Сервис оставлен; проверьте готовность к оплате.`
        : `${billing} — дата наступила. Отметьте оплату и продлите период.`
      : level === 'soon'
        ? `${billing}. Решите: продлить или отменить.`
        : `${billing} — дата наступила. Решите: продлить или отменить.`,
  };
}

export async function runTechRenewalNotifications(deps: TechRenewalDeps): Promise<TechRenewalResult> {
  const { db, now } = deps;
  const log = deps.log ?? ((level, msg, extra) => {
    if (extra !== undefined) console[level](`[tech-renewal-cron] ${msg}`, extra);
    else console[level](`[tech-renewal-cron] ${msg}`);
  });

  const today = mskDateStr(now);

  // Жёлтый статус и напоминание — про одно и то же приближение даты, поэтому
  // статус подтягиваем здесь же: иначе он ждал бы, пока кто-нибудь откроет экран.
  await refreshPendingReview(db, today);

  const cutoff = addDays(today, RENEWAL_NOTIFY_DAYS);
  const subsRes = await db
    .from('tech_subscriptions')
    .select('id, service_name, amount, currency, next_billing_date, status')
    .neq('status', 'cancel')
    .lte('next_billing_date', cutoff);

  if (subsRes.error) {
    log('error', `subscriptions query failed: ${subsRes.error.message}`);
    return { processed: 0, created: 0 };
  }

  const subs = (subsRes.data ?? []) as SubRow[];
  if (!subs.length) return { processed: 0, created: 0 };

  const logRes = await db
    .from('tech_renewal_notification_log')
    .select('subscription_id, billing_date, level')
    .in('subscription_id', subs.map((s) => s.id));

  const sent = new Set(
    ((logRes.data ?? []) as LogRow[]).map((r) => `${r.subscription_id}:${r.billing_date}:${r.level}`),
  );

  const adminsRes = await db.from('profiles').select('id').eq('role', 'admin');
  const admins = ((adminsRes.data ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (!admins.length) {
    log('warn', 'нет ни одного админа — напоминания некому слать');
    return { processed: subs.length, created: 0 };
  }

  let created = 0;

  for (const sub of subs) {
    const level: Level = daysUntil(sub.next_billing_date, today) <= 0 ? 'due' : 'soon';
    const key = `${sub.id}:${sub.next_billing_date}:${level}`;
    if (sent.has(key)) continue;

    const { title, body } = buildContent(sub, level);
    const rows = admins.map((userId) => ({
      user_id: userId,
      type: 'tech_renewal',
      title,
      body,
      entity_type: 'tech_subscription',
      entity_id: sub.id,
      is_read: false,
    }));

    const insertRes = await db.from('notifications').insert(rows);
    if (insertRes.error) {
      log('error', `insert notification failed: ${insertRes.error.message}`);
      continue;
    }

    const upsertRes = await db.from('tech_renewal_notification_log').upsert(
      { subscription_id: sub.id, billing_date: sub.next_billing_date, level },
      { onConflict: 'subscription_id,billing_date,level' },
    );
    if (upsertRes.error) log('error', `dedup log upsert failed: ${upsertRes.error.message}`);

    sent.add(key);
    created += rows.length;
  }

  return { processed: subs.length, created };
}
