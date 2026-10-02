/**
 * Клиент БД СТАДИЙ движка гипотез: у каждого запроса есть срок на ЗАГОЛОВКИ
 * ответа И на ПАУЗУ между кусками тела, и любой запрос обрывается сигналом
 * джобы.
 *
 * Что здесь лечится. Общий админский клиент (lib/supabaseAdmin.ts) ограничивает
 * запрос только до прихода заголовков: таймер снимается в `.finally()` самого
 * `fetch`, то есть ровно тогда, когда ответ начался. ЧТЕНИЕ ТЕЛА после этого не
 * ограничено ничем и не слушает никакого сигнала. Для стадии это значит, что
 * `await` на теле жирной строки `he_bases.data` может не кончиться НИКОГДА:
 * сторож простоя воркера через своё окно даст abort, abort до транспорта не
 * дойдёт (сигнала у запроса нет), и через STAGE_ABORT_GRACE_MS процесс выйдет —
 * вместе со всеми остальными проектами, потому что воркер односоточный.
 *
 * Механизм скопирован из движка вертикалей v2 (там такой же stageDb), а не
 * импортирован: архитектурный тест
 * tests/architecture/verticalEngineV2Isolation.test.ts запрещает связи V1 ↔ v2 в
 * обе стороны, поэтому здесь живёт файл-двойник. Инцидент 23.09.2026, которым
 * правка мотивирована В V2 (голодание пула libuv на распаковке gzip), в ENG НЕ
 * воспроизводится: сайт компании резолвится по локальной таблице (pdl_companies,
 * не DNS и не gzip), а `Promise.all` встречается в трёх стадиях — по одному месту
 * в baseCollect, evidence и hypotheses. Ценность здесь ровно одна — ОТСУТСТВИЕ
 * срока на тело ответа.
 *
 * Почему клиент ОТДЕЛЬНЫЙ, а не сигнал на общем. Общий `db` в воркере
 * обслуживает claimJob, cancel-наблюдателя, failJob и сборщик брошенных строк, и
 * всё это обязано работать ПОСЛЕ аборта джобы: привяжи его к сигналу джобы — и
 * записать причину отказа станет нечем.
 *
 * Срок мерит ПАУЗУ между кусками, а не общее время чтения: `he_bases.data` —
 * жирный jsonb (до 50 000 строк компаний у staff-базы), и законное чтение такой
 * строки идёт долго, но НЕПРЕРЫВНО. Бюджет общего времени убивал бы здоровые
 * чтения.
 *
 * Клиентов в файле ДВА, и различает их ровно привязка к сигналу джобы:
 * createHeStageSupabase — вся работа стадии, обрывается абортом; ниже
 * heCheckpointSupabase — только записи, ФИКСИРУЮЩИЕ УЖЕ СДЕЛАННУЮ ОПЛАТУ, они
 * обязаны долетать и после аборта (см. комментарий у самой функции).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdminFetchWithRetry } from '@/lib/supabaseAdmin';

/**
 * Срок ожидания заголовков И самой длинной паузы между двумя куском тела.
 *
 * ЧИСЛО то же, что у общего админского клиента (тот читает тот же
 * SUPABASE_FETCH_TIMEOUT_MS с тем же дефолтом 120 000 мс), а ОБЛАСТЬ ДЕЙСТВИЯ
 * другая, и это надо знать точно. Общий клиент взводит свои 120 000 на КАЖДУЮ
 * внутреннюю попытку (`fetchOnce` внутри supabaseAdminFetchWithRetry, до
 * SUPABASE_RETRY_MAX_ATTEMPTS = 3), здесь таймер взводится ОДИН РАЗ вокруг всего
 * цикла повторов: цикл живёт в транспорте, который нам передают как fetchImpl, и
 * границы его попыток отсюда не видны — увидеть их значило бы переписать
 * политику повторов админского клиента в этом файле.
 *
 * Что из этого следует, по обеим сторонам.
 *  + Весь вызов теперь ограничен 120 000 мс вместо 3 × 120 000 + паузы ≈ 362 000:
 *    именно это держит порядок «срок запроса к БД < окно простоя стадии»
 *    (1 800 000 мс), при котором вставшее чтение кончается само, а не аварийным
 *    выходом процесса.
 *  − Одному сценарию становится хуже: если первые попытки съел отказ соединения,
 *    последней достаётся не полный бюджет, а остаток. Дорогой по времени код
 *    здесь один — UND_ERR_CONNECT_TIMEOUT (10 000 мс у undici); остальные
 *    повторяемые (ENOTFOUND, ECONNREFUSED и прочие из
 *    SAFE_TO_RETRY_NON_GET_CODES) кончаются мгновенно. Худший реальный расклад —
 *    2 × 10 000 мс плюс паузы 500 и 1 500 мс, то есть у третьей попытки
 *    ≈98 000 мс вместо 120 000. Проиграет только БД, которая на третьей попытке
 *    отвечает заголовками дольше 98 секунд; полный цикл всех трёх отказов
 *    соединения ≈32 000 мс и в бюджет укладывается вчетверо.
 *
 * Сам наш abort в этом цикле НЕ повторяется: `supabaseAdminFetchWithRetry`
 * видит `init.signal.aborted` и бросает сразу, до своего `shouldRetry` (а тот
 * повторяет только коды обрыва связи, и ABORT_ERR среди них нет).
 *
 * НО ЦИКЛ ПОВТОРОВ ЕСТЬ И ВЫШЕ НАС — в самом postgrest-js (2.105.x, повторы
 * включены по умолчанию). Отказ fetch'а он повторяет для GET/HEAD/OPTIONS ещё
 * до 3 раз с паузами 1/2/4 с, если у ошибки НЕ name 'AbortError' и НЕ code
 * 'ABORT_ERR'. Имя у нашей ошибки срока своё (HeStageDbTimeoutError), поэтому
 * без кода чтение, вставшее на заголовках, уходило в БД четыре раза и
 * стоило ≈ 4 × 120 000 + 7 000 ≈ 487 000 мс вместо 120 000 — до клиента стадий
 * (общий админский клиент) такой отказ приходил как AbortError и не повторялся
 * вовсе. Поэтому у HeStageDbTimeoutError есть `code = 'ABORT_ERR'`: postgrest-js
 * отдаёт её сразу, и для чтения срок расходуется один раз — ровно как обещано
 * выше. Записи (POST/PATCH/DELETE) postgrest-js не повторяет никогда.
 * Обрыв связи и прочие отказы транспорта наш fetch отдаёт как есть (см.
 * failure), и postgrest-js повторяет их для GET так же, как до клиента стадий.
 */
export const HE_STAGE_DB_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.HE_STAGE_DB_TIMEOUT_MS ?? process.env.SUPABASE_FETCH_TIMEOUT_MS ?? '120000') || 120_000,
);

/**
 * Хвосты сообщения — ЕДИНСТВЕННЫЙ источник текста и для ошибки, и для предиката
 * ниже. Две фазы различаются текстом сознательно: у них РАЗНАЯ политика повторов
 * (см. isHeStageDbInterruption), и вывести одну из другой по тексту «timeout»
 * было бы нельзя.
 */
const STAGE_DB_NO_HEADERS = 'no response headers';
const STAGE_DB_BODY_STALL = 'response body stalled';

/** Истёк срок запроса стадии к БД: заголовки не пришли либо тело встало. */
export class HeStageDbTimeoutError extends Error {
  /**
   * Дискриминант на случай двух копий модуля в одном процессе (воркер и
   * Next-бандл): instanceof тогда ложен, а поле — нет.
   */
  readonly heStageDbTimeout = true as const;
  /**
   * Код, по которому postgrest-js НЕ повторяет отказ fetch'а (его повторы GET и
   * HEAD смотрят только на name 'AbortError' и code 'ABORT_ERR'). Без него
   * вставшее на заголовках чтение уходило в БД четыре раза подряд — см.
   * HE_STAGE_DB_TIMEOUT_MS. Наш транзиентный предикат (lib/db/transientError.ts)
   * этот код блипом не считает, `supabaseAdminFetchWithRetry` его не повторяет.
   */
  readonly code = 'ABORT_ERR' as const;

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    readonly phase: 'headers' | 'body',
  ) {
    // Текст английский: he_jobs.error читает и английский кабинет
    // (lib/hypothesisEngine/clientErrors.ts сводит «timeout» к коду 'timeout'),
    // и русский staff-инструмент /tools/hypothesis-engine.
    super(
      `HE stage database ${method} request timeout after ${timeoutMs}ms `
        + `(${phase === 'headers' ? STAGE_DB_NO_HEADERS : STAGE_DB_BODY_STALL})`,
    );
    this.name = 'HeStageDbTimeoutError';
  }
}

/**
 * Маркер ВСТАВШЕГО ТЕЛА в тексте сообщения. Собран из той же константы, что и
 * само сообщение, — двух независимых написаний одного текста здесь нет.
 */
const STAGE_DB_BODY_STALL_MARKER = new RegExp(
  `\\bHE stage database [A-Z]+ request timeout after \\d+ms \\(${STAGE_DB_BODY_STALL}\\)`,
);

/**
 * ПРЕРЫВАНИЕ, а не сбой стадии: тело ответа встало посередине, работа не
 * выполнялась и не отказала — её оборвал срок ЭТОГО клиента. Воркер повторяет
 * такой прогон, не тратя попытку (kind='db').
 *
 * Истинно ТОЛЬКО для фазы тела, и это главное про этот предикат. Фаза заголовков
 * ограничена и без этого файла (тот же срок у общего клиента), и её отказ уже
 * сегодня тратит попытку — дать ей бесплатные повторы значило бы ПОДНЯТЬ потолок
 * платных прогонов стадии с 3 до 8 там, где сейчас 3. Вставшее тело же не
 * кончалось раньше НИЧЕМ, кроме сторожа простоя, а политика сторожа — как раз
 * бесплатное прерывание; здесь она сохраняется, а не вводится.
 *
 * Обрыв соединения (ECONNRESET, UND_ERR_SOCKET) сюда НЕ попадает по той же
 * причине: он и сегодня заканчивается отказом запроса со своей попыткой.
 *
 * Разбор ТЕКСТА в предикате не украшение и не лень. postgrest-js НЕ пробрасывает
 * отказ транспорта наружу: он ловит его и собирает `{ error: { message, details,
 * hint, code } }` (PostgrestBuilder, ветка `!shouldThrowOnError`), где от класса
 * остаётся только имя внутри message. Поэтому дискриминант проверяется первым —
 * он работает там, где экземпляр доезжает (throwOnError, обёртка через `cause`),
 * — а текст остаётся единственным способом узнать то, что через postgrest-js
 * прошло. Маркер генерирует ровно этот файл, слова «abort» в нём нет (в движке
 * это отмена пользователем), и фаза заголовков им не описывается.
 */
export function isHeStageDbInterruption(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    const candidate = e as { heStageDbTimeout?: unknown; phase?: unknown; message?: unknown };
    if (candidate.heStageDbTimeout === true && candidate.phase === 'body') return true;
    if (typeof candidate.message === 'string' && STAGE_DB_BODY_STALL_MARKER.test(candidate.message)) return true;
    if (typeof e === 'string' && STAGE_DB_BODY_STALL_MARKER.test(e)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Статусы без тела ответа: читать нечего, срок на тело к ним не применяется. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function abortReasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? 'aborted');
}

/**
 * Отмена самой ДЖОБЫ (отмена пользователем или сторож простоя). Имя AbortError
 * обязательно: postgrest-js по нему не делает своих повторов.
 *
 * Текст сознательно НЕ несёт маркера вставшего тела: судьбу такого прогона решает
 * воркер по причине аборта (handleJob читает abort.signal.reason), а не этот
 * файл.
 */
function jobAbortError(reason: unknown): Error {
  const error = new Error(`HE job aborted: ${abortReasonMessage(reason)}`);
  error.name = 'AbortError';
  return error;
}

/**
 * Связать источники с одним контроллером обычными слушателями (снимаются после
 * запроса): долгоживущий сигнал джобы не должен собирать слушателя на каждый
 * запрос стадии — за один тик сборки их тысячи.
 */
function linkSignals(controller: AbortController, sources: AbortSignal[]): () => void {
  const unlink: Array<() => void> = [];
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    unlink.push(() => source.removeEventListener('abort', onAbort));
  }
  return () => {
    for (const remove of unlink) remove();
  };
}

/**
 * fetch стадий: срок на заголовки, срок на паузу между кусками тела, обрыв по
 * сигналу джобы. Тело проходит НАСКВОЗЬ (второй раз не буферизуется).
 */
export function createHeStageFetch(options: {
  /** Сигнал текущей джобы — модульным геттером (в воркере это getHeActiveJobSignal). */
  jobSignal: () => AbortSignal | null | undefined;
  /** Транспорт под низом; в воркере — админский fetch со своими повторами по обрыву связи. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): typeof fetch {
  const timeoutMs = options.timeoutMs ?? HE_STAGE_DB_TIMEOUT_MS;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const method = (init?.method ?? 'GET').toUpperCase();
    const job = options.jobSignal() ?? null;
    if (job?.aborted) throw jobAbortError(job.reason);
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let phase: 'headers' | 'body' = 'headers';
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        request.abort(new HeStageDbTimeoutError(method, timeoutMs, phase));
      }, timeoutMs);
    };
    const unlink = linkSignals(request, [...(init?.signal ? [init.signal] : []), ...(job ? [job] : [])]);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      unlink();
    };
    const failure = (error: unknown): unknown => {
      // Джобу оборвали — это её прерывание, а не отказ БД: судьбу решает воркер.
      if (job?.aborted) return jobAbortError(job.reason);
      if (timedOut) return request.signal.reason;
      // Свой сигнал вызывающего (короткая справочная выборка) сохраняет свою ошибку.
      if (init?.signal?.aborted) return error;
      // Любой другой abort — это срок ЗАГОЛОВКОВ транспорта под низом (админский
      // fetch ограничивает их тем же числом). Называем его сроком, а не
      // «AbortError: This operation was aborted».
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        return new HeStageDbTimeoutError(method, timeoutMs, 'headers');
      }
      // Обрыв связи и прочее отдаём КАК ЕСТЬ: так же, как до этой правки, — и с
      // той же политикой попыток у воркера.
      return error;
    };

    arm();
    let response: Response;
    try {
      request.signal.throwIfAborted();
      // Освобождает вызывающего по abort'у даже тогда, когда транспорт на abort
      // не реагирует вовсе.
      response = await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', onAbort, { once: true });
        fetchImpl(input, { ...init, signal: request.signal }).then(
          (value) => {
            request.signal.removeEventListener('abort', onAbort);
            if (request.signal.aborted) {
              void value.body?.cancel().catch(() => {});
              return;
            }
            resolve(value);
          },
          (error: unknown) => {
            request.signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    } catch (error) {
      release();
      throw failure(error);
    }
    phase = 'body';
    if (request.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      release();
      throw failure(request.signal.reason);
    }
    if (!response.body || NULL_BODY_STATUSES.has(response.status) || method === 'HEAD') {
      release();
      return response;
    }
    // Перевзводим срок на входе в фазу тела. Без этого остаток бюджета
    // заголовков доставался бы ПЕРВОМУ куску: законные 119 с ожидания ответа на
    // жирную строку оставили бы телу миллисекунды и здоровое чтение было бы
    // объявлено вставшим — а у вставшего тела политика бесплатная, то есть такой
    // ложный вердикт ещё и повторял бы оплаченную стадию.
    arm();

    const reader = response.body.getReader();
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stop = (error: unknown) => {
      if (released) return;
      release();
      try {
        output?.error(error);
      } catch {
        /* поток уже закрыт */
      }
      void reader.cancel(error).catch(() => {});
    };
    request.signal.addEventListener('abort', () => stop(failure(request.signal.reason)), { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      async pull(controller) {
        if (released) return;
        // Срок идёт на ПАУЗУ: взводим перед ожиданием куска и снимаем, как
        // только кусок пришёл. Медленный ПОТРЕБИТЕЛЬ под срок не попадает.
        arm();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          stop(failure(error));
          return;
        }
        if (released) return;
        clearTimeout(timer);
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        release();
        return reader.cancel(reason);
      },
    });
    const headers = new Headers(response.headers);
    // Тело уже расшифровано транспортом и может отличаться длиной.
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
}

/**
 * Один клиент на все стадии: сигнал текущей джобы берётся геттером на КАЖДЫЙ
 * запрос, поэтому клиент можно создать один раз на процесс.
 */
export function createHeStageSupabase(options: {
  url: string;
  serviceRoleKey: string;
  jobSignal: () => AbortSignal | null | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SupabaseClient {
  return createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createHeStageFetch(options) },
  });
}

/**
 * ВТОРОЙ клиент стадий — только для записей, которые ФИКСИРУЮТ УЖЕ ПОТРАЧЕННЫЕ
 * ДЕНЬГИ. Сигнала джобы у него НЕТ (`jobSignal: () => null`), срок на заголовки
 * и на паузу в теле — тот же.
 *
 * Зачем он нужен. Клиент стадий выше привязан к сигналу джобы сознательно: после
 * abort'а сторожа запросы стадии обязаны кончаться, иначе прерванный прогон
 * продолжал бы работать. Но одна и та же привязка бьёт по двум РАЗНЫМ видам
 * запросов. Запрос РАБОТЫ после аборта не нужен — его отказ ничего не стоит.
 * Запрос, который ЗАПОМИНАЕТ УЖЕ СДЕЛАННУЮ ОПЛАТУ, после аборта нужен именно
 * тогда, когда абортом прогон и кончается: его отказ превращает оплаченную
 * работу в неоплаченную, и повтор покупает её второй раз.
 *
 * Сколько времени у такой записи есть — по-разному, и обещать «с запасом» на все
 * нельзя. Окно даёт только сторож ПРОСТОЯ: после своего abort'а он ждёт
 * STAGE_ABORT_GRACE_MS (120 000 мс) и выходит из процесса. Отмена пользователем
 * окна не ставит вовсе — стадия просто доигрывает, и её записи ограничены лишь
 * своими сроками. Одиночный UPDATE стоит не больше HE_STAGE_DB_TIMEOUT_MS
 * (120 000 мс) — это его собственный потолок на заголовки, а таймер взведён ОДИН
 * РАЗ на весь цикл повторов транспорта, — то есть в окно он укладывается, но
 * ровно впритык, а не «с запасом»: медленная БД съест его целиком. Почти все
 * такие записи — одиночный запрос (полный список и без числа — у
 * paidCheckpointDb в stages/baseCollect.ts); по нескольку запросов подряд шлют
 * ТРИ:
 *  - запись НОВОГО плана в стор вертикали (rememberPlan: upsert
 *    he_catalog_cursors, затем — только когда сменился ключ плана, а в сторе
 *    лежит отметка остывания — снятие этой отметки): до двух запросов, худший
 *    случай 2 × 120 000 = 240 000 мс, примерно ДВА окна;
 *  - финальная запись базы (baseCollect, harvestRow) сидит в цикле
 *    HARVEST_WRITE_ATTEMPTS = 3 попыток, худший случай —
 *    3 × HE_STAGE_DB_TIMEOUT_MS + паузы 1 000 и 2 000 мс ≈ 363 000 мс, то есть
 *    примерно ТРИ окна;
 *  - строка прогона долива (baseCollectRefill, writeRefillRun) — это UPDATE, а
 *    когда он не задел ни строки, ещё и INSERT: два запроса подряд, худший
 *    случай 2 × 120 000 = 240 000 мс, примерно ДВА окна. Второй запрос нужен
 *    только вручную поставленному доливу (у ночного крона строка 'collecting'
 *    уже есть), так что обычная ночь — один запрос.
 * Практически до этих чисел не доходит, и вот почему. Цикл harvestRow повторяет
 * только БЛИП (isTransientDbError — 08xxx/57P0x, 502/503/504 шлюза, ECONNRESET и
 * родня), а такой отказ приходит за миллисекунды, так что реальная плата — те же
 * ≈3 000 мс паузы. Наш собственный срок (HeStageDbTimeoutError) транзиентным
 * предикатом НЕ признаётся — ни `code`, ни текст под него не подходят, — поэтому
 * упёршаяся в срок запись уходит из цикла после ПЕРВОЙ попытки, и 3 × 120 000 мс
 * требует БД, которая трижды отвечает шлюзовым 503 на последних миллисекундах
 * бюджета. Если процесс всё же выйдет посреди цикла, поведение то же, что было
 * до этого клиента: запись потеряна, и её вернёт только повтор стадии.
 *
 * Границы использования — узкие и проверяемые: клиент отдаётся ТОЛЬКО под запись
 * чекпойнта оплаты (критерий «деньги, а не работа» и полный список — у
 * paidCheckpointDb в stages/baseCollect.ts; refill-ветка
 * stages/baseCollectRefill.ts берёт его оттуда же; чекпойнт перебора
 * evidence/brand_cloud (stages/brandCloud.ts, writeHeItemCheckpoint) зовёт эту
 * функцию напрямую). Ни одно ЧТЕНИЕ стадии через
 * него не идёт — иначе пропало бы то, ради чего волна 4b и делалась: чтения
 * стадии должны кончаться.
 *
 * Возвращает null РОВНО ПО ОДНОМУ условию — url или сервисный ключ не в
 * окружении. Про вызывающего функция не знает НИЧЕГО, и это надо читать
 * буквально: «не воркер» она не определяет. У воркера переменные есть всегда
 * (тот же процесс собирает ими клиент стадий), поэтому в проде возвращается
 * настоящий клиент — ради этого всё и сделано. А вот у теста или скрипта со
 * своим двойником `ctx.supabase` исход зависит НЕ от них, а от окружения: в
 * чекауте без `.env` вернётся null и двойник останется в деле, а в чекауте с
 * `.env` (next/jest подхватывает его сам) вернётся НАСТОЯЩИЙ клиент с сервисным
 * ключом — и чекпойнт-запись уедет мимо двойника в ту базу, на которую указывает
 * `.env`. Сегодня это ни на что не влияет: путей V1-сборки и долива под тестом
 * нет ни одного (тесты baseCollect в tests/lib/vertical-engine-v2/ — про V2,
 * у которого чекпойнт-клиента нет вовсе). Первый же тест на эти пути обязан
 * либо снять обе переменные, либо подменить модуль `../stageDb`.
 *
 * Когда null всё-таки вернулся, вызывающий остаётся на клиенте стадий, то есть
 * на поведении до этой правки: гарантии «запись долетит после аборта» там нет, и
 * обещать её нельзя.
 */
let checkpointSupabase: SupabaseClient | null | undefined;

export function heCheckpointSupabase(): SupabaseClient | null {
  if (checkpointSupabase !== undefined) return checkpointSupabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  checkpointSupabase =
    url && serviceRoleKey
      ? createHeStageSupabase({
          url,
          serviceRoleKey,
          // Ровно то, чем этот клиент отличается от клиента стадий.
          jobSignal: () => null,
          // Тот же транспорт, что у клиента стадий: повторы по отказу соединения
          // у записи чекпойнта нужны не меньше, чем у любой другой записи.
          fetchImpl: supabaseAdminFetchWithRetry,
        })
      : null;
  return checkpointSupabase;
}
