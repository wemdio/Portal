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
 */

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { DEFAULT_MAX_ABOUT_CANDIDATES } from '@/lib/enrich/aboutCandidates';
import { fetchAndExtract, normalizeUrl } from '@/lib/enrich/websiteParser';
import { getHeActiveJobSignal } from '../llm';
import { withHeDeadline } from '../operationDeadline';
import { defaultSearch, HE_SEARCH_TIMEOUT_MS } from './searchIo';
import type { HeStageContext } from './shared';

export type HeFetchTextFn = (url: string) => Promise<string>;
export type HeSearchFn = (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;

/** DNS-резолв SSRF-гейта: у node:dns своего срока нет — молчащий резолвер вешал стадию. */
const DNS_TIMEOUT_MS = 8_000;

/**
 * Чтение сайта: константы цепочки fetchAndExtract (lib/enrich/websiteParser.ts).
 * На каждый адрес там 2 попытки по FETCH_TIMEOUT_MS с паузой
 * FETCH_RETRY_DELAY_MS между ними; адресов — главная + www + http.
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
 * Дефолтный фетч: нормализация URL → SSRF-гейт (DNS/приватные адреса режем
 * до первого запроса) → fetchAndExtract (главная + «о компании», ≤3000 символов).
 */
export async function defaultFetchText(url: string, parent?: AbortSignal): Promise<string> {
  const normalized = normalizeUrl(url);
  return withHeDeadline('website extraction', WEBSITE_TIMEOUT_MS, parent, async (signal) => {
    await withHeDeadline('website DNS', DNS_TIMEOUT_MS, signal, () => assertPublicWebsite(normalized));
    // DNS-резолв не прерывается: его поздний результат не должен начать HTTP.
    signal.throwIfAborted();
    const text = await fetchAndExtract(normalized, { signal });
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
  const parent = heStageSignal(ctx);
  const custom = ctx.fetchText;
  return (url) =>
    (custom
      ? withHeDeadline('website extraction', WEBSITE_TIMEOUT_MS, parent, () => custom(url))
      : defaultFetchText(url, parent)
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
