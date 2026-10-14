import 'server-only';

import { Resolver, resolve4, resolveNs } from 'node:dns/promises';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSenderAlert } from './alerts';
import type { BlacklistStatus, DmarcStatus, DomainHealth, SpfStatus } from './domainReputation';

/**
 * Проверка доменов отправки по DNS: подписи SPF / DKIM / DMARC и чёрные
 * списки доменов. Результат — sender_domain_health, его читает вкладка
 * «Статистика» (правила оценки — domainReputation.ts).
 *
 * Чёрные списки отказывают в ответе на запросы через публичные DNS (Google,
 * Cloudflare): Spamhaus отвечает 127.255.255.254, URIBL — 127.0.0.1. Такой
 * ответ не «чисто», а «не проверено»; тогда спрашиваем серверы списка
 * напрямую. Не ответили и они — честно пишем «не проверено».
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** Домен перепроверяется не чаще, чем раз в это время. */
const RECHECK_AFTER_MS = 12 * 60 * 60 * 1000;
/** Доменов за один запуск: DNS-запросы медленные, отправку не держим. */
const DOMAINS_PER_RUN = 15;
const DNS_TIMEOUT_MS = 4000;

/** Обычные имена DKIM-ключа: Google Workspace, Microsoft, Maildoso и типовые. */
const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'dkim', 'mail', 's1', 's2', 'k1'];

interface BlacklistZone {
  id: string;
  zone: string;
  /** Адрес ответа → вердикт: часть ответов означает «запрос отклонён». */
  verdict(ip: string): BlacklistStatus;
}

const lastOctet = (ip: string) => Number(ip.split('.')[3] ?? -1);

const BLACKLISTS: BlacklistZone[] = [
  {
    id: 'spamhaus',
    zone: 'dbl.spamhaus.org',
    // 127.0.1.2–127.0.1.254 — домен в списке; 127.255.255.x — отказ в запросе.
    verdict: (ip) => (/^127\.0\.1\.\d+$/.test(ip) && lastOctet(ip) >= 2 && lastOctet(ip) < 255 ? 'listed' : 'unknown'),
  },
  {
    id: 'surbl',
    zone: 'multi.surbl.org',
    // Битовая маска списков; 127.0.0.1 — отказ в запросе.
    verdict: (ip) => (/^127\.0\.0\.\d+$/.test(ip) && lastOctet(ip) > 1 ? 'listed' : 'unknown'),
  },
  {
    id: 'uribl',
    zone: 'multi.uribl.com',
    // 2 / 4 / 8 — black / grey / red; 127.0.0.1 — отказ в запросе.
    verdict: (ip) => (/^127\.0\.0\.\d+$/.test(ip) && (lastOctet(ip) & 14) !== 0 ? 'listed' : 'unknown'),
  },
];

export function parseSpf(txt: string[]): SpfStatus {
  const records = txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (!records.length) return 'missing';
  if (records.length > 1) return 'multiple';
  // «+all» и «?all» разрешают слать от домена кому угодно — защиты нет.
  return /[+?]all\b/i.test(records[0]) ? 'soft' : 'ok';
}

export function parseDmarc(txt: string[]): DmarcStatus {
  const record = txt.find((t) => /^v=DMARC1/i.test(t.trim()));
  if (!record) return 'missing';
  const policy = record.match(/(?:^|;)\s*p=(\w+)/i)?.[1]?.toLowerCase();
  return policy === 'reject' || policy === 'quarantine' ? policy : 'none';
}

function isMissing(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

async function txtRecords(resolver: Resolver, name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

/** Серверы зоны чёрного списка — чтобы спросить их в обход публичного DNS. */
const zoneServers = new Map<string, string[]>();

async function directResolver(zone: string): Promise<Resolver | null> {
  let ips = zoneServers.get(zone);
  if (!ips) {
    ips = [];
    try {
      for (const ns of (await resolveNs(zone)).slice(0, 4)) {
        try {
          ips.push(...(await resolve4(ns)));
        } catch {
          // один сервер не разрешился — хватит остальных
        }
      }
    } catch {
      // зона не отвечает — останется «не проверено»
    }
    zoneServers.set(zone, ips);
  }
  if (!ips.length) return null;
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers(ips.slice(0, 4));
  return resolver;
}

async function lookupBlacklist(resolver: Resolver, domain: string, list: BlacklistZone): Promise<BlacklistStatus> {
  const name = `${domain}.${list.zone}`;
  const ask = async (r: Resolver): Promise<BlacklistStatus> => {
    try {
      const ips = await r.resolve4(name);
      return ips.some((ip) => list.verdict(ip) === 'listed') ? 'listed' : 'unknown';
    } catch (e) {
      return isMissing(e) ? 'clean' : 'unknown';
    }
  };
  const first = await ask(resolver);
  if (first !== 'unknown') return first;
  const direct = await directResolver(list.zone);
  return direct ? ask(direct) : 'unknown';
}

export async function checkDomain(domain: string): Promise<Omit<DomainHealth, 'checked_at'>> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  try {
    const [rootTxt, dmarcTxt] = await Promise.all([
      txtRecords(resolver, domain),
      txtRecords(resolver, `_dmarc.${domain}`),
    ]);
    let dkimSelector: string | null = null;
    for (const selector of DKIM_SELECTORS) {
      const txt = await txtRecords(resolver, `${selector}._domainkey.${domain}`).catch(() => []);
      if (txt.some((t) => /v=DKIM1|p=/i.test(t))) {
        dkimSelector = selector;
        break;
      }
    }
    const blacklists: Record<string, BlacklistStatus> = {};
    for (const list of BLACKLISTS) blacklists[list.id] = await lookupBlacklist(resolver, domain, list);
    return {
      domain,
      spf: parseSpf(rootTxt),
      dmarc: parseDmarc(dmarcTxt),
      dkim_selector: dkimSelector,
      blacklists,
      error: null,
    };
  } catch (e) {
    return {
      domain,
      spf: null,
      dmarc: null,
      dkim_selector: null,
      blacklists: {},
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}

/**
 * Перепроверить домены, которые давно не проверялись. Вызывается ведущим
 * воркером; за раз — не больше DOMAINS_PER_RUN, остальные дойдут следующими
 * запусками. Домен, только что попавший в чёрный список, — алерт в TG.
 */
export async function runDomainHealth({ log }: { log: Log }): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;

  const { data: mailboxes, error } = await db.from('sender_mailboxes').select('email');
  if (error) throw new Error(error.message);
  const domains = [
    ...new Set((mailboxes ?? []).map((m) => String(m.email).toLowerCase().split('@')[1] ?? '').filter((d) => d !== '')),
  ];
  if (!domains.length) return;

  const { data: rows, error: healthError } = await db
    .from('sender_domain_health')
    .select('domain, checked_at, blacklists')
    .in('domain', domains);
  if (healthError) throw new Error(healthError.message);
  type KnownRow = { checked_at: string; blacklists: Record<string, BlacklistStatus> | null };
  const known = new Map<string, KnownRow>(
    (rows ?? []).map((r) => [String(r.domain), { checked_at: String(r.checked_at), blacklists: r.blacklists }] as const),
  );

  const checkedTime = (domain: string) => {
    const row = known.get(domain);
    return row ? new Date(row.checked_at).getTime() : 0;
  };
  const staleBefore = Date.now() - RECHECK_AFTER_MS;
  const due = domains
    .filter((d) => checkedTime(d) < staleBefore)
    // Самые давние — первыми; ни разу не проверенные — раньше всех.
    .sort((a, b) => checkedTime(a) - checkedTime(b))
    .slice(0, DOMAINS_PER_RUN);
  if (!due.length) return;

  const newlyListed: string[] = [];
  for (const domain of due) {
    const result = await checkDomain(domain);
    const before = known.get(domain)?.blacklists ?? {};
    const fresh = Object.entries(result.blacklists)
      .filter(([list, status]) => status === 'listed' && before[list] !== 'listed')
      .map(([list]) => list);
    if (fresh.length) newlyListed.push(`${domain} — ${fresh.join(', ')}`);

    const { error: upsertError } = await db
      .from('sender_domain_health')
      .upsert({ ...result, checked_at: new Date().toISOString() }, { onConflict: 'domain' });
    if (upsertError) throw new Error(upsertError.message);
  }
  log('info', `Домены проверены по DNS: ${due.length}`);

  if (newlyListed.length) {
    await sendSenderAlert('Домен отправки попал в чёрный список', [
      ...newlyListed,
      'Письма с него, скорее всего, уходят в спам. Детали — «Рассылка» → «Статистика».',
    ]);
  }
}
