/**
 * Поисковая IO-реализация для стадий, отделена от io.ts (фетч): не тянет
 * websiteParser/playwright в тесты pure-логики. Рынок проекта определяет
 * geo-параметры Serper — см. market.ts.
 *
 * Здесь же живёт РАЗБОР исхода поиска (волна 3). До него `defaultSearch`
 * возвращал пустой массив и на пустую выдачу, и на отказ провайдера: когда
 * ночью кончались поисковые кредиты, платное исследование доезжало до конца на
 * пустом входе — competitors собирал список конкурентов из ничего, brand_cloud
 * писал «следов бренда нет», evidence давал тонкие доказательства, и в
 * he_bases/he_projects не было НИ СЛОВА об ошибке. Кабинет показывал
 * завершённое исследование со слабым результатом.
 */

import {
  serperSearchOutcome,
  SERPER_REQUEST_TIMEOUT_MS,
  type SerperFailureKind,
} from '@/lib/search/serperClient';
import { serperGeoForMarket, type HeMarket } from '../market';
import { isHeOperationTimeout } from '../operationDeadline';
import { HE_US_SERPER_KEY_ENV, heUsProviderKey } from '../providerKeys';

export type HeSearchResults = Array<{ title: string; link: string; snippet?: string }>;

/**
 * Ожиданий журнала расхода на один поиск: beginProviderUsage до запроса и
 * metering.finish в finally (lib/search/serperClient.ts).
 *
 * У ЭТОГО движка оба ожидания мгновенны: журнал открывают воркер (вокруг
 * runHeStage) и оба роута запуска шаблона (вокруг ядра запуска), только для
 * проекта market='us' (costTelemetry.ts), и его писатель на
 * 'started' не делает ничего, а на 'finished' лишь ставит строку в фоновую
 * запись, которую поиск не ждёт. У RU-джоб журнала нет, крючок — no-op. Запас
 * ниже поэтому не тратится ни на одном рынке; число оставлено прежним, чтобы
 * страховочный срок поиска RU-инструмента не сдвинулся.
 */
const SEARCH_JOURNAL_WRITES = 2;
/**
 * Сколько даём ОДНОМУ ожиданию журнала. Крючок providerUsage ждёт writer,
 * которого ему передали, и своего срока у ожидания нет; писатель, пишущий
 * синхронно, под нагрузкой БД мог бы выйти за любой бюджет. Ориентир — тот же
 * порядок, что у соседнего движка (его писатель пишет синхронно): там бюджет
 * операции втрое больше бюджета запроса ровно ради этих записей. Писатель
 * этого движка (costTelemetry.ts) синхронно не пишет — см. выше.
 */
const SEARCH_JOURNAL_WRITE_BUDGET_MS = 30_000;
/**
 * Бюджет ОДНОГО поиска для страховочного срока стадии (io.ts).
 *
 * Считается как запрос + журнал вокруг него, а не задаётся числом: 15 с (так
 * было до правки) не покрывали даже сумму, и при синхронном писателе под
 * нагрузкой БД бюджет сжигал бы не поиск, а бухгалтерия — УСПЕШНЫЙ и УЖЕ
 * ОПЛАЧЕННЫЙ запрос прилетал бы в стадию как таймаут и выбрасывался. Писатель
 * журнала ENG фоновый, поэтому сбой или медленная БД журнала этот срок не
 * расходуют вовсе. Сам HTTP-запрос ограничен внутри клиента
 * (SERPER_REQUEST_TIMEOUT_MS) и слушает сигнал задачи; внешний срок — страховка
 * от клиента, который свой сигнал проигнорировал.
 */
export const HE_SEARCH_TIMEOUT_MS =
  SERPER_REQUEST_TIMEOUT_MS + SEARCH_JOURNAL_WRITES * SEARCH_JOURNAL_WRITE_BUDGET_MS;

/**
 * Провайдер поиска ОТКАЗАЛ (деньги, ключ, временный сбой или отказ ОДНОМУ
 * запросу — у serperClient это kind 'transient', свой истёкший срок) — это не
 * пустая выдача. Класс, а не текст: по тексту отмену задачи
 * приняли бы за транзиент (та же причина, что в operationDeadline.ts).
 */
export class HeSearchProviderError extends Error {
  /** Дискриминант на случай двух копий модуля в процессе (воркер + Next-бандл). */
  readonly heSearchProvider = true;

  constructor(
    public readonly kind: SerperFailureKind,
    message: string,
    /** Код ответа провайдера; печатается в лог стадии — heSearchFailureStatus. */
    public readonly httpStatus?: number,
  ) {
    // Текст — стабильная константа клиента Serper: его разбирает
    // clientErrors.ts («Serper billing:» → billing, «Serper configuration:» →
    // configuration, «Serper transient:» → provider) и печатает английским
    // текстом кабинета. Русский staff-инструмент видит эту же строку в
    // he_jobs.error, а причину по запросам — в русском логе стадии.
    super(message);
    this.name = 'HeSearchProviderError';
  }
}

export function isHeSearchProviderError(e: unknown): e is HeSearchProviderError {
  if (e instanceof HeSearchProviderError) return true;
  return typeof e === 'object' && e !== null && (e as { heSearchProvider?: unknown }).heSearchProvider === true;
}

/**
 * Дефолтный поиск: выдача либо типизированный отказ.
 *
 * signal — отмена задачи и срок операции (io.ts): молчащий поиск обрывается
 * вместе с запросом, а не после него. Отмена проверяется ДО разбора отказа:
 * остановленная работа не должна выглядеть как сбой провайдера.
 *
 * Ключ: работа проекта market='us' (под журналом расхода ENG) ищет по своему
 * ключу HE_US_SERPER_API_KEY, если он задан; иначе — общий SERPER_API_KEY
 * клиента Serper, как до правки (providerKeys.ts).
 */
export async function defaultSearch(
  q: string,
  market: HeMarket = 'ru',
  signal?: AbortSignal,
): Promise<HeSearchResults> {
  signal?.throwIfAborted();
  const geo = serperGeoForMarket(market);
  const engKey = heUsProviderKey(HE_US_SERPER_KEY_ENV);
  const outcome = await serperSearchOutcome(q, {
    num: 10,
    gl: geo.gl,
    hl: geo.hl,
    signal,
    ...(engKey ? { apiKey: engKey } : {}),
  });
  signal?.throwIfAborted();
  if (outcome.failure) {
    throw new HeSearchProviderError(outcome.failure.kind, outcome.failure.message, outcome.failure.httpStatus);
  }
  return outcome.items
    .filter((it) => typeof it.link === 'string' && it.link.length > 0)
    .map((it) => ({ title: it.title ?? '', link: it.link as string, snippet: it.snippet }));
}

/**
 * Исходы поиска за стадию: сколько запросов провайдер ВООБЩЕ обслужил, самый
 * сильный отказ и отдельно — ПЕРМАНЕНТНЫЙ отказ, если он был.
 *
 * Обслуженный запрос с пустой выдачей — обслуженный запрос: пустая выдача это
 * факт о рынке, и одна такая среди двадцати хороших не имеет права уронить
 * исследование. Поэтому ВРЕМЕННЫЙ сбой останавливает стадию только когда
 * обслуженных нет ни одного: блип не смеет убить прогон.
 *
 * С деньгами и ключом так нельзя. Такой отказ перманентен по построению —
 * каждый следующий запрос получит тот же ответ, — и счётчик обслуженных про
 * него ничего не говорит: ровно так выглядит ночь, в которой кредиты кончились
 * НЕ на первом запросе (кандидат 1 обслужен, кредиты умерли на кандидате 2).
 * До правки один обслуженный запрос разоружал оба предиката до конца стадии:
 * остальные 19 кандидатов получали платный вызов ресёрч-модели на пустом
 * массиве источников, стадия писала 'done', сносила прошлые 'proposed' гипотезы
 * проекта, вставляла тонкие, а he_jobs.error и he_projects.error оставались
 * NULL — кабинет показывал завершённое исследование со слабым результатом.
 */
export interface HeSearchTally {
  answered: number;
  failure?: Error;
  /**
   * Первый перманентный отказ провайдера (деньги, ключ; отказ одному запросу
   * перманентным не считается — kind 'transient'). Отдельное поле,
   * а не вывод из failure: failure живёт под правилом «важно, только если не
   * обслужено ни одного», а этот отказ важен всегда. Первый, а не последний:
   * дальше придёт он же, а вместе с ним первым в he_jobs.error попадает тот
   * запрос, на котором прогон реально кончился.
   */
  refusal?: HeSearchProviderError;
}

export function newHeSearchTally(): HeSearchTally {
  return { answered: 0 };
}

export function noteHeSearchAnswered(tally: HeSearchTally): void {
  tally.answered += 1;
}

/**
 * Запомнить отказ. Отмена задачи и прочие сбои (сеть кабинета, журнал расхода)
 * сюда не попадают: ранг 0 — «это не отказ поиска».
 */
export function noteHeSearchFailure(tally: HeSearchTally, error: unknown): void {
  const rank = failureRank(error);
  if (rank === 0) return;
  if (!tally.failure || rank > failureRank(tally.failure)) tally.failure = error as Error;
  // Деньги и ключ запоминаются ОТДЕЛЬНО и навсегда: их читают без оглядки на
  // число обслуженных запросов (см. шапку интерфейса).
  if (!tally.refusal && isHeSearchProviderError(error) && error.kind !== 'transient') {
    tally.refusal = error;
  }
}

/** Деньги и ключ сильнее временного сбоя, временный сбой — сильнее своего срока. */
function failureRank(error: unknown): number {
  if (isHeSearchProviderError(error)) return error.kind === 'transient' ? 2 : 3;
  if (isHeOperationTimeout(error)) return 1;
  return 0;
}

/**
 * Чем стадии падать в конце перебора: перманентным отказом — всегда, временным
 * сбоем — только если поиск не обслужил НИ ОДНОГО запроса. Спрашивается в конце:
 * до этого у временного сбоя ещё есть шанс, что следующий запрос ответит.
 */
export function heSearchStageFailure(tally: HeSearchTally): Error | undefined {
  return tally.refusal ?? (tally.answered === 0 ? tally.failure : undefined);
}

/**
 * Отказ, из-за которого продолжать перебор бессмысленно. Спрашивается ПОСЛЕ
 * поиска по очередному элементу и ДО платного вызова модели по нему: стадии, где
 * вызов идёт на КАЖДЫЙ элемент (brand_cloud по брендам, evidence по кандидатам),
 * иначе сначала дотратят бюджет модели на пустом входе и только потом признаются,
 * что входа не было.
 *
 * Два слагаемых, и второе — не то же самое, что «отказ вообще был»:
 *
 *  - ПЕРМАНЕНТНЫЙ отказ (деньги, ключ) — всегда: он повторится на каждом
 *    следующем элементе, и число обслуженных запросов до него ничего в нём не
 *    меняет (см. шапку HeSearchTally);
 *  - ВРЕМЕННЫЙ сбой — по тому же правилу, что в конце стадии
 *    (heSearchStageFailure): только когда поиск не обслужил НИ ОДНОГО запроса.
 *    Без этого слагаемого ПОЛНЫЙ отказ поиска (5xx-шторм, лимит частоты, свой
 *    истёкший срок) был не виден вовсе: refusal пуст, answered равен нулю, и
 *    перебор доезжал до конца, платя вызов модели за каждый элемент на пустом
 *    массиве источников — на двадцати кандидатах это двадцать вызовов вместо
 *    одного.
 *
 * itemsSearched — сколько элементов перебора уже отработало поиск (i + 1). Без
 * него правило било бы по ОДИНОЧНОМУ блипу: у первого элемента поиск бывает
 * ровно один (brand_cloud — один запрос на бренд), и единственный 502 на нём
 * означал бы «провайдер лёг», хотя означает он ровно то, что означает. Два
 * элемента подряд без единой обслуженной выдачи — уже не блип. Цена этой
 * осторожности — ОДИН вызов модели на первом элементе вместо нуля; цена её
 * отсутствия — падение здорового прогона на первом же блипе.
 */
export function heSearchOutageFailure(tally: HeSearchTally, itemsSearched: number): Error | undefined {
  return tally.refusal ?? (tally.answered === 0 && itemsSearched > 1 ? tally.failure : undefined);
}

/**
 * Код ответа провайдера для лога стадии — или пустая строка, если кода не было
 * (свой истёкший срок, обрыв сети, отсутствующий ключ).
 *
 * Зачем: клиентский текст отказа — стабильная константа на КЛАСС
 * («Serper billing: …», «Serper configuration: …»), и по ней специалист не
 * отличит 402 от 403 с фразой про кредиты, а 401 от 400. В he_jobs.error код
 * не уезжает (там строка для кабинета), поэтому единственный его читатель —
 * русский лог прогона, откуда и начинается разбор ночи.
 */
export function heSearchFailureStatus(error: unknown): string {
  return isHeSearchProviderError(error) && error.httpStatus !== undefined
    ? ` (HTTP ${error.httpStatus})`
    : '';
}
