import 'server-only';
import { beginProviderUsage, getProviderUsageScope, type ProviderUsageDetails } from '@/lib/providerUsage';

const SERPER_API_URL = 'https://google.serper.dev/search';
/**
 * Срок ОДНОГО HTTP-запроса к Serper. Экспортирован не для красоты: потребитель,
 * который страхует весь вызов своим сроком операции, обязан считать бюджет от
 * этого числа, а не от догадки. Вокруг запроса живёт ещё журнал расхода (две
 * записи в БД портала, см. beginProviderUsage/finish ниже) — он в этот срок НЕ
 * входит, и внешний бюджет должен покрывать сумму.
 */
export const SERPER_REQUEST_TIMEOUT_MS = 8_000;

export interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

export interface SerperSearchOptions {
  num?: number;
  gl?: string;
  hl?: string;
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Вид отказа провайдера. Пустая выдача отказом НЕ является: пустая выдача —
 * факт о рынке, отказ — отсутствие факта. Путать их дорого: на пустом входе
 * платный конвейер доезжает до конца и выставляет счёт за пустоту.
 *
 * Деление — по тому, повторится ли отказ на КАЖДОМ следующем запросе:
 *  - billing / configuration — да (кончились кредиты; ключ не задан или
 *    отвергнут: 401/403) — дальше спрашивать бессмысленно;
 *  - transient — нет: временный сбой (429, 5xx, 408/425, свой срок, обрыв
 *    сети) ИЛИ отказ ОДНОМУ запросу (400/404/413/422 и прочие 4xx, пустой
 *    запрос) — следующий запрос с другим текстом его не наследует. Потребитель
 *    (lib/hypothesisEngine/stages/searchIo.ts) по этому виду не останавливает
 *    перебор, пока хоть один запрос обслужен.
 */
export type SerperFailureKind = 'billing' | 'configuration' | 'transient';

export interface SerperFailure {
  kind: SerperFailureKind;
  /**
   * СТАБИЛЬНАЯ строка. Тело ответа, ключ и текст запроса сюда не попадают:
   * сообщение уезжает в колонки `error` и разбирается регэкспами потребителей
   * (lib/hypothesisEngine/clientErrors.ts, lib/verticalEngineV2/collectionErrors.ts).
   */
  message: string;
  /** Код ответа, если он был, — для лога и диагностики, не для текста клиенту. */
  httpStatus?: number;
}

export interface SerperSearchOutcome {
  items: SerperOrganicItem[];
  /** Провайдер отказал. Поля нет → выдача получена (возможно, честно пустая). */
  failure?: SerperFailure;
}

const FAILURE_MESSAGES: Record<SerperFailureKind, string> = {
  billing: 'Serper billing: insufficient search credits.',
  configuration: 'Serper configuration: search API key or request is invalid.',
  transient: 'Serper transient: search service unavailable.',
};
const MISSING_KEY_MESSAGE = 'Serper configuration: search API key is not set.';
const TIMEOUT_MESSAGE = 'Serper transient: timeout.';
const TRANSPORT_MESSAGE = 'Serper transient: transport.';
const RATE_LIMIT_MESSAGE = 'Serper transient: rate limited.';
/**
 * Отказ ОДНОМУ запросу (400/404/413/422 и прочие 4xx, кроме ключа, денег,
 * лимита частоты и 408/425). Префикса «Serper transient:» у текста нет
 * сознательно: кабинет (clientErrors.classifyHeClientError) читает его как
 * «сервис временно недоступен», а если стадия упадёт на таком отказе, значит
 * провайдер отверг ВСЕ её запросы, и «временно недоступен» было бы неправдой.
 * Без якоря текст получает общий код кабинета («техническая проблема,
 * попробуйте ещё раз») — для отвергнутых запросов это правда.
 */
const QUERY_REJECTED_MESSAGE = 'Serper query rejected: the search API refused this request.';
const EMPTY_QUERY_MESSAGE = 'Serper query rejected: the search request is empty.';

/**
 * «Кончились кредиты» Serper отдаёт не только кодом 402: тот же отказ приходит
 * и 403-м с текстом в теле. Тело используется ТОЛЬКО как признак — наружу
 * уезжает константа выше.
 */
const CREDIT_PHRASE =
  /not enough credits|insufficient[\s_-]+(?:funds|balance|credits|search credits)|payment[\s_-]+required|credit balance (?:is )?too low/i;

export function hasSerperKey(): boolean {
  return (process.env.SERPER_API_KEY ?? '').trim().length > 0;
}

/**
 * Best-effort обёртка над Serper (Google search API):
 * нет ключа / non-2xx / timeout / сетевой сбой → []. Дефолт регион ru/ru.
 * Ошибка активного журнала расходов пробрасывается: учёт нельзя молча потерять.
 *
 * Отличить отказ провайдера от пустой выдачи этой функцией НЕЛЬЗЯ по
 * построению — для этого есть serperSearchOutcome. Здесь поведение сохранено
 * байт-в-байт для потребителей, которым отказ действительно безразличен.
 */
export async function serperSearch(
  query: string,
  opts?: SerperSearchOptions,
): Promise<SerperOrganicItem[]> {
  return (await runSerperSearch(query, opts, false)).items;
}

/**
 * То же обращение к Serper, но с КЛАССИФИКАЦИЕЙ исхода: отказ по деньгам,
 * отказ по ключу и временный сбой либо отказ одному запросу (см.
 * SerperFailureKind) отделены от полученной выдачи.
 * Нужна тем, кто на пустом входе продолжает тратить деньги (исследование в
 * движках): пустая выдача — результат, отказ — его отсутствие.
 */
export async function serperSearchOutcome(
  query: string,
  opts?: SerperSearchOptions,
): Promise<SerperSearchOutcome> {
  return runSerperSearch(query, opts, true);
}

/**
 * Код ответа (плюс тело как признак) → вид отказа. Порядок значим: деньги
 * определяем раньше ключа, иначе 403 «not enough credits» уехал бы в
 * configuration и разбор наверху сказал бы «починить конфигурацию» вместо
 * «пополнить баланс».
 */
function httpFailure(status: number, body: string): SerperFailure {
  if (status === 402 || CREDIT_PHRASE.test(body)) {
    return { kind: 'billing', message: FAILURE_MESSAGES.billing, httpStatus: status };
  }
  if (status === 429) return { kind: 'transient', message: RATE_LIMIT_MESSAGE, httpStatus: status };
  if (status >= 500) return { kind: 'transient', message: FAILURE_MESSAGES.transient, httpStatus: status };
  // 408 (сервер не дождался запроса) и 425 (слишком рано) — временные по
  // протоколу; классификатор модели повторяет их так же (hypothesisEngine/llm.ts,
  // RETRYABLE_STATUSES).
  if (status === 408) return { kind: 'transient', message: TIMEOUT_MESSAGE, httpStatus: status };
  if (status === 425) return { kind: 'transient', message: FAILURE_MESSAGES.transient, httpStatus: status };
  // Ключ: не задан или отвергнут — повторится на каждом запросе, чинит человек.
  if (status === 401 || status === 403) {
    return { kind: 'configuration', message: FAILURE_MESSAGES.configuration, httpStatus: status };
  }
  // Остальные 4xx (400/404/413/422 …) — отказ ЭТОМУ запросу: запросы
  // исследования пишет модель, и один пустой, слишком длинный или странный
  // запрос не говорит ничего о следующем. Раньше он был 'configuration', то
  // есть терминальным с первого раза для всей джобы — с текстом «ключ неверен»
  // при исправном ключе.
  return { kind: 'transient', message: QUERY_REJECTED_MESSAGE, httpStatus: status };
}

/** Строковые поля ответа — только для CREDIT_PHRASE; наружу не уезжают. */
function errorPhrase(record: Record<string, unknown>): string {
  return [record.error, record.message].filter((value) => typeof value === 'string').join(' ');
}

async function runSerperSearch(
  query: string,
  opts: SerperSearchOptions | undefined,
  classify: boolean,
): Promise<SerperSearchOutcome> {
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  // Нет ключа — это не пустая выдача и не сбой сети: правка конфигурации.
  // Журнал расхода не открываем: платить не за что.
  if (!apiKey) return { items: [], failure: { kind: 'configuration', message: MISSING_KEY_MESSAGE } };
  // Задача уже отменена. Отмена — не отказ провайдера; её разбирает
  // вызывающая сторона по своему же сигналу.
  if (opts?.signal?.aborted) return { items: [] };
  // Пустой запрос (модель вернула '' в search_queries) — отказ этому запросу,
  // без обращения к провайдеру: ответить на него нечем. Только для
  // классифицирующего входа: serperSearch для прочих потребителей ведёт себя
  // как раньше, байт в байт.
  if (classify && !query.trim()) return { items: [], failure: { kind: 'transient', message: EMPTY_QUERY_MESSAGE } };
  const metered = getProviderUsageScope() !== undefined;
  const metering = await beginProviderUsage('serper');
  const usage: ProviderUsageDetails = { status: 'ambiguous' };

  const controller = new AbortController();
  // Свой истёкший срок надо отличать от отмены снаружи: наружу это разные
  // новости («провайдер принял и молчит» против «работу остановили»).
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts?.timeout ?? SERPER_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(opts?.signal?.reason);
  opts?.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts?.signal?.aborted) onAbort();

  try {
    controller.signal.throwIfAborted();
    const res = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: opts?.num ?? 10, gl: opts?.gl ?? 'ru', hl: opts?.hl ?? 'ru' }),
      signal: controller.signal,
    });
    usage.httpStatus = res.status;
    usage.providerRequestId = res.headers?.get('x-request-id') ?? undefined;
    if (!res.ok) {
      usage.status = 'http_error';
      // Тело читаем один раз и только если оно кому-то нужно: из него берётся
      // и цифра расхода для журнала, и признак «кончились кредиты». Чтение
      // накрыто тем же таймером, что и запрос, и его сбой не должен потерять
      // классификацию по коду.
      const body = classify || metered ? await res.text().catch(() => '') : '';
      if (metered) {
        try { usage.serperCredits = reportedCredits(JSON.parse(body)); } catch { /* Cost remains unknown. */ }
      }
      return { items: [], failure: httpFailure(res.status, body) };
    }
    const data = (await res.json()) as { organic?: SerperOrganicItem[] };
    usage.serperCredits = reportedCredits(data);
    let failure: SerperFailure | undefined;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      usage.status = 'success';
      const record = data as Record<string, unknown>;
      const embedded = typeof record.statusCode === 'number' ? record.statusCode : 0;
      if (record.error || embedded >= 400) {
        usage.status = 'http_error';
        // 200 с телом об ошибке — тот же отказ, просто без кода в статусе.
        // Без кода считаем транзиентом (502), а не деньгами: фразу про
        // кредиты, если она есть, разберёт httpFailure.
        failure = httpFailure(embedded >= 400 ? embedded : 502, errorPhrase(record));
      }
    }
    const items = (data.organic ?? []).filter(
      (it): it is SerperOrganicItem => it != null && typeof it === 'object' && typeof it.link === 'string',
    );
    return { items, failure };
  } catch {
    if (opts?.signal?.aborted) return { items: [] };
    if (timedOut) return { items: [], failure: { kind: 'transient', message: TIMEOUT_MESSAGE } };
    return { items: [], failure: { kind: 'transient', message: TRANSPORT_MESSAGE } };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
    await metering.finish(usage);
  }
}

function reportedCredits(data: unknown): number | undefined {
  const credits = data && typeof data === 'object' ? (data as { credits?: unknown }).credits : undefined;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}
