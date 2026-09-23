import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch, Pool, ProxyAgent, type Dispatcher } from 'undici';
import { getProxyGroups, pickProxyUrl, tryAcquireProxySlot } from '@/lib/enrich/proxyPool';
import { ProviderUsageWriteError } from '@/lib/providerUsage';
import { VeOperationTimeoutError, withVeDeadline } from './operationDeadline';
import { deriveWebsiteFromEmail } from '@/lib/leadBoard/deriveWebsite';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { normalizeVeCompanyInn, normalizeVeCompanyName } from './collectionIdentity';
import { parseVeEvidencePage, rankVeEvidenceLinks, selectVeEvidenceText, type VeEvidencePage } from './relevancePage';
import { veSearchProviderFailure, VeSearchProviderError, VE_RELEVANCE_SEARCH_OPERATION_TIMEOUT_MS, type VeSearchProviderFailure } from './relevanceSearch';
import { readVeSearchCache, searchVeRelevanceWebsitesCached } from './relevanceSearchCache';
import { createVeSharedPageReader, focusVeCompanyFact, freshVeCompanyFact, readVeCompanyFacts,
  veCompanyFactKey, veFactPageKey, writeVeCompanyFacts } from './companyFacts';

export interface VeRelevanceEvidence {
  status: 'ok' | 'unavailable' | 'error';
  text: string;
  url: string;
  reason: string;
  provider_error?: VeSearchProviderFailure;
  /** A cache miss postponed by acquisition policy, never a negative verdict. */
  search_deferred?: true;
  /** Телеметрия: была ли страница, не ответившая за 5 с, или кончился общий
   * дедлайн (120 с). Ярлык `website_evidence_timeout` ставится уже, чем это
   * поле: только если молчит стартовая страница собственного сайта компании
   * или истёк общий дедлайн. Молчание найденного поиском чужого домена или
   * внутренней страницы уже прочитанного сайта повтор не лечит, и ярлык там
   * окончательный. Поле читает только журнал длительностей, в чекпойнт и в
   * документ базы оно не попадает. */
  timeout?: 'page' | 'deadline';
  /** Сколько страниц было прочитано (включая неудачные попытки). */
  pages?: number;
  /** Телеметрия RU-прокси; в чекпойнт не попадает. attempts — все GET через
   * прокси, rescued — своя главная открылась через прокси, а прямой повтор в
   * том же окне не ответил, verified — компания получила готовый текст с сайта,
   * страницу которого принёс прокси, denied — не хватило пропуска. */
  proxy?: { attempts: number; rescued: number; verified: number; denied: number };
}

/** direct — с нашего адреса (США), proxy — второй заход через RU-прокси. */
export type VeEvidenceRoute = 'direct' | 'proxy';
type VeProxyStart = 'silent' | 'blocked' | 'slow';

export interface VeRelevanceEvidenceOptions {
  signal?: AbortSignal;
  companyInn?: string;
  companyName?: string;
  companyAddress?: string;
  /** Корпоративный адрес компании: его домен — бесплатный кандидат на сайт. */
  companyEmail?: string;
  focus?: string;
  allowPaidSearch?: boolean;
  /** Trusted offline adapters; never selected from user/source data. */
  fetchText?: (url: string) => Promise<string>;
  fetchPage?: (url: string, signal: AbortSignal, route?: VeEvidenceRoute) => Promise<VeEvidencePage>;
  search?: (query: string, signal: AbortSignal) => Promise<SerperOrganicItem[]>;
  searchCache?: typeof readVeSearchCache;
  companyFacts?: { read: typeof readVeCompanyFacts; write: typeof writeVeCompanyFacts };
}

// Includes the shared search queue, one bounded search and website reads.
const TOTAL_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 5_000;
// Оба дедлайна приходят одним классом ошибки; различает их только label.
// Константы, чтобы строка не разъехалась между постановкой и разбором.
const PAGE_DEADLINE_LABEL = 'relevance evidence page';
const TOTAL_DEADLINE_LABEL = 'relevance website evidence';
const MAX_BODY_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 6_000;
const MAX_PAGE_READS = 10;
const MAX_PAGE_RETRIES = 2;
const MAX_DOMAINS = 3;
// Через прокси на компанию: своя главная и не больше двух страниц реквизитов
// того же сайта, если главная открылась только так или только на повторе
// после молчания. Главные ИНН владельца почти не печатают (0 из 17 в замере),
// без реквизитов спасённая главная подтверждается только брендом.
const MAX_PROXY_READS = 3;
// CONNECT к прокси undici не отменяет вместе с запросом: без своего предела
// соединение с прокси висело бы до его ответа (до 300 с) уже после возврата
// пропуска. Здесь оно живёт не дольше постраничного предела с запасом.
const PROXY_CONNECT_TIMEOUT_MS = 6_000;
const PROXY_CONNECTIONS_PER_NODE = 6;
// Готовый туннель после чтения переходит к пулу сайта и вне лимита выше жил бы
// по подсказке Keep-Alive сайта (до 600 с). Держим его не дольше секунды.
const PROXY_TUNNEL_IDLE_MS = 1_000;

function allowedUrl(value: string): URL | null {
  try {
    if (value.length > 1_000) return null;
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))
      || isIP(host) || host.startsWith('[') || !host.includes('.')
      || /(^|\.)(localhost|local|internal)$/.test(host)) return null;
    url.hostname = host;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

export function veOfficialWebsiteCandidates(raw: string): URL[] {
  const candidates = new Map<string, URL>();
  // A multi-value cell may contain emails, labels and several websites. Never
  // extract the domain from an email or repair a URL containing credentials.
  for (const token of raw.trim().split(/[\s,;|]+/).slice(0, 20)) {
    const candidate = token.replace(/^["'(<]+|["')>.]+$/g, '');
    if (!candidate || candidate.includes('@')) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) continue;
    const parsed = allowedUrl(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (parsed && !DIRECTORY_HOST.test(parsed.hostname) && !candidates.has(siteHost(parsed))) candidates.set(siteHost(parsed), parsed);
    if (candidates.size >= MAX_DOMAINS) break;
  }
  return [...candidates.values()];
}

function siteHost(url: URL): string { return url.hostname.replace(/^www\./, ''); }
const DIRECTORY_HOST = /(?:^|\.)(?:rusprofile\.ru|list-org\.com|saby\.ru|sbis\.ru|spark-interfax\.ru|companium\.ru|checko\.ru|zachestnyibiznes\.ru|egrul\.nalog\.ru|2gis\.ru|yandex\.ru|google\.com|vk\.com|ok\.ru|hh\.ru|headhunter\.ru|superjob\.ru|rabota\.ru|t\.me|instagram\.com|facebook\.com|prodoctorov\.ru|zoon\.ru|companies\.rbc\.ru|check\.tochka\.com|e-ecolog\.ru|xfirm\.ru|tbank\.ru|ruspeach\.com)$/i;

/** No-INN discovery needs the complete brand in the site's own title AND a
 * geographic clue from the original source. Search snippets cannot verify it. */
function discoveredNameMatches(pages: VeEvidencePage[], name: string, address: string): boolean {
  const brand = normalizeVeCompanyName(name);
  const distinctive = brand.split(' ').filter((word) => word.length >= 4
    && !/^(агентство|недвижимости|компания|группа|компаний|центр|риэлтор|риелтор|сервис|услуги)$/.test(word));
  const geo = address.toLowerCase().match(/[\p{L}]{4,}/gu)?.filter((word) =>
    !/^(россия|область|район|город|улица|проспект|республика|край|russia|region)$/.test(word)) ?? [];
  const titles = pages.map((page) => ` ${normalizeVeCompanyName(page.title)} `).join(' ');
  const text = normalizeVeCompanyName(pages.map((page) => page.text).join(' '));
  return distinctive.length > 0 && geo.length > 0 && titles.includes(` ${brand} `)
    && geo.some((word) => (` ${text} `).includes(` ${word} `));
}
function sameOriginLinks(page: VeEvidencePage): VeEvidencePage['links'] {
  return page.links.filter((link) => {
    const url = allowedUrl(link.url);
    return url?.origin === new URL(page.url).origin && !/\.(?:pdf|jpg|jpeg|png|zip|docx?)$/i.test(url.pathname);
  });
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

/** Сообщение вместе с кодом и причиной: fetch из undici пишет в message
 * только «fetch failed», а ECONNREFUSED и ошибки сертификата — в cause. */
function failureText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' ');
}
/** Сайт ответил сам: HTTP-статус, чужой редирект, не-HTML или слишком большая страница. */
function siteAnswered(error: unknown): boolean {
  return /website_(?:blocked_http_\d+|content_unavailable|transient_http_\d+|redirect_unavailable|content_too_large)/.test(failureText(error));
}
/** Отказ по нашему адресу: RU-сайты так отвечают адресам из США. */
function blockedByAddress(error: unknown): boolean {
  return /website_blocked_http_(?:403|429)/.test(failureText(error));
}
/** Сертификат или TLS: повтор даст тот же отказ. */
const TLS_FAILURE = /\bEPROTO\b|CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_VERIFY|SELF_SIGNED/;
/** Хост недоступен на уровне соединения: нет DNS, отказ, сломанный TLS. */
function connectionFailure(error: unknown): boolean {
  const text = failureText(error);
  return /\b(?:ENOTFOUND|ENODATA|ECONNREFUSED)\b|website_address_unavailable/.test(text) || TLS_FAILURE.test(text);
}

function transientPageFailure(error: unknown): boolean {
  // undici пишет «fetch failed» и для сертификата: такой отказ не повторяем,
  // иначе быстрые мёртвые домены съедают повторы молчащего своего сайта.
  if (TLS_FAILURE.test(failureText(error))) return false;
  return error instanceof VeOperationTimeoutError || error instanceof Error
    && /website_transient_http_(?:408|500|502|503|504)|\b(?:EAI_AGAIN|ETIMEOUT|ETIMEDOUT|ESERVFAIL|ECONNRESET|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|fetch failed|network error/i.test(error.message);
}

/** Website DNS must not occupy the OS lookup pool used by database/provider
 * connections. A per-read resolver is cancellable when the page deadline ends;
 * timed-out sites cannot leave background lookups blocking unrelated work.
 * Only these checked IPv4 answers may be used by the pinned HTTP connection.
 */
export async function resolveVeEvidenceAddress(hostname: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 1_500, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const addresses = await resolver.resolve4(hostname);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((address) => !publicIpv4(address))) {
      throw new Error('website_address_unavailable');
    }
    return addresses[0];
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

/** Narrow static-page reader. The shared website parser follows unchecked
 * redirects and crawls extra pages, so it is deliberately not used here.
 * Each hop validates its URL and DNS answers, then connects to a pinned public
 * IPv4 address; neither DNS rebinding nor a redirect can reach a private host.
 */
async function fetchEvidencePage(initialUrl: URL, signal: AbortSignal, focus?: string, proxy?: Dispatcher): Promise<VeEvidencePage> {
  let current = initialUrl;
  for (let hop = 0; hop <= 3; hop += 1) {
    const checked = allowedUrl(current.href);
    if (!checked) throw new Error('website_address_unavailable');
    const pinned = await resolveVeEvidenceAddress(checked.hostname, signal);
    // Через прокси адрес разрешает сам прокси, закрепить IP нельзя. Наш
    // резолвер всё равно обязан вернуть публичный адрес, иначе не идём.
    const dispatcher = proxy ?? new Agent({
      connect: {
        family: 4,
        lookup: (_hostname, options, callback) => callback(null,
          options.all ? [{ address: pinned, family: 4 }] : pinned, 4),
      },
    });
    try {
      const response = await fetch(current.href, {
        dispatcher, signal, redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PortalWebsiteEvidence/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
          'Accept-Language': 'ru,en;q=0.7',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location ? allowedUrl(new URL(location, current).href) : null;
        const sameSite = next?.hostname.replace(/^www\./, '') === initialUrl.hostname.replace(/^www\./, '');
        if (!next || !sameSite || hop === 3 || (current.protocol === 'https:' && next.protocol !== 'https:')) {
          throw new Error('website_redirect_unavailable');
        }
        current = next;
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)\b/i.test(contentType) || !response.body) {
        await response.body?.cancel();
        if ([408, 500, 502, 503, 504].includes(response.status)) throw new Error(`website_transient_http_${response.status}`);
        if (response.status === 403 || response.status === 429) throw new Error(`website_blocked_http_${response.status}`);
        throw new Error('website_content_unavailable');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) throw new Error('website_content_too_large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      return parseVeEvidencePage(Buffer.concat(chunks), current.href, contentType, focus);
    } finally {
      // Destroy also aborts late/incomplete bodies; do not keep per-site sockets.
      // Прокси-диспетчер общий на процесс (proxyPool) — его не трогаем.
      if (!proxy) await dispatcher.destroy();
    }
  }
  throw new Error('website_redirect_unavailable');
}

const sharedPageReader = createVeSharedPageReader((url, signal) => fetchEvidencePage(url, signal));
// Свои диспетчеры к тем же нодам пула, а не общие из proxyPool: только здесь
// у CONNECT есть предел времени и числа соединений к ноде.
const proxyAgents = new Map<string, Dispatcher>();
function evidenceProxyDispatcher(): Dispatcher | undefined {
  const uri = pickProxyUrl(true);
  if (!uri) return undefined;
  let agent = proxyAgents.get(uri);
  if (!agent) {
    try {
      agent = new ProxyAgent({
        uri, keepAliveTimeout: PROXY_TUNNEL_IDLE_MS, keepAliveMaxTimeout: PROXY_TUNNEL_IDLE_MS,
        clientFactory: (origin, options) => new Pool(origin,
          { ...options, connections: PROXY_CONNECTIONS_PER_NODE, headersTimeout: PROXY_CONNECT_TIMEOUT_MS }),
      });
    } catch {
      return undefined;
    }
    proxyAgents.set(uri, agent);
  }
  return agent;
}
// Отдельный экземпляр: прямой и проксированный полёт одного адреса не сливаются.
const proxyPageReader = createVeSharedPageReader(async (url, signal) => {
  const proxy = evidenceProxyDispatcher();
  if (!proxy) throw new Error('website_proxy_unavailable');
  return fetchEvidencePage(url, signal, undefined, proxy);
});

/** Bounded official-site evidence: 10 pages + at most 2 transient retries,
 * one search, 120 seconds including queue/metering. Each URL can be retried at
 * most once. One own start page per company may instead get its second try as
 * a direct retry raced against the RU proxy in the same 5-second window; that
 * try spends a retry but is not blocked by retries other domains used up.
 * At most 3 proxied GETs per company: the own start page and, when it opened
 * only through the proxy or only on a retry after silence, two identity pages
 * of the same site.
 * Search snippets are discovery only. With a known INN, every selected domain
 * must confirm that sole INN on its own pages before any activity is returned.
 * Unavailable, conflicting or unverified identity always stays needs_review.
 */
export async function fetchVeRelevanceEvidence(
  website: string,
  opts: VeRelevanceEvidenceOptions = {},
): Promise<VeRelevanceEvidence> {
  opts.signal?.throwIfAborted();
  const inn = normalizeVeCompanyInn(opts.companyInn);
  const supplied = veOfficialWebsiteCandidates(website);
  // У 17.8% строк резерва сайта нет вовсе — им платный поиск покупается без
  // единой бесплатной попытки. Но у трети из них корпоративная почта на своём
  // домене, а домен корпоративной почты и есть сайт компании. Кандидат
  // проходит те же проверки безопасности и ту же проверку владения, что и
  // сайт из источника: он лишь даёт шанс подтвердиться бесплатно.
  if (!supplied.length) {
    const domain = deriveWebsiteFromEmail(opts.companyEmail);
    if (domain) supplied.push(...veOfficialWebsiteCandidates(`https://${domain}`));
  }
  const nameSearch = Boolean(opts.companyName?.trim() && opts.companyAddress?.trim());
  const factKey = veCompanyFactKey({ inn, company: opts.companyName, address: opts.companyAddress });
  // Offline adapters never touch the real cache unless explicitly provided.
  const factStore = opts.companyFacts ?? (!opts.fetchPage && !opts.fetchText && !opts.search
    ? { read: readVeCompanyFacts, write: writeVeCompanyFacts } : undefined);
  const cachedPages = new Map<string, VeEvidencePage>();
  if (factKey && factStore) {
    for (const record of await factStore.read([factKey], opts.signal)) {
      if (record.company_key !== factKey) continue;
      const page = freshVeCompanyFact(record);
      const url = page && allowedUrl(page.url);
      if (page && url && !DIRECTORY_HOST.test(url.hostname)) cachedPages.set(veFactPageKey(page.url), page);
    }
    // Recover the confirmed company website without buying another search.
    // Раньше память фактов подключалась только при ПУСТОМ website: компания с
    // сайтом из реестра, который не печатает ИНН, шла покупать поиск заново,
    // хотя её подтверждённая страница уже лежала в памяти (30 суток). В память
    // попадают только страницы с подтверждённой личностью, поэтому добавлять
    // их к указанным доменам безопасно — они лишь дают шанс подтвердиться
    // бесплатно, а проверка владения остаётся прежней.
    for (const page of cachedPages.values()) {
      const url = allowedUrl(page.url)!;
      if (!supplied.some((other) => siteHost(other) === siteHost(url))) supplied.push(url);
      if (supplied.length >= MAX_DOMAINS) break;
    }
  }
  if (!supplied.length && !inn && !nameSearch) return { status: 'unavailable', text: '', url: '', reason: 'missing_or_unsafe_website', pages: 0 };
  const observedAt = new Date().toISOString();
  const freshPages = new Set<string>();
  const pages = new Map<string, Promise<VeEvidencePage | undefined>>();
  // conflicted — ОКОНЧАТЕЛЬНЫЙ отказ: в реквизитах сайта стоит чужой владелец,
  // и никакой повтор этого не изменит. Отделён от unverified, чтобы медленная
  // страница не переименовала его в «таймаут»: гейт по ярлыку таймаута ставит
  // компанию на повторную проверку, а повтор снова покупает платный поиск.
  let failed = false, timedOut = false, unverified = false, conflicted = false, searchAttempted = false, searchCompleted = false, brandVerified = false;
  // Разделение того же таймаута на «не успела страница» и «не успел общий
  // дедлайн»: первое стоит 5 с и повторяется, второе съедает всю компанию.
  let pageTimedOut = false, deadlineTimedOut = false;
  const noteTimeout = (error: unknown): void => {
    if (!(error instanceof VeOperationTimeoutError)) return;
    if (error.label === PAGE_DEADLINE_LABEL) pageTimedOut = true; else deadlineTimedOut = true;
  };
  let retries = 0;
  let searchDeferred = false;
  let providerError: VeSearchProviderFailure | undefined;
  const verified = new Map<string, VeEvidencePage[]>();
  // Замер 22.09: своя главная, молчащая или отвечающая 403 нашему адресу в
  // США, через RU-прокси открывается примерно в каждом десятом случае, за
  // 1–3 с. Прокси общие с парсерами Яндекс Карт, поэтому заход через прокси
  // один на компанию и только для стартовой страницы своего сайта, в тех же
  // 5 с. На таймаут он идёт вместе с прямым повтором, а не вместо него: около
  // трети сайтов, которые напрямую отвечают, через прокси висят, а первый
  // таймаут часто даёт нагрузка. На 403/429 прямой повтор бесполезен — только
  // прокси. Если главная открылась только через прокси, тем же путём читаются
  // её реквизиты (MAX_PROXY_READS). Если её открыл прямой повтор после
  // молчания, реквизиты идут той же гонкой прямого пути и прокси: такой сайт
  // нашему адресу отвечает через раз (sibdobrodar.ru: /contacts напрямую
  // молчит, через прокси — 200 за 2,8 с).
  const proxyRoute = (Boolean(opts.fetchPage) || !opts.fetchText) && getProxyGroups().priority.length > 0;
  let proxyUsed = false;
  const proxy = { attempts: 0, rescued: 0, verified: 0, denied: 0 };
  // Стартовые адреса (свой кандидат или найденный поиском), которые напрямую
  // не ответили вовсе: молчание или обрыв соединения. /contacts и реквизиты
  // такого хоста молчат так же (замер: 10 из 10), читать их — терять по 5 с
  // на страницу и повторы, которые пригодились бы найденному сайту. Сбой
  // внутренней страницы живого сайта сюда не попадает.
  const deadStarts = new Set<string>();
  // Своя стартовая страница, чьи реквизиты читаются с прокси: silent —
  // открылась только через прокси, напрямую молчала; blocked — только через
  // прокси, напрямую отвечала 403/429; slow — первый прямой заход промолчал,
  // открыл её прямой повтор (кто бы ни выиграл гонку с прокси).
  const proxyStarts = new Map<string, VeProxyStart>();
  // Хосты, страницу которых принёс прокси: по ним считается польза прокси.
  const proxyHosts = new Set<string>();
  // Страницы реквизитов slow-хоста, которые прочитаны только напрямую (прокси
  // не досталось: нет пула, пропуска или лимита) и промолчали без ответа сайта.
  const directQuiet = new Set<string>();
  // Ярлык таймаута — только когда молчит стартовая страница собственного
  // сайта. Молчание каталога из поиска или внутренней страницы повтор не
  // лечит: половина таймаутов в замере — такие каталоги.
  let ownSilent = false;
  /** start — стартовая страница кандидата, page — внутренняя страница. via —
   * страница реквизитов своего сайта из proxyStarts. */
  const read = async (url: URL, parent: AbortSignal, mode: 'start' | 'page' = 'page', via?: VeProxyStart): Promise<VeEvidencePage | undefined> => {
    parent.throwIfAborted();
    if (pages.has(url.href)) return pages.get(url.href);
    if (pages.size >= MAX_PAGE_READS) return undefined;
    const own = mode === 'start' && !searchAttempted && supplied.some((candidate) => candidate.href === url.href);
    const load = async (signal: AbortSignal, route: VeEvidenceRoute): Promise<VeEvidencePage> => {
      const cached = cachedPages.get(veFactPageKey(url.href));
      const page = cached ? focusVeCompanyFact(cached, opts.focus) : opts.fetchPage ? await opts.fetchPage(url.href, signal, route)
        : opts.fetchText ? { text: selectVeEvidenceText(await opts.fetchText(url.href), opts.focus), url: url.href, links: [], inns: [] }
          : focusVeCompanyFact(await (route === 'proxy' ? proxyPageReader : sharedPageReader)(url, signal), opts.focus);
      signal.throwIfAborted();
      // Offline adapters have the same destination restrictions as transport.
      const finalUrl = allowedUrl(page.url);
      if (!finalUrl || siteHost(finalUrl) !== siteHost(url) || (url.protocol === 'https:' && finalUrl.protocol !== 'https:')) {
        throw new Error('website_redirect_unavailable');
      }
      if (!cached) freshPages.add(page.url);
      return page;
    };
    // silent/answered — по всем заходам, directDead — по последнему прямому:
    // сбой самого прокси ничего не говорит о хосте.
    let silent = false, answered = false, directDead = false;
    const fail = (error: unknown, route: VeEvidenceRoute): void => {
      failed = true;
      const pageTimeout = error instanceof VeOperationTimeoutError;
      timedOut ||= pageTimeout;
      noteTimeout(error);
      silent ||= pageTimeout;
      answered ||= siteAnswered(error);
      if (route === 'direct') directDead = pageTimeout || connectionFailure(error);
    };
    /** Один заход в окне 5 с. Маршруты идут параллельно: берётся первая
     * прочитанная страница, остальные отменяются. */
    const attempt = async (routes: VeEvidenceRoute[]): Promise<{ page?: VeEvidencePage; route?: VeEvidenceRoute; error?: unknown }> => {
      const errors = new Map<VeEvidenceRoute, unknown>();
      try {
        const won = await withVeDeadline(PAGE_DEADLINE_LABEL, PAGE_TIMEOUT_MS, parent, (signal) =>
          new Promise<{ page: VeEvidencePage; route: VeEvidenceRoute }>((resolve, reject) => {
            const flights = routes.map((route) => ({ route, controller: new AbortController() }));
            const stop = () => flights.forEach(({ controller }) => controller.abort(signal.reason));
            signal.addEventListener('abort', stop, { once: true });
            for (const { route, controller } of flights) {
              load(controller.signal, route).then((page) => {
                signal.removeEventListener('abort', stop);
                for (const other of flights) if (other.route !== route) other.controller.abort();
                resolve({ page, route });
              }, (error: unknown) => {
                if (signal.aborted) return;
                errors.set(route, error);
                if (errors.size < routes.length) return;
                signal.removeEventListener('abort', stop);
                reject(error);
              });
            }
          }));
        if (won.route === 'proxy') proxyHosts.add(siteHost(url));
        return won;
      } catch (error) {
        parent.throwIfAborted();
        // Маршрут, не ответивший до конца окна, получает таймаут окна.
        for (const route of routes) fail(errors.get(route) ?? error, route);
        return { error };
      }
    };
    const task = (async () => {
      let release: (() => void) | undefined;
      // Первый заход — прямой; у реквизитов slow-хоста с пропуском — гонка
      // прямого пути и прокси в одном окне.
      let first: VeEvidenceRoute[] = ['direct'];
      try {
        // slow-хост без пула читается напрямую, как раньше.
        if (via && (via !== 'slow' || proxyRoute) && !cachedPages.has(veFactPageKey(url.href))) {
          const capped = proxy.attempts >= MAX_PROXY_READS;
          release = capped ? undefined : tryAcquireProxySlot() ?? undefined;
          if (release && via === 'slow') {
            proxy.attempts += 1;
            first = ['direct', 'proxy'];
          } else if (release) {
            proxy.attempts += 1;
            const { page } = await attempt(['proxy']);
            release();
            release = undefined;
            if (page) return page;
            // Сайт через прокси уже отвечал: это частичное чтение, ответ окончательный.
            if (via === 'silent') return undefined;
          } else if (via === 'silent') {
            // Напрямую такой сайт промолчит так же. Нехватка пропуска — наш
            // лимит, а не ответ сайта: ярлык остаётся таймаутом, гейт повторит.
            if (!capped) { proxy.denied += 1; ownSilent = true; }
            return undefined;
          } else if (!capped) proxy.denied += 1;
          // После 403 — та же страница напрямую, как раньше: отказ приходит за 0,3–0,6 с.
        }
        let result = await attempt(first);
        release?.();
        release = undefined;
        if (result.page) return result.page;
        const pageTimeout = result.error instanceof VeOperationTimeoutError;
        let second: VeEvidenceRoute[] | undefined;
        // Свой второй заход не ждёт бюджета повторов: его могли съесть быстрые
        // отказы соседних доменов, пока своя главная молчала.
        if (own && proxyRoute && !proxyUsed && (pageTimeout || blockedByAddress(result.error))) {
          // Пропуск без ожидания: нет свободного — остаёмся на прямом пути.
          release = tryAcquireProxySlot() ?? undefined;
          if (release) {
            proxyUsed = true;
            proxy.attempts += 1;
            second = pageTimeout ? ['direct', 'proxy'] : ['proxy'];
          } else proxy.denied += 1;
        }
        if (!second && retries < MAX_PAGE_RETRIES && transientPageFailure(result.error)) second = ['direct'];
        if (second) {
          retries += 1;
          result = await attempt(second);
          if (result.page) {
            if (result.route === 'proxy') {
              proxy.rescued += 1;
              proxyStarts.set(url.href, pageTimeout ? 'silent' : 'blocked');
            } else if (own && pageTimeout) proxyStarts.set(url.href, 'slow');
            return result.page;
          }
        }
      } finally {
        release?.();
      }
      if (mode === 'start' && directDead) deadStarts.add(url.href);
      // Сбой самого прокси молчание не отменяет: сайт так и не ответил.
      if (own && silent && !answered) ownSilent = true;
      if (via === 'slow' && first.length === 1 && silent && !answered) directQuiet.add(url.href);
      return undefined;
    })();
    pages.set(url.href, task);
    return task;
  };
  const inspect = async (start: URL, initial: VeEvidencePage | undefined, signal: AbortSignal, discovered = false): Promise<VeEvidencePage[]> => {
    // Стартовая страница не ответила вовсе: по сети /contacts и реквизиты
    // этого хоста не читаем, из памяти фактов — читаем, как раньше. Без
    // памяти ярлыки те же, что дал бы неудачный /contacts.
    const offline = !initial && deadStarts.has(start.href);
    const readable = (href: string) => !offline || cachedPages.has(veFactPageKey(href));
    // Главная открылась только через прокси: реквизиты читаем тем же путём,
    // а страницы деятельности молчащего нашему адресу сайта не читаем вовсе.
    // slow: реквизиты — гонкой прямого пути и прокси, деятельность — напрямую.
    const viaProxy = initial ? proxyStarts.get(start.href) : undefined;
    const sitePages: VeEvidencePage[] = initial ? [initial] : [];
    const identity = () => {
      // Конфликт считаем по ВЛАДЕЛЬЧЕСКИМ позициям (подвал, реквизиты,
      // юридическая страница), а не по любому ИНН в тексте: чужой ИНН в отзыве,
      // в платёжном виджете или в перечне партнёров аннулировал весь сайт
      // целиком, и компания уходила покупать поиск. Допуск при этом не
      // ослаблен — он по-прежнему требует ровно одного владельца и нашего ИНН.
      const owners = new Set(sitePages.flatMap((page) => page.ownerInns ?? []));
      const seen = owners;
      // Сайт, который НЕ печатает ни одного владельческого ИНН, проверяем
      // брендом и географией — тем же порогом, что и компанию без ИНН. Раньше
      // наличие ИНН в реестре делало требование к тому же сайту строже: нет
      // ИНН в подвале — покупаем поиск, а он приносит подтверждённый сайт в
      // 2.7% записей. Чужой ИНН по-прежнему отменяет сайт целиком.
      const brandMatches = () => discoveredNameMatches(sitePages, opts.companyName ?? '', opts.companyAddress ?? '');
      return !inn ? (!discovered || brandMatches() ? 'supplied' : 'unknown') : [...seen].some((value) => value !== inn) ? 'conflict'
        : owners.size === 1 ? 'verified' : brandMatches() ? 'supplied' : 'unknown';
    };
    if ((inn || discovered) && identity() === 'unknown') {
      const base = new URL(initial?.url ?? start.href);
      // Re-rank newly discovered legal/about links after each page, so a hub
      // can lead to requisites without crawling unrelated navigation.
      const requisites: string[] = [];
      for (let attempt = 0; attempt < 3 && pages.size < MAX_PAGE_READS; attempt++) {
        if (viaProxy === 'silent' && proxy.attempts >= MAX_PROXY_READS) break;
        const legal = rankVeEvidenceLinks(sitePages.flatMap(sameOriginLinks), opts.focus, 'identity');
        const next = [...legal, { url: new URL('/contacts', base).href, text: 'Contacts' }]
          .find((link) => !pages.has(link.url) && readable(link.url));
        const url = next ? allowedUrl(next.url) : null;
        if (!url) break;
        const denied = proxy.denied;
        requisites.push(url.href);
        const page = await read(url, signal, 'page', viaProxy);
        if (page) sitePages.push(page);
        // Молчащий сайт без пропуска в прокси дальше не читаем: ярлык — таймаут.
        if (identity() !== 'unknown' || (viaProxy === 'silent' && proxy.denied > denied)) break;
      }
      // Реквизиты slow-хоста без прокси (нет пула, пропуска или лимита) все
      // промолчали напрямую: это наш предел, а не ответ сайта — ярлык
      // остаётся таймаутом, и гейт повторит компанию, как до прокси.
      if (viaProxy === 'slow' && identity() === 'unknown' && requisites.length
        && requisites.every((href) => directQuiet.has(href))) ownSilent = true;
    }
    const verdict = identity();
    if (verdict === 'conflict' || verdict === 'unknown') { conflicted ||= verdict === 'conflict'; unverified = true; return []; }
    // Отмечаем допуск по бренду отдельно от допуска по ИНН: это разные по
    // надёжности основания, и доля каждого нужна в замерах.
    if (inn && verdict === 'supplied') brandVerified = true;
    // Use actual same-origin links, including deeper service sections. Focus
    // ranking comes from the page parser; never invent a target-specific path.
    const home = sitePages[0];
    if (!home) return [];
    const host = siteHost(new URL(home.url));
    const publish = () => verified.set(host, sitePages.filter((page) => Boolean(page.text)));
    // Preserve already verified pages if a later optional service read times out.
    publish();
    const fallback = new URL(/\.(?:ru|xn--p1ai)$/i.test(new URL(home.url).hostname) ? '/uslugi' : '/services', home.url).href;
    const visited: VeEvidencePage['links'] = [];
    // После 403 отказ быстрый (0,3–0,6 с) и бывает не на всех страницах —
    // страницы деятельности такого сайта читаются напрямую, как раньше.
    for (let attempt = 0; viaProxy !== 'silent' && attempt < 4 && pages.size < MAX_PAGE_READS; attempt++) {
      const ranked = rankVeEvidenceLinks(sitePages.flatMap(sameOriginLinks), opts.focus, 'activity', visited);
      const next = [...ranked, { url: fallback, text: 'Services' }].find((link) => !pages.has(link.url) && readable(link.url));
      if (!next) break;
      const url = allowedUrl(next.url);
      if (!url || url.origin !== new URL(home.url).origin) continue;
      visited.push(next);
      const page = await read(url, signal);
      if (page) sitePages.push(page);
      if (identity() === 'conflict') { verified.delete(host); conflicted = true; unverified = true; return []; }
      publish();
    }
    // A legal footer on a later service page can expose another entity.
    if (identity() === 'conflict') { verified.delete(host); conflicted = true; unverified = true; return []; }
    return sitePages.filter((page) => Boolean(page.text));
  };
  try {
    await withVeDeadline(TOTAL_DEADLINE_LABEL, TOTAL_TIMEOUT_MS, opts.signal, async (signal) => {
      // Without a strong identity, do not move across unrelated supplied domains.
      const candidates = inn ? supplied : supplied.slice(0, 1);
      const homes = await Promise.all(candidates.map((url) => read(url, signal, 'start')));
      for (let i = 0; i < candidates.length; i += 1) {
        await inspect(candidates[i], homes[i], signal);
      }
      if (verified.size || (!inn && !nameSearch) || pages.size >= MAX_PAGE_READS) return;
      signal.throwIfAborted();
      searchAttempted = true;
      const query = (inn ? '"' + inn + '"' : '"' + String(opts.companyName).replace(/["\r\n]/g, ' ').slice(0, 160) + '" ' + String(opts.companyAddress).slice(0, 100))
        + ' официальный сайт -site:rusprofile.ru -site:list-org.com -site:checko.ru -site:companium.ru -site:hh.ru';
      let results: SerperOrganicItem[];
      try {
        const found = await withVeDeadline('relevance website search', VE_RELEVANCE_SEARCH_OPERATION_TIMEOUT_MS, signal, async (searchSignal) =>
          opts.allowPaidSearch === false ? (opts.searchCache ?? readVeSearchCache)(query, searchSignal)
            : opts.search ? opts.search(query, searchSignal) : searchVeRelevanceWebsitesCached(query, searchSignal));
        if (found === null) { searchDeferred = true; searchCompleted = true; return; }
        results = found;
      } catch (error) {
        if (error instanceof ProviderUsageWriteError) throw error;
        signal.throwIfAborted();
        providerError = veSearchProviderFailure(error);
        return;
      }
      searchCompleted = true;
      signal.throwIfAborted();
      const found: URL[] = [];
      for (const item of results.slice(0, 6)) {
        const url = typeof item.link === 'string' ? allowedUrl(item.link) : null;
        if (!url || DIRECTORY_HOST.test(url.hostname) || /\.(?:pdf|docx?|zip)$/i.test(url.pathname)
          || found.some((other) => siteHost(other) === siteHost(url))) continue;
        found.push(url);
        if (found.length >= MAX_DOMAINS) break;
      }
      for (const url of found) {
        await inspect(url, await read(url, signal, 'start'), signal, true);
        if (verified.size) return;
      }
    });
  } catch (error) {
    if (error instanceof ProviderUsageWriteError) throw error;
    opts.signal?.throwIfAborted();
    failed = true;
    timedOut ||= error instanceof VeOperationTimeoutError;
    noteTimeout(error);
    if (searchAttempted && !searchCompleted && !providerError) {
      providerError = veSearchProviderFailure(new VeSearchProviderError('transient', timedOut ? 'timeout' : 'transport'));
    }
  }
  opts.signal?.throwIfAborted();
  // Общий дедлайн бьёт компанию целиком, постраничный — только одну страницу.
  // Когда случилось и то и другое, отвечает тот, кто закончил работу.
  const timeout = deadlineTimedOut ? 'deadline' as const : pageTimedOut ? 'page' as const : undefined;
  const proxyTelemetry = () => (proxy.attempts || proxy.denied ? { proxy: { ...proxy } } : {});
  if (searchDeferred) return { status: 'unavailable', text: '', url: supplied[0]?.href ?? '',
    reason: 'paid_search_deferred', search_deferred: true, pages: pages.size, ...(timeout ? { timeout } : {}), ...proxyTelemetry() };
  if (providerError) return {
    status: 'error', text: '', url: supplied[0]?.href ?? '',
    reason: providerError.message, provider_error: providerError,
    pages: pages.size, ...(timeout ? { timeout } : {}), ...proxyTelemetry(),
  };
  // Reserve room for every page rather than letting a long home/menu consume
  // all evidence. Focus selection has already scanned each complete document.
  const selected = [...verified.values()].flat();
  const unique = selected.filter((page, index) => selected.findIndex((other) => other.url === page.url) === index);
  if (factKey && factStore) {
    // Reuse never renews the observation's age. No-INN supplied sites require
    // brand + geography verification before entering the shared store too.
    const shareable = [...verified.values()].filter((sitePages) => inn
      || discoveredNameMatches(sitePages, opts.companyName ?? '', opts.companyAddress ?? '')).flat();
    const observations = shareable.filter((page) => freshPages.has(page.url));
    if (observations.length) await factStore.write(factKey, observations, observedAt);
  }
  const perPage = Math.floor((MAX_TEXT_CHARS - unique.reduce((n, page) => n + page.url.length + 8, 0)) / Math.max(1, unique.length));
  const text = unique.map((page) => `URL: ${page.url}\n${selectVeEvidenceText(page.text, opts.focus, Math.max(200, perPage))}`).join('\n\n').slice(0, MAX_TEXT_CHARS);
  // Польза прокси — по компании: сайт, страницу которого принёс прокси
  // (спасённая главная или реквизиты), дошёл до текста.
  if (text && [...proxyHosts].some((host) => verified.has(host))) proxy.verified = 1;
  return {
    status: text ? 'ok' : 'unavailable', text, url: unique[0]?.url ?? supplied[0]?.href ?? '',
    reason: text ? (searchAttempted ? 'discovered_verified_website'
      : inn ? (brandVerified ? 'brand_verified_website' : 'identity_verified_website') : 'supplied_website_evidence')
      // Окончательный отказ по владельцу идёт ПЕРЕД таймаутом: иначе одна
      // медленная страница отправляла бы такую компанию на новый круг с новой
      // покупкой поиска, хотя ответ уже получен и он не изменится.
      : conflicted ? 'website_identity_unverified'
        : ownSilent || deadlineTimedOut ? 'website_evidence_timeout' : unverified ? 'website_identity_unverified'
        : failed ? 'website_evidence_failed' : searchAttempted ? 'website_search_unverified' : 'no_usable_website_text',
    pages: pages.size, ...(timeout ? { timeout } : {}), ...proxyTelemetry(),
  };
}
