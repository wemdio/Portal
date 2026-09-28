/**
 * Существует ли ник в Telegram — по публичной странице t.me, без наших аккаунтов.
 *
 * На «юзернейм не найден» Telegram отвечает в двух разных случаях: ника нет
 * вовсе, или наш аккаунт заморожен и не видит живых людей. По ответу самого
 * аккаунта их не различить, а ошибка дорога в обе стороны. 24–28.09.2026 четыре
 * мёртвых ника в хвосте базы ATOL-1 отправили на суточную паузу все 50
 * аккаунтов кампании как «замороженные». А в начале сентября замороженные
 * аккаунты той же кампании списали из очереди 68 живых людей как
 * несуществующих.
 *
 * Страница t.me/<ник> отвечает про ник независимо от наших аккаунтов: у
 * существующего там профиль с именем (`tgme_page_title`), у несуществующего —
 * пустая заглушка с заголовком «Telegram: Contact @ник». Сверка по истории
 * ATOL-1: из ников, которым ушли письма, на t.me нашлись 39 из 40; из висевших
 * в очереди мёртвыми — 0 из 6; из списанных замороженными аккаунтами — 68 из 70.
 *
 * Страница неофициальная, и её вид Telegram может поменять в любой день. Поэтому
 * каждая проверка начинается с двух контрольных ников — заведомо живого и
 * заведомо несуществующего. Не совпал хоть один — проверка считается сломанной и
 * отвечает «не знаю» про всех: вызывающие откатываются к прежней логике, а не
 * выкидывают живых людей из очереди.
 */

export type TmeVerdict = 'exists' | 'missing' | 'unknown';

/** Причина пропуска контакта, чей ник t.me не знает. Терминальная: в очередь такой не возвращается. */
export const NICK_MISSING_REASON = 'ника нет в Telegram — проверено по t.me';

export interface TmeCheck {
  /** Контрольные ники дали ожидаемый ответ — вердиктам можно верить. */
  working: boolean;
  /** Ник в нижнем регистре → вердикт. При `working: false` все `unknown`. */
  verdicts: Map<string, TmeVerdict>;
}

/** Официальный канал Telegram — существует, пока существует сам Telegram. */
const CONTROL_ALIVE = 'telegram';

const REQUEST_TIMEOUT_MS = 10_000;
/** Между запросами: t.me отвечает быстро, но очередь из сотен подряд — повод для ограничения. */
const PAUSE_MS = 300;
/**
 * Столько «не знаю» подряд — и дальше не спрашиваем: так выглядит ограничение
 * частоты или обрыв сети, и оставшиеся запросы только продлят бан.
 */
const MAX_UNKNOWN_STREAK = 3;
/**
 * Ответы помним полчаса. Ник, который не нашёл один аккаунт, в том же круге
 * пробует следующий — второй раз спрашивать t.me про него незачем.
 */
const CACHE_TTL_MS = 30 * 60_000;

const cache = new Map<string, { verdict: Exclude<TmeVerdict, 'unknown'>; at: number }>();

/**
 * Разбор страницы t.me. Чистая функция — вся логика вердикта здесь.
 *
 * «Не существует» признаём только по положительному признаку — узнаваемой
 * заглушке с заголовком-адресом. Капча, страница провайдера, пустой ответ,
 * новая вёрстка — всё это «не знаю», а не «ника нет»: иначе любой сбой сети
 * превращался бы в список «несуществующих» живых людей.
 */
export function classifyTmePage(status: number, html: string, username: string): TmeVerdict {
  if (status !== 200 || !html || !html.includes('class="tgme_page"')) return 'unknown';
  if (html.includes('class="tgme_page_title"')) return 'exists';
  const ogTitle = /<meta property="og:title" content="([^"]*)"/i.exec(html)?.[1] ?? '';
  if (ogTitle.trim().toLowerCase() === `telegram: contact @${username.toLowerCase()}`) return 'missing';
  return 'unknown';
}

export function normalizeNick(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

/** Ник, которого заведомо нет: 20 случайных символов после буквы. */
function randomMissingNick(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tail = '';
  for (let i = 0; i < 20; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `zq${tail}`;
}

async function fetchVerdict(username: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<TmeVerdict> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://t.me/${encodeURIComponent(username)}`, {
      // Язык фиксируем: по заголовку заглушки узнаём несуществующий ник, а
      // перевод страницы его бы сломал.
      headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' },
      signal: ctrl.signal,
    });
    return classifyTmePage(res.status, await res.text(), username);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkUsernamesOnTme(
  usernames: string[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; pauseMs?: number; now?: () => number } = {},
): Promise<TmeCheck> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const now = opts.now ?? Date.now;

  const nicks = Array.from(new Set(usernames.map(normalizeNick).filter(Boolean)));
  const verdicts = new Map<string, TmeVerdict>(nicks.map((n) => [n, 'unknown']));

  // Свежие ответы берём из памяти: их получили, когда контрольные ники сошлись.
  const toAsk: string[] = [];
  for (const nick of nicks) {
    const cached = cache.get(nick);
    if (cached && now() - cached.at < CACHE_TTL_MS) verdicts.set(nick, cached.verdict);
    else toAsk.push(nick);
  }
  if (!toAsk.length) return { working: true, verdicts };

  const alive = await fetchVerdict(CONTROL_ALIVE, fetchImpl, timeoutMs);
  const missing = alive === 'exists' ? await fetchVerdict(randomMissingNick(), fetchImpl, timeoutMs) : 'unknown';
  if (alive !== 'exists' || missing !== 'missing') {
    return { working: false, verdicts: new Map(nicks.map((n) => [n, 'unknown'])) };
  }

  let unknownStreak = 0;
  let asked = 0;
  for (const nick of toAsk) {
    if (unknownStreak >= MAX_UNKNOWN_STREAK) break;
    if (asked > 0 && pauseMs > 0) await sleep(pauseMs);
    asked++;

    const verdict = await fetchVerdict(nick, fetchImpl, timeoutMs);
    verdicts.set(nick, verdict);
    if (verdict === 'unknown') {
      unknownStreak++;
    } else {
      unknownStreak = 0;
      cache.set(nick, { verdict, at: now() });
    }
  }
  return { working: true, verdicts };
}

const lastDownReportAt = new Map<string, number>();

/**
 * Говорить ли вслух, что проверка через t.me не работает.
 *
 * Если сервер не видит t.me, это будет на каждом вызове, а журнал от
 * одинаковых строк бесполезен. Раз в час на каждого слушателя (кампанию,
 * фоновую проверку) — достаточно, чтобы заметить, и один не съедает
 * предупреждение другого.
 */
export function shouldReportTmeDown(key: string, nowMs = Date.now()): boolean {
  if (nowMs - (lastDownReportAt.get(key) ?? 0) < 60 * 60_000) return false;
  lastDownReportAt.set(key, nowMs);
  return true;
}
