import 'server-only';

import net from 'net';
import { promises as dns } from 'dns';

/**
 * SSRF-защита исходящих SMTP-подключений (BYO-почты).
 *
 * Пользователь с provider='custom' задаёт host/port сам. Без проверки прод-сервер
 * мог бы подключиться к внутренним адресам (loopback, RFC1918, link-local,
 * cloud-metadata 169.254.169.254) и стать сканером/оракулом. Разрешаем только
 * публичные адреса и стандартные SMTP-порты.
 */

const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true;
  if (x.startsWith('fe80')) return true; // link-local
  if (x.startsWith('fc') || x.startsWith('fd')) return true; // unique-local
  if (x.startsWith('::ffff:')) {
    const v4 = x.split(':').pop() ?? '';
    if (v4.includes('.')) return isPrivateV4(v4); // IPv4-mapped
  }
  return false;
}

function isDisallowedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateV4(ip);
  if (fam === 6) return isPrivateV6(ip);
  return true; // не распознали — блокируем
}

export interface TargetCheck {
  ok: boolean;
  reason?: 'port' | 'host' | 'dns';
}

/** Проверяет, что SMTP-цель безопасна (публичный адрес + стандартный порт). */
export async function assertSafeSmtpTarget(host: string, port: number): Promise<TargetCheck> {
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: 'port' };
  const h = (host ?? '').trim().toLowerCase();
  if (!h) return { ok: false, reason: 'host' };

  if (net.isIP(h)) {
    return isDisallowedAddress(h) ? { ok: false, reason: 'host' } : { ok: true };
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(h, { all: true });
  } catch {
    return { ok: false, reason: 'dns' };
  }
  if (!addrs.length) return { ok: false, reason: 'dns' };
  for (const a of addrs) {
    if (isDisallowedAddress(a.address)) return { ok: false, reason: 'host' };
  }
  return { ok: true };
}
