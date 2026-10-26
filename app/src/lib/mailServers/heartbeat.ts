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
 * отчёта dnsbl, иначе каждый листинг выводится дважды. Оплату серверов страница не показывает
 * (Сергей 26.10: «про оплату убери всю информацию») — напоминания о ней остаются в Telegram.
 */
export function activeAlerts(report: MailServerReport): MailAlert[] {
  return report.alerts.filter((a) => !a.key.startsWith('bl:') && a.key !== 'pay');
}

/** Провайдер для группировки: из отчёта, иначе «без провайдера». */
export function providerOf(row: MailServerRow): string {
  const p = row.payload.server.provider?.trim();
  const loc = row.payload.server.location?.trim();
  return p ? (loc ? `${p}, ${loc}` : p) : 'Провайдер не указан';
}

export type RowState = 'ok' | 'warn' | 'bad' | 'off';

/** Строка таблицы «Кто где живёт»: один адрес сервера и что на нём. */
export interface AddressRow {
  key: string;
  /** Порядок адреса в отчёте сервера: основной адрес сервера — первым. */
  pos: number;
  ip: string;
  ptr: string;
  who: string;
  kind: IpKind;
  boxes: number;
  server: string;
  /** Город сервера — в таблице адресов достаточно его, провайдер виден в таблице серверов. */
  where: string;
  state: RowState;
  stateText: string;
  domains: MailDomain[];
  tags: MailTag[];
}

const KIND_ORDER: Record<IpKind, number> = { client: 0, ours: 1, paused: 2, idle: 3 };

function silentFor(receivedAt: string, now: Date): string {
  const min = Math.round((now.getTime() - new Date(receivedAt).getTime()) / 60_000);
  return min < 120 ? `${min} мин` : `${Math.round(min / 60)} ч`;
}

/** Адреса всех серверов: сначала клиенты, потом наши, потом пауза — по одной строке на адрес. */
export function addressRows(rows: MailServerRow[], now: Date): AddressRow[] {
  const out: AddressRow[] = [];
  for (const row of rows) {
    const r = row.payload;
    const listed = new Set((r.dnsbl?.listed ?? []).map((l) => l.name));
    const silent = freshness(row.received_at, now) === 'silent';
    for (const [pos, ip] of r.ips.entries()) {
      const kind = ipKind(ip);
      const labels = new Set(ip.domains.map((d) => d.tag).filter(Boolean));
      const tags = r.instantly.tags.filter((t) => labels.has(t.label));
      const listedHere = ip.domains.filter((d) => listed.has(d.domain)).length;
      const broken = tags.reduce((n, t) => n + t.problems.length, 0);
      let state: RowState = 'ok';
      let stateText = 'в порядке';
      if (silent) {
        state = 'bad';
        stateText = `сервер молчит ${silentFor(row.received_at, now)}`;
      } else if (kind === 'paused' || kind === 'idle') {
        state = 'off';
        stateText = listedHere ? `на паузе: ${listedHere} дом. в чёрных списках` : kind === 'idle' ? 'свободен' : 'на паузе';
      } else if (listedHere) {
        state = 'warn';
        stateText = `${listedHere} дом. в чёрных списках`;
      } else if (broken) {
        state = 'warn';
        stateText = `${broken} ящ. с ошибкой в Instantly`;
      }
      const clients = ipClients(ip);
      out.push({
        key: `${row.server_id}|${ip.ip}`,
        pos,
        ip: ip.ip,
        ptr: ip.ptr,
        who: kind === 'client' ? clients.join(', ') : kind === 'ours' ? 'Наши неименные' : kind === 'paused' ? 'Наши, на паузе' : 'Свободный адрес',
        kind,
        boxes: ip.domains.reduce((n, d) => n + d.boxes, 0),
        server: r.server.label,
        where: r.server.location || providerOf(row),
        state,
        stateText,
        domains: ip.domains,
        tags,
      });
    }
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.server.localeCompare(b.server) || a.pos - b.pos);
}

/** Названия тревог бота, если текст ещё не записан (состояние старше, чем запись текста в state.json). */
const ALERT_FALLBACK: Record<string, string> = {
  bounces: 'много отказов «спам» при отправке',
  queue: 'растёт очередь писем',
  disk: 'заканчивается место на диске',
  cert: 'истекает сертификат',
  inbound: 'нет входящих подключений на порт 25',
  'inbound-mail': 'давно не приходили письма',
  limits: 'упёрлись в лимит подключений',
  icount: 'в Instantly не все ящики сервера',
  'instantly-api': 'не удаётся проверить ящики в Instantly',
};

export interface AttentionItem {
  level: 'bad' | 'warn';
  text: string;
}

/**
 * Что требует внимания — обычными словами, без повторов: одна и та же тревога с нескольких
 * серверов — одной строкой со списком серверов.
 */
export function attentionItems(rows: MailServerRow[], now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  const sameAlert = new Map<string, string[]>();
  for (const row of rows) {
    const r = row.payload;
    const name = r.server.label;
    if (freshness(row.received_at, now) === 'silent') {
      items.push({ level: 'bad', text: `${name} не присылает отчёт ${silentFor(row.received_at, now)} — сломался сервер или связь с ним` });
    }
    for (const [svc, st] of Object.entries(r.server.services ?? {})) {
      if (st !== 'active') items.push({ level: 'bad', text: `${name}: служба ${svc} не работает` });
    }
    for (const a of activeAlerts(r)) {
      const text = a.text || ALERT_FALLBACK[a.key] || a.key;
      sameAlert.set(text, [...(sameAlert.get(text) ?? []), name]);
    }
    const listed = r.dnsbl?.listed?.length ?? 0;
    if (listed) {
      const paused = r.ips.every((ip) => ipKind(ip) === 'paused' || ipKind(ip) === 'idle');
      items.push({ level: 'warn', text: `${name}: ${listed} дом. в чёрных списках${paused ? ' (ящики на паузе)' : ''}` });
    }
    for (const t of r.instantly.tags) {
      if (t.problems.length) items.push({ level: 'warn', text: `${name}, «${t.label}»: ${t.problems.length} ящ. с ошибкой в Instantly` });
    }
    if (r.server.disk_used_pct >= 80) items.push({ level: 'warn', text: `${name}: диск занят на ${r.server.disk_used_pct}%` });
    if (r.server.queue >= 100) items.push({ level: 'warn', text: `${name}: в очереди ${r.server.queue} писем` });
    if (r.server.cert_days_left !== null && r.server.cert_days_left < 20) {
      items.push({ level: 'warn', text: `${name}: сертификат истекает через ${r.server.cert_days_left} дн.` });
    }
  }
  for (const [text, servers] of sameAlert) {
    const grouped = `${text.charAt(0).toUpperCase()}${text.slice(1)} (${servers.join(', ')})`;
    items.push({ level: 'warn', text: servers.length > 1 ? grouped : `${servers[0]}: ${text}` });
  }
  return items.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}
