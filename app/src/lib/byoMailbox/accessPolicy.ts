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

/**
 * ENG-клиент свои ящики НЕ подключает (решение владельца 11.10.2026): кампании
 * ENG-кабинета шлют только из пула наших ящиков (hypothesisEngine/
 * engSendingPreset.ts), экрана подключения у него больше нет. Гейт выше его по-
 * прежнему пускает — список и удаление ящиков, подключённых раньше, остаются, —
 * а точки ПОДКЛЮЧЕНИЯ (POST /api/client/mailboxes, старт OAuth Google и
 * Яндекса) отказывают ему 403 этой проверкой (byoMailbox/access.ts,
 * refuseOwnMailboxConnectForEng). `market` — auth.market общего гейта:
 * ENG-хост или profiles.market='eng' (clientApiHelper.requestMarket). У 'ru'
 * отказа нет — RU-путь не меняется.
 */
export const ENG_OWN_MAILBOX_UNAVAILABLE_TEXT =
  'Your campaigns send from mailboxes we provide, so connecting your own mailbox is not available.';
export const ENG_OWN_MAILBOX_UNAVAILABLE_CODE = 'OWN_MAILBOX_NOT_AVAILABLE';

export function ownMailboxConnectRefused(market: string | null | undefined): boolean {
  return market === 'eng';
}
