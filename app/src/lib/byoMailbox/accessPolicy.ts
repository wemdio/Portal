/**
 * Политика доступа к подключению ящиков. Без server-only — чтобы тесты
 * не тащили NextRequest.
 *
 * Origin/Referer намеренно не смотрим: их легко подставить. Открываем по
 * allowlist (старый RU-пилот), по Host ENG-кабинета, или по profiles.market.
 */

import { isEngAppHost } from '@/lib/engMarket';

export function parseMailboxPilotUserIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function mailboxConnectAllowed(input: {
  userId: string;
  allowlistRaw: string;
  host?: string | null;
  profileMarket?: string | null;
}): boolean {
  if (!input.userId) return false;
  if (parseMailboxPilotUserIds(input.allowlistRaw).has(input.userId.toLowerCase())) {
    return true;
  }
  if (isEngAppHost(input.host)) return true;
  return input.profileMarket === 'eng';
}
