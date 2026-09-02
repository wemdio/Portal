import { createWorkerLogger, requireSupabaseAdmin, pollLoop } from './_shared';
import { runCampaignLoop } from '@/lib/ai-caller/campaignLoop';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown, isShuttingDown } from '@/lib/workerShutdown';

const WORKER_ID = `ai-caller-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;

/**
 * Сколько кампаний обзвона воркер ведёт одновременно.
 *
 * Число прежнее — три. Раньше это был предел карты `runningCampaigns` в памяти,
 * теперь — предел раннера аренды; смысл тот же, и менять его вместе с
 * механизмом было бы нечестно: пропускную способность обзвона задаёт не он, а
 * лимиты провайдера на исходящие линии.
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.AI_CALLER_MAX_CONCURRENCY ?? '3'));

/**
 * Аренда строки кампании — признак живости ПРОЦЕССА.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок короткий:
 * 180 с ≈ три пропущенных продления. После краха/OOM/SIGKILL кампанию подберут
 * через аренду (3 мин) + один опрос соседа (30 с) ≈ 3,5 минуты. Чистая
 * остановка (деплой) обнуляет аренду сразу и порога не ждёт.
 *
 * До этого перевода у обзвона не было ни healthcheck, ни autoheal, ни сторожа:
 * зависший процесс не замечал никто, и кампания стояла до тех пор, пока человек
 * не открывал вкладку. Аренда — первый признак жизни у этого воркера вообще.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.AI_CALLER_LEASE_SECONDS ?? '180'));

/**
 * Порог простоя по колонке прогресса `called_contacts` — 20 минут.
 *
 * Арифметика снизу. Между двумя инкрементами счётчика законно проходит:
 * ожидание конца звонка (потолок 120 с) + запись итога + пауза перед следующим
 * (5–15 с) + перечитывание статуса и захват контакта. То есть здоровый цикл
 * двигает счётчик минимум раз в ~2,5 минуты. Отдельно бывают серии контактов
 * БЕЗ инкремента: битый номер отбрасывается мгновенно, а вот контакт, на
 * котором провайдер трижды отвечает ошибкой, стоит ~10 секунд. Сотня таких
 * подряд — это 17 минут честной работы без движения счётчика; порог обязан
 * быть выше, иначе исправная кампания теряла бы аренду на плохом участке базы.
 *
 * Арифметика сверху. Спецификации мониторинга у `ai_campaigns` нет: в
 * services/health-check/main.py таблица входит только в счётчик количества
 * (_JOB_TABLES), обнаружения зависаний для неё нет вовсе — это и есть довод за
 * то, чтобы порог здесь был. Значит верхнюю границу задаёт здравый смысл:
 * порог (20 мин) + одна аренда (3 мин, после прерывания она не отпускается, а
 * истекает сама) + один опрос соседа (30 с) = 23,5 минуты до перезапуска
 * кампании другой репликой. Для очереди, где один звонок длится минуты, это
 * заметно быстрее, чем человек сам увидит замерший счётчик на экране.
 */
const STALL_MS = Math.max(60_000, Number(process.env.AI_CALLER_STALL_MS ?? String(20 * 60_000)));

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);

/**
 * В этой таблице НЕТ отдельного статуса «ожидает исполнителя».
 *
 * Check-констрейнт `ai_campaigns` (миграция 20260325_0000) знает четыре
 * значения: draft / running / paused / completed. Кнопка «Запустить» сразу
 * пишет `running` — то есть очередь здесь выражена не статусом, а ОТСУТСТВИЕМ
 * аренды: строка `running` без живого lease_until и есть «ждёт исполнителя», и
 * забирает её путь перехвата истёкшей аренды.
 *
 * Библиотеке при этом нужно какое-то значение под pending. Даём заведомо
 * невозможное: check-констрейнт гарантирует, что строк с ним нет, поэтому
 * запрос кандидата всегда пуст, а CAS `where status = <это>` не совпадёт ни с
 * одной строкой и записать его в базу физически не может. Подставить сюда
 * реальный статус нельзя ни один: `draft` — это загруженная, но не запущенная
 * человеком кампания, `running` — уже работающая (её отбирали бы, не глядя на
 * аренду, и уводили у живого исполнителя), `completed`/`paused` — законченные.
 */
const NO_PENDING_STATUS = 'never-pending';

/**
 * Раннер кампании обзвона на едином жизненном цикле задач
 * (app/src/lib/jobs/lifecycle.ts).
 *
 * Единица работы — СТРОКА КАМПАНИИ `ai_campaigns`, а не команда в очереди.
 * `ai_caller_jobs` остаётся каналом воли оператора («старт», «стоп»), но больше
 * не держит команду «старт» в статусе «выполняется» всё время жизни кампании.
 */
const campaignRunner = createJobRunner<{ id: string; called_contacts: number }, unknown>({
  table: 'ai_campaigns',
  workerId: WORKER_ID,
  statuses: {
    pending: NO_PENDING_STATUS,
    running: 'running',
    // Терминалы из того же check-констрейнта. `done` библиотека не использует
    // (manageTerminalStatus: false — «завершено» пишет тело, когда контакты
    // кончились). `failed` она пишет сама, когда исполнитель терял кампанию
    // maxAttempts раз подряд, и статуса «ошибка» в этой таблице нет — поэтому
    // `paused`: интерфейс показывает у такой кампании кнопку «Запустить»
    // (CampaignsTab.tsx: draft|paused → Play), то есть тупика не возникает.
    done: 'completed',
    failed: 'paused',
  },
  leaseSeconds: LEASE_SECONDS,
  concurrency: MAX_CONCURRENCY,
  /*
   * Бюджет потерь — три, дефолтные, и этого достаточно.
   *
   * Прогрев Telegram пришлось поднимать до десяти, потому что его чекпойнты
   * событийные и ночью отсутствуют по восемь часов подряд. Здесь наоборот:
   * колонка прогресса `called_contacts` двигается на каждом созданном звонке,
   * то есть в норме раз в 2–3 минуты, и любое такое движение возвращает бюджет
   * в ноль (см. checkProgress в lib/jobs/lifecycle.ts). Чтобы дойти до предела,
   * нужно три грубых остановки подряд, между которыми кампания не сделала НИ
   * ОДНОГО звонка, — это уже не деплой, а сломанная кампания, и остановить её
   * правильно.
   */
  maxAttempts: 3,
  // Итог пишет тело: только оно знает, кончились ли контакты («завершено») или
  // кампанию остановил оператор (её статус трогать нельзя вовсе).
  manageTerminalStatus: false,
  // Колонка прогресса читается из захваченной строки как точка отсчёта —
  // иначе первый тик продления потратился бы на её засев.
  select: 'called_contacts',
  /*
   * claimPatch НЕТ, и это осознанно.
   *
   * Единственный кандидат в этой таблице — updated_at, и писать его на КАЖДОМ
   * захвате нельзя: перехват строки затирал бы отметку «когда кампанию трогали
   * в последний раз», по которой человек и отличает живую кампанию от забытой.
   * Колонки «когда начали» здесь нет вовсе, а ловушка с отметкой, которую
   * освежает сам механизм аренды, в этом проекте срабатывала уже трижды.
   */
  progress: { column: 'called_contacts', stalledAfterMs: STALL_MS },
  /*
   * Сколько ждать тело после сигнала: 8 секунд.
   *
   * Деплой останавливает контейнер `docker compose stop --timeout 15`. Из этих
   * пятнадцати библиотека тратит около трёх на два прохода освобождения аренды
   * с паузой в секунду и контрольное чтение. Телу нужно куда меньше: все паузы
   * прерываемые (sleep с сигналом), запросы к провайдеру уходят с тем же
   * сигналом, а после выхода из ожидания оно просто возвращается, ничего не
   * дописывая. Восемь секунд — с запасом, и остаётся резерв.
   */
  shutdownGraceMs: 8_000,
  log,
  run: async (job, ctx) => {
    log('info', `Starting campaign ${job.id}`);
    try {
      await runCampaignLoop(
        job.id,
        db,
        () => ctx.shouldStop(),
        (level, msg) => log(level, `[campaign:${job.id.slice(0, 8)}] ${msg}`),
        { signal: ctx.signal, runToken: ctx.runToken },
      );
      log('info', `Campaign ${job.id} loop finished`);
    } catch (err) {
      // На остановке статус не трогаем: строка либо уже не наша, либо отдаётся
      // соседу, и решение о ней принимает библиотека.
      if (ctx.signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `Campaign ${job.id} loop error: ${msg}`);
      /*
       * Настоящий сбой — кампания встаёт на паузу, как и до перевода.
       *
       * Отдать её на повторный захват было бы хуже: колонки для причины в
       * `ai_campaigns` нет, повторяющееся падение не увидел бы никто, а
       * освобождение аренды при manageTerminalStatus=false попыткой не
       * считается — кампания крутилась бы в цикле «захват-падение» вечно.
       * Пауза видна оператору и снимается одной кнопкой.
       */
      const { error } = await db
        .from('ai_campaigns')
        .update({
          status: 'paused',
          updated_at: new Date().toISOString(),
          // Владение снимаем вместе со статусом — как это делает библиотека в
          // своей терминальной записи (clearOwnership в lib/jobs/lifecycle.ts).
          lease_until: null,
          run_token: null,
          worker_id: null,
        })
        .eq('id', job.id)
        .eq('run_token', ctx.runToken);
      if (error) log('error', `Failed to pause ai campaign ${job.id}: ${error.message}`);
    }
  },
});

/**
 * Взять одну команду оператора из `ai_caller_jobs`.
 *
 * Захват переводит команду СРАЗУ в `completed`, минуя `running`. Так можно
 * именно теперь: обе команды стали мгновенными и, главное, необязательными —
 * «старт» ничего не запускает (кампанию подберёт раннер по её собственному
 * статусу), а «стоп» лишь подтверждает статус `paused`, который интерфейс уже
 * записал сам. Потерянная на полпути команда ничего не ломает.
 *
 * Что это убирает: окно, в котором команда висит в `running`. Раньше «старт»
 * жил в нём всё время работы кампании и требовал целого хозяйства — сброса
 * зависших джоб при старте процесса и сторожа сирот. Теперь окна нет вовсе, и
 * восстанавливать при старте нечего.
 */
async function claimCommand(): Promise<{ id: string; campaign_id: string; action: string } | null> {
  const { data: pending, error: selectError } = await db
    .from('ai_caller_jobs')
    .select('id, campaign_id, action')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    log('warn', `Не смог прочитать очередь команд: ${selectError.message}`);
    return null;
  }
  if (!pending) return null;

  const { data: claimed, error: casError } = await db
    .from('ai_caller_jobs')
    .update({ status: 'completed', started_at: new Date().toISOString(), finished_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, campaign_id, action')
    .maybeSingle();

  if (casError) {
    log('warn', `Не смог взять команду ${pending.id}: ${casError.message}`);
    return null;
  }
  return claimed ?? null;
}

async function dispatchCommand(job: { id: string; campaign_id: string; action: string }): Promise<void> {
  const campaignId = job.campaign_id;
  switch (job.action) {
    case 'start':
      // Работу запускает не команда, а сама строка кампании: интерфейс уже
      // записал ей status='running', и раннер подхватит её на ближайшем опросе.
      log('info', `Start requested for campaign ${campaignId} — кампанию подхватит раннер аренды`);
      break;
    case 'stop': {
      /*
       * Остановка — это запись в строку кампании, а не сигнал в память.
       *
       * Обычно эта запись НИЧЕГО НЕ НАХОДИТ, и так и задумано: интерфейс пишет
       * `paused` ещё до постановки команды, а условие ниже требует `running`.
       * Команда добивает только случай, когда статус по какой-то причине не
       * записался. Владение при остановке снимает не она, а сам исполнитель:
       * его продление аренды перестанет находить строку в `running` (≤ треть
       * аренды, 60 с), цикл перечитает статус на ближайшем круге и обнулит
       * lease_until/run_token/worker_id своей же терминальной записью
       * (см. ветку «статус изменился снаружи» в lib/ai-caller/campaignLoop.ts).
       * Ждать конца цикла здесь нельзя: тело может идти в другой реплике.
       */
      const { error } = await db
        .from('ai_campaigns')
        .update({
          status: 'paused',
          updated_at: new Date().toISOString(),
          lease_until: null,
          run_token: null,
          worker_id: null,
        })
        .eq('id', campaignId)
        .eq('status', 'running');
      if (error) log('error', `Не смог остановить кампанию ${campaignId}: ${error.message}`);
      else log('info', `Stop recorded for campaign ${campaignId}`);
      break;
    }
    default:
      log('warn', `Unknown action: ${job.action}`);
      await db
        .from('ai_caller_jobs')
        .update({ status: 'failed', error_message: `Unknown action: ${job.action}` })
        .eq('id', job.id);
  }
}

export async function pollOnce(): Promise<boolean> {
  let claimedCommand = false;
  const command = await claimCommand();
  if (command) {
    log('info', `Claimed command ${command.id}: ${command.action} for campaign ${command.campaign_id}`);
    try {
      await dispatchCommand(command);
    } catch (err) {
      log('error', `Command ${command.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    claimedCommand = true;
  }

  /*
   * Занятость слотов проверяем ДО обращения к раннеру.
   *
   * Его собственная проверка при занятых слотах отвечает «зови снова» после
   * паузы в 500 мс, а pollLoop на такой ответ свой интервал не выжидает — круг
   * замкнулся бы сразу, и все часы работы кампаний воркер стучал бы в базу по
   * два запроса за полсекунды (та же яма, что разобрана в
   * worker/salesChatLogger.ts и worker/tgOutreach.ts).
   */
  if (campaignRunner.activeJobIds().length >= MAX_CONCURRENCY) return claimedCommand;

  const claimedCampaign = await campaignRunner.pollOnce();
  return claimedCommand || claimedCampaign;
}

/*
 * Ни сброса зависших джоб, ни возобновления кампаний при старте здесь БОЛЬШЕ
 * НЕТ.
 *
 * Прежняя resetStuckJobs возвращала в очередь все `running` команды, а
 * resumeRunningCampaigns искала кампании в running/paused, подкладывала им
 * команду «старт» и — самое вредное — переводила ВСЕ paused обратно в running.
 * То есть каждый подъём процесса воскрешал кампании, которые оператор
 * остановил руками. Обе опирались на допущение «раз мы стартовали, значит
 * прошлого исполнителя нет»; на второй реплике это неправда.
 *
 * Их роль взяла аренда: брошенная кампания — это строка `running` с истёкшим
 * или обнулённым lease_until, и её подбирает обычный захват раннера, одинаково
 * при любом числе реплик. Остановленная кампания остаётся остановленной.
 */

async function main() {
  log('info', `AI Caller worker starting... (аренда ${LEASE_SECONDS}s, порог простоя ${Math.round(STALL_MS / 60_000)} мин, слотов ${MAX_CONCURRENCY})`);

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: флаг читают из
      // другого модуля, и полагаться на то, что shutdown() успеет поставить его
      // сам до первого await внутри библиотеки, нельзя.
      markShuttingDown();
      log('info', `${sig} received — releasing campaign leases for fast handoff`);
      void campaignRunner.shutdown().catch((err) => log('error', 'campaign shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop: isShuttingDown,
    pollOnce,
    // Только очередь команд: realtime будит опрос лишь по status=eq.pending
    // (см. pollLoop в worker/_shared.ts), а в `ai_campaigns` такого статуса нет
    // и быть не может. Запуск кампании всё равно доходит мгновенно — интерфейс
    // рядом со сменой статуса кладёт сюда команду «старт», и просыпаемся мы на
    // ней. Перехват брошенной аренды идёт запасным тиком раз в 30 секунд.
    realtimeTables: ['ai_caller_jobs'],
  });

  await campaignRunner.shutdown();

  log('info', 'AI Caller worker stopped');
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
