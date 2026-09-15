import 'server-only';

import net from 'net';
import { promises as dns } from 'dns';

/**
 * SSRF-защита исходящих SMTP/IMAP-подключений (BYO-почты).
 *
 * Пользователь с provider='custom' задаёт host/port сам (для IMAP у Maildoso это
 * вообще всегда индивидуальный хост из CSV). Без проверки прод-сервер мог бы
 * подключиться к внутренним адресам (loopback, RFC1918, link-local,
 * cloud-metadata 169.254.169.254) и стать сканером/оракулом — причём для IMAP это
 * особенно опасно: byoReplies опрашивает ящик по расписанию бесконечно, то есть
 * это не разовый запрос, а постоянный canal на заданный клиентом host:port.
 * Разрешаем только публичные адреса и стандартные порты.
 */

// ТОЛЬКО submission-порты (465 implicit TLS / 587 STARTTLS / 2525 alt).
// Порт 25 (MX-relay) НЕ разрешаем намеренно: исходящие на 25 к произвольным серверам —
// это паттерн, за который Spamhaus вносит IP в списки (был инцидент с email-валидацией
// с нашего сервера). Отправка с подключённых ящиков всегда идёт на submission-порт
// провайдера (465/587), порт 25 для этого не нужен.
const SMTP_ALLOWED_PORTS = new Set([465, 587, 2525]);

// IMAP всегда по implicit TLS на 993 у всех провайдеров из compatibility-матрицы
// (Gmail, Yandex, Maildoso, ZapMail). STARTTLS-порт 143 не поддерживаем осознанно —
// он бы расширил allowlist без реальной необходимости.
const IMAP_ALLOWED_PORTS = new Set([993]);

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

async function assertSafeTarget(host: string, port: number, allowedPorts: Set<number>): Promise<TargetCheck> {
  if (!allowedPorts.has(port)) return { ok: false, reason: 'port' };
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

/** Проверяет, что SMTP-цель безопасна (публичный адрес + стандартный submission-порт). */
export async function assertSafeSmtpTarget(host: string, port: number): Promise<TargetCheck> {
  return assertSafeTarget(host, port, SMTP_ALLOWED_PORTS);
}

/** Проверяет, что IMAP-цель безопасна (публичный адрес + порт 993). */
export async function assertSafeImapTarget(host: string, port: number): Promise<TargetCheck> {
  return assertSafeTarget(host, port, IMAP_ALLOWED_PORTS);
}
