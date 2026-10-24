/**
 * Дефолтные IO-реализации для стадий: фетч страниц (SSRF-гейт +
 * cheerio-парсер websiteParser) и поиск (Serper, best-effort — см. searchIo.ts).
 *
 * Вынесены отдельно от shared.ts, чтобы модули с pure-логикой (clustering,
 * template) и юнит-тесты не подтягивали тяжёлый граф websiteParser/playwright.
 *
 * Сроки и отмена (волна 3): у каждого вида операции свой бюджет — DNS, чтение
 * сайта, поиск, — и сигнал отмены задачи доходит до транспорта. До этого ни у
 * DNS-резолва, ни у цепочки чтения сайта, ни у поискового клиента срока не
 * было, а воркер односоточный: один молчащий хост держал исследование всех
 * проектов. Завершение каждой операции отмечается через ctx.onActivity — это
 * вход сторожа простоя (он обязан отличать работающую стадию от зависшей).
 *
 * Недоступный сайт (волна 4b): провал ЧТЕНИЯ отличается от истёкшего срока и от
 * отмены типом — HeSiteUnreachableError. Это факт о сайте клиента, и стадия
 * решает по нему не так, как по транзиенту: см. класс ниже.
 *
 * Маршрут чтения (волна 7, прямая попытка с 23.10.2026): у рынка 'us' свой
 * порядок маршрутов и свой Accept-Language — см. ENG_WEBSITE_ROUTE. Рынок 'ru' читает сайт ровно теми
 * же запросом и маршрутом, что и до этой правки; общий парсер
 * (lib/enrich/websiteParser.ts) держит русские значения дефолтами.
 *
 * Защита чтения и потолок тела (раунды 9–11): каждое чтение страницы через
 * ЭТОТ модуль — главная со всей цепочкой fetchAndExtract и строгая страница
 * resolveFetchPage — идёт с опцией guard парсера (heFetchGuard ниже: проверка
 * публичного адреса перед каждым запросом и шагом редиректа, не больше
 * HE_MAX_REDIRECTS шагов) и с потолком тела HE_PAGE_MAX_BYTES. Оба рынка: ни
 * один настоящий сайт не ведёт редиректом на приватный адрес и не нуждается в
 * мегабайтах HTML ради 3000 символов текста. Только у 'us' редирект https →
 * http не проходится, порт — только 80/443, а адреса наших серверов
 * отклоняются: политика английского рынка целиком — createUsWebsiteFetchGuard
 * (enrich/publicAddress.ts, там же OWN_SERVER_ADDRESSES и STANDARD_WEB_PORTS). Чтения сайтов
 * мимо этого модуля — шаги конструктора баз, которые base_collect ставит
 * дочерней джобой (поиск почт, описания компаний, lib/tools/processingSteps.ts):
 * EN-джоба конструктора (locale 'en' — её ставит только рынок 'us') читает
 * под той же createUsWebsiteFetchGuard и с потолком 3 МиБ (enSiteGuard там),
 * RU-джоба — без этой защиты, как раньше.
 *
 * Строгая страница (resolveFetchPage): ровно запрошенный адрес — без обхода
 * «о компании», без подмены главной, www- и http-вариантами; нет страницы —
 * null. Для подстраниц сайта и источников доказательств, где подменённая
 * страница — неправда в корпусе.
 */

import { lookup } from 'node:dns/promises';
import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { WebsiteFetchError } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';
import { DEFAULT_MAX_ABOUT_CANDIDATES } from '@/lib/enrich/aboutCandidates';
import { createPublicWebsiteGuard, createUsWebsiteFetchGuard } from '@/lib/enrich/publicAddress';
import {
  fetchAndExtract,
  fetchSinglePage,
  isWebsiteNoHtmlError,
  normalizeUrl,
  type WebsiteFetchGuard,
  type WebsiteFetchRouteOrder,
} from '@/lib/enrich/websiteParser';
import { getHeActiveJobSignal } from '../llm';
import type { HeMarket } from '../market';
import { isHeOperationTimeout, withHeDeadline } from '../operationDeadline';
import { defaultSearch, HE_SEARCH_TIMEOUT_MS, isHeSearchProviderError } from './searchIo';
import type { HeStageContext } from './shared';

export type HeFetchTextFn = (url: string) => Promise<string>;
export type HeSearchFn = (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;

/** Строго прочитанная страница (resolveFetchPage). */
export interface HeFetchedPage {
  /** Адрес, где закончились редиректы: с него и пришёл текст. */
  url: string;
  /** Текст страницы, ≤3000 символов; пустой — HTML есть, текста нет. */
  text: string;
  companyEvidenceLinks?: Array<{ url: string; kind: 'legal' | 'about' | 'contact' | 'locations' | 'services'; priority?: number; label?: string }>;
  companyEvidenceTextTruncated?: boolean;
}
export type HeFetchPageFn = (url: string) => Promise<HeFetchedPage | null>;

/** DNS-резолв SSRF-гейта: у node:dns своего срока нет — молчащий резолвер вешал стадию. */
const DNS_TIMEOUT_MS = 8_000;

/**
 * Потолок тела ОДНОГО ответа. Воркер живёт в 512 МБ, а тело раньше
 * ограничивал только срок попытки — быстрый хост за 8 с успевал залить сотни
 * мегабайт, и декодирование с cheerio умножали их. Текст страницы режется до
 * 3000 символов, так что первых 3 МБ HTML хватает с запасом.
 */
const HE_PAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Шагов редиректа на один запрос. Каждый шаг проверяется на публичный адрес,
 * поэтому потолок — не защита сам по себе, а предел работы; 10 — как у Go
 * net/http, с запасом для цепочек http → https → www → /en/.
 */
const HE_MAX_REDIRECTS = 10;

/**
 * Чтение сайта: константы цепочки fetchAndExtract (lib/enrich/websiteParser.ts).
 * На каждый адрес там 2 попытки по WEBSITE_FETCH_TIMEOUT_MS с паузой
 * FETCH_RETRY_DELAY_MS между ними; адресов — главная + www + http.
 *
 * Срок попытки передаётся в fetchAndExtract ЯВНО (defaultFetchText ниже), а не
 * совпадает с его дефолтом по договорённости: арифметика бюджета опирается
 * именно на это число, и молчаливое совпадение с чужой константой держалось бы
 * ровно до первой её правки.
 *
 * Защита чтения (heFetchGuard) арифметику не меняет: проверки адреса, все шаги
 * редиректа и чтение тела идут внутри того же срока одной попытки.
 */
const WEBSITE_FETCH_TIMEOUT_MS = 8_000;
const WEBSITE_FETCH_ATTEMPTS = 2;
const WEBSITE_FETCH_RETRY_DELAY_MS = 300;
const WEBSITE_ORIGIN_VARIANTS = 3;
/** Запас поверх сетевого времени: декодирование и разбор HTML (iconv/cheerio). */
const WEBSITE_PARSE_SLACK = 1.15;
/** Ниже этого бюджет не опускаем: здоровому сайту нужно ≥120 с. */
const WEBSITE_MIN_TIMEOUT_MS = 120_000;

/**
 * Сколько страниц «о компании» реально переберёт цепочка. Читаем ТУ ЖЕ env и
 * тем же санитайзером, что websiteParser (`MAX_ABOUT_CANDIDATES`) и
 * buildAboutCandidates (мусор в env → дефолт, 0 → 1): разойтись эти два числа
 * не имеют права, иначе бюджет снова окажется верным только для одной
 * конфигурации.
 */
function aboutCandidatesInEffect(): number {
  const configured = Number(
    process.env.WEBSITE_ENRICHMENT_MAX_ABOUT_CANDIDATES ?? String(DEFAULT_MAX_ABOUT_CANDIDATES),
  );
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : DEFAULT_MAX_ABOUT_CANDIDATES;
}

/**
 * Бюджет чтения сайта ВЫВОДИТСЯ из длины цепочки, а не забит числом.
 *
 * 140 с (так было до правки) — верная арифметика ровно для 4 страниц «о
 * компании»: 7 адресов × (2 × 8 с + 0,3 с) ≈ 114 с + DNS 8 с ≈ 122 с. Но число
 * страниц настраивается: поставь прод WEBSITE_ENRICHMENT_MAX_ABOUT_CANDIDATES=8
 * — и ЗДОРОВОЙ цепочке нужно ≈187 с, то есть каждый живой, но очень медленный
 * сайт падал бы на site_profile как таймаут. Срок обязан ловить зависание, а не
 * рубить здоровый сайт.
 */
function websiteTimeoutMs(gateLookups: 1 | 2): number {
  const perAddress = WEBSITE_FETCH_ATTEMPTS * WEBSITE_FETCH_TIMEOUT_MS + WEBSITE_FETCH_RETRY_DELAY_MS;
  const addresses = WEBSITE_ORIGIN_VARIANTS + aboutCandidatesInEffect();
  const chain = gateLookups * DNS_TIMEOUT_MS + addresses * perAddress;
  // Округляем до целых секунд: срок печатается в лог и в he_jobs.error.
  //
  // Верхнего клампа нет намеренно: тихо урезанный бюджет рубил бы здоровый сайт
  // ровно так же, только без следа в логе. Но «сверху всё равно стоит сторож
  // простоя стадии» — НЕ инвариант, а совпадение чисел, и вот его настоящее
  // условие. Окно сторожа (stageIdleTimeoutMs в worker/hypothesisEngine.ts)
  // выводится из срока одной попытки запроса к МОДЕЛИ:
  // max(STAGE_IDLE_FLOOR_MS = 1 200 000, heLlmMaxAttemptMs × 1,5) — то есть
  // 1 800 000 мс на шиппинг-конфигурации (потолок срока попытки в llm.ts —
  // 1 200 000 мс) и не меньше 1 200 000 мс ни при каком HE_LLM_TIMEOUT_MS: до
  // 800 000 мс включительно побеждает нижняя граница, выше — сам множитель, и
  // перекрышка окно только поднимает. Этот бюджет выводится из длины цепочки
  // чтения САЙТА; общего слагаемого у двух чисел нет, и порядок держится лишь
  // пока
  //   ceil(1,15 × (8 000 + (3 + n) × 16 300)) < окно,
  // где n — WEBSITE_ENRICHMENT_MAX_ABOUT_CANDIDATES. Это n ≤ 92 на шиппинг-окне
  // и n ≤ 60 при окне на нижней границе; дефолт n = 4 (141 000 мс) от обоих
  // порогов далеко. У рынка 'us' в гейте второй lookup (gateLookups = 2, см.
  // WEBSITE_TIMEOUT_US_MS) — 16 000 вместо 8 000; пороги от этого не
  // сдвигаются (те же n ≤ 92 и n ≤ 60), дефолт — 150 000 мс.
  //
  // Что ломается выше порога: чтение сайта не подаёт признаков жизни, пока не
  // закончится (ctx.onActivity стоит в .finally у resolveFetchText), поэтому
  // первым сработает не свой срок операции, а сторож — здоровый медленный сайт
  // объявляется зависанием ВСЕЙ джобы, прерывание считается бесплатным, и
  // стадия перезапускается вместо того, чтобы честно бросить один адрес.
  // Поднимать n выше 60 можно только вместе с HE_LLM_TIMEOUT_MS (окно пойдёт за
  // ним) — либо добавив сюда признак жизни внутри цепочки.
  return Math.max(WEBSITE_MIN_TIMEOUT_MS, Math.ceil((chain * WEBSITE_PARSE_SLACK) / 1000) * 1000);
}

/** ≈141 с на дефолтных 4 страницах «о компании», ≈216 с на 8. */
const WEBSITE_TIMEOUT_MS = websiteTimeoutMs(1);
/**
 * Рынок 'us': после общего гейта — проверка политики его защиты чтения (порт и
 * адреса наших серверов, gateWebsiteAddress) со своим lookup под тем же
 * DNS_TIMEOUT_MS, поэтому в цепочке два срока DNS: ≈150 с на дефолте. У 'ru'
 * бюджет прежний.
 */
const WEBSITE_TIMEOUT_US_MS = websiteTimeoutMs(2);

/**
 * Строгая страница (resolveFetchPage): один адрес, без цепочки. Гейт DNS и у
 * рынка 'us' второй lookup — повторный при отказе (usDnsFailure) либо проверка
 * политики 'us' при успехе (gateWebsiteAddress), не оба, — по DNS_TIMEOUT_MS, затем
 * WEBSITE_FETCH_ATTEMPTS попыток по сроку с паузой, тот же запас на разбор:
 * ceil(1,15 × (2 × 8 000 + 2 × 8 000 + 300)) = 38 000 мс. Минимума в 120 с нет:
 * он про цепочку главной, а одна страница, не ответившая за две попытки, не
 * ответит и за третью минуту.
 */
const WEBSITE_PAGE_TIMEOUT_MS =
  Math.ceil(
    ((2 * DNS_TIMEOUT_MS + WEBSITE_FETCH_ATTEMPTS * WEBSITE_FETCH_TIMEOUT_MS + WEBSITE_FETCH_RETRY_DELAY_MS) *
      WEBSITE_PARSE_SLACK) /
      1000,
  ) * 1000;
/**
 * Поиск: срок HTTP-запроса живёт внутри клиента Serper, а этот бюджет
 * страхует зависший клиент И покрывает журнал расхода вокруг запроса
 * (разбивка — в searchIo.ts, HE_SEARCH_TIMEOUT_MS).
 */
const SEARCH_TIMEOUT_MS = HE_SEARCH_TIMEOUT_MS;

/**
 * Сайт клиента недоступен — исход чтения сайта, а не поломка стадии. Два рода:
 *  - `dns` — гейт не пустил к первому запросу: домен не резолвится, адрес
 *    невалидный либо приватный (`assertPublicWebsite`), у рынка 'us' ещё —
 *    порт не 80/443 или адрес нашего сервера (heFetchGuard) — факт об адресе. У
 *    рынка 'us' «не резолвится» — только ENOTFOUND/ENODATA, а сбой самого
 *    резолвера (EAI_AGAIN и др.) сюда не попадает (usDnsFailure ниже);
 *  - `no_html` — хост принял соединение, но ни один адрес origin'а не отдал
 *    HTML (`WebsiteNoHtmlError` из websiteParser). Так же выглядит и наш
 *    маршрут чтения, который не дошёл (прокси, бот-защита сайта), поэтому
 *    кабинет считает этот род техническим сбоем (`website_no_html`).
 * Стадии оба рода одинаковы (повторять пути origin'а незачем); различает их
 * только кабинет — по роду в тексте.
 *
 * ТОЛЬКО market='us' (решение владельца 14.10.2026 «Как было»). У RU-проекта
 * чтение сайта бросает исходную ошибку гейта или парсера, как до порта ENG:
 * site_profile на ней останавливается прежним текстом, без пометок
 * site_unreachable/site_thin в брифе и без продолжения по ручному описанию
 * бизнеса (siteProfile.ts этот класс читает по типу, а RU его больше не
 * получает). Защита чтения (heFetchGuard, потолок тела) и сроки — общие.
 *
 * Зачем свой класс поверх чужих ошибок. Стадии нужно три разных решения на три
 * исхода одного вызова: истёк срок (транзиент, повторяем), отменили (конец
 * работы), сайт недоступен (перебирать остальные пути этого origin'а не за чем,
 * а исход записываем честно). Первые два уже типизированы; третий до этой
 * правки различался только по русскому тексту чужого модуля — то есть не
 * различался никак.
 *
 * Текст РУССКИЙ: его читают `he_jobs.error`/`he_projects.error` и ежедневный
 * staff-инструмент /tools/hypothesis-engine. В английский кабинет ни один байт
 * этой строки не уезжает — роут сворачивает её в код причины
 * (`clientEngProjection.toClientEngStageErrorCode` → `clientErrors`: род `dns` —
 * код `website_unreachable`, род `no_html` — технический `website_no_html`,
 * у которого в кабинете есть «Try again»), и экран печатает английскую
 * константу справочника.
 *
 * АСИММЕТРИЯ, которую надо знать читателю логов: слова «Сайт клиента» в тексте
 * верны не всегда, а класс всё равно один. Ошибку бросает `defaultFetchText` для
 * ЛЮБОГО адреса, который ей дали, а дают ей и чужие: главная и кейс-страница
 * бренда (stages/brandCloud.ts), источник поисковой выдачи
 * (stages/evidence.ts), главная конкурента (stages/competitors.ts). То есть в
 * журнале стадии может стоять «Сайт клиента недоступен» про домен конкурента.
 * Строгая страница (defaultFetchPage) бросает тот же класс с тем же текстом.
 *
 * Почему текст всё равно НЕ меняется. Первые слова вместе с родом в скобках —
 * якорь классификатора кабинета (clientErrors.ts), и разойтись эти два места не
 * имеют права; а разделить текст на «свой» и «чужой» значило бы либо два
 * сообщения под один якорь, либо перенос якоря вместе с правилом.
 * Цена асимметрии при этом ограничена ОДНИМ местом: наружу — в
 * `he_projects.error`/`he_jobs.error` и дальше в коды `website_unreachable` /
 * `website_no_html` —
 * ошибка уходит только из стадии site_profile, и только про
 * `project.website_url`, то есть там формулировка честна буквально. Три стадии с
 * чужими адресами ловят её в своём catch и печатают ОДНОЙ СТРОКОЙ ЛОГА рядом с
 * самим адресом (`heIoFailureReason`, «фетч <url> пропущен: …»), а прогон
 * продолжают: ни в статус, ни в кабинет эта строка не попадает. Поэтому читать
 * такую строку нужно по URL в ней, а не по первым словам.
 */
export type HeSiteUnreachableKind = 'dns' | 'no_html';

export class HeSiteUnreachableError extends Error {
  /** Дискриминант: instanceof ложен, если в процессе окажется две копии модуля. */
  readonly heSiteUnreachable = true as const;

  constructor(
    readonly kind: HeSiteUnreachableKind,
    readonly url: string,
    readonly detail: string,
    cause?: unknown,
  ) {
    // Первые слова вместе с родом в скобках — якорь классификатора кабинета
    // (сверка ВХОЖДЕНИЕМ, а не началом строки: воркер дописывает перед причиной
    // имя стадии). Менять только вместе с правилом в clientErrors.ts.
    super(`Сайт клиента недоступен (${kind}): ${detail}`, { cause });
    this.name = 'HeSiteUnreachableError';
  }
}

/** Типизированная проверка «сайт недоступен», без разбора текста ошибки. */
export function isHeSiteUnreachable(e: unknown): e is HeSiteUnreachableError {
  if (e instanceof HeSiteUnreachableError) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { heSiteUnreachable?: unknown }).heSiteUnreachable === true
  );
}

/**
 * Провал транспортной операции → «сайт недоступен», но ТОЛЬКО когда это правда.
 * Истёкший срок и отмена задачи остаются собой: первый транзиентен (воркер
 * повторит стадию), вторая — остановка по просьбе человека, и записать любую из
 * них мёртвым доменом значило бы соврать про сайт клиента.
 */
function asSiteUnreachable(
  e: unknown,
  kind: HeSiteUnreachableKind,
  url: string,
  signal: AbortSignal,
  market: HeMarket,
): unknown {
  // RU — исходная ошибка, как до порта ENG (см. шапку класса).
  if (market !== 'us' || signal.aborted || isHeOperationTimeout(e)) return e;
  return new HeSiteUnreachableError(kind, url, e instanceof Error ? e.message : String(e), e);
}

/**
 * Маршрут чтения для АНГЛИЙСКОГО рынка.
 *
 * Дефолт websiteParser рассчитан на .ru-сайт: лестница попыток начинается с
 * приоритетной (российской) группы прокси, а запрос уходит с русским
 * Accept-Language. Для сайта из США это неверно дважды — русский exit-узел
 * чаще режут и медленнее ходит, а по языку сайт может отдать другую страницу
 * или редирект. Просим английскую страницу и читаем 'direct-first': первая
 * попытка напрямую (сервер в Нью-Йорке — тот же маршрут, которым EN-джоба
 * конструктора ищет почты), повтор — нода вне российской группы.
 *
 * До 23.10.2026 здесь был 'non-priority-first' (HK/EU-нода, затем RU) без
 * прямой попытки. Замер на боевом воркере по двум сборам страховщиков: 105
 * сайтов, которые проверка компаний не прочитала, и 40 прочитанных. Напрямую
 * открылись 39 из 40 прочитанных (медиана 1,25 с против 1,94 с через HK/EU,
 * RU — 9 из 40) и 15 непрочитанных, которые обе группы прокси получали 403,
 * обрывом или таймаутом. Остальные непрочитанные не открываются ни одним
 * маршрутом: домен не существует, сервер молчит, сертификат неверен или
 * сайт отказывает любому роботу.
 *
 * Рынок 'ru' не передаёт ничего: и заголовок, и порядок там ровно те же, что
 * были до этой правки. Строка языка совпадает с EN_ACCEPT_LANGUAGE почтового
 * скрапера — два места, куда уезжает английская локаль, обязаны просить одно.
 *
 * layoutAware (2026-10-16): разбор HTML, который не снимает вёрстку Elementor,
 * HubSpot CMS и Squarespace как «шум» — см. ExtractTextOptions в
 * websiteParser. Без него главная сайта на этих конструкторах схлопывалась до
 * <title>, и site_profile отказывал клиенту «сайт почти без текста» (hst.ie:
 * 176 символов при ~25 000 видимых). И главная (fetchAndExtract), и строгие
 * страницы (fetchSinglePage) читаются этим разбором — один сайт, одно
 * правило. RU по-прежнему читает прежним разбором.
 */
const ENG_WEBSITE_ROUTE: {
  routeOrder: WebsiteFetchRouteOrder;
  acceptLanguage: string;
  layoutAware: true;
} = {
  routeOrder: 'direct-first',
  acceptLanguage: 'en-US,en',
  layoutAware: true,
};

/**
 * Коды ответа резолвера, которые значат «такого имени нет» (getaddrinfo
 * EAI_NONAME/EAI_NODATA → ENOTFOUND, «записей нет» → ENODATA). Только они —
 * факт об адресе. Остальное (EAI_AGAIN, EAI_FAIL, ESERVFAIL, ECONNREFUSED у
 * резолвера…) — наш резолвер не ответил, это не про сайт клиента.
 */
const DNS_NAME_NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Не ответил НАШ резолвер (usDnsFailure ниже) — сбой у нас, а не факт о сайте.
 * Текст «DNS-резолвер не ответил …» — якорь кабинета (clientErrors.ts → код
 * 'internal'), его не менять. Дискриминант heResolverFailure читает воркер
 * (writeJobFailure): такой отказ тратит попытку, но повтор идёт после паузы, а
 * не через ~5 с — минутный сбой резолвера иначе сжигал все попытки стадии.
 * Поле переживает файл брошенных строк (FAILURE_FIELDS воркера).
 */
class HeResolverFailureError extends Error {
  /** Дискриминант: instanceof ложен, если в процессе окажется две копии модуля. */
  readonly heResolverFailure = true as const;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'HeResolverFailureError';
  }
}

/** Сбой нашего резолвера (HeResolverFailureError) где-то в цепочке причин — по дискриминанту. */
export function isHeResolverFailure(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; depth += 1) {
    if ((e as { heResolverFailure?: unknown }).heResolverFailure === true) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Провал DNS-резолва у гейта assertPublicWebsite — у рынка 'us' уточнённый.
 *
 * Общий гейт (lib/clientDemo/personalize.ts: его делят демо-персонализация RU и
 * verticalEngineV2) любой провал lookup превращает в одну и ту же
 * WebsiteFetchError «Не удалось найти такой сайт (DNS)» со статусом 502 и код
 * резолвера выбрасывает. Для ENG-кабинета это решало судьбу проекта: род `dns`
 * → website_unreachable — НЕ технический, «Try again» нет, клиент заперт, даже
 * если упал наш резолвер (EAI_AGAIN). Сам гейт не трогаем — его вывод в RU и v2
 * остаётся байт-в-байт прежним; вместо этого на ЭТОЙ ветке (только 502 гейта,
 * только 'us') спрашиваем резолвер ещё раз, уже с кодом:
 *  - ENOTFOUND / ENODATA — имени нет: прежний род `dns`;
 *  - имя на этот раз нашлось — первый провал был сбоем резолвера;
 *  - любой другой код — резолвер не ответил.
 * Последние два — HeResolverFailureError с кодом резолвера в тексте, НЕ
 * HeSiteUnreachableError: site_profile её не переживает, а бросает, воркер
 * повторяет стадию по своей политике (с паузой, см. класс выше), а кабинет
 * читает исход техническим сбоем («Try again» есть).
 * Невалидный, приватный или служебный адрес (400 гейта) остаётся родом `dns`.
 * Рынок 'ru' сюда не заходит — у него всё как до этой правки.
 */
async function usDnsFailure(gateError: unknown, normalized: string): Promise<unknown> {
  if (!(gateError instanceof WebsiteFetchError) || gateError.status !== 502) return gateError;
  let host: string;
  try {
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return gateError;
  }
  try {
    await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && DNS_NAME_NOT_FOUND_CODES.has(code)) return gateError;
    return new HeResolverFailureError(
      `DNS-резолвер не ответил для ${host} (${typeof code === 'string' ? code : 'без кода'})`,
      e,
    );
  }
  return new HeResolverFailureError(
    `DNS-резолвер не ответил для ${host} с первой попытки (повторный запрос прошёл)`,
    gateError,
  );
}

/**
 * Защита чтения для каждого запроса этого модуля (см. шапку): публичный адрес перед
 * каждым запросом и шагом редиректа, прямой маршрут — с проверкой при
 * соединении (enrich/publicAddress.ts). Явный http-вариант главной в цепочке
 * fetchAndExtract — не редирект, отказ https → http его не касается.
 *
 * 'us' — политика английского рынка целиком (createUsWebsiteFetchGuard в
 * enrich/publicAddress.ts, с этим же HE_MAX_REDIRECTS): редирект https → http
 * не проходится, порт только 80/443 (STANDARD_WEB_PORTS), адреса наших
 * серверов (OWN_SERVER_ADDRESSES) отклоняются по литералу, по ответу нашего
 * резолвера и при соединении прямого маршрута. 'ru' — только публичный адрес:
 * https → http проходится, как проходил в redirect: 'follow' до этой правки,
 * порт и адрес наших серверов не проверяются.
 */
function heFetchGuard(market: HeMarket): WebsiteFetchGuard {
  if (market === 'us') return createUsWebsiteFetchGuard({ maxRedirects: HE_MAX_REDIRECTS });
  return createPublicWebsiteGuard({ allowHttpDowngrade: true, maxRedirects: HE_MAX_REDIRECTS });
}

/**
 * SSRF-гейт до первого запроса: адрес публичный и резолвится. Отказ у рынка
 * 'us' — род `dns` (сбой самого резолвера отделён, см. usDnsFailure), у RU —
 * исходная ошибка гейта, как до порта ENG.
 * Общий шаг defaultFetchText и defaultFetchPage.
 *
 * У рынка 'us' следом — политика его защиты чтения (порт и адреса наших
 * серверов, heFetchGuard): адрес, который она отклоняет, — тоже факт об
 * адресе, род `dns`, а не `no_html` с «Try again», который ничего не изменит.
 * Её lookup ответил ошибкой — проверка пропускает (решает соединение, см.
 * enrich/publicAddress.ts), как и на каждом следующем запросе; молчит дольше
 * DNS_TIMEOUT_MS — истёкший срок операции, как и у первого lookup.
 */
async function gateWebsiteAddress(normalized: string, signal: AbortSignal, market: HeMarket): Promise<void> {
  try {
    await withHeDeadline('website DNS', DNS_TIMEOUT_MS, signal, () =>
      assertPublicWebsite(normalized),
    );
  } catch (e) {
    if (market !== 'us' || signal.aborted || isHeOperationTimeout(e)) {
      throw asSiteUnreachable(e, 'dns', normalized, signal, market);
    }
    // Повторный lookup — под тем же бюджетом DNS, что и первый.
    const failure = await withHeDeadline('website DNS', DNS_TIMEOUT_MS, signal, () =>
      usDnsFailure(e, normalized),
    );
    if (failure !== e) throw failure;
    throw asSiteUnreachable(e, 'dns', normalized, signal, market);
  }
  if (market === 'us') {
    try {
      await withHeDeadline('website DNS', DNS_TIMEOUT_MS, signal, () =>
        heFetchGuard(market).checkUrl(new URL(normalized)),
      );
    } catch (e) {
      // Отказ политики — по дискриминанту WebsiteAddressRefusedError, не по тексту.
      const refused = (e as { websiteAddressRefused?: unknown } | null)?.websiteAddressRefused === true;
      throw refused ? asSiteUnreachable(e, 'dns', normalized, signal, market) : e;
    }
  }
  // DNS-резолв не прерывается: его поздний результат не должен начать HTTP.
  signal.throwIfAborted();
}

/**
 * Дефолтный фетч: нормализация URL → SSRF-гейт (DNS/приватные адреса режем
 * до первого запроса) → fetchAndExtract (главная + «о компании», ≤3000 символов)
 * с защитой чтения и потолком тела на каждом запросе цепочки.
 * Оба шага дают собственный род недоступности у рынка 'us' — см.
 * HeSiteUnreachableError; у RU — исходные ошибки гейта и парсера.
 *
 * Порядок шагов важен: проверка публичности адреса идёт ПЕРВОЙ, до любого
 * запроса, и маршрут рынка её не обходит.
 */
export async function defaultFetchText(
  url: string,
  parent?: AbortSignal,
  market: HeMarket = 'ru',
): Promise<string> {
  const normalized = normalizeUrl(url);
  const budget = market === 'us' ? WEBSITE_TIMEOUT_US_MS : WEBSITE_TIMEOUT_MS;
  return withHeDeadline('website extraction', budget, parent, async (signal) => {
    await gateWebsiteAddress(normalized, signal, market);
    let text: string;
    try {
      text = await fetchAndExtract(normalized, {
        timeout: WEBSITE_FETCH_TIMEOUT_MS,
        signal,
        guard: heFetchGuard(market),
        maxBytes: HE_PAGE_MAX_BYTES,
        ...(market === 'us' ? ENG_WEBSITE_ROUTE : {}),
      });
    } catch (e) {
      // Пустая/JS-страница сюда НЕ попадает: у неё есть HTML, и fetchAndExtract
      // возвращает про это текст, а не бросает.
      throw isWebsiteNoHtmlError(e) ? asSiteUnreachable(e, 'no_html', normalized, signal, market) : e;
    }
    signal.throwIfAborted();
    return text;
  });
}

/**
 * Дефолтная строгая страница: тот же SSRF-гейт → fetchSinglePage (ровно этот
 * адрес, без «о компании» и запасных адресов) с защитой чтения и потолком тела.
 *
 * Исходы — те же классы, что у defaultFetchText, плюс null:
 *  - { url, text } — url — адрес после редиректов, text может быть пустым;
 *  - null — страницы нет (ответ не 2xx, не-HTML) или адрес редиректа отклонён;
 *  - HeSiteUnreachableError('dns') — гейт не пустил;
 *  - HeSiteUnreachableError('no_html') — адрес не ответил ни на одной попытке;
 *  - HeOperationTimeoutError — истёк WEBSITE_PAGE_TIMEOUT_MS; отмена — отменой.
 */
export async function defaultFetchPage(
  url: string,
  parent?: AbortSignal,
  market: HeMarket = 'ru',
  options?: { companyEvidence?: boolean; companyEvidenceTerms?: string[] },
): Promise<HeFetchedPage | null> {
  const normalized = normalizeUrl(url);
  return withHeDeadline('website page', WEBSITE_PAGE_TIMEOUT_MS, parent, async (signal) => {
    await gateWebsiteAddress(normalized, signal, market);
    let page: HeFetchedPage | null;
    try {
      page = await fetchSinglePage(normalized, {
        timeout: WEBSITE_FETCH_TIMEOUT_MS,
        signal,
        guard: { ...heFetchGuard(market), ...(market === 'us' && options?.companyEvidence === true ? { preferHttpsRedirects: true } : {}) },
        maxBytes: HE_PAGE_MAX_BYTES,
        ...(market === 'us' ? ENG_WEBSITE_ROUTE : {}),
        ...(options?.companyEvidence === true ? { companyEvidence: true } : {}),
        ...(market === 'us' && options?.companyEvidence === true && options.companyEvidenceTerms
          ? { companyEvidenceTerms: options.companyEvidenceTerms } : {}),
      });
    } catch (e) {
      throw isWebsiteNoHtmlError(e) ? asSiteUnreachable(e, 'no_html', normalized, signal, market) : e;
    }
    signal.throwIfAborted();
    return page;
  });
}

/**
 * Сигнал отмены задачи для стадии: ctx.signal (точечные вызовы, тесты) либо
 * модульный сигнал активной джобы, который воркер ставит перед runHeStage.
 * Модульный источник — не «на всякий случай»: воркер выполняет строго одну
 * джобу, и стадии получают отмену без правки контракта каждого вызова (тот же
 * приём уже работает в LLM-слое).
 */
export function heStageSignal(ctx: HeStageContext): AbortSignal | undefined {
  return ctx.signal ?? getHeActiveJobSignal() ?? undefined;
}

export function resolveFetchText(ctx: HeStageContext): HeFetchTextFn {
  // Рынок проекта ведёт маршрут и язык запроса только в дефолтной реализации
  // (тот же приём, что у resolveSearch с geo Serper); подменённый ctx.fetchText
  // — тесты и особые стадии — работает как раньше.
  const parent = heStageSignal(ctx);
  const market = ctx.market;
  const custom = ctx.fetchText;
  return (url) =>
    (custom
      ? withHeDeadline('website extraction', WEBSITE_TIMEOUT_MS, parent, () => custom(url))
      : defaultFetchText(url, parent, market)
    ).finally(() => ctx.onActivity?.());
}

/**
 * Строгая страница для стадии (подстраницы сайта, источники доказательств):
 * исходы — у defaultFetchPage. Подменённый ctx.fetchText (тесты, особые
 * стадии) отвечает и здесь — его текст считается текстом запрошенного адреса,
 * статуса у него нет, поэтому null он не даёт.
 */
export function resolveFetchPage(ctx: HeStageContext, options?: { companyEvidence?: boolean; companyEvidenceTerms?: string[] }): HeFetchPageFn {
  const parent = heStageSignal(ctx);
  const market = ctx.market;
  const custom = ctx.fetchText;
  return (url) =>
    (custom
      ? withHeDeadline('website page', WEBSITE_PAGE_TIMEOUT_MS, parent, async () => ({ url, text: await custom(url) }))
      : defaultFetchPage(url, parent, market, options)
    ).finally(() => ctx.onActivity?.());
}

/**
 * Поиск для стадии.
 *
 * ОТКАЗ ПОИСКА У RU-ПРОЕКТА — ПУСТАЯ ВЫДАЧА, КАК ДО ПОРТА ENG (решение
 * владельца 14.10.2026 «Как было»). До волны 3 дефолтный поиск не бросал
 * никогда: нет ключа, кончились кредиты, 5xx, свой таймаут — пустой массив, и
 * стадии RU-инструмента (competitors, brand_cloud, evidence, vocab) шли дальше
 * на том, что есть. С волны 3 defaultSearch бросает типизированный отказ
 * (HeSearchProviderError), а стадии по счётчику отказов останавливаются
 * (searchIo.heSearchStageFailure / heSearchOutageFailure) — это остаётся ТОЛЬКО
 * у market='us'. У любого другого рынка дефолтный поиск снова отвечает пустой
 * выдачей на отказ провайдера и на собственный срок поиска (SEARCH_TIMEOUT_MS):
 * стадия не видит отказа вовсе и идёт прежним путём. Отмена задачи (сигнал
 * джобы, в том числе сторож и срок стадии) по-прежнему бросается у обоих
 * рынков — сроки и сторож остаются общими. Подменённый ctx.search (тесты,
 * особые стадии) отвечает как есть: его отказы стадии ловили и до порта.
 */
export function resolveSearch(ctx: HeStageContext): HeSearchFn {
  // Рынок проекта ведёт geo Serper только в дефолтной реализации; подменённый
  // ctx.search (тесты, особые стадии) работает как раньше.
  const parent = heStageSignal(ctx);
  const market: HeMarket = ctx.market ?? 'ru';
  const emptyOnProviderFailure = !ctx.search && market !== 'us';
  return (q) => {
    const run = withHeDeadline('website search', SEARCH_TIMEOUT_MS, parent, (signal) =>
      ctx.search ? ctx.search(q) : defaultSearch(q, market, signal),
    );
    const settled = emptyOnProviderFailure
      ? run.catch((e: unknown): Awaited<ReturnType<HeSearchFn>> => {
          if (parent?.aborted) throw e;
          if (isHeSearchProviderError(e) || isHeOperationTimeout(e)) return [];
          throw e;
        })
      : run;
    return settled.finally(() => ctx.onActivity?.());
  };
}
