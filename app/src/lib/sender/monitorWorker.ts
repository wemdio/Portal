import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSenderAlert } from './alerts';

/**
 * Монитор сендера (задачи 5.7 + 5.8 хендоффа масштаба).
 *
 * До этого всё чиненое работало молча: отправка могла встать в ноль, ящики
 * отваливаться пачками, bounce rate гореть — узнать об этом можно было только
 * зайдя в портал. Здесь собираются метрики раз в несколько минут и решается,
 * сигналить ли в TG и ставить ли домен на автопаузу.
 *
 * Правила вынесены в чистую функцию evaluateSenderHealth — её же проверяют
 * тесты, без БД и телеграма.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** Пороговые значения. Меняются только с пониманием, что алерт останется читаемым. */
export interface MonitorThresholds {
  /** Сколько писем должно стоять «на сегодня», чтобы очередь считалась застрявшей. */
  stalledDueMessages: number;
  /** Глубина очереди, о которой предупреждаем заранее. */
  queueDepthWarn: number;
  /** Минимум отправок за окно, ниже которого bounce rate шумит и не считается. */
  domainMinSent: number;
  /** Доля отбоев по домену, после которой домен встаёт на паузу. */
  domainBounceRate: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  stalledDueMessages: 5,
  queueDepthWarn: 500,
  domainMinSent: 30,
  domainBounceRate: 0.1,
};

export interface MonitorMetrics {
  /** Писем отправлено за последний час. */
  sentLastHour: number;
  /** Писем стоит в очереди с прошедшим временем отправки. */
  dueScheduled: number;
  /** Возраст самого старого «должного» письма, минуты. */
  oldestDueMinutes: number | null;
  /** Ящиков упало в failed за последний час. */
  failedMailboxesLastHour: number;
  /** Отправлено/отбилось по доменам за 24 ч. */
  domains: { domain: string; sent: number; bounced: number }[];
}

export interface HealthDecision {
  alerts: { key: string; title: string; lines: string[] }[];
  /** Домены под автопаузу: отправки с них прекращаются до решения человека. */
  pauseDomains: { domain: string; sent: number; bounced: number; rate: number }[];
}

/**
 * Что сигналить и на что ставить паузу по метрикам. Чистая функция: и воркер,
 * и тесты смотрят на одни и те же правила.
 */
export function evaluateSenderHealth(m: MonitorMetrics, t: MonitorThresholds): HealthDecision {
  const alerts: HealthDecision['alerts'] = [];

  // Отправка стоит: письма назрели, но за час не ушло ни одного. Порог по
  // глубине отсекает «кампания просто закончилась» — 2-3 хвостовых письма
  // после остановки алертом не являются.
  if (m.sentLastHour === 0 && m.dueScheduled >= t.stalledDueMessages) {
    alerts.push({
      key: 'send_stalled',
      title: 'Рассылка: отправка стоит',
      lines: [
        `За последний час не отправлено ни одного письма, в очереди ${m.dueScheduled} с прошедшим временем.`,
        m.oldestDueMinutes != null ? `Самое старое ждёт ${Math.round(m.oldestDueMinutes)} мин.` : null,
        'Проверьте вкладку «Ящики»: вероятно, отвалились ящики или воркер.',
      ].filter((x): x is string => x != null),
    });
  }

  if (m.dueScheduled >= t.queueDepthWarn) {
    alerts.push({
      key: 'queue_depth',
      title: 'Рассылка: очередь растёт',
      lines: [
        `В очереди ${m.dueScheduled} писем с прошедшим временем отправки (порог ${t.queueDepthWarn}).`,
        m.sentLastHour > 0 ? `Темп: ${m.sentLastHour} писем за час — очередь не успевает дренироваться.` : 'Отправка при этом не идёт.',
      ],
    });
  }

  if (m.failedMailboxesLastHour > 0) {
    alerts.push({
      key: 'mailboxes_failed',
      title: 'Рассылка: ящики отваливаются',
      lines: [`За последний час ${m.failedMailboxesLastHour} ящиков перешли в «Ошибка».`],
    });
  }

  const pauseDomains: HealthDecision['pauseDomains'] = [];
  for (const d of m.domains) {
    if (d.sent < t.domainMinSent) continue;
    const rate = d.bounced / d.sent;
    if (rate < t.domainBounceRate) continue;
    pauseDomains.push({ ...d, rate });
    alerts.push({
      key: `domain_bounce:${d.domain}`,
      title: `Рассылка: bounce rate домена ${d.domain}`,
      lines: [
        `Отбоев ${d.bounced} из ${d.sent} писем за 24 ч (${Math.round(rate * 100)}%).`,
        'Домен поставлен на автопаузу: ящики выключены до разбора.',
      ],
    });
  }

  return { alerts, pauseDomains };
}

/** Один ключ алертится не чаще раза в период — иначе каждые 5 минут по новой. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function shouldFire(key: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const since = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();
  const { data } = await supabaseAdmin
    .from('sender_alert_state')
    .select('fired_at')
    .eq('key', key)
    .maybeSingle();
  if (data && String(data.fired_at) > since) return false;
  return true;
}

async function markFired(key: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('sender_alert_state')
    .upsert({ key, fired_at: new Date().toISOString() }, { onConflict: 'key' });
}

async function collectMetrics(log: Log): Promise<MonitorMetrics> {
  const db = supabaseAdmin!;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const [sentHour, due, oldestDue, failedBoxes, domainRows] = await Promise.all([
    db.from('sender_messages').select('id', { count: 'exact', head: true })
      .eq('status', 'sent').gte('sent_at', hourAgo),
    db.from('sender_messages').select('id', { count: 'exact', head: true })
      .eq('status', 'scheduled').lte('scheduled_at', nowIso),
    db.from('sender_messages').select('scheduled_at')
      .eq('status', 'scheduled').lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true }).limit(1),
    db.from('sender_mailboxes').select('id', { count: 'exact', head: true })
      .eq('status', 'failed').gte('updated_at', hourAgo),
    db.rpc('sender_domain_health', { p_hours: 24 }),
  ]);

  if (domainRows.error) log('warn', `sender_domain_health не посчитался: ${domainRows.error.message}`);

  const oldest = (oldestDue.data?.[0] as { scheduled_at?: string } | undefined)?.scheduled_at;

  return {
    sentLastHour: sentHour.count ?? 0,
    dueScheduled: due.count ?? 0,
    oldestDueMinutes: oldest ? (Date.now() - new Date(oldest).getTime()) / 60_000 : null,
    failedMailboxesLastHour: failedBoxes.count ?? 0,
    domains: ((domainRows.data ?? []) as { domain: string; sent: number; bounced: number }[]),
  };
}

/** Автопауза домена: выключаем ящики домена, причину кладём в строку ящика. */
async function pauseDomain(domain: string, rate: number, log: Log): Promise<void> {
  if (!supabaseAdmin) return;
  const note = `Автопауза: отбои ${Math.round(rate * 100)}% за 24 ч — домен выключен до разбора`;
  const { data, error } = await supabaseAdmin
    .from('sender_mailboxes')
    .update({ enabled: false, last_error: note, updated_at: new Date().toISOString() })
    .ilike('email', `%@${domain}`)
    .eq('enabled', true)
    .select('id');
  if (error) log('error', `Не удалось поставить домен ${domain} на паузу: ${error.message}`);
  else log('warn', `Домен ${domain} на автопаузе: выключено ящиков ${data?.length ?? 0}`);
}

/** Один проход монитора. Зовётся воркером раз в несколько минут. */
export async function runSenderMonitor(opts?: { log?: Log; thresholds?: MonitorThresholds }): Promise<void> {
  if (!supabaseAdmin) return;
  const log: Log = opts?.log ?? (() => {});
  const thresholds = opts?.thresholds ?? DEFAULT_THRESHOLDS;

  let metrics: MonitorMetrics;
  try {
    metrics = await collectMetrics(log);
  } catch (e) {
    log('warn', `Метрики сендера не собрались: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const decision = evaluateSenderHealth(metrics, thresholds);

  for (const domain of decision.pauseDomains) {
    await pauseDomain(domain.domain, domain.rate, log);
  }

  for (const alert of decision.alerts) {
    if (!(await shouldFire(alert.key))) continue;
    const sent = await sendSenderAlert(alert.title, alert.lines);
    if (sent) {
      await markFired(alert.key);
      log('warn', `Алерт сендера отправлен: ${alert.key}`);
    }
  }
}
