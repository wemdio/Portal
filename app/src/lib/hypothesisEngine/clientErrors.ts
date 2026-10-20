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
 * Модуль ЧИСТЫЙ (единственный импорт — справочник текстов без зависимостей) и
 * не импортирует verticalEngineV2 (правило изоляции движков,
 * docs/design/2026-08-20-vertical-engine-v2-isolation.md): идея классификации
 * скопирована из `verticalEngineV2/collectionErrors.ts`, тексты и набор
 * правил написаны заново под строки V1 и под английский рынок.
 *
 * СЕРВЕРНЫЙ модуль: браузер его не импортирует (см. реэкспорт ниже). Строки
 * клиента классифицируются на сервере — проекция кабинета отдаёт код причины
 * (`clientEngProjection.toClientEngStageErrorCode`), экран разворачивает код в
 * текст по справочнику.
 *
 * Инвариант: результат собирается ТОЛЬКО из констант справочника. Ни одна
 * подстрока входа наружу не попадает — иначе утечка возвращается через
 * «понятное сообщение».
 *
 * Коды `billing` / `configuration` вынесены отдельными предикатами: их
 * читает политика повторов воркера (волна 3, через `llm.ts`) — на таком отказе
 * платная стадия не повторяется вовсе, она падает сразу, и перезапускает её
 * человек. Их же (через `heTeamFixableFailureOf`) читает алерт команде
 * (`opsAlert.ts`): клиент на этих кодах читает «команда уже работает».
 */

// Тексты и словарь кодов живут в клиентобезопасном справочнике без единого
// регэкспа (`components/client-eng/clientFailureText.ts`): браузер берёт их
// оттуда и этот модуль не импортирует, поэтому классификатор ниже — с именами
// провайдеров, наших каталогов и таблиц и русскими фразами стадий — в
// клиентский чанк не уезжает. Здесь реэкспорт: серверные импорты (`llm.ts`,
// роут запуска, архитектурный тест) остаются прежними.
import { heClientFailureFor, type HeClientErrorCode, type HeClientFailure } from '@/components/client-eng/clientFailureText';

export {
  HE_CLIENT_ERROR_CODES,
  // Фраза паузы по потолку расхода — для отказа 409 клиентских роутов
  // (spendCeiling.ts); тот же текст печатает карточка паузы автопилота.
  HE_SPEND_PAUSED_EN,
  // «research можно запустить ещё раз» — один предикат на роут исследования
  // кабинета и шаг 1 (не технические остановки — HE_RESEARCH_FINAL_STOP_CODES),
  // и окно «цепочка встала» — одно число на роут, деталку и текст шага 1.
  heResearchRetryAllowed,
  HE_RESEARCH_STALL_GRACE_MS,
  formatHeClientFailure,
  heClientFailureFor,
  type HeClientErrorCode,
  type HeClientFailure,
} from '@/components/client-eng/clientFailureText';

/**
 * Якорь отказа «тонкий сайт без описания бизнеса» (HeSiteThinNeedsBusinessError,
 * stages/siteProfile.ts): с него начинается сообщение класса, а воркер пишет
 * его в he_projects.error / he_jobs.error с префиксом стадии (`site_profile: …`,
 * writeJobFailure). Классификатор ниже сворачивает его в `website_thin` сверкой
 * ВХОЖДЕНИЕМ. Живёт здесь, а не в стадии: модуль чистый, и стадия берёт якорь
 * отсюда — текст отказа и правило кабинета читают одну константу.
 */
export const HE_SITE_THIN_NEEDS_BUSINESS_ANCHOR = 'Сайт клиента почти без текста';

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
 * Отказ, который чинит только команда: первые два правила
 * `classifyHeClientError` ровно в его порядке (биллинг раньше конфигурации).
 *
 * Отдельной функцией ради ОДНОГО читателя кроме классификатора — алерта команде
 * (worker/hypothesisEngine.ts → opsAlert.ts). Кабинет пишет на эти коды «мы уже
 * работаем над этим» (clientFailureText.ts, HE_TEAM_ON_IT_EN), и это правда
 * только если команда узнаёт о КАЖДОМ тексте, который кабинет свернёт в эти
 * коды, — а не только о типизированных отказах провайдера. Классификатор
 * зовёт эту же функцию, поэтому правила разъехаться не могут.
 */
export function heTeamFixableFailureOf(error: unknown): 'billing' | 'configuration' | null {
  const message = errorMessage(error);
  if (isHeProviderBillingError(message)) return 'billing';
  if (isHeProviderConfigurationError(message)) return 'configuration';
  return null;
}

/**
 * Код причины по тексту сбоя. Порядок правил значим: «Авто-сборка не дала
 * строк: pdl_companies read: <текст Postgres>» обязан остаться `source`, а не
 * съехать в `internal` по имени таблицы внутри.
 */
export function classifyHeClientError(error: unknown): HeClientErrorCode {
  const message = errorMessage(error);
  if (!message.trim()) return 'unknown';

  const teamFixable = heTeamFixableFailureOf(message);
  if (teamFixable) return teamFixable;
  if (/\b(?:Requesty|Serper|OpenRouter)\s*(?:HTTP\s*)?[:(]?\s*(?:429|5\d\d)\b/i.test(message)) return 'provider';
  if (/\bSerper transient:/i.test(message)) return 'provider';

  // A qualification stop is not a source/audience mismatch or an invitation to repay it.
  if (/Company qualification stopped at its spending limit\./i.test(message)) return 'qualification_limit';
  if (/Company qualification (?:could not verify the model response|has no saved response for a previous model request|stopped because the model service could not complete the request)\./i.test(message) ||
      /ENG company qualification: (?:unsupported_model|invalid_budget|missing_budget_history|invalid_model_input);/i.test(message)) {
    return 'qualification_incomplete';
  }

  // Осознанные остановки сборки — СРАЗУ после правил провайдера, выше тарифных
  // и всех остальных. Оба якоря пишет только наш код (stages/baseCollect.ts:
  // отказ пробы среза и терминал «релевант-гейт снял все строки»,
  // offTargetNote), и в оба текста ПЕРЕД якорем подставлено имя вертикали в
  // «…», а в текст пробы — ещё и примеры компаний мимо среза. Стоя ниже
  // тарифных правил, имя вроде «Email warm-up tools» сворачивало осознанную
  // остановку в subscription_warmup по /прогрев почт|warm-?up/ (так же — имя с
  // «лимит контактов» или «Подписка не активна», и всё, что ловят правила
  // долива, ёмкости и сайта между ними). Тексты, которые пишут для тех правил
  // (ClientLaunchError в clientLaunch/appendLeads, тексты долива и ёмкости в
  // stages/baseCollectRefill.ts и autoPipeline.ts, HeSiteUnreachableError),
  // этих якорей не содержат, поэтому их классификация от перестановки не
  // меняется. Провайдерские правила остаются первыми: их якорь — имя
  // подрядчика вместе с кодом ответа или служебной фразой.
  //
  // Терминал «гейт снял всё» при цели по гипотезам (флаг
  // HE_GATE_HYPOTHESIS_SCOPE; stages/baseCollect.ts, offTargetNote). Оборот
  // «не покрывается каталогом» в этом тексте НЕ встречается: про такую базу он
  // неправда — компании могли принадлежать вертикали.
  if (/не подходит под гипотезы вертикали/i.test(message)) return 'hypothesis_mismatch';
  if (/Company qualification: no companies with verified fit for the selected hypotheses and target countries\./i.test(message)) return 'company_unverified';
  if (/не покрывается каталогом/i.test(message)) return 'audience_mismatch';

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
  // Дневной кап добора не дал строк (stages/baseCollectRefill.ts, шаг 5б). Обе
  // формулировки несут общую подстроку «дневной бюджет добора», но означают
  // разное: «… этой базы … забронирован её первым прогоном» — исход
  // 'already_reserved', повтор прогона той же базы (кап проекта может быть
  // свободен), остальное — 'cap_exhausted', кап проекта занят. Поэтому сначала
  // узкий якорь, потом общий: поменяют узкую формулировку — повтор уедет в
  // общий код с прежним текстом, а не в 'internal'. Правила стоят ВЫШЕ общих:
  // текст русский и без якоря уехал бы в 'internal' с неправдой «техническая
  // проблема, попробуйте ещё раз».
  // Куда эти тексты доезжают СЕГОДНЯ. Кабинет классифицирует he_bases.error
  // (и ошибки проекта/джоб), а не collect_info.refill_result.error и не журнал
  // прогонов. В he_bases.error попадает только текст 'cap_exhausted': такая
  // база уходит в 'failed'. 'already_reserved' базу НЕ возвращает — она
  // остаётся 'analyzed' с пустым error (runHeRefillAppend, persistRefillBase),
  // и её текст лежит только в refill_result.error и строке прогона; ленту
  // кабинет строит по stats.budget_outcome (engDashboard.ts). То есть правило
  // 'refill_repeat_run' сегодня не срабатывает ни на одной строке, которую
  // кабинет разбирает, — оно держит узкий текст вне общего кода на случай,
  // если его когда-нибудь запишут в he_bases.error.
  if (/дневной бюджет добора этой базы/i.test(message)) return 'refill_repeat_run';
  if (/дневной бюджет добора/i.test(message)) return 'refill_budget_spent';
  if (/лимит контактов воркспейса/i.test(message)) return 'sending_capacity';
  if (/Лимит контактов исчерпан/i.test(message)) return 'contacts_exhausted';

  // Сайт клиента не открылся (стадия site_profile, HeSiteUnreachableError из
  // stages/io.ts). Якорь — начало сообщения КЛАССА вместе с родом в скобках, но
  // не начало строки: воркер пишет причину с префиксом стадии
  // (`site_profile: …` — `writeJobFailure` в worker/hypothesisEngine.ts; имя
  // функции, а не номер строки: номера здесь уже разъезжались). Правило стоит ВЫШЕ
  // общих: в хвост сообщения подставлена причина чужого модуля, и «…: Не удалось
  // загрузить сайт: … timed out» съехало бы в 'timeout', то есть в «попробуйте
  // ещё раз» — совет, который мёртвому домену не помогает никогда.
  // Два рода — два кода (HE_RESEARCH_FINAL_STOP_CODES, clientFailureText.ts):
  // `dns` (адрес не привёл к публичному серверу) — не технический
  // website_unreachable; `no_html` (соединение было, HTML не пришёл ни с одного
  // адреса — так же выглядит и наш маршрут чтения, который не дошёл) —
  // технический website_no_html, у него на шаге 1 есть «Try again».
  if (/Сайт клиента недоступен \(no_html\)/i.test(message)) return 'website_no_html';
  if (/Сайт клиента недоступен \(dns\)/i.test(message)) return 'website_unreachable';
  // Тонкий сайт без описания бизнеса у проекта клиента ENG-кабинета
  // (HeSiteThinNeedsBusinessError, stages/siteProfile.ts): сайт открылся, но
  // текста мало, и research ждёт описания. Якорь — константа выше, по которой
  // стадия и собирает сообщение, поэтому правило и текст не разъедутся. Стоит
  // ВЫШЕ общих по той же причине, что правила недоступного сайта: без него
  // строка уходила в 'unknown' — «технический сбой» и «Try again», которым
  // этот отказ не лечится, вместо просьбы об описании.
  if (message.includes(HE_SITE_THIN_NEEDS_BUSINESS_ANCHOR)) return 'website_thin';

  // Список Do not contact клиента и список стран проекта на сборке
  // (stages/baseCollect.ts; план docs/handoff/2026-10-16-eng-countries, §1A/§1B).
  // ВЫШЕ `segment_exhausted`, `timeout`, `already_collected` и `source`: все
  // четыре текста начинаются с «Авто-сборка не дала строк» либо несут хвост
  // чужого сбоя (сообщение чтения списка), и общие правила сказали бы клиенту
  // «запустите ещё раз» там, где помогает только правка списка. Порядок между
  // ними: нечитаемый список — сбой у нас (internal), раньше «сверх лимита» и
  // «все в списке»; «нет источника для стран» — последним.
  if (/Список Do not contact клиента не прочитан/i.test(message)) return 'internal';
  if (/Список Do not contact клиента больше/i.test(message)) return 'do_not_contact_over_cap';
  if (/в списке Do not contact клиента/i.test(message)) return 'do_not_contact';
  if (/нет источника для стран проекта/i.test(message)) return 'countries_uncovered';

  if (/Сегмент исчерпан|не осталось новых/i.test(message)) return 'segment_exhausted';

  // Конструктор баз: таймаут ожидания отделяем от прочих его исходов.
  if (/Конструктор баз не завершился/i.test(message)) return 'timeout';
  if (/конструктор завершился со статусом|конструктор вернул пустые данные/i.test(message)) return 'enrichment';
  if (/timed? ?out|ETIMEDOUT|AbortError|The operation was aborted/i.test(message)) return 'timeout';

  // ВЫШЕ `source`: причина начинается с «Авто-сборка не дала строк», но строки
  // были — все они уже лежат в других базах проекта (повторная сверка после
  // импорта конструктора, stages/baseCollect.ts, closeWithoutRows). Текст
  // `source` («источники не вернули строк») про такую базу — неправда.
  if (/уже есть в других базах проекта/i.test(message)) return 'already_collected';

  if (
    /Авто-сборка не дала строк|план пуст/i.test(message) ||
    /\b(?:pdl_companies|funded_companies|eng_hiring_cache|companies_directory|hh_vacancies|hh_live|yandex_maps|google_maps|yandex_maps_organizations|google_maps_places)\b/i.test(
      message,
    )
  ) {
    return 'source';
  }

  // Наш DNS-резолвер не ответил на адрес сайта (stages/io.ts, usDnsFailure —
  // только рынок 'us'): не факт о сайте клиента, а сбой у нас.
  if (/DNS-резолвер не ответил/i.test(message)) return 'internal';

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
 * Классификация + безопасный английский текст — для серверных мест, где на
 * руках сырая строка (предупреждения запуска). Кабинетные экраны получают
 * готовый код из проекции и сюда не ходят.
 */
export function getHeClientFailure(error: unknown): HeClientFailure {
  return heClientFailureFor(classifyHeClientError(error));
}
