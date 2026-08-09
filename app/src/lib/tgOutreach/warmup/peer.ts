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
import { withTimeout } from '../withTimeout';

/**
 * Отдельные лимиты на каждый способ найти собеседника.
 *
 * Раньше таймаут в 60 секунд стоял снаружи всего resolveWarmupPeer — из-за
 * этого запасной путь через телефон никогда не срабатывал: если username
 * зависал в мобильном прокси, внешний таймер убивал функцию до перехода к
 * телефону, и переписка падала целиком (07.08.2026 — 7 подряд провалов дня 4).
 *
 * Теперь каждая попытка под своим таймером. Username-резолв в норме отвечает
 * за секунды; 20 секунд — с запасом на медленный прокси, но не столько, чтобы
 * съесть всё окно. Оставшихся 40 секунд хватает импорту контакта, который
 * возит по MTProto больше данных.
 */
// Функции, а не константы: тестам нужно подставить своё значение, а константа
// читается один раз при импорте модуля и уже не меняется.
function usernameTimeoutMs(): number {
  return Number(process.env.TG_WARMUP_RESOLVE_USERNAME_TIMEOUT_MS) || 20_000;
}
function phoneTimeoutMs(): number {
  return Number(process.env.TG_WARMUP_RESOLVE_PHONE_TIMEOUT_MS) || 40_000;
}

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

/**
 * Кому можно отправлять.
 *
 * `Api.User` приходит от свежего резолва, `Api.InputPeerUser` — собранный из
 * запомненных `tg_user_id` и `access_hash` (см. `peerCache.ts`). Для отправки
 * годятся оба, а вот удалять контакт есть смысл только у первого: запомненный
 * peer означает, что контакт давно убран.
 */
export interface ResolvedPeer {
  entity: Api.User | Api.InputPeerUser;
  /** true, если пришлось импортировать контакт — его надо удалить после переписки. */
  imported: boolean;
}

/**
 * Резолв по @username отдельным RPC, а не через client.getEntity.
 *
 * getEntity сначала лезет в кэш сущностей сессии и достраивает InputUser из
 * него. На загруженных чужих сессиях кэш бывает неполным: gramJS получает
 * undefined и падает внутри себя с «Cannot read properties of undefined
 * (reading 'classType')» — ровно это словил прогрев 06.08.2026, и переписка
 * ушла в failed. Явный ResolveUsername ходит в Telegram и кэш не спрашивает.
 */
async function resolveByUsername(
  client: TelegramClient,
  username: string,
): Promise<ResolvedPeer | null> {
  const res = await withTimeout(
    client.invoke(new Api.contacts.ResolveUsername({ username })),
    usernameTimeoutMs(),
    'резолв @username',
  );
  const user = res.users.find((u): u is Api.User => u instanceof Api.User);
  return user ? { entity: user, imported: false } : null;
}

async function resolveByPhone(
  client: TelegramClient,
  phone: string,
): Promise<ResolvedPeer | null> {
  const res = await withTimeout(
    client.invoke(new Api.contacts.ImportContacts({
      contacts: [new Api.InputPhoneContact({
        clientId: bigInt(Date.now()) as unknown as never,
        phone,
        firstName: 'Kolya',
        lastName: '',
      })],
    })),
    phoneTimeoutMs(),
    'импорт телефона',
  );
  const user = res.users.find((u): u is Api.User => u instanceof Api.User);
  return user ? { entity: user, imported: true } : null;
}

/**
 * Найти peer нашего же аккаунта, чтобы можно было ему написать.
 *
 * Если username не сработал, а телефон известен — пробуем импорт контакта.
 * Способы независимы: сбой одного не повод терять переписку, ради которой
 * шестнадцать аккаунтов уже подключились.
 */
export async function resolveWarmupPeer(
  client: TelegramClient,
  target: { tg_username: string | null; phone: string | null },
): Promise<ResolvedPeer | null> {
  const strategy = chooseResolutionStrategy(target);
  if (strategy.kind === 'none') return null;

  const phone = normalizePhone(target.phone);

  if (strategy.kind === 'username') {
    try {
      const peer = await resolveByUsername(client, strategy.username);
      if (peer) return peer;
    } catch (e) {
      // Телефона нет — рассказать о проблеме больше некому, пробрасываем.
      if (!phone) throw e;
    }
    return phone ? resolveByPhone(client, phone) : null;
  }

  return resolveByPhone(client, strategy.phone);
}

/** Убрать импортированный контакт. Диалог при этом остаётся доступным. */
export async function dropImportedContact(
  client: TelegramClient,
  entity: Api.User | Api.InputPeerUser,
): Promise<void> {
  // Удалять есть что только у свежего резолва: запомненный peer собран из чисел
  // и контактом никогда не был.
  if (!(entity instanceof Api.User)) return;
  await client.invoke(new Api.contacts.DeleteContacts({ id: [entity] }));
}
