/**
 * ENG-ветка роутов чёрного списка клиента (`GET/POST /api/client/blocklist`,
 * `DELETE /api/client/blocklist/[id]`) — экран «Do not contact» английского
 * кабинета (`app/client/eng/do-not-contact`).
 *
 * Хранилище то же, что у RU-страницы «Чёрный список»: `client_blocked_contacts`
 * в БД рассыльщика, скоуп `client_user_id`, точный нормализованный адрес
 * (`normalizeBlockedEmail`). Читают его те же фильтры: запуск шаблона
 * (`hypothesisEngine/launchTemplate.ts`, шаг 5a — Launch, «Launch N more
 * markets», достройка долга) и ночной долив
 * (`hypothesisEngine/stages/baseCollectRefill.ts`, шаг 4, плюс повтор внутри
 * `appendLeadsToClientCampaign` прямо перед загрузкой). Оба читают список
 * клиента из пресета (`client_campaign_presets.client_user_id`), а пресет
 * ENG-клиента записан на него самого (`engSendingPreset.ts`) — значит, адрес,
 * добавленный здесь, выпадает из каждой загрузки, которая прочитала список
 * после добавления. Запуск читает его ОДИН раз, в начале (шаг 5a), и грузит
 * лидов через минуты (после классификатора сегментов): адрес, добавленный,
 * пока запуск уже идёт, в этот запуск ещё может попасть. Экран говорит это
 * клиенту так же.
 *
 * ЛЮДИ, КОТОРЫЕ УЖЕ ЛЕЖАТ В КАМПАНИИ. Сама ветка рассыльщика не зовёт никогда.
 * Снятие с идущих кампаний клиента (решение владельца 14.10.2026) — модуль
 * `hypothesisEngine/engDncRemoval.ts`, за выключателем HE_ENG_DNC_REMOVE (по
 * умолчанию выключен). Выключен — POST, GET и DELETE ведут себя как до него
 * (ответ POST несёт `removal: 'off'`, GET — `in_campaign_removal: 'off'`), ни
 * одного запроса в его таблицы. Включён — POST до вставки пишет заявку, после
 * вставки раскладывает её по кампаниям клиента (или оставляет воркеру; идёт
 * запуск клиента — ещё раз после него) и отвечает, что вышло (`removal`,
 * `removal_campaigns`, `removal_after_launch`,
 * `removal_skipped_reply_campaign`); снимает лидов воркер
 * hypothesis-engine; GET отдаёт, сколько адресов ждут проверки и сколько снять
 * не удалось (только то, с чем клиент ещё может что-то сделать); DELETE
 * отменяет ждущие и неудавшиеся строки убранного адреса.
 *
 * ЗАБЛОКИРОВАННЫЙ АККАУНТ (отметка he_eng_account_blocks, engAccountBlock):
 * POST и DELETE отказывают 403 тем же текстом, что рыночный гейт кабинета
 * (apiGuards.requireEngMarket, ENG_ACCOUNT_BLOCKED_TEXT) — для сессии,
 * пережившей блокировку (отзыв сессий не лёг). Список не меняется, заявок
 * снятия с кампаний нет. Отметка не прочиталась — 503, ничего не записано;
 * таблицы нет (миграция 20261013_0001) — как до блокировки. GET открыт: он
 * ничего не меняет и не тратит. Строки, которые лежали в очереди снятия до
 * блокировки, воркер не трогает, пока отметка стоит (engDncRemoval,
 * runHeEngDncRemovalPass).
 *
 * Отличия от RU-ветки (она не меняется ни на байт, развилка — `auth.market`):
 *  - тексты английские: RU-фраза дошла бы до кабинета общим «problem on our
 *    side» (engErrorText режет кириллицу), и клиент не узнал бы причину;
 *  - добавление пачкой — разбор вставленного текста здесь, на сервере, одним
 *    правилом; домены и мусор не добавляются и возвращаются примерами;
 *  - потолок списка (BLOCKLIST_MAX_ENTRIES) держится строго: вставка, пересчёт
 *    и откат своих строк, если список перерос потолок. Список длиннее потолка
 *    getBlockedEmailSet не читает вовсе — запуск и долив этого клиента тогда
 *    отказывают (fail-closed), поэтому перерасти его пачкой нельзя. Гарантии
 *    «никогда» нет: при сбое отката или потерянном ответе вставки (и у
 *    RU-ветки — гонкой двух вкладок) список может оказаться длиннее; тогда
 *    экран держит постоянную строку об этом (EngDoNotContact), добавление
 *    отвечает list_over_limit, а страницы читаются и дальше 10 000;
 *  - список постранично с точным счётом и поиском: у PostgREST есть потолок
 *    строк ответа (ради него и написан RPC client_blocklist_snapshot, см. его
 *    миграцию 20260901_0001), и `.limit(10000)` RU-ветки за ним показал бы
 *    часть списка как весь.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BLOCKLIST_MAX_ENTRIES,
  normalizeBlockedEmail,
} from '@/lib/clientBlocklist/blockedContacts';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ENG_ACCOUNT_BLOCKED_TEXT, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { contactHost, normalizeBlockedDomain, parseBlockedEntry } from '@/lib/clientBlocklist/blockedDomains';
import { heEngDncDomainsEnabled } from '@/lib/hypothesisEngine/engRolloutFlags';
import { readHeEngAccountBlock } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import {
  heEngDncRemovalView,
  openHeEngDncIntent,
  readHeEngDncSummary,
  releaseHeEngDncAddress,
  settleHeEngDncIntent,
  type HeEngDncAddOutcome,
} from '@/lib/hypothesisEngine/engDncRemoval';

/** Строк на странице списка. */
export const ENG_BLOCKLIST_PAGE_SIZE = 100;
/** Разных адресов в одной вставке. */
export const ENG_BLOCKLIST_MAX_PER_ADD = 1_000;
/** Символов во вставленном тексте: 1 000 адресов с именами и запятыми влезают с запасом. */
export const ENG_BLOCKLIST_MAX_TEXT = 200_000;
/** Примеров недобавленного в ответе (остальное — числом). */
const EXAMPLES_MAX = 10;
const EXAMPLE_CHARS = 80;
/** id в одном `in(...)` отката: 100 uuid — около 4 КБ строки запроса. */
const ROLLBACK_ID_CHUNK = 100;
/** Строк в одной вставке (см. engBlocklistPost). */
const INSERT_CHUNK = 100;
const SEARCH_MAX_CHARS = 320;

const MAX_TEXT = BLOCKLIST_MAX_ENTRIES.toLocaleString('en-US');
const PER_ADD_TEXT = ENG_BLOCKLIST_MAX_PER_ADD.toLocaleString('en-US');

export const ENG_BLOCKLIST_TEXT = {
  loadFailed: 'Could not load your list. Try again in a minute.',
  badRequest: 'The request could not be read. Refresh the page and try again.',
  empty: 'Paste at least one email address.',
  // Срабатывает по числу символов, а не адресов: 700 строк выгрузки CRM с
  // колонками уже длиннее потолка, поэтому совет — про текст, а не «≤ 1 000».
  tooLong: 'This is too much text to add at once. Paste only the email addresses, or fewer rows at a time.',
  tooMany: (n: number) =>
    `You pasted ${n.toLocaleString('en-US')} different addresses. Add at most ${PER_ADD_TEXT} at a time.`,
  listFull:
    `Your list already holds ${MAX_TEXT} entries, the most it can hold. ` +
    'Remove entries you no longer need to add new ones.',
  // Список уже длиннее потолка (сбой отката или потерянный ответ вставки):
  // число — настоящее, а не «10 000», и сказано, что это значит для кампаний.
  listOverLimit: (count: number) =>
    `Your list holds ${count.toLocaleString('en-US')} entries, more than the ${MAX_TEXT} it can hold, ` +
    'so nothing was added. ' +
    `Until you remove at least ${(count - BLOCKLIST_MAX_ENTRIES).toLocaleString('en-US')}, ` +
    'no new contacts are added to your campaigns.',
  overLimit: (room: number) =>
    `These would take your list over ${MAX_TEXT} entries, the most it can hold, so none of them were added. ` +
    `You can add up to ${room.toLocaleString('en-US')} more, or remove entries you no longer need.`,
  addFailed: 'Could not add these entries, and none of them were added. Try again in a minute.',
  // Экран после этого кода сам перечитывает список (reload) — отсюда «below».
  addUnconfirmed:
    'Could not finish adding these entries, and some of them may be on your list now. ' +
    'Check your list below. ' +
    `While it holds more than ${MAX_TEXT} entries, no new contacts are added to your campaigns.`,
  overLimitStuck:
    `Your list went over ${MAX_TEXT} entries, the most it can hold, and we could not undo it. ` +
    `No new contacts are added to your campaigns until you remove entries to bring it back to ${MAX_TEXT} or fewer.`,
  removeFailed: 'Could not remove this entry. Try again in a minute.',
  // Домены компаний (kind 'domains', план 2026-10-16-eng-countries, §1B).
  emptyDomains: 'Paste at least one company domain.',
  tooManyDomains: (n: number) =>
    `You pasted ${n.toLocaleString('en-US')} different domains. Add at most ${PER_ADD_TEXT} at a time.`,
  domainsUnavailable: 'Blocking whole companies by domain is not available yet.',
  // Тот же текст, что у рыночного гейта кабинета (apiGuards.requireEngMarket).
  unavailable: 'Service temporarily unavailable — refresh the page',
} as const;

/**
 * Машинный код отказа добавления. Экран читает три из них: после
 * `add_unconfirmed`, `over_limit_stuck` и `list_over_limit` он перечитывает
 * список — состав после ответа неизвестен или список длиннее потолка, и экран
 * должен показать его настоящий размер.
 */
export type EngBlocklistAddCode =
  | 'account_blocked'
  | 'unavailable'
  | 'domains_unavailable'
  | 'not_eng_market'
  | 'bad_request'
  | 'empty'
  | 'too_long'
  | 'too_many'
  | 'list_full'
  | 'list_over_limit'
  | 'over_limit'
  | 'add_failed'
  | 'add_unconfirmed'
  | 'over_limit_stuck';

interface EngBlockedRow {
  id: string;
  email: string;
  created_at: string;
}

interface Rejected {
  count: number;
  examples: string[];
}

export interface EngBlocklistPaste {
  /** Разные нормализованные адреса, в порядке вставки. */
  emails: string[];
  /**
   * Сайт, домен или шаблон с явным признаком: `@acme.com`, `*@acme.com`,
   * `info*@acme.com`, `https://acme.com`, `www.acme.com`, `acme.com/about`.
   * Слово с точкой без такого признака (`acme.com`, `Jane.Doe`, `report.pdf`)
   * сюда НЕ попадает — оно «не адрес», утверждать, что клиент вставил домен,
   * нечем.
   */
  domains: Rejected;
  /** Всё прочее непустое: имена, обрывки, адреса без домена, слова с точкой. */
  invalid: Rejected;
}

/** Обёртки вокруг адреса из почтовых клиентов и таблиц: `<a@b.com>`, `"a@b.com",`, `(a@b.com).` */
const WRAP_HEAD_RE = /^[<>()[\]{}"'`]+/;
const WRAP_TAIL_RE = /[<>()[\]{}"'`.,:;]+$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Разделители токенов. `<` и `>` — тоже: `Jane<jane@acme.com>` без пробела даёт два токена. */
const SPLIT_RE = /[\s,;<>]+/;

/**
 * Невидимые символы формата (категория Cf: U+200B из Slack, U+FEFF, мягкий
 * перенос, метки направления). Строка с таким символом на экране выглядит как
 * адрес лида, но не совпадёт с ним никогда (filterBlockedLeads сравнивает
 * точные строки), — поэтому они вырезаются до разбора.
 */
const FORMAT_CHARS_RE = /\p{Cf}/gu;

/**
 * Ссылка mailto: адрес — до `?` (дальше subject/body/cc ссылки), в
 * процент-кодировке (RFC 6068). Ссылка заменяется самим адресом до разбивки на
 * токены, так что `mailto:a@x.com,b@y.com?subject=Hi` даёт два адреса.
 */
const MAILTO_RE = /mailto:([^\s<>"'`()[\]{}]*)/gi;

function mailtoAddresses(_link: string, rest: string): string {
  const addresses = rest.split('?')[0];
  try {
    return ` ${decodeURIComponent(addresses)} `;
  } catch {
    // Битая %-последовательность: как есть — дальше её разберёт общее правило.
    return ` ${addresses} `;
  }
}

/**
 * Форма адреса, которую список принимает, поверх `normalizeBlockedEmail` (его
 * EMAIL_RE пропускает `<`, `?`, кавычки и прочее в домене — такая строка не
 * совпала бы ни с одним лидом, а клиенту было бы сказано «добавлено»).
 * Локальная часть — буквы, цифры и atext-символы RFC 5322 без `*` (шаблон
 * разбирается раньше); домен — метки из букв, цифр и дефиса и буквенная зона
 * (или punycode `xn--`). Всё, что сюда не прошло, — «не адрес». Принятая
 * строка проходит и `normalizeBlockedEmail`, поэтому читатели списка
 * (getBlockedEmailSet) её примут.
 */
const ADDRESS_RE =
  /^[\p{L}\p{M}\p{N}!#$%&'+\/=?^_`{|}~.-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+(?:\p{L}[\p{L}\p{M}]{1,62}|xn--[a-z0-9-]+)$/u;

function pushExample(target: Rejected, seen: Set<string>, raw: string) {
  const key = raw.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.count += 1;
  if (target.examples.length < EXAMPLES_MAX) {
    target.examples.push(raw.length > EXAMPLE_CHARS ? `${raw.slice(0, EXAMPLE_CHARS)}…` : raw);
  }
}

/**
 * Шаблон со звёздочкой в локальной части (`*@acme.com`, `info*@acme.com`).
 * `normalizeBlockedEmail` такой токен ПРИНЯЛ бы как адрес, и в список легла бы
 * строка, которая не совпадёт ни с одним лидом, — клиент считал бы домен
 * закрытым. Поэтому шаблон разбирается раньше адреса.
 */
const WILDCARD_LOCAL_RE = /^[^@]*\*[^@]*@/;

/**
 * Сайт, домен или шаблон вместо адреса — только с явным признаком: `@` без
 * локальной части, звёздочка в локальной части, схема (`https://`), `www.` или
 * путь после домена. Голое слово с точкой (`acme.com`, `Jane.Doe`,
 * `report.pdf`) признака не несёт и уходит в «не адрес».
 */
function looksLikeDomain(token: string): boolean {
  const lower = token.toLowerCase();
  const at = lower.indexOf('@');
  if (at >= 0) {
    if (at > 0 && !WILDCARD_LOCAL_RE.test(lower)) return false;
    return DOMAIN_RE.test(lower.slice(at + 1).split(/[/?#]/)[0]);
  }
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(lower);
  const rest = scheme ? lower.slice(scheme[0].length) : lower;
  const pathAt = rest.search(/[/?#]/);
  const host = pathAt >= 0 ? rest.slice(0, pathAt) : rest;
  const marked = scheme !== null || pathAt >= 0 || host.startsWith('www.');
  return marked && DOMAIN_RE.test(host);
}

/**
 * Разбор вставленного текста: сначала вырезаются невидимые символы формата и
 * ссылки mailto заменяются адресами; разделители — пробелы, переводы строк,
 * запятые, точки с запятой, `<` и `>`. Адрес проходит тем же
 * `normalizeBlockedEmail`, что и фильтры запуска и долива, и вдобавок
 * консервативной формой ADDRESS_RE. Повторы считаются один раз.
 */
export function parseEngBlocklistPaste(text: string): EngBlocklistPaste {
  const emails: string[] = [];
  const seenEmails = new Set<string>();
  const domains: Rejected = { count: 0, examples: [] };
  const invalid: Rejected = { count: 0, examples: [] };
  const seenDomains = new Set<string>();
  const seenInvalid = new Set<string>();
  const prepared = text.replace(FORMAT_CHARS_RE, '').replace(MAILTO_RE, mailtoAddresses);
  for (const piece of prepared.split(SPLIT_RE)) {
    const token = piece.replace(WRAP_HEAD_RE, '').replace(WRAP_TAIL_RE, '');
    if (!token) continue;
    const normalized = WILDCARD_LOCAL_RE.test(token) ? null : normalizeBlockedEmail(token);
    const email = normalized && ADDRESS_RE.test(normalized) ? normalized : null;
    if (email) {
      if (!seenEmails.has(email)) {
        seenEmails.add(email);
        emails.push(email);
      }
    } else if (looksLikeDomain(token)) {
      pushExample(domains, seenDomains, token);
    } else {
      pushExample(invalid, seenInvalid, token);
    }
  }
  return { emails, domains, invalid };
}

export interface EngBlocklistDomainsPaste {
  /** Разные домены (normalizeBlockedDomain: хост как набран, punycode), в порядке вставки. */
  domains: string[];
  /** Не хост: обрывки, IP, localhost, без зоны. */
  invalid: Rejected;
  /** Личная почта (gmail.com, outlook.com…): компанией не закрывается. */
  personal: Rejected;
  /** Не домен компании: публичный суффикс, соцсеть, конструктор сайтов. */
  notCompany: Rejected;
  /**
   * Добавленные поддомены (shop.acme.com) — добавляются как набраны, а
   * примеры — подсказка добавить домен компании (`subdomainOf`).
   */
  subdomains: Rejected;
}

/**
 * Разбор вставки «Company domains»: та же чистка, что у адресов (символы
 * формата, mailto, обёртки, разделители), затем каждый токен —
 * normalizeBlockedDomain (blockedDomains.ts): адрес даёт свой домен, ссылка —
 * свой хост. Повторы считаются один раз.
 */
export function parseEngBlocklistDomains(text: string): EngBlocklistDomainsPaste {
  const domains: string[] = [];
  const seenDomains = new Set<string>();
  const invalid: Rejected = { count: 0, examples: [] };
  const personal: Rejected = { count: 0, examples: [] };
  const notCompany: Rejected = { count: 0, examples: [] };
  const subdomains: Rejected = { count: 0, examples: [] };
  const seenRejected = new Set<string>();
  const seenSubdomains = new Set<string>();
  const prepared = text.replace(FORMAT_CHARS_RE, '').replace(MAILTO_RE, mailtoAddresses);
  for (const piece of prepared.split(SPLIT_RE)) {
    const token = piece.replace(WRAP_HEAD_RE, '').replace(WRAP_TAIL_RE, '');
    if (!token) continue;
    const parsed = normalizeBlockedDomain(token);
    if (parsed.ok) {
      if (seenDomains.has(parsed.domain)) continue;
      seenDomains.add(parsed.domain);
      domains.push(parsed.domain);
      if (parsed.subdomainOf) pushExample(subdomains, seenSubdomains, parsed.domain);
      continue;
    }
    // Личный и «не компания» — примером хост (gmail.com), а не каждый адрес
    // целиком: клиенту важно, какой домен не принят. Мусор — как вставлен.
    if (parsed.refused === 'invalid') pushExample(invalid, seenRejected, token);
    else pushExample(parsed.refused === 'personal' ? personal : notCompany, seenRejected, contactHost(token) ?? token);
  }
  return { domains, invalid, personal, notCompany, subdomains };
}

function refusal(code: EngBlocklistAddCode, error: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

/**
 * Отказ мутации заблокированному аккаунту (шапка, «Заблокированный аккаунт»):
 * 403 'account_blocked' — отметка активна; 503 'unavailable' — отметка не
 * прочиталась или основной БД нет («не прочитали» не превращается в «можно»);
 * null — можно (отметки нет, снята, или таблицы нет). Одно чтение по ключу.
 */
async function engBlocklistBlockRefusal(
  portalDb: SupabaseClient | null,
  userId: string,
  op: 'add' | 'remove',
): Promise<NextResponse | null> {
  const block = portalDb
    ? await readHeEngAccountBlock(portalDb, userId)
    : ({ state: 'error', detail: 'portal db is not configured', code: null } as const);
  if (block.state === 'blocked') return refusal('account_blocked', ENG_ACCOUNT_BLOCKED_TEXT, 403);
  if (block.state === 'error') {
    await logError(
      'client.blocklist.eng_block_read_failed',
      new Error(block.detail.slice(0, 300)),
      { op },
      { userId },
    );
    return refusal('unavailable', ENG_BLOCKLIST_TEXT.unavailable, 503);
  }
  return null;
}

/** `%`, `_` и `\` из строки поиска — буквально, а не шаблоном ilike. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Точный счёт списка клиента (с `q` — только адресов с этой подстрокой); null — не прочитался. */
async function countList(db: SupabaseClient, userId: string, q = ''): Promise<number | null> {
  let query = db
    .from('client_blocked_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('client_user_id', userId);
  if (q) query = query.ilike('email', `%${likeLiteral(q)}%`);
  const { count, error } = await query;
  return error || typeof count !== 'number' ? null : count;
}

/** Доменных записей ('@' + хост) в списке клиента; null — не прочитался. */
async function countDomains(db: SupabaseClient, userId: string): Promise<number | null> {
  const { count, error } = await db
    .from('client_blocked_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('client_user_id', userId)
    .like('email', '@%');
  return error || typeof count !== 'number' ? null : count;
}

/** Откат строк, вставленных этим запросом. true — удалены все. */
async function rollbackInserted(db: SupabaseClient, userId: string, ids: string[]): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < ids.length; i += ROLLBACK_ID_CHUNK) {
    const { error } = await db
      .from('client_blocked_contacts')
      .delete()
      .eq('client_user_id', userId)
      .in('id', ids.slice(i, i + ROLLBACK_ID_CHUNK));
    if (error) ok = false;
  }
  return ok;
}

/**
 * GET (ENG): страница списка, свежие сверху. `?offset=` — с какой строки,
 * `?q=` — часть адреса. `total` — весь список, `matching` — под поиском.
 * Снятие с идущих кампаний (engDncRemoval.readHeEngDncSummary):
 * `in_campaign_removal` 'off' | 'on'; `pending` — сколько разных адресов ждут
 * проверки кампаний, `failed` — скольких снять не удалось (адрес ещё в списке,
 * кампания ещё в записях клиента и шлёт или может слать), `failed_examples` —
 * до 10 таких адресов, `failed_at_least` — `failed` нижняя граница; null —
 * выключено или не прочиталось. `portalDb` — основная БД (его таблицы); по
 * умолчанию supabaseAdmin.
 */
export async function engBlocklistGet(
  req: NextRequest,
  db: SupabaseClient,
  userId: string,
  portalDb: SupabaseClient | null = supabaseAdmin,
): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const rawOffset = Number(params.get('offset') ?? 0);
  // Без потолка 10 000: список, переросший потолок (см. шапку), обязан
  // листаться до конца — иначе «Show more» за 10 000 отдавал бы ту же страницу.
  // Смещение за концом — PGRST103 ниже, пустая страница.
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, SEARCH_MAX_CHARS);

  let page = db
    .from('client_blocked_contacts')
    .select('id, email, created_at', { count: 'exact' })
    .eq('client_user_id', userId);
  if (q) page = page.ilike('email', `%${likeLiteral(q)}%`);
  const [pageRes, total] = await Promise.all([
    page
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + ENG_BLOCKLIST_PAGE_SIZE - 1),
    q ? countList(db, userId) : Promise.resolve(null),
  ]);

  // Строка, с которой просили страницу, исчезла (удаления между страницами):
  // PostgREST отвечает PGRST103 — это пустая страница, а не сбой, и счёт тогда
  // читается отдельно.
  const pastEnd = pageRes.error?.code === 'PGRST103';
  const matching =
    pageRes.error && !pastEnd
      ? null
      : !pastEnd && typeof pageRes.count === 'number'
        ? pageRes.count
        : await countList(db, userId, q);
  const listTotal = q ? total : matching;
  if (matching === null || listTotal === null) {
    await logError(
      'client.blocklist.eng_list_failed',
      pageRes.error ?? new Error('не прочитался счёт списка'),
      { searching: q.length > 0 },
      { userId },
    );
    return NextResponse.json({ error: ENG_BLOCKLIST_TEXT.loadFailed }, { status: 500 });
  }

  // Строка — адрес или домен компании ('@' + хост, план 2026-10-16-eng-countries,
  // §1B): `kind` и `value` (домен — без '@'); `email` — сырьё, как раньше.
  const items = (pastEnd ? [] : ((pageRes.data ?? []) as EngBlockedRow[])).map((row) => {
    const entry = parseBlockedEntry(row.email);
    return entry?.kind === 'domain'
      ? { ...row, kind: 'domain' as const, value: entry.domain }
      : { ...row, kind: 'email' as const, value: entry?.email ?? row.email };
  });
  const nextOffset = offset + items.length;
  return NextResponse.json({
    items,
    total: listTotal,
    matching,
    offset,
    next_offset: items.length > 0 && nextOffset < matching ? nextOffset : null,
    // Доменов во всём списке (без поиска); null — счёт не прочитался (страница
    // от этого не падает: число — подпись «N entries · M domains»).
    domains_total: await countDomains(db, userId),
    // Добавление доменов открыто (HE_ENG_DNC_DOMAINS): экран показывает
    // переключатель «Company domains» только при true.
    domains_enabled: heEngDncDomainsEnabled(),
    ...(await readHeEngDncSummary(portalDb, db, userId)),
  });
}

/** id события ответа (Block на Replies): bigint, как у курсора Replies. */
const REPLY_ID_RE = /^\d{1,15}$/;

/**
 * POST (ENG): добавить вставленный текст. Body: `{ text: string, reply_id?: string,
 * kind?: 'emails' | 'domains' }`. `kind` нет или 'emails' — адреса, как раньше;
 * 'domains' — домены компаний (engBlocklistPostDomains, свой порядок проверок).
 *
 * `reply_id` — только у «Block» на Replies: id ответа (instantly_activity_events),
 * на карточке которого нажали, и ровно один адрес в `text` (иначе 400
 * bad_request). Используется только снятием с кампаний (включённым): кампанию
 * этого ответа не проверяют — она перестала писать человеку, когда он ответил
 * (engDncRemoval, шапка п. 3b). Чужой id ничего не даёт: его кампания не в
 * записях клиента. Список и его тексты от `reply_id` не зависят.
 *
 * Порядок: разбор → потолок по текущему счёту → вставка частями без
 * перезаписи (`ignoreDuplicates`: вернутся только новые строки) → пересчёт →
 * если список перерос BLOCKLIST_MAX_ENTRIES или пересчёт не прочитался, откат
 * своих новых строк. Уже стоявшие адреса не трогаются ни вставкой, ни откатом.
 * Сбой части вставки — откат известных строк и пересчёт: «ничего не
 * добавлено» (add_failed) отвечается, только когда откат прошёл и пересчёт
 * показал прежний размер списка.
 *
 * Снятие с идущих кампаний (engDncRemoval.ts): до вставки — заявка
 * (openHeEngDncIntent), после — её разворот или удаление
 * (settleHeEngDncIntent, исход — engAddOutcome). Успешный ответ добавления
 * дописывается ПОСЛЕ разворота и несёт `removal` (heEngDncRemovalView):
 * 'off' — выключено; 'none_running' — кампаний у клиента нет; 'removing' —
 * адреса разложены по `removal_campaigns` кампаниям, воркер их проверяет;
 * 'deferred' — кампании сейчас не прочитались, разложит воркер;
 * 'not_scheduled' — заявка не записалась, кампании не проверяются, пока
 * адреса не добавят ещё раз. К ним `removal_after_launch` — у клиента идёт
 * запуск, и его кампании проверятся ещё раз, когда он кончится, и
 * `removal_skipped_reply_campaign` — кампания ответа (Block) не проверяется.
 * Отказы (4xx/5xx) — тела S4 без этих полей. Заблокированный аккаунт —
 * первым делом, до разбора тела (engBlocklistBlockRefusal).
 */
export async function engBlocklistPost(
  req: NextRequest,
  db: SupabaseClient,
  userId: string,
  portalDb: SupabaseClient | null = supabaseAdmin,
): Promise<NextResponse> {
  // Тело читается до отметки блокировки, но ветка адресов отвечает в прежнем
  // порядке: сначала блокировка, потом нечитаемое тело. Ветка доменов —
  // выключатель и рыночный гейт раньше всего остального (engBlocklistPostDomains).
  let body: { text?: unknown; reply_id?: unknown; kind?: unknown };
  let bodyOk = true;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
    bodyOk = false;
  }
  if (bodyOk && body && typeof body === 'object' && body.kind === 'domains') {
    return engBlocklistPostDomains(body, db, userId, portalDb);
  }

  const blocked = await engBlocklistBlockRefusal(portalDb, userId, 'add');
  if (blocked) return blocked;

  if (!bodyOk || !body || typeof body !== 'object' || typeof body.text !== 'string') {
    return refusal('bad_request', ENG_BLOCKLIST_TEXT.badRequest, 400);
  }
  if (body.kind !== undefined && body.kind !== null && body.kind !== 'emails') {
    return refusal('bad_request', ENG_BLOCKLIST_TEXT.badRequest, 400);
  }
  const replyId = body.reply_id === undefined || body.reply_id === null ? null : body.reply_id;
  if (replyId !== null && (typeof replyId !== 'string' || !REPLY_ID_RE.test(replyId))) {
    return refusal('bad_request', ENG_BLOCKLIST_TEXT.badRequest, 400);
  }
  if (body.text.length > ENG_BLOCKLIST_MAX_TEXT) {
    return refusal('too_long', ENG_BLOCKLIST_TEXT.tooLong, 400);
  }

  const paste = parseEngBlocklistPaste(body.text);
  if (paste.emails.length === 0 && paste.domains.count === 0 && paste.invalid.count === 0) {
    return refusal('empty', ENG_BLOCKLIST_TEXT.empty, 400);
  }
  if (paste.emails.length > ENG_BLOCKLIST_MAX_PER_ADD) {
    return refusal('too_many', ENG_BLOCKLIST_TEXT.tooMany(paste.emails.length), 400);
  }
  // Block шлёт ровно один адрес; ответ относится только к нему.
  if (replyId !== null && paste.emails.length > 1) {
    return refusal('bad_request', ENG_BLOCKLIST_TEXT.badRequest, 400);
  }
  if (paste.emails.length === 0) {
    return NextResponse.json({
      added: 0,
      already_listed: 0,
      domains: paste.domains,
      invalid: paste.invalid,
      total: null,
    });
  }

  const intent = await openHeEngDncIntent({ portalDb, userId, emails: paste.emails, replyId });
  const res = await engBlocklistAddParsed(db, userId, paste);
  const settle = await settleHeEngDncIntent(intent, await engAddOutcome(res), { portalDb, instantlyDb: db });
  if (res.status < 200 || res.status >= 300) return res;
  // Что сказать про кампании, известно только после разворота: дописываем.
  const view = heEngDncRemovalView(intent, settle);
  let addedBody: Record<string, unknown>;
  try {
    addedBody = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return res;
  }
  return NextResponse.json(
    {
      ...addedBody,
      removal: view.removal,
      removal_campaigns: view.campaigns,
      removal_after_launch: view.afterLaunch,
      removal_skipped_reply_campaign: view.skippedReplyCampaign,
    },
    { status: res.status },
  );
}

/** Примеров в аудите добавления доменов (домены компаний — не персональные данные). */
const DOMAINS_AUDIT_SAMPLE = 20;

/**
 * POST (ENG), `kind: 'domains'` — домены компаний в «Do not contact» (план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, §1B). Запись —
 * `'@' + хост` в той же колонке email, source 'manual'.
 *
 * Порядок проверок — до разбора текста и до любой записи:
 *  1. выключатель HE_ENG_DNC_DOMAINS — выключен: 400 'domains_unavailable';
 *  2. requireEngMarket по профилю (не по хосту запроса: `auth.market` берётся
 *     из хоста, и RU-клиент на ENG-хосте попал бы сюда; RU-запуск HE при сбое
 *     чтения списка идёт без списка вовсе — launchTemplate.ts, путь «как до
 *     порта», — поэтому доменная строка в RU-списке недопустима); отказ — его
 *     статус (403/503), ничего не записано;
 *  3. отметка блокировки аккаунта (engBlocklistBlockRefusal), как у адресов.
 * Дальше — та же механика вставки и те же коды отказов, что у адресов
 * (engBlocklistInsertEntries). Заявки снятия с кампаний нет: люди этих компаний,
 * уже стоящие в идущих кампаниях, в них остаются (экран говорит это). Ответ:
 * `{kind:'domains', added, already_listed, invalid, personal, not_company,
 * subdomains, total}`, где invalid/personal/not_company/subdomains — `{count,
 * examples}`.
 */
async function engBlocklistPostDomains(
  body: { text?: unknown; reply_id?: unknown },
  db: SupabaseClient,
  userId: string,
  portalDb: SupabaseClient | null,
): Promise<NextResponse> {
  if (!heEngDncDomainsEnabled()) {
    return refusal('domains_unavailable', ENG_BLOCKLIST_TEXT.domainsUnavailable, 400);
  }
  if (!portalDb) return refusal('unavailable', ENG_BLOCKLIST_TEXT.unavailable, 503);
  const market = await requireEngMarket(portalDb, userId);
  if (!market.ok) {
    const code: EngBlocklistAddCode =
      market.failure.status === 503
        ? 'unavailable'
        : market.failure.message === ENG_ACCOUNT_BLOCKED_TEXT
          ? 'account_blocked'
          : 'not_eng_market';
    return refusal(code, market.failure.message, market.failure.status);
  }
  const blocked = await engBlocklistBlockRefusal(portalDb, userId, 'add');
  if (blocked) return blocked;

  if (typeof body.text !== 'string') return refusal('bad_request', ENG_BLOCKLIST_TEXT.badRequest, 400);
  // Block на Replies — только адрес человека, не компания.
  if (body.reply_id !== undefined && body.reply_id !== null) {
    return refusal('bad_request', ENG_BLOCKLIST_TEXT.badRequest, 400);
  }
  if (body.text.length > ENG_BLOCKLIST_MAX_TEXT) {
    return refusal('too_long', ENG_BLOCKLIST_TEXT.tooLong, 400);
  }

  const paste = parseEngBlocklistDomains(body.text);
  if (
    paste.domains.length === 0
    && paste.invalid.count === 0
    && paste.personal.count === 0
    && paste.notCompany.count === 0
  ) {
    return refusal('empty', ENG_BLOCKLIST_TEXT.emptyDomains, 400);
  }
  if (paste.domains.length > ENG_BLOCKLIST_MAX_PER_ADD) {
    return refusal('too_many', ENG_BLOCKLIST_TEXT.tooManyDomains(paste.domains.length), 400);
  }
  const rejectedFields = {
    invalid: paste.invalid,
    personal: paste.personal,
    not_company: paste.notCompany,
    subdomains: paste.subdomains,
  };
  if (paste.domains.length === 0) {
    return NextResponse.json({ kind: 'domains', added: 0, already_listed: 0, ...rejectedFields, total: null });
  }

  const inserted = await engBlocklistInsertEntries(db, userId, paste.domains.map((d) => `@${d}`));
  if (!inserted.ok) return inserted.response;
  const { insertedIds, after } = inserted;
  const alreadyListed = paste.domains.length - insertedIds.length;

  if (insertedIds.length > 0) {
    await logAudit(
      'client.blocklist.eng_domains_added',
      'ENG-клиент добавил домены компаний в «Do not contact»',
      {
        added: insertedIds.length,
        alreadyListed,
        total: after,
        sample: paste.domains.slice(0, DOMAINS_AUDIT_SAMPLE),
      },
      { userId },
    );
  }

  return NextResponse.json(
    { kind: 'domains', added: insertedIds.length, already_listed: alreadyListed, ...rejectedFields, total: after },
    { status: insertedIds.length > 0 ? 201 : 200 },
  );
}

/**
 * Исход добавления для заявки снятия: ответ 2xx — адреса запроса в списке;
 * 400 и add_failed — доказанно ничего не добавлено; прочее (add_unconfirmed,
 * over_limit_stuck, нечитаемый ответ) — состав неизвестен.
 */
async function engAddOutcome(res: NextResponse): Promise<HeEngDncAddOutcome> {
  if (res.status >= 200 && res.status < 300) return 'added';
  if (res.status === 400) return 'nothing_added';
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return body?.code === 'add_failed' ? 'nothing_added' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Вставка разобранных адресов — порядок в докблоке engBlocklistPost. */
async function engBlocklistAddParsed(
  db: SupabaseClient,
  userId: string,
  paste: EngBlocklistPaste,
): Promise<NextResponse> {
  const inserted = await engBlocklistInsertEntries(db, userId, paste.emails);
  if (!inserted.ok) return inserted.response;
  const { insertedIds, after } = inserted;

  if (insertedIds.length > 0) {
    await logAudit(
      'client.blocklist.eng_added',
      'ENG-клиент добавил адреса в «Do not contact»',
      { added: insertedIds.length, alreadyListed: paste.emails.length - insertedIds.length, total: after },
      { userId },
    );
  }

  return NextResponse.json(
    {
      added: insertedIds.length,
      already_listed: paste.emails.length - insertedIds.length,
      domains: paste.domains,
      invalid: paste.invalid,
      total: after,
    },
    { status: insertedIds.length > 0 ? 201 : 200 },
  );
}

/**
 * Механика вставки, общая для адресов и доменов ('@' + хост): счёт до →
 * потолок → вставка частями без перезаписи → пересчёт → откат своих строк при
 * переросте потолка. Отказ — готовый ответ; успех — id новых строк и размер
 * списка после.
 */
async function engBlocklistInsertEntries(
  db: SupabaseClient,
  userId: string,
  entries: string[],
): Promise<{ ok: false; response: NextResponse } | { ok: true; insertedIds: string[]; after: number }> {
  const fail = (response: NextResponse) => ({ ok: false as const, response });
  const before = await countList(db, userId);
  if (before === null) {
    await logError('client.blocklist.eng_add_failed', new Error('не прочитался счёт списка до вставки'), {}, { userId });
    return fail(refusal('add_failed', ENG_BLOCKLIST_TEXT.addFailed, 500));
  }
  if (before > BLOCKLIST_MAX_ENTRIES) {
    return fail(refusal('list_over_limit', ENG_BLOCKLIST_TEXT.listOverLimit(before), 400));
  }
  if (before === BLOCKLIST_MAX_ENTRIES) {
    return fail(refusal('list_full', ENG_BLOCKLIST_TEXT.listFull, 400));
  }

  // Вставка частями по INSERT_CHUNK строк: RETURNING каждой части заведомо
  // меньше потолка строк ответа PostgREST, значит, id вернутся ВСЕ — откат ниже
  // держится на этом. Сбой части — откат уже вставленных частей.
  const insertedIds: string[] = [];
  for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
    const { data, error } = await db
      .from('client_blocked_contacts')
      .upsert(
        entries
          .slice(i, i + INSERT_CHUNK)
          .map((email) => ({ client_user_id: userId, email, reason: null, source: 'manual' })),
        { onConflict: 'client_user_id,email', ignoreDuplicates: true },
      )
      .select('id');
    if (error || !Array.isArray(data)) {
      // Строки прошлых частей известны по id — откатываются. Сама сбойная
      // часть могла и записаться (ответ потерян после commit) — её id
      // неизвестны, удалять по адресу нельзя (снесли бы адреса, стоявшие в
      // списке раньше). Поэтому — пересчёт: прежний размер после отката значит
      // «ничего не добавлено»; список длиннее потолка — over_limit_stuck (запуски
      // и долив клиента теперь отказывают); иначе состав неизвестен —
      // add_unconfirmed, экран перечитает список.
      const rolledBack = insertedIds.length === 0 || (await rollbackInserted(db, userId, insertedIds));
      const now = await countList(db, userId);
      await logError(
        'client.blocklist.eng_add_failed',
        error ?? new Error('вставка не вернула строк'),
        { inserted: insertedIds.length, rolledBack, before, now },
        { userId },
      );
      if (now !== null && now > BLOCKLIST_MAX_ENTRIES) {
        return fail(refusal('over_limit_stuck', ENG_BLOCKLIST_TEXT.overLimitStuck, 500));
      }
      return fail(
        rolledBack && now === before
          ? refusal('add_failed', ENG_BLOCKLIST_TEXT.addFailed, 500)
          : refusal('add_unconfirmed', ENG_BLOCKLIST_TEXT.addUnconfirmed, 500),
      );
    }
    for (const row of data as { id: string }[]) insertedIds.push(row.id);
  }

  const after = await countList(db, userId);
  if (after === null || after > BLOCKLIST_MAX_ENTRIES) {
    const rolledBack = insertedIds.length === 0 || (await rollbackInserted(db, userId, insertedIds));
    await logError(
      'client.blocklist.eng_add_rolled_back',
      new Error(
        after === null
          ? 'не прочитался счёт списка после вставки'
          : `список перерос ${BLOCKLIST_MAX_ENTRIES}: ${after}`,
      ),
      { inserted: insertedIds.length, rolledBack },
      { userId },
    );
    if (after === null) {
      return fail(
        rolledBack
          ? refusal('add_failed', ENG_BLOCKLIST_TEXT.addFailed, 500)
          : refusal('add_unconfirmed', ENG_BLOCKLIST_TEXT.addUnconfirmed, 500),
      );
    }
    if (!rolledBack) return fail(refusal('over_limit_stuck', ENG_BLOCKLIST_TEXT.overLimitStuck, 500));
    // Размер без своих строк: другая вкладка могла за это время дописать
    // столько, что список и без нас длиннее потолка, — тогда число настоящее.
    const without = after - insertedIds.length;
    if (without > BLOCKLIST_MAX_ENTRIES) {
      return fail(refusal('list_over_limit', ENG_BLOCKLIST_TEXT.listOverLimit(without), 400));
    }
    const room = BLOCKLIST_MAX_ENTRIES - without;
    return fail(
      room > 0
        ? refusal('over_limit', ENG_BLOCKLIST_TEXT.overLimit(room), 400)
        : refusal('list_full', ENG_BLOCKLIST_TEXT.listFull, 400),
    );
  }

  return { ok: true, insertedIds, after };
}

/**
 * DELETE (ENG): тот же скоуп, что у RU-ветки; чужой id даёт removed: 0.
 * Снятие с кампаний включено — ждущие и неудавшиеся строки убранного адреса
 * отменяются (engDncRemoval.releaseHeEngDncAddress; выключено — без запроса).
 * Заблокированный аккаунт — отказ до удаления (engBlocklistBlockRefusal).
 */
export async function engBlocklistDelete(
  db: SupabaseClient,
  userId: string,
  id: string,
  portalDb: SupabaseClient | null = supabaseAdmin,
): Promise<NextResponse> {
  const blocked = await engBlocklistBlockRefusal(portalDb, userId, 'remove');
  if (blocked) return blocked;

  const { data, error } = await db
    .from('client_blocked_contacts')
    .delete()
    .eq('id', id)
    .eq('client_user_id', userId)
    .select('email');

  if (error) {
    await logError('client.blocklist.remove_failed', error, { id }, { userId });
    return NextResponse.json({ error: ENG_BLOCKLIST_TEXT.removeFailed }, { status: 500 });
  }

  const removed = (data ?? []).length;
  if (removed > 0) {
    const email = (data as { email: string }[])[0]?.email;
    const entry = parseBlockedEntry(email);
    if (entry?.kind === 'domain') {
      // Домен компании: свой аудит; заявок снятия с кампаний у доменов нет
      // (добавление их не открывает), отменять нечего.
      await logAudit('client.blocklist.eng_domain_removed', 'ENG-клиент убрал домен компании из «Do not contact»', {
        domain: entry.domain,
      }, { userId });
    } else {
      await logAudit('client.blocklist.removed', 'Client unblocked a contact', { email }, { userId });
      await releaseHeEngDncAddress({ portalDb, userId, email });
    }
  }
  return NextResponse.json({ removed });
}
