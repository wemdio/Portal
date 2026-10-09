/**
 * Алерт команде: КЛИЕНТСКИЙ проект ENG остановлен тем, что чинит только команда.
 *
 * Решение владельца 04.10.2026: клиент не видит ни слова про баланс,
 * провайдеров, ключи и ёмкость — кабинет пишет нейтральное «временная проблема
 * на нашей стороне, мы уже работаем над этим»
 * (`components/client-eng/clientFailureText.ts`, `HE_TEAM_ON_IT_EN`). Вторая
 * половина этой фразы — правда ТОЛЬКО потому, что этот модуль сообщает команде
 * в health-бот (туда же, куда бот шлёт все технические сводки). Убрали вызов —
 * кабинет начинает врать.
 *
 * Что считается такой остановкой (`HeOpsStopKind`):
 *  - 'billing' / 'configuration' — отказ провайдера модели или поиска по
 *    деньгам либо по ключу. Зовёт воркер (`worker/hypothesisEngine.ts`,
 *    writeJobFailure) на каждом отказе, который кабинет свернёт в эти коды;
 *  - 'capacity_pause' — у рассыльщика кончилось место под контакты. Зовут
 *    места записи паузы ночного добора (`stages/baseCollectRefill.ts`,
 *    `autoPipeline.ts`) и запуск шаблона из ENG-кабинета
 *    (`launchTemplate.ts`, стадия HE_OPS_STAGE_TEMPLATE_LAUNCH): там паузы
 *    добора нет, но остальные сегменты запуска не создаются, и клиент читает
 *    ту же нейтральную фразу;
 *  - 'letters_held' — ночной добор снял ВСЕ строки ночи: письмо запущенной
 *    кампании прочиталось бы у них неверно (stats.held_unfilled,
 *    `stages/baseCollectRefill.ts`, alertRefillLettersHeld). Сборка куплена,
 *    отправлено 0, ночь записана 'appended', а не сухой: это проблема писем, а
 *    не рынка, и чинит её только команда (клиент читает в ленте «N skipped
 *    (the letters would not read right…)»). Провайдера у этого вида нет —
 *    `provider: 'letters'`; окно молчания — по ВЕРТИКАЛИ, а не по проекту (у
 *    каждой вертикали свой запущенный шаблон и своя починка). Второй
 *    вызывающий — крон ДО покупки (`autoPipeline.ts`, шаг 3a--, стадия
 *    'refill_preflight'): письмо не прочиталось бы ни у одной строки при любых
 *    данных, поэтому сборка не покупается, а ночь записана 'failed' без базы;
 *  - 'segment_refused' — ночной добор: сегментная кампания запуска ЯВНО
 *    отказала (HTTP 4xx, не 429 и не ёмкость), не приняв ни строки, — почти
 *    наверняка её удалили или заархивировали у рассыльщика
 *    (`stages/baseCollectRefill.ts`, alertRefillSegmentRefused). Проект НЕ
 *    остановлен: строки сегмента той же ночью уходят в основную кампанию с
 *    основным текстом (кроме тех, кому эта кампания уже писала; или не
 *    отправляются, если основная не подтверждена), но текст сегмента не
 *    получает никто, пока команда не вернёт кампанию или не перезапустит
 *    шаблон. Алерт уходит, когда итог переотправки уже известен; id кампаний —
 *    строками контекста (`campaignId`, `mainCampaignId`), не в причине.
 *    Провайдер — 'sending'; окно молчания — по ВЕРТИКАЛИ, как у
 *    'letters_held' (у каждой вертикали свой запуск);
 *  - 'spend_ceiling' — известный расход us-проекта по журналу достиг потолка
 *    (spendCeiling.ts; ПО УМОЛЧАНИЮ ПОТОЛОК ВЫКЛЮЧЕН, и тогда этот вид не шлёт
 *    никто). Следующая платная стадия не поставлена, проект на паузе — причина
 *    'spend_ceiling' автопилота либо пауза ночного добора. Зовут
 *    spendCeiling.enforceHeSpendCeiling (воркер: дочейн автопилота;
 *    реконсилер; кнопки кабинета, в том числе старт исследования) и ночной тик
 *    (`autoPipeline.ts`, шаг 3a-, и напоминание о стоящей паузе). Провайдера
 *    нет — `provider: 'budget'`; окно молчания — 6 ч, как у ёмкости: потолок
 *    проекта сам не опускается, и каждая следующая попытка постановки — та же
 *    новость.
 *
 * ТОЛЬКО market='us'. RU-инструмент живёт со своими привычками и в это решение
 * не входит: строка с market='ru' (и любым другим известным рынком) молча
 * отбрасывается здесь, в одном месте, а не у каждого вызывающего. market=null
 * значит «рынок прочитать не удалось» — такой алерт УХОДИТ с пометкой: пропустить
 * ENG-проект хуже, чем один раз написать про RU, потому что кабинет уже обещал
 * клиенту, что команда знает.
 *
 * ДЕДУПЛИКАЦИЯ — в памяти процесса, двумя ключами:
 *  1. проект + вид отказа + провайдер: повтор в течение окна вида
 *     (heOpsRepeatWindowMs) не пишется вовсе — но окно держится, ТОЛЬКО ЕСЛИ
 *     сообщение про этот проект Telegram принял (`sendWorkerAlert` → true).
 *     Занимается оно синхронно, при решении «слать» (иначе два почти
 *     одновременных вызова ушли бы оба), а снимается, когда ни один чат
 *     сообщение не принял: нет кредов, ошибка Telegram, сеть. Тогда следующий
 *     такой же отказ пишет снова, а не молчит час или шесть, пока кабинет
 *     говорит клиенту, что команда знает. Снимается по настоящему исходу
 *     отправки, даже если он пришёл позже срока ожидания вызывающего. Повтор
 *     того же отказа, пришедший, пока первое сообщение ещё в пути, гасится и
 *     при неудаче не досылается — это то же событие, напишет следующее.
 *     Провайдер в ключе обязателен:
 *     отказ модели после отказа поиска у того же проекта — ВТОРАЯ поломка, и
 *     кабинет про неё тоже пишет «команда уже работает». Окна разные:
 *       - 'billing' / 'configuration' — HE_OPS_TEAM_FIX_REPEAT_MS (1 ч). Оба
 *         терминальны с первого ответа: ретрай джобы их не повторяет, шаг
 *         падает сразу. Значит, повтор в чате — это НОВОЕ событие (шаг
 *         перезапустили, а пополненный баланс снова кончился или ключ снова
 *         отклонён), а сбросить ключ, когда команда починила, отсюда нечем.
 *         Час гасит только дубли одного события: сборщик брошенных строк,
 *         дописывающий тот же отказ, и текстовый случай, который транспорт
 *         держит транзиентным (не больше трёх попыток джобы);
 *       - 'capacity_pause' — HE_OPS_CAPACITY_REPEAT_MS (6 ч): место кончается
 *         у всего воркспейса, и несколько вертикалей одной ночи (каждая — своя
 *         джоба сборки, между ними часы) или повторные нажатия запуска — одна
 *         новость. Цена: место освободили, а оно снова кончилось у того же
 *         проекта в течение 6 ч в том же процессе — второй раз чат молчит;
 *       - 'letters_held' — те же 6 ч, но ключ ещё и с вертикалью: повтор той
 *         же ночи (перезапуск сборки вертикали) гасится, а следующая ночь
 *         (сутки спустя) пишет снова, пока письма не починили;
 *       - 'segment_refused' — так же, 6 ч по вертикали: несколько мёртвых
 *         сегментов одной ночи — одна новость, следующая ночь пишет снова,
 *         пока кампанию не вернули;
 *  2. провайдер + вид отказа: первое сообщение уходит сразу, а остальные
 *     проекты с тем же отказом в течение HE_OPS_BURST_WINDOW_MS (10 мин)
 *     копятся и уходят ОДНИМ сообщением-списком в конце окна — кончившийся
 *     баланс у провайдера валит все проекты очереди подряд, и это одна новость,
 *     а не двадцать. Окно свёртки от исхода отправки НЕ зависит (иначе при
 *     лежащем Telegram объём ниже не держался бы); не принятый список снимает
 *     окна ключа 1 у всех своих проектов.
 * ОБЪЁМ при отказе провайдера ограничивает второй ключ, а не первый: на пару
 * «провайдер + вид» не больше двух сообщений за окно свёртки (первое и
 * список), то есть не больше 12 за любой час в одном процессе, сколько бы
 * проектов ни упало. Отказ, задевший 20 проектов: 2 сообщения, если они упали
 * в пределах 10 мин (обычная картина — очередь падает подряд); 12 — потолок за
 * час при любом разбросе; 20 (по одному на проект) — худший случай за весь
 * отказ, если проекты падают парами с интервалом не меньше 10 мин. Каждый
 * перезапуск упавшего шага во время долгого отказа добавляет проект не чаще
 * раза в час — и всё равно в те же 12 сообщений за час.
 * Цена хранения в памяти: после рестарта процесса (деплой, autoheal) тот же
 * проект может прийти в чат ещё раз — не больше одного лишнего сообщения на
 * ключ за рестарт; накопленный, но не отправленный список теряется, если
 * процесс умер без `flushHeOpsAlerts()` (воркер зовёт её при штатной
 * остановке, одноразовый крон обязан звать её перед выходом; веб-процесс
 * запуска долгоживущий и шлёт список по таймеру). Процессы памяти не делят:
 * воркер, крон и веб-сервер дедуплицируют каждый своё.
 * Персистентный дедуп (таблица) сознательно не заведён: он стоил бы миграции
 * ради одного лишнего сообщения после деплоя.
 *
 * НИКОГДА НЕ БРОСАЕТ и не держит вызывающего дольше HE_OPS_SEND_TIMEOUT_MS:
 * `sendWorkerAlert` своего срока не имеет, а сбой Telegram не должен ни уронить
 * запись отказа, ни задержать очередь движка. Вызывающий в долгоживущем
 * процессе может не ждать промис (`void`), одноразовый — обязан дождаться.
 *
 * Секретов в сообщении нет: причина обрезается до HE_OPS_REASON_MAX символов,
 * похожее на ключ/токен вымарывается. Имя проекта — не длиннее
 * HE_OPS_NAME_MAX: список из двадцати проектов должен влезть в одно сообщение
 * (длинное транспорт режет сам и отправляет, но хвост списка тогда теряется).
 * Транспорт — существующий
 * `lib/telegram/workerAlert.ts` (health-бот по умолчанию), второго клиента
 * Telegram здесь нет. Без кредов он только пишет предупреждение в stderr —
 * поэтому наличие TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID в
 * контейнере движка (воркер и крон) И в веб-контейнере `portal` (запуск
 * шаблона из кабинета) входит в предрелизную проверку.
 */

import { sendWorkerAlert } from '@/lib/telegram/workerAlert';

/** Что остановило проект. */
export type HeOpsStopKind =
  | 'billing'
  | 'configuration'
  | 'capacity_pause'
  | 'letters_held'
  | 'spend_ceiling'
  | 'segment_refused';

/**
 * Чей отказ: модель (LLM-провайдер), поиск (Serper), рассыльщик (Instantly);
 * 'letters' — не провайдер, а письма запущенного шаблона (вид 'letters_held');
 * 'budget' — не провайдер, а потолок расхода проекта (вид 'spend_ceiling').
 */
export type HeOpsStopProvider = 'model' | 'search' | 'sending' | 'letters' | 'budget';

export interface HeOpsStop {
  projectId: string;
  /** Имя проекта, если есть под рукой без лишнего чтения. */
  projectName?: string | null;
  /**
   * Рынок проекта. Алерт уходит только для 'us'; null — рынок прочитать не
   * удалось, алерт уходит с пометкой (см. шапку).
   */
  market: string | null;
  /** Стадия he_jobs или место в кроне ('refill_preflight'). */
  stage: string;
  kind: HeOpsStopKind;
  provider: HeOpsStopProvider;
  /** Сырая причина — обрежется и вымарается здесь. */
  reason?: string | null;
  httpStatus?: number | null;
  jobId?: string | null;
  baseId?: string | null;
  /**
   * Вертикаль. У 'letters_held' и 'segment_refused' входит в ключ окна
   * молчания (см. шапку); у остальных видов — только строка сообщения.
   */
  verticalId?: string | null;
  /** Шаблон, если отказ случился на его запуске. */
  templateId?: string | null;
  /**
   * Кампания рассыльщика, о которой алерт ('segment_refused' — отказавшая
   * кампания сегмента), и основная кампания запуска. Строками контекста, а не
   * в причине: причина проходит redactSecrets, и UUID кампании (36 символов,
   * буквы и цифры) стал бы «[redacted]». Контекст не вымарывается — как id
   * проекта, джобы и базы рядом.
   */
  campaignId?: string | null;
  mainCampaignId?: string | null;
  /**
   * Только capacity_pause и spend_ceiling: поставил ли паузу именно этот вызов
   * (`pauseHeAutoPipelineRefill` / `recordHeAutopilotPause` → true), или она уже
   * стояла / не записалась (false). null/не задано — не применимо.
   */
  pauseRecorded?: boolean | null;
  /**
   * Что читает клиент, если не только общая нейтральная фраза (запуск
   * шаблона: по форме исхода — общий отказ запуска или нейтральная фраза).
   * Не задано — общая фраза.
   */
  clientSees?: string | null;
}

/**
 * Стадия запуска шаблона из ENG-кабинета (launchTemplate.ts). Паузы добора за
 * ней нет — чинится освобождённым местом и повтором запуска, поэтому и совет
 * команде у неё свой (actionFor).
 */
export const HE_OPS_STAGE_TEMPLATE_LAUNCH = 'template_launch';

/** Окно молчания по проекту, виду и провайдеру для 'billing' / 'configuration' (см. шапку). */
export const HE_OPS_TEAM_FIX_REPEAT_MS = 60 * 60 * 1000;
/** То же окно для 'capacity_pause', 'letters_held', 'spend_ceiling' и 'segment_refused' (см. шапку). */
export const HE_OPS_CAPACITY_REPEAT_MS = 6 * 60 * 60 * 1000;

/** Окно молчания по проекту, виду отказа и провайдеру — по виду отказа. */
export function heOpsRepeatWindowMs(kind: HeOpsStopKind): number {
  return kind === 'capacity_pause' ||
    kind === 'letters_held' ||
    kind === 'spend_ceiling' ||
    kind === 'segment_refused'
    ? HE_OPS_CAPACITY_REPEAT_MS
    : HE_OPS_TEAM_FIX_REPEAT_MS;
}

/** Окно, в котором отказы одного провайдера по разным проектам сворачиваются в одно сообщение. */
export const HE_OPS_BURST_WINDOW_MS = 10 * 60 * 1000;
/** Сколько вызывающий ждёт отправку в Telegram, прежде чем пойти дальше. */
export const HE_OPS_SEND_TIMEOUT_MS = 15_000;
/** Длина причины в сообщении. */
export const HE_OPS_REASON_MAX = 200;
/** Длина имени проекта в сообщении (id проекта пишется всегда целиком). */
const HE_OPS_NAME_MAX = 60;
/** Сколько проектов перечислять в свёрнутом сообщении; остальные — числом. */
const HE_OPS_BURST_LIST_MAX = 20;

const WORKER_ID = 'hypothesis-engine · ENG';

const KIND_LABEL: Record<HeOpsStopKind, string> = {
  billing: 'отказ по деньгам (баланс/кредиты)',
  configuration: 'отказ по настройке (ключ не задан или отклонён)',
  // Без «добор на паузе»: тот же вид отказа шлёт и запуск шаблона, у которого
  // паузы нет; про паузу говорят совет (actionFor) и строка «пауза».
  capacity_pause: 'нет места под контакты у рассыльщика',
  letters_held: 'письмо запущенной кампании прочиталось бы неверно у всех строк ночи',
  spend_ceiling: 'известный расход проекта достиг потолка — следующая платная стадия не поставлена',
  segment_refused: 'сегментная кампания запуска отказала — текст сегмента не уходит',
};

const PROVIDER_LABEL: Record<HeOpsStopProvider, string> = {
  model: 'LLM-провайдер (модель)',
  search: 'Serper (поиск)',
  sending: 'Instantly (рассыльщик)',
  letters: 'письма шаблона (не провайдер)',
  budget: 'потолок расхода ENG (не провайдер)',
};

/**
 * Начало темы сообщения. 'letters_held' проект не останавливает: ночной добор
 * идёт, не уходят только письма.
 */
function subjectHead(kind: HeOpsStopKind): string {
  if (kind === 'letters_held') return 'ночной добор вертикали не отправил ничего';
  if (kind === 'segment_refused') return 'ночной добор вертикали идёт мимо сегментной кампании';
  return kind === 'spend_ceiling' ? 'клиентский проект на паузе' : 'клиентский проект остановлен';
}

/** Что сделать команде — по виду отказа, провайдеру и (для ёмкости) месту отказа. */
function actionFor(kind: HeOpsStopKind, provider: HeOpsStopProvider, stage?: string): string {
  if (kind === 'letters_held') {
    const meanwhile =
      stage === 'refill_preflight'
        ? 'пока ничего не сделано, ночной добор вертикали пропускается: сборка не покупается и письма не уходят'
        : 'пока ничего не сделано, ночи вертикали покупают сборку и не отправляют ни одного письма';
    return `разобрать письма запущенного шаблона вертикали (причина выше): пересобрать шаблон и запустить его — ночной добор доливает в последнюю запущенную кампанию вертикали — либо выключить ночной добор проекта (he_auto_pipeline_configs.enabled); ${meanwhile}`;
  }
  if (kind === 'segment_refused') {
    return 'проверить кампанию сегмента у рассыльщика (строки «кампания» и «HTTP-статус» выше): вернуть её, если удалена '
      + 'или в архиве, либо перезапустить шаблон вертикали (запуск создаёт новые кампании, ночной добор доливает в '
      + 'последнюю запущенную); пока ничего не сделано, строки этого сегмента каждую ночь уходят в основную кампанию '
      + 'с основным текстом (кроме тех, кому эта кампания уже писала), а если основная не подтверждена — не отправляются';
  }
  if (kind === 'spend_ceiling') {
    // Что именно — по месту остановки: у ночного добора своя пауза и своя кнопка.
    const resume =
      stage === 'refill_preflight' || stage === 'refill_paused'
        ? 'снять паузу ночного добора: Движок вертикалей → карточка проекта → возобновить ночной добор'
        : 'проект продолжает «Start outreach» клиента (или ночной проход при HE_AUTOPILOT_RECONCILE), '
          + 'не запущенное исследование — «Re-run research», по шагу — staff-инструмент';
    return 'проверить расход (GET /api/tools/hypothesis-engine/projects/<id>/cost); продолжить — поднять '
      + 'HE_US_PROJECT_SPEND_CAP_USD (потолок проекта) или дождаться, пока расход проекта за последние 24 часа '
      + `опустится ниже HE_US_PROJECT_DAY_SPEND_CAP_USD (окно скользящее, не календарные сутки), затем ${resume}; `
      + 'иначе следующая постановка снова встанет. '
      + 'Идущая стадия, начатое исследование (вся цепочка) и уже поставленные джобы доработают — потолок их не обрывает';
  }
  if (kind === 'capacity_pause') {
    if (stage === HE_OPS_STAGE_TEMPLATE_LAUNCH) {
      return 'освободить место в воркспейсе рассыльщика, затем повторить запуск шаблона (клиент — «Launch all (paused)» на шаге 5): повтор создаёт только несозданные сегменты и не дублирует уже созданные кампании';
    }
    return 'освободить место в воркспейсе рассыльщика, затем снять паузу: Движок вертикалей → карточка проекта → возобновить ночной добор';
  }
  const what = kind === 'billing' ? 'пополнить баланс' : 'проверить ключ в env воркера';
  return `${what} — ${PROVIDER_LABEL[provider]}; затем перезапустить остановленный шаг — сам он не продолжится`;
}

/** Похожее на секрет — вымарываем до обрезки, чтобы хвост токена не пережил срез. */
function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    // Длинный токен — с буквами И цифрами: имя env-переменной
    // (OPENROUTER_..._API_KEY) цифр не несёт и остаётся — команде оно и нужно.
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
}

/**
 * Не длиннее max символов, с «…» на срезе. Срез не рвёт суррогатную пару:
 * половинка эмодзи — невалидный UTF-8, и Telegram отклонил бы сообщение целиком.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Причина для сообщения: одна строка, без секретов, не длиннее HE_OPS_REASON_MAX. */
export function heOpsReasonText(raw: string | null | undefined): string {
  const flat = redactSecrets(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  if (!flat) return 'причина не записана';
  return clip(flat, HE_OPS_REASON_MAX);
}

function projectLabel(stop: HeOpsStop): string {
  const name = stop.projectName?.trim();
  return name ? `«${clip(name, HE_OPS_NAME_MAX)}» (${stop.projectId})` : stop.projectId;
}

/**
 * Отправка с собственным сроком: sendWorkerAlert не бросает, но и срока не знает.
 * `holds` — окна молчания проектов этого сообщения: не принял ни один чат —
 * окна снимаются (см. шапку), по настоящему исходу, а не по сроку ожидания.
 */
async function sendBounded(alert: Parameters<typeof sendWorkerAlert>[0], holds: HeOpsHeld[]): Promise<void> {
  const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
  try {
    const delivered = sendWorkerAlert(alert).catch(() => false);
    void delivered
      .then((accepted) => {
        if (!accepted) releaseHolds(holds);
      })
      .catch(() => undefined);
    await Promise.race([
      delivered,
      new Promise<void>((resolve) => {
        deadline.timer = setTimeout(() => {
          console.warn(`[he-ops-alert] Telegram не ответил за ${HE_OPS_SEND_TIMEOUT_MS}ms — идём дальше`);
          resolve();
        }, HE_OPS_SEND_TIMEOUT_MS);
        (deadline.timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    // Не бросаем никогда: алерт не должен уронить запись отказа.
  } finally {
    if (deadline.timer) clearTimeout(deadline.timer);
  }
}

function sendSingle(stop: HeOpsStop, held: HeOpsHeld): Promise<void> {
  return sendBounded({
    workerId: WORKER_ID,
    subject: `${subjectHead(stop.kind)} — ${KIND_LABEL[stop.kind]}, ${PROVIDER_LABEL[stop.provider]}`,
    error: heOpsReasonText(stop.reason),
    context: {
      'проект': projectLabel(stop),
      'рынок': stop.market ?? 'не прочитан (проверь, что это ENG)',
      'стадия': stop.stage,
      'HTTP-статус': stop.httpStatus ?? null,
      'джоба': stop.jobId ?? null,
      'база': stop.baseId ?? null,
      'вертикаль': stop.verticalId ?? null,
      'шаблон': stop.templateId ?? null,
      'кампания': stop.campaignId ?? null,
      'основная кампания': stop.mainCampaignId ?? null,
      'пауза':
        (stop.kind === 'capacity_pause' || stop.kind === 'spend_ceiling') && typeof stop.pauseRecorded === 'boolean'
          ? stop.pauseRecorded
            ? 'поставлена этим отказом'
            : 'не записана этим вызовом (уже стояла, нет конфига или колонок)'
          : null,
      'клиент видит': stop.clientSees?.trim() || 'временная проблема на нашей стороне, команда уже работает',
      'сделать': actionFor(stop.kind, stop.provider, stop.stage),
    },
  }, [held]);
}

function sendBurst(provider: HeOpsStopProvider, kind: HeOpsStopKind, pending: HeOpsPending[]): Promise<void> {
  const stops = pending.map((p) => p.stop);
  const shown = stops.slice(0, HE_OPS_BURST_LIST_MAX);
  const lines = shown.map(
    (s) =>
      `${projectLabel(s)} — ${s.stage}${s.verticalId ? `, вертикаль ${s.verticalId}` : ''}` +
      `${s.campaignId ? `, кампания ${s.campaignId}` : ''}${s.market ? '' : ' (рынок не прочитан)'}`,
  );
  if (stops.length > shown.length) lines.push(`и ещё ${stops.length - shown.length}`);
  // Советы всех мест отказа в списке, без повторов: у ёмкости ночной добор и
  // запуск шаблона чинятся по-разному.
  const actions = [...new Set(stops.map((s) => actionFor(kind, provider, s.stage)))];
  return sendBounded({
    workerId: WORKER_ID,
    subject:
      kind === 'letters_held' || kind === 'segment_refused'
        ? `то же ещё у ${stops.length} — ${KIND_LABEL[kind]}`
        : `тем же отказом остановлено ещё ${stops.length} — ${KIND_LABEL[kind]}, ${PROVIDER_LABEL[provider]}`,
    error: lines.join('\n'),
    context: {
      'первая причина': heOpsReasonText(stops[0]?.reason),
      'сделать': actions.join('; '),
    },
  }, pending.map((p) => p.held));
}

/**
 * Окно молчания по ключу «проект | вид отказа | провайдер»: до какого момента
 * (мс) молчать. Хранится срок, а не время отправки: окно у видов разное.
 * Объектом, а не числом: снять окно может только тот вызов, который его занял
 * (`releaseHolds` сверяет идентичность), а не более поздний с тем же сроком.
 */
interface HeOpsHold {
  until: number;
}

/** Окно вместе с его ключом — что снять, если сообщение не принял ни один чат. */
interface HeOpsHeld {
  key: string;
  hold: HeOpsHold;
}

const silentUntilByProjectKind = new Map<string, HeOpsHold>();

/** Снять окна, которые всё ещё принадлежат этим вызовам (см. шапку). */
function releaseHolds(holds: HeOpsHeld[]): void {
  for (const { key, hold } of holds) {
    if (silentUntilByProjectKind.get(key) === hold) silentUntilByProjectKind.delete(key);
  }
  if (holds.length) {
    console.warn(
      `[he-ops-alert] алерт не принят ни одним чатом — окно молчания снято у ${holds.length} проект(ов), следующий такой же отказ напишет снова`,
    );
  }
}

/** Отказ, отложенный в свёртку, вместе с окном его проекта. */
interface HeOpsPending {
  stop: HeOpsStop;
  held: HeOpsHeld;
}

interface HeOpsBurst {
  provider: HeOpsStopProvider;
  kind: HeOpsStopKind;
  /** Когда ушло первое сообщение окна. */
  leadAt: number;
  pending: HeOpsPending[];
  timer: ReturnType<typeof setTimeout> | null;
}

/** Открытые окна свёртки по провайдеру и виду отказа. */
const bursts = new Map<string, HeOpsBurst>();

function flushBurst(key: string): Promise<void> {
  const burst = bursts.get(key);
  if (!burst) return Promise.resolve();
  bursts.delete(key);
  if (burst.timer) clearTimeout(burst.timer);
  if (!burst.pending.length) return Promise.resolve();
  return sendBurst(burst.provider, burst.kind, burst.pending);
}

/**
 * Сообщить команде, что клиентский проект остановлен тем, что чинит только
 * она. Ничего не бросает; промис кончается, когда сообщение ушло, отложено в
 * свёртку или отброшено (не ENG, повтор в окне) — и не позже
 * HE_OPS_SEND_TIMEOUT_MS.
 *
 * Решение «слать / молчать / копить» принимается СИНХРОННО до первого await:
 * два почти одновременных вызова (воркер не ждёт промис) не могут оба
 * оказаться «первыми».
 */
export function notifyHeClientStop(stop: HeOpsStop, opts: { now?: number } = {}): Promise<void> {
  try {
    if (stop.market !== null && stop.market !== 'us') return Promise.resolve();
    const now = opts.now ?? Date.now();

    for (const [key, hold] of silentUntilByProjectKind) {
      if (now >= hold.until) silentUntilByProjectKind.delete(key);
    }
    // 'letters_held' и 'segment_refused' — окно по вертикали (см. шапку),
    // остальные виды — по проекту.
    const projectKey =
      `${stop.projectId}|${stop.kind}|${stop.provider}` +
      (stop.kind === 'letters_held' || stop.kind === 'segment_refused' ? `|${stop.verticalId ?? ''}` : '');
    const current = silentUntilByProjectKind.get(projectKey);
    if (current !== undefined && now < current.until) return Promise.resolve();
    // Занимаем окно сразу (решение синхронное), но держится оно, только если
    // сообщение примут: иначе sendBounded его снимет (см. шапку).
    const held: HeOpsHeld = { key: projectKey, hold: { until: now + heOpsRepeatWindowMs(stop.kind) } };
    silentUntilByProjectKind.set(projectKey, held.hold);

    const burstKey = `${stop.provider}|${stop.kind}`;
    const open = bursts.get(burstKey);
    if (open && now - open.leadAt < HE_OPS_BURST_WINDOW_MS) {
      open.pending.push({ stop, held });
      if (!open.timer) {
        open.timer = setTimeout(
          () => {
            void flushBurst(burstKey);
          },
          Math.max(0, open.leadAt + HE_OPS_BURST_WINDOW_MS - now),
        );
        // Долгоживущий воркер дождётся таймера сам; одноразовый процесс он не
        // держит — тот обязан позвать flushHeOpsAlerts() перед выходом.
        (open.timer as { unref?: () => void }).unref?.();
      }
      return Promise.resolve();
    }
    // Окно истекло (или его не было): прежний хвост — отдельным сообщением,
    // этот отказ открывает новое окно.
    const previous = open ? flushBurst(burstKey) : Promise.resolve();
    bursts.set(burstKey, { provider: stop.provider, kind: stop.kind, leadAt: now, pending: [], timer: null });
    return Promise.all([previous, sendSingle(stop, held)]).then(() => undefined, () => undefined);
  } catch (e) {
    console.warn('[he-ops-alert] алерт не собран:', e);
    return Promise.resolve();
  }
}

/**
 * Отправить всё, что копится в окнах свёртки, не дожидаясь их конца. Для
 * штатной остановки воркера и для конца одноразового крона: иначе список
 * проектов, остановленных тем же отказом, умрёт вместе с процессом.
 */
export function flushHeOpsAlerts(): Promise<void> {
  const keys = [...bursts.keys()];
  return Promise.all(keys.map((key) => flushBurst(key))).then(() => undefined, () => undefined);
}
