/**
 * Безопасные клиентские ошибки английского кабинета: внутренний текст сбоя →
 * машинный код причины + английское объяснение.
 *
 * Зачем: стадии V1 пишут в `he_projects.error` / `he_bases.error` /
 * `collect_info` русские строки, а в них подставляется сырьё — тело ответа
 * LLM-провайдера (`Requesty 402: {...}`, lib/hypothesisEngine/llm.ts),
 * сообщения Postgres/PostgREST с именами таблиц `he_*`, внутренние uuid джоб.
 * Кабинет печатает это как есть. Сырые тексты в БД трогать нельзя — их читает
 * staff и легаси-инструмент /tools/hypothesis-engine, поэтому маппинг живёт
 * на границе клиентского контура: в `api/client/eng/**` и `components/client-eng/*`.
 *
 * Модуль ЧИСТЫЙ и не импортирует verticalEngineV2 (правило изоляции движков,
 * docs/design/2026-08-20-vertical-engine-v2-isolation.md): идея классификации
 * скопирована из `verticalEngineV2/collectionErrors.ts`, тексты и набор
 * правил написаны заново под строки V1 и под английский рынок.
 *
 * Инвариант: результат собирается ТОЛЬКО из констант этого файла. Ни одна
 * подстрока входа наружу не попадает — иначе утечка возвращается через
 * «понятное сообщение».
 *
 * Коды `billing` / `configuration` вынесены отдельными предикатами: их
 * переиспользует волна 3 (политика ретраев — платную операцию не повторяем,
 * пока не пополнен баланс и не починен ключ).
 */

export type HeClientErrorCode =
  /** У провайдера ИИ/поиска кончились деньги — повтор бессмысленен. */
  | 'billing'
  /** Ключ провайдера не задан/отклонён — нужна правка конфигурации. */
  | 'configuration'
  /** Провайдер временно недоступен или ограничил запросы. */
  | 'provider'
  /** Проба каталожного среза: сегмент не про эту вертикаль, база не собиралась. */
  | 'audience_mismatch'
  /** В источниках не осталось новых компаний после исключения уже собранных. */
  | 'segment_exhausted'
  /** Источник не отдал строк (ошибка чтения каталога или пустая выдача). */
  | 'source'
  /** Конструктор баз не обогатил строки почтами. */
  | 'enrichment'
  /** Шаг не уложился в отведённое время. */
  | 'timeout'
  /** Идёт прогрев ящиков — отправка/долив пока закрыты. */
  | 'subscription_warmup'
  /** Подписка не активна. */
  | 'subscription_inactive'
  /** Подписка оформлена, оплата не поступила. */
  | 'awaiting_payment'
  /** Исчерпан лимит контактов тарифа. */
  | 'contacts_exhausted'
  /** У рассыльщика нет места под новые контакты — ёмкость, а не тариф клиента. */
  | 'sending_capacity'
  /** Узнанный сбой инфраструктуры (БД/сеть) — клиенту деталей не даём. */
  | 'internal'
  /** Ничего не опознали. */
  | 'unknown';

export interface HeClientFailure {
  code: HeClientErrorCode;
  /** Одна строка заголовка: что произошло. */
  title: string;
  /** Что при этом уцелело (оплаченные строки, кампания). */
  whatIsSaved: string;
  /** Следующий шаг клиента. */
  whatToDo: string;
}

/**
 * Тексты. Правила: только английский, без имён провайдеров и таблиц, без
 * внутренних id и без слова «error code» — код уезжает в атрибут, а не в текст.
 * Биллинг провайдера клиенту не объясняем деталями: это наша проблема.
 */
const FAILURES: Record<HeClientErrorCode, Omit<HeClientFailure, 'code'>> = {
  billing: {
    title: 'The run stopped on our side — one of the services we pay for ran out of balance.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Our team is already notified; the run continues once the balance is topped up.',
  },
  configuration: {
    title: 'The run stopped on our side — one of the services we rely on is not configured correctly.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Our team is already notified; no action is needed from you.',
  },
  provider: {
    title: 'A service we rely on was temporarily unavailable, so the step stopped early.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Start the step again in a few minutes; if it keeps failing, contact your manager.',
  },
  audience_mismatch: {
    title: 'The catalog slice we could build for this vertical did not match it, so no base was built.',
    whatIsSaved: 'No contacts were bought for this vertical.',
    whatToDo:
      'This was a deliberate stop — mailing such a list would hurt the verticals that do work. Pick another vertical or upload your own list.',
  },
  segment_exhausted: {
    title: 'The sources have no new companies left for this vertical.',
    whatIsSaved: 'Companies collected earlier stay in the bases you already have.',
    whatToDo:
      'This does not mean the market is exhausted — only these sources are. Pick another vertical or upload your own list.',
  },
  source: {
    title: 'The company sources did not return any rows for this vertical.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Start the collection again; if it keeps coming back empty, contact your manager.',
  },
  enrichment: {
    title: 'Finding and validating emails did not finish for this base.',
    whatIsSaved: 'The companies collected are saved; rows without a validated email will not be mailed.',
    whatToDo: 'Start the collection again to retry the enrichment, or continue with the rows you have.',
  },
  timeout: {
    title: 'The step did not finish in time and was stopped.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Start it again; if it times out twice, contact your manager.',
  },
  subscription_warmup: {
    title: 'Your mailboxes are still warming up, so sending is on hold.',
    whatIsSaved: 'Contacts collected for you are saved and wait for the warm-up to finish.',
    whatToDo: 'Sending resumes automatically when the warm-up period ends.',
  },
  subscription_inactive: {
    title: 'Sending is paused because the subscription is not active.',
    whatIsSaved: 'Contacts collected for you are saved.',
    whatToDo: 'Renew the subscription in Billing to resume sending.',
  },
  awaiting_payment: {
    title: 'Sending is paused until the first payment goes through.',
    whatIsSaved: 'Contacts collected for you are saved.',
    whatToDo: 'Complete the payment in Billing to resume sending.',
  },
  contacts_exhausted: {
    title: 'The contact limit of your plan is used up for this billing period.',
    whatIsSaved: 'Contacts already uploaded keep running in your campaigns.',
    whatToDo: 'Upgrade the plan or wait for the next billing period to add more contacts.',
  },
  /**
   * НЕ путать с contacts_exhausted: тот про тариф клиента («поднимите план»), а
   * этот — про ёмкость НАШЕГО рассыльщика, за которую клиент не отвечает и
   * доплачивать ему нечего. Поэтому в тексте нет ни слова «plan», ни шага от
   * клиента: ночь отложена, а не потеряна (ночной долив ставится заново каждые
   * сутки, крон heAutoPipelineCron).
   */
  sending_capacity: {
    title: 'Adding new contacts is on hold — our sending platform has no room for them right now.',
    whatIsSaved:
      'Nothing was lost: everything collected so far is saved, and the campaigns already running keep sending.',
    whatToDo: 'No action is needed from you — the daily refill resumes by itself once room frees up.',
  },
  internal: {
    title: 'The step stopped because of a technical problem on our side.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Try again; if it happens twice, contact your manager.',
  },
  unknown: {
    title: 'The step stopped because of a technical problem.',
    whatIsSaved: 'Everything collected so far is saved.',
    whatToDo: 'Try again; if it happens twice, contact your manager.',
  },
};

/** Полный список кодов — для ревью текстов и исчерпывающих switch'ей. */
export const HE_CLIENT_ERROR_CODES = Object.keys(FAILURES) as HeClientErrorCode[];

/** Вход может прийти строкой (`he_bases.error`), Error'ом стадии или строкой Supabase. */
function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Биллинг провайдера: повторять платную операцию бессмысленно, пока не
 * пополнен баланс. V1 отдаёт `Requesty {status}: {тело ответа}` (llm.ts),
 * поисковый клиент — строки с именем Serper.
 */
export function isHeProviderBillingError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /\b(?:Requesty|Serper|OpenRouter)\s*(?:HTTP\s*)?[:(]?\s*402\b/i.test(message) ||
    /\bSerper billing:/i.test(message) ||
    (/\b(?:Requesty|Serper|OpenRouter)\b/i.test(message) &&
      /not enough credits|insufficient[\s_-]+(?:funds|balance|credits|search credits)|payment[\s_-]+required|credit balance (?:is )?too low/i.test(
        message,
      ))
  );
}

/** Ключ провайдера не задан либо отклонён — правка конфигурации, а не ретрай. */
export function isHeProviderConfigurationError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /\bSerper configuration:/i.test(message) ||
    /\b(?:Requesty|Serper|OpenRouter)\s*(?:HTTP\s*)?[:(]?\s*(?:401|403)\b/i.test(message) ||
    // getApiKey() в llm.ts падает именно с именем env-переменной.
    /\b(?:OPENROUTER|REQUESTY|SERPER)[A-Z0-9_]*_API_KEY\b/.test(message) ||
    (/\b(?:Requesty|Serper|OpenRouter)\b/i.test(message) &&
      /(?:missing|invalid|absent|rejected)[\s_-]+(?:api[\s_-]+)?key|api[\s_-]+key.{0,30}(?:missing|invalid|absent|rejected)/i.test(
        message,
      ))
  );
}

/**
 * Код причины по тексту сбоя. Порядок правил значим: «Авто-сборка не дала
 * строк: pdl_companies read: <текст Postgres>» обязан остаться `source`, а не
 * съехать в `internal` по имени таблицы внутри.
 */
export function classifyHeClientError(error: unknown): HeClientErrorCode {
  const message = errorMessage(error);
  if (!message.trim()) return 'unknown';

  if (isHeProviderBillingError(message)) return 'billing';
  if (isHeProviderConfigurationError(message)) return 'configuration';
  if (/\b(?:Requesty|Serper|OpenRouter)\s*(?:HTTP\s*)?[:(]?\s*(?:429|5\d\d)\b/i.test(message)) return 'provider';
  if (/\bSerper transient:/i.test(message)) return 'provider';

  // Тарифные отказы (ClientLaunchError из clientLaunch/appendLeads) доезжают
  // до кабинета через refill_result и журнал прогонов долива.
  if (/прогрев почт|warm-?up/i.test(message)) return 'subscription_warmup';
  if (/оплата ещё не поступила|оплата еще не поступила/i.test(message)) return 'awaiting_payment';
  if (/Подписка не активна|subscription is not active/i.test(message)) return 'subscription_inactive';
  // ВЫШЕ contacts_exhausted намеренно: это два разных факта, и подстроки у них
  // почти одинаковые. «Лимит контактов исчерпан» — тариф клиента; «лимит
  // контактов воркспейса исчерпан» — нет места у нашего рассыльщика. Второе
  // пишут два близнеца-текста: REFILL_CAPACITY_NOTE (отказ на доливе,
  // stages/baseCollectRefill.ts) и CAPACITY_REFUSAL_ERROR (отказ предполёта до
  // сборки, autoPipeline.ts). Якорь — общая подстрока обоих; менять её можно
  // только вместе с ними, оба места на это ссылаются.
  if (/лимит контактов воркспейса/i.test(message)) return 'sending_capacity';
  if (/Лимит контактов исчерпан/i.test(message)) return 'contacts_exhausted';

  if (/не покрывается каталогом/i.test(message)) return 'audience_mismatch';
  if (/Сегмент исчерпан|не осталось новых/i.test(message)) return 'segment_exhausted';

  // Конструктор баз: таймаут ожидания отделяем от прочих его исходов.
  if (/Конструктор баз не завершился/i.test(message)) return 'timeout';
  if (/конструктор завершился со статусом|конструктор вернул пустые данные/i.test(message)) return 'enrichment';
  if (/timed? ?out|ETIMEDOUT|AbortError|The operation was aborted/i.test(message)) return 'timeout';

  if (
    /Авто-сборка не дала строк|план пуст/i.test(message) ||
    /\b(?:pdl_companies|funded_companies|eng_hiring_cache|companies_directory|hh_vacancies|hh_live|yandex_maps|google_maps|yandex_maps_organizations|google_maps_places)\b/i.test(
      message,
    )
  ) {
    return 'source';
  }

  if (
    /\bhe_[a-z_]+\b/i.test(message) ||
    /\bbase_constructor_jobs\b|\bclient_campaign_presets\b|\bparser_jobs\b/i.test(message) ||
    /PGRST\d*|duplicate key value|violates [a-z-]+ constraint|relation ".*" does not exist|permission denied for|JWT|fetch failed|ECONNREFUSED/i.test(
      message,
    )
  ) {
    return 'internal';
  }

  return 'unknown';
}

/**
 * Текст по известному коду — для мест, где причина уже машинная и разбирать
 * нечего: префлайт тарифа перед доливом, отказ биллинга, гейт конфигурации.
 */
export function heClientFailureFor(code: HeClientErrorCode): HeClientFailure {
  return { code, ...FAILURES[code] };
}

/** Классификация + безопасный английский текст. */
export function getHeClientFailure(error: unknown): HeClientFailure {
  return heClientFailureFor(classifyHeClientError(error));
}

/** Одной строкой — для компактных мест кабинета (карточка базы, список проектов). */
export function formatHeClientFailure(failure: HeClientFailure): string {
  return `${failure.title} ${failure.whatIsSaved} ${failure.whatToDo}`;
}

/** Короткий путь «сырьё → строка для экрана». */
export function heClientErrorText(error: unknown): string {
  return formatHeClientFailure(getHeClientFailure(error));
}
