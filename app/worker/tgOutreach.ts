import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import {
  runCampaignLoop,
  refetchEmptyDialogs,
  type CampaignCheckpoint,
} from '@/lib/tgOutreach/campaignLoop';
import { runWarmupLoop, type WarmupCheckpoint } from '@/lib/tgOutreach/warmup/loop';
import { writeHeartbeat } from '@/lib/tgOutreach/gramClient';
import {
  planWatchdogActions,
  staleKillRequests,
  type LoopControl,
} from '@/lib/tgOutreach/watchdog';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { startTrace } from '@/lib/tracer';

const WORKER_ID = `tg-outreach-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;

/**
 * Сколько БОЕВЫХ кампаний воркер ведёт одновременно.
 *
 * Число прежнее — предел карты `runningCampaigns` стал пределом раннера аренды,
 * смысл тот же. На проде оно задано в compose (TG_OUTREACH_MAX_CONCURRENCY=12):
 * потолок считался по памяти контейнера, каждая кампания — свой набор клиентов
 * gramJS в одном процессе.
 */
const CAMPAIGN_MAX_CONCURRENCY = Math.max(1, Number(process.env.TG_OUTREACH_MAX_CONCURRENCY ?? '5'));

/**
 * Аренда строки кампании — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок держим
 * коротким: 180 с ≈ три пропущенных продления. После краха/OOM/SIGKILL кампанию
 * подберут через аренду (3 мин) + один опрос (30 с) ≈ 3,5 минуты. Чистая
 * остановка (деплой) обнуляет аренду сразу и порога не ждёт.
 *
 * Признак «работа движется» — отдельный, это колонка progress_at ниже.
 */
const CAMPAIGN_LEASE_SECONDS = Math.max(60, Number(process.env.TG_OUTREACH_LEASE_SECONDS ?? '180'));

/**
 * Порог простоя по колонке `progress_at` — 25 минут, и это ЕДИНСТВЕННОЕ
 * обнаружение зависших кампаний, оставшееся в воркере.
 *
 * Снизу. Порог обязан быть больше самого длинного ЗАКОННОГО молчания круга.
 * Отметку двигают те же горячие точки, что раньше кормили сторожа: верх круга,
 * каждый аккаунт, каждый контакт первого касания, конец паузы. Самая длинная
 * законная пауза между двумя отметками — анти-флуд между аккаунтами, до 599 с
 * (10 мин), плюс работа самого аккаунта: загрузка диалогов с потолком 180 с,
 * повторное подключение и вторая попытка — ещё столько же. То есть ~17 минут
 * честной работы без единой отметки достижимы. 25 минут — то же число, что
 * стояло в сторожевом таймере на проде (TG_OUTREACH_WATCHDOG_MS=1500000), и
 * поднято оно туда было ровно по этой причине: дефолтных 15 минут не хватало и
 * сторож трижды за 8,5 часов ронял процесс на здоровых кампаниях (16.08.2026).
 *
 * Сверху. Спецификации мониторинга у `tg_outreach_campaigns` нет: в
 * services/health-check/main.py таблица входит только в счётчик количества
 * (_JOB_TABLES, «TG Кампании»), обнаружения зависаний для неё нет вовсе.
 * Значит верхнюю границу задаёт правило суммы и здравый смысл: порог (25 мин)
 * + одна аренда (3 мин — при простое она НЕ отпускается, а истекает сама)
 * + один опрос (30 с) = 28,5 минуты до того, как кампанию перезапустят с
 * чекпойнта. Прежний сторож в лучшем случае действовал за 25 + 1 (тик) минуту,
 * а в худшем не действовал вовсе — изолировал кампанию до перезапуска воркера.
 */
const CAMPAIGN_STALL_MS = Math.max(60_000, Number(process.env.TG_OUTREACH_STALL_MS ?? String(25 * 60_000)));

/**
 * Как часто отметка прогресса едет в базу.
 *
 * Горячие точки цикла зовут onProgress десятки раз в минуту, а колонка нужна
 * только для сравнения «сдвинулась или стоит» на каждом продлении аренды (раз в
 * 60 с). Пишем не чаще раза в минуту: этого достаточно, чтобы порог в 25 минут
 * не сработал на живой кампании, и это 1440 записей в сутки вместо десятков
 * тысяч.
 */
const PROGRESS_WRITE_INTERVAL_MS = 60_000;

/**
 * Аренда прогона прогрева — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок держим
 * коротким: 180 с ≈ три пропущенных продления. После краха/OOM/SIGKILL прогон
 * подберут через аренду (3 мин) + один опрос соседа (30 с — realtime будит
 * только на status=pending, effectiveFallback в app/worker/_shared.ts) ≈ 3,5
 * минуты. Чистая остановка (деплой) обнуляет аренду сразу и порога не ждёт.
 *
 * Прогон живёт четверо суток и переживает десяток деплоев — на длину аренды
 * это не влияет: аренда меряет не длину задачи, а частоту признаков жизни.
 */
const WARMUP_LEASE_SECONDS = Math.max(
  60,
  Number(process.env.TG_WARMUP_LEASE_SECONDS ?? '180'),
);

/**
 * Сколько прогревов одновременно на этой реплике.
 *
 * Своя очередь и свой предел, отдельно от боевых кампаний, — иначе повторился
 * бы 04.08.2026, когда прогрев ATOL-1 два часа простоял в pending, потому что
 * пять боевых кампаний держали весь общий пул слотов.
 *
 * Ограничивает число не Telegram, а память. Счётчики Telegram тут ни при чём:
 * тот, об который прогрев разбился 07.08.2026, — это импорт контактов НА
 * АККАУНТ, а две кампании греются разными аккаунтами через разные прокси, и
 * параллельность его не удваивает. А вот лимит памяти контейнера (4 ГБ,
 * docker-compose.prod.yml) подбирался под число одновременных наборов
 * подключённых клиентов, и прогревный слот теперь ДОБАВЛЯЕТСЯ к боевым:
 * потолок — сумма TG_OUTREACH_MAX_CONCURRENCY и этого числа.
 *
 * Два по умолчанию: одного мало (вторая партия аккаунтов ждала бы четверо
 * суток), а прибавка к пиковой памяти при двенадцати боевых кампаниях —
 * шестая часть. Вынесено в переменную, а не зашито: соседний
 * TG_OUTREACH_MAX_CONCURRENCY — живой памятник тому, чем кончается зашитая
 * константа, которую понадобилось поменять на бою.
 */
const WARMUP_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.TG_WARMUP_MAX_CONCURRENCY ?? '2'),
);

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

/**
 * Сторожевой таймер остался ТОЛЬКО за прогревом.
 *
 * Боевые кампании из него убраны: их зависание теперь ловит колонка прогресса
 * `progress_at` под арендой (CAMPAIGN_STALL_MS выше), и два сторожа на одну
 * работу конфликтовали бы. Конкретно конфликтовали так:
 *  - сторож при общем зависании ронял процесс (process.exit(1)), а это чужие
 *    аренды: у здоровых соседних кампаний lease_until остался бы живым, и
 *    следующий владелец ждал бы их полную аренду, записав это как падение с
 *    тратой попытки;
 *  - карантин («изолируем и ждём перезапуска воркера») под арендой означает
 *    строку, которую никто не подберёт: продление идёт независимым таймером и
 *    держало бы мёртвую кампанию живой на вид.
 * Порог простоя делает то же самое, но правильно: продления прекращаются,
 * аренда истекает сама, кампанию подбирают и продолжают с чекпойнта.
 *
 * Прогреву эта замена не подходит и потому сторож для него сохранён без
 * изменений: у прогона нет колонки, которая двигалась бы в пределах часов
 * (законная ночная пауза — 8 часов), и порог для него не существует —
 * арифметика в комментарии к warmupRunner ниже.
 */
const warmupLastProgressAt = new Map<string, number>();
const WATCHDOG_THRESHOLD_MS = Number(process.env.TG_OUTREACH_WATCHDOG_MS) || 15 * 60_000;
const WATCHDOG_CHECK_INTERVAL_MS = 60_000;

// Сколько ждать, пока прогрев умрёт по-хорошему, прежде чем изолировать его.
// Разрыв сокетов будит зависший await почти мгновенно, но циклу нужно ещё
// доразмотать текущий шаг и дописать статус в БД.
const WATCHDOG_KILL_GRACE_MS = Number(process.env.TG_OUTREACH_WATCHDOG_GRACE_MS) || 3 * 60_000;

/**
 * Ручки «порвать сокеты» боевых кампаний, по campaign_id.
 *
 * Разрыв сокетов — единственное, чем можно разбудить цикл, стоящий внутри
 * зависшего сетевого await'а, и единственное, чем можно освободить сессии
 * Telegram до того, как строку заберёт кто-то ещё.
 *
 * КАРТА ОТДЕЛЬНАЯ ОТ ПРОГРЕВА, И ЭТО ВАЖНО. Раньше она была общей, а ключом в
 * обеих служит campaign_id — то есть прогрев и боевой цикл одной кампании
 * писали в одну ячейку. После остановки прогрева аутрич можно запускать сразу,
 * прогревное тело в этот момент ещё разматывается, и его finally стирал ключ
 * уже начавшейся кампании. Хук закрытия клиентов не находил ручку и отпускал
 * аренду с живыми сессиями — ровно то, ради чего он существует. Теперь у
 * каждого своя карта, а удаление идёт с проверкой на тождество объекта: чужую
 * запись не сотрёт даже опоздавший finally.
 */
const campaignControls = new Map<string, LoopControl>();
const warmupControls = new Map<string, LoopControl>();
const warmupKillRequestedAt = new Map<string, number>();

/** Кооперативные ручки «остановись» боевых кампаний, по campaign_id. */
const campaignStops = new Map<string, () => void>();

/**
 * Идущее тело кампании: campaign_id -> промис, который разрешится, когда цикл
 * действительно вышел.
 *
 * ЭТО ГЛАВНАЯ ЗАЩИТА ОТ ВТОРОГО ЗАПУСКА. Раньше её роль играла карта
 * runningCampaigns: пока кампания в ней, старт по команде не проходил. С
 * переездом на аренду карта ушла, а вместе с ней и проверка — и открылся путь
 * в два клика. Оператор жмёт «Стоп»: статус становится `stopped`, владение
 * снимается, но тело останавливается кооперативно и, если стоит в зависшем
 * вызове gramJS, живёт ещё минуты. Оператор тут же жмёт «Запустить»: статус
 * снова `running`, аренды нет, раннер берёт строку — и buildClients открывает
 * ТЕ ЖЕ двенадцать сессий, которые держит первое тело. Это AUTH_KEY_DUPLICATED
 * на каждый аккаунт, а три таких эпизода выключают аккаунт насовсем.
 * «Перезапустить» делал обе половины подряд вообще без паузы.
 */
const campaignBodies = new Map<string, Promise<void>>();

/**
 * Сколько ждать, пока прошлое тело кампании доработает, прежде чем сдаться.
 *
 * Разбуженное разрывом сокетов тело выходит за секунды: паузы прерываемые,
 * сетевые вызовы падают с ошибкой сразу. Минута — с запасом на то, чтобы цикл
 * доразмотал текущий шаг и дописал строки в журнал. Если не уложился, новый
 * прогон не начинаем вовсе: подключать сессии поверх живых нельзя, а строку
 * отдадим следующему опросу — он придёт через полминуты.
 */
const CAMPAIGN_BODY_HANDOVER_MS = 60_000;

/**
 * Идущее закрытие клиентов кампании: campaign_id -> промис.
 *
 * Закрытие зовут двое — обработчик прерывания (сразу, как только стало ясно,
 * что кампания больше не наша) и beforeRelease (перед тем, как отпустить
 * аренду). Промис общий, чтобы второй вызов дожидался первого, а не рвал те же
 * сокеты во второй раз.
 */
const campaignClosing = new Map<string, Promise<void>>();

/**
 * Ручки остановки идущих прогревов, по campaign_id.
 *
 * Отдельная карта от боевых кампаний: у прогрева своя очередь, свой предел
 * одновременных прогонов и свой сторож. Сторожевому таймеру эта карта отвечает
 * на вопрос «прогон ещё жив в процессе?» — без неё он дошёл бы только до
 * первого шага (разрыв сокетов) и никогда не довёл бы решение до конца.
 */
const warmupStops = new Map<string, () => void>();

/**
 * Прогоны, которым уже сказали в журнал, что они ждут свободный слот.
 *
 * Фраза верна на каждом опросе, а опросы идут раз в 30 секунд — без этого
 * множества вкладка «Прогрев» за сутки ожидания получила бы три тысячи
 * одинаковых строк. Запись снимается, когда прогон наконец захвачен.
 */
const warmupWaitLogged = new Set<string>();

/**
 * Закрыть клиенты Telegram кампании и дождаться, пока они закрыты.
 *
 * ЗАЧЕМ ЭТО ВАЖНЕЕ, ЧЕМ ВЫГЛЯДИТ. Единица работы здесь — кампания с дюжиной
 * живых MTProto-сессий. Второе подключение той же сессии даёт
 * AUTH_KEY_DUPLICATED, и после трёх таких подряд аккаунт выключается насовсем
 * (lib/tgOutreach/gramClient.ts) — восстановление только руками, с
 * перевыпуском сессии с телефона. Поэтому клиенты обязаны быть закрыты ДО
 * того, как строку кампании сможет забрать кто-то ещё: и при остановке
 * процесса (beforeRelease), и при потере аренды, и при простое.
 *
 * Разрыв сокетов — единственное, что будит цикл, стоящий внутри зависшего
 * сетевого await'а: кооперативная проверка «просили остановиться» до него не
 * доходит. gramJS после disconnect() не переподключается сам (userDisconnected),
 * так что брошенное тело не воскресит сессию исподтишка.
 */
function closeCampaignClients(campaignId: string): Promise<void> {
  const existing = campaignClosing.get(campaignId);
  if (existing) return existing;
  const control = campaignControls.get(campaignId);
  if (!control?.forceDisconnect) return Promise.resolve();
  const closing = control
    .forceDisconnect()
    .catch((err: unknown) => {
      log('error', `Не смог закрыть клиенты кампании ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
      /*
       * Неудачу НЕ запоминаем как успех.
       *
       * Промис кэшируется, чтобы два зовущих не рвали одни и те же сокеты
       * дважды. Но кэш разрешённого промиса после ОШИБКИ означал бы, что
       * повторная попытка разрыва не случится больше никогда — а нужна она
       * ровно там, где первая не сработала: тело не проснулось, мы ждём его
       * второй заход. Стираем запись, чтобы следующий вызов попробовал снова.
       */
      if (campaignClosing.get(campaignId) === closing) campaignClosing.delete(campaignId);
    });
  campaignClosing.set(campaignId, closing);
  return closing;
}

/**
 * Дождаться, пока прошлое тело кампании закончит, помогая ему закончить.
 *
 * Два движения — те же, что делал сторожевой таймер: кооперативная просьба
 * остановиться и разрыв сокетов, потому что цикл может стоять внутри зависшего
 * сетевого вызова и до проверки «просили остановиться» не дойти. Возвращает
 * false, если за отведённое время тело так и не вышло, — тогда начинать второй
 * прогон нельзя.
 */
async function handOverCampaign(campaignId: string, previous: Promise<void>): Promise<boolean> {
  try {
    campaignStops.get(campaignId)?.();
  } catch (err) {
    log('error', `Не смог попросить прошлый прогон ${campaignId} остановиться: ${err instanceof Error ? err.message : String(err)}`);
  }
  void closeCampaignClients(campaignId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CAMPAIGN_BODY_HANDOVER_MS);
  });
  try {
    return await Promise.race([previous.then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Снять регистрацию прогона, НО только если она всё ещё наша.
 *
 * Тождество объекта, а не факт наличия ключа: тело, размотавшееся с опозданием,
 * не должно стирать ручки прогона, который уже начался на том же ключе. Именно
 * так общая карта ломала защиту от второго набора клиентов.
 */
function forgetIfOwn<T>(map: Map<string, T>, key: string, own: T): void {
  if (map.get(key) === own) map.delete(key);
}

function forgetCampaign(campaignId: string, own: { control: LoopControl; stop: () => void; body: Promise<void> }) {
  forgetIfOwn(campaignStops, campaignId, own.stop);
  forgetIfOwn(campaignControls, campaignId, own.control);
  forgetIfOwn(campaignBodies, campaignId, own.body);
  /*
   * campaignClosing здесь НЕ чистим — намеренно.
   *
   * Тело кампании, разбуженное сигналом, возвращается за один-два микротаска,
   * то есть раньше, чем библиотека успевает позвать beforeRelease. Сотри мы
   * тут запись о начатом закрытии, хук не нашёл бы ни ручки (её уже нет), ни
   * промиса — и отчитался бы «клиенты закрыты» до того, как они закрылись.
   * Аренду отпустили бы под живыми сессиями, а это ровно тот случай, ради
   * которого хук и существует. Запись снимает следующий запуск этой же
   * кампании (см. начало run), так что копиться ей негде.
   */
}

/**
 * Закрыть зависшие start-джобы вместо возврата в очередь.
 *
 * Почему `completed`, а не `pending`: возвращённая в очередь команда «старт»
 * ничего полезного не сделает (работу запускает не она, а строка кампании), а
 * путаницу в журнале создаст.
 */
async function closeStuckStartJobs(ids: string[], reason: string): Promise<void> {
  if (!ids.length) return;
  const { error } = await db
    .from('tg_outreach_jobs')
    .update({ status: 'completed', finished_at: new Date().toISOString(), error_message: reason })
    .in('id', ids)
    // Гонка с .finally() живого цикла: он помечает джобу completed параллельно,
    // и без этого условия можно было бы переписать уже закрытую джобу.
    .eq('status', 'running');
  if (error) log('error', `Не смог закрыть зависшие start-джобы: ${error.message}`);
}

export async function resetStuckJobs() {
  const { data, error } = await db
    .from('tg_outreach_jobs')
    .select('id, action')
    .eq('status', 'running');

  // Ошибку запроса раньше игнорировали: `const { data } = ...`, и при сбое
  // связи data приходил null, условие ниже не выполнялось, функция молча
  // выходила. А зовут её ровно один раз, на старте процесса — второго шанса
  // нет. 18.08.2026 перезапуск в 21:20 совпал с морганием базы: пять start-джоб
  // остались `running`, авто-резюм каждые пять минут видел «старт уже
  // запланирован» и ничего не делал, и все кампании простояли 16 часов, показывая
  // в интерфейсе running. Молчать здесь нельзя.
  if (error) {
    log('error', `Не смог проверить зависшие джобы при старте: ${error.message}. Их подберёт периодический сторож сирот.`);
    return;
  }

  const rows = (data ?? []) as Array<{ id: string; action: string }>;
  if (!rows.length) return;

  const isStart = (action: string) => (START_ACTIONS as readonly string[]).includes(action);
  const startIds = rows.filter((r) => isStart(r.action)).map((r) => r.id);
  const controlIds = rows.filter((r) => !isStart(r.action)).map((r) => r.id);

  // Control-джобы (стоп/рестарт/refetch) — прямое действие человека, его
  // терять нельзя: если оператор нажал «Стоп» перед падением процесса,
  // кампанию надо остановить, а не забыть об этом.
  if (controlIds.length) {
    log('info', `Возвращаю в очередь ${controlIds.length} зависших control-джоб`);
    const { error: updErr } = await db
      .from('tg_outreach_jobs')
      .update({ status: 'pending', error_message: null, started_at: null, finished_at: null })
      .in('id', controlIds)
      .eq('status', 'running');
    if (updErr) {
      log('error', `Не смог сбросить зависшие control-джобы: ${updErr.message}. Их подберёт периодический сторож сирот.`);
    }
  }

  if (startIds.length) {
    log('info', `Закрываю ${startIds.length} зависших start-джоб — работу запускает не команда, а сама строка кампании`);
    await closeStuckStartJobs(startIds, 'Зависшая start-джоба от прошлого процесса: закрыта при старте воркера');
  }
}

// Control-джобы (stop/restart/refetch_messages) не занимают слот раннера и
// должны подхватываться независимо от предела одновременных кампаний — иначе
// оператор жмёт «Стоп», а команда живёт в pending, пока все слоты заняты.
// Инцидент 29.07.2026: 5 running кампаний → 4 стоп-клика подряд ушли в stale,
// кампании продолжали работать.
export const CONTROL_ACTIONS = ['stop', 'restart', 'refetch_messages', 'warmup_stop'] as const;
export const START_ACTIONS = ['start', 'warmup_start'] as const;

/*
 * Периодического сторожа осиротевших start-джоб здесь БОЛЬШЕ НЕТ.
 *
 * Он решал одну задачу: команда «старт» висела в статусе «выполняется» всё
 * время жизни кампании, и если процесс умирал, она оставалась там навсегда — а
 * авто-резюм, увидев активную команду, считал, что старт уже запланирован, и не
 * делал ничего (18.08.2026: пять кампаний простояли 16 часов). Вместе с
 * авто-резюмом ушла и причина: команда «старт» закрывается тем же запросом,
 * который её взял, и висеть в «выполняется» больше не может. Брошенная кампания
 * теперь определяется истёкшей арендой, а не отсутствием активной команды, —
 * и определяется одинаково при любом числе реплик.
 */

export async function claimJob(
  actionFilter?: readonly string[],
): Promise<{ id: string; campaign_id: string; action: string } | null> {
  let pendingQuery = db
    .from('tg_outreach_jobs')
    .select('id, campaign_id, action')
    .eq('status', 'pending');
  if (actionFilter && actionFilter.length > 0) {
    pendingQuery = pendingQuery.in('action', actionFilter as unknown as string[]);
  }
  const { data: pending } = await pendingQuery
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_outreach_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, campaign_id, action')
    .maybeSingle();

  return claimed ?? null;
}

/**
 * В таблице кампаний НЕТ статуса «ожидает исполнителя».
 *
 * Check-констрейнт `tg_outreach_campaigns` (миграция 20260804_0001) знает
 * пять значений: stopped / running / paused / error / warming. Кнопка
 * «Запустить» сразу пишет `running` — то есть очередь выражена не статусом, а
 * ОТСУТСТВИЕМ аренды: строка `running` без живого lease_until и есть «ждёт
 * исполнителя», и забирает её путь перехвата истёкшей аренды.
 *
 * Библиотеке при этом нужно какое-то значение под pending. Даём заведомо
 * невозможное: check-констрейнт гарантирует, что строк с ним нет, поэтому
 * запрос кандидата всегда пуст, а CAS `where status = <это>` не совпадёт ни с
 * одной строкой. Подставить сюда реальный статус нельзя ни один: `stopped`,
 * `paused` и `error` — это решения оператора и итоги, их брать в работу нельзя,
 * `running` — уже работающая, а `warming` — греющаяся, и вот она отдельно
 * важна: пока кампания в этом статусе, боевой раннер её не видит вовсе. Это и
 * есть взаимное исключение с прогревом — структурное, а не картой в памяти:
 * греющаяся кампания просто не подходит ни под один путь захвата.
 */
const NO_PENDING_STATUS = 'never-pending';

/**
 * Отпустить аренду кампании, которая вышла сама и осталась в `running`.
 *
 * Библиотека этого не сделает: на успешном пути при manageTerminalStatus=false
 * она снимает владение только со строки, статус которой УЖЕ не `running`
 * (строку, оставленную в работе ради возобновления, трогать нельзя). А цикл
 * умеет вернуться, ничего не написав: например, его попросили остановиться,
 * пока он ждал минуту перед второй попыткой подключения. Без этой записи
 * кампания простояла бы с живой арендой до её конца, после чего перехват счёл
 * бы её потерянной и списал попытку — ровно та ловушка, на которой прогрев
 * уходил в тупик (задача 1 этого этапа).
 */
async function releaseCampaignLeaseIfIdle(campaignId: string, runToken: string): Promise<void> {
  const { error } = await db
    .from('tg_outreach_campaigns')
    .update({ lease_until: null })
    .eq('id', campaignId)
    .eq('status', 'running')
    .eq('run_token', runToken);
  if (error) log('error', `Не смог отпустить аренду кампании ${campaignId}: ${error.message}`);
}

/**
 * Боевой аутрич на едином жизненном цикле задач (lib/jobs/lifecycle.ts).
 *
 * Единица работы — СТРОКА КАМПАНИИ, а не команда в очереди. `tg_outreach_jobs`
 * остаётся каналом воли оператора («старт», «стоп»), но больше не держит
 * команду «старт» в статусе «выполняется» всё время жизни кампании — а вместе
 * с ней уходят и сторожа, которые эту команду сторожили.
 */
const campaignRunner = createJobRunner<
  { id: string; name: string | null; user_id: string | null; progress_at: string | null },
  CampaignCheckpoint
>({
  table: 'tg_outreach_campaigns',
  workerId: WORKER_ID,
  statuses: {
    pending: NO_PENDING_STATUS,
    running: 'running',
    // `done` библиотека не использует (manageTerminalStatus: false — итог пишет
    // тело). `failed` она пишет сама, когда исполнитель терял кампанию
    // maxAttempts раз подряд; из статусов таблицы это `error` — он красный в
    // интерфейсе и при этом не тупик: кнопка «Запустить» есть у любого статуса,
    // кроме `running` и `warming` (src/app/tools/tg-outreach/page.tsx).
    done: 'stopped',
    failed: 'error',
  },
  leaseSeconds: CAMPAIGN_LEASE_SECONDS,
  concurrency: CAMPAIGN_MAX_CONCURRENCY,
  /*
   * Бюджет потерь — три, дефолтные.
   *
   * Прогреву пришлось поднимать до десяти, потому что его чекпойнты событийные
   * и ночью отсутствуют по восемь часов подряд. Здесь наоборот: чекпойнт
   * пишется после КАЖДОГО аккаунта, а колонка прогресса двигается раз в минуту
   * — и любое движение возвращает бюджет в ноль. Чтобы дойти до предела, нужно
   * три грубые остановки подряд, между которыми кампания не отработала ни
   * одного аккаунта и не сдвинула отметку прогресса ни разу. Это уже не деплой,
   * а сломанная кампания, и остановить её правильно.
   */
  maxAttempts: 3,
  manageTerminalStatus: false,
  // progress_at читается из захваченной строки как точка отсчёта — иначе первый
  // тик продления потратился бы на её засев.
  select: 'name, user_id, progress_at',
  /*
   * claimPatch НЕТ, и это осознанно.
   *
   * Кандидатов на «поле при захвате» тут два, и оба — ловушки. `updated_at` —
   * отметка «когда кампанию трогали в последний раз», по ней человек отличает
   * живую от забытой; освежать её механизмом аренды значит сломать её смысл.
   * `progress_at` — колонка прогресса, и писать её на захвате означало бы
   * докладывать о прогрессе, которого ещё не было. Точку отсчёта библиотека и
   * так берёт от момента захвата, а не от значения в колонке.
   */
  progress: { column: 'progress_at', stalledAfterMs: CAMPAIGN_STALL_MS },
  /*
   * У кампании нет колонки под причину отказа — зато есть свой журнал, который
   * оператор и читает на вкладке кампании.
   *
   * Поэтому failedPatch здесь работает РАДИ ПОБОЧНОГО ДЕЙСТВИЯ: он пишет строку
   * в tg_outreach_logs и возвращает только отметку времени. Без него
   * библиотечный отказ («исполнитель терял задачу N раз подряд») виден лишь в
   * stdout контейнера — то есть человеку, у которого кампания молча покраснела,
   * не виден нигде. Запись не ждём: терминальная запись библиотеки не должна
   * зависеть от журнала.
   */
  failedPatch: (reason, campaignId) => {
    void db
      .from('tg_outreach_logs')
      .insert({
        campaign_id: campaignId,
        level: 'error',
        message: `Кампания остановлена механизмом задач: ${reason}. Нажмите «Запустить», чтобы продолжить.`,
      })
      .then(({ error }) => {
        if (error) log('error', `Не смог записать причину отказа в журнал кампании: ${error.message}`);
      }, () => {});
    return { updated_at: new Date().toISOString() };
  },
  /*
   * Бюджет остановки: 12 секунд, из них 4 — на закрытие клиентов.
   *
   * Считаем от деплоя: он останавливает воркеры `docker compose stop
   * --timeout 15` (шаг 5 .semaphore/scheduled-deploy.yml), то есть до SIGKILL
   * пятнадцать секунд. Двенадцать — потолок библиотеки (MAX_SHUTDOWN_GRACE_MS),
   * три секунды деплоя остаются в резерве.
   *
   * Внутрь этих двенадцати ложатся по порядку: beforeRelease (≤4 с), два
   * прохода освобождения аренды с паузой в секунду между ними и контрольное
   * чтение (~1,5 с), остаток (~6,5 с) — телам кампаний.
   *
   * Откуда четыре секунды на хук. Закрыть надо до двенадцати клиентов gramJS на
   * кампанию: disconnect каждого — это закрытие своего сокета, десятки
   * миллисекунд на здоровом и до ~300 мс на повисшем через прокси, а идут они
   * последовательно (disconnectAll в lib/tgOutreach/gramClient.ts) — то есть
   * 0,6 с в норме и ~3,6 с в худшем случае. Кампании закрываются параллельно,
   * поэтому двенадцать кампаний не умножают этот срок. Ключи сессий отдельно
   * сохранять не нужно: цикл пишет session_data после каждого аккаунта, а
   * disconnect авторизацию не меняет.
   *
   * Что будет, если не уложимся: библиотека всё равно отпустит аренду и скажет
   * об этом в журнал. Неотпущенная аренда хуже открытых сокетов — кампанию не
   * подберёт никто до конца leaseSeconds, а перехват потом запишет это как
   * падение и потратит попытку.
   */
  shutdownGraceMs: 12_000,
  beforeReleaseTimeoutMs: 4_000,
  /*
   * Единственное место во всём воркере, где порядок «сначала клиенты, потом
   * аренда» имеет цену человеческой ошибки.
   *
   * Сосед, подхвативший строку раньше, чем мы отключили аккаунты, подключит ТЕ
   * ЖЕ сессии MTProto, получит AUTH_KEY_DUPLICATED и после трёх таких подряд
   * выключит аккаунт насовсем — восстановление только руками, с перевыпуском
   * сессии с телефона. Поэтому хук зовётся после abort всех тел и ДО первого
   * освобождения аренды.
   */
  beforeRelease: async (campaignIds) => {
    if (!campaignIds.length) return;
    log('info', `Закрываю клиенты Telegram ${campaignIds.length} кампани(и/й) до отпускания аренды`);
    await Promise.all(campaignIds.map((id) => closeCampaignClients(id)));
    log('info', 'Клиенты Telegram закрыты — аренду можно отпускать');
  },
  log,
  run: async (job, ctx) => {
    const campaignId = job.id;

    /*
     * Одна кампания — один набор клиентов. Проверка ДО всего остального.
     *
     * Прошлое тело этой кампании может быть ещё живо: остановка кооперативная,
     * а цикл, стоящий в зависшем вызове gramJS, выходит не сразу. Запустить
     * второй цикл поверх него — значит открыть те же сессии MTProto и получить
     * AUTH_KEY_DUPLICATED на каждый аккаунт (трижды — и аккаунт выключен
     * навсегда). Поэтому: просим прошлое тело закончить, рвём его сокеты и
     * ЖДЁМ. Дождались — работаем дальше, оно уже сняло свои ручки.
     *
     * Не дождались — второй цикл не начинаем и отпускаем аренду. Строку после
     * этого возьмёт кто угодно: обычно мы же на следующем опросе (реплика на
     * проде одна), но при двух репликах — сосед, и он увидит строку свободной,
     * пока сессии, возможно, ещё держит наше тело. Это осознанный размен:
     * альтернатива — держать аренду за телом, которое не отвечает, то есть
     * запереть кампанию до перезапуска контейнера. Разрыв сокетов к этому
     * моменту сделан и у него была целая минута.
     */
    const previousBody = campaignBodies.get(campaignId);
    if (previousBody) {
      log('warn', `Campaign ${campaignId}: предыдущий прогон ещё не завершился — прошу его закончить и жду до ${Math.round(CAMPAIGN_BODY_HANDOVER_MS / 1000)}с`);
      const handedOver = await handOverCampaign(campaignId, previousBody);
      if (!handedOver) {
        log(
          'error',
          `Campaign ${campaignId}: предыдущий прогон не завершился за ${Math.round(CAMPAIGN_BODY_HANDOVER_MS / 1000)}с — не запускаю второй. ` +
            'Клиенты Telegram этой кампании держит он; второй набор тех же сессий выключил бы аккаунты. Аренду отпускаю — кампанию возьмёт следующий свободный исполнитель (обычно этот же воркер на ближайшем опросе).',
        );
        await releaseCampaignLeaseIfIdle(campaignId, ctx.runToken);
        return;
      }
    }

    // Пока мы ждали прошлое тело, всё могло измениться: пришёл SIGTERM, или
    // строку у нас забрали. Подключать сессии после этого нельзя.
    if (ctx.shouldStop()) {
      log('info', `Campaign ${campaignId}: остановка пришла до запуска цикла — не подключаюсь`);
      if (!ctx.signal.aborted) await releaseCampaignLeaseIfIdle(campaignId, ctx.runToken);
      return;
    }

    log('info', `Starting campaign ${campaignId}`);

    let stopRequested = false;
    const stop = () => { stopRequested = true; };
    campaignStops.set(campaignId, stop);
    const control: LoopControl = {};
    campaignControls.set(campaignId, control);
    // Отметка о закрытии клиентов ПРОШЛОГО запуска этой кампании: снимаем её
    // здесь, а не при выходе, — см. forgetCampaign.
    campaignClosing.delete(campaignId);
    let bodyDone: () => void = () => {};
    const body = new Promise<void>((resolve) => { bodyDone = resolve; });
    campaignBodies.set(campaignId, body);

    /*
     * Прерывание — сразу рвём сокеты, не дожидаясь, пока цикл заметит сам.
     *
     * Причина прерывания всегда одна и та же по смыслу: кампания больше не
     * наша (остановка процесса, потеря аренды, простой дольше порога). Дальше
     * работать этими клиентами — писать в Telegram за чужой счёт, а держать
     * сессии открытыми — готовить соседу AUTH_KEY_DUPLICATED. Кооперативной
     * проверки мало: цикл может стоять внутри сетевого await'а, до проверки не
     * доходя, — разбудить его умеет только разрыв сокетов.
     */
    const onAbort = () => { void closeCampaignClients(campaignId); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    /*
     * Отметка прогресса: та же горячая точка, что раньше кормила сторожа.
     *
     * Пишем не чаще раза в минуту и не дожидаясь ответа: цикл не должен ждать
     * базу ради диагностики. Запись ограждена жетоном — перехваченной кампании
     * мы отметки не ставим, иначе продлевали бы соседу жизнь его же строкой.
     */
    let lastProgressWriteAt = 0;
    let progressWriteInFlight = false;
    let progressWriteFailures = 0;
    const onProgress = () => {
      const now = Date.now();
      if (progressWriteInFlight || now - lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
      if (ctx.signal.aborted) return;
      lastProgressWriteAt = now;
      progressWriteInFlight = true;
      void (async () => {
        const { error } = await db
          .from('tg_outreach_campaigns')
          .update({ progress_at: new Date(now).toISOString() })
          .eq('id', campaignId)
          .eq('run_token', ctx.runToken);
        if (!error) {
          progressWriteFailures = 0;
          return;
        }
        progressWriteFailures += 1;
        /*
         * Отдельный громкий сигнал, а не одна и та же тихая строка.
         *
         * Пока отметка не пишется, здоровая кампания выглядит зависшей: порог
         * простоя сработает, аренда уйдёт, кампанию передадут — и так каждые
         * полчаса, без единого намёка на настоящую причину. Библиотека такое не
         * поймает: её собственное предупреждение «колонку прогресса не
         * прочитать» касается ЧТЕНИЯ, а здесь ломается запись. Порог в пять —
         * это пять минут подряд неудачных попыток, то есть уже не моргание сети.
         */
        if (progressWriteFailures === 1 || progressWriteFailures % 5 === 0) {
          const level = progressWriteFailures >= 5 ? 'error' : 'warn';
          log(
            level,
            `Кампания ${campaignId}: отметка прогресса не пишется ${progressWriteFailures} раз(а) подряд — ${error.message}. ` +
              (progressWriteFailures >= 5
                ? `Кампания выглядит зависшей и будет передана другому исполнителю через ${Math.round(CAMPAIGN_STALL_MS / 60_000)} мин, хотя работает.`
                : ''),
          );
        }
      })()
        .catch(() => {})
        .finally(() => { progressWriteInFlight = false; });
    };

    /*
     * Дальше — ОДИН try/finally на всё, и старт трейса внутри него.
     *
     * Регистрацию живого тела снимает только finally, поэтому между
     * `campaignBodies.set` и входом в try не должно быть ни одного действия,
     * которое может бросить. Раньше между ними стояли старт трейса и запись
     * span'а: их исключение оставило бы промис тела неразрешённым навсегда, и
     * каждый следующий заход на эту кампанию ждал бы минуту, сдавался и
     * повторял это до перезапуска контейнера — кампания, которую нельзя
     * запустить ничем. Трейс — диагностика, ронять из-за неё нечего, но и
     * полагаться на то, что она не бросит, тоже нельзя.
     */
    let trace: Awaited<ReturnType<typeof startTrace>> = null;
    try {
      trace = await startTrace({
        name: 'tg-outreach.campaign.run',
        input: {
          campaignId,
          campaignName: job.name,
          route: 'tg_outreach_worker',
          userId: job.user_id,
        },
        message: `TG Аутрич: ${job.name ?? campaignId}`,
        userId: job.user_id ?? null,
      });

      const requestId = trace?.traceId ?? crypto.randomUUID();
      if (trace) {
        await db
          .from('trace_spans')
          .update({ input: { campaignId, campaignName: job.name, requestId, route: 'tg_outreach_worker', userId: job.user_id } })
          .eq('id', trace.id);
      }
      const traceContext = trace ? { requestId } : undefined;

      await runCampaignLoop(
        campaignId,
        db,
        () => ctx.shouldStop() || stopRequested,
        traceContext,
        onProgress,
        control,
        {
          signal: ctx.signal,
          runToken: ctx.runToken,
          checkpoint: ctx.checkpoint,
          saveCheckpoint: ctx.saveCheckpoint,
        },
      );
      log('info', `Campaign ${campaignId} loop finished`);
      void trace?.end({ status: 'stopped' });
      // Вышли сами — если строка всё ещё наша и в работе, отпускаем аренду, а
      // не оставляем её висеть до конца срока.
      if (!ctx.signal.aborted) await releaseCampaignLeaseIfIdle(campaignId, ctx.runToken);
    } catch (err) {
      // На остановке статус не трогаем: строка либо уже не наша, либо отдаётся
      // соседу, и решение о ней принимает библиотека.
      if (ctx.signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `Campaign ${campaignId} loop error: ${msg}`);
      void trace?.fail(err);
      /*
       * Настоящий сбой — статус «ошибка», как и до перевода.
       *
       * Отдать кампанию на повторный захват было бы хуже: освобождение аренды
       * при manageTerminalStatus=false попыткой не считается, и кампания,
       * падающая сразу после запуска, крутилась бы в цикле «захват-падение»
       * вечно. Красный статус виден оператору и снимается одной кнопкой.
       */
      const { error } = await db
        .from('tg_outreach_campaigns')
        .update({
          status: 'error',
          updated_at: new Date().toISOString(),
          // Владение снимаем вместе со статусом — как это делает библиотека в
          // своей терминальной записи (clearOwnership в lib/jobs/lifecycle.ts).
          lease_until: null,
          run_token: null,
          worker_id: null,
        })
        .eq('id', campaignId)
        .eq('run_token', ctx.runToken);
      if (error) log('error', `Failed to mark tg campaign ${campaignId} as error: ${error.message}`);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      forgetCampaign(campaignId, { control, stop, body });
      // Разрешаем промис ПОСЛЕ снятия ручек: тот, кто нас ждёт, должен
      // увидеть карты уже чистыми и поставить в них своё.
      bodyDone();
    }
  },
});

/**
 * Команда «запустить кампанию» — теперь только подтверждение.
 *
 * Работу запускает не она, а сама строка кампании: интерфейс пишет ей
 * `running` (campaigns/[id]/start/route.ts) и рядом кладёт эту команду, чтобы
 * опрос проснулся сразу, а не ждал запасного тика. Раннер подхватит строку по
 * отсутствию аренды.
 */
async function handleStartJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  const { data: campaign } = await db
    .from('tg_outreach_campaigns')
    .select('status')
    .eq('id', campaignId)
    .single();

  /*
   * Кампанию греют — боевой цикл на ней запускать нельзя.
   *
   * ЭТА ПРОВЕРКА ПОСТОЯННАЯ, НЕ ВРЕМЕННАЯ. Да, раннер боевых кампаний не видит
   * строку в статусе `warming` и тем закрывает захват — взаимное исключение
   * теперь структурное. Но `tg_outreach_jobs` переезд пережила: команды
   * «старт» и «стоп» остаются каналом воли оператора, а команда — это не
   * захват. Пока существует путь «пришла команда старт → что-то происходит»,
   * ему нужен свой замок, и вот он.
   */
  if (campaign?.status === 'warming') {
    log('warn', `Campaign ${campaignId} is warming up — start ignored`);
    await db
      .from('tg_outreach_jobs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        error_message: 'Кампания на прогреве: боевой аутрич не запускается, пока идёт прогрев',
      })
      .eq('id', job.id);
    return;
  }

  log('info', `Start requested for campaign ${campaignId} — кампанию подхватит раннер аренды`);
  await db
    .from('tg_outreach_jobs')
    .update({ status: 'completed', finished_at: new Date().toISOString() })
    .eq('id', job.id);
}

async function handleStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  /*
   * Остановка — это прежде всего запись в строку кампании.
   *
   * Владение снимаем тем же движением, что и статус. Это и есть остановка для
   * исполнителя, где бы он ни шёл: его продление аренды перестанет находить
   * строку с нашим жетоном (≤ треть аренды, 60 с), библиотека взведёт сигнал,
   * а обработчик прерывания порвёт сокеты — цикл выйдет, ничего больше не
   * отправив. Ждать конца цикла здесь, как раньше, нельзя: тело может идти в
   * другой реплике, а команда «стоп» обязана отработать за секунды.
   *
   * Условие на статус — только `warming`: прогрев останавливают своей кнопкой,
   * и гасить его этой командой значило бы бросить прогон без итога. Все
   * остальные статусы пишем безусловно, потому что интерфейс «стоп» сам в
   * строку не пишет — он только кладёт эту команду.
   */
  const { error } = await db
    .from('tg_outreach_campaigns')
    .update({
      status: 'stopped',
      updated_at: new Date().toISOString(),
      lease_until: null,
      run_token: null,
      worker_id: null,
    })
    .eq('id', campaignId)
    .neq('status', 'warming');
  if (error) log('error', `Не смог остановить кампанию ${campaignId}: ${error.message}`);

  /*
   * И сразу же — кооперативная просьба, если кампания идёт в ЭТОМ процессе.
   *
   * Запись выше доходит до исполнителя за минуту (тик продления аренды), а
   * реплика на проде одна: в подавляющем большинстве случаев это мы сами, и
   * ждать минуту незачем. Кросс-процессный путь при этом остаётся — просьба в
   * памяти его не заменяет, а опережает.
   */
  campaignStops.get(campaignId)?.();

  /*
   * Закрываем клиенты — до того, как команда будет отмечена выполненной, но
   * САМО ТЕЛО НЕ ЖДЁМ.
   *
   * Закрытие быстрое (сокеты, не сеть) и это единственная честная гарантия
   * слова «остановлено»: сессии свободны, а не «мы попросили». А вот ожидания
   * тела здесь быть не должно. Оно шло бы внутри опроса и держало бы весь цикл
   * до минуты: в это время не берётся ни чужой «стоп», ни «перезапуск», ни
   * перехват брошенной кампании, ни прогрев. Голова очереди, забитая на
   * аварийном пути оператора, — это ровно инцидент 29.07.2026, когда четыре
   * стоп-клика подряд ушли в никуда.
   *
   * Ждать и не нужно: от второго набора сессий защищает не эта пауза, а
   * проверка живого тела в самом раннере (второй запуск не начнётся, пока
   * прошлый цикл жив) и такая же проверка в догрузке переписок.
   */
  await closeCampaignClients(campaignId);
  log('info', `Stop recorded for campaign ${campaignId}`);

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

/**
 * Перезапуск: остановить и снова пометить строку запущенной.
 *
 * Ни один маршрут интерфейса эту команду сегодня не ставит, но канал команд
 * жив, и «остановить и не запустить» было бы ловушкой. Статус пишем явно —
 * команда «старт» этого больше не делает намеренно: иначе залежавшаяся команда
 * воскрешала бы кампанию, остановленную оператором (аудит 20.08.2026). Здесь
 * же воля оператора выражена прямо и только что, и ограждение по `stopped`
 * гарантирует, что мы запускаем именно ту кампанию, которую сами остановили
 * строкой выше.
 */
async function handleRestartJob(job: { id: string; campaign_id: string }) {
  // handleStopJob закрыл клиенты и попросил цикл выйти; ждать его выхода не
  // нужно и здесь — новый прогон всё равно упрётся в проверку живого тела в
  // раннере и дождётся там, вне опроса команд.
  await handleStopJob(job);
  const { error } = await db
    .from('tg_outreach_campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', job.campaign_id)
    .eq('status', 'stopped');
  if (error) log('error', `Не смог перезапустить кампанию ${job.campaign_id}: ${error.message}`);
  else log('info', `Restart requested for campaign ${job.campaign_id} — кампанию подхватит раннер аренды`);
}

async function handleRefetchJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  /*
   * Догрузка переписок — третий путь, открывающий те же сессии Telegram.
   *
   * Она строит свой набор клиентов, ни на что не глядя, и от этого её нужно
   * держать так же, как второй запуск кампании: маршрут отказывает, пока
   * кампания числится запущенной, но статус `stopped` пишется ДО того, как
   * цикл вышел, а ожидание тела ограничено. То есть тело, пережившее потолок,
   * всё ещё держит сессии в тот момент, когда догрузка к ним подключается —
   * и это тот же AUTH_KEY_DUPLICATED, только с другой стороны.
   */
  const previousBody = campaignBodies.get(campaignId);
  if (previousBody) {
    log('warn', `Refetch ${campaignId}: цикл кампании ещё не вышел — прошу его закончить и жду`);
    const handedOver = await handOverCampaign(campaignId, previousBody);
    if (!handedOver) {
      const msg = 'Цикл кампании ещё работает и держит сессии Telegram. Догрузка переписок открыла бы те же сессии вторыми — это выключает аккаунты. Остановите кампанию и повторите через минуту.';
      log('error', `Refetch ${campaignId}: ${msg}`);
      await db.from('tg_outreach_jobs').update({
        status: 'failed',
        error_message: msg,
        finished_at: new Date().toISOString(),
      }).eq('id', job.id);
      return;
    }
  }

  log('info', `Refetch messages for campaign ${campaignId}`);

  try {
    await refetchEmptyDialogs(campaignId, db, undefined, async (p) => {
      await db.from('tg_outreach_jobs').update({ progress: p }).eq('id', job.id);
    });
    await db.from('tg_outreach_jobs').update({
      status: 'completed',
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('error', `Refetch failed for ${campaignId}: ${errMsg}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: errMsg,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

/**
 * Прогрев на едином жизненном цикле задач (lib/jobs/lifecycle.ts).
 *
 * Единица работы — СТРОКА ПРОГОНА `tg_outreach_warmup_runs`, а не команда в
 * очереди: прогон идёт четверо суток, его состояние намеренно живёт в базе
 * (день считается от started_at, у каждой переписки свой статус, сообщения
 * пишутся по ходу), и он заведомо переживает процесс. Раньше это выражалось
 * командой «warmup_start», которая висела в статусе «выполняется» всё время
 * прогона и требовала отдельных сторожей — сироты, возобновление при старте,
 * закрытие зависших. Теперь брошенный прогон — это истёкшая аренда, и ничего
 * больше.
 *
 * Взаимное исключение с боевым аутричем держит не карта в памяти, а статус
 * кампании: греющаяся стоит в `warming`, боевая — в `running`. Развёрнуто — в
 * комментарии к проверке в lib/tgOutreach/warmup/loop.ts.
 */
const warmupRunner = createJobRunner<{ id: string; campaign_id: string }, WarmupCheckpoint>({
  table: 'tg_outreach_warmup_runs',
  workerId: WORKER_ID,
  // Статусы — из check-констрейнта таблицы (20260803_0006):
  // pending / running / finished / stopped / failed. Терминал успеха здесь
  // называется `finished`, а не `done`.
  statuses: { pending: 'pending', running: 'running', done: 'finished', failed: 'failed' },
  leaseSeconds: WARMUP_LEASE_SECONDS,
  concurrency: WARMUP_MAX_CONCURRENCY,
  /*
   * Бюджет потерь — десять, а не три по умолчанию.
   *
   * Дефолт рассчитан на задачу, которая идёт минуты и после каждого шага
   * пишет чекпойнт. Прогон идёт ЧЕТВЕРО СУТОК, а чекпойнты у него привязаны к
   * событиям, а не к часам: их пишет каждая переписка и смена дня. Ночью
   * (sleep_periods, по умолчанию 00:00-08:00) переписок нет вовсе — то есть
   * восемь часов подряд ни одного чекпойнта, и любая потеря в этом окне
   * копится в счётчик, ничем не обнуляясь. Три деплоя за такую ночь, три
   * жёстких остановки контейнера или три срабатывания сторожа простоя — и
   * прогон уходил бы в `failed` посреди третьего дня.
   *
   * Цена такой ошибки была не «переделать работу», а тупик: до правки
   * библиотечный `failed` не возвращал кампанию из статуса `warming`, и она
   * переставала принимать и запуск, и остановку, и удаление прогрева — все три
   * маршрута отвечали 409. Тупик закрыт с двух сторон: releaseCampaignsStuck
   * InWarming ниже расклинивает кампанию, а этот бюджет делает саму ситуацию
   * редкой. Десять — это заведомо больше, чем деплоев и рестартов бывает за
   * одну ночь, и всё ещё конечное число: безнадёжно битый прогон, падающий
   * сразу после захвата, остановится, а не будет крутиться вечно.
   */
  maxAttempts: 10,
  // Итог пишет тело: только оно умеет отличить «прогрев доиграл все дни» от
  // «подключились не все аккаунты» и собрать сводку по аккаунтам в summary.
  manageTerminalStatus: false,
  select: 'campaign_id',
  /*
   * claimPatch НЕТ, и это важно. Единственная отметка «когда началось» в этой
   * таблице — started_at, но она не диагностическая: от неё считается ДЕНЬ
   * ПРОГРЕВА (dayNumber в warmup/loop.ts). Проставить её на каждом захвате
   * значило бы откатывать прогрев в первый день при каждом перехвате строки —
   * четырёхдневный прогон никогда бы не закончился, а нагрузка навсегда
   * осталась бы на уровне первого дня. Первую установку делает само тело, и
   * ровно один раз, при пустом started_at.
   */
  /*
   * progress НЕ подключаем — сознательно, и вот арифметика.
   *
   * Кандидат в этой таблице ровно один — current_day, и он двигается раз в
   * сутки: как детектор зависания это бесполезно (порог пришлось бы ставить
   * больше суток). Других скалярных колонок, которые двигались бы по ходу
   * работы, у строки прогона нет: счётчики переписок и сообщений живут в
   * tg_outreach_warmup_conversations, отдельными строками, а checkpoint —
   * jsonb, и библиотека такие колонки прямо запрещает (сравнение по !== на
   * каждый раз новом объекте всегда даёт «движение» и молча выключает и
   * детектор простоя, и предел попыток).
   *
   * Даже будь такая колонка, порога не существует. Снизу его ограничивает
   * самый длинный ЗАКОННЫЙ простой прогрева, а он огромен по устройству:
   *  - ночью аккаунты молчат — sleep_periods по умолчанию «00:00-08:00», то
   *    есть 8 часов подряд без единой переписки;
   *  - переписки дня раскиданы случайно по активному окну (16 часов), а в
   *    первый день их всего 2 на аккаунт: между двумя соседними законно
   *    проходят часы.
   * Порог обязан быть больше 8 часов. Сверху его никто не ограничивает
   * жёстко: JobMonitorSpec для tg_outreach_warmup_runs в
   * services/health-check/main.py НЕТ (проверено — в списке спецификаций этой
   * таблицы нет вовсе, и это записано там отдельным комментарием с той же
   * арифметикой; боевые кампании, в отличие от прогрева, спецификацию с
   * собственным порогом 45 мин получили — им есть что двигать раз в минуту).
   * Значит верхняя граница — суждение,
   * и суждение такое: смысл детектор имеет, только если срабатывает быстрее,
   * чем человек сам увидит остановившийся прогрев на вкладке «Прогрев», то
   * есть в пределах суток. Порога, который одновременно больше 8 часов и
   * заметно меньше 24, нет.
   *
   * Что защищает вместо progress: мёртвый процесс аренду не продлевает —
   * прогон подберут через ≤ WARMUP_LEASE_SECONDS; зависшее тело в живом
   * процессе отдаёт строку на ближайшем деплое, когда shutdown() обнулит
   * аренду; а собственный сторож воркера продолжает следить за прогревом по
   * отметкам onProgress ровно как раньше.
   */
  /*
   * Весь бюджет остановки: 10 секунд.
   *
   * Бюджет. Деплой останавливает контейнер `docker compose stop --timeout 15`,
   * то есть до SIGKILL пятнадцать секунд. В эти десять библиотека укладывает
   * два прохода освобождения аренды с паузой в секунду и контрольное чтение
   * (около трёх), остаток — около семи — достаётся телу. Телу на выход нужно
   * заметно меньше: паузы рвутся сигналом (abortableSleep, interruptibleSleep
   * с шагом 2 с), сетевые вызовы — тоже, а дальше остаётся сохранить ключи
   * сессий и закрыть до дюжины клиентов gramJS. Пять секунд деплоя остаются в
   * резерве.
   *
   * Чего эти секунды НЕ дают: аренду библиотека отпускает ДО ожидания тела, то
   * есть в эти секунды строка формально свободна, а клиенты Telegram ещё живы.
   * Порядок «сначала закрыть клиенты, потом отпустить аренду» библиотека теперь
   * умеет — это опция beforeRelease, — но прогрев её намеренно НЕ включает:
   * контейнер tg-outreach на проде один, деплой сначала останавливает старый и
   * только потом поднимает новый, а хук означал бы разрыв сокетов на каждом
   * деплое вместо аккуратного выхода цикла. Боевому аутричу с его дюжиной
   * сессий на кампанию она нужна по-настоящему — там её и включает задача 4,
   * замерив реальное время закрытия клиентов.
   */
  shutdownGraceMs: 10_000,
  failedPatch: (reason) => ({ error_message: reason, finished_at: new Date().toISOString() }),
  log,
  run: async (job, ctx) => {
    const campaignId = job.campaign_id;
    log('info', `Starting warmup run ${job.id} for campaign ${campaignId}`);

    // Сторож простоя воркера следит за прогревом ровно как за кампанией:
    // ключом остаётся campaign_id, потому что forceDisconnect и stop() у него
    // тоже по кампании.
    warmupLastProgressAt.set(campaignId, Date.now());
    const onProgress = () => { warmupLastProgressAt.set(campaignId, Date.now()); };
    const control: LoopControl = {};
    // Своя карта, не общая с боевыми кампаниями: ключ у обеих один
    // (campaign_id), и общая карта позволяла опоздавшему прогревному телу
    // стереть ручку уже запущенного аутрича — см. комментарий к warmupControls.
    warmupControls.set(campaignId, control);
    // Ручка сторожа: он гасит зависший прогрев теми же двумя движениями, что и
    // кампанию, — просит остановиться и рвёт сокеты. Выйдя, тело вернёт
    // управление раннеру, а аренду отпустит блок ниже, и прогон подберут
    // заново — это и есть замена прежнему «auto-resume поднимет».
    let stopRequested = false;
    const warmupStop = () => { stopRequested = true; };
    warmupStops.set(campaignId, warmupStop);
    warmupWaitLogged.delete(job.id);

    try {
      await runWarmupLoop(
        campaignId,
        db,
        () => ctx.shouldStop() || stopRequested,
        onProgress,
        control,
        { runId: job.id, signal: ctx.signal, runToken: ctx.runToken, saveCheckpoint: ctx.saveCheckpoint },
      );
      log('info', `Warmup run ${job.id} (campaign ${campaignId}) returned`);

      /*
       * Прогрев вышел по требованию сторожа — аренду отпускаем сами, руками.
       *
       * Библиотека этого не сделает и не может: ctx.signal здесь НЕ взведён
       * (сторож — наш локальный механизм, а не остановка процесса и не потеря
       * аренды), поэтому она идёт успешным путём, а снятие владения на нём
       * ограждено `status <> running` — строка осталась running, и запись не
       * находит ни одной строки. Результат без этого блока: продление уже
       * остановлено, а lease_until стоит в будущем, то есть до полной аренды
       * мёртвого времени, после которого перехват видит НЕПУСТУЮ аренду,
       * считает её потерянной и списывает попытку. Ровно те попытки, из-за
       * которых прогон и уходил в тупик (см. maxAttempts выше).
       *
       * Обнуление аренды — то же самое, что делает shutdown() при штатной
       * передаче: строка сразу свободна, а потерей не считается. Ограждаем
       * жетоном и статусом, чтобы не тронуть строку, которую тем временем
       * закрыло само тело (finished/failed) или перехватил сосед.
       */
      if (stopRequested && !ctx.signal.aborted) {
        const { error } = await db
          .from('tg_outreach_warmup_runs')
          .update({ lease_until: null })
          .eq('id', job.id)
          .eq('status', 'running')
          .eq('run_token', ctx.runToken);
        if (error) {
          log('error', `Не смог отпустить аренду прогона ${job.id} после остановки сторожем: ${error.message}`);
        } else {
          log('info', `Warmup run ${job.id} stopped by watchdog — lease released for immediate reclaim`);
        }
      }
    } catch (err) {
      // Терминальный статус пишет тело — в том числе на отказе, иначе прогон
      // остался бы в running до истечения аренды и был бы перехвачен как
      // падение. На остановке статус не трогаем: строка либо уже не наша, либо
      // отдаётся соседу, и ограждение по жетону такую запись не пропустит.
      if (ctx.signal.aborted) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      log('error', `Warmup run ${job.id} (campaign ${campaignId}) crashed: ${errMsg}`);
      await db
        .from('tg_outreach_warmup_runs')
        .update({
          status: 'failed',
          error_message: errMsg.slice(0, 500),
          finished_at: new Date().toISOString(),
          // Владение снимаем вместе со статусом — как это делает библиотека в
          // своей терминальной записи (clearOwnership в lib/jobs/lifecycle.ts).
          lease_until: null,
          run_token: null,
          worker_id: null,
        })
        .eq('id', job.id)
        .eq('run_token', ctx.runToken);
      // Иначе кампания застрянет в статусе «прогрев», из которого нельзя
      // запустить аутрич.
      await db
        .from('tg_outreach_campaigns')
        .update({ status: 'stopped', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('status', 'warming');
    } finally {
      // Только своё: прогон этой же кампании мог начаться заново, и стирать его
      // ручки нельзя (то же правило, что в forgetCampaign).
      forgetIfOwn(warmupStops, campaignId, warmupStop);
      forgetIfOwn(warmupControls, campaignId, control);
      warmupLastProgressAt.delete(campaignId);
      warmupKillRequestedAt.delete(campaignId);
    }
  },
});

/**
 * Команда «запустить прогрев» — теперь только подтверждение.
 *
 * Работу запускает не она, а сама строка прогона: интерфейс создаёт её в
 * статусе `pending`, и раннер выше подхватывает её на ближайшем опросе (а
 * realtime будит опрос сразу). Команду закрываем немедленно, чтобы она не
 * висела в «выполняется» и не путала ни сторожа сирот, ни человека.
 */
async function handleWarmupStartJob(job: { id: string; campaign_id: string }) {
  log('info', `Warmup start requested for campaign ${job.campaign_id} — прогон подхватит раннер аренды`);
  await db
    .from('tg_outreach_jobs')
    .update({ status: 'completed', finished_at: new Date().toISOString() })
    .eq('id', job.id);
}

async function handleWarmupStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  /*
   * Остановка — это запись в строку прогона, а не сигнал в память процесса.
   *
   * Владение снимаем тем же движением, что и статус: строка перестаёт быть
   * арендованной, и любая запоздалая запись уходящего тела не пройдёт
   * ограждение по жетону. Исполнитель узнает об остановке двумя путями сразу —
   * его продление аренды перестанет находить строку в `running` (≤ треть
   * аренды, 60 с) и цикл перечитает активный прогон на ближайшем круге
   * (≤ 60 с). Ждать конца цикла здесь, как раньше, больше нельзя и не нужно:
   * тело может идти в другой реплике.
   */
  await db
    .from('tg_outreach_warmup_runs')
    .update({
      status: 'stopped',
      finished_at: new Date().toISOString(),
      lease_until: null,
      run_token: null,
      worker_id: null,
    })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'running']);
  log('info', `Warmup stop recorded for campaign ${campaignId}`);

  // Возвращаем кампанию в «остановлена»: прогрев кончился, аутрич снова можно
  // запустить. Условие на warming — чтобы не затереть статус, если кампанию
  // тем временем уже перевели во что-то другое.
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('status', 'warming');

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function dispatchJob(job: { id: string; campaign_id: string; action: string }): Promise<void> {
  log('info', `Claimed job ${job.id}: ${job.action} for campaign ${job.campaign_id}`);
  try {
    switch (job.action) {
      case 'start':
        await handleStartJob(job);
        break;
      case 'stop':
        await handleStopJob(job);
        break;
      case 'restart':
        await handleRestartJob(job);
        break;
      case 'refetch_messages':
        await handleRefetchJob(job);
        break;
      case 'warmup_start':
        await handleWarmupStartJob(job);
        break;
      case 'warmup_stop':
        await handleWarmupStopJob(job);
        break;
      default:
        log('warn', `Unknown action: ${job.action}`);
        await db.from('tg_outreach_jobs').update({
          status: 'failed',
          error_message: `Unknown action: ${job.action}`,
          finished_at: new Date().toISOString(),
        }).eq('id', job.id);
    }
  } catch (err) {
    log('error', `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

/**
 * Сказать ожидающим прогонам, что они стоят в очереди за слотом.
 *
 * Без этой строки ожидание невидимо и выглядит поломкой: кнопка «Прогрев»
 * сразу переводит кампанию в статус «Прогрев», а работа не начинается — при
 * этом запуск аутрича и остановка кампании в этом статусе отвечают 409. Человек
 * видит замерший экран и никакого объяснения. Пишем в журнал самого прогона,
 * то есть ровно туда, куда оператор и смотрит, — на вкладку «Прогрев».
 */
async function logWarmupRunsWaitingForSlot(active: number): Promise<void> {
  const { data, error } = await db
    .from('tg_outreach_warmup_runs')
    .select('id, campaign_id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5);
  if (error || !data?.length) return;

  for (const run of data as Array<{ id: string; campaign_id: string }>) {
    if (warmupWaitLogged.has(run.id)) continue;
    warmupWaitLogged.add(run.id);
    await db.from('tg_outreach_warmup_logs').insert({
      run_id: run.id,
      campaign_id: run.campaign_id,
      level: 'info',
      message:
        `Прогрев в очереди: сейчас идёт ${active} из ${WARMUP_MAX_CONCURRENCY} одновременных прогревов. ` +
        'Этот начнётся сам, как только освободится место — останавливать и запускать заново не нужно.',
    });
  }
}

async function pollJobsOnce(): Promise<boolean> {
  // Сначала команды управления (stop/restart/refetch): они не занимают слот
  // раннера, а «стоп» даже освобождает его. Ждать свободного слота перед
  // остановкой нельзя — оператор не смог бы выключить ничего, когда все слоты
  // заняты (инцидент 29.07.2026).
  const controlJob = await claimJob(CONTROL_ACTIONS);
  if (controlJob) {
    await dispatchJob(controlJob);
    return true;
  }

  // Команды «старт» больше не занимают слот: они ничего не запускают, а только
  // подтверждают решение оператора. Работу берёт раннер по строке кампании,
  // и предел одновременных кампаний проверяет он (и pollOnce ниже).
  const startJob = await claimJob(START_ACTIONS);
  if (!startJob) return false;

  await dispatchJob(startJob);
  return true;
}

export async function pollOnce(): Promise<boolean> {
  const claimedJob = await pollJobsOnce();

  /*
   * Боевые кампании: занятость слотов проверяем ДО обращения к раннеру.
   *
   * Его собственная проверка при занятых слотах отвечает «зови снова» после
   * паузы в 500 мс, а pollLoop на такой ответ свой интервал не выжидает — круг
   * замкнулся бы сразу, и всё время работы кампаний воркер стучал бы в базу по
   * два запроса за полсекунды (яма разобрана в worker/salesChatLogger.ts).
   */
  const campaignsActive = campaignRunner.activeJobIds().length;
  const claimedCampaign = campaignsActive >= CAMPAIGN_MAX_CONCURRENCY
    ? false
    : await campaignRunner.pollOnce();

  /*
   * Прогрев опрашивается своей очередью и своим пределом параллелизма: общий
   * пул слотов боевых кампаний ему больше не нужен.
   *
   * Занятый слот проверяем ДО обращения к раннеру, а не полагаемся на его
   * внутреннюю проверку. Она при занятых слотах отвечает «зови снова» после
   * паузы в 500 мс, а pollLoop на такой ответ свой интервал не выжидает — круг
   * замкнулся бы сразу, и все четверо суток прогрева воркер стучал бы в базу
   * по два запроса за полсекунды (та же яма, что разобрана в
   * worker/salesChatLogger.ts). Пока слот занят, брать нечего, и честный ответ
   * «нет работы» отправляет цикл спать до realtime или до 30-секундного
   * запасного тика.
   */
  const warmupActive = warmupRunner.activeJobIds().length;
  const warmupBusy = warmupActive >= WARMUP_MAX_CONCURRENCY;
  if (warmupBusy) {
    // Тот же запрос, что сделал бы захват, но с честным ответом человеку
    // вместо молчания. Идёт раз в 30 секунд (опрос спит на fallback-тике), и
    // пишет в журнал один раз на прогон.
    await logWarmupRunsWaitingForSlot(warmupActive);
  }
  const claimedWarmup = warmupBusy ? false : await warmupRunner.pollOnce();

  return claimedJob || claimedCampaign || claimedWarmup;
}

/*
 * Возобновления кампаний при старте здесь БОЛЬШЕ НЕТ.
 *
 * Прежняя resumeRunningCampaigns при каждом подъёме процесса (и раз в пять
 * минут) делала три вещи: переводила все `error` в `paused`, все `paused` — в
 * `running`, и каждой кампании подкладывала команду «старт». То есть любой
 * деплой воскрешал кампании, которые оператор остановил руками или которые
 * сама система погасила из-за ошибки конфигурации; отличить одно от другого
 * она не умела. Опиралась она на допущение «раз мы стартовали, значит прошлого
 * исполнителя нет» — на второй реплике это просто неправда, и тогда она
 * отбирала бы живую кампанию.
 *
 * Её роль взяла аренда: брошенная кампания — это строка `running` с истёкшим
 * или обнулённым lease_until, и её подбирает обычный захват раннера, одинаково
 * при любом числе реплик. Остановленная кампания остаётся остановленной,
 * поставленная на паузу — на паузе, до кнопки оператора.
 */

/*
 * Возобновления прогревов при старте здесь БОЛЬШЕ НЕТ.
 *
 * Прежняя resumeWarmupRuns при каждом подъёме процесса (и раз в пять минут)
 * искала прогоны в pending/running и подкладывала им команду «warmup_start».
 * Ей на смену пришла аренда: брошенный прогон — это строка `running` с
 * истёкшим или обнулённым lease_until, и её подбирает обычный захват раннера,
 * работающий одинаково при любом числе реплик. Прежняя же схема опиралась на
 * «раз мы стартовали, значит прошлого исполнителя нет» — на второй реплике это
 * неправда, и она отобрала бы живой прогон.
 */

/**
 * Расклинить кампании, застрявшие в статусе «Прогрев» без живого прогона.
 *
 * Статус `warming` — это замок: пока он стоит, интерфейс отвечает 409 на всё
 * сразу. Запуск аутрича — «Кампания на прогреве», остановка кампании — «идёт
 * прогрев, останавливайте на вкладке Прогрев», остановка прогрева — «Активного
 * прогрева нет», потому что прогона в pending/running действительно уже нет.
 * Единственным выходом оставалось запустить новый прогрев, чтобы тут же его
 * остановить.
 *
 * Снять замок обязано всё, что закрывает прогон, — и тело прогрева это делает.
 * Но есть путь, на котором тела нет вовсе: библиотека сама пишет `failed`,
 * когда исполнитель терял прогон maxAttempts раз подряд. Она про кампанию не
 * знает и знать не должна — значит, ключ от замка нужен снаружи.
 *
 * Условие простое и не может задеть живое: у кампании статус `warming`, а
 * прогона в pending/running нет ни одного. Гонки с запуском нет — интерфейс
 * сначала создаёт строку прогона, и только потом ставит кампании `warming`.
 */
export async function releaseCampaignsStuckInWarming(): Promise<void> {
  const { data: warming, error } = await db
    .from('tg_outreach_campaigns')
    .select('id')
    .eq('status', 'warming');
  if (error) {
    log('error', `Не смог проверить кампании в статусе прогрева: ${error.message}`);
    return;
  }
  const ids = ((warming ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (!ids.length) return;

  const { data: activeRuns, error: runsError } = await db
    .from('tg_outreach_warmup_runs')
    .select('campaign_id')
    .in('campaign_id', ids)
    .in('status', ['pending', 'running']);
  if (runsError) {
    log('error', `Не смог проверить активные прогоны прогрева: ${runsError.message}`);
    return;
  }

  const alive = new Set(
    ((activeRuns ?? []) as Array<{ campaign_id: string }>).map((r) => r.campaign_id),
  );
  const stuck = ids.filter((id) => !alive.has(id));
  if (!stuck.length) return;

  log(
    'warn',
    `Кампании в статусе «Прогрев» без активного прогона: ${stuck.join(', ')}. Возвращаю в «остановлена» — иначе их нельзя ни запустить, ни остановить.`,
  );
  const { error: updError } = await db
    .from('tg_outreach_campaigns')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .in('id', stuck)
    // Ещё раз по статусу: между двумя запросами кампанию могли перевести
    // куда-то ещё, и затирать чужое решение нечем.
    .eq('status', 'warming');
  if (updError) {
    log('error', `Не смог расклинить кампании из статуса прогрева: ${updError.message}`);
  }
}

const RESUME_CHECK_INTERVAL_MS = 5 * 60_000;

async function main() {
  log(
    'info',
    `TG Outreach worker starting... (кампании: аренда ${CAMPAIGN_LEASE_SECONDS}s, порог простоя ${Math.round(CAMPAIGN_STALL_MS / 60_000)} мин, слотов ${CAMPAIGN_MAX_CONCURRENCY}; ` +
      `прогрев: аренда ${WARMUP_LEASE_SECONDS}s, слотов ${WARMUP_MAX_CONCURRENCY})`,
  );
  await resetStuckJobs();
  await releaseCampaignsStuckInWarming();

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: shutdown() ставит
      // флаг и сам, но полагаться на то, что он успеет до первого await внутри
      // библиотеки, нельзя — флаг читают из другого модуля. Вызов
      // идемпотентный, флаг односторонний — лишним он быть не может.
      markShuttingDown();
      log('info', `${sig} received — закрываю клиенты Telegram и отпускаю аренды`);
      /*
       * Оба раннера останавливаются ПАРАЛЛЕЛЬНО, и это осознанно.
       *
       * Последовательно было бы 12 секунд бюджета кампаний плюс 10 прогрева —
       * 22 секунды, а деплой даёт пятнадцать (`docker compose stop --timeout
       * 15`), и аренду прогрева отпускал бы уже SIGKILL, то есть никто.
       * Параллельно общий срок равен большему из двух, 12 секундам, и в
       * пятнадцать укладывается с запасом. Мешать друг другу им нечем: у
       * каждого свои строки, свои клиенты и свои карты ручек.
       */
      void campaignRunner.shutdown().catch((err) => log('error', 'campaign shutdown failed', err));
      void warmupRunner.shutdown().catch((err) => log('error', 'warmup shutdown failed', err));
    });
  }

  // Independent heartbeat ticker keeps the docker healthcheck green as long
  // as the Node event loop is alive: если событийный цикл процесса умрёт
  // целиком, файл протухнет и autoheal перезапустит контейнер. Зависание
  // ОТДЕЛЬНОЙ кампании этим не ловится — для него есть порог простоя аренды.
  writeHeartbeat();
  const heartbeatTimer = setInterval(() => writeHeartbeat(), 30_000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  /**
   * Прогревы, признанные безнадёжно зависшими.
   *
   * Живут до конца жизни процесса и до тех пор, пока цикл прогрева не уйдёт из
   * реестра сам (тогда карантин снимается в staleKillRequests). Набор мал по
   * определению — больше, чем прогревов в работе, в нём быть не может.
   */
  const warmupQuarantined = new Set<string>();

  /*
   * Сторож простоя — теперь ТОЛЬКО за прогревом.
   *
   * Боевые кампании из него вышли: их простой ловит колонка `progress_at` под
   * арендой, и это строго лучше — зависшую кампанию не изолируют до
   * перезапуска воркера, а отдают следующему владельцу, который продолжит её с
   * чекпойнта. Держать оба механизма было нельзя: сторож при общем зависании
   * ронял процесс, а падение процесса — это чужие аренды, у здоровых соседей
   * lease_until остался бы живым, и следующий владелец ждал бы их полный срок,
   * записав это как падение с тратой попытки.
   *
   * Прогреву замена не подходит: у прогона нет колонки, которая двигалась бы в
   * пределах часов (законная ночная пауза — восемь часов), и порог для него
   * поставить не из чего. Поэтому здесь всё как было: молчит дольше порога —
   * просим остановиться и рвём сокеты; не помогло за отведённое время —
   * изолируем и живём дальше.
   */
  const watchdogTimer = setInterval(() => {
    if (shouldStop()) return;
    const now = Date.now();
    const snapshot = {
      now,
      lastProgressAt: warmupLastProgressAt,
      killRequestedAt: warmupKillRequestedAt,
      running: new Set(warmupStops.keys()),
      quarantined: warmupQuarantined,
      stallMs: WATCHDOG_THRESHOLD_MS,
      graceMs: WATCHDOG_KILL_GRACE_MS,
    };

    for (const campaignId of staleKillRequests(snapshot)) {
      warmupKillRequestedAt.delete(campaignId);
      // Цикл размотался — прогон отпустит аренду и будет подобран заново.
      if (warmupQuarantined.delete(campaignId)) {
        log('info', `Watchdog: прогрев кампании ${campaignId} размотался — карантин снят, прогон подберут по аренде.`);
      }
    }

    for (const { campaignId, action, stallMin } of planWatchdogActions(snapshot)) {
      if (action === 'quarantine') {
        /**
         * Прогрев не разбудить — изолируем и живём дальше.
         *
         * Отправлять он ничего не будет: шаг `kill` уже выставил ему stop(), и
         * когда зависший await разомкнётся, цикл выйдет на первой проверке.
         * Двойника не появится: строка прогона остаётся арендованной этим
         * процессом, и захват её не тронет.
         *
         * Цена — один занятый слот прогрева до перезапуска воркера.
         */
        warmupQuarantined.add(campaignId);
        log(
          'error',
          `Watchdog: прогрев кампании ${campaignId} молчит ${stallMin} мин и пережил разрыв сокетов ` +
            `(${Math.round(WATCHDOG_KILL_GRACE_MS / 60_000)} мин). Изолирую его: остальная работа продолжается. ` +
            'Прогон не поднимется сам — нужен перезапуск воркера в удобное время.',
        );
        continue;
      }

      // Гасим один прогон: просим остановиться и рвём его сокеты, чтобы
      // разбудить зависший await. Выйдя, тело отпустит аренду, и прогон
      // подберут заново — это и есть замена прежнему «auto-resume поднимет».
      log(
        'error',
        `Watchdog: прогрев кампании ${campaignId} не отчитывается ${stallMin} мин ` +
          `(порог ${Math.round(WATCHDOG_THRESHOLD_MS / 60_000)} мин). Останавливаю только его.`,
      );
      warmupKillRequestedAt.set(campaignId, now);
      try {
        warmupStops.get(campaignId)?.();
      } catch (err) {
        log('error', `Watchdog: stop() failed for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      void warmupControls
        .get(campaignId)
        ?.forceDisconnect?.()
        .catch((err: unknown) => {
          log(
            'error',
            `Watchdog: force-disconnect failed for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

  /*
   * Периодическая проверка осталась одна: замок `warming`.
   *
   * Сторожа сирот и авто-резюма здесь больше нет — их роль взяла аренда
   * (см. комментарии выше). А замок снимать надо и на ходу: библиотека пишет
   * `failed` прогону в работающем процессе, и ждать перезапуска ради
   * расклинивания кампании — это до следующего деплоя.
   */
  const resumeTimer = setInterval(() => {
    if (shouldStop()) return;
    releaseCampaignsStuckInWarming().catch((err) =>
      log('error', `Проверка застрявших в прогреве кампаний упала: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, RESUME_CHECK_INTERVAL_MS);

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    // Строки кампаний в этот список не входят намеренно: realtime будит опрос
    // только по status=eq.pending (pollLoop в worker/_shared.ts), а такого
    // статуса в tg_outreach_campaigns нет и быть не может. Запуск всё равно
    // доходит мгновенно — интерфейс рядом со сменой статуса кладёт команду
    // «старт», и просыпаемся мы на ней. Перехват брошенной аренды идёт
    // запасным тиком раз в 30 секунд.
    realtimeTables: ['tg_outreach_jobs', 'tg_outreach_warmup_runs'],
  });

  clearInterval(heartbeatTimer);
  clearInterval(watchdogTimer);
  clearInterval(resumeTimer);

  // Оба вызова идемпотентны и возвращают тот же промис, что уже запустил
  // обработчик сигнала, — то есть здесь мы дожидаемся уже идущих параллельно
  // остановок, а не запускаем их одну за другой.
  await Promise.all([campaignRunner.shutdown(), warmupRunner.shutdown()]);

  log('info', 'TG Outreach worker stopped');
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
