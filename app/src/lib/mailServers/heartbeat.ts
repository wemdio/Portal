/**
 * Отчёт почтового сервера (mail-pilot/mail-heartbeat.py, раз в 15 минут) и расчёты для
 * страницы «Админ → Почтовые серверы». Паролей и ключей в отчёте нет — только состояние.
 */

export interface MailDomain {
  domain: string;
  /** Имя подключения Instantly (pN.<служебный домен>) — пару доменов можно перевезти правкой DNS. */
  conn: string;
  boxes: number;
  paused: number;
  pending: number;
  /** Тег Instantly ящиков домена: клиент (Nimax…) или «пилот-…» для наших неименных. */
  tag: string;
}

export interface MailIp {
  ip: string;
  ptr: string;
  domains: MailDomain[];
}

export interface MailTag {
  label: string;
  boxes: number;
  active: number;
  warmup_on: number;
  problems: { email: string; status: number | null; warmup: number | null }[];
}

export interface MailAlert {
  key: string;
  since: string | null;
  text: string;
}

export interface MailServerReport {
  v: number;
  generated_at: string;
  server: {
    label: string;
    hostname: string;
    provider: string;
    location: string;
    helo: string;
    uptime_s: number;
    load1: number;
    mem_total_mb: number | null;
    mem_used_mb: number | null;
    disk_used_pct: number;
    queue: number;
    cert_days_left: number | null;
    cert_names: string[];
    services: Record<string, string>;
    pay_due: string;
    boxes: number;
    paused: number;
    pending: number;
  };
  ips: MailIp[];
  instantly: { tags: MailTag[]; error: string | null };
  mail_today: {
    sent: number;
    deferred: number;
    bounced_dead: number;
    bounced_other: number;
    delivered_in: number;
    inbound_connects: number;
  };
  dnsbl: { checked_at: string | null; listed: { name: string; result: string }[] };
  alerts: MailAlert[];
}

export interface MailServerRow {
  server_id: string;
  payload: MailServerReport;
  received_at: string;
  source_ip: string | null;
}

/** Отчёт больше этого — не наш скрипт: у сервера с 32 ящиками он около 3 КБ. */
export const MAX_REPORT_BYTES = 256 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Проверка формы отчёта: только то, без чего страница не построится. Лишние поля
 * пропускаем — новая версия скрипта на сервере не должна ломать приём.
 */
export function parseReport(body: unknown): { ok: true; report: MailServerReport } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: 'Ожидался JSON-объект' };
  const server = body.server;
  if (!isObj(server)) return { ok: false, error: 'Нет server' };
  const hostname = server.hostname;
  if (typeof hostname !== 'string' || !/^[a-z0-9.-]{3,253}$/i.test(hostname)) {
    return { ok: false, error: 'server.hostname — не имя хоста' };
  }
  if (!Array.isArray(body.ips)) return { ok: false, error: 'Нет ips' };
  for (const ip of body.ips) {
    if (!isObj(ip) || typeof ip.ip !== 'string' || !Array.isArray(ip.domains)) {
      return { ok: false, error: 'Неверный элемент ips' };
    }
  }
  if (!isObj(body.mail_today) || !isObj(body.instantly) || !Array.isArray(body.alerts)) {
    return { ok: false, error: 'Нет mail_today, instantly или alerts' };
  }
  return { ok: true, report: body as unknown as MailServerReport };
}

export type Freshness = 'ok' | 'late' | 'silent';

/** Отчёт раз в 15 минут: пропуск одного — «опаздывает», молчание дольше часа — тревога. */
export function freshness(receivedAt: string, now: Date): Freshness {
  const ageMin = (now.getTime() - new Date(receivedAt).getTime()) / 60_000;
  if (ageMin <= 35) return 'ok';
  if (ageMin <= 60) return 'late';
  return 'silent';
}

export type IpKind = 'ours' | 'client' | 'paused' | 'idle';

/** Что на адресе: наши неименные ящики (теги «пилот-…»), ящики клиента, всё на паузе или пусто. */
export function ipKind(ip: MailIp): IpKind {
  const boxes = ip.domains.reduce((s, d) => s + d.boxes, 0);
  if (boxes === 0) return 'idle';
  if (ip.domains.every((d) => d.paused === d.boxes)) return 'paused';
  return ip.domains.some((d) => d.tag && !d.tag.toLowerCase().startsWith('пилот')) ? 'client' : 'ours';
}

/** Клиенты на адресе — по тегам ящиков; для наших неименных пусто. */
export function ipClients(ip: MailIp): string[] {
  return [...new Set(ip.domains.map((d) => d.tag).filter((t) => t && !t.toLowerCase().startsWith('пилот')))];
}

/**
 * Тревоги бота без листингов доменов (ключи «bl:…»): чёрные списки страница показывает из
 * отчёта dnsbl, иначе каждый листинг выводится дважды.
 */
export function activeAlerts(report: MailServerReport): MailAlert[] {
  return report.alerts.filter((a) => !a.key.startsWith('bl:'));
}

export interface MailSummary {
  servers: number;
  silent: number;
  ips: number;
  boxesOurs: number;
  boxesClients: number;
  boxesPaused: number;
  alerts: number;
  listed: number;
}

export function summarize(rows: MailServerRow[], now: Date): MailSummary {
  const s: MailSummary = { servers: rows.length, silent: 0, ips: 0, boxesOurs: 0, boxesClients: 0, boxesPaused: 0, alerts: 0, listed: 0 };
  for (const row of rows) {
    const r = row.payload;
    if (freshness(row.received_at, now) === 'silent') s.silent += 1;
    s.ips += r.ips.length;
    s.alerts += activeAlerts(r).length;
    s.listed += r.dnsbl?.listed?.length ?? 0;
    for (const ip of r.ips) {
      for (const d of ip.domains) {
        s.boxesPaused += d.paused;
        const working = d.boxes - d.paused;
        if (d.tag && !d.tag.toLowerCase().startsWith('пилот')) s.boxesClients += working;
        else s.boxesOurs += working;
      }
    }
  }
  return s;
}

/** Провайдер для группировки: из отчёта, иначе «без провайдера». */
export function providerOf(row: MailServerRow): string {
  const p = row.payload.server.provider?.trim();
  const loc = row.payload.server.location?.trim();
  return p ? (loc ? `${p}, ${loc}` : p) : 'Провайдер не указан';
}
