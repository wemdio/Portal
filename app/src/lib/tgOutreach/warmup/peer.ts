/**
 * Прогрев: как один наш аккаунт находит другой.
 *
 * Боевой цикл никогда не пишет первым — он отвечает в существующих диалогах,
 * где peer приходит готовым из getDialogs. Прогреву нужен первый контакт, а для
 * него нужен peer с access_hash. Путей два:
 *
 *   - резолв по @username — дёшево и ничего не меняет в аккаунте;
 *   - импорт телефона в контакты — работает всегда, но оставляет след.
 *
 * Импортированный контакт удаляем сразу после переписки. Диалог остаётся
 * рабочим, а постоянная взаимная сеть «все шестнадцать аккаунтов друг у друга в
 * контактах» не образуется: такой клубок — легко вычисляемый след, по одному
 * спалившемуся аккаунту находится вся партия.
 *
 * Образец работы с ImportContacts — app/src/lib/cisLeads/phoneEnrichmentWorker.ts.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import bigInt from 'big-integer';

export type ResolutionStrategy =
  | { kind: 'username'; username: string }
  | { kind: 'phone'; phone: string }
  | { kind: 'none' };

/** Телефон в вид, который принимает Telegram: только цифры. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits : null;
}

export function chooseResolutionStrategy(target: {
  tg_username: string | null;
  phone: string | null;
}): ResolutionStrategy {
  const username = (target.tg_username ?? '').trim().replace(/^@/, '');
  if (username) return { kind: 'username', username };
  const phone = normalizePhone(target.phone);
  if (phone) return { kind: 'phone', phone };
  return { kind: 'none' };
}

export interface ResolvedPeer {
  entity: Api.User;
  /** true, если пришлось импортировать контакт — его надо удалить после переписки. */
  imported: boolean;
}

/** Найти peer нашего же аккаунта, чтобы можно было ему написать. */
export async function resolveWarmupPeer(
  client: TelegramClient,
  target: { tg_username: string | null; phone: string | null },
): Promise<ResolvedPeer | null> {
  const strategy = chooseResolutionStrategy(target);
  if (strategy.kind === 'none') return null;

  if (strategy.kind === 'username') {
    const entity = await client.getEntity(strategy.username);
    return entity instanceof Api.User ? { entity, imported: false } : null;
  }

  const res = await client.invoke(new Api.contacts.ImportContacts({
    contacts: [new Api.InputPhoneContact({
      clientId: bigInt(Date.now()) as unknown as never,
      phone: strategy.phone,
      firstName: 'Kolya',
      lastName: '',
    })],
  }));
  const user = res.users.find((u): u is Api.User => u instanceof Api.User);
  return user ? { entity: user, imported: true } : null;
}

/** Убрать импортированный контакт. Диалог при этом остаётся доступным. */
export async function dropImportedContact(
  client: TelegramClient,
  entity: Api.User,
): Promise<void> {
  await client.invoke(new Api.contacts.DeleteContacts({ id: [entity] }));
}
