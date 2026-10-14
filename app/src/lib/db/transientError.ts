/**
 * «Этот отказ БД — блип, а не приговор»: ОДИН предикат для воркеров и роутов.
 *
 * Модуль НЕЙТРАЛЬНЫЙ: ни одного импорта (ни движков, ни supabase-клиента,
 * ни 'server-only'), поэтому его одинаково читают воркер, стадия и route.ts.
 * Предикат вырос из того, который восемь месяцев держит конструктор баз
 * (lib/tools/baseConstructorWorker.ts, isTransientPersistError): те же коды
 * SQLSTATE/PostgREST и его список текстов Kong'а, который срезает коды, когда
 * его апстрим исчезает. Список здесь шире на собственные тела 503/504 Kong и
 * nginx: конструктор передаёт статус ответа аргументом и ловит их по нему, а
 * вызывающие этого модуля статус, как правило, не передают.
 *
 * Почему НЕ lib/supabaseRetry.isTransientError, который уже есть в репозитории:
 * он считает транзиентными /abort/ и /timeout/ в тексте. В движке гипотез
 * «abort» — это ОТМЕНА ПОЛЬЗОВАТЕЛЕМ, а «timeout» — прерывание сторожа простоя;
 * оба разбираются по ТИПУ ошибки и имеют свою политику попыток. Считать их
 * блипом БД значило бы воскрешать отменённую джобу бесплатными повторами —
 * ровно тот класс дефекта, из-за которого в этом воркере запрещён regexp по
 * тексту в решениях о судьбе джобы.
 *
 * Чем предикат НЕ является: разрешением повторить СТАДИЮ. Повтор оплаченной
 * стадии стоит денег, повтор ЗАПИСИ — нет. Предикат отвечает только на вопрос
 * «имеет ли смысл повторить тот самый запрос».
 */

/**
 * Коды, при которых повтор осмыслен: обрыв соединения (08xxx), перезагрузка и
 * завершение работы сервера (57P01-57P03), исчерпание соединений и дискового
 * пространства (53200/53300), внутренние коды PostgREST о недоступности
 * апстрима и кеша схемы (PGRST000-PGRST003).
 */
const TRANSIENT_DB_CODE = /^(?:08\w{3}|57P0[123]|53[23]00|PGRST00[0-3])$/;

/**
 * HTTP-статусы шлюза, за которыми стоит не отказ запроса, а недоступность.
 *
 * Читается ТОЛЬКО через необязательный аргумент `status` и только для самой
 * ошибки (не для её `cause`): ошибки supabase-js своего HTTP-статуса не несут
 * (postgrest-js на не-JSON теле собирает `{ message: body }`, а `status` кладёт
 * рядом с ошибкой, в ответ запроса, не внутрь неё). Поле `status` у самой
 * ошибки НЕ читается сознательно: оно есть у чужих классов (отказ модели
 * HeLlmHttpError несёт 503 провайдера), и такой отказ в цепочке причин не
 * должен становиться «блипом БД». Вызывающий, у которого статус ответа на руках
 * (`const { error, status } = await …`), передаёт его сам.
 *
 * Без аргумента шлюзовой отказ узнаётся по ТЕКСТУ ниже: тела Kong и nginx
 * перечислены там поимённо.
 */
const TRANSIENT_DB_STATUS = new Set([429, 502, 503, 504]);

/**
 * Тексты, по которым узнаём блип, когда кода нет вовсе. Сюда намеренно НЕ
 * входят невалидный JSON, отказ прав, ошибка схемы и нарушение ограничения:
 * повторы такой запрос не исправят, а попытки сожгут.
 *
 * Собственные тела шлюзов — дословно, потому что postgrest-js отдаёт их
 * сообщением ошибки, а статуса в ней нет (см. выше):
 *  - Kong: 502 «An invalid response was received from the upstream server»,
 *    503 «The upstream server is currently unavailable», «name resolution
 *    failed» (апстрим-контейнер пересоздаётся), «failure to get a peer from the
 *    ring-balancer», 504 «The upstream server is timing out»;
 *  - nginx: «502 Bad Gateway», «503 Service Temporarily Unavailable»,
 *    «504 Gateway Time-out».
 */
const TRANSIENT_DB_MESSAGE =
  /invalid response was received from the upstream server|upstream server is (?:currently unavailable|timing out)|name resolution failed|failure to get a peer from the ring-balancer|bad gateway|service (?:temporarily )?unavailable|gateway time-?out|database system is (?:in recovery mode|starting up|shutting down)|schema cache.*(?:retrying|connection)|(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|UND_ERR_\w+)|fetch failed|connection (?:reset|terminated|closed)/i;

/** Поля, которые предикат читает у ошибки PostgREST, Error'а и обёртки над ними. */
interface DbErrorLike {
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

function matches(error: DbErrorLike, status?: number): boolean {
  if (status !== undefined && TRANSIENT_DB_STATUS.has(status)) return true;
  if (typeof error.code === 'string' && TRANSIENT_DB_CODE.test(error.code)) return true;
  return typeof error.message === 'string' && TRANSIENT_DB_MESSAGE.test(error.message);
}

/**
 * Транзиентный ли это отказ БД/шлюза. Принимает и PostgrestError (`{message,
 * code}`), и обычный Error, в чей текст подставлено `error.message` запроса, —
 * поэтому предикат работает и после того, как стадия завернула отказ в свой
 * `throw new Error(...)`. Цепочку `cause` проходим на пару уровней: обёртки
 * fetch'а прячут ECONNRESET именно там.
 */
export function isTransientDbError(error: unknown, status?: number): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; depth += 1) {
    if (matches(e as DbErrorLike, depth === 0 ? status : undefined)) return true;
    e = (e as DbErrorLike).cause;
  }
  return false;
}
