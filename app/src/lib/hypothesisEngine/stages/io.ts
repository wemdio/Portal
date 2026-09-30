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
 * Маршрут чтения (волна 7): у рынка 'us' свой порядок групп прокси и свой
 * Accept-Language — см. ENG_WEBSITE_ROUTE. Рынок 'ru' читает сайт ровно теми
 * же запросом и маршрутом, что и до этой правки; общий парсер
 * (lib/enrich/websiteParser.ts) держит русские значения дефолтами.
 */

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { DEFAULT_MAX_ABOUT_CANDIDATES } from '@/lib/enrich/aboutCandidates';
import {
  fetchAndExtract,
  isWebsiteNoHtmlError,
  normalizeUrl,
  type WebsiteFetchRouteOrder,
} from '@/lib/enrich/websiteParser';
import { getHeActiveJobSignal } from '../llm';
import type { HeMarket } from '../market';
import { isHeOperationTimeout, withHeDeadline } from '../operationDeadline';
import { defaultSearch, HE_SEARCH_TIMEOUT_MS } from './searchIo';
import type { HeStageContext } from './shared';

export type HeFetchTextFn = (url: string) => Promise<string>;
export type HeSearchFn = (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;

/** DNS-резолв SSRF-гейта: у node:dns своего срока нет — молчащий резолвер вешал стадию. */
const DNS_TIMEOUT_MS = 8_000;

/**
 * Чтение сайта: константы цепочки fetchAndExtract (lib/enrich/websiteParser.ts).
 * На каждый адрес там 2 попытки по WEBSITE_FETCH_TIMEOUT_MS с паузой
 * FETCH_RETRY_DELAY_MS между ними; адресов — главная + www + http.
 *
 * Срок попытки передаётся в fetchAndExtract ЯВНО (defaultFetchText ниже), а не
 * совпадает с его дефолтом по договорённости: арифметика бюджета опирается
 * именно на это число, и молчаливое совпадение с чужой константой держалось бы
 * ровно до первой её правки.
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
function websiteTimeoutMs(): number {
  const perAddress = WEBSITE_FETCH_ATTEMPTS * WEBSITE_FETCH_TIMEOUT_MS + WEBSITE_FETCH_RETRY_DELAY_MS;
  const addresses = WEBSITE_ORIGIN_VARIANTS + aboutCandidatesInEffect();
  const chain = DNS_TIMEOUT_MS + addresses * perAddress;
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
  // порогов далеко.
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
const WEBSITE_TIMEOUT_MS = websiteTimeoutMs();
/**
 * Поиск: срок HTTP-запроса живёт внутри клиента Serper, а этот бюджет
 * страхует зависший клиент И покрывает журнал расхода вокруг запроса
 * (разбивка — в searchIo.ts, HE_SEARCH_TIMEOUT_MS).
 */
const SEARCH_TIMEOUT_MS = HE_SEARCH_TIMEOUT_MS;

/**
 * Сайт клиента недоступен — это ФАКТ О САЙТЕ, а не сбой движка. Два рода:
 *  - `dns` — гейт не пустил к первому запросу: домен не резолвится, адрес
 *    невалидный либо приватный (`assertPublicWebsite`);
 *  - `no_html` — хост принял соединение, но ни один адрес origin'а не отдал
 *    HTML (`WebsiteNoHtmlError` из websiteParser).
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
 * (`clientEngProjection.toClientEngStageErrorCode` → `clientErrors`, код
 * `website_unreachable`), и экран печатает английскую константу справочника.
 *
 * АСИММЕТРИЯ, которую надо знать читателю логов: слова «Сайт клиента» в тексте
 * верны не всегда, а класс всё равно один. Ошибку бросает `defaultFetchText` для
 * ЛЮБОГО адреса, который ей дали, а дают ей и чужие: главная и кейс-страница
 * бренда (stages/brandCloud.ts), источник поисковой выдачи
 * (stages/evidence.ts), главная конкурента (stages/competitors.ts). То есть в
 * журнале стадии может стоять «Сайт клиента недоступен» про домен конкурента.
 *
 * Почему текст всё равно НЕ меняется. Первые слова вместе с родом в скобках —
 * якорь классификатора кабинета (clientErrors.ts), и разойтись эти два места не
 * имеют права; а разделить текст на «свой» и «чужой» значило бы либо два
 * сообщения под один якорь, либо перенос якоря вместе с правилом.
 * Цена асимметрии при этом ограничена ОДНИМ местом: наружу — в
 * `he_projects.error`/`he_jobs.error` и дальше в код `website_unreachable` —
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
): unknown {
  if (signal.aborted || isHeOperationTimeout(e)) return e;
  return new HeSiteUnreachableError(kind, url, e instanceof Error ? e.message : String(e), e);
}

/**
 * Маршрут чтения для АНГЛИЙСКОГО рынка.
 *
 * Дефолт websiteParser рассчитан на .ru-сайт: лестница попыток начинается с
 * приоритетной (российской) группы прокси, а запрос уходит с русским
 * Accept-Language. Для сайта из США это неверно дважды — русский exit-узел
 * чаще режут и медленнее ходит, а по языку сайт может отдать другую страницу
 * или редирект. Переворачиваем порядок групп и просим английскую страницу;
 * российская группа остаётся ВТОРОЙ попыткой, ни один маршрут не потерян.
 *
 * Рынок 'ru' не передаёт ничего: и заголовок, и порядок там ровно те же, что
 * были до этой правки. Строка языка совпадает с EN_ACCEPT_LANGUAGE почтового
 * скрапера — два места, куда уезжает английская локаль, обязаны просить одно.
 */
const ENG_WEBSITE_ROUTE: { routeOrder: WebsiteFetchRouteOrder; acceptLanguage: string } = {
  routeOrder: 'non-priority-first',
  acceptLanguage: 'en-US,en',
};

/**
 * Дефолтный фетч: нормализация URL → SSRF-гейт (DNS/приватные адреса режем
 * до первого запроса) → fetchAndExtract (главная + «о компании», ≤3000 символов).
 * Оба шага дают собственный род недоступности — см. HeSiteUnreachableError.
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
  return withHeDeadline('website extraction', WEBSITE_TIMEOUT_MS, parent, async (signal) => {
    try {
      await withHeDeadline('website DNS', DNS_TIMEOUT_MS, signal, () =>
        assertPublicWebsite(normalized),
      );
    } catch (e) {
      throw asSiteUnreachable(e, 'dns', normalized, signal);
    }
    // DNS-резолв не прерывается: его поздний результат не должен начать HTTP.
    signal.throwIfAborted();
    let text: string;
    try {
      text = await fetchAndExtract(normalized, {
        timeout: WEBSITE_FETCH_TIMEOUT_MS,
        signal,
        ...(market === 'us' ? ENG_WEBSITE_ROUTE : {}),
      });
    } catch (e) {
      // Пустая/JS-страница сюда НЕ попадает: у неё есть HTML, и fetchAndExtract
      // возвращает про это текст, а не бросает.
      throw isWebsiteNoHtmlError(e) ? asSiteUnreachable(e, 'no_html', normalized, signal) : e;
    }
    signal.throwIfAborted();
    return text;
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

export function resolveSearch(ctx: HeStageContext): HeSearchFn {
  // Рынок проекта ведёт geo Serper только в дефолтной реализации; подменённый
  // ctx.search (тесты, особые стадии) работает как раньше.
  const parent = heStageSignal(ctx);
  return (q) =>
    withHeDeadline('website search', SEARCH_TIMEOUT_MS, parent, (signal) =>
      ctx.search ? ctx.search(q) : defaultSearch(q, ctx.market ?? 'ru', signal),
    ).finally(() => ctx.onActivity?.());
}
