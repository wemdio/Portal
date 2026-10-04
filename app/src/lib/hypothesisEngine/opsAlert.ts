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
 *    ту же нейтральную фразу.
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
 *     (heOpsRepeatWindowMs) не пишется вовсе. Провайдер в ключе обязателен:
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
 *  2. провайдер + вид отказа: первое сообщение уходит сразу, а остальные
 *     проекты с тем же отказом в течение HE_OPS_BURST_WINDOW_MS (10 мин)
 *     копятся и уходят ОДНИМ сообщением-списком в конце окна — кончившийся
 *     баланс у провайдера валит все проекты очереди подряд, и это одна новость,
 *     а не двадцать.
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
 * похожее на ключ/токен вымарывается. Транспорт — существующий
 * `lib/telegram/workerAlert.ts` (health-бот по умолчанию), второго клиента
 * Telegram здесь нет. Без кредов он только пишет предупреждение в stderr —
 * поэтому наличие TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID в
 * контейнере движка (воркер и крон) И в веб-контейнере `portal` (запуск
 * шаблона из кабинета) входит в предрелизную проверку.
 */

import { sendWorkerAlert } from '@/lib/telegram/workerAlert';

/** Что остановило проект. */
export type HeOpsStopKind = 'billing' | 'configuration' | 'capacity_pause';

/** Чей отказ: модель (LLM-провайдер), поиск (Serper), рассыльщик (Instantly). */
export type HeOpsStopProvider = 'model' | 'search' | 'sending';

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
  /** Шаблон, если отказ случился на его запуске. */
  templateId?: string | null;
  /**
   * Только capacity_pause: поставил ли паузу именно этот вызов
   * (`pauseHeAutoPipelineRefill` → true), или она уже стояла / не записалась
   * (false). null/не задано — не применимо.
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
/** То же окно для 'capacity_pause' (см. шапку). */
export const HE_OPS_CAPACITY_REPEAT_MS = 6 * 60 * 60 * 1000;

/** Окно молчания по проекту, виду отказа и провайдеру — по виду отказа. */
export function heOpsRepeatWindowMs(kind: HeOpsStopKind): number {
  return kind === 'capacity_pause' ? HE_OPS_CAPACITY_REPEAT_MS : HE_OPS_TEAM_FIX_REPEAT_MS;
}

/** Окно, в котором отказы одного провайдера по разным проектам сворачиваются в одно сообщение. */
export const HE_OPS_BURST_WINDOW_MS = 10 * 60 * 1000;
/** Сколько вызывающий ждёт отправку в Telegram, прежде чем пойти дальше. */
export const HE_OPS_SEND_TIMEOUT_MS = 15_000;
/** Длина причины в сообщении. */
export const HE_OPS_REASON_MAX = 200;
/** Сколько проектов перечислять в свёрнутом сообщении; остальные — числом. */
const HE_OPS_BURST_LIST_MAX = 20;

const WORKER_ID = 'hypothesis-engine · ENG';

const KIND_LABEL: Record<HeOpsStopKind, string> = {
  billing: 'отказ по деньгам (баланс/кредиты)',
  configuration: 'отказ по настройке (ключ не задан или отклонён)',
  // Без «добор на паузе»: тот же вид отказа шлёт и запуск шаблона, у которого
  // паузы нет; про паузу говорят совет (actionFor) и строка «пауза».
  capacity_pause: 'нет места под контакты у рассыльщика',
};

const PROVIDER_LABEL: Record<HeOpsStopProvider, string> = {
  model: 'LLM-провайдер (модель)',
  search: 'Serper (поиск)',
  sending: 'Instantly (рассыльщик)',
};

/** Что сделать команде — по виду отказа, провайдеру и (для ёмкости) месту отказа. */
function actionFor(kind: HeOpsStopKind, provider: HeOpsStopProvider, stage?: string): string {
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

/** Причина для сообщения: одна строка, без секретов, не длиннее HE_OPS_REASON_MAX. */
export function heOpsReasonText(raw: string | null | undefined): string {
  const flat = redactSecrets(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  if (!flat) return 'причина не записана';
  return flat.length > HE_OPS_REASON_MAX ? `${flat.slice(0, HE_OPS_REASON_MAX - 1)}…` : flat;
}

function projectLabel(stop: HeOpsStop): string {
  const name = stop.projectName?.trim();
  return name ? `«${name}» (${stop.projectId})` : stop.projectId;
}

/** Отправка с собственным сроком: sendWorkerAlert не бросает, но и срока не знает. */
async function sendBounded(alert: Parameters<typeof sendWorkerAlert>[0]): Promise<void> {
  const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
  try {
    await Promise.race([
      sendWorkerAlert(alert).catch(() => undefined),
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

function sendSingle(stop: HeOpsStop): Promise<void> {
  return sendBounded({
    workerId: WORKER_ID,
    subject: `клиентский проект остановлен — ${KIND_LABEL[stop.kind]}, ${PROVIDER_LABEL[stop.provider]}`,
    error: heOpsReasonText(stop.reason),
    context: {
      'проект': projectLabel(stop),
      'рынок': stop.market ?? 'не прочитан (проверь, что это ENG)',
      'стадия': stop.stage,
      'HTTP-статус': stop.httpStatus ?? null,
      'джоба': stop.jobId ?? null,
      'база': stop.baseId ?? null,
      'шаблон': stop.templateId ?? null,
      'пауза':
        stop.kind === 'capacity_pause' && typeof stop.pauseRecorded === 'boolean'
          ? stop.pauseRecorded
            ? 'поставлена этим отказом'
            : 'не записана этим вызовом (уже стояла, нет конфига или колонок)'
          : null,
      'клиент видит': stop.clientSees?.trim() || 'временная проблема на нашей стороне, команда уже работает',
      'сделать': actionFor(stop.kind, stop.provider, stop.stage),
    },
  });
}

function sendBurst(provider: HeOpsStopProvider, kind: HeOpsStopKind, stops: HeOpsStop[]): Promise<void> {
  const shown = stops.slice(0, HE_OPS_BURST_LIST_MAX);
  const lines = shown.map((s) => `${projectLabel(s)} — ${s.stage}${s.market ? '' : ' (рынок не прочитан)'}`);
  if (stops.length > shown.length) lines.push(`и ещё ${stops.length - shown.length}`);
  // Советы всех мест отказа в списке, без повторов: у ёмкости ночной добор и
  // запуск шаблона чинятся по-разному.
  const actions = [...new Set(stops.map((s) => actionFor(kind, provider, s.stage)))];
  return sendBounded({
    workerId: WORKER_ID,
    subject: `тем же отказом остановлено ещё ${stops.length} — ${KIND_LABEL[kind]}, ${PROVIDER_LABEL[provider]}`,
    error: lines.join('\n'),
    context: {
      'первая причина': heOpsReasonText(stops[0]?.reason),
      'сделать': actions.join('; '),
    },
  });
}

/**
 * До какого момента (мс) молчать по ключу «проект | вид отказа | провайдер».
 * Хранится срок, а не время отправки: окно у видов разное.
 */
const silentUntilByProjectKind = new Map<string, number>();

interface HeOpsBurst {
  provider: HeOpsStopProvider;
  kind: HeOpsStopKind;
  /** Когда ушло первое сообщение окна. */
  leadAt: number;
  pending: HeOpsStop[];
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

    for (const [key, until] of silentUntilByProjectKind) {
      if (now >= until) silentUntilByProjectKind.delete(key);
    }
    const projectKey = `${stop.projectId}|${stop.kind}|${stop.provider}`;
    const until = silentUntilByProjectKind.get(projectKey);
    if (until !== undefined && now < until) return Promise.resolve();
    silentUntilByProjectKind.set(projectKey, now + heOpsRepeatWindowMs(stop.kind));

    const burstKey = `${stop.provider}|${stop.kind}`;
    const open = bursts.get(burstKey);
    if (open && now - open.leadAt < HE_OPS_BURST_WINDOW_MS) {
      open.pending.push(stop);
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
    return Promise.all([previous, sendSingle(stop)]).then(() => undefined, () => undefined);
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
