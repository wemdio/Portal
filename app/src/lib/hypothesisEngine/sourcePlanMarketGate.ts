/**
 * НАБОР ИСТОЧНИКОВ ПО РЫНКУ — второй рубеж «у английского проекта не бывает
 * русских компаний». Чистый модуль: ни БД, ни модели, ни логов.
 *
 * ЗАЧЕМ, ЕСЛИ EN-ПРОМПТ И ТАК НАЗЫВАЕТ ТОЛЬКО ENG-ИСТОЧНИКИ. Промпт — просьба,
 * а не замок: схема плана (HeCollectTaskSchema) принимает все семь источников
 * на любом рынке, и задача hh_live / yandex_maps / companies_directory,
 * пришедшая в план us-проекта (ответ модели мимо промпта или план, сохранённый
 * в сторе вертикали до появления этого набора), ушла бы в коллектор как есть:
 * hh.ru с регионом «113» (Россия), Яндекс.Карты, реестр РФ. Её строки — русские
 * компании с русскими адресами, и запуск английского клиента написал бы им
 * английское письмо. Первый рубеж — воркер, который больше не включает русский
 * путь молча при ошибке чтения рынка (P-G-worker-market-fail-closed); этот
 * модуль закрывает то, что тот не ловит: русскую задачу внутри us-плана.
 *
 * ГДЕ ПРИМЕНЯЕТСЯ (stages/baseCollect.ts — все места, через которые задача
 * доходит до коллектора):
 *  - план модели — сразу после ответа (buildPlan);
 *  - после починки «в плане нет каталога» и после пробы среза (buildPlan);
 *  - после платного расширения плана (widenPlanWithPaidSlice);
 *  - переиспользованный план из стора вертикали — НА ЧТЕНИИ, каждый раз:
 *    план переживает ночи, и сохранённый до этой правки план иначе исполнялся
 *    бы вечно; и на ЗАПИСИ в стор (rememberPlan) — туда задача вне набора
 *    больше не попадает;
 *  - задачи, уже лежащие в collect_info незавершённой сборки (pending /
 *    dispatched / done на момент выката) — свип перед DISPATCH, а харвест
 *    такой задачи не входит в срез (harvestSlice) и у ремонта refill-базы,
 *    который читает collect_info без свипа;
 *  - assert в самом начале dispatchTask — последний рубеж перед вызовом
 *    коллектора.
 *
 * RU НЕ ТРОНУТ. Для market='ru' набора НЕТ (`null`), и это не «все семь
 * источников», а «проверки нет вовсе»: gateHeSourcePlan возвращает ТОТ ЖЕ
 * объект плана, heSourceAllowedForMarket — true на любой источник. План, задачи
 * и диспатч staff-инструмента /tools/hypothesis-engine идут прежним путём
 * байт-в-байт. Запись `Record<HeMarket, …>` заставит того, кто добавит третий
 * рынок, решить про его набор явно — компилятор не даст забыть.
 *
 * FAIL-CLOSED для us: набор — белый список. Источник, которого здесь нет
 * (включая любой будущий, добавленный в схему плана), у us-проекта не
 * исполняется, пока его не впишут сюда.
 */

import type { HeMarket } from './market';
import type { HeCollectTask, HeSourcePlan } from './prompts/sourcePlan';

export type HeCollectTaskSource = HeCollectTask['source'];

/**
 * us — ровно те источники, которые называет EN-промпт плана
 * (prompts/sourcePlan.en.ts) и которые диспатчер умеет исполнять по-английски:
 * каталоги pdl / funded / eng_hiring читаются напрямую, google_maps уходит в
 * парсер с language='en', region='US' (dispatchTask).
 */
const HE_MARKET_SOURCES: Record<HeMarket, readonly HeCollectTaskSource[] | null> = {
  ru: null,
  us: ['pdl', 'funded', 'eng_hiring', 'google_maps'],
};

/** Источник разрешён рынку. У RU набора нет — разрешено всё, как и раньше. */
export function heSourceAllowedForMarket(market: HeMarket, source: string): boolean {
  const allowed = HE_MARKET_SOURCES[market];
  return allowed === null || (allowed as readonly string[]).includes(source);
}

export interface HeGatedSourcePlan {
  /** План без задач вне набора. Ничего не снято — ТОТ ЖЕ объект, что на входе. */
  plan: HeSourcePlan;
  /** Источники снятых задач, в порядке плана (повторы сохраняются). */
  dropped: string[];
}

/**
 * Снять из плана задачи, чей источник не разрешён рынку.
 *
 * Может вернуть план БЕЗ ЗАДАЧ — и это не ошибка этой функции, а решение
 * вызывающего: у us-плана после снятия сначала чинится каталог
 * (ensureCatalogSource добавляет pdl-срез плану без каталога, пустому — тоже),
 * а если и починка не дала задачи — сборка останавливается с причиной (см.
 * stages/baseCollect.ts, «ПЛАН ПУСТ ПОСЛЕ НАБОРА РЫНКА»). Тихой пустой базы
 * этот путь не даёт.
 */
export function gateHeSourcePlan(plan: HeSourcePlan, market: HeMarket): HeGatedSourcePlan {
  if (HE_MARKET_SOURCES[market] === null) return { plan, dropped: [] };
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const kept = tasks.filter((task) => heSourceAllowedForMarket(market, String(task?.source ?? '')));
  if (kept.length === tasks.length) return { plan, dropped: [] };
  const dropped = tasks
    .filter((task) => !heSourceAllowedForMarket(market, String(task?.source ?? '')))
    .map((task) => String(task?.source ?? ''));
  return { plan: { ...plan, tasks: kept }, dropped };
}

/**
 * Типизированный отказ исполнить задачу: её источник не разрешён рынку
 * проекта. Бросается ДО любого вызова коллектора — ни дочерней джобы, ни чтения
 * каталога, то есть ничего не оплачено. Ловит его обработчик задачи в стадии
 * (runDispatch): задача уходит в 'failed' с этим текстом, остальные задачи
 * плана идут своим путём; база падает, только если других строк нет.
 *
 * Текст — для staff (he_bases.error / разбор задач). Клиент его не видит:
 * кабинет сворачивает he_bases.error в код причины (clientErrors), а имя
 * источника в тексте уводит его в `source`.
 */
export class HeSourceMarketRefusal extends Error {
  readonly market: HeMarket;
  readonly source: string;

  constructor(market: HeMarket, source: string) {
    super(
      `источник ${source} не входит в набор источников рынка ${market} — ` +
        'задача не исполнялась, коллектор не вызывался',
    );
    this.name = 'HeSourceMarketRefusal';
    this.market = market;
    this.source = source;
  }
}

/** Assert перед вызовом коллектора: источник вне набора рынка → HeSourceMarketRefusal. */
export function assertHeSourceAllowedForMarket(market: HeMarket, source: string): void {
  if (!heSourceAllowedForMarket(market, source)) throw new HeSourceMarketRefusal(market, source);
}
