import { domainToASCII } from 'node:url';
import { checkSyntax, isFreeProvider } from '@/lib/emailValidation/shared';
import { isBlockedTechnicalEmailDomain } from '@/lib/companiesDirectory/contactPolicy';
import { isVeTwoGisMarkedRow, VE_TWO_GIS_ROW_FIELD } from './twoGisMarker';
import { veTwoGisSiteDomain } from './twoGisRows';

/**
 * Ящики строк 2ГИС (план 26.10, R3 часть 3в). Только VE2: в модуль сборщика Ш5 (twoGisRows.ts)
 * почта и проверки адресов не идут. Правило Сергея, п.5 (26.10): все опубликованные ящики на
 * сайте — свои и бесплатные; не хостеры/регистраторы, не чужие компании; адреса не составляем.
 * Отсюда: вердикт — только по происхождению адреса; статус проверки (_email_status) не ставится
 * и не повышается; остаётся подмножество найденных адресов, новый адрес не строится никогда.
 */

/** Почта хостингов и регистраторов: адрес на их домене — ящик площадки, не компании (и на своём домене). Не tilda.ws:
 * info@dvor.tilda.ws на dvor.tilda.ws — свой. */
export const VE_TWO_GIS_HOSTING_MAIL_DOMAINS: readonly string[] = ['timeweb.ru', 'timeweb.com', 'beget.com', 'beget.ru', 'beget.tech',
  'reg.ru', 'nic.ru', 'r01.ru', 'sweb.ru', 'spaceweb.ru', 'masterhost.ru', 'jino.ru', 'sprinthost.ru', 'hostiman.ru', 'mchost.ru',
  'ucoz.ru', 'ucoz.net', 'nethouse.ru', 'tilda.cc', 'wix.com'];
// Бесплатная почта сверх общего списка (yandex.by и yandex.kz в нём уже есть).
const EXTRA_FREE = ['narod.ru', 'tut.by'];
const onDomain = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);

export type VeTwoGisMailboxVerdict = 'invalid' | 'artifact' | 'hosting' | 'technical' | 'own' | 'free' | 'foreign';

/**
 * Происхождение адреса относительно сайта карточки, по порядку: синтаксис (IDN — через punycode, как в
 * проверке адресов); артефакт разбора (%xx, слипшийся телефон); хостинг/регистратор; технический домен;
 * свой (тот же домен сайта, его поддомен, поддомен конструктора); бесплатная почта; иначе — чужой.
 */
export function veTwoGisMailboxVerdict(email: unknown, website: unknown): VeTwoGisMailboxVerdict {
  const value = String(email ?? '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return 'invalid';
  const local = value.slice(0, at);
  const domain = domainToASCII(value.slice(at + 1)) || value.slice(at + 1);
  if (!checkSyntax(`${local}@${domain}`).valid) return 'invalid';
  if (/%[0-9a-f]{2}/i.test(value) || /^\+?(?:\d[()-]?){10,}[a-z]/.test(local)) return 'artifact';
  if (VE_TWO_GIS_HOSTING_MAIL_DOMAINS.some((root) => onDomain(domain, root))) return 'hosting';
  if (isBlockedTechnicalEmailDomain(domain)) return 'technical';
  const own = veTwoGisSiteDomain(website);
  if (own && veTwoGisSiteDomain(domain) === own) return 'own';
  if (isFreeProvider(domain) || EXTRA_FREE.includes(domain)) return 'free';
  return 'foreign';
}

/**
 * Ящики строк 2ГИС по компании (card_id метки, иначе домен сайта): остаются строки со своим или
 * бесплатным ящиком — без изменений. Ни одного — одна строка без почты и без _email_status: в шлюз
 * и выдачу она не идёт, а card_id уходит в noMailbox — журнал закрывает домен для линии гипотезы
 * (rejected, no_published_mailbox: с этого сайта контакта нет, навсегда для линии). Прочие строки —
 * на месте; без строк 2ГИС — тот же массив. Порядок — входной.
 * В журнал noMailbox пишется только для обойдённых сайтов (завершившийся конструктор), все найденные
 * адреса которых чужие, хостинга, технические или артефакты. Карточки, у которых конструктор адреса
 * не нашёл (validate_emails отбрасывает такие строки), не журналируются и остаются доступными: у
 * find_emails нет итога обхода по строке, и таймаут не отличить от «ящика нет» (D3).
 */
export function admitVeTwoGisMailboxes<T extends Record<string, unknown>>(rows: T[]): { rows: T[]; noMailbox: string[] } {
  if (!rows.some(isVeTwoGisMarkedRow)) return { rows, noMailbox: [] };
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!isVeTwoGisMarkedRow(row)) return;
    const marker = row[VE_TWO_GIS_ROW_FIELD] as { card_id?: unknown } | undefined;
    const card = typeof marker?.card_id === 'string' && marker.card_id.trim() ? marker.card_id : null;
    const key = card ? `card:${card}` : `site:${veTwoGisSiteDomain(row.website) ?? `row:${index}`}`;
    groups.set(key, [...groups.get(key) ?? [], index]);
  });
  const keep = new Map<number, T>();
  const noMailbox: string[] = [];
  for (const indices of groups.values()) {
    const good = indices.filter((index) => ['own', 'free'].includes(veTwoGisMailboxVerdict(rows[index].email, rows[index].website)));
    if (good.length) { for (const index of good) keep.set(index, rows[index]); continue; }
    const first = { ...rows[indices[0]], email: '' } as Record<string, unknown>;
    delete first._email_status;
    keep.set(indices[0], first as T);
    const marker = rows[indices[0]][VE_TWO_GIS_ROW_FIELD] as { card_id?: unknown } | undefined;
    if (typeof marker?.card_id === 'string' && marker.card_id.trim()) noMailbox.push(marker.card_id);
  }
  return { rows: rows.flatMap((row, index) => !isVeTwoGisMarkedRow(row) ? [row] : keep.has(index) ? [keep.get(index)!] : []), noMailbox };
}
