/**
 * Стадия site_profile: фетч сайта клиента (SSRF-гейт + websiteParser) →
 * докачка контентных страниц (/about, /uslugi, /prices, …, корпус до ~12k
 * символов — профиль по одной главной давал усреднённые гипотезы) →
 * LLM-профиль → снапшот в he_projects.brief.site_profile, статус проекта
 * переводится в 'researching'. Тонкий/JS-сайт (мало текста или заглушка
 * парсера) помечается brief.site_thin — UI просит ручное описание бизнеса
 * (business_override), которое стадия hypotheses кладёт в промпт поверх
 * профиля.
 *
 * Дополнительно — наполнение кейс-банка (he_cases, source='site'): по тексту
 * сайта + до 3 очевидных кейс-страниц (/cases, /case-studies, /otzyvy, …)
 * LLM извлекает до 8 доказательных кейсов клиента (дедуп по нормализованному
 * тексту). Refresh по снимку: site-строки проекта читаются ДО вставки, на
 * каждый ключ (нормализованный текст) остаётся одна строка, вставляются только
 * кейсы, которых в снимке нет, и удаляются строки снимка, не совпавшие со
 * свежим набором, и лишние копии одного ключа; при пустой выборке или сбое
 * вставки старые кейсы сохраняются. Загруженные вручную (source='upload') не
 * трогаются. Весь кейс-шаг best-effort: ошибка (LLM/БД/нет таблицы на
 * параллельном роллауте) логируется и НЕ роняет основную стадию.
 *
 * Локализация: при he_projects.market='us' оба LLM-вызова идут EN-промптами
 * (prompts/siteProfile.en), иначе — RU (обратная совместимость).
 *
 * Только market='us' (рынок 'ru' читает и строит всё, как раньше):
 *  - доп. страницы — свои англоязычные списки путей (CONTENT_PAGE_PATHS_EN,
 *    CASE_PAGE_PATHS_EN) строгим чтением одной страницы (io.ts
 *    resolveFetchPage): отсутствующий путь — «страницы нет» за один запрос, а
 *    не главная или «о компании» вместо неё. Страница, чей итоговый адрес или
 *    текст уже взят (главная, редирект двух путей на один адрес), в корпус
 *    второй раз не идёт;
 *  - бриф клиента — второй источник профиля, двумя блоками EN-промпта
 *    (clientBriefForProfile): факты о клиенте (business_override,
 *    offer_override) — на конфликте с текстом сайта правы они, у тонкого или
 *    JS-сайта профиль строится в основном по ним; пожелания по таргетингу
 *    (рамка ЦА icp) — не факты, только для target_audience;
 *  - current_clients и cases профиля — только дословно из текста сайта: что
 *    модель вернула сверх этого (пожелание «hospitals» из рамки ЦА в том
 *    числе), код выбрасывает до записи (keepSiteLiteralProof);
 *  - профиль несёт product_category — категорию продукта словами покупателя;
 *    по ней стадия competitors ищет конкурентов, а не только по имени бренда.
 *
 * Сроки чтения сайта (волна 3): каждое чтение ограничено сроком (io.ts), и
 * истёкший срок — НЕ «страницы нет». Три исхода стадии различимы:
 *  - главная не ответила в срок → наружу летит HeOperationTimeoutError, в
 *    логе — отдельная строка. Тип важен САМОЙ стадии: таймаут не превращается
 *    ни в site_unreachable, ни в site_thin (бриф не трогаем). Своей ветки у
 *    воркера для этого класса нет: там это обычный фейл стадии — попытка
 *    тратится, повтор назначается без паузы, на MAX_ATTEMPTS джоба падает.
 *    Кабинет ENG сводит текст отказа к коду 'timeout' (clientErrors.ts);
 *  - докачка не ответила в срок → остальные пути этого origin не перебираем
 *    (каждый стоил бы ещё один полный срок) и пишем это в лог; профиль строится
 *    по тому, что успели прочитать;
 *  - сайт ответил, но текста мало → как и раньше brief.site_thin (UI просит
 *    ручное описание бизнеса). Таймаут в site_thin НЕ превращается.
 *
 * Недоступный сайт (волна 4b): мёртвый домен клиента — законный исход
 * исследования, а не сбой движка, и стадия его переживает:
 *  - молчащий origin запоминается на время прогона (silentOrigins) и остальные
 *    его пути не перебираются: каждый пошёл бы тем же кругом (главная + www +
 *    http + до 4 кандидатов «о компании» ≈ 2 минуты), и 14 путей превращали
 *    один мёртвый хост в полчаса работы односоточного воркера;
 *  - исход пишется в бриф (site_thin + site_unreachable) ДО любого отказа,
 *    поэтому мастер сразу просит ручное описание бизнеса;
 *  - ручное описание уже есть → профиль строим по нему, и прогон идёт дальше;
 *    его нет → профиль выдумывать не из чего, стадия отказывает с честной
 *    причиной (в кабинете — английский код website_unreachable у рода dns и
 *    технический website_no_html у рода no_html).
 */

import { z } from 'zod';

import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';

import { callLLMWithSchema, getHeModel } from '../llm';
import { projectMarket, type HeMarket } from '../market';
import { HeSiteProfileSchema } from '../schemas';
import { heCaseDraftSchema, normalizeCaseText } from '../caseBank';
import { readHeIcpFrame } from '../icpFrame';
import { BUSINESS_OVERRIDE_MAX_LENGTH, OFFER_OVERRIDE_MAX_LENGTH } from '../projectBriefPatch';
import { buildSiteCaseExtractionMessages, buildSiteProfileMessages } from '../prompts/siteProfile';
import {
  buildSiteCaseExtractionMessagesEn,
  buildSiteProfileMessagesEn,
} from '../prompts/siteProfile.en';
import type { HeJob, HeProject } from '../types';
import {
  heStageSignal,
  HeSiteUnreachableError,
  isHeSiteUnreachable,
  resolveFetchPage,
  resolveFetchText,
  type HeFetchedPage,
  type HeFetchPageFn,
  type HeFetchTextFn,
} from './io';
import { heIoFailureReason, isHeOperationTimeout } from '../operationDeadline';
import {
  addUsage,
  newUsage,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/** Локальная схема ответа LLM по кейсам (намеренно НЕ в schemas.ts). */
const HeSiteCasesSchema = z.object({
  cases: z.array(heCaseDraftSchema).max(8),
});

/**
 * Очевидные пути кейс-страниц рынка 'ru' — слепой перебор на том же origin.
 * EN-пути (/case-studies, /testimonials, /customers) перемешаны с RU — для
 * RU-сайтов они безвредны (404 — ожидаемая норма), а порядок задаёт
 * приоритет в пределах MAX_PAGE_ATTEMPTS. Рынок 'us' перебирает свой список
 * (CASE_PAGE_PATHS_EN ниже).
 */
export const CASE_PAGE_PATHS = [
  '/cases',
  '/case-studies',
  '/kejsy',
  '/projects',
  '/testimonials',
  '/clients',
  '/portfolio',
  '/customers',
  '/otzyvy',
  '/reviews',
  '/works',
];

/** Капы: не более 3 успешно скачанных кейс-страниц, не более 6 попыток. */
const MAX_EXTRA_PAGES = 3;
const MAX_PAGE_ATTEMPTS = 6;

/** Страница короче этого порога считается пустой/бесполезной. */
const MIN_PAGE_CHARS = 100;

/**
 * Контентные страницы для профиля бизнеса (рынок 'ru'): «о компании», услуги,
 * цены, продукты. Профиль, построенный на одной главной (≤3000 символов), даёт
 * усреднённые гипотезы из приоров модели — докачиваем до 4 страниц в корпус.
 * Рынок 'us' перебирает свой список (CONTENT_PAGE_PATHS_EN ниже).
 */
export const CONTENT_PAGE_PATHS = [
  '/about',
  '/o-nas',
  '/company',
  '/about-us',
  '/o-kompanii',
  '/uslugi',
  '/services',
  '/prices',
  '/tseny',
  '/products',
  '/solutions',
  '/resheniya',
];

/**
 * Пути рынка 'us': англоязычный сайт описывает продукт на /products,
 * /solutions, /pricing, /platform, а клиентов — на /customers и
 * /case-studies. Русских путей здесь нет; порядок — приоритет, а длина
 * списков равна капам попыток (MAX_CONTENT_ATTEMPTS, MAX_PAGE_ATTEMPTS): путь
 * сверх капа не пробовался бы никогда. Читаются строгим чтением страницы (см.
 * fetchExtraPages), поэтому отсутствующий (404) путь стоит один запрос.
 */
const CONTENT_PAGE_PATHS_EN = [
  '/about',
  '/about-us',
  '/company',
  '/products',
  '/solutions',
  '/services',
  '/pricing',
  '/platform',
];
const CASE_PAGE_PATHS_EN = [
  '/customers',
  '/case-studies',
  '/customer-stories',
  '/success-stories',
  '/testimonials',
  '/clients',
];

/**
 * Строгое чтение (рынок 'us'): сколько подряд путей должно не ответить ни на
 * одной из двух попыток (HeSiteUnreachableError рода no_html), чтобы origin
 * считался молчащим. У строгого чтения запасных адресов нет, и один такой
 * путь — это две попытки одного адреса (≈16 с), а не полный круг цепочки, как у
 * fetchText; одного медленного пути мало, чтобы бросить остальные.
 */
const STRICT_SILENT_AFTER_NO_HTML = 2;

/** Капы контентной докачки: ≤4 успешных страниц, ≤8 попыток (оба списка). */
const MAX_CONTENT_PAGES = 4;
const MAX_CONTENT_ATTEMPTS = 8;
/** Символов на доп. страницу в корпусе профиля; общий кап корпуса. */
const EXTRA_PAGE_EXCERPT = 2500;
const MAX_PROFILE_CORPUS = 12000;
/** Корпус короче порога (или JS-заглушка) → сайт «тонкий», нужен ручной бриф. */
const THIN_SITE_CHARS = 800;
const JS_STUB_MARK = 'требует JavaScript';

/**
 * Память ОДНОГО прогона стадии: origin'ы, которые не отдали ни байта HTML.
 *
 * Живёт в локальной переменной runSiteProfileStage и умирает вместе с прогоном —
 * ни модульного кэша, ни записи в БД: хост, молчавший во время аварии, обязан
 * получить честную попытку на следующем прогоне (и на следующей попытке джобы).
 *
 * Почему это почти не гасит живой, но медленный на одном пути хост. Запись
 * появляется только от HeSiteUnreachableError, а его бросает лишь та проба, у
 * которой НИ ОДИН адрес цепочки не отдал HTML: ни запрошенный путь с ретраем, ни
 * www- и http-корни того же origin'а, ни до 4 кандидатов «о компании». Медленный
 * путь даёт истёкший срок (свой тип, своя ветка timedOut), отсутствующий путь —
 * HTML страницы 404, пустой или JS-путь — текст-заглушку: ни один из этих
 * исходов в память не пишется.
 *
 * ОДИН живой origin всё-таки попасть сюда может, и это осознанная цена. Ответ
 * считается HTML'ом по content-type (`fetchHtml`: пустое тело с
 * html-подобным или отсутствующим типом — всё ещё HTML, поэтому обычный 404
 * даёт заглушку, а не молчание). Но ответ с НЕ html-подобным типом (404 от
 * API-шлюза, `application/json`) и любой 5xx не считаются HTML вовсе — а
 * спасательные адреса цепочки есть не у каждого origin'а: у https-хоста, который
 * УЖЕ www, www-корень не пробуется (он и есть запрошенный), и если http-слушателя
 * на нём нет, http-корень отваливается сразу. Остаются только кандидаты «о
 * компании», и когда ни один из них не существует, живой origin объявляется
 * молчащим по ОДНОМУ такому пути, а остальные 13 не пробуются.
 *
 * Чинить это здесь нечем и незачем: стадия уже прочитала главную (иначе она
 * ушла бы веткой unreachable выше), профиль строится по прочитанному, а цена
 * ошибки — недобранные доп. страницы одного прогона против гарантии, что мёртвый
 * хост не съест полчаса односоточного воркера. Следующий прогон пробует заново —
 * память живёт только внутри прогона.
 *
 * Всё сказанное выше о пробе пути — про рынок 'ru' (fetchText). Рынок 'us'
 * читает доп. страницы строго (resolveFetchPage): 404, 5xx, 403 и не-HTML там
 * — «страницы нет» (null), а no_html значит, что сам адрес не ответил ни на
 * одной из двух попыток. Поэтому путь 'us' пишет origin в память не с первого
 * no_html, а со STRICT_SILENT_AFTER_NO_HTML подряд (любой ответ сбрасывает
 * счёт); род dns — гейт не пустил хост — пишет сразу, как и у 'ru'.
 */
type HeSilentOrigins = Set<string>;

/** Origin адреса или null, если адрес не разбирается (ветку уже держит вызов). */
function siteOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Дотянуть контентные + кейс-страницы (рынок 'ru' — тем же fetchText, что и
 * главная; 'us' — строгим чтением, см. последний абзац). Бюджеты РАЗДЕЛЬНЫЕ:
 * контентные пути (12 шт) не съедают попытки кейс-путей — иначе кейс-страницы
 * недостижимы вообще (8 попыток < 12 контентных путей).
 * Каждая страница best-effort: 404/ошибка парсера — норма.
 *
 * Истёкший срок — не «нет страницы»: origin не отвечает, и остальные пути
 * (их до 14) стоили бы по полному сроку каждый. Такой перебор и есть та самая
 * зависшая стадия, поэтому на первом таймауте докачку прекращаем и сообщаем об
 * этом наверх (timedOut), чтобы исход попал в лог отдельной строкой.
 * Отмена задачи не «пропущенная страница», а конец работы — её пробрасываем.
 *
 * Молчащий origin — второй стоп, и он не про срок: проба, у которой ни один
 * адрес не отдал HTML, доказала это за ≈2 минуты полного круга, и остальные 13
 * путей повторили бы тот же круг с тем же исходом. Такой origin попадает в
 * память прогона (silentOrigins), и она же останавливает второй цикл этой
 * функции — кейс-пути. ЕДИНСТВЕННАЯ точка этой проверки здесь: кейс-шаг стадии
 * (refreshSiteCases) своего перебора путей не имеет и получает готовые страницы.
 *
 * Рынок 'us' (передан strict): свои списки путей и строгое чтение страницы.
 * Взятая страница отдаёт в корпус свой итоговый адрес (после редиректов), а
 * страница, чей адрес или текст уже взят — главная, предыдущая доп. страница,
 * контентная, вернувшаяся кейсовой, — пропускается и считается в duplicates:
 * «/about» и «/about-us», уводящие на один «/company», дают одну страницу.
 * Текст сравнивается вхождением в уже взятый (главная fetchText несёт и
 * «о компании»), адрес — без схемы, «www.», запроса и хвостового «/».
 */
async function fetchExtraPages(
  fetchText: HeFetchTextFn,
  websiteUrl: string,
  silentOrigins: HeSilentOrigins,
  jobSignal?: AbortSignal,
  strict?: { fetchPage: HeFetchPageFn; homeText: string },
): Promise<{
  content: Array<{ url: string; text: string }>;
  cases: Array<{ url: string; text: string }>;
  timedOut: boolean;
  duplicates: number;
}> {
  const origin = siteOrigin(websiteUrl);
  if (!origin) {
    return { content: [], cases: [], timedOut: false, duplicates: 0 };
  }
  let timedOut = false;
  const stop = () => timedOut || silentOrigins.has(origin);
  const takenUrls = new Set<string>();
  const takenTexts: string[] = [];
  let duplicates = 0;
  let noHtmlStreak = 0;
  if (strict) {
    const homeUrl = pageUrlKey(websiteUrl);
    if (homeUrl) takenUrls.add(homeUrl);
    const homeText = pageTextKey(strict.homeText);
    if (homeText) takenTexts.push(homeText);
  }
  const takeStrictPage = (page: HeFetchedPage | null): { url: string; text: string } | null => {
    noHtmlStreak = 0;
    if (!page || page.text.trim().length < MIN_PAGE_CHARS) return null;
    const urlKey = pageUrlKey(page.url);
    const textKey = pageTextKey(page.text);
    if ((urlKey && takenUrls.has(urlKey)) || takenTexts.some((taken) => taken.includes(textKey))) {
      duplicates += 1;
      return null;
    }
    if (urlKey) takenUrls.add(urlKey);
    takenTexts.push(textKey);
    return { url: page.url, text: page.text };
  };
  const fetchPath = async (path: string): Promise<{ url: string; text: string } | null> => {
    try {
      if (strict) return takeStrictPage(await strict.fetchPage(origin + path));
      const text = await fetchText(origin + path);
      if (text && text.trim().length >= MIN_PAGE_CHARS) return { url: origin + path, text };
    } catch (e) {
      if (jobSignal?.aborted) throw e;
      if (isHeOperationTimeout(e)) timedOut = true;
      else if (
        isHeSiteUnreachable(e)
        && (!strict || e.kind === 'dns' || ++noHtmlStreak >= STRICT_SILENT_AFTER_NO_HTML)
      ) {
        silentOrigins.add(origin);
      }
      /* страницы может не существовать — это ожидаемо */
    }
    return null;
  };

  const content: Array<{ url: string; text: string }> = [];
  let contentAttempts = 0;
  for (const path of strict ? CONTENT_PAGE_PATHS_EN : CONTENT_PAGE_PATHS) {
    if (content.length >= MAX_CONTENT_PAGES || contentAttempts >= MAX_CONTENT_ATTEMPTS || stop()) break;
    contentAttempts++;
    const page = await fetchPath(path);
    if (page) content.push(page);
  }

  const cases: Array<{ url: string; text: string }> = [];
  let caseAttempts = 0;
  for (const path of strict ? CASE_PAGE_PATHS_EN : CASE_PAGE_PATHS) {
    if (cases.length >= MAX_EXTRA_PAGES || caseAttempts >= MAX_PAGE_ATTEMPTS || stop()) break;
    caseAttempts++;
    const page = await fetchPath(path);
    if (page) cases.push(page);
  }
  return { content, cases, timedOut, duplicates };
}

/** Ключ адреса страницы для дедупа: хост без «www.» + путь без хвостового «/». */
function pageUrlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Ключ текста страницы для дедупа: без многоточия обрезки, пробелы схлопнуты, регистр снят. */
function pageTextKey(text: string): string {
  return text.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Корпус профиля: главная + контентные страницы с маркерами URL, с капом. */
function buildProfileCorpus(siteText: string, extraPages: Array<{ url: string; text: string }>): string {
  let corpus = siteText;
  for (const page of extraPages) {
    if (corpus.length >= MAX_PROFILE_CORPUS) break;
    corpus += `\n\n=== ${page.url} ===\n${page.text.slice(0, EXTRA_PAGE_EXCERPT)}`;
  }
  return corpus.slice(0, MAX_PROFILE_CORPUS);
}

/**
 * Кейс-шаг стадии (best-effort): LLM-извлечение до 8 кейсов → refresh в
 * he_cases (только source='site' этого проекта): снимок site-строк до
 * вставки, insert кейсов, которых в снимке нет, затем delete строк снимка вне
 * свежего набора и лишних копий одного кейса.
 *
 * Кейс-страницы приходят ГОТОВЫМИ и параметр обязателен. Свой перебор путей у
 * этого шага был (fetchCasePages) и удалён: единственный вызов всегда передавал
 * `extraPages.cases`, то есть массив — пустой, когда докачка ничего не нашла или
 * остановилась, — поэтому фолбэк `?? (await fetchCasePages(...))` не мог
 * сработать НИ РАЗУ. Мёртвая ветка при этом выглядела как второй предохранитель:
 * в ней стояла своя проверка молчащего origin'а, и по коду казалось, что таких
 * проверок две. Она одна, и живёт она в fetchExtraPages.
 */
async function refreshSiteCases(
  ctx: HeStageContext,
  projectId: string,
  websiteUrl: string,
  siteText: string,
  market: HeMarket,
  casePages: Array<{ url: string; text: string }>,
): Promise<{ extracted: number; tokensUsed: number; costUsd: number }> {
  const extraPages = casePages;
  stageLog(ctx, `[site_profile] кейс-страницы: ${extraPages.length}`);

  const casesInput = { websiteUrl, siteText, extraPages };
  const llm = await callLLMWithSchema(
    market === 'us'
      ? buildSiteCaseExtractionMessagesEn(casesInput)
      : buildSiteCaseExtractionMessages(casesInput),
    HeSiteCasesSchema,
    { model: getHeModel('bulk'), maxTokens: 4096 },
  );
  // Дедуп по нормализованному тексту: главная и /cases часто описывают один
  // и тот же кейс — без дедупа он вставился бы дважды.
  //
  // Текст модели чистим ДО дедупа и вставки: один NUL или одиночный UTF-16
  // суррогат — и PostgREST отвергает всю вставку he_cases. Порядок важен:
  // ключ дедупа и сверки со снимком (freshKeys ниже) считается по ТОМУ ЖЕ
  // тексту, что ляжет в строку, — иначе на следующем прогоне этот же кейс не
  // узнавался бы в снимке: прежняя строка уходила бы «устаревшей», а он
  // вставлялся заново. Текст без этих двух символов не меняется.
  const seen = new Set<string>();
  const cases = stripUnstorableJsonChars(llm.data.cases)
    .slice(0, 8)
    .filter((c) => c.text.trim().length > 0)
    .filter((c) => {
      const key = normalizeCaseText(c.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Пустая выборка — ничего не удаляем: старые site-кейсы сохраняются.
  if (!cases.length) {
    return { extracted: 0, tokensUsed: llm.tokensUsed, costUsd: llm.costUsd };
  }

  // Снимок site-строк проекта ДО вставки: уборка ниже трогает только его, то
  // есть ни строку этого прогона, ни чужую запись после снимка удалить не может.
  // На каждый ключ (нормализованный текст — тот же, что у дедупа выше) остаётся
  // одна строка, самая ранняя; другие копии ключа и строки, которых нет в
  // свежем наборе, — устаревшие. Вставляются только кейсы, которых в снимке
  // нет: совпавший кейс остаётся прежней строкой, а не копией рядом с ней.
  // Upload-кейсы не трогаем.
  const { data: siteRows, error: readError } = await ctx.supabase
    .from('he_cases')
    .select('id, text')
    .eq('project_id', projectId)
    .eq('source', 'site')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (readError) throw new Error(`he_cases read site: ${readError.message}`);
  const freshKeys = new Set(cases.map((c) => normalizeCaseText(c.text)));
  const retainedKeys = new Set<string>();
  const staleIds: string[] = [];
  for (const row of (siteRows ?? []) as Array<{ id: string; text: string | null }>) {
    const key = normalizeCaseText(row.text ?? '');
    if (!freshKeys.has(key) || retainedKeys.has(key)) staleIds.push(row.id);
    else retainedKeys.add(key);
  }
  const missingCases = cases.filter((c) => !retainedKeys.has(normalizeCaseText(c.text)));

  // Insert-first: сначала недостающие строки — при сбое вставки весь прежний
  // набор проекта остаётся на месте (delete-then-insert терял бы его целиком).
  if (missingCases.length) {
    const { error: insError } = await ctx.supabase.from('he_cases').insert(
      missingCases.map((c) => ({
        project_id: projectId,
        source: 'site',
        filename: null,
        industry: c.industry,
        client_type: c.client_type,
        task: c.task,
        metrics: c.metrics,
        result: c.result,
        text: c.text,
      })),
    );
    if (insError) throw new Error(`he_cases insert site: ${insError.message}`);
  }

  if (staleIds.length) {
    const { error: delError } = await ctx.supabase
      .from('he_cases')
      .delete()
      .eq('project_id', projectId)
      .eq('source', 'site')
      .in('id', staleIds);
    if (delError) throw new Error(`he_cases delete stale site: ${delError.message}`);
  }

  return { extracted: cases.length, tokensUsed: llm.tokensUsed, costUsd: llm.costUsd };
}

/**
 * Ручное описание бизнеса из брифа — ровно тем же чтением, что стадия
 * hypotheses (`stages/hypotheses.ts`): строка после trim либо null.
 */
function readBusinessOverride(brief: HeProject['brief']): string | null {
  const value = (brief as Record<string, unknown> | null)?.business_override;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Пометка корпуса рынка 'ru', когда профиль строится по ручному описанию, а не
 * по сайту: RU-промпт требует «опирайся ТОЛЬКО на текст сайта», и молча
 * подсунуть туда чужой текст — значит получить профиль, который врёт про
 * источник. Рынок 'us' описание корпусом не передаёт: EN-промпт получает бриф
 * отдельным блоком (clientBriefForProfile) и прямо знает, что сайт не прочитан.
 */
const MANUAL_BUSINESS_MARK_RU = '=== Сайт прочитать не удалось. Описание бизнеса от клиента ===';

/**
 * Бриф клиента для EN-промпта профиля (только market='us'), двумя блоками — у
 * них разный статус для профиля (в кабинете их набирает сам клиент, у
 * staff-проекта — специалист):
 *  - facts — факты о клиенте: описание бизнеса (business_override) и оффер
 *    (offer_override). Они про то, что клиент делает и продаёт;
 *  - wishes — пожелания по таргетингу из рамки ЦА (icp, readHeIcpFrame): кого
 *    клиент хочет или не хочет видеть покупателем. Это НЕ факты: «Customers the
 *    client wants to reach: hospitals» не значит, что больницы у клиента уже
 *    есть. Промпт пускает их только в target_audience, а current_clients и
 *    cases после ответа сверяет с текстом сайта код (keepSiteLiteralProof).
 * Блок — строки «подпись: значение» либо null, когда строк нет. Описание и
 * оффер в платный вызов идут не длиннее капа записи поля (projectBriefPatch):
 * значение, сохранённое до капа или в обход роута, длиннее не уйдёт. Рамку ЦА
 * режет при чтении сам readHeIcpFrame.
 */
function clientBriefForProfile(brief: HeProject['brief']): { facts: string | null; wishes: string | null } {
  const fields = (brief ?? {}) as Record<string, unknown>;
  const facts: string[] = [];
  const business = readBusinessOverride(brief);
  if (business) facts.push(`About the business: ${sliceWholeChars(business, 0, BUSINESS_OVERRIDE_MAX_LENGTH)}`);
  const offer = typeof fields.offer_override === 'string' ? fields.offer_override.trim() : '';
  if (offer) facts.push(`Offer: ${sliceWholeChars(offer, 0, OFFER_OVERRIDE_MAX_LENGTH)}`);
  const wishes: string[] = [];
  const icp = readHeIcpFrame(fields.icp);
  if (icp?.include.length) wishes.push(`Customers the client wants to reach: ${icp.include.join('; ')}`);
  if (icp?.exclude.length) wishes.push(`Customers the client does not want to reach: ${icp.exclude.join('; ')}`);
  if (icp?.size) wishes.push(`Wanted customer company size: ${icp.size}`);
  if (icp?.geo) wishes.push(`Wanted customer geography: ${icp.geo}`);
  return {
    facts: facts.length ? facts.join('\n') : null,
    wishes: wishes.length ? wishes.join('\n') : null,
  };
}

/** Слова текста для дословной сверки: NFKC, нижний регистр, всё, кроме букв и цифр, — один пробел. */
function literalWords(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Сколько выброшенных записей показать в строке лога (остальные — числом). */
const LITERAL_DROP_LOG_SAMPLE = 3;

/**
 * Доказательства профиля рынка 'us' — только дословно из текста сайта.
 *
 * current_clients и cases кабинет показывает клиенту («Current clients»), а
 * письма берут их в материалы как доказательство (chain: proof «из
 * материалов»), и письма пула уходят без проверки человеком. Промпт требует
 * брать их только из текста сайта и его словами; здесь это проверяет код:
 * запись остаётся, только если её слова целиком, подряд и по границам слов
 * есть в корпусе, который видела модель (регистр, пунктуация и пробелы не
 * различаются). Остальное выбрасывается — пожелание из рамки ЦА («hospitals»),
 * которого на сайте нет, и пересказ кейса чужими словами тоже. Сайт недоступен
 * — корпус пуст, и оба списка пустые. Остальные поля профиля не трогаются.
 */
function keepSiteLiteralProof<T extends { current_clients: string[]; cases: string[] }>(
  ctx: HeStageContext,
  profile: T,
  corpus: string,
): T {
  const haystack = ` ${literalWords(corpus)} `;
  const dropped: string[] = [];
  const keep = (items: string[]): string[] =>
    items.filter((item) => {
      const words = literalWords(item);
      if (words && haystack.includes(` ${words} `)) return true;
      dropped.push(item);
      return false;
    });
  const checked = { ...profile, current_clients: keep(profile.current_clients), cases: keep(profile.cases) };
  if (dropped.length) {
    stageLog(
      ctx,
      `[site_profile] из current_clients/cases убрано ${dropped.length}: этих слов нет в тексте сайта `
        + `(${dropped.slice(0, LITERAL_DROP_LOG_SAMPLE).map((item) => `«${sliceWholeChars(item, 0, 80)}»`).join(', ')}`
        + `${dropped.length > LITERAL_DROP_LOG_SAMPLE ? ', …' : ''})`,
    );
  }
  return checked;
}

/**
 * Профиль рынка 'us': общая схема плюс product_category — категория продукта
 * словами покупателя («payroll software for restaurants»). Её читает стадия
 * competitors (stages/competitors.ts), чтобы искать конкурентов по категории,
 * а не только по имени бренда. Схема локальная: RU-профиль этого поля не
 * получает, и общий HeSiteProfileSchema не меняется.
 */
const HeSiteProfileSchemaUs = HeSiteProfileSchema.extend({
  product_category: z.string().default(''),
});

/** Что делать специалисту, когда сайт мёртв и ручного описания тоже нет. */
const SITE_UNREACHABLE_NEEDS_BUSINESS =
  'профиль не построен: проверьте адрес сайта либо заполните ручное описание бизнеса и запустите research заново';

/**
 * Запись исхода в бриф: род недоступности, причина как её увидит специалист, и
 * время. Ключ СЛУЖЕБНЫЙ — в белом списке кабинета (`clientEngProjection`) его
 * нет, поэтому русская причина клиенту не уезжает: он видит код error_code.
 */
function unreachableMark(error: HeSiteUnreachableError): Record<string, unknown> {
  return { kind: error.kind, detail: error.message, at: new Date().toISOString() };
}

/**
 * Патч брифа с перечитыванием прямо перед записью: за минуты LLM-вызовов
 * пользователь мог сохранить overrides (offer/style/signature/business) через
 * PATCH — спред от протухшего снапшота их бы затёр. Один хелпер на оба исхода
 * стадии (профиль построен и «сайт недоступен»), чтобы перечитывание не
 * пришлось повторять второй раз и не разошлось.
 *
 * Статус проекта переводит только успешный исход: у отказа статус ставит воркер
 * (стадия не знает, была ли это последняя попытка).
 */
async function patchBrief(
  ctx: HeStageContext,
  project: HeProject,
  patch: Record<string, unknown>,
  options?: { status: 'researching' },
): Promise<void> {
  const { data: freshProject } = await ctx.supabase
    .from('he_projects')
    .select('brief')
    .eq('id', project.id)
    .single();
  // Патч — текст модели (site_profile) и разбор сайта: один NUL или одиночный
  // UTF-16 суррогат, и PostgREST отвергает ВСЮ запись брифа после оплаченного
  // профиля — стадия падает и на повторе покупает его заново. Чистим только
  // патч: остальной бриф уже лежит в jsonb и хранимым быть обязан. Текст без
  // этих двух символов (вся кириллица и латиница) уходит байт-в-байт тем же.
  const brief = {
    ...(((freshProject as { brief?: Record<string, unknown> } | null)?.brief) ?? project.brief ?? {}),
    ...stripUnstorableJsonChars(patch),
  };
  const { error } = await ctx.supabase
    .from('he_projects')
    .update({
      brief,
      ...(options?.status ? { status: options.status } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', project.id);
  if (error) throw new Error(`he_projects update brief: ${error.message}`);
}

export async function runSiteProfileStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const market = projectMarket(project);

  const fetchText = resolveFetchText(ctx);
  // Доп. страницы рынка 'us' — строгим чтением (см. fetchExtraPages); главная
  // у обоих рынков читается fetchText: для неё цепочка запасных адресов верна.
  const fetchPage = market === 'us' ? resolveFetchPage(ctx) : null;
  const jobSignal = heStageSignal(ctx);
  // Память прогона о молчащих origin'ах (см. HeSilentOrigins): её наполняет и
  // главная, и каждая проба пути, а читают оба цикла докачки.
  const silentOrigins: HeSilentOrigins = new Set();
  const websiteOrigin = siteOrigin(project.website_url);
  stageLog(ctx, `[site_profile] фетч ${project.website_url}`);
  let siteText = '';
  let unreachable: HeSiteUnreachableError | null = null;
  try {
    siteText = await fetchText(project.website_url);
  } catch (e) {
    // Три исхода одного вызова — три решения. Срок истёк: хост принял
    // соединение и молчит, это транзиент — отказываем стадией, не записывая
    // в бриф «сайт недоступен»: от мёртвого сайта его отличает здесь, в
    // стадии, именно тип. Воркер этот класс отдельно не читает — для него это
    // обычный фейл (попытка тратится, повтор без паузы). Сайт недоступен: это
    // факт о сайте клиента, стадия его переживает (ниже). Всё остальное
    // (отмена в том числе) — как было.
    if (isHeOperationTimeout(e)) {
      stageLog(
        ctx,
        `[site_profile] сайт не ответил в срок: ${heIoFailureReason(e)} — это таймаут, а не пустой сайт`,
      );
      throw e;
    }
    if (!isHeSiteUnreachable(e)) throw e;
    unreachable = e;
    if (websiteOrigin) silentOrigins.add(websiteOrigin);
    stageLog(ctx, `[site_profile] ${e.message} — профиль по сайту не строим`);
  }

  // Мёртвый домен — законный исход исследования, а не сбой движка. Что делать
  // дальше, решает ОДНО: есть ли ручное описание бизнеса. Есть — профиль строим
  // по нему (то же спасение, что у тонкого сайта, и прогон идёт дальше); нет —
  // строить профиль не из чего, и выдуманный профиль здесь хуже отказа: по нему
  // молча отработали бы все следующие стадии цепочки.
  const manualBusiness = readBusinessOverride(project.brief);
  if (unreachable && !manualBusiness) {
    // Исход пишем ДО отказа: шаг «Brief» мастера читает brief.site_thin и сразу
    // просит описание бизнеса — то самое поле, которое снимает этот отказ.
    await patchBrief(ctx, project, {
      website_url: project.website_url,
      site_thin: true,
      site_text_chars: 0,
      site_unreachable: unreachableMark(unreachable),
      captured_at: new Date().toISOString(),
    });
    stageLog(ctx, '[site_profile] ручного описания бизнеса нет — стадия отказывает честной причиной');
    throw new HeSiteUnreachableError(
      unreachable.kind,
      unreachable.url,
      `${unreachable.detail} — ${SITE_UNREACHABLE_NEEDS_BUSINESS}`,
      unreachable,
    );
  }
  if (unreachable) {
    // Рынок 'us' корпус оставляет пустым: описание и остальной бриф уходят в
    // EN-промпт отдельным блоком (clientBriefForProfile ниже).
    if (market !== 'us') siteText = `${MANUAL_BUSINESS_MARK_RU}\n${manualBusiness}`;
    stageLog(ctx, '[site_profile] профиль строим по ручному описанию бизнеса (business_override)');
  }
  // Докачка контентных/кейс-страниц: профиль по одной главной (≤3000 символов)
  // — уровень «прочитал билборд» и даёт усреднённые гипотезы. Кейс-страницы
  // из этой же пачки уходят в refreshSiteCases (без повторных фетчей).
  // Недоступный origin уже в памяти прогона, поэтому вызов вернётся пустым, не
  // тронув ни одного из 14 путей.
  const extraPages = await fetchExtraPages(
    fetchText,
    project.website_url,
    silentOrigins,
    jobSignal,
    fetchPage ? { fetchPage, homeText: siteText } : undefined,
  );
  if (extraPages.duplicates > 0) {
    stageLog(
      ctx,
      `[site_profile] доп. страниц-повторов пропущено: ${extraPages.duplicates} (их адрес или текст уже в корпусе)`,
    );
  }
  if (extraPages.timedOut) {
    stageLog(
      ctx,
      '[site_profile] докачка остановлена: сайт не ответил в срок (остальные пути этого origin не пробовали)',
    );
  } else if (!unreachable && websiteOrigin && silentOrigins.has(websiteOrigin)) {
    stageLog(
      ctx,
      '[site_profile] докачка остановлена: origin перестал отдавать HTML (остальные пути этого origin не пробовали)',
    );
  }
  const corpusPages = [...extraPages.content, ...extraPages.cases];
  // Название источника честное: при недоступном сайте в корпусе не «главная», а
  // ручное описание, и в логе это должно читаться так же.
  stageLog(
    ctx,
    `[site_profile] ${unreachable && market !== 'us' ? 'ручное описание' : 'главная'} ${siteText.length} символов`
      + ` + ${corpusPages.length} доп. страниц (кейс: ${extraPages.cases.length}), профиль…`,
  );
  const corpus = buildProfileCorpus(siteText, corpusPages);

  // Гейт «тонкого» сайта: текста мало или пришла JS-заглушка парсера →
  // помечаем в brief (UI просит ручное описание бизнеса, business_override).
  // Недоступный сайт «тонкий» ВСЕГДА, сколько бы ни было ручного описания: в
  // профиле нет ни одной строки с самого сайта, и мастер обязан это показать.
  const siteThin = unreachable !== null || corpus.length < THIN_SITE_CHARS || siteText.includes(JS_STUB_MARK);
  if (siteThin) {
    stageLog(ctx, `[site_profile] сайт тонкий (${corpus.length} символов) — помечен site_thin`);
  }

  // Бриф клиента — второй источник профиля, только рынок 'us' (см. шапку).
  const clientBrief = market === 'us' ? clientBriefForProfile(project.brief) : null;
  if (clientBrief?.facts || clientBrief?.wishes) {
    stageLog(
      ctx,
      `[site_profile] бриф клиента в промпте профиля: факты о клиенте ${clientBrief.facts?.length ?? 0} символов `
        + `(на конфликте с сайтом правы они), пожелания по таргетингу ${clientBrief.wishes?.length ?? 0} символов `
        + '(не факты: только target_audience)',
    );
  }

  const profileInput = { websiteUrl: project.website_url, siteText: corpus };
  const profileOptions = { model: getHeModel('research'), maxTokens: 4096 };
  const llm = market === 'us'
    ? await callLLMWithSchema(
        buildSiteProfileMessagesEn({
          ...profileInput,
          clientFacts: clientBrief?.facts ?? null,
          targetingWishes: clientBrief?.wishes ?? null,
          siteState: unreachable ? 'unreachable' : siteThin ? 'thin' : 'read',
        }),
        HeSiteProfileSchemaUs,
        profileOptions,
      )
    : await callLLMWithSchema(buildSiteProfileMessages(profileInput), HeSiteProfileSchema, profileOptions);
  addUsage(usage, llm);
  // Рынок 'us': клиенты и кейсы профиля — только дословно из текста сайта.
  const profile = market === 'us' ? keepSiteLiteralProof(ctx, llm.data, corpus) : llm.data;

  await patchBrief(
    ctx,
    project,
    {
      website_url: project.website_url,
      site_profile: profile,
      site_thin: siteThin,
      site_text_chars: corpus.length,
      // Пишем всегда: ожившему сайту метка прошлого прогона осталась бы навсегда.
      site_unreachable: unreachable ? unreachableMark(unreachable) : null,
      captured_at: new Date().toISOString(),
    },
    { status: 'researching' },
  );

  // Кейс-банк: best-effort — сбой не должен ронять основную стадию
  // (бриф уже сохранён; he_cases может ещё не существовать на роллауте).
  if (unreachable) {
    // Кейсы извлекают из ТЕКСТА САЙТА, а его нет. Вызвать модель по ручному
    // описанию значило бы заплатить за выдуманные кейсы клиента.
    stageLog(ctx, '[site_profile] кейсы не извлекаем: сайт недоступен, извлекать их не из чего');
  } else {
    try {
      const casesResult = await refreshSiteCases(
        ctx,
        project.id,
        project.website_url,
        siteText,
        market,
        extraPages.cases,
      );
      usage.tokensUsed += casesResult.tokensUsed;
      usage.costUsd += casesResult.costUsd;
      stageLog(ctx, `[site_profile] кейсов извлечено: ${casesResult.extracted}`);
    } catch (e) {
      // Отмена задачи — не «кейсы не дались»: дальше по стадии идти незачем,
      // а воркер по 'cancelled' попытку не тратит.
      if (jobSignal?.aborted) throw e;
      stageLog(ctx, `[site_profile] кейсы не извлечены: ${heIoFailureReason(e)}`);
    }
  }

  return { result: profile, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
