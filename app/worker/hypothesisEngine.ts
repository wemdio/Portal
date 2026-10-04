/**
 * Hypothesis Engine worker — обрабатывает джобы из he_jobs («Движок вертикалей»).
 *
 * Паттерн — копия salesAiAnalysis.ts: poll loop + realtime wake на INSERT/UPDATE
 * pending-джобы + graceful shutdown. На старте сбрасывает застрявшие 'running'
 * (после рестарта пода) обратно в 'pending' с сохранением attempts, иначе после
 * деплоя они висят навсегда.
 *
 * Джобы создаются API (/api/tools/hypothesis-engine/*): API ставит только
 * первую research-стадию (site_profile) либо точечные стадии (chain/vocab/
 * base_analyze/base_collect/template). Research-цепочку дальше ведёт сам воркер:
 * site_profile → competitors → brand_cloud → hypotheses → evidence → clustering.
 * Стадия base_collect — оркестратор: ждёт дочерние парсеры через self-requeue
 * (сама возвращает свою строку в pending; handleJob такой requeue не затирает
 * done-апдейтом). Стадии выполняются через runHeStage из lib/hypothesisEngine; fetchText/search
 * не переопределяем — используются дефолты либы (SSRF-гейт + websiteParser,
 * serperSearch).
 *
 * Отмена: cancel-роут (projects/[id]/cancel) переводит джобы проекта в
 * 'cancelled'. Pending не клеймятся; у running наблюдатель в handleJob
 * аборти́т LLM-запрос через канал активной джобы (setHeActiveJob), а если стадия успела
 * завершиться — done/дочейн не выполняются, attempts не растут (failJob).
 *
 * Живость стадии (волна 3): у каждой стадии есть сторож простоя
 * (createHeJobWatchdog). Он считает окно от ПОСЛЕДНЕЙ активности — строки лога
 * стадии, запроса к БД (withStageActivity), завершённой операции
 * ввода-вывода (ctx.onActivity, stages/io.ts) или попытки запроса к модели
 * (канал активной джобы, lib/hypothesisEngine/llm.ts) — и прерывает молчащую
 * стадию,
 * а если та игнорирует abort, процесс выходит и его перезапускает docker.
 *
 * Запросы стадий к БД идут ОТДЕЛЬНЫМ клиентом (stageDb ниже): у каждого есть
 * срок на заголовки и на ПАУЗУ между кусками тела, и его обрывает сигнал джобы.
 * Исключение одного рода и оно не здесь: записи, ФИКСИРУЮЩИЕ УЖЕ СДЕЛАННУЮ
 * ОПЛАТУ, идут третьим клиентом без сигнала (stageDb.heCheckpointSupabase,
 * см. paidCheckpointDb в stages/baseCollect.ts) — оба срока у них те же, а
 * сигнала нет, чтобы их отказ не превращал оплаченную работу в неоплаченную.
 * Числа таких записей здесь нет намеренно: полный список ведёт один докблок
 * paidCheckpointDb, а копия числа в шапке воркера с ним уже разъезжалась (две
 * записи стало четыре, когда освобождение дошло до ветки долива, потом список
 * вырос снова — план, проба среза, стор плана, расширение, конструктор).
 * Поэтому вставшее тело жирной строки he_bases.data кончается само за
 * HE_STAGE_DB_TIMEOUT_MS, а abort сторожа доходит до транспорта — аварийный выход
 * процесса перестаёт быть единственным способом раскрутить такое чтение. Общий
 * `db` остаётся у бухгалтерии воркера: она обязана работать ПОСЛЕ аборта джобы.
 *
 * Прерывание (сторож, рестарт воркера, обрыв чтения проекта, вставшее тело
 * ответа БД) попытку НЕ
 * тратит, но не бесконечно: HE_JOB_FREE_INTERRUPTIONS подряд, дальше обычная
 * попытка и финальный фейл — иначе застрявшая стадия пряталась бы за
 * бесплатными повторами навсегда. Классы прерываний ТИПИЗИРОВАНЫ
 * (HeJobInterruptionError), regexp по тексту тут недопустим: в этом движке
 * «aborted» означает отмену пользователем. Прерывание считается ЦЕНТРАЛЬНО, по
 * факту abort'а (handleJob после возврата стадии), а не по тому, дала ли стадия
 * отказу вылететь: 26 catch'ей движка глотают всё подряд, и проглоченный abort
 * иначе становился успешным 'done'.
 *
 * Участок ПОСЛЕ стадии (финализация и запись отказа) идёт под своим сроком
 * (POST_STAGE_DEADLINE_MS) на клиенте с сигналом: сторож там снят сознательно,
 * и молчащий PostgREST держал бы всю очередь при зелёном healthcheck.
 */

import fs from 'node:fs';
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, sleep, startWorkerHeartbeat } from './_shared';
import { supabaseAdminFetchWithRetry } from '@/lib/supabaseAdmin';
import { runHeStage } from '@/lib/hypothesisEngine/stages';
import { getHeActiveJobSignal, heLlmFailureOf, heLlmMaxAttemptMs, setHeActiveJob } from '@/lib/hypothesisEngine/llm';
import type { HeLlmSpend } from '@/lib/hypothesisEngine/llm';
// Клиент БД СТАДИЙ: срок на заголовки И на паузу между кусками тела, обрыв по
// сигналу джобы. Отдельный от `db` сознательно — см. комментарий у stageDb ниже.
import { createHeStageSupabase, isHeStageDbInterruption, HE_STAGE_DB_TIMEOUT_MS } from '@/lib/hypothesisEngine/stageDb';
// Единственный примитив репозитория «сделай значение пригодным для jsonb/text»
// (его же используют supabaseInstantly, парсеры и соседний движок). Это не
// импорт через границу движков — модуль общий и лежит ниже обоих; своя копия
// здесь означала бы, что следующий сюрприз Postgres починят в одном из двух
// мест. Границу сторожит tests/architecture/verticalEngineV2Isolation.test.ts:
// запрещён только verticalEngineV2.
import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';
// «Блип БД или приговор» — нейтральный предикат (lib/db/transientError.ts, без
// импортов), общий с конструктором баз и ENG-роутами. Читается ТОЛЬКО там, где
// решается судьба ЗАПРОСА (повторить ту же запись) и судьба джобы, стадия
// которой ещё НЕ НАЧАЛАСЬ. Повтор оплаченной стадии по этому предикату не
// назначается нигде.
import { isTransientDbError } from '@/lib/db/transientError';
import { normalizeHeMarket } from '@/lib/hypothesisEngine/market';
import {
  HE_ANALYZING_BASE_FIELDS,
  enqueueAutopilotFollowups,
  isAnalyzingBaseLive,
  liveHeJobBaseIds,
  repairOrphanAnalyzingBase,
} from '@/lib/hypothesisEngine/autopilotNext';
import type { HeAnalyzingBase } from '@/lib/hypothesisEngine/autopilotNext';
import { closeHeRefillBaseAfterFinalFail } from '@/lib/hypothesisEngine/stages/baseCollect';
import { isHeSearchProviderError } from '@/lib/hypothesisEngine/stages/searchIo';
import type { HeSearchProviderError } from '@/lib/hypothesisEngine/stages/searchIo';
// Алерт команде в health-бот, когда ENG-проект остановлен отказом, который
// чинит только команда (решение владельца 04.10.2026). Предикат — тот же, по
// которому кабинет сворачивает причину в 'billing'/'configuration'.
import { heTeamFixableFailureOf } from '@/lib/hypothesisEngine/clientErrors';
import { flushHeOpsAlerts, notifyHeClientStop } from '@/lib/hypothesisEngine/opsAlert';
import type { HeOpsStopKind, HeOpsStopProvider } from '@/lib/hypothesisEngine/opsAlert';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';

const WORKER_ID = `hypothesis-engine-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const MAX_ATTEMPTS = 3;
/** Как часто воркер проверяет строку активной джобы на отмену пользователем. */
const CANCEL_WATCH_MS = 3000;

/**
 * Heartbeat-файл: обновляется каждые 30с независимым setInterval-тиком.
 * Docker healthcheck читает mtime и флипает контейнер в unhealthy, если он
 * не обновлялся > 300с — autoheal тогда перезапускает воркер (паттерн
 * worker/yandexmaps.ts, инцидент 27.07.2026: event-loop hang при живом
 * процессе невидим без внешнего heartbeat).
 */
const HEARTBEAT_PATH = process.env.HE_WORKER_HEARTBEAT_PATH ?? '/tmp/hypothesis-engine-worker-heartbeat';

/**
 * НИЖНЯЯ ГРАНИЦА окна простоя стадии. Сторожа у воркера НЕ БЫЛО: heartbeat
 * тикает независимым setInterval (worker/_shared.ts), поэтому зависший на чтении
 * сокета await держал строку 'running' сколько угодно, а healthcheck оставался
 * зелёным — и вместе с этой джобой стояли все проекты (воркер single-flight).
 *
 * Окно считается от ПОСЛЕДНЕЙ активности стадии (строка лога, запрос к БД —
 * withStageActivity, — завершённая операция ввода-вывода — ctx.onActivity, —
 * попытка запроса к модели — канал активной джобы llm.ts), а не от её старта:
 * медленная, но работающая стадия не прерывается — ей достаточно одного
 * признака жизни за окно.
 *
 * Граница ОДНА, и это правда конфигурации. Раньше их было две (research 15 мин,
 * base 20 мин), но фактическое окно считает stageIdleTimeoutMs как максимум с
 * запасом над сроком запроса к модели (1,5 × 1 200 000 = 1 800 000 мс), то есть в
 * шиппинг-конфигурации побеждало третье число и оба окна были одинаковыми:
 * «у research окно уже» было мёртвым различием, а константа — ложью. Осталось
 * то число, которое может стать главным: самое широкое ЗАКОННОЕ молчание
 * стадии ВНЕ запроса к модели — пачка записей base_collect, где один запрос к
 * БД законно длится минуты. Оно работает при маленьком HE_LLM_TIMEOUT_MS
 * (минимум 30 000 мс → запас 45 000 мс), не давая окну провалиться ниже
 * законного молчания сборки.
 */
const STAGE_IDLE_FLOOR_MS = 20 * 60_000;

/**
 * Во сколько раз окно простоя обязано превосходить самое долгое ЗАКОННОЕ
 * молчание одного запроса к модели (heLlmMaxAttemptMs).
 *
 * Зачем множитель, а не «поровну»: до этой правки окно research было РАВНО
 * потолку срока вызова, то есть на стадии hypotheses (maxTokens 32768, её
 * расчёт просит 1 163 040 мс) сторож срабатывал ПЕРВЫМ — гонка двух равных
 * чисел, и выигрывал её всегда сторож. Сам потолок с тех пор поднят до
 * 1 200 000 мс, чтобы не резать формулу (llm.ts, LLM_DEADLINE_MAX_MS), и окно
 * следует за ним: 1 800 000 мс.
 * Здоровая генерация объявлялась зависанием, прерывание считалось бесплатным, и
 * самый дорогой вызов проекта переплачивался до 5 раз ещё до первой
 * засчитанной попытки. Теперь порядок бюджетов задан арифметикой: срок ПОПЫТКИ
 * ≤ heLlmMaxAttemptMs, окно = 1,5 × heLlmMaxAttemptMs, запас 50%.
 */
const LLM_SILENCE_SAFETY_FACTOR = 1.5;

/**
 * Окно простоя стадии. Берётся МАКСИМУМ из нижней границы (STAGE_IDLE_FLOOR_MS)
 * и запаса над сроком одной попытки запроса к модели, потому что молчание
 * генерации — законное и самое долгое в движке.
 *
 * Параметра «research или базовая» у функции больше нет: он ничего не решал ни
 * в одной шиппинг-конфигурации (см. STAGE_IDLE_FLOOR_MS).
 *
 * HE_LLM_TIMEOUT_MS перевернуть порядок не может: heLlmMaxAttemptMs читает ту
 * же перекрышку, и окно следует за ней (1 800 000 мс срока → 2 700 000 мс
 * окна). Единственный источник числа — llm.ts, двух независимых констант в двух
 * файлах здесь больше нет.
 */
function stageIdleTimeoutMs(): number {
  return Math.max(STAGE_IDLE_FLOOR_MS, Math.ceil(heLlmMaxAttemptMs() * LLM_SILENCE_SAFETY_FACTOR));
}
/**
 * Сколько ждём, пока прерванная стадия раскрутится сама. Не дождались —
 * процесс выходит с кодом 1 (restart: unless-stopped поднимает его заново):
 * await, игнорирующий abort, иначе остаётся зомби, который позже допишет
 * устаревшее состояние, и при single-flight воркере блокирует всю очередь.
 * Строку 'running' после рестарта подберёт resetStuckJobs — и посчитает
 * прерывание, поэтому бесплатный выход не бесконечен.
 */
const STAGE_ABORT_GRACE_MS = 2 * 60_000;

/**
 * Сколько прерываний ПОДРЯД не тратят попытку. Прерывание — не сбой стадии:
 * работа не выполнялась (сторож прервал молчание, воркер перезапустили
 * деплоем, оборвалось чтение проекта до запуска стадии), и раньше такие случаи
 * либо тратили попытку зря, либо (через resetStuckJobs) давали бесконечные
 * бесплатные повторы, за которыми застрявшая стадия пряталась навсегда.
 * Предел лечит только бесконечный цикл ОДНОГО и того же зависания: после него
 * каждое следующее прерывание считается обычной неудачной попыткой, и на
 * MAX_ATTEMPTS джоба уходит в 'failed' с терминальной обработкой стадии
 * (research → проект failed, base_collect → ремонт базы). Серия обнуляется
 * любым нормально завершившимся прогоном, включая тик self-requeue
 * base_collect: прогрессирующая сборка предела не достигает.
 */
const HE_JOB_FREE_INTERRUPTIONS = 5;
/** Пауза перед повтором прерванного прогона: 30с → 60с → 120с (дальше 120с). */
const INTERRUPTION_RETRY_BASE_MS = 30_000;
const INTERRUPTION_RETRY_MAX_MS = 120_000;

/**
 * Пауза перед повтором, когда подождать попросил САМ провайдер (429 +
 * Retry-After). Попытка при этом ТРАТИТСЯ — и вот почему.
 *
 * Зачем пауза: llm.ts честно отказывает с kind='rate_limit' и retryAfterMs,
 * когда провайдер просит подождать дольше, чем разрешено спать внутри вызова, —
 * «решение за джобой». Читателя у этого решения не было: попытка тратилась, а
 * run_after не ставился, и claimJob поднимал джобу через ~5 с. Лимит,
 * попросивший 2 минуты, заканчивал проект за 10 секунд (три попытки).
 *
 * Почему БЕСПЛАТНОЙ стоянки больше нет (ревью волны 3). Стоянка перезапускала
 * стадию С НАЧАЛА и не считалась попыткой, а серия стоянок обнулялась любым
 * обычным фейлом (clearHeJobRetryState) — то есть 5 бесплатных стоянок
 * повторялись перед КАЖДОЙ из трёх попыток: 18 полных платных прогонов стадии
 * там, где HEAD тратил 3. На evidence (один платный research-вызов на кандидата,
 * 429 на 18-м) это 18 × 17 ≈ 306 оплаченных вызовов вместо 51.
 *
 * Ценность стоянки сохранена целиком: повтор идёт НЕ раньше времени, которое
 * назвал провайдер, а не через 5 секунд. Пауза ставится только перед повтором,
 * а на последней попытке повтора нет (finalFail), поэтому пауз не больше
 * MAX_ATTEMPTS − 1 = 2 по ≤ RATE_LIMIT_PAUSE_MAX_MS: терпение джобы — до
 * ~20 минут (плюс ожидания внутри вызова) вместо 10 секунд у HEAD, а потолок
 * платной работы — те же MAX_ATTEMPTS полных прогонов, что и у любого другого
 * отказа. Отдельный счётчик стоянок для этого не нужен: attempts и есть
 * предел, и он один.
 *
 * MAX_ATTEMPTS полных прогонов — ПОТОЛОК, а у поэлементных стадий он ниже.
 * evidence и brand_cloud на market='us' пишут обработанный префикс в
 * he_jobs.result своей строки (stages/brandCloud.ts, writeHeItemCheckpoint), и
 * повтор после 429 доплачивает только необработанный хвост: на примере выше
 * 17 вердиктов оплачиваются один раз, а не 51. На RU 429 внутри этих стадий до
 * воркера не доходит вовсе — кандидат или бренд пропускается и стадия идёт
 * дальше, как до волны 3 (heRunStoppingLlmFailure).
 */
const RATE_LIMIT_PAUSE_DEFAULT_MS = 60_000;
/** Потолок одной паузы: дольше — уже не «подожди», а «зайди позже». */
const RATE_LIMIT_PAUSE_MAX_MS = 10 * 60_000;

/**
 * Срок на участок ПОСЛЕ стадии: финализация (чтение статуса → done-запись →
 * расход → дочейн → followups) и запись отказа (failJob → ремонт базы).
 *
 * Сторож простоя снимается вместе со стадией СОЗНАТЕЛЬНО (см. finally в
 * handleJob): убивать процесс между неатомарными записями нельзя — оплаченная
 * стадия исполнится заново. Но без всякого срока молчащий PostgREST держал бы
 * этот участок бесконечно, при зелёном healthcheck и вставшей очереди (воркер
 * single-flight): сторожа нет, heartbeat тикает своим таймером.
 *
 * Поэтому у участка свой срок, и он заканчивается САМ: каждый запрос получает
 * сигнал (withAbortSignal → PostgrestBuilder.abortSignal), а весь участок ещё и
 * в гонке с таймером — так он завершается даже там, где сигнал не проброшен.
 * По истечении срока НЕ бросаем наверх и НЕ выходим из процесса: и то и другое
 * отправило бы оплаченную стадию на повтор (failJob / resetStuckJobs). Пишем
 * громкую строку и отдаём слот следующей джобе; своя строка остаётся
 * 'running', и её вместе с готовым результатом подбирает сборщик брошенных
 * строк (collectStrandedJobs), зато остальные проекты идут дальше.
 */
const POST_STAGE_DEADLINE_MS = 2 * 60_000;

/**
 * Повторы done-записи. Запись идемпотентна и адресована по id, поэтому
 * транзиентный отказ PostgREST (503 после вызова на 32768 токенов) лечится
 * повтором ЗАПИСИ — в отличие от повтора СТАДИИ, который оплатил бы тот вызов
 * заново. Паузы 1с → 2с → 4с, всего ≤ 7 с ожидания внутри срока участка.
 */
const DONE_WRITE_ATTEMPTS = 4;
const DONE_WRITE_RETRY_BASE_MS = 1000;

/**
 * Повторы ЧТЕНИЯ застрявших 'running' на старте (resetStuckJobs) и повторы
 * ЗАПИСИ отказа (writeJobFailure) при блипе БД. Паузы 1с → 2с; оба участка
 * идут до первой стадии либо внутри POST_STAGE_DEADLINE_MS, так что суммарное
 * ожидание (≤3 с) в срок укладывается с запасом.
 *
 * Повторяется ЗАПРОС, а не стадия: запись отказа адресована по id и
 * идемпотентна, чтение застрявших строк бесплатно. Ни один из этих повторов не
 * меняет числа платных прогонов стадии.
 */
const STUCK_READ_ATTEMPTS = 3;
const STUCK_READ_RETRY_BASE_MS = 1000;
const FAIL_WRITE_ATTEMPTS = 3;
const FAIL_WRITE_RETRY_BASE_MS = 1000;

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
/**
 * Клиент БД, через который ходят СТАДИИ (ctx.supabase в handleJob).
 *
 * Отличие от `db` одно, и оно про окончание запроса: у общего админского клиента
 * срок стоит только на ЗАГОЛОВКИ ответа (таймер снимается, как только ответ
 * начался), а чтение ТЕЛА не ограничено ничем и не слушает никакого сигнала.
 * Жирная строка `he_bases.data`, чьё тело встало на середине, держала стадию
 * навсегда: сторож простоя давал abort, до транспорта тот не доходил, и через
 * STAGE_ABORT_GRACE_MS процесс выходил — вместе со всеми остальными проектами
 * (воркер односоточный).
 *
 * Почему НЕ сигнал на общем клиенте: `db` обслуживает claimJob,
 * cancel-наблюдателя, failJob, recordStageSpend и сборщик брошенных строк, и всё
 * это обязано работать ПОСЛЕ аборта джобы — иначе записать причину отказа нечем.
 *
 * Сигнал джобы берётся МОДУЛЬНЫМ геттером канала активной джобы (тем же, что
 * читает LLM-слой и stages/io.ts), а не полем контракта стадии: механизм один, и
 * стадии для этого править не надо.
 *
 * Транспорт под низом — админский fetch со своими повторами по обрыву связи.
 * Пауза между кусками тела — ограничение, которого не было вовсе. У фазы
 * ЗАГОЛОВКОВ то же ЧИСЛО, что у общего клиента (SUPABASE_FETCH_TIMEOUT_MS,
 * дефолт 120 000 мс), но ДРУГАЯ область: общий взводит его на каждую внутреннюю
 * попытку, здесь таймер один на весь цикл повторов — границы попыток из
 * переданного fetchImpl не видны. Весь вызов поэтому ограничен 120 000 мс вместо
 * ≈362 000, и это как раз то, что держит порядок «срок запроса к БД < окно
 * простоя стадии»; цена — последней попытке после отказов соединения достаётся
 * остаток бюджета, а не полный (разбор с числами — у HE_STAGE_DB_TIMEOUT_MS в
 * lib/hypothesisEngine/stageDb.ts).
 */
const stageDb = createHeStageSupabase({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  jobSignal: getHeActiveJobSignal,
  fetchImpl: supabaseAdminFetchWithRetry,
});
const shouldStop = setupGracefulShutdown(log);

/**
 * Свой провайдерский ключ движка (C3). До сих пор V1 и V2 читали ОДНУ
 * переменную OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (docker-compose.prod.yml
 * передаёт обоим воркерам одно значение), поэтому расход и rate limit одного
 * продукта били по другому: ночной долив ENG и ручной прогон специалиста в
 * V2 делили лимит запросов.
 *
 * Если задан HE_OPENROUTER_API_KEY — этот процесс работает по нему: значение
 * подставляется в переменную, которую читает getApiKey() в
 * lib/hypothesisEngine/llm.ts (читает при каждом вызове, не на импорте).
 * Переменная не задана — всё как раньше, общий ключ; ломаться нечему.
 * Правки compose не требует: оба воркера подключают весь .env через env_file,
 * а читает HE_OPENROUTER_API_KEY только этот файл.
 *
 * В лог уходит ТОЛЬКО имя выбранной переменной, никогда значение.
 */
function applyEngineProviderKey(): void {
  const dedicated = (process.env.HE_OPENROUTER_API_KEY ?? '').trim();
  if (!dedicated) {
    log('info', 'Provider key: HE_OPENROUTER_API_KEY не задан → общий OPENROUTER_HYPOTHESIS_ENGINE_API_KEY');
    return;
  }
  process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = dedicated;
  log('info', 'Provider key: свой ключ движка HE_OPENROUTER_API_KEY (общий ключ этим воркером не используется)');
}

/**
 * Прерывание прогона стадии: стадия НЕ упала сама — её оборвали.
 *
 * Класс типизированный, и решение «тратить попытку или нет» принимается по
 * типу, а не по тексту: в этом воркере «aborted» означает отмену
 * пользователем (failJob ловит её отдельно, по статусу строки), и regexp
 * `/aborted/i` воскрешал бы отменённую работу бесплатными повторами.
 * Поле-дискриминант heJobInterruption страхует случай, когда до сравнения
 * доезжает не тот же экземпляр класса (две копии модуля в бандле).
 */
class HeJobInterruptionError extends Error {
  readonly heJobInterruption = true as const;

  constructor(message: string, readonly kind: 'inactivity' | 'restart' | 'db') {
    super(message);
    this.name = 'HeJobInterruptionError';
  }
}

/** Прерывание ли это (типизированно, без разбора текста сообщения). */
function isHeJobInterruption(error: unknown): boolean {
  if (error instanceof HeJobInterruptionError) return true;
  return (error as { heJobInterruption?: unknown } | null)?.heJobInterruption === true;
}

/** Род прерывания для лога: сторож простоя, рестарт воркера или обрыв чтения БД. */
function heJobInterruptionKind(error: unknown): string {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : 'unknown';
}

/**
 * Результат завершённой стадии не записался, и повторять СТАДИЮ бессмысленно.
 *
 * Класс терминальный по той же причине, что отказ провайдера по балансу: запись
 * идемпотентна и адресована по id, внутри финализации она уже повторена с
 * бэкоффом (DONE_WRITE_ATTEMPTS), поэтому следующий прогон стадии предъявит тот
 * же результат той же БД — и оплатит стадию заново. Джоба уходит в 'failed' с
 * причиной: «оплачено, но не сохранено» — это работа для человека, а не для
 * трёх повторов. Имя таблицы в тексте намеренно: кабинет сворачивает причину в
 * 'internal' (clientErrors.classifyHeClientError).
 *
 * Сразу — только когда done-запись отвергнута НЕ блипом (isTransientDbError
 * ложен: размер, содержимое, права). Блип и истёкший срок участка терминальным
 * отказом сразу не становятся: строка с готовым результатом уходит сборщику
 * (collectStrandedJobs), и тот доставляет ТОТ ЖЕ результат, когда БД
 * вернётся; этим классом он закрывает строку, лишь когда доставка отвергнута
 * не блипом или исчерпала STRANDED_DELIVERY_ATTEMPTS при отвечающей БД.
 */
class HeJobResultWriteError extends Error {
  /** Дискриминант: instanceof ложен, если в бандле окажется две копии модуля. */
  readonly heJobTerminal = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'HeJobResultWriteError';
  }
}

/** Терминальный отказ джобы (повтор стадии ничего не изменит), типизированно. */
function isHeJobTerminal(error: unknown): boolean {
  if (error instanceof HeJobResultWriteError) return true;
  return (error as { heJobTerminal?: unknown } | null)?.heJobTerminal === true;
}

/**
 * ПЕРМАНЕНТНЫЙ отказ ПОИСКОВОГО провайдера (кончились кредиты, неверный или
 * отсутствующий ключ) — по типу, как и у модели, никогда по тексту.
 *
 * Зачем отдельный читатель. Терминальность джобы выводилась ТОЛЬКО из
 * heLlmFailureOf, а тот узнаёт свой дискриминант (heLlmFailure); у
 * HeSearchProviderError дискриминант другой (heSearchProvider), и кончившиеся
 * ночью кредиты Serper шли обычным фейлом: три полных прогона стадии там, где
 * ответ провайдера не изменится ни на одном из них. Отказ поиска по деньгам и
 * ключу перманентен ровно так же, как отказ модели, — и стоит дороже, потому
 * что ломается стадия, где на каждый элемент перебора идёт платный вызов
 * модели.
 *
 * Транзиентный отказ поиска сюда НЕ попадает (kind === 'transient': 429, 5xx,
 * 408/425, таймаут, обрыв сети, а также отказ ОДНОМУ запросу — 400/404/413/422
 * и пустой запрос, см. SerperFailureKind в lib/search/serperClient.ts): он не
 * повторяется на каждом следующем запросе, поэтому остаётся обычным фейлом со
 * своими MAX_ATTEMPTS, а стадия падает на нём, только если поиск не обслужил
 * ни одного запроса (stages/searchIo.ts).
 */
function heSearchRefusalOf(error: unknown): HeSearchProviderError | null {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    if (isHeSearchProviderError(e) && e.kind !== 'transient') return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Отказ, о котором надо сказать команде: проект остановлен тем, что чинит
 * только она (деньги или ключ у провайдера модели либо поиска). null — не такой.
 *
 * Два источника, и нужны оба:
 *  - ТИП (heLlmFailureOf / heSearchRefusalOf) — тот же, что делает отказ
 *    терминальным выше; он же называет провайдера и HTTP-статус;
 *  - ТЕКСТ — ровно тот предикат, по которому кабинет свернёт причину в
 *    'billing'/'configuration' (clientErrors.heTeamFixableFailureOf). Кабинет
 *    на этих кодах пишет клиенту «команда уже работает» (clientFailureText,
 *    HE_TEAM_ON_IT_EN), и эта фраза обязана быть правдой и там, где типа нет:
 *    стадия сама записала в he_bases.error «Авто-сборка не дала строк: … Serper
 *    billing: …» и бросила обычный Error, или 5xx-ответ с «insufficient credits»
 *    в теле (транспорт держит его транзиентным, а кабинет читает биллингом).
 */
function heOpsStopOf(
  llmFailure: ReturnType<typeof heLlmFailureOf>,
  searchRefusal: HeSearchProviderError | null,
  msg: string,
): { kind: HeOpsStopKind; provider: HeOpsStopProvider; httpStatus?: number } | null {
  if (searchRefusal && searchRefusal.kind !== 'transient') {
    return { kind: searchRefusal.kind, provider: 'search', httpStatus: searchRefusal.httpStatus };
  }
  if (llmFailure?.kind === 'billing' || llmFailure?.kind === 'configuration') {
    return { kind: llmFailure.kind, provider: 'model', httpStatus: llmFailure.status };
  }
  const textKind = heTeamFixableFailureOf(msg);
  if (!textKind) return null;
  return { kind: textKind, provider: /\bSerper\b/i.test(msg) ? 'search' : 'model' };
}

/** Срок чтения рынка и имени проекта для алерта: дольше ждать незачем, алерт отвязан от очереди. */
const OPS_ALERT_PROJECT_READ_MS = 10_000;
/** Пауза перед вторым и последним чтением, если первое не удалось. */
const OPS_ALERT_PROJECT_REREAD_MS = 30_000;

/**
 * Сообщить команде об остановке ENG-проекта (lib/hypothesisEngine/opsAlert.ts).
 *
 * ОТВЯЗАНО ОТ ОЧЕРЕДИ: промис не ждём, а всё, что внутри может отказать, —
 * поймано. Запись отказа джобы уже сделана к этому моменту, и ни чтение
 * проекта, ни Telegram не могут ни задержать следующую джобу (воркер
 * single-flight), ни уронить процесс.
 *
 * RU НЕ ЗАДЕТ: для RU-проекта (market='ru') opsAlert отбрасывает алерт до
 * отправки; единственный след — одно читающее чтение he_projects(market, name)
 * на джобе, уже упавшей таким отказом. Записей нет, сообщений нет.
 *
 * Рынок не прочитался — алерт уходит с пометкой «рынок не прочитан»: кабинет
 * ENG-клиента уже пообещал, что команда знает, и промолчать хуже, чем один раз
 * написать про RU-проект. Проекта нет вовсе (удалён) — молчим: сообщать некому.
 */
function alertTeamOnClientStop(
  job: HeJob,
  stop: { kind: HeOpsStopKind; provider: HeOpsStopProvider; httpStatus?: number },
  msg: string,
): void {
  void (async () => {
    let market: string | null = null;
    let projectName: string | null = null;
    // Две попытки с паузой: блип БД не должен ни потерять ENG-алерт, ни
    // отправить алерт про RU-проект с пометкой «рынок не прочитан».
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { data, error } = await withAbortSignal(db, AbortSignal.timeout(OPS_ALERT_PROJECT_READ_MS))
          .from('he_projects')
          .select('market, name')
          .eq('id', job.project_id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return;
        const row = data as { market?: unknown; name?: unknown };
        market = normalizeHeMarket(row.market);
        projectName = typeof row.name === 'string' ? row.name : null;
        break;
      } catch (e) {
        log(
          'warn',
          `Job ${job.id} (${job.stage}) ops alert: проект не прочитан, попытка ${attempt}/2 `
            + `(${e instanceof Error ? e.message : String(e)})`
            + (attempt < 2 ? '' : ' — алерт уйдёт с пометкой «рынок не прочитан»'),
        );
        if (attempt < 2) await sleep(OPS_ALERT_PROJECT_REREAD_MS);
      }
    }
    await notifyHeClientStop({
      projectId: job.project_id,
      projectName,
      market,
      stage: job.stage,
      kind: stop.kind,
      provider: stop.provider,
      reason: msg,
      httpStatus: stop.httpStatus ?? null,
      jobId: job.id,
      baseId: typeof job.payload?.base_id === 'string' ? job.payload.base_id : null,
    });
  })().catch((e) => {
    log('warn', `Job ${job.id} (${job.stage}) ops alert не отправлен: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/** Прерывания подряд — в payload джобы (своей колонки не нужно; стадии лишние ключи игнорируют). */
function heJobInterruptions(payload: Record<string, unknown> | null | undefined): number {
  const value = payload?.interruptions;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Закрыть серию прерываний в payload; null — закрывать нечего.
 *
 * Зовётся не только из нормально завершённого прогона, но и из ОБЫЧНОГО фейла
 * стадии: «прерываний подряд» обязано значить подряд. Раньше счётчик снимался
 * только там, где прогон закончился со строкой не в 'running', а обычный фейл
 * payload не трогал вовсе — старая серия доживала до следующего прерывания и то
 * продолжало её, хотя между ними была засчитанная попытка. Лог при этом писал
 * «N in a row», и число было неправдой.
 *
 * Счётчика стоянок по rate limit здесь больше нет: пауза по просьбе провайдера
 * теперь тратит попытку (RATE_LIMIT_PAUSE_DEFAULT_MS), то есть считает её
 * attempts, и второй счётчик — который этот же обнулятор сбрасывал, раздавая
 * новые бесплатные стоянки перед каждой попыткой, — не нужен.
 */
function clearHeJobRetryState(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  if (!heJobInterruptions(payload)) return null;
  const next = { ...payload };
  delete next.interruptions;
  return next;
}

/** Короткая сводка того, чего ждёт event loop: «TCPSocketWrap×31, Timeout×12». */
function summarizeActiveResources(limit = 8): string {
  const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  const counts = new Map<string, number>();
  for (const name of resources) counts.set(name, (counts.get(name) ?? 0) + 1);
  const entries = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = entries.slice(0, limit).map(([name, count]) => `${name}×${count}`);
  if (entries.length > limit) shown.push(`+${entries.length - limit} kinds`);
  return shown.join(', ') || 'none';
}

/**
 * Сторож простоя стадии. Идея и форма скопированы из
 * verticalEngineV2/workerLiveness.ts (импортировать нельзя — архитектурный
 * тест tests/architecture/verticalEngineV2Isolation.test.ts запрещает V1
 * зависеть от V2), поведение упрощено под single-flight воркер V1.
 *
 * Сторож НЕ гонится со стадией и не запускает замену в этом же процессе:
 * сначала abort (его видит и текущий HTTP-запрос к модели — сигнал джобы
 * проброшен в LLM-слой каналом активной джобы), и только если стадия не
 * ответила за graceMs — процесс выходит, чтобы устаревшая работа не дописала
 * состояние после восстановления.
 *
 * Внешний abort (отмена пользователем) окно НЕ снимает: стадия, которая
 * игнорирует отмену и висит дальше, доедет до того же таймаута и выхода.
 */
function createHeJobWatchdog(options: {
  abort: AbortController;
  idleMs: number;
  graceMs: number;
  /** Текст причины; в нём намеренно есть «timeout» — так его классифицирует кабинет. */
  reason: string;
  onTimeout: () => void;
  /** Получает фактически прожданное после abort время. */
  onUnresponsive: (waitedMs: number) => void;
}): { touch: () => void; stop: () => void } {
  let idleTimer: NodeJS.Timeout | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (stopped) return;
      // Сначала отчёт, потом abort: abort освобождает застрявшие await'ы и
      // стирает картину того, чего они ждали.
      try {
        options.onTimeout();
      } finally {
        options.abort.abort(new HeJobInterruptionError(`${options.reason} after ${options.idleMs}ms`, 'inactivity'));
      }
      const abortedAt = Date.now();
      recoveryTimer = setTimeout(() => {
        if (!stopped) options.onUnresponsive(Date.now() - abortedAt);
      }, options.graceMs);
      recoveryTimer.unref?.();
    }, options.idleMs);
    idleTimer.unref?.();
  };

  const touch = () => {
    // Истёкшую стадию поздняя активность не оживляет: срок аварийного выхода
    // уже идёт, продлевать его нечем — стадия обязана была закончиться.
    if (stopped || recoveryTimer) return;
    arm();
  };

  arm();
  return {
    touch,
    stop: () => {
      stopped = true;
      clearTimeout(idleTimer);
      clearTimeout(recoveryTimer);
    },
  };
}

/**
 * Клиент БД для стадии: тот же supabaseAdmin, но каждый запрос отмечается как
 * активность. Без этого «прогресс» был бы виден только по строкам лога, а
 * base_analyze не логирует ни разу, base_collect же большую часть тика именно
 * читает и пишет БД. Прокси прозрачен: методы вызываются на настоящем клиенте
 * (bind), поэтому приватные поля supabase-js остаются на месте.
 */
function withStageActivity<T extends object>(client: T, onActivity: () => void): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'from' || prop === 'rpc' || prop === 'schema') {
        return (...args: unknown[]) => {
          onActivity();
          const result = method.apply(target, args);
          if (result === null || typeof result !== 'object') return result;
          // schema() отдаёт КЛИЕНТ, а не билдер: своего завершения у него нет,
          // зато его from()/rpc() — запросы. Оборачиваем его этим же прокси
          // (так же, как withAbortSignal ниже), иначе `schema(x).from(t)`
          // уходил бы мимо прокси и сторож не видел бы ни одного такого запроса.
          if (prop === 'schema') return withStageActivity(result as object, onActivity);
          return touchOnSettle(result as object, onActivity);
        };
      }
      return method.bind(target);
    },
  });
}

/**
 * Отметить активность ещё и на ЗАВЕРШЕНИИ запроса.
 *
 * Отметка в момент `from`/`rpc` говорит только, что стадия запрос ОТПРАВИЛА:
 * окно сторожа начинает идти с отправки, поэтому один законно долгий запрос
 * (пачка вставок base_collect под нагрузкой БД) исчерпывал окно, ПОКА РАБОТАЛ,
 * и работающая стадия объявлялась зависшей. Билдер supabase-js — thenable:
 * перехватываем `then` и отмечаем активность на обоих исходах.
 *
 * Прокси обязан пережить цепочку: `.eq`/`.maybeSingle` возвращают тот же
 * объект, поэтому возврат target подменяем самим прокси, а новый объект
 * (`.select()` отдаёт другой билдер) оборачиваем тем же способом. Иначе `then`
 * доставался бы голому билдеру и завершение снова оставалось бы незамеченным.
 */
function touchOnSettle<T extends object>(node: T, onActivity: () => void): T {
  const proxy: T = new Proxy(node, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'then') {
        return (onDone?: (v: unknown) => unknown, onFail?: (e: unknown) => unknown) =>
          method.call(
            target,
            (v: unknown) => {
              onActivity();
              return onDone ? onDone(v) : v;
            },
            (e: unknown) => {
              onActivity();
              if (onFail) return onFail(e);
              throw e;
            },
          );
      }
      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        if (result === target) return proxy;
        return result !== null && typeof result === 'object'
          ? touchOnSettle(result as object, onActivity)
          : result;
      };
    },
  }) as T;
  return proxy;
}

/** Клиент БД воркера (он же тип прокси-обёрток ниже). */
type HeWorkerDb = typeof db;

/** Методы, возвращающие билдер запроса: на нём и живёт abortSignal. */
const QUERY_BUILDER_METHODS = new Set(['select', 'insert', 'update', 'upsert', 'delete']);

/** Поставить сигнал на билдер запроса, если он это умеет (PostgrestBuilder). */
function attachAbortSignal(builder: unknown, signal: AbortSignal): unknown {
  const withSignal = (builder as { abortSignal?: (s: AbortSignal) => unknown } | null)?.abortSignal;
  return typeof withSignal === 'function' ? withSignal.call(builder, signal) : builder;
}

/**
 * Клиент БД, у которого КАЖДЫЙ запрос получает внешний AbortSignal.
 *
 * Зачем: на участке после стадии сторожа простоя нет (см. POST_STAGE_DEADLINE_MS),
 * и молчащий PostgREST держал бы его бесконечно. Срок сам по себе прекращает
 * ОЖИДАНИЕ, но запрос без сигнала остаётся висеть и может дописать состояние
 * позже — поэтому срок ещё и обрывает запросы.
 *
 * Прокси прозрачен так же, как withStageActivity: методы вызываются на настоящем
 * клиенте (bind/apply на target), сигнал ставится сразу после
 * select/insert/update/upsert/delete, дальше цепочка (.eq, .maybeSingle) идёт по
 * настоящим объектам supabase-js. Прокинутый клиент годится и для чужих
 * функций, которым его передают параметром (enqueueAutopilotFollowups,
 * liveHeJobBaseIds, repairOrphanAnalyzingBase) — их запросы тоже попадают под
 * срок, без правок в их файлах.
 */
function withAbortSignal<T extends object>(client: T, signal: AbortSignal): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'schema') {
        return (...args: unknown[]) => withAbortSignal(method.apply(target, args) as object, signal);
      }
      if (prop === 'rpc') {
        return (...args: unknown[]) => attachAbortSignal(method.apply(target, args), signal);
      }
      if (prop !== 'from') return method.bind(target);
      return (...args: unknown[]) => {
        const queryBuilder = method.apply(target, args) as object;
        return new Proxy(queryBuilder, {
          get(qTarget, qProp) {
            const qValue = Reflect.get(qTarget, qProp, qTarget);
            if (typeof qValue !== 'function') return qValue;
            const qMethod = qValue as (...qArgs: unknown[]) => unknown;
            if (typeof qProp !== 'string' || !QUERY_BUILDER_METHODS.has(qProp)) return qMethod.bind(qTarget);
            return (...qArgs: unknown[]) => attachAbortSignal(qMethod.apply(qTarget, qArgs), signal);
          },
        });
      };
    },
  }) as T;
}

/**
 * Выполнить участок после стадии под своим сроком (POST_STAGE_DEADLINE_MS).
 *
 * Наверх бросает ТОЛЬКО отказ, случившийся ДО срока, — его ждёт вызывающий
 * (pollOnce → failJob). Истёкший срок и поздний отказ заканчиваются строкой в
 * логе: повтор оплаченной стадии здесь недопустим, а необработанный поздний
 * отказ уронил бы процесс (unhandled rejection) и сделал ровно это.
 *
 * Возвращает, УЛОЖИЛСЯ ли участок в срок. Читатели — финализация (отдать
 * брошенную строку сборщику, markJobStranded) и failJob (его итог читают
 * pollOnce, resetStuckJobs и сам сборщик: строку, запись которой не доехала,
 * из списка не вычёркивают).
 */
async function withPostStageDeadline(
  job: HeJob,
  label: string,
  run: (client: HeWorkerDb, signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`${label} deadline after ${POST_STAGE_DEADLINE_MS}ms`));
  }, POST_STAGE_DEADLINE_MS);
  timer.unref?.();
  const onExpiry = new Promise<'expired'>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve('expired'), { once: true });
  });
  try {
    const outcome = await Promise.race<'done' | 'expired'>([
      run(withAbortSignal(db, controller.signal), controller.signal).then(
        () => 'done' as const,
        (e: unknown) => {
          if (!expired) throw e;
          log(
            'error',
            `Job ${job.id} (${job.stage}) ${label} отказала уже после срока: ${e instanceof Error ? e.message : String(e)}`,
          );
          return 'done' as const;
        },
      ),
      onExpiry,
    ]);
    if (outcome === 'expired') {
      log(
        'error',
        `Job ${job.id} (${job.stage}) ${label} не уложилась в ${POST_STAGE_DEADLINE_MS}ms — запросы оборваны, `
          + `слот отдан следующей джобе (оплаченную стадию не повторяем); active resources: ${summarizeActiveResources()}`,
      );
    }
    return outcome === 'done';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Готовый результат ОПЛАЧЕННОЙ стадии, который ещё не лёг в he_jobs, — и
 * бухгалтерия его финализации.
 *
 * projectBooked — прибавлен ли расход прогона к he_projects. Там накопитель —
 * инкремент (accumulateProjectUsage), второй раз прибавлять нельзя; he_jobs
 * пишется абсолютным значением от снимка строки, и его повтор безопасен.
 * Флаг ставится только по ПОДТВЕРЖДЁННОЙ записи. Запрос, оборванный сроком
 * участка, мог всё же лечь в БД — тогда сборщик прибавит расход к he_projects
 * второй раз; это остаточный случай, и он завышает воронку, а не теряет её.
 */
interface HeStrandedDelivery {
  result: unknown;
  tokensUsed: number;
  costUsd: number;
  projectBooked: boolean;
}

/** Брошенная строка: почему, чем её закрыть и что в неё доставить. */
interface HeStrandedJob {
  job: HeJob;
  reason: string;
  /**
   * Чем закрыть строку через failJob, когда доставлять нечего: ИСХОДНЫЙ отказ
   * (прерывание остаётся прерыванием, отказ провайдера — отказом), а для
   * брошенной финализации — HeJobResultWriteError.
   */
  failure: unknown;
  /** Результат завершённой стадии: сборщик пишет его done-строкой, а не 'failed'. */
  delivery: HeStrandedDelivery | null;
  /** Попытки доставки, при которых статус ПРОЧИТАЛСЯ, а done-запись не легла. */
  deliveryTries: number;
  /**
   * Доставку бросили (отказ не блипом или попытки кончились) и закрывают
   * строку отказом `failure`. Результат при этом НЕ выбрасывается: последняя
   * done-запись могла лечь без ответа, и тогда строка окажется 'done' — с
   * хвостом, который обязан дойти (finishLandedDoneRow).
   */
  abandoned: boolean;
  /** Попытки хвоста done-строки (finishLandedDoneRow), при которых статус ПРОЧИТАЛСЯ. */
  tailTries: number;
  /** Повторы ремонта базы, обрезанного сроком после записи отказа (см. collectStrandedJobs). */
  repairTries: number;
}

/**
 * Строки, запись которых этот воркер бросил на полпути (этот процесс или
 * прошлый процесс того же контейнера, см. ниже), — и стадия при этом либо уже
 * оплачена и завершена (истёк срок участка после стадии, не прочитался статус,
 * done-запись отвергнута блипом), либо закончилась отказом, запись которого не
 * легла (failJob вернул false: pollOnce, а также resetStuckJobs — для строк,
 * которые он и так закрывает).
 *
 * Зачем отдельный список. Единственным сборщиком застрявших 'running' был
 * resetStuckJobs, а он отрабатывает только на старте процесса — брошенная
 * строка висела до ближайшего рестарта (часы), и вместе с ней стоял проект.
 * Вернуть её в pending, как это делает resetStuckJobs, здесь НЕЛЬЗЯ: рестарт
 * обрывает стадию посередине (работа не сделана), а тут стадия отработала и
 * оплачена — повтор оплатил бы её заново. Поэтому сборщик ДОСТАВЛЯЕТ готовый
 * результат той же done-строкой, что и финализация (deliverDoneRow), и только
 * если доставка отвергнута не блипом или исчерпала STRANDED_DELIVERY_ATTEMPTS
 * при отвечающей БД, закрывает строку терминально (HeJobResultWriteError).
 * Строку без результата он закрывает её исходным отказом. Строку, которая уже
 * 'done' (done-запись легла, а ответ на неё потерян), он доводит хвостом
 * финализации (finishLandedDoneRow), а не вычеркивает молча.
 *
 * Список свой, а не «все 'running' в таблице»: воркер single-flight, но
 * заметать чужие строки по одному лишь статусу — значит убить джобу соседнего
 * процесса, если он когда-нибудь появится.
 *
 * Список переживает выход процесса: он дублируется в файл STRANDED_PATH и
 * читается на старте ДО resetStuckJobs, а тот строки из списка не трогает —
 * иначе рестарт закрывал бы оплаченную и завершённую стадию бесплатным
 * прерыванием 'restart', то есть оплачивал бы её заново. Граница — срок жизни
 * файла (см. STRANDED_PATH): пересоздание контейнера, пока БД ещё лежит,
 * список теряет, и такую строку resetStuckJobs снова закроет бесплатным
 * прерыванием — стадия будет оплачена повторно. Перед остановкой процесса
 * сборщик делает последний проход (main).
 */
const strandedJobs = new Map<string, HeStrandedJob>();

/**
 * Сколько раз сборщик доставляет результат при ОТВЕЧАЮЩЕЙ на чтение БД. Тики,
 * где не прочитался даже статус (БД лежит), не считаются: пока БД недоступна,
 * ждать дешевле, чем выбросить оплаченный результат. Каждая доставка — до
 * DONE_WRITE_ATTEMPTS запросов внутри POST_STAGE_DEADLINE_MS. Тот же предел и
 * тот же счёт «только тики с прочитанным статусом» — у хвоста легшей
 * done-строки (finishLandedDoneRow, свой счётчик tailTries).
 */
const STRANDED_DELIVERY_ATTEMPTS = 5;

/**
 * Файл списка брошенных строк — рядом с heartbeat и с тем же сроком жизни:
 * файловая система контейнера переживает выход процесса и `docker restart`
 * (autoheal, аварийный выход сторожа), но НЕ пересоздание контейнера при
 * деплое — volume у воркера нет (docker-compose.prod.yml).
 */
const STRANDED_PATH = process.env.HE_WORKER_STRANDED_PATH ?? '/tmp/hypothesis-engine-stranded.json';

/**
 * Поля отказа, по которым failJob решает судьбу джобы. Все они читаются по
 * ДИСКРИМИНАНТУ, а не по классу (isHeJobInterruption, isHeJobTerminal,
 * heLlmFailureOf, heSearchRefusalOf), поэтому отказ, восстановленный из файла
 * простым Error с этими полями, классифицируется так же, как исходный.
 */
const FAILURE_FIELDS = [
  'heJobInterruption',
  'heJobTerminal',
  'heLlmFailure',
  'heSearchProvider',
  'kind',
  'status',
  'retryAfterMs',
  'httpStatus',
] as const;

function serializeFailure(error: unknown, depth = 0): Record<string, unknown> {
  const record = (error !== null && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
  for (const field of FAILURE_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[field] = value;
  }
  // Цепочку причин — на ту же глубину, что читают heLlmFailureOf/heSearchRefusalOf.
  if (depth < 3 && record.cause) out.cause = serializeFailure(record.cause, depth + 1);
  return out;
}

function reviveFailure(raw: unknown): Error {
  const record = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const error = new Error(typeof record.message === 'string' ? record.message : 'he_jobs stranded job') as Error &
    Record<string, unknown>;
  if (typeof record.name === 'string') error.name = record.name;
  for (const field of FAILURE_FIELDS) if (field in record) error[field] = record[field];
  if (record.cause) error.cause = reviveFailure(record.cause);
  return error;
}

/** Записать список в файл (атомарно: tmp + rename). Сбой — громкая строка, не исключение. */
function persistStrandedJobs(): void {
  try {
    if (!strandedJobs.size) {
      fs.rmSync(STRANDED_PATH, { force: true });
      return;
    }
    const entries = [...strandedJobs.values()].map((entry) => ({
      job: entry.job,
      reason: entry.reason,
      failure: serializeFailure(entry.failure),
      delivery: entry.delivery,
      deliveryTries: entry.deliveryTries,
      abandoned: entry.abandoned,
      tailTries: entry.tailTries,
      repairTries: entry.repairTries,
    }));
    const tmp = `${STRANDED_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries));
    fs.renameSync(tmp, STRANDED_PATH);
  } catch (e) {
    log(
      'error',
      `Список брошенных строк не записан в ${STRANDED_PATH}: ${e instanceof Error ? e.message : String(e)} — `
        + 'после рестарта процесса его строки закроет resetStuckJobs бесплатным прерыванием',
    );
  }
}

/** Прочитать список, оставленный прошлым процессом этого контейнера. */
function loadStrandedJobs(): void {
  let text: string;
  try {
    text = fs.readFileSync(STRANDED_PATH, 'utf8');
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'ENOENT') {
      log('error', `Список брошенных строк не прочитан из ${STRANDED_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  try {
    const entries: unknown = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error('ожидался массив');
    for (const raw of entries) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const job = entry.job as HeJob | undefined;
      if (!job || typeof job.id !== 'string') continue;
      const delivery = entry.delivery as HeStrandedDelivery | null | undefined;
      strandedJobs.set(job.id, {
        job,
        reason: typeof entry.reason === 'string' ? entry.reason : 'restored after restart',
        failure: reviveFailure(entry.failure),
        delivery:
          delivery && typeof delivery === 'object'
            ? {
                result: delivery.result,
                tokensUsed: Number(delivery.tokensUsed) || 0,
                costUsd: Number(delivery.costUsd) || 0,
                projectBooked: delivery.projectBooked === true,
              }
            : null,
        deliveryTries: Number(entry.deliveryTries) || 0,
        abandoned: entry.abandoned === true,
        tailTries: Number(entry.tailTries) || 0,
        repairTries: Number(entry.repairTries) || 0,
      });
    }
    if (strandedJobs.size) {
      log('info', `Восстановлено брошенных строк из ${STRANDED_PATH}: ${strandedJobs.size} — их закроет сборщик, не resetStuckJobs`);
    }
  } catch (e) {
    log('error', `Список брошенных строк в ${STRANDED_PATH} не разобрался: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Пометить строку брошенной. Первая причина важнее: с неё всё началось. */
function markJobStranded(
  job: HeJob,
  reason: string,
  close: { failure: unknown; delivery?: HeStrandedDelivery | null },
): void {
  if (strandedJobs.has(job.id)) return;
  strandedJobs.set(job.id, {
    job,
    reason,
    failure: close.failure,
    delivery: close.delivery ?? null,
    deliveryTries: 0,
    abandoned: false,
    tailTries: 0,
    repairTries: 0,
  });
  persistStrandedJobs();
}

function forgetStrandedJob(id: string): void {
  if (strandedJobs.delete(id)) persistStrandedJobs();
}

/**
 * Доставить или закрыть брошенные строки. Зовётся каждым тиком поллера (пустой
 * список стоит одну проверку) и последний раз перед остановкой процесса.
 *
 * Статус перечитываем: срок участка мог истечь УЖЕ ПОСЛЕ done-записи (на
 * дочейне или на постановке followups), и тогда строка честно 'done' —
 * перезаписать её значило бы стереть результат оплаченной стадии.
 *
 * ВЕСЬ набор того, что может вернуть чтение статуса (he_jobs_status_check знает
 * пять статусов, плюс отказ чтения и пропавшая строка), и что с ним делается:
 *  - чтение отвергнуто → ничего, следующий тик; попытки не тратятся;
 *  - 'running', запись с результатом, доставку не бросали → deliverDoneRow.
 *    Блип или срок — следующий тик, до STRANDED_DELIVERY_ATTEMPTS попыток;
 *    отказ не блипом или конец попыток — доставка БРОШЕНА (abandoned), и
 *    строку закрывает failJob с HeJobResultWriteError;
 *  - 'running' без результата или с брошенной доставкой → failJob исходным
 *    отказом. Не лёг — следующий тик. Лёг у записи без результата — она
 *    вычеркнута. Лёг у брошенной доставки — запись остаётся ещё на одно чтение:
 *    CAS отказа поверх 'done' не пишет (и отвечает «записано»), а последняя
 *    done-запись могла лечь без ответа — тогда следующее чтение увидит 'done';
 *  - 'done', запись с результатом (брошенной доставка или нет) → done-строка
 *    ЛЕГЛА, ответ на неё потерян: хвост finishLandedDoneRow (расход в
 *    he_projects, дочейн, followups), каждый шаг со своим дедупом. Не уложился
 *    в срок или не прочиталось чтение дедупа — следующий тик, до
 *    STRANDED_DELIVERY_ATTEMPTS попыток, дальше громкая строка лога и запись
 *    вычеркнута. Раньше такую строку просто вычеркивали — и проект
 *    молча стоял в 'researching' без живой джобы и без следующей стадии;
 *  - 'done' без результата → строку закрыл не прогон этой записи (у записи
 *    отказа результата нет) — вычеркнуть;
 *  - 'pending' (self-requeue base_collect, чей статус финализация не
 *    прочитала), 'failed' (отказ, легший без ответа, в том числе наш у
 *    брошенной доставки), 'cancelled', строки нет, любой другой статус →
 *    строку закрыли без сборщика; вычеркнуть. Перед этим запись с результатом,
 *    чей расход ещё не дошёл до he_projects, его записывает (recordStageSpend):
 *    вызовы модели оплачены при любом исходе строки, а у срока финализации,
 *    оборвавшего её до учёта, другого писателя этого расхода нет.
 */
async function collectStrandedJobs(): Promise<void> {
  if (!strandedJobs.size) return;
  for (const [id, entry] of [...strandedJobs]) {
    const { job } = entry;
    try {
      const { data, error } = await db.from('he_jobs').select('status').eq('id', id).maybeSingle();
      // БД ещё не вернулась — не гадаем о статусе, попробуем на следующем тике.
      if (error) continue;
      const status = (data as { status: string } | null)?.status;
      const delivery = entry.delivery;
      if (status === 'done' && delivery) {
        entry.tailTries += 1;
        let finished = false;
        let why = `не уложился в ${POST_STAGE_DEADLINE_MS}ms`;
        try {
          finished = await withPostStageDeadline(job, 'stranded done tail', async (client) => {
            await finishLandedDoneRow(client, job, delivery);
          });
        } catch (e) {
          why = e instanceof Error ? e.message : String(e);
        }
        if (finished) {
          forgetStrandedJob(id);
          continue;
        }
        if (entry.tailTries < STRANDED_DELIVERY_ATTEMPTS) {
          persistStrandedJobs();
          log(
            'error',
            `Job ${id} (${job.stage}) хвост легшей done-строки не доведён (попытка `
              + `${entry.tailTries}/${STRANDED_DELIVERY_ATTEMPTS}), повторим на следующем тике: ${why}`,
          );
          continue;
        }
        forgetStrandedJob(id);
        log(
          'error',
          `Job ${id} (${job.stage}) хвост легшей done-строки брошен после ${entry.tailTries} попыток (${why}) — `
            + `проект ${job.project_id} может стоять без следующей стадии (дочейн/followups), `
            + `расход в he_projects ${delivery.projectBooked ? 'учтён' : 'НЕ учтён'}`,
        );
        continue;
      }
      if (status !== 'running') {
        if (delivery && !delivery.projectBooked) {
          await withPostStageDeadline(job, 'stranded spend', async (client) => {
            await recordStageSpend(
              client,
              job,
              delivery.tokensUsed,
              delivery.costUsd,
              `брошенная строка уже '${status ?? 'удалена'}'`,
              delivery,
            );
          });
        }
        /**
         * Ремонт базы, обрезанный сроком участка. Финальный отказ base_collect
         * пишет строку отказа, а ПОТОМ чинит базу (repairBaseAfterCollectFinalFail)
         * — внутри того же срока. Если срок кончился между ними, строка уже
         * 'failed', failJob вернул false, и записью о брошенной строке остаёмся
         * только мы. Без этого повтора база навсегда стояла бы в 'collecting'
         * без живой джобы, а дедуп постановки сборки видел бы её как «уже
         * собирается» — вертикаль заблокирована. Повтор безопасен: ремонт
         * выходит сразу, если база уже терминальна, и пишет базу CAS'ом по
         * её текущему статусу.
         */
        const repairBaseId =
          status === 'failed' && job.stage === 'base_collect' && typeof job.payload?.base_id === 'string'
            ? job.payload.base_id
            : null;
        if (repairBaseId) {
          const failure = entry.failure;
          const repairMsg = stripUnstorableJsonChars(
            failure instanceof Error ? failure.message : String(failure ?? entry.reason),
          );
          let repaired = false;
          let why = 'не уложился в срок';
          try {
            repaired = await withPostStageDeadline(job, 'stranded base repair', async (client) => {
              await repairBaseAfterCollectFinalFail(client, job, repairBaseId, repairMsg);
            });
          } catch (e) {
            why = e instanceof Error ? e.message : String(e);
          }
          if (!repaired) {
            entry.repairTries += 1;
            if (entry.repairTries < STRANDED_DELIVERY_ATTEMPTS) {
              persistStrandedJobs();
              log(
                'warn',
                `Job ${id} (base_collect) ремонт базы ${repairBaseId} не доведён (попытка ${entry.repairTries}/`
                  + `${STRANDED_DELIVERY_ATTEMPTS}: ${why}) — повторю следующим тиком`,
              );
              continue;
            }
            // Предел: дальше база остаётся как есть — ровно то состояние, что было
            // до этого повтора, но теперь о нём кричит лог.
            log(
              'error',
              `Job ${id} (base_collect) ремонт базы ${repairBaseId} брошен после ${entry.repairTries} попыток `
                + `(${why}) — база может остаться в нетерминальном статусе, нужен человек`,
            );
          }
        }
        forgetStrandedJob(id);
        log('info', `Job ${id} (${job.stage}) брошенная строка: уже '${status ?? 'удалена'}' — собирать нечего`);
        continue;
      }
      if (delivery && !entry.abandoned) {
        entry.deliveryTries += 1;
        // Текст уходит в he_jobs.error при терминальном закрытии — английский,
        // как и прочие причины этого класса.
        let outcome = { kind: 'retry', message: `post-stage deadline ${POST_STAGE_DEADLINE_MS}ms expired` } as HeDoneWriteOutcome;
        await withPostStageDeadline(job, 'stranded delivery', async (client, signal) => {
          outcome = await deliverDoneRow(client, signal, job, delivery);
        });
        if (outcome.kind === 'delivered') {
          forgetStrandedJob(id);
          log(
            'info',
            `Job ${id} (${job.stage}) брошенный результат доставлен сборщиком (попытка ${entry.deliveryTries}) — `
              + 'оплаченная стадия не повторяется',
          );
          continue;
        }
        if (outcome.kind === 'retry' && entry.deliveryTries < STRANDED_DELIVERY_ATTEMPTS) {
          persistStrandedJobs();
          log(
            'error',
            `Job ${id} (${job.stage}) брошенный результат не доставлен (попытка `
              + `${entry.deliveryTries}/${STRANDED_DELIVERY_ATTEMPTS}), повторим на следующем тике: ${outcome.message}`,
          );
          continue;
        }
        // Запись отвергнута не блипом либо попытки при отвечающей БД кончились:
        // результат не сохранить, строку закрывает терминальный класс. Сам
        // результат (его бухгалтерию) запись хранит дальше: последняя попытка
        // могла лечь без ответа, и тогда хвост done-строки ещё понадобится.
        entry.failure = new HeJobResultWriteError(`he_jobs finalization abandoned (${entry.reason}): ${outcome.message}`);
        entry.abandoned = true;
        persistStrandedJobs();
      }
      const written = await failJob(job, entry.failure);
      // Брошенная доставка — ещё одно чтение статуса: 'failed' вычеркнет её,
      // 'done' (легла последняя done-запись) доведёт хвост.
      if (written && !delivery) forgetStrandedJob(id);
    } catch (e) {
      log(
        'error',
        `Job ${id} (${job.stage}) брошенную строку собрать не удалось: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Записать расход прогона, который НЕ закончился done-апдейтом: прерванный
 * сторожем, упавший (стадия бросила исключение — расход тогда знает только
 * канал активной джобы, llm.ts onSpend) и тот, чей результат не удалось
 * сохранить.
 *
 * Вызовы модели во всех этих случаях уже оплачены, и невидимым этот расход быть
 * не должен: воронка себестоимости (he_projects) занижалась ровно на те деньги,
 * которые потом тратились второй раз. Своих ошибок наружу не бросает — они
 * логируются: решение о судьбе джобы принимает вызывающий.
 *
 * booking — бухгалтерия финализации (HeStrandedDelivery): если расход уже
 * прибавлен к he_projects, второй раз не прибавляем, а подтверждённую запись
 * отмечаем в нём.
 */
async function recordStageSpend(
  client: HeWorkerDb,
  job: HeJob,
  tokensUsed: number,
  costUsd: number,
  why: string,
  booking?: { projectBooked: boolean },
): Promise<void> {
  if (!tokensUsed && !costUsd) return;
  const { error } = await client
    .from('he_jobs')
    .update({
      tokens_used: (job.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(job.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
  if (error) {
    log('error', `Job ${job.id} (${job.stage}) расход прогона не записан в he_jobs (${why}): ${error.message}`);
  }
  const funnelOk = booking?.projectBooked === true
    || await accumulateProjectUsage(client, job.project_id, tokensUsed, costUsd);
  if (booking && funnelOk) booking.projectBooked = true;
  const spend = `+${tokensUsed} tok, $${costUsd.toFixed(6)}`;
  if (!error && funnelOk) {
    log('info', `Job ${job.id} (${job.stage}) расход прогона учтён (${why}): ${spend}`);
  } else {
    // Не «учтён»: сказать «учтён», когда обе записи отвергнуты, значит потерять
    // деньги молча — ровно та невидимость, из-за которой правка и делается.
    log(
      'error',
      `Job ${job.id} (${job.stage}) расход прогона учтён НЕ ПОЛНОСТЬЮ (${why}): `
        + `he_jobs=${error ? 'нет' : 'да'}, he_projects=${funnelOk ? 'да' : 'нет'} (${spend})`,
    );
  }
}

/** Порядок research-пайплайна: после done стадии ставится следующая (если её ещё нет). */
const NEXT_RESEARCH_STAGE: Partial<Record<HeStage, HeStage>> = {
  site_profile: 'competitors',
  competitors: 'brand_cloud',
  brand_cloud: 'hypotheses',
  hypotheses: 'evidence',
  evidence: 'clustering',
};

/**
 * ТЕРМИНАЛЬНЫЕ статусы he_bases (ограничение he_bases_status_check знает пять:
 * uploaded, collecting, analyzing, analyzed, failed). Ремонт базы после
 * финального фейла сборки решает по ЭТОМУ набору, а не по перечислению
 * нетерминальных: раньше он был написан как «если collecting — свалить, если не
 * analyzing — уйти», и любой ТРЕТИЙ нетерминальный статус (сегодня это
 * 'uploaded', завтра — новый) молча оставался висеть навсегда. Инверсия — единственная
 * форма, которая не ломается от добавления статуса: терминальный набор закрыт,
 * нетерминальный открыт.
 */
const HE_BASE_TERMINAL_STATUSES = new Set(['analyzed', 'failed']);

/** Стадии research-пайплайна — при финальном фейле помечают проект failed. */
const RESEARCH_STAGES = new Set<HeStage>([
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
]);

/**
 * Строки, застрявшие в 'running' после рестарта (деплой, авария, аварийный
 * выход сторожа простоя), возвращаются в очередь. Раньше это был один
 * bulk-апдейт БЕЗ счётчика — то есть бесконечный бесплатный повтор: стадия,
 * которая вешает процесс, поднималась заново после каждого рестарта и нигде не
 * оставляла следа. Теперь каждая такая строка идёт через ту же политику, что и
 * прерывание внутри прогона (failJob, kind='restart'): бесплатно до
 * HE_JOB_FREE_INTERRUPTIONS подряд, дальше обычная попытка и финальный фейл с
 * терминальной обработкой стадии.
 *
 * Прогрессирующей джобе предел не грозит: серия обнуляется нормально
 * завершённым прогоном, а base_collect делает это каждым тиком self-requeue.
 */
async function resetStuckJobs() {
  // Это ЕДИНСТВЕННЫЙ сборщик чужих застрявших 'running' (свои брошенные строки
  // закрывает collectStrandedJobs), и работает он один раз — на старте. Блип БД
  // ровно в эту секунду означал, что все застрявшие строки останутся 'running'
  // до СЛЕДУЮЩЕГО рестарта, а их проекты — стоять: воркер single-flight и
  // pending-джобу такого проекта он клеймит, а вот его 'running'-строку уже
  // никто не подберёт. Поэтому блип повторяем (чтение бесплатно), а постоянный
  // отказ — нет: повторы его не вылечат.
  let rows: HeJob[] = [];
  for (let attempt = 1; attempt <= STUCK_READ_ATTEMPTS; attempt += 1) {
    const { data, error, status } = await db
      .from('he_jobs')
      .select('*')
      .eq('status', 'running');
    if (!error) {
      rows = (data ?? []) as HeJob[];
      break;
    }
    const retry = attempt < STUCK_READ_ATTEMPTS && isTransientDbError(error, status);
    log(
      'error',
      `Stuck running jobs could not be read (attempt ${attempt}/${STUCK_READ_ATTEMPTS})`
        + `${retry ? ', повторяем — блип БД' : ''}: ${error.message}`,
    );
    if (!retry) return;
    await sleep(STUCK_READ_RETRY_BASE_MS * attempt);
  }
  // Строки из списка брошенных (прочитан из файла до этого вызова, см. main) —
  // НЕ прерывание: их стадия завершилась и оплачена либо их отказ уже
  // классифицирован. Бесплатный 'restart' оплатил бы такую стадию заново; их
  // доставляет или закрывает исходным отказом сборщик (collectStrandedJobs).
  const stranded = rows.filter((row) => strandedJobs.has(row.id));
  if (stranded.length) {
    log(
      'info',
      `Stuck running jobs left to the stranded collector (их стадия уже оплачена или отказ уже известен): `
        + stranded.map((row) => `${row.id} (${row.stage})`).join(', '),
    );
    rows = rows.filter((row) => !strandedJobs.has(row.id));
  }
  if (!rows.length) return;
  log('info', `Resetting ${rows.length} stuck running jobs to pending`);
  for (const row of rows) {
    // Одна невыправленная строка не должна оставить остальные в 'running':
    // без этого сбой на первой же строке возвращал прежнюю беду (джоба висит
    // running, воркер её никогда не клеймит).
    try {
      // Текст с именем таблицы — намеренно: кабинет сворачивает причину в
      // машинный код (clientErrors.classifyHeClientError), и чисто русская
      // фраза попадала в 'unknown' («техническая проблема», без «на нашей
      // стороне»). Имя he_jobs даёт 'internal' — честный класс для рестарта
      // воркера. Русская часть остаётся для staff-инструмента.
      const restart = new HeJobInterruptionError('he_jobs restart: воркер перезапущен во время стадии', 'restart');
      // Запись не легла — строка не должна ждать следующего рестарта:
      // тот же отказ допишет сборщик, как только БД ответит.
      if (!(await failJob(row, restart))) markJobStranded(row, 'restart reset did not land', { failure: restart });
    } catch (e) {
      log(
        'error',
        `Stuck job ${row.id} (${row.stage}) was not returned to the queue: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

async function claimJob(): Promise<HeJob | null> {
  const { data: pending } = await db
    .from('he_jobs')
    .select('*')
    .eq('status', 'pending')
    // Отложенные джобы (self-requeue base_collect ставит run_after в будущее)
    // не клеймим раньше времени — иначе ожидание дочерних парсеров
    // превращается в hot spin по БД.
    .lte('run_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  // attempts здесь НЕ инкрементируем: attempts — счётчик фейлов (failJob),
  // а не клеймов. Self-requeue base_collect переводит джобу в pending десятки
  // раз подряд — инкремент на клейме сжигал все попытки за секунды ожидания.
  const { data: claimed } = await db
    .from('he_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', (pending as HeJob).id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return (claimed as HeJob | null) ?? null;
}

/**
 * Добавить расход стадии на проект (read-modify-write, воркер один на проект).
 * Клиент приходит параметром: на участке после стадии он со сроком
 * (withPostStageDeadline), иначе запись расхода могла бы висеть без сторожа.
 *
 * Возвращает, ДОШЁЛ ли расход до he_projects. Раньше и чтение, и запись здесь
 * молчали, поэтому вызывающий не мог отличить учтённый расход от потерянного и
 * писал в лог «учтён» в обоих случаях — то есть врал ровно про воронку
 * себестоимости.
 */
async function accumulateProjectUsage(
  client: HeWorkerDb,
  projectId: string,
  tokensUsed: number,
  costUsd: number,
): Promise<boolean> {
  if (!tokensUsed && !costUsd) return true;
  const { data: project, error: readErr } = await client
    .from('he_projects')
    .select('tokens_used, cost_usd')
    .eq('id', projectId)
    .maybeSingle();
  if (readErr) {
    log('error', `he_projects ${projectId} usage read failed: ${readErr.message}`);
    return false;
  }
  // Проекта нет (удалён) — прибавлять некуда, и это не сбой.
  if (!project) return false;
  const p = project as { tokens_used: number | null; cost_usd: number | string | null };
  const { error: writeErr } = await client
    .from('he_projects')
    .update({
      tokens_used: (p.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(p.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);
  if (writeErr) {
    log('error', `he_projects ${projectId} usage update failed: ${writeErr.message}`);
    return false;
  }
  return true;
}

/**
 * Сколько раз пробуем поставить следующую research-стадию: вставка в he_jobs
 * денег не стоит, повтор дешевле обрыва цепочки проекта.
 */
const CHAIN_ENQUEUE_ATTEMPTS = 3;
const CHAIN_ENQUEUE_RETRY_MS = 1000;

/**
 * Дочейнить следующую research-стадию. Идемпотентно: если такая стадия уже
 * стоит в pending/running по этому проекту (повторный прогон, гонка с API) —
 * дубликат не ставим.
 *
 * Ошибку ЧТЕНИЯ дедупа бросаем, а не игнорируем: пустой `existing` после сбоя
 * чтения означает не «стадии нет», а «неизвестно», и insert на этом месте
 * ставил ВТОРУЮ копию следующей стадии — второй платный прогон того же
 * research. Повтор (chainNextResearchStage) перечитает дедуп заново.
 */
async function enqueueNextResearchStage(client: HeWorkerDb, job: HeJob) {
  const nextStage = NEXT_RESEARCH_STAGE[job.stage];
  if (!nextStage) return;

  const { data: existing, error: existingErr } = await client
    .from('he_jobs')
    .select('id')
    .eq('project_id', job.project_id)
    .eq('stage', nextStage)
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle();
  if (existingErr) throw new Error(`he_jobs ${nextStage} dedup read: ${existingErr.message}`);
  if (existing) return;

  const { error } = await client
    .from('he_jobs')
    .insert({ project_id: job.project_id, stage: nextStage });
  if (error) throw new Error(`he_jobs ${nextStage} enqueue: ${error.message}`);
  log('info', `Job ${job.id} (${job.stage}) → enqueued ${nextStage} for project ${job.project_id}`);
}

/**
 * Дочейн следующей стадии, который НЕ роняет уже завершённую джобу.
 *
 * Раньше сбой постановки летел из handleJob наверх, pollOnce звал failJob, и
 * тот возвращал в pending УЖЕ done-джобу с attempts+1: оплаченная
 * research-стадия исполнялась заново на самой дорогой модели. Поэтому:
 *  - сначала CHAIN_ENQUEUE_ATTEMPTS дешёвых попыток — типичная причина
 *    (транзиентный отказ PostgREST) лечится повтором, а дедуп-чтение внутри
 *    не даёт повтору поставить дубликат;
 *  - джоба остаётся done: платную работу не повторяем, причину пишем в её
 *    `error` (в мастере специалиста колонка ошибки видна и у done-строки);
 *  - проект уходит в 'failed' с причиной — вести цепочку дальше некому, а
 *    молчаливый успех оставил бы проект в 'researching' навсегда. Это тот же
 *    терминальный статус, что failJob ставит при финальном фейле
 *    research-стадии, только без трёх платных повторов по дороге к нему;
 *    перезапуск research (staff-роут projects/[id]/research и клиентская
 *    кнопка client/eng/projects/[id]/research) с него работает — обе идут через
 *    enqueueHeResearchJob, а тот сам возвращает проект в 'researching'.
 *    Апдейт идёт с CAS по 'researching': отменённый проект cancel-роут уже
 *    перевёл в 'draft', и затирать его отмену этим фейлом нельзя.
 *
 * Окно ремонта сознательно оставлено коротким (~3 с суммой пауз): воркер
 * односоточный, пока он спит — не обрабатываются джобы других проектов, а
 * дольше ждать тут и нечем помочь. Полная недоступность БД роняет и записи
 * причины (тогда проект остаётся в 'researching' до внешнего реконсилятора),
 * а сбой, при котором insert в he_jobs не проходит, а update he_projects
 * проходит, — не транзиент, и повторы его не вылечат. Долговечное решение —
 * реконсилятор незавершённых проектов (отдельная волна).
 *
 * Наружу не бросает НИЧЕГО (включая сбой самой записи причины) — иначе вернётся
 * ровно тот повтор платной стадии, от которого функция и защищает.
 */
async function chainNextResearchStage(client: HeWorkerDb, job: HeJob) {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= CHAIN_ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await enqueueNextResearchStage(client, job);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      log('error', `Job ${job.id} (${job.stage}) chain enqueue failed (attempt ${attempt}/${CHAIN_ENQUEUE_ATTEMPTS}): ${msg}`);
      if (attempt < CHAIN_ENQUEUE_ATTEMPTS) await sleep(CHAIN_ENQUEUE_RETRY_MS * attempt);
    }
  }

  const reason = `chain stopped: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`;
  try {
    await client
      .from('he_jobs')
      .update({ error: reason.slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', job.id);
    await client
      .from('he_projects')
      .update({
        status: 'failed',
        error: `${job.stage}: ${reason}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id)
      // CAS: валим только идущее исследование. Отменённый проект cancel-роут
      // уже перевёл в 'draft' — затирать отмену фейлом дочейна нельзя.
      // (Перезапуск, успевший вернуть проект в 'researching', этим фильтром не
      // отличить — такую гонку закроет только реконсилятор.)
      .eq('status', 'researching');
    log('error', `Job ${job.id} (${job.stage}) → research chain stopped, project ${job.project_id} marked failed`);
  } catch (e) {
    log('error', `Job ${job.id} (${job.stage}) → research chain stopped, но записать причину не удалось: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Чем считать отказ стадии, вылетевший из runHeStage (или из чтения рынка до
 * неё).
 *
 * Сторож прервал молчащую стадию: то, чем она упала ПОСЛЕ abort, — это
 * прерывание, а не её собственный сбой. Отмена пользователем сюда не попадает:
 * её reason — DOMException, и её обрабатывает failJob по статусу.
 *
 * ТЕЛО ответа БД встало на середине — прерывание (kind='db'), не сбой стадии:
 * работа не выполнялась и не отказала, её оборвал срок клиента стадий.
 * Политика при этом НЕ новая, а сохранённая: до этой правки такое чтение не
 * кончалось ничем, кроме сторожа простоя, а сторож считает прерывание
 * бесплатным. Потолок платных прогонов тот же и общий
 * (HE_JOB_FREE_INTERRUPTIONS подряд, дальше обычные попытки) — второго
 * счётчика здесь не появляется.
 *
 * Фаза ЗАГОЛОВКОВ и обрыв связи сюда не попадают сознательно
 * (isHeStageDbInterruption истинен только для вставшего тела): они ограничены
 * тем же сроком и без этой правки и уже сегодня тратят попытку — бесплатные
 * повторы поднимали бы потолок платных прогонов стадии с 3 до 8 там, где
 * сегодня 3.
 */
function stageFailureOf(error: unknown, abortReason: unknown): unknown {
  if (isHeJobInterruption(abortReason)) return abortReason;
  if (isHeStageDbInterruption(error)) {
    return new HeJobInterruptionError(error instanceof Error ? error.message : String(error), 'db');
  }
  return error;
}

async function handleJob(job: HeJob) {
  log('info', `Running stage ${job.stage} for project ${job.project_id} (job ${job.id}, attempt ${job.attempts})`);

  // Отмена задачи: cancel-роут переводит джобу в 'cancelled'. Наблюдатель
  // раз в CANCEL_WATCH_MS перечитывает строку и аборти́т контроллер — сигнал
  // проброшен в LLM-слой (setHeActiveJob ниже), текущий запрос к модели
  // обрывается сразу, а не по окончании стадии. Если стадия сейчас не в
  // LLM-вызове, отмена сработает по завершении: статус 'cancelled' ниже не
  // даёт записать done и дочейнить следующую стадию.
  const abort = new AbortController();
  // Сторож простоя стадии: окно от последней активности, дальше abort (его
  // видит текущий запрос к модели) и, если стадия не ответила, выход процесса.
  const idleMs = stageIdleTimeoutMs();
  let lastActivity = `stage ${job.stage} started`;
  const watchdog = createHeJobWatchdog({
    abort,
    idleMs,
    graceMs: STAGE_ABORT_GRACE_MS,
    reason: `HE ${job.stage} inactivity timeout`,
    // Где стояла джоба: её последняя строка лога и чего ждёт процесс (сокеты,
    // DNS-запросы, чтения файлов) — после abort этой картины уже не будет.
    onTimeout: () => log(
      'error',
      `Inactivity timeout: job ${job.id} (${job.stage}) after ${idleMs}ms; `
        + `last activity: ${lastActivity}; active resources: ${summarizeActiveResources()}`,
    ),
    onUnresponsive: (waitedMs) => {
      log(
        'error',
        `Job ${job.id} (${job.stage}) ignored abort for ${waitedMs}ms — exiting; `
          + `строку подберёт resetStuckJobs после рестарта (active resources: ${summarizeActiveResources()})`,
      );
      process.exit(1);
    },
  });
  // Канал активной джобы для LLM-слоя: отмена, ТОТ ЖЕ признак жизни, что у
  // стадий (watchdog.touch()), и лог с личностью прогона. Механизм живости один
  // — сток один; llm.ts только отмечает в нём каждую попытку запроса, иначе
  // генерация ответа (самое длинное законное молчание движка) выглядит
  // зависанием, а прерывание её — бесплатным.
  //
  // Тот же канал несёт РАСХОД: каждый оплаченный ответ модели этого прогона
  // (включая отброшенные попытки схемы) прибавляется в paid. Стадия отдаёт свой
  // расход только вместе с результатом, поэтому без этой суммы деньги прогона,
  // который бросил исключение, не попадали в he_jobs/he_projects вовсе.
  const paid: HeLlmSpend = { tokensUsed: 0, costUsd: 0 };
  setHeActiveJob({
    signal: abort.signal,
    onActivity: () => watchdog.touch(),
    log: (msg) => log('warn', `Job ${job.id} (${job.stage}) project ${job.project_id}: ${msg}`),
    onSpend: (spend) => {
      paid.tokensUsed += spend.tokensUsed;
      paid.costUsd += spend.costUsd;
    },
  });
  const cancelWatcher = setInterval(() => {
    void (async () => {
      try {
        const { data } = await db
          .from('he_jobs')
          .select('status')
          .eq('id', job.id)
          .maybeSingle();
        if (data && (data as { status: string }).status === 'cancelled') abort.abort();
      } catch {
        // Транзиентная ошибка БД не должна ронять воркер — следующий тик повторит.
      }
    })();
  }, CANCEL_WATCH_MS);

  // Исход прогона стадии. Отказ не бросается из catch сразу: сначала (после
  // finally, когда сторож снят) записываем его оплаченный расход.
  let run:
    | { ok: true; stageResult: Awaited<ReturnType<typeof runHeStage>> }
    | { ok: false; error: unknown };
  try {
    // Рынок проекта (geo поиска, язык промптов/писем) — один read на джобу.
    const { data: proj, error: projErr, status: projStatus } = await db
      .from('he_projects')
      .select('market')
      .eq('id', job.project_id)
      .maybeSingle();
    // Обрыв ЧТЕНИЯ — прерывание, а не сбой стадии: стадия ещё не начиналась.
    // Раньше ошибка глоталась, market молча становился дефолтным ('ru'), и
    // прогон us-проекта уходил на русских промптах — клиент получал письма не
    // на своём языке. Отсутствие строки (проект удалён) ошибкой не является:
    // это дальше честно скажет readProject стадии.
    //
    // Бесплатное прерывание — только БЛИПУ (isTransientDbError): ни одного
    // платного вызова тут ещё не было, поэтому повтор ничего не стоит, а пауза
    // run_after (30/60/120 с) даёт БД вернуться. Постоянный отказ (нет колонки,
    // отказ прав, кеш схемы после неприменённой миграции) прерыванием НЕ
    // считаем: он не вылечится ни за пять бесплатных повторов, ни за восемь
    // минут ожидания, и честнее дать ему сразу тратить попытки и дойти до
    // 'failed' с причиной, чем прятать конфигурационную поломку за словом
    // «прерывание».
    if (projErr) {
      const text = `he_projects market read: ${projErr.message}`;
      throw isTransientDbError(projErr, projStatus) ? new HeJobInterruptionError(text, 'db') : new Error(text);
    }
    const market = normalizeHeMarket((proj as { market?: string } | null)?.market);

    const stageResult = await runHeStage(job, {
      // Клиент СТАДИЙ (stageDb): у каждого запроса срок на заголовки и на паузу
      // между кусками тела, и его обрывает сигнал джобы. Поверх — отметка
      // активности: каждый запрос стадии к БД признак жизни для сторожа, иначе
      // прогрессирующая, но молчаливая стадия (base_analyze не логирует вовсе)
      // выглядела бы зависшей.
      supabase: withStageActivity(stageDb, () => watchdog.touch()),
      market,
      // Отмена задачи — тем же сигналом, что уехал в канал LLM-слоя. Поле
      // контракта заполняем явно (io.ts: ctx.signal ?? getHeActiveJobSignal()):
      // читатель у него был, писателя не было вовсе, то есть ветка контракта
      // была недостижима. Объект один и тот же — поведение не меняется, но
      // «сигнал приходит стадии» перестаёт зависеть от того, что стадию запустил
      // именно этот воркер.
      signal: abort.signal,
      // Сигнал активности стадии (stages/shared.ts → stages/io.ts): каждая
      // завершившаяся операция ввода-вывода — чтение сайта, поиск — продлевает
      // окно сторожа. Тик таймера активностью не считается НИГДЕ, иначе
      // сторож перестал бы отличать работающую стадию от зависшей.
      onActivity: () => watchdog.touch(),
      log: (msg) => {
        lastActivity = msg.slice(0, 500);
        watchdog.touch();
        log('info', `[${job.stage}] ${msg}`);
      },
    });
    run = { ok: true, stageResult };
  } catch (e) {
    run = { ok: false, error: stageFailureOf(e, abort.signal.reason) };
  } finally {
    clearInterval(cancelWatcher);
    // Сторож снимается вместе со стадией СОЗНАТЕЛЬНО: дальше идёт неатомарная
    // финализация (done → дочейн → followups), и убивать процесс между этими
    // записями как способ восстановления нельзя — оплаченная стадия исполнится
    // заново. Молчащая финализация при этом не бесконечна: у участка свой срок
    // и свой сигнал на каждом запросе (withPostStageDeadline,
    // POST_STAGE_DEADLINE_MS) — по нему запросы обрываются, в лог уходит
    // громкая строка, а слот отдаётся следующей джобе БЕЗ повтора стадии.
    watchdog.stop();
    setHeActiveJob(null);
  }

  if (!run.ok) {
    // Стадия бросила: её результата нет, а расход, если он был, знает только
    // канал (paid). Записываем его ДО решения о судьбе джобы (pollOnce →
    // failJob) — под сроком участка, своим отдельным: повтор, отмена,
    // терминальный отказ — в любом исходе эти вызовы модели уже оплачены.
    if (paid.tokensUsed || paid.costUsd) {
      const failure = run.error;
      try {
        await withPostStageDeadline(job, 'failed-run spend', async (client) => {
          await recordStageSpend(
            client,
            job,
            paid.tokensUsed,
            paid.costUsd,
            `стадия упала: ${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}`.slice(0, 300),
          );
        });
      } catch (e) {
        log('error', `Job ${job.id} (${job.stage}) расход упавшего прогона не записан: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw run.error;
  }
  const { stageResult } = run;
  /**
   * Расход прогона — то, что вернула стадия, но НЕ МЕНЬШЕ того, что канал
   * насчитал по оплаченным ответам модели за этот прогон. Стадия теряет деньги
   * там, где вызов отказал после отброшенной попытки схемы (отказ несёт расход
   * лишь текстом, а чаще — никак) или где она проглотила отказ, не прибавив его
   * расход. Больше канала стадия может отчитаться законно (вне llm.ts у движка
   * платных вызовов нет, но страхуемся), поэтому берём максимум, а не сумму:
   * сумма посчитала бы дважды всё, что стадия учла сама.
   */
  const tokensUsed = Math.max(stageResult.tokensUsed ?? 0, paid.tokensUsed);
  const costUsd = Math.max(stageResult.costUsd ?? 0, paid.costUsd);
  if (paid.costUsd > (stageResult.costUsd ?? 0) || paid.tokensUsed > (stageResult.tokensUsed ?? 0)) {
    log(
      'warn',
      `Job ${job.id} (${job.stage}) стадия отчиталась о расходе меньше оплаченного: `
        + `стадия ${stageResult.tokensUsed ?? 0} tok/$${(stageResult.costUsd ?? 0).toFixed(6)}, `
        + `ответы модели ${paid.tokensUsed} tok/$${paid.costUsd.toFixed(6)} — в учёт идёт оплаченное`,
    );
  }

  /**
   * ЦЕНТРАЛЬНАЯ проверка прерывания: стадия вернулась, но джобу успели
   * прервать.
   *
   * До этой проверки abort превращался в HeJobInterruptionError ТОЛЬКО в catch
   * выше, то есть лишь тогда, когда стадия дала отказу вылететь наружу. Пять
   * стадий (brandCloud, competitors, evidence, siteProfile, vocab) для этого
   * проверяют сигнал в каждом своём catch, а 26 остальных catch'ей — нет:
   * chain.ts и template.ts глотают критик-луп и проход правок целиком
   * («критик-луп недоступен — оставляем исходные письма»), ещё 18 живут в
   * baseCollect, baseCollectRefill, dossier и hypotheses. Проглоченный abort
   * становился УСПЕХОМ: сторож снят, catch не сработал, строка ушла в 'done',
   * he_jobs.error остался NULL, цепочка дочейнилась дальше — и клиент получал
   * письма БЕЗ критика и правок, а единственным следом была одна строка лога.
   *
   * Поэтому решение принимается здесь, по ФАКТУ прерывания, а не по поведению
   * стадии: чинить это в стадиях означало бы держать 26 одинаковых проверок и
   * добавлять 27-ю к каждому новому catch. Отмена пользователем сюда не
   * попадает — её reason не наш класс (DOMException), и её обрабатывает ветка
   * статуса ниже вместе с failJob.
   */
  const abortReason: unknown = abort.signal.reason;
  const interrupted = abort.signal.aborted && isHeJobInterruption(abortReason);

  // Финализация (и учёт расхода прерванного прогона) — под своим сроком:
  // сторожа здесь уже нет, см. POST_STAGE_DEADLINE_MS.
  // Результат и бухгалтерия финализации — один объект: его же получит сборщик,
  // если строку придётся бросить, и по нему он знает, что уже записано.
  const delivery: HeStrandedDelivery = { result: stageResult.result, tokensUsed, costUsd, projectBooked: false };
  const finalized = await withPostStageDeadline(job, 'finalization', async (client, signal) => {
    if (interrupted) {
      // Прерывание идёт той же политикой, что и в catch: бесплатно до
      // HE_JOB_FREE_INTERRUPTIONS подряд, с паузой run_after, дальше обычная
      // попытка. Платную работу, которую стадия успела сделать до abort,
      // сначала записываем — повтор её не вернёт.
      await recordStageSpend(client, job, tokensUsed, costUsd, `прерывание ${heJobInterruptionKind(abortReason)}`);
      throw abortReason;
    }
    await finalizeJob(client, signal, job, delivery);
  });
  if (!finalized) {
    // Срок участка истёк: строка осталась 'running'. Раньше её не подбирал
    // никто до ближайшего рестарта процесса.
    //  - Завершённый прогон: стадия ОПЛАЧЕНА, и сборщик доставит её результат
    //    той же done-строкой, без повтора стадии (collectStrandedJobs).
    //  - Прерванный: стадия не доработала, её судьба — бесплатное прерывание с
    //    повтором; сборщик допишет именно его, а не терминальный отказ. Раньше
    //    такая строка ждала resetStuckJobs, то есть ближайшего рестарта.
    if (interrupted) markJobStranded(job, 'finalization deadline (interrupted run)', { failure: abortReason });
    else {
      markJobStranded(job, 'finalization deadline', {
        failure: new HeJobResultWriteError('he_jobs finalization abandoned (finalization deadline)'),
        delivery,
      });
    }
  }
}

/**
 * Финализация завершённой стадии: статус → done-запись → расход → дочейн →
 * followups. Вынесена отдельной функцией, потому что целиком идёт под сроком
 * участка (withPostStageDeadline) и на прокинутом клиенте: `db` напрямую здесь
 * означал бы запрос без сигнала, то есть возможность повиснуть навсегда.
 *
 * Если done-строка не легла (статус не прочитался, done-запись отвергнута
 * блипом или оборвана сроком), строка с ГОТОВЫМ результатом уходит сборщику
 * (markJobStranded) — он доставит её, когда БД вернётся. Терминальный отказ
 * (HeJobResultWriteError) бросается только на отказ НЕ блипом.
 */
async function finalizeJob(
  client: HeWorkerDb,
  signal: AbortSignal,
  job: HeJob,
  delivery: HeStrandedDelivery,
) {
  const { tokensUsed, costUsd } = delivery;

  // base_collect переводит свою строку обратно в pending (self-requeue на
  // время работы дочерних парсеров) и возвращает {waiting: true}. Не затираем
  // requeue финальным done-апдейтом — только накапливаем расход стадии.
  // Сюда же попадает 'cancelled': стадия завершилась после отмены — done и
  // дочейн следующей research-стадии не выполняем, джоба остаётся cancelled.
  /**
   * Ошибку чтения ЧИТАЕМ — и сначала повторяем САМО чтение (оно бесплатно, в
   * отличие от повтора стадии). Раньше ошибка глоталась, `current` молча
   * становился null, и код шёл дальше так, будто строка в 'running': done-запись
   * затирала self-requeue base_collect (ожидание дочерних парсеров
   * превращалось в «стадия закончена») и воскрешала отменённую джобу в 'done'
   * вместе с дочейном следующей платной стадии.
   */
  let current: { status: string } | null = null;
  let statusErr: string | null = null;
  for (let attempt = 1; attempt <= DONE_WRITE_ATTEMPTS; attempt += 1) {
    const { data, error } = await client
      .from('he_jobs')
      .select('status')
      .eq('id', job.id)
      .maybeSingle();
    if (!error) {
      current = data as { status: string } | null;
      statusErr = null;
      break;
    }
    statusErr = error.message;
    if (attempt >= DONE_WRITE_ATTEMPTS || signal.aborted) break;
    log(
      'error',
      `Job ${job.id} (${job.stage}) status read rejected (attempt ${attempt}/${DONE_WRITE_ATTEMPTS}): ${error.message}`,
    );
    await sleep(DONE_WRITE_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  if (statusErr) {
    // Статус неизвестен — писать 'done' нельзя (см. выше), повторять стадию
    // тоже: она оплачена. Расход записываем, строку с результатом отдаём
    // сборщику: прочитав 'running', он доставит ту же done-строку.
    await recordStageSpend(client, job, tokensUsed, costUsd, `статус джобы не прочитан: ${statusErr}`, delivery);
    markJobStranded(job, 'status read failed', {
      failure: new HeJobResultWriteError('he_jobs finalization abandoned (status read failed)'),
      delivery,
    });
    log(
      'error',
      `Job ${job.id} (${job.stage}) статус джобы не прочитан за ${DONE_WRITE_ATTEMPTS} попытки — `
        + `done-запись не делаем (она затёрла бы self-requeue или отмену), результат доставит сборщик: ${statusErr}`,
    );
    return;
  }
  if (current && current.status !== 'running') {
    const cancelled = current.status === 'cancelled';
    // Прогон закончился нормально — прежние прерывания больше не «подряд».
    // Для base_collect это главный клапан: каждый тик ожидания обнуляет серию,
    // поэтому предел бесплатных прерываний ловит только застрявшую сборку, а
    // не длинную (часы ожидания конструктора — десятки тиков).
    const payload = clearHeJobRetryState(job.payload);
    const { error: waitingErr } = await client
      .from('he_jobs')
      .update({
        tokens_used: (job.tokens_used ?? 0) + tokensUsed,
        cost_usd: Number(job.cost_usd ?? 0) + costUsd,
        updated_at: new Date().toISOString(),
        ...(payload ? { payload } : {}),
      })
      .eq('id', job.id);
    // Строка уже НЕ 'running' (self-requeue или отмена), поэтому сбой этой
    // записи не оставляет застрявшей джобы — но молча терять расход и обнуление
    // серии нельзя: без строки в логе это ровно та невидимость, из-за которой
    // прерывания переставали быть «подряд».
    if (waitingErr) {
      log('error', `Job ${job.id} (${job.stage}) usage/payload update failed: ${waitingErr.message}`);
    }
    delivery.projectBooked = await accumulateProjectUsage(client, job.project_id, tokensUsed, costUsd);
    log(
      'info',
      cancelled
        ? `Job ${job.id} (${job.stage}) → cancelled пользователем (+${tokensUsed} tok до отмены)`
        : `Job ${job.id} (${job.stage}) → waiting (self-requeue, +${tokensUsed} tok)`,
    );
    return;
  }

  const outcome = await deliverDoneRow(client, signal, job, delivery);
  if (outcome.kind === 'delivered') return;
  // Расход прогона попадает в воронку НЕЗАВИСИМО от судьбы записи: вызовы
  // оплачены, и занижалась ровно та сумма, которая иначе тратится второй раз.
  // Раньше throw стоял ПЕРЕД учётом — отчёт о себестоимости терял именно
  // двойные траты.
  await recordStageSpend(client, job, tokensUsed, costUsd, `done-запись отвергнута: ${outcome.message}`, delivery);
  if (outcome.kind === 'retry') {
    // Блип или истёкший срок: та же запись ляжет, когда БД вернётся, — и
    // результат оплаченной стадии сохранится. Раньше он выбрасывался, а
    // джоба уходила в 'failed' (research — вместе с проектом).
    markJobStranded(job, 'done write rejected', {
      failure: new HeJobResultWriteError(`he_jobs finalization abandoned (done write rejected): ${outcome.message}`),
      delivery,
    });
    log(
      'error',
      `Job ${job.id} (${job.stage}) done-запись не легла за ${DONE_WRITE_ATTEMPTS} попытки (блип БД или срок участка) — `
        + `стадию не повторяем, результат доставит сборщик: ${outcome.message}`,
    );
    return;
  }
  // Отказ не блипом: повтор стадии предъявит тот же результат той же БД и
  // оплатит стадию заново (см. HeJobResultWriteError). Джоба честно
  // становится 'failed' с причиной — это и был смысл чтения ошибки.
  throw new HeJobResultWriteError(`he_jobs done write: ${outcome.message}`);
}

/** Чем кончилась доставка done-строки. */
type HeDoneWriteOutcome =
  | { kind: 'delivered' }
  /** Блип БД или срок участка: ту же запись можно повторить позже. */
  | { kind: 'retry'; message: string }
  /** Запись отвергнута не блипом: повтор её не исправит. */
  | { kind: 'refused'; message: string };

/**
 * Записать done-строку готового результата и довести финализацию до конца
 * (расход в he_projects, дочейн, followups). Общая для финализации и сборщика
 * брошенных строк: результат один и тот же, и путь у него должен быть один.
 * Наружу не бросает: исход записи — в возвращаемом значении.
 */
async function deliverDoneRow(
  client: HeWorkerDb,
  signal: AbortSignal,
  job: HeJob,
  delivery: HeStrandedDelivery,
): Promise<HeDoneWriteOutcome> {
  const { tokensUsed, costUsd } = delivery;
  // Результат чистим ПЕРЕД записью: Postgres не хранит ни NUL, ни одиночный
  // UTF-16 суррогат, а сюда приезжает текст модели (обрыв по max_tokens ровно
  // между половинами пары — уже наблюдался как «Unterminated string») и
  // соскрапленные строки. Такой результат PostgREST отвергает ЦЕЛИКОМ.
  const doneRow = {
    status: 'done',
    result: stripUnstorableJsonChars((delivery.result ?? {}) as Record<string, unknown>),
    error: null,
    finished_at: new Date().toISOString(),
    tokens_used: (job.tokens_used ?? 0) + tokensUsed,
    cost_usd: Number(job.cost_usd ?? 0) + costUsd,
    updated_at: new Date().toISOString(),
  };
  /**
   * Ошибку done-записи ЧИТАЕМ — и сначала ПОВТОРЯЕМ САМУ ЗАПИСЬ. Раньше она
   * молча игнорировалась (строка оставалась 'running', и рестарт уводил джобу
   * бесплатным прерыванием — оплаченная стадия исполнялась заново до пяти раз);
   * потом её начали бросать наверх, и транзиентный 503 PostgREST после вызова
   * на 32768 токенов стал обычным фейлом стадии, то есть ТОТ ЖЕ вызов
   * оплачивался ещё дважды. Повторяем то, что сломалось: запись идемпотентна и
   * адресована по id, а стадия — нет.
   */
  let doneErr: { message: string; transient: boolean } | null = null;
  for (let attempt = 1; attempt <= DONE_WRITE_ATTEMPTS; attempt += 1) {
    const { error, status } = await client.from('he_jobs').update(doneRow).eq('id', job.id);
    if (!error) {
      doneErr = null;
      break;
    }
    doneErr = { message: error.message, transient: isTransientDbError(error, status) };
    // Срок участка истёк (запросы оборваны) — спать и повторять уже некому.
    if (attempt >= DONE_WRITE_ATTEMPTS || signal.aborted) break;
    log(
      'error',
      `Job ${job.id} (${job.stage}) done write rejected (attempt ${attempt}/${DONE_WRITE_ATTEMPTS}): ${error.message}`,
    );
    await sleep(DONE_WRITE_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  if (doneErr) {
    return signal.aborted || doneErr.transient
      ? { kind: 'retry', message: doneErr.message }
      : { kind: 'refused', message: doneErr.message };
  }

  if (!delivery.projectBooked) {
    delivery.projectBooked = await accumulateProjectUsage(client, job.project_id, tokensUsed, costUsd);
  }
  // Дочейн следующей research-стадии сам обрабатывает свой сбой: наверх ничего
  // не бросает, иначе failJob вернул бы уже done-джобу в pending и оплаченная
  // стадия исполнилась бы заново.
  await chainNextResearchStage(client, job);
  // Автопилот ENG-кабинета (только при he_projects.autopilot=true): дочейн
  // chain → base_collect → (base_analyze уже авто) → template. Сбой постановки
  // followup не должен ронять уже завершённую джобу — логируем и идём дальше.
  try {
    // Итог дочейна логируем: 'reanalyzed' (вместо новой сборки вылечена
    // осиротевшая база) иначе не виден в логах вообще.
    const followups = await enqueueAutopilotFollowups(client, job);
    const summary = Object.entries(followups)
      .map(([stage, outcome]) => `${stage}=${outcome}`)
      .join(' ');
    if (summary) log('info', `Job ${job.id} (${job.stage}) autopilot followups: ${summary}`);
  } catch (e) {
    log('error', `Job ${job.id} (${job.stage}) autopilot followups failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  log('info', `Job ${job.id} (${job.stage}) → done (+${tokensUsed} tok, $${costUsd.toFixed(6)})`);
  return { kind: 'delivered' };
}

/**
 * Хвост done-строки, которая ЛЕГЛА без подтверждения: UPDATE закоммичен, а
 * ответ на него не дошёл (каждый повтор получил 502 шлюза) либо срок участка
 * оборвал финализацию уже после записи. Зовёт его сборщик, прочитав 'done' у
 * записи с результатом (collectStrandedJobs).
 *
 * Шаги те же, что у deliverDoneRow после записи, но любой из них мог УЖЕ
 * случиться — финализация успела часть до обрыва, или прошлый тик сборщика
 * дошёл до середины, — а повтор каждого стоит денег. Поэтому дедуп у каждого
 * свой и сильнее, чем в обычном пути:
 *  - расход в he_projects — только при delivery.projectBooked=false; флаг
 *    ставится по подтверждённой записи и сразу уходит в файл списка (рестарт
 *    посреди хвоста не прибавит второй раз). Остаток прежний (см.
 *    HeStrandedDelivery): прибавка, которая легла, но ответа не дала,
 *    прибавится повторно — завышенная воронка, без повтора работы;
 *  - дочейн research-стадии — см. landedChainBlocker;
 *  - followups автопилота — см. landedFollowupBlocker.
 * Сбой чтения дедупа бросается: «не знаем» не равно «нет», и сборщик повторит
 * хвост следующим тиком.
 */
async function finishLandedDoneRow(
  client: HeWorkerDb,
  job: HeJob,
  delivery: HeStrandedDelivery,
): Promise<void> {
  const { tokensUsed, costUsd } = delivery;
  if (!delivery.projectBooked) {
    delivery.projectBooked = await accumulateProjectUsage(client, job.project_id, tokensUsed, costUsd);
    if (delivery.projectBooked) persistStrandedJobs();
  }
  const nextStage = NEXT_RESEARCH_STAGE[job.stage];
  if (nextStage) {
    const blocker = await landedChainBlocker(client, job);
    if (blocker) {
      log('info', `Job ${job.id} (${job.stage}) хвост легшей done-строки: ${nextStage} не ставим — ${blocker}`);
    } else {
      // Свой сбой постановки дочейн обрабатывает сам (повторы, затем проект
      // 'failed' с причиной) и наружу не бросает.
      await chainNextResearchStage(client, job);
    }
  }
  if (job.stage === 'chain' || job.stage === 'base_analyze') {
    const blocker = await landedFollowupBlocker(client, job);
    if (blocker) {
      log('info', `Job ${job.id} (${job.stage}) хвост легшей done-строки: followups не ставим — ${blocker}`);
    } else {
      try {
        const followups = await enqueueAutopilotFollowups(client, job);
        const summary = Object.entries(followups)
          .map(([stage, outcome]) => `${stage}=${outcome}`)
          .join(' ');
        if (summary) log('info', `Job ${job.id} (${job.stage}) autopilot followups: ${summary}`);
      } catch (e) {
        log('error', `Job ${job.id} (${job.stage}) autopilot followups failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  log(
    'info',
    `Job ${job.id} (${job.stage}) → done: хвост легшей done-строки доведён сборщиком `
      + `(+${tokensUsed} tok, $${costUsd.toFixed(6)}, he_projects ${delivery.projectBooked ? 'учтён' : 'НЕ учтён'})`,
  );
}

/**
 * Почему хвост легшей done-строки НЕ ставит следующую research-стадию (null —
 * ставить можно; дальше обычный chainNextResearchStage с его собственным
 * дедупом по pending/running).
 *
 * Обычный дедуп здесь слаб: между обрывом и хвостом следующая стадия могла уже
 * отработать — тик, где сборщик не прочитал статус, а клейм прошёл, — и тогда
 * pending/running-строки нет, а вставка оплатила бы стадию второй раз. Поэтому
 * смотрим research-строки проекта, созданные ПОСЛЕ этой джобы, в любом
 * статусе. Источник у такой строки один из двух: наш же дочейн, легший до
 * обрыва, или новый запуск research (enqueueHeResearchJob пускает его, как
 * только активных research-джоб нет, а эта уже 'done'). В обоих случаях
 * ставить нечего.
 *
 * Второе условие — проект всё ещё 'researching'. Хвост приходит позже обычной
 * финализации (минуты, а при лежащей БД и дольше), и за это время cancel-роут
 * мог перевести проект в 'draft', а отказ — в 'failed': дочейн после этого —
 * платная стадия проекта, который её не ждёт.
 */
async function landedChainBlocker(client: HeWorkerDb, job: HeJob): Promise<string | null> {
  const [newer, project] = await Promise.all([
    client
      .from('he_jobs')
      .select('stage, status')
      .eq('project_id', job.project_id)
      .in('stage', [...RESEARCH_STAGES])
      .neq('id', job.id)
      .gt('created_at', job.created_at)
      .limit(1),
    client.from('he_projects').select('status').eq('id', job.project_id).maybeSingle(),
  ]);
  if (newer.error) throw new Error(`he_jobs landed-chain dedup read: ${newer.error.message}`);
  if (project.error) throw new Error(`he_projects landed-chain status read: ${project.error.message}`);
  const row = (newer.data ?? [])[0] as { stage?: string; status?: string } | undefined;
  if (row) return `после этой джобы уже создана research-строка ${row.stage} (${row.status})`;
  const projectStatus = (project.data as { status?: string } | null)?.status;
  if (projectStatus !== 'researching') return `проект уже '${projectStatus ?? 'удалён'}'`;
  return null;
}

/**
 * Почему хвост легшей done-строки НЕ ставит followups автопилота (null —
 * ставить можно; дальше enqueueAutopilotFollowups со своими проверками, в том
 * числе autopilot проекта).
 *
 * Их собственный дедуп видит только живое: для chain — базу вертикали в
 * collecting/analyzing/analyzed, для base_analyze — pending/running
 * template-джобу базы. Если постановка легла до обрыва, а поставленное успело
 * отработать (template — done) или упасть (сборка — 'failed'), повтор купил бы
 * письма или сборку второй раз. Поэтому ищем то, что постановка создаёт, в
 * любом статусе, созданное ПОСЛЕ этой джобы: для chain — авто-базу вертикали,
 * для base_analyze — template-джобу той же базы. Её мог поставить и человек
 * (кнопка сборки, «Start outreach») — тогда ставить тем более нечего.
 */
async function landedFollowupBlocker(client: HeWorkerDb, job: HeJob): Promise<string | null> {
  if (job.stage === 'chain') {
    const verticalId = typeof job.payload?.vertical_id === 'string' ? job.payload.vertical_id : null;
    // Без вертикали followup сам ничего не поставит (no_vertical_in_job).
    if (!verticalId) return null;
    const { data, error } = await client
      .from('he_bases')
      .select('id, status')
      .eq('vertical_id', verticalId)
      .eq('source', 'auto')
      .gt('created_at', job.created_at)
      .limit(1);
    if (error) throw new Error(`he_bases landed-followup dedup read: ${error.message}`);
    const row = (data ?? [])[0] as { id?: string; status?: string } | undefined;
    return row ? `после этой джобы у вертикали уже создана авто-база ${row.id} (${row.status})` : null;
  }
  if (job.stage === 'base_analyze') {
    const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
    // Без базы followup сам ничего не поставит (no_base_in_job).
    if (!baseId) return null;
    const { data, error } = await client
      .from('he_jobs')
      .select('id, status')
      .eq('project_id', job.project_id)
      .eq('stage', 'template')
      .eq('payload->>base_id', baseId)
      .gt('created_at', job.created_at)
      .limit(1);
    if (error) throw new Error(`he_jobs landed-followup dedup read: ${error.message}`);
    const row = (data ?? [])[0] as { id?: string; status?: string } | undefined;
    return row ? `после этой джобы по базе уже создана template-джоба ${row.id} (${row.status})` : null;
  }
  return null;
}

/**
 * Ремонт базы после ФИНАЛЬНОГО фейла base_collect. Решение принимается по
 * ТЕРМИНАЛЬНОСТИ статуса (HE_BASE_TERMINAL_STATUSES), а не по списку знакомых
 * нетерминальных: 'analyzing' лечится, любой другой НЕтерминальный — валится,
 * терминальный — не трогается. Так путь не обходит статус, о котором не знал
 * автор правки (новый статус завтра).
 *
 * Разбору статуса предшествует тест ИСТОЧНИКА (`source='auto'`, тот же, с
 * которого начинается сама стадия): базу специалиста — CSV в 'uploaded' — этот
 * ремонт не валит и не анализирует. Единственная запись, которая идёт ДО чтения
 * источника, — фолбэк на нечитаемой строке, и его CAS по 'collecting' в
 * staff-базу попасть не может: 'collecting' выставляет только авто-сборка, роут
 * загрузки CSV создаёт базу в 'uploaded'.
 *
 *  - НЕтерминальный, кроме 'analyzing' (штатно — 'collecting') — до harvest:
 *    собранного нет, база уходит в 'failed' с причиной. Иначе она навсегда
 *    остаётся «живой» для collect-роута и держит partial unique index
 *    he_bases_one_collecting_per_vertical.
 *  - 'collecting' у ночного долива ENG (payload.refill) — исключение из
 *    предыдущего пункта: у такой базы срез мог быть уже куплен (гейт, джоба
 *    конструктора), и закрывает её терминал долива с серией отказов
 *    (closeHeRefillBaseAfterFinalFail, stages/baseCollect.ts): 'failed' на
 *    первом отказе подряд, 'analyzed' со строками среза со второго, строка
 *    прогона 'failed', джоба конструктора отменена. Не вышло до записи базы —
 *    прежний 'failed'.
 *  - 'analyzing' — harvest УЖЕ прошёл: строки собраны, конструктор оплачен,
 *    умерла только вставка base_analyze (stages/baseCollect.ts делает её
 *    отдельным запросом после перевода базы в 'analyzing'). Обычно пару
 *    закрывает сама стадия на ПЕРВОМ же повторе (её start-guard узнаёт
 *    'analyzing' с непустыми row_count/columns и бесплатно доставляет анализ),
 *    так что сюда доезжают только те базы, чья сборка не дожила до повтора
 *    вовсе — отменена, исчерпала попытки на другом отказе, умерла с подом.
 *    Здесь база
 *    ГОДНА к анализу, и правильный ремонт — поставить пропавшую джобу
 *    анализа, а не выбросить оплаченные строки в 'failed' ради выхода из
 *    подвисшего состояния. Вставка в he_jobs бесплатна, анализ подхватит
 *    автопилот дальше (base_analyze done → template). Сам ремонт и предикат
 *    живости — общие с автопилотом и клиентским роутом «Start outreach»
 *    (lib/hypothesisEngine/autopilotNext: isAnalyzingBaseLive,
 *    repairOrphanAnalyzingBase), чтобы три контура не расходились в том, что
 *    считать живой базой и что делать с осиротевшей.
 *
 * 'failed' остаётся фолбэком ровно там, где анализ невозможен: живого анализа
 * нет и анализировать нечего (нет строк/колонок) или в этом конвейере анализа
 * не бывает вовсе (refill). Иначе база без живой джобы висела бы в 'analyzing'
 * навсегда, а автопилот вертикали считал бы её подготовленной и больше ничего
 * не ставил.
 *
 * Сбой самой постановки анализа — НЕ 'failed': repairOrphanAnalyzingBase
 * бросает, и база с оплаченными строками остаётся 'analyzing' (catch ниже
 * только пишет строку лога). 'failed' здесь вернул бы её компании в пул, и
 * следующая сборка купила бы их заново. Бесплатную вставку повторит следующий
 * ремонт той же сироты (завершение цепочки писем, «Start outreach», ночной
 * проход автопилота, если он включён). У RU-инструмента (autopilot = false)
 * этих контуров нет: база остаётся 'analyzing', как до ветки, где этот ремонт
 * 'analyzing' не трогал вовсе.
 */
async function repairBaseAfterCollectFinalFail(
  client: HeWorkerDb,
  job: HeJob,
  baseId: string,
  msg: string,
) {
  /**
   * Терминальная запись с CAS по НАБЛЮДЁННОМУ статусу: пишем 'failed' только
   * поверх того самого нетерминального статуса, который мы прочитали. Раньше в
   * CAS было зашито 'collecting' — единственный статус, который путь умел
   * лечить.
   */
  const markNonTerminalFailed = async (fromStatus: string, error: string) => {
    await client
      .from('he_bases')
      .update({
        status: 'failed',
        error: error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', baseId)
      .eq('status', fromStatus);
  };

  const { data: baseRow, error: baseErr } = await client
    .from('he_bases')
    // `source` — сверх общего списка полей: этот контур единственный, кто читает
    // базу по base_id из payload джобы, не отобрав её заранее по source='auto'
    // (автопилот и клиентский роут запуска фильтруют источник в своих выборках).
    .select(`${HE_ANALYZING_BASE_FIELDS}, source`)
    .eq('id', baseId)
    .maybeSingle();
  // Сбой чтения — прежнее поведение: валим только 'collecting'. Про
  // 'analyzing' без чтения судить нельзя (можно убить живой анализ).
  if (baseErr || !baseRow) {
    await markNonTerminalFailed('collecting', msg);
    return;
  }
  const base = baseRow as unknown as HeAnalyzingBase;
  const baseStatus = typeof base.status === 'string' && base.status ? base.status : null;
  // Статус не прочитался значением — тот же случай «неизвестно», что выше.
  if (!baseStatus) {
    await markNonTerminalFailed('collecting', msg);
    return;
  }
  /**
   * НЕ АВТО-БАЗА — не наша, ремонт её не касается ни в какую сторону.
   *
   * Тот же тест источника, которым начинается сама стадия (stages/baseCollect:
   * `base.source !== 'auto'` → отказ), и стоит он ДО разбора статуса: решение по
   * терминальности статуса для чужой базы бессмысленно в обе стороны. Без него
   * ветка «любой нетерминальный статус → failed» пишет 'failed' поверх
   * 'uploaded' — то есть поверх ЖИВОЙ базы, которую специалист только что залил
   * CSV в /tools/hypothesis-engine и которая ждёт своего base_analyze, — а по
   * 'analyzing' чужой базы ремонт поставил бы ВТОРОЙ платный base_analyze.
   * Сегодня путь сюда недостижим (джобу base_collect ставят только вместе с
   * авто-базой, и start-guard стадии другой source не пускает), поэтому проверка
   * — не лечение живого дефекта, а сохранение инварианта: первая же будущая
   * «пересборка адресов для загруженной базы» иначе стоила бы staff-базы.
   */
  const baseSource = typeof base.source === 'string' && base.source ? base.source : null;
  if (baseSource !== 'auto') {
    log(
      'info',
      `Job ${job.id} (base_collect) base ${baseId}: source='${baseSource ?? 'upload'}' — не авто-база, ремонт её не трогает`,
    );
    return;
  }
  // Терминальный статус (стадия сама свалила базу с ПРИЧИНОЙ — «ноль строк»,
  // отказ пробы среза; так выглядели базы Franchise Brands 12.08) — не трогаем:
  // текст start-guard перетёр бы осмысленную причину.
  if (HE_BASE_TERMINAL_STATUSES.has(baseStatus)) return;
  // Ночной долив ENG (payload.refill ставит только крон для market='us'):
  // судьбу компаний решает серия отказов, как у отказа долива и таймаута
  // конструктора, строка прогона закрывается 'failed', а джоба конструктора
  // отменяется (closeHeRefillBaseAfterFinalFail). Раньше здесь всегда писалось
  // 'failed' — компании возвращались каждую ночь, и тот же срез покупался
  // заново без предела. Не вышло до записи базы — прежний путь ниже.
  if (job.payload?.refill === true && baseStatus === 'collecting') {
    try {
      await closeHeRefillBaseAfterFinalFail(
        { supabase: client, log: (m) => log('info', `Job ${job.id} (base_collect) ${m}`) },
        job,
        baseId,
        msg,
      );
      return;
    } catch (e) {
      log(
        'error',
        `Job ${job.id} (base_collect) base ${baseId}: refill-ремонт с серией отказов не удался `
          + `(${e instanceof Error ? e.message : String(e)}) — пробую закрыть базу прежним путём (failed, компании в пул); не выйдет — повторит сборщик брошенных строк`,
      );
    }
  }
  // Любой нетерминальный статус, КРОМЕ 'analyzing', собранного не имеет: сборка
  // умерла до harvest, спасать нечего — база уходит в 'failed' с причиной.
  // 'collecting' (штатный статус авто-сборки) и любой третий нетерминальный
  // статус идут одним путём, а не так, что первый лечится, а остальные висят.
  if (baseStatus !== 'analyzing') {
    await markNonTerminalFailed(baseStatus, msg);
    return;
  }

  // Живость — ОБЩИМ предикатом автопилота и кабинета, но с graceMs=0: смерть
  // тут наблюдаемая, а не выведенная из снапшота (упала та самая base_collect,
  // которая и должна была поставить анализ), и окно ожидания только помешало бы
  // лечить — секунду назад harvest как раз и выставил 'analyzing'.
  let liveBaseIds: Set<string>;
  try {
    liveBaseIds = await liveHeJobBaseIds(client, job.project_id);
  } catch (e) {
    // «Неизвестно» ≠ «мертва»: без списка активных джоб базу не трогаем.
    log(
      'error',
      `Job ${job.id} (base_collect) base ${baseId}: активные джобы не прочитаны (${e instanceof Error ? e.message : String(e)}) — базу не трогаем`,
    );
    return;
  }
  if (isAnalyzingBaseLive(base, liveBaseIds, 0)) {
    log('info', `Job ${job.id} (base_collect) base ${baseId}: analyzing с живой джобой по базе — не трогаем`);
    return;
  }

  try {
    const verdict = await repairOrphanAnalyzingBase(client, {
      projectId: job.project_id,
      base,
      reason: msg,
      // Refill-конвейер анализа не делает вовсе — там только 'failed'.
      refill: job.payload?.refill === true,
    });
    if (verdict === 'reanalyzed') {
      const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
      log(
        'info',
        `Job ${job.id} (base_collect) base ${baseId}: осиротевший analyzing вылечен постановкой base_analyze (${rowCount} собранных строк сохранены)`,
      );
    } else {
      // 'failed' — анализировать нечего (нет строк/колонок, refill); точная
      // причина уже в he_bases.error. Сбой самой постановки сюда не приходит:
      // он бросает, и его ловит catch ниже.
      log(
        'error',
        `Job ${job.id} (base_collect) base ${baseId}: осиротевший analyzing не удалось довести до анализа → failed`,
      );
    }
  } catch (e) {
    // Ремонт не записался (в том числе не удалась постановка анализа) — база
    // остаётся в 'analyzing' до следующего прохода (автопилот вертикали или
    // повторный «Start outreach» кабинета её долечат).
    // Бросать наверх нельзя: failJob вызван из catch pollOnce.
    log(
      'error',
      `Job ${job.id} (base_collect) base ${baseId}: ремонт осиротевшего analyzing не удался: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Сколько ждать до повтора, если провайдер попросил подождать (429).
 * Попытку это НЕ экономит (см. RATE_LIMIT_PAUSE_DEFAULT_MS) — только отодвигает
 * повтор на время, которое назвал сам провайдер.
 */
function rateLimitPauseMs(retryAfterMs: number | undefined): number {
  return Math.min(
    RATE_LIMIT_PAUSE_MAX_MS,
    Math.max(1_000, retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : RATE_LIMIT_PAUSE_DEFAULT_MS),
  );
}

/**
 * Записать отказ джобы. Все запросы идут под сроком участка после стадии
 * (POST_STAGE_DEADLINE_MS): сторож простоя здесь уже снят, и молчащий PostgREST
 * иначе держал бы ВСЮ очередь движка при зелёном healthcheck.
 */
async function failJob(job: HeJob, err: unknown): Promise<boolean> {
  let written = false;
  const finished = await withPostStageDeadline(job, 'fail write', async (client, signal) => {
    written = await writeJobFailure(client, job, err, signal);
  });
  return finished && written;
}

/** Возвращает, ДОЕХАЛА ли запись отказа до строки (читатель — collectStrandedJobs). */
async function writeJobFailure(
  client: HeWorkerDb,
  job: HeJob,
  err: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  const msg = err instanceof Error ? err.message : String(err);
  /**
   * То же сообщение, но пригодное для Postgres: в msg приезжает тело ответа
   * провайдера и текст модели, а NUL и одиночный UTF-16 суррогат не хранятся ни
   * в text, ни в jsonb — PostgREST отвергает ВЕСЬ апдейт. Отвергнутая запись
   * отказа оставляла бы джобу в 'running' и прятала саму причину отказа.
   */
  const safeMsg = stripUnstorableJsonChars(msg);
  // Отменённая пользователем джоба: стадия упала по AbortSignal. Это не фейл —
  // не инкрементируем attempts, не затираем 'cancelled', не валим проект/базу.
  // Чтение — быстрый путь для лога; если оно не прочиталось (или отмена легла
  // ПОСЛЕ него), 'cancelled' защищает CAS самой записи отказа ниже.
  const { data: currentBefore } = await client
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (currentBefore && (currentBefore as { status: string }).status === 'cancelled') {
    log('info', `Job ${job.id} (${job.stage}) aborted by user cancel`);
    return true;
  }

  // Что ответил провайдер модели — ТИПОМ (heLlmFailureOf), не текстом. Классы
  // llm.ts выделил ещё в этой волне, но читателя у них не было: rate limit и
  // отказ по балансу шли общим путём «обычный фейл», то есть сгорали тремя
  // попытками за ~10 секунд и переплачивали стадию целиком.
  const llmFailure = heLlmFailureOf(err);
  // Провайдер попросил подождать (429 + Retry-After): повтор отодвигаем на его
  // паузу, но попытку ТРАТИМ. Бесплатная стоянка (пять штук, обнулявшихся любым
  // обычным фейлом) стоила до 18 полных платных прогонов стадии вместо трёх —
  // см. RATE_LIMIT_PAUSE_DEFAULT_MS. Ценность осталась: ждём провайдера, а не
  // сжигаем три попытки за десять секунд.
  const rateLimited = llmFailure?.kind === 'rate_limit';
  // Баланс и конфигурация: ответ терминальный с первого раза. Повтор не меняет
  // ничего (баланс за 5 секунд не пополняется, ключ сам не починится), а стоит
  // ДВА полных прогона стадии — то есть заново оплачивает все вызовы, которые
  // она успела сделать до отказа. Причина в he_jobs.error уже английская
  // («Requesty 402: …»), кабинет сворачивает её в 'billing'/'configuration'.
  // ТОТ ЖЕ вопрос поисковому провайдеру: «Serper billing: insufficient search
  // credits.» / «Serper configuration: …» перманентны с первого ответа, и
  // следующий прогон стадии получит их снова — уже заплатив за всё, что успел.
  const searchRefusal = heSearchRefusalOf(err);
  const terminalProviderRefusal =
    llmFailure?.kind === 'billing' || llmFailure?.kind === 'configuration' || searchRefusal !== null;
  // Терминальный отказ стадии: повтор оплатит её заново и получит тот же ответ.
  // Дискриминант heJobTerminal носят ДВА класса, и они разные новости:
  // HeJobResultWriteError («результат оплачен, но не сохранился» — здешний и
  // тот, которым сборщик закрывает брошенную строку) и HeVocabEmptyError
  // (stages/vocab.ts: обязательный список словаря пуст или отсутствует и после
  // повтора, платить за это трижды не за что).
  // Поэтому ниже в лог уходит ИМЯ класса, а не выдумка про запись результата.
  const terminalStageFailure = isHeJobTerminal(err);

  // Прерывание (сторож простоя, рестарт воркера, обрыв чтения проекта до
  // стадии): работа не выполнялась, платить попыткой не за что. Признак —
  // ТИП ошибки, не её текст. Бесплатность ограничена: после
  // HE_JOB_FREE_INTERRUPTIONS подряд прерывание считается обычной попыткой,
  // иначе застрявшая стадия крутилась бы бесплатно вечно.
  const interrupted = isHeJobInterruption(err);
  const interruptions = interrupted ? heJobInterruptions(job.payload) + 1 : 0;
  const free = interrupted && interruptions <= HE_JOB_FREE_INTERRUPTIONS;
  // attempts — число фейлов, а не клеймов: инкремент только здесь.
  const nextAttempts = job.attempts + (free ? 0 : 1);
  const finalFail =
    !free && (terminalProviderRefusal || terminalStageFailure || nextAttempts >= MAX_ATTEMPTS);
  const pauseMs = rateLimited && !finalFail ? rateLimitPauseMs(llmFailure?.retryAfterMs) : 0;
  if (terminalStageFailure) {
    log(
      'error',
      `Job ${job.id} (${job.stage}) terminal stage failure (${err instanceof Error ? err.name : 'unknown'}) `
        + `on attempt ${nextAttempts}/${MAX_ATTEMPTS} — повтор стадии не назначается `
        + `(он оплатил бы стадию заново и получил тот же ответ): ${msg}`,
    );
  } else if (terminalProviderRefusal) {
    // Какой именно провайдер отказал — в логе прогона: клиентский текст у
    // обоих сворачивается в один код кабинета ('billing'/'configuration'), и
    // специалист иначе не поймёт, кому пополнять баланс.
    const refusalProvider = searchRefusal ? 'search' : 'model';
    const refusalKind = searchRefusal ? searchRefusal.kind : llmFailure?.kind;
    const refusalStatus = searchRefusal ? searchRefusal.httpStatus : llmFailure?.status;
    log(
      'error',
      `Job ${job.id} (${job.stage}) terminal ${refusalProvider} provider refusal (${refusalKind}`
        + `${refusalStatus ? `, HTTP ${refusalStatus}` : ''}) on attempt ${nextAttempts}/${MAX_ATTEMPTS} `
        + `— повтор стадии не назначается: ${msg}`,
    );
  } else if (free) {
    log(
      'warn',
      `Job ${job.id} (${job.stage}) interrupted (${heJobInterruptionKind(err)}) `
        + `${interruptions}/${HE_JOB_FREE_INTERRUPTIONS} in a row `
        + `(attempt ${job.attempts}/${MAX_ATTEMPTS} not spent): ${msg}`,
    );
  } else if (interrupted) {
    log(
      'error',
      `Job ${job.id} (${job.stage}) interrupted (${heJobInterruptionKind(err)}) ${interruptions} times in a row `
        + `— free retries exhausted, counted as attempt ${nextAttempts}/${MAX_ATTEMPTS}: ${msg}`,
    );
  } else if (rateLimited) {
    log(
      'warn',
      `Job ${job.id} (${job.stage}) rate-limited by provider (attempt ${nextAttempts}/${MAX_ATTEMPTS} spent)`
        + `${pauseMs ? `, повтор не раньше чем через ${pauseMs}ms` : ' — попытки исчерпаны'}: ${msg}`,
    );
  } else {
    log('error', `Job ${job.id} (${job.stage}) failed (attempt ${nextAttempts}/${MAX_ATTEMPTS}): ${msg}`);
  }

  // Серия прерываний закрывается ОБЫЧНЫМ фейлом тоже: между двумя прерываниями
  // была засчитанная попытка — значит они уже не «подряд» (clearHeJobRetryState).
  const clearedPayload = interrupted ? null : clearHeJobRetryState(job.payload);
  /**
   * Чем прогон закончился — тем и определяется, КОГДА его повторять.
   *
   *  - прерывание: возвращается как не начинавшееся (счётчик серии в payload,
   *    пауза в run_after — без неё повтор упирался бы в ту же недоступную БД
   *    сразу, started_at сброшен, как это делал bulk-апдейт resetStuckJobs до
   *    волны 3);
   *  - rate limit: та же пауза, но попытка потрачена (см. выше);
   *  - обычный фейл: повтор сразу, как раньше, но серия прерываний закрыта.
   */
  const retryState: Record<string, unknown> = {};
  if (interrupted) {
    retryState.payload = stripUnstorableJsonChars({ ...job.payload, interruptions });
    retryState.run_after = new Date(
      Date.now() + Math.min(INTERRUPTION_RETRY_BASE_MS * 2 ** (interruptions - 1), INTERRUPTION_RETRY_MAX_MS),
    ).toISOString();
    retryState.started_at = null;
  } else {
    if (clearedPayload) retryState.payload = stripUnstorableJsonChars(clearedPayload);
    if (pauseMs) {
      retryState.run_after = new Date(Date.now() + pauseMs).toISOString();
      retryState.started_at = null;
    }
  }
  // Текст ошибки и payload чистим: NUL и одиночный суррогат Postgres не хранит
  // ни в text, ни в jsonb, а в msg приезжает тело ответа провайдера и текст
  // модели. Отвергнутая запись отказа оставляла бы джобу 'running' — то есть
  // прятала бы саму причину отказа.
  const failRow = {
    status: finalFail ? 'failed' : 'pending',
    attempts: nextAttempts,
    error: safeMsg.slice(0, 500),
    finished_at: finalFail ? new Date().toISOString() : null,
    ...retryState,
    updated_at: new Date().toISOString(),
  };
  /**
   * Запись отказа при блипе БД ПОВТОРЯЕМ. Это ровно тот случай, когда
   * транзиентный отказ БД стоил ЦЕЛОЙ ДЖОБЫ: апдейт отвергался, строка
   * оставалась 'running', и подобрать её было некому до следующего рестарта
   * процесса — вместе с ней стоял весь проект, потому что воркер single-flight.
   * Повторяется ЗАПРОС: он адресован по id и идемпотентен (одни и те же
   * attempts, run_after считается до цикла), поэтому лишних прогонов стадии не
   * появляется ни одного. Не легла и после повторов — вызывающий отдаёт
   * строку сборщику (pollOnce, resetStuckJobs → markJobStranded).
   *
   * Запись — с CAS по статусу: она ложится только поверх 'running', 'pending'
   * (self-requeue base_collect) или 'failed' (повтор, чей первый ответ
   * потерялся, хотя запись легла), но НИКОГДА поверх 'cancelled' и 'done'.
   * Без CAS отмена, легшая между чтением выше и записью (или между попытками
   * повтора), перетиралась 'pending' — отменённая работа воскресала и снова
   * оплачивалась; а 'done' стирал бы сохранённый результат оплаченной стадии.
   * Сколько строк задето, читаем из ответа (select): ноль — строка закрыта
   * без нас, и проект/базу этот отказ не трогает, как и ветка отмены выше.
   */
  let failErrMsg: string | null = null;
  let failLanded = true;
  for (let attempt = 1; attempt <= FAIL_WRITE_ATTEMPTS; attempt += 1) {
    const { data: landed, error, status } = await client
      .from('he_jobs')
      .update(failRow)
      .eq('id', job.id)
      .in('status', ['running', 'pending', 'failed'])
      .select('id');
    if (!error) {
      failErrMsg = null;
      failLanded = Array.isArray(landed) && landed.length > 0;
      break;
    }
    failErrMsg = error.message;
    // Срок участка истёк (запросы оборваны) или отказ не блип — повторять нечем.
    if (attempt >= FAIL_WRITE_ATTEMPTS || signal?.aborted || !isTransientDbError(error, status)) break;
    log(
      'error',
      `Job ${job.id} (${job.stage}) fail update rejected (attempt ${attempt}/${FAIL_WRITE_ATTEMPTS}), `
        + `повторяем — блип БД: ${error.message}`,
    );
    await sleep(FAIL_WRITE_RETRY_BASE_MS * attempt);
  }
  // Сбой записи отказа виден в логе: без него джоба осталась бы 'running' до
  // рестарта, и причина (та, что в msg) не попала бы никуда вообще.
  const failErr = failErrMsg ? { message: failErrMsg } : null;
  if (failErr) {
    log('error', `Job ${job.id} (${job.stage}) fail update rejected: ${failErr.message} (причина отказа: ${msg})`);
  } else if (!failLanded) {
    log(
      'info',
      `Job ${job.id} (${job.stage}) отказ не записан: строка уже закрыта без воркера `
        + `(отменена пользователем, завершена или удалена) — проект и базу не трогаем: ${msg}`,
    );
    return true;
  }

  // Отказ, который чинит только команда (деньги/ключ провайдера), — алерт в
  // health-бот; только ENG, RU отбрасывает opsAlert. Здесь, а не в ветке
  // финального фейла: текстовый случай (стадия записала причину в he_bases.error
  // и бросила обычный Error) клиент видит уже с ПЕРВОЙ попытки. Не легла запись
  // (failErr) — алерт всё равно уходит: тот же отказ допишет сборщик, а повтор
  // алерта погасит дедуп opsAlert. Отмена/закрытая строка выше — без алерта.
  const opsStop = heOpsStopOf(llmFailure, searchRefusal, msg);
  if (opsStop) alertTeamOnClientStop(job, opsStop, msg);

  // Финальный фейл research-стадии валит весь research-пайплайн проекта.
  if (finalFail && RESEARCH_STAGES.has(job.stage)) {
    await client
      .from('he_projects')
      .update({
        status: 'failed',
        error: `${job.stage}: ${safeMsg}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id);
  }

  // Финальный фейл base_collect: без ремонта he_bases навсегда остаётся в
  // нетерминальном статусе — 'collecting' (collect-роут продолжает отдавать
  // базу как живую) или 'analyzing' (автопилот считает её подготовленной).
  // Что именно делать с базой — в repairBaseAfterCollectFinalFail. payload
  // может не содержать base_id — тогда просто не трогаем базу.
  if (finalFail && job.stage === 'base_collect') {
    const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
    if (baseId) await repairBaseAfterCollectFinalFail(client, job, baseId, safeMsg);
  }

  return !failErr;
}

async function pollOnce(): Promise<boolean> {
  // Брошенные строки закрываем ДО клейма: пока такая строка висит в 'running',
  // её проект стоит, а воркер один на всех.
  await collectStrandedJobs();
  const job = await claimJob();
  if (!job) return false;
  // Клейм прошёл только поверх 'pending' — значит брошенная запись по этой
  // строке устарела (сборщик, прочитай он статус в этом тике, вычеркнул бы её
  // сам). Иначе её прежний результат (например {waiting} тика base_collect)
  // позже доставился бы поверх НОВОГО прогона.
  if (strandedJobs.has(job.id)) forgetStrandedJob(job.id);
  try {
    await handleJob(job);
  } catch (err) {
    // Запись отказа не легла (БД лежит дольше её повторов или истёк срок
    // участка) — строка осталась 'running'. Раньше её не подбирал никто до
    // рестарта, а рестарт закрывал её бесплатным прерыванием: оплаченная
    // стадия, чей результат уже отвергнут (HeJobResultWriteError), или
    // терминальный отказ провайдера исполнялись заново. Сборщик допишет ТОТ ЖЕ
    // отказ, как только БД ответит.
    if (!(await failJob(job, err))) markJobStranded(job, 'fail write did not land', { failure: err });
  }
  return true;
}

async function main() {
  log('info', 'Hypothesis Engine worker starting…');

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);
  // До первой стадии: дальше ключ читает getApiKey() на каждом вызове модели.
  applyEngineProviderKey();
  // Порядок бюджетов печатаем на старте: «срок одного запроса к модели <
  // окно простоя» — то условие, без которого здоровый платный вызов снова
  // объявят зависанием. Числа читаются из llm.ts, поэтому в логе видно и
  // действующий HE_LLM_TIMEOUT_MS.
  log(
    'info',
    `Stage watchdog: ${stageIdleTimeoutMs()}ms idle `
      + `(≥ ${LLM_SILENCE_SAFETY_FACTOR}× LLM attempt ${heLlmMaxAttemptMs()}ms, floor ${STAGE_IDLE_FLOOR_MS}ms), `
      + `abort grace ${STAGE_ABORT_GRACE_MS}ms, free interruptions ${HE_JOB_FREE_INTERRUPTIONS}, `
      + `rate-limit pause ≤ ${RATE_LIMIT_PAUSE_MAX_MS}ms (попытка тратится), `
      + `post-stage deadline ${POST_STAGE_DEADLINE_MS}ms, `
      // Срок клиента стадий печатаем рядом с окном сторожа: порядок «срок
      // запроса к БД < окно простоя» — то условие, при котором вставшее тело
      // кончается САМО, а не аварийным выходом процесса. Это срок на заголовки и
      // на ПАУЗУ между кусками тела, не на всё чтение.
      + `stage DB per-request ${HE_STAGE_DB_TIMEOUT_MS}ms (headers / body-chunk pause)`,
  );

  // Брошенные строки прошлого процесса этого контейнера — ДО resetStuckJobs:
  // иначе он закрыл бы их бесплатным прерыванием (см. strandedJobs).
  loadStrandedJobs();
  await resetStuckJobs();

  try {
    await pollLoop({
      log,
      pollIntervalMs: POLL_INTERVAL_MS,
      shouldStop,
      pollOnce,
      realtimeTables: ['he_jobs'],
    });
    // Последний проход сборщика перед остановкой: список переживает
    // `docker restart`, но не пересоздание контейнера при деплое. Не дольше
    // минуты: при лежащей БД чтение статуса через `db` может висеть минутами,
    // а остановку (stop_grace_period) держать нечем — файл списка уже записан.
    await Promise.race([
      collectStrandedJobs(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 60_000).unref?.();
      }),
    ]);
    // Список ENG-проектов, остановленных тем же отказом провайдера, копится до
    // конца окна свёртки (opsAlert.ts) — отправляем его до выхода, иначе он
    // умрёт с процессом. Пусто (RU-трафик, отказов не было) — сразу дальше;
    // ждать дольше срока отправки opsAlert не будет.
    await flushHeOpsAlerts();
  } finally {
    clearInterval(heartbeat);
  }

  log('info', 'Hypothesis Engine worker stopped');
  process.exit(0);
}

void main();
