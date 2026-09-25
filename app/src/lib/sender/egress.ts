import 'server-only';

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Адрес отправки воркера «Рассылки».
 *
 * Один воркер = один адрес: контейнер сидит в Docker-сети, чей исходящий NAT
 * привязан к адресу (deploy/sender/render-compose.sh), поэтому весь трафик —
 * SMTP, IMAP, токены Google — выходит с него без участия кода. Код отвечает за
 * три вещи: знать свой адрес (SENDER_EGRESS_IP), убедиться, что интернет видит
 * именно его, и сообщать о себе в реестр sender_egress_ips.
 *
 * Общие задачи парка выполняет держатель аренды — см. LeaseKeeper.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Сервисы «с какого адреса меня видно»: ответ — голый IPv4 текстом. */
const ECHO_URLS = ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip'];
const ECHO_TIMEOUT_MS = 8_000;

export const GLOBAL_LEASE = 'global';
export const LEASE_TTL_SECONDS = 90;
const LEASE_RENEW_MS = 20_000;
/** Запас до истечения аренды: часы воркера и БД расходятся, а продление может запоздать. */
const LEASE_SAFETY_MS = 15_000;

export function isIpv4(value: unknown): value is string {
  return typeof value === 'string' && IPV4_RE.test(value);
}

export interface EgressIdentity {
  ip: string;
  /** Подпись сервера для экрана «Адреса отправки». */
  host: string;
  /** Держатель аренды: адрес + id процесса — старый и новый контейнер одного адреса различаются. */
  holder: string;
}

export function egressIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): EgressIdentity | null {
  const ip = (env.SENDER_EGRESS_IP ?? '').trim();
  if (!isIpv4(ip)) return null;
  return {
    ip,
    host: (env.SENDER_HOST_LABEL ?? '').trim(),
    holder: `${ip}#${randomUUID().slice(0, 8)}`,
  };
}

export type EgressVerdict = { ok: true } | { ok: false; error: string } | { ok: null };

/**
 * Вердикт по ответам echo-сервисов:
 * - кто-то назвал чужой адрес — ошибка, даже если остальные назвали наш;
 * - все ответившие назвали наш — подтверждено;
 * - никто внятно не ответил — вердикта нет.
 */
export function judgeEgress(expected: string, seen: (string | null)[]): EgressVerdict {
  const answers = seen.filter((s): s is string => isIpv4(s));
  if (!answers.length) return { ok: null };
  const foreign = answers.find((s) => s !== expected);
  if (foreign) return { ok: false, error: `Воркер выходит в интернет с ${foreign}, а должен с ${expected}` };
  return { ok: true };
}

async function askEcho(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ECHO_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

export async function checkEgress(expected: string): Promise<EgressVerdict> {
  const seen = await Promise.all(ECHO_URLS.map(askEcho));
  return judgeEgress(expected, seen);
}

/** Пульс и вердикт самопроверки в реестр. Строки нет — заводим; accepts_new не трогаем. */
export async function reportEgress(identity: EgressIdentity, lastError: string | null): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const row: Record<string, unknown> = {
    ip: identity.ip,
    last_seen_at: new Date().toISOString(),
    last_error: lastError,
  };
  if (identity.host) row.host = identity.host;
  const { error } = await supabaseAdmin.from('sender_egress_ips').upsert(row, { onConflict: 'ip' });
  return !error;
}

async function acquireLease(name: string, holder: string, ttlSeconds: number): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin.rpc('sender_acquire_lease', {
    p_name: name,
    p_holder: holder,
    p_ttl_seconds: ttlSeconds,
  });
  return !error && data === true;
}

async function releaseLease(name: string, holder: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.rpc('sender_release_lease', { p_name: name, p_holder: holder });
}

/**
 * Держит аренду независимым таймером, как heartbeat: долгий тик (двадцать
 * писем подряд) аренду не теряет, а мёртвый event loop — теряет, и её через
 * TTL подхватывает другой воркер. Воркер с неподтверждённым адресом аренду
 * не берёт и отдаёт: иначе общие задачи встали бы у того, кто сам не работает.
 */
export class LeaseKeeper {
  private held = false;
  private heldUntil = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly name: string,
    private readonly holder: string,
    private readonly log: Log,
    private readonly eligible: () => boolean,
  ) {}

  start(): void {
    void this.renew();
    this.timer = setInterval(() => void this.renew(), LEASE_RENEW_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  isHeld(): boolean {
    return this.held && Date.now() < this.heldUntil;
  }

  private async renew(): Promise<void> {
    const was = this.held;
    if (!this.eligible()) {
      if (was) await releaseLease(this.name, this.holder).catch(() => {});
      this.held = false;
      if (was) this.log('warn', `Аренда «${this.name}» отдана: адрес воркера не подтверждён`);
      return;
    }
    const ok = await acquireLease(this.name, this.holder, LEASE_TTL_SECONDS).catch(() => false);
    this.held = ok;
    if (ok) this.heldUntil = Date.now() + LEASE_TTL_SECONDS * 1000 - LEASE_SAFETY_MS;
    if (ok !== was) {
      this.log('info', ok
        ? `Аренда «${this.name}» наша — выполняю общие задачи парка`
        : `Аренда «${this.name}» у другого воркера`);
    }
  }

  /** Штатная остановка: аренду отдаём сразу, а не ждём её истечения. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.held) await releaseLease(this.name, this.holder).catch(() => {});
    this.held = false;
  }
}

/** Начало текущих суток по Москве (UTC+3 без перехода на летнее время), ISO. */
export function startOfMoscowDayIso(now: Date = new Date()): string {
  const MSK_MS = 3 * 60 * 60 * 1000;
  const msk = new Date(now.getTime() + MSK_MS);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - MSK_MS).toISOString();
}
