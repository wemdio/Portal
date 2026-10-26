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
 * Заблокированный ENG-аккаунт (S3b): перед стадией джобы us-проекта воркер
 * читает отметку блокировки владельца (engBlockedSweep.guardHeEngJobOwner):
 * заблокирован — джоба гасится и стадия не идёт; отметка не прочиталась —
 * джоба возвращается в очередь с паузой, попытка не тратится. Между джобами —
 * фоновая проверка заблокированных аккаунтов (heEngBlockSweep ниже).
 *
 * Живость стадии (волна 3): у каждой стадии есть сторож простоя
 * (createHeJobWatchdog). Он считает окно от ПОСЛЕДНЕЙ активности — строки лога
 * стадии, запроса к БД (withStageActivity), завершённой операции
 * ввода-вывода (ctx.onActivity, stages/io.ts) или попытки запроса к модели
 * (канал активной джобы, lib/hypothesisEngine/llm.ts) — и в режиме 'enforce'
 * (дефолт, HE_STAGE_WATCHDOG_MODE) прерывает молчащую стадию,
 * а если та игнорирует abort, процесс выходит и его перезапускает docker. В
 * режиме 'log' сторож только пишет, что прервал бы (см. STAGE_WATCHDOG).
 *
 * Переходы строки he_jobs, которые пишет воркер после стадии (done и отказ), —
 * CAS по 'running' И по токену клейма (started_at, который поставил claimJob;
 * см. readHeJobRowAfterCasMiss): отмена, легшая между чтением статуса и
 * записью, больше не затирается 'done', и за отменённой строкой не ставятся ни
 * следующая стадия, ни followups. Тот же контракт обязан держать self-requeue
 * base_collect (requeueSelf в stages/baseCollect.ts).
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
 * вырос снова — план, проба среза, стор плана, расширение, конструктор; запись
 * постановки конструктора с 08.10.2026 из списка ушла — её id резервируется до
 * вставки).
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
import { getHeActiveJobSignal, heLlmFailureOf, heLlmMaxAttemptMs, isHeLlmTimeout, setHeActiveJob, withHeActiveJobScope } from '@/lib/hypothesisEngine/llm';
import { HE_ENG_COLLECTION_CONCURRENCY, selectHeEngCollectionCandidate } from '@/lib/hypothesisEngine/engCollectionQueue';
import type { HeEngCollectionScope } from '@/lib/hypothesisEngine/engCollectionQueue';
import { readHeEngCollectionScope } from '@/lib/hypothesisEngine/engCollectionScope';
import { heWorkerLaneTakes, readHeWorkerLane } from '@/lib/hypothesisEngine/heWorkerLane';
import { withHeEngProjectUsageLock } from '@/lib/hypothesisEngine/engProjectUsage';
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
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
// «Блип БД или приговор» — нейтральный предикат (lib/db/transientError.ts, без
// импортов), общий с конструктором баз и ENG-роутами. Читается ТОЛЬКО там, где
// решается судьба ЗАПРОСА (повторить ту же запись) и судьба джобы, стадия
// которой ещё НЕ НАЧАЛАСЬ. Повтор оплаченной стадии по этому предикату не
// назначается нигде.
import { isTransientDbError } from '@/lib/db/transientError';
import { normalizeHeMarket } from '@/lib/hypothesisEngine/market';
import { markHeJournalGap, openHeProviderJournal, withHeProviderJournal } from '@/lib/hypothesisEngine/costTelemetry';
import type { HeProviderJournal } from '@/lib/hypothesisEngine/costTelemetry';
import {
  HE_ANALYZING_BASE_FIELDS,
  enqueueAutopilotFollowups,
  isAnalyzingBaseLive,
  liveHeJobBaseIds,
  repairOrphanAnalyzingBase,
} from '@/lib/hypothesisEngine/autopilotNext';
import type { HeAnalyzingBase, HeSpendGate } from '@/lib/hypothesisEngine/autopilotNext';
// Потолок расхода us-проекта (P-A-project-spend-ceiling). ПО УМОЛЧАНИЮ
// ВЫКЛЮЧЕН: без HE_US_PROJECT_SPEND_CAP_USD / HE_US_PROJECT_DAY_SPEND_CAP_USD
// ворота дочейна автопилота не делают ни одного запроса и ничего не меняют.
// Цепочку research воркер не проверяет (см. enqueueNextResearchStage).
import { createHeSpendGate } from '@/lib/hypothesisEngine/spendCeiling';
import { closeHeRefillBaseAfterFinalFail } from '@/lib/hypothesisEngine/stages/baseCollect';
import { isHeSearchProviderError } from '@/lib/hypothesisEngine/stages/searchIo';
import type { HeSearchProviderError } from '@/lib/hypothesisEngine/stages/searchIo';
import { isHeResolverFailure, isHeSiteUnreachable } from '@/lib/hypothesisEngine/stages/io';
// Алерт команде в health-бот, когда ENG-проект остановлен отказом, который
// чинит только команда (решение владельца 04.10.2026). Предикат — тот же, по
// которому кабинет сворачивает причину в 'billing'/'configuration'.
import { heTeamFixableFailureOf } from '@/lib/hypothesisEngine/clientErrors';
import {
  HE_JOB_BRAND_INPUTS_KEY,
  HE_JOB_UNPAID_BRAND_INPUT,
  HE_JOB_UNPAID_REFUSAL_KEY,
  heBrandInputRefusalOf,
} from '@/lib/hypothesisEngine/letterBrandGuard';
import { flushHeOpsAlerts, notifyHeClientStop } from '@/lib/hypothesisEngine/opsAlert';
import type { HeOpsStopKind, HeOpsStopProvider } from '@/lib/hypothesisEngine/opsAlert';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';
// Автозапуск ENG (S3): после «Launch» проекта готовый шаблон вертикали
// запускается тем же вызовом, что кнопка «Launch now» кабинета, — тиком между
// джобами (maybeRunHeEngAutoLaunch ниже).
import { heEngAutoLaunchTickMs, runHeEngAutoLaunchTick } from '@/lib/hypothesisEngine/engAutoLaunch';
// Письма ENG-клиенту (S3): события автозапуска и проход по данным в том же тике.
import { runHeEngClientMailScan, sendHeEngClientNotice } from '@/lib/hypothesisEngine/engClientMail';
// Заблокированный ENG-аккаунт (S3b): страж джобы в handleJob и фоновая
// проверка между джобами (heEngBlockSweep ниже).
import { createHeEngBlockSweepTicker, guardHeEngJobOwner } from '@/lib/hypothesisEngine/engBlockedSweep';
import { createHeEngUnverifiedCampaignTicker } from '@/lib/hypothesisEngine/engUnverifiedCampaign';
// «Do not contact» ENG (решение владельца 14.10.2026): снятие людей из списка
// клиента с его идущих кампаний — проход между джобами (heEngDncRemoval ниже).
import { createHeEngDncRemovalTicker } from '@/lib/hypothesisEngine/engDncRemoval';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

const WORKER_ID = `hypothesis-engine-${process.pid}`;
/** Which jobs this process takes; unset = all, the original single process (heWorkerLane.ts). */
const WORKER_LANE = readHeWorkerLane();
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
 * Режим сторожа простоя: HE_STAGE_WATCHDOG_MODE = 'enforce' | 'log'.
 *
 *  - 'enforce' (ДЕФОЛТ, и он же при пустом или нераспознанном значении) —
 *    поведение волны 3: окно молчания → abort джобы (прерывание 'inactivity',
 *    бесплатное до HE_JOB_FREE_INTERRUPTIONS подряд), стадия не ответила за
 *    STAGE_ABORT_GRACE_MS → выход процесса;
 *  - 'log' — сторож ничего не прерывает: на каждое окно молчания пишет строку
 *    «прервал бы» (джоба, стадия, сколько молчит, последняя активность, чего
 *    ждёт процесс) и смотрит дальше. Ложный abort здоровой стадии в этом режиме
 *    невозможен — ради наблюдения за ним режим и существует. Одно исключение:
 *    джоба, уже ОТМЕНЁННАЯ пользователем (её сигнал взведён cancel-наблюдателем),
 *    которая молчит целое окно, идёт путём 'enforce' (grace → выход процесса):
 *    отмена обязана выиграть, а прерывать там уже нечего — её прервал клиент.
 *
 * Почему дефолт — 'enforce', а не 'log' (решение по фактам, ревизия 08.10.2026).
 * 'log' безопасен дефолтом только если КАЖДАЯ операция, которую стадия ждёт,
 * сама кончается за ограниченное время. Ограничены: вызов модели (срок попытки
 * llm.ts, ≤ heLlmMaxAttemptMs, и счётные повторы), поиск и чтение сайта с DNS
 * (withHeDeadline в stages/io.ts), запросы стадии к своей БД (stageDb: срок на
 * заголовки и на паузу в теле), ожидание дочерних джоб (self-requeue, без
 * ожидания внутри процесса). НЕ ограничены на стороне клиента:
 *  - запросы к датасету Instantly (lib/instantlyDataset.ts, pg): statement_timeout
 *    серверный, а молча оборванное TCP-соединение после отправки запроса держит
 *    `await` вечно — RU-пути hypotheses, evidence (якорь %), chain, template,
 *    dossier;
 *  - запросы ночного долива ENG мимо клиента стадий: supabaseInstantly
 *    (lib/supabaseInstantly.ts: локальный PostgREST снимает таймер на
 *    заголовках, у hosted-пути таймера нет вовсе) — пресет и блок-лист долива
 *    (clientLaunch/appendLeads.ts), — и записи журнала доставки через общий
 *    supabaseAdmin (срок только на заголовки, тело не ограничено). HTTP
 *    Instantly у долива ограничен целиком: загрузка — 90 000 мс вместе с телом
 *    (хук активности включает timeoutIncludesBody), замер присутствия —
 *    20 000 мс на запрос и 120 000 мс на весь замер.
 * Пока любое из этого живо, 'log' дефолтом означал бы: зависшая стадия держит
 * односоточный воркер — то есть ВСЕ проекты обоих рынков — до ручного
 * рестарта, при зелёном healthcheck. Поэтому 'log' — только включаемый режим
 * для наблюдения на выкатке.
 */
type HeStageWatchdogMode = 'enforce' | 'log';

function parseHeStageWatchdogMode(raw: string | undefined): { mode: HeStageWatchdogMode; rejected: string | null } {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'log') return { mode: 'log', rejected: null };
  if (!value || value === 'enforce') return { mode: 'enforce', rejected: null };
  return { mode: 'enforce', rejected: raw ?? null };
}

const STAGE_WATCHDOG = parseHeStageWatchdogMode(process.env.HE_STAGE_WATCHDOG_MODE);

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
 *
 * Тот же предел и та же серия — у остановки evidence рынка 'us' с
 * продвинутым чекпойнтом (HeEvidenceProgressResumeError в
 * stages/evidence.ts, род 'evidence_progress'): стадия сама бросает отказ с
 * дискриминантом heJobInterruption, когда модель временно не ответила, а это
 * исполнение уже проверило хотя бы одного кандидата и чекпойнт с ним
 * подтверждён. Сделанная работа лежит в чекпойнте, и повтор её не покупает —
 * поэтому попытку она не тратит. Своей ветки у неё здесь нет: она идёт этой
 * политикой целиком (серия, пауза, после предела — обычная попытка), а сверх
 * того evidence ограничивает такие остановки на джобу сам
 * (EVIDENCE_FREE_RESUMES_PER_JOB, счётчик в чекпойнте, серией не
 * обнуляется). Бесплатных повторов evidence поэтому не больше
 * EVIDENCE_FREE_RESUMES_PER_JOB на джобу и не больше HE_JOB_FREE_INTERRUPTIONS
 * подряд, засчитанных — те же MAX_ATTEMPTS.
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
 * Лестница пауз перед повтором после ОТКАЗА ПРОВАЙДЕРА, который проходит сам:
 * 429 модели (выше) и временный сбой модели или поиска
 * (heTransientProviderFailureOf) — RATE_LIMIT_PAUSE_DEFAULT_MS (60 с) после
 * первой засчитанной попытки, этот потолок (120 с) после второй; провайдер
 * назвал срок дольше (Retry-After) — ждём его, но не дольше
 * RATE_LIMIT_PAUSE_MAX_MS. Попытка тратится, как и раньше: полных прогонов
 * стадии те же MAX_ATTEMPTS, пауза только отодвигает повтор. Та же лестница —
 * у временного сбоя на нашей стороне внутри стадии (heOwnTransientFailureOf).
 *
 * Зачем. Обычный временный отказ (5xx, свой срок ответа модели, обрыв
 * соединения, полный отказ поиска) повторялся сразу — claimJob поднимал строку
 * через ~5 с, — и сбой провайдера на минуту-две сжигал все три попытки:
 * research-проект падал, а каждый повтор заново оплачивал вызовы, которые
 * стадия успела сделать до отказа. С паузами 60 + 120 с три попытки
 * переживают около трёх минут недоступности (плюс время самих прогонов).
 *
 * Почему с 60 с, а не с 30, как у прерываний: пауз всего MAX_ATTEMPTS − 1 = 2
 * (на последней попытке повтора нет), и 30 + 60 с не покрывали бы
 * двухминутный сбой. У 429 без Retry-After первая пауза прежняя (60 с), вторая
 * вдвое длиннее; Retry-After короче ступени лестницы паузу больше не
 * сокращает: срок, названный провайдером, — нижняя граница паузы, а не её
 * длина.
 */
const PROVIDER_RETRY_PAUSE_LADDER_MAX_MS = 120_000;

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
const shutdownRequested = setupGracefulShutdown(log);
let engCollectionStopping = false;
const shouldStop = () => shutdownRequested() || engCollectionStopping;

// One HE process, two ordinary ENG collection slots. Legacy stages and refills
// remain exclusive. A slot covers the entire job, including cost/failure writes.
type HeActiveCollection = HeEngCollectionScope & { task: Promise<void>; abort?: AbortController };
const activeCollections = new Map<string, HeActiveCollection>();
const engUsageProjects = new Set<string>();

/**
 * Полоса ENG-сборов будится к сроку, а не к запасному опросу. Тик сборки
 * встаёт в очередь сам (requeueSelf) с паузой 1–15 с, а realtime будит воркер
 * в момент записи — когда run_after ещё впереди. Без срока следующий опрос
 * был через 30 с (FALLBACK_POLL_MS в _shared.ts), и каждая пауза в 1 с
 * становилась паузой до 30 с: по логам сбора 22.10.2026 ожидание заняло
 * 44 из 132 минут. Полоса serial (RU и остальные стадии) — как раньше.
 */
const ENG_LANE_WAKES = WORKER_LANE === 'eng_collections';
let wakeEngLane: (() => void) | null = null;

/** Через сколько мс наступит ближайший run_after ожидающей сборки; null — такой нет. */
async function nextEngCollectionDueInMs(): Promise<number | null> {
  const now = Date.now();
  const { data, error } = await db.from('he_jobs').select('run_after')
    .eq('status', 'pending').eq('stage', 'base_collect').gt('run_after', new Date(now).toISOString())
    .order('run_after', { ascending: true }).limit(1).maybeSingle();
  if (error || !data) return null;
  const at = Date.parse(String((data as { run_after?: unknown }).run_after));
  // Строго после срока: claimJob сравнивает run_after с часами этого же процесса.
  return Number.isFinite(at) ? Math.max(250, at - now + 100) : null;
}

/**
 * Свой провайдерский ключ движка (C3). До сих пор V1 и V2 читали ОДНУ
 * переменную OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (docker-compose.prod.yml
 * передаёт обоим воркерам одно значение), поэтому расход и rate limit одного
 * продукта били по другому: ночной долив ENG и ручной прогон специалиста в
 * V2 делили лимит запросов.
 *
 * Если задан HE_OPENROUTER_API_KEY — его значение подставляется в переменную
 * OPENROUTER_HYPOTHESIS_ENGINE_API_KEY, которую читает getApiKey() в
 * lib/hypothesisEngine/llm.ts (читает при каждом вызове, не на импорте), и
 * общий ключ этот процесс больше не отправляет. По нему идут вызовы модели
 * всех стадий, КРОМЕ стадий проектов market='us' при заданном
 * HE_US_REQUESTY_API_KEY: такие стадии идут под журналом расхода ENG, и
 * getApiKey берёт их собственный ключ раньше этой переменной
 * (providerKeys.ts). Переменная не задана — всё как раньше: общий ключ
 * (OPENROUTER_HYPOTHESIS_ENGINE_API_KEY, нет его — OPENROUTER_BRIEF_API_KEY),
 * а у стадий us — HE_US_REQUESTY_API_KEY, если он задан; ломаться нечему.
 * Правки compose не требует: оба воркера подключают весь .env через env_file,
 * а читает HE_OPENROUTER_API_KEY только этот файл.
 *
 * В лог уходят ТОЛЬКО имена переменных, никогда значения. Задан ли
 * HE_US_REQUESTY_API_KEY, отсюда не видно: это пишет providerKeys.ts строкой
 * [he-keys] при первом вызове модели в стадии us-проекта.
 */
function applyEngineProviderKey(): void {
  const usNote = 'стадии проектов market=us — по HE_US_REQUESTY_API_KEY, если он задан (строка [he-keys] при первом вызове модели в такой стадии)';
  const dedicated = (process.env.HE_OPENROUTER_API_KEY ?? '').trim();
  if (!dedicated) {
    log('info', `Provider key (модель, Requesty): HE_OPENROUTER_API_KEY не задан → общий OPENROUTER_HYPOTHESIS_ENGINE_API_KEY (нет его — OPENROUTER_BRIEF_API_KEY); ${usNote}`);
    return;
  }
  process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = dedicated;
  log('info', `Provider key (модель, Requesty): HE_OPENROUTER_API_KEY вместо общего ключа (общий этим воркером не отправляется); ${usNote}`);
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

/**
 * Род прерывания для лога: сторож простоя, рестарт воркера, обрыв чтения БД или
 * остановка evidence с продвинутым чекпойнтом ('evidence_progress').
 */
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

/** Временный отказ провайдера, после которого повтор стадии отодвигается. */
type HeTransientProviderFailure = 'model' | 'model_timeout' | 'search';

/**
 * ВРЕМЕННЫЙ отказ провайдера — по ТИПУ (дискриминанты классов), никогда по
 * тексту; null — не такой. Читатель — writeJobFailure: такой отказ тратит
 * попытку, как и раньше, но повтор отодвигается лестницей пауз
 * (PROVIDER_RETRY_PAUSE_LADDER_MAX_MS, rateLimitPauseMs).
 *
 *  - 'model' — класс 'transient' транспорта модели (llm.ts: 5xx, 408/425/529,
 *    обрыв соединения, недочитанное тело 200) после быстрых повторов внутри
 *    вызова или после окна, в котором их делают;
 *  - 'model_timeout' — истёк свой срок попытки запроса к модели
 *    (HeLlmTimeoutError); отмена задачи и сторож простоя сюда не попадают —
 *    у них свой класс (отмена, HeJobInterruptionError);
 *  - 'search' — отказ поиска класса 'transient' (429, 5xx, свой срок запроса
 *    клиента Serper, обрыв сети, отказ одному запросу; SerperFailureKind);
 *    стадия бросает его, только если поиск не обслужил ни одного запроса
 *    (stages/searchIo.ts).
 * Истёкший срок операции стадии (HeOperationTimeoutError — чтение сайта
 * клиента, страховочный срок поиска) сюда НЕ входит: это не отказ провайдера,
 * и он остаётся обычным фейлом с повтором без паузы (stages/siteProfile.ts).
 * 429 модели (rate_limit) здесь не считается: у него своя ветка в
 * writeJobFailure с той же лестницей. Цепочку причин проходим на ту же
 * глубину, что heLlmFailureOf и heSearchRefusalOf.
 */
function heTransientProviderFailureOf(error: unknown): HeTransientProviderFailure | null {
  if (heLlmFailureOf(error)?.kind === 'transient') return 'model';
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    if (isHeLlmTimeout(e)) return 'model_timeout';
    if (isHeSearchProviderError(e) && e.kind === 'transient') return 'search';
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Временный сбой у НАС (не у провайдера), после которого повтор стадии отодвигается. */
type HeOwnTransientFailure = 'db' | 'resolver';

/**
 * ВРЕМЕННЫЙ сбой нашей стороны внутри стадии; null — не такой. Читатель —
 * writeJobFailure: попытка тратится, как и раньше, но повтор идёт после паузы
 * той же лестницы (rateLimitPauseMs: 60 с, потом 120 с), а не через ~5 с —
 * иначе сбой на минуту сжигал все MAX_ATTEMPTS попыток, а каждая заново
 * оплачивала вызовы модели, которые стадия успела сделать до отказа.
 *
 *  - 'resolver' — не ответил наш DNS-резолвер (HeResolverFailureError из
 *    stages/io.ts, по дискриминанту heResolverFailure);
 *  - 'db' — isTransientDbError: блип БД или шлюза PostgREST (обрыв, 502/503/504
 *    Kong/nginx, коды 08xxx/57P0x/PGRST00x). Предикат узнаёт его и по тексту
 *    (ECONNRESET, «fetch failed»), поэтому так же попадает и сетевой обрыв
 *    другого запроса стадии без класса провайдера — пауза ему тоже на пользу,
 *    в логе он назван «БД/шлюз или сеть», а не «БД».
 * Отказы с классом провайдера (heLlmFailureOf любого рода, свой срок модели,
 * отказ поиска) сюда НЕ попадают: у них свои ветки выше по коду, а 502 в теле
 * ответа модели — не блип нашей БД. Недоступный сайт (HeSiteUnreachableError)
 * — тоже нет: это исход чтения чужого адреса, а не сбой у нас.
 */
function heOwnTransientFailureOf(error: unknown): HeOwnTransientFailure | null {
  if (heLlmFailureOf(error)) return null;
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    if (isHeLlmTimeout(e) || isHeSearchProviderError(e) || isHeSiteUnreachable(e)) return null;
    e = (e as { cause?: unknown }).cause;
  }
  if (isHeResolverFailure(error)) return 'resolver';
  if (isTransientDbError(error)) return 'db';
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

/**
 * Тот ли это прогон: started_at строки равен токену клейма джобы (started_at,
 * который поставил claimJob и вернул в строке). Сравниваем МОМЕНТЫ, а не
 * текст: PostgREST отдаёт «…+00:00», Date#toISOString пишет «…Z».
 */
function heSameClaimToken(rowStartedAt: unknown, job: HeJob): boolean {
  if (job.started_at === null || job.started_at === undefined) {
    return rowStartedAt === null || rowStartedAt === undefined;
  }
  if (typeof rowStartedAt !== 'string') return false;
  const row = Date.parse(rowStartedAt);
  return Number.isFinite(row) && row === Date.parse(job.started_at);
}

/** Тот же момент времени у двух записей timestamptz (формат PostgREST против toISOString). */
function heSameInstant(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Date.parse(a);
  return Number.isFinite(left) && left === Date.parse(b);
}

/** Что лежит в строке he_jobs после CAS-записи, не задевшей ни одной строки. */
type HeJobRowAfterCasMiss =
  /** Перечитать не удалось: состояние строки неизвестно. */
  | { kind: 'unknown'; message: string }
  /** Строки нет (удалена вместе с проектом). */
  | { kind: 'gone' }
  /**
   * Строка есть. ownRun — started_at равен токену клейма ЭТОГО прогона;
   * updatedAt — для узнавания своей же записи, легшей без ответа.
   */
  | { kind: 'row'; status: string; ownRun: boolean; updatedAt: unknown };

/**
 * Перечитать строку he_jobs после того, как CAS-запись воркера (done или отказ:
 * `status = 'running'` И `started_at = токен клейма`, у строки без токена —
 * `started_at is null`) вернула ноль строк. Ноль — это НЕ «записано»: строку
 * закрыли без нас (отмена пользователем, удаление, self-requeue base_collect,
 * новый клейм) — либо наша же прошлая попытка той же записи легла, а ответ на
 * неё потерялся (обрыв соединения после отправки). Различает их только чтение.
 *
 * Токен — started_at, а не только статус: строку, которую успели вернуть в
 * очередь и заклеймить заново, статус 'running' не отличает от нашей, и
 * запоздавшая запись этого прогона легла бы поверх нового.
 *
 * Сам не бросает: отказ чтения — исход 'unknown', решение за вызывающим.
 */
async function readHeJobRowAfterCasMiss(client: HeWorkerDb, job: HeJob): Promise<HeJobRowAfterCasMiss> {
  try {
    const { data, error } = await client
      .from('he_jobs')
      .select('status, started_at, updated_at')
      .eq('id', job.id)
      .maybeSingle();
    if (error) return { kind: 'unknown', message: error.message };
    if (!data) return { kind: 'gone' };
    const row = data as { status?: unknown; started_at?: unknown; updated_at?: unknown };
    return {
      kind: 'row',
      status: typeof row.status === 'string' ? row.status : String(row.status),
      ownRun: heSameClaimToken(row.started_at, job),
      updatedAt: row.updated_at,
    };
  } catch (e) {
    return { kind: 'unknown', message: e instanceof Error ? e.message : String(e) };
  }
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
 * игнорирует отмену и висит дальше, доедет до того же таймаута и выхода — в
 * обоих режимах (см. STAGE_WATCHDOG).
 *
 * Режим 'log' (STAGE_WATCHDOG): по окну молчания — только onWouldAbort с
 * фактическим временем молчания и новое окно; abort, срок grace и выход процесса
 * не взводятся, пока джоба не отменена.
 */
function createHeJobWatchdog(options: {
  abort: AbortController;
  idleMs: number;
  graceMs: number;
  mode: HeStageWatchdogMode;
  /** Текст причины; в нём намеренно есть «timeout» — так его классифицирует кабинет. */
  reason: string;
  onTimeout: () => void;
  /** Режим 'log': окно молчания прошло, enforce прервал бы стадию. Получает время молчания. */
  onWouldAbort: (idleForMs: number) => void;
  /** Получает фактически прожданное после abort время. */
  onUnresponsive: (waitedMs: number) => void;
}): { touch: () => void; stop: () => void } {
  let idleTimer: NodeJS.Timeout | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let lastTouchAt = Date.now();

  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (stopped) return;
      // 'log': отчёт и следующее окно. Отменённую джобу (сигнал уже взведён
      // отменой) это не касается — её висение ведёт к выходу, как в 'enforce'.
      if (options.mode === 'log' && !options.abort.signal.aborted) {
        options.onWouldAbort(Date.now() - lastTouchAt);
        arm();
        return;
      }
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
    lastTouchAt = Date.now();
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
 * heBrandInputRefusalOf, heLlmFailureOf, heSearchRefusalOf,
 * heTransientProviderFailureOf, heOwnTransientFailureOf), поэтому отказ,
 * восстановленный из файла простым Error с этими полями, классифицируется так
 * же, как исходный. Блип БД heOwnTransientFailureOf узнаёт по тексту
 * сообщения — оно в файле есть всегда.
 */
const FAILURE_FIELDS = [
  'heJobInterruption',
  'heJobTerminal',
  'heUnpaidRefusal',
  'heLlmFailure',
  'heLlmTimeout',
  'heSearchProvider',
  'heResolverFailure',
  'heSiteUnreachable',
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
 *    Его запись — CAS по 'running' и токену клейма прогона записи, поэтому
 *    статус, прочитанный здесь, ничего не разрешает сам: отмена, легшая между
 *    чтением и записью, даёт исход 'closed' (расход учтён, строка вычеркнута,
 *    дальше ничего не ставится), 'running' чужого прогона — тоже 'closed', а
 *    своя done-запись, легшая без ответа, — 'landed' (хвост на следующем тике,
 *    чтение увидит 'done'). Блип или срок — следующий тик, до
 *    STRANDED_DELIVERY_ATTEMPTS попыток; отказ не блипом или конец попыток —
 *    доставка БРОШЕНА (abandoned), и строку закрывает failJob с
 *    HeJobResultWriteError;
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
        // CAS done-записи не задел строку, а строка уже 'done' этого прогона:
        // прошлая запись легла без ответа. Хвост (расход, дочейн, followups) —
        // со своим дедупом на следующем тике: чтение статуса увидит 'done'.
        if (outcome.kind === 'landed') {
          persistStrandedJobs();
          log('info', `Job ${id} (${job.stage}) брошенный результат уже лёг done-строкой — хвост доведу следующим тиком`);
          continue;
        }
        // Строку закрыли без сборщика между чтением статуса и записью (отмена,
        // удаление, чужой прогон): done не пишем, дальше ничего не ставим, но
        // оплаченный расход учитываем.
        if (outcome.kind === 'closed') {
          const closed = outcome;
          await withPostStageDeadline(job, 'stranded spend', async (client) => {
            await bookClosedRunSpend(client, job, delivery, closed);
          });
          forgetStrandedJob(id);
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
  // Split lanes: the other process may be running its rows right now. Re-queue
  // only this lane's; an unclassifiable row stays for its owner's restart.
  if (WORKER_LANE !== 'all') {
    const own: HeJob[] = [];
    for (const row of rows) {
      try {
        if (heWorkerLaneTakes(WORKER_LANE, await readHeEngCollectionScope(db, row))) own.push(row);
      } catch (e) {
        log('error', `Stuck job ${row.id} (${row.stage}) left running: its lane is unknown (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    rows = own;
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

/**
 * Split lanes only: the other HE process may be running this project's other
 * kind of work. A project never ran a collection beside an exclusive stage in
 * the single process, and its usage write is serialized only in-process
 * (engProjectUsage.ts). An unread state counts as busy until the next poll.
 */
async function projectBusyInOtherLane(job: HeJob): Promise<boolean> {
  const { data, error } = await db.from('he_jobs').select('id')
    .eq('project_id', job.project_id).eq('status', 'running').limit(50);
  if (error) {
    log('error', `Running he_jobs of project ${job.project_id} could not be read: ${error.message}`);
    return true;
  }
  return (data ?? []).some((row) => row.id !== job.id && !activeCollections.has(row.id));
}

async function claimJob(): Promise<{ job: HeJob; scope: HeEngCollectionScope } | null> {
  const active = [...activeCollections.values()];
  if (active.length >= HE_ENG_COLLECTION_CONCURRENCY) return null;
  const blockedProjects = new Set([...strandedJobs.values()].map((entry) => entry.job.project_id));
  // Page past active/self-requeued rows and blocked verticals. An older serial
  // job is a barrier: drain ENG work before running that job alone.
  const pageSize = 50;
  for (let offset = 0; !shouldStop(); offset += pageSize) {
    const { data, error } = await db.from('he_jobs').select('*')
      .eq('status', 'pending').lte('run_after', new Date().toISOString())
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      log('error', `Pending he_jobs could not be read: ${error.message}`);
      return null;
    }
    const rows = (data ?? []) as HeJob[];
    for (const pending of rows) {
      if (shouldStop()) return null;
      if (activeCollections.has(pending.id) || blockedProjects.has(pending.project_id)) continue;
      let scope: HeEngCollectionScope;
      try {
        scope = await readHeEngCollectionScope(db, pending);
      } catch (error) {
        // Unknown ownership is not permission to run beside another client.
        log('error', `Job ${pending.id} collection scope unavailable: ${error instanceof Error ? error.message : String(error)}`);
        // A split lane cannot tell whose job this is; the next poll reads it again.
        if (WORKER_LANE !== 'all') continue;
        if (active.length > 0) return null;
        // Preserve the old exclusive path at idle. Its owner/budget guards
        // decide the job's outcome; a broken scope read must not wedge RU too.
        scope = { id: pending.id, project_id: pending.project_id, baseId: null, verticalId: null, parallelEligible: false };
      }
      // The other process's job is not a barrier here: it does not wait on this lane.
      if (!heWorkerLaneTakes(WORKER_LANE, scope)) continue;
      if (!selectHeEngCollectionCandidate([scope], active, { blockedProjectIds: blockedProjects })) {
        if (!scope.parallelEligible) return null;
        continue;
      }
      if (WORKER_LANE !== 'all' && await projectBusyInOtherLane(pending)) continue;
      if (shouldStop()) return null;
      const at = new Date().toISOString();
      // Do not increment attempts: base_collect legitimately yields many times.
      // started_at is the run token used by all completion/failure CAS writes.
      const { data: claimed, error: claimError } = await db.from('he_jobs')
        .update({ status: 'running', started_at: at, updated_at: at })
        .eq('id', pending.id).eq('status', 'pending').eq('updated_at', pending.updated_at)
        .select('*').maybeSingle();
      if (claimError) {
        log('error', `Job ${pending.id} (${pending.stage}) claim update rejected: ${claimError.message}`);
        return null;
      }
      if (!claimed) continue;
      if (scope.parallelEligible) engUsageProjects.add(pending.project_id);
      return { job: claimed as HeJob, scope };
    }
    if (rows.length < pageSize) return null;
  }
  return null;
}

/**
 * Добавить расход стадии на проект. Параллельные ENG-сборки одного проекта
 * сериализуют этот короткий read-modify-write; legacy работает как прежде.
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
  const write = () => writeProjectUsage(client, projectId, tokensUsed, costUsd);
  return engUsageProjects.has(projectId) ? withHeEngProjectUsageLock(projectId, write) : write();
}

async function writeProjectUsage(
  client: HeWorkerDb,
  projectId: string,
  tokensUsed: number,
  costUsd: number,
): Promise<boolean> {
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
 *
 * Второй барьер — проект всё ещё 'researching'. CAS done-записи закрывает
 * отмену, легшую ДО неё; отмену, легшую сразу ПОСЛЕ (cancel-роут переводит
 * 'researching' → 'draft', если у проекта нашлась другая активная джоба),
 * видит только чтение проекта. Без него следующая стадия вставлялась в
 * отменённый проект, и цепочка шла до clustering — до пяти оплаченных стадий,
 * а clustering ещё и перетирал 'draft' на 'researched'. С ним в остаточную
 * гонку (отмена между этим чтением и insert) проходит не больше одной
 * стадии: следующий дочейн уже увидит 'draft'. Тот же барьер стоит в хвосте
 * легшей done-строки (landedChainBlocker) — путей к этой вставке два, и
 * барьер на обоих. RU не меняется: research-цепочка идёт только в
 * 'researching' (его ставят старт исследования и site_profile; 'draft' —
 * только отмена, 'failed' — только отказ, 'researched' — clustering, после
 * которого следующей стадии нет).
 *
 * Потолка расхода (spendCeiling.ts) здесь НЕТ намеренно: начатое исследование
 * доводится до конца. Пауза посреди цепочки оставила бы проект 'researching'
 * без джобы, и выйти из неё можно было бы только повтором с site_profile —
 * заплатив второй раз за уже сделанные стадии. Потолок проверяет СТАРТ
 * исследования (кнопка кабинета «Try again» — только после технического
 * сбоя); перебор от этого — не
 * больше одного исследования (шапка spendCeiling.ts).
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

  const { data: project, error: projectErr } = await client
    .from('he_projects')
    .select('status')
    .eq('id', job.project_id)
    .maybeSingle();
  if (projectErr) throw new Error(`he_projects ${job.project_id} status read before ${nextStage}: ${projectErr.message}`);
  const projectStatus = (project as { status?: unknown } | null)?.status;
  if (projectStatus !== 'researching') {
    log(
      'info',
      `Job ${job.id} (${job.stage}) → ${nextStage} не ставим: проект ${job.project_id} уже `
        + `'${typeof projectStatus === 'string' ? projectStatus : 'удалён'}' (отмена или отказ легли после done)`,
    );
    return;
  }

  const { error } = await client
    .from('he_jobs')
    .insert({ project_id: job.project_id, stage: nextStage });
  if (error) throw new Error(`he_jobs ${nextStage} enqueue: ${error.message}`);
  log('info', `Job ${job.id} (${job.stage}) → enqueued ${nextStage} for project ${job.project_id}`);
}

/**
 * Ворота потолка расхода для дочейна автопилота после done-джобы
 * (enqueueAutopilotFollowups спрашивает их прямо перед постановкой сборки и
 * писем). Зовут оба места дочейна — deliverDoneRow и finishLandedDoneRow:
 * путей к этой постановке два, и ворота на обоих. Потолок по умолчанию
 * выключен — тогда ворота отвечают «можно» без запросов; автопилот бывает
 * только у проекта, включённого кнопкой ENG-кабинета, поэтому RU-проект
 * (autopilot=false) до ворот не доходит вовсе.
 */
function followupSpendGate(client: HeWorkerDb, job: HeJob): HeSpendGate {
  return createHeSpendGate(client, {
    projectId: job.project_id,
    path: 'autopilot_followup',
    jobId: job.id,
    baseId: typeof job.payload?.base_id === 'string' ? job.payload.base_id : null,
    verticalId: typeof job.payload?.vertical_id === 'string' ? job.payload.vertical_id : null,
    warn: (msg) => log('warn', `Job ${job.id} (${job.stage}) autopilot followup: ${msg}`),
  });
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

  // Текст отказа БД пригоден для Postgres не всегда (NUL, одиночный суррогат), а
  // срез по 500 мог разрезать пару пополам — тогда отвергалась бы и сама запись
  // причины. Для текста без суррогатов sliceWholeChars режет ровно как slice.
  const reason = stripUnstorableJsonChars(`chain stopped: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  try {
    await client
      .from('he_jobs')
      .update({ error: sliceWholeChars(reason, 0, 500), updated_at: new Date().toISOString() })
      .eq('id', job.id);
    await client
      .from('he_projects')
      .update({
        status: 'failed',
        error: sliceWholeChars(`${job.stage}: ${reason}`, 0, 500),
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
  const collection = activeCollections.get(job.id);
  if (collection) collection.abort = abort;
  // Сторож простоя стадии: окно от последней активности, дальше abort (его
  // видит текущий запрос к модели) и, если стадия не ответила, выход процесса.
  const idleMs = stageIdleTimeoutMs();
  let lastActivity = `stage ${job.stage} started`;
  const watchdog = createHeJobWatchdog({
    abort,
    idleMs,
    graceMs: STAGE_ABORT_GRACE_MS,
    mode: STAGE_WATCHDOG.mode,
    reason: `HE ${job.stage} inactivity timeout`,
    // Где стояла джоба: её последняя строка лога и чего ждёт процесс (сокеты,
    // DNS-запросы, чтения файлов) — после abort этой картины уже не будет.
    onTimeout: () => log(
      'error',
      `Inactivity timeout: job ${job.id} (${job.stage}) after ${idleMs}ms; `
        + `last activity: ${lastActivity}; active resources: ${summarizeActiveResources()}`,
    ),
    // Режим 'log': та же картина, но стадию не трогаем. Строку ищут по
    // «would abort» — по ней и решают, можно ли включать 'enforce' там, где он
    // выключен, и не ложный ли это сигнал.
    onWouldAbort: (idleForMs) => log(
      'warn',
      `Inactivity (log mode, would abort): job ${job.id} (${job.stage}) project ${job.project_id} `
        + `idle ${idleForMs}ms ≥ window ${idleMs}ms — стадию НЕ прерываем; `
        + `last activity: ${lastActivity}; active resources: ${summarizeActiveResources()}`,
    ),
    onUnresponsive: (waitedMs) => {
      if (collection) {
        // A hung ENG slot must not immediately kill another paid collection.
        // Stop admission, interrupt peers and let their checkpoints/cost/failure
        // writes finish before the existing process-restart recovery takes over.
        if (engCollectionStopping) return;
        engCollectionStopping = true;
        const peers = [...activeCollections.values()].filter((entry) => entry.id !== job.id);
        for (const peer of peers) {
          peer.abort?.abort(new HeJobInterruptionError('he_jobs restart: another ENG collection ignored abort', 'restart'));
        }
        log('error', `Job ${job.id} ignored abort for ${waitedMs}ms; draining ${peers.length} ENG peer(s) before restart`);
        void Promise.race([
          Promise.allSettled(peers.map((entry) => entry.task)),
          new Promise<void>((resolve) => setTimeout(resolve, 2 * POST_STAGE_DEADLINE_MS + STAGE_ABORT_GRACE_MS)),
        ]).then(() => process.exit(1));
        return;
      }
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
  // Только market='us' (llm.ts, heLlmEngAccounting); RU — как до порта ENG:
  // у RU-прогона onSpend не зовётся, paid остаётся 0, и в he_jobs идёт ровно
  // расход, который вернула стадия (упавший прогон расхода не пишет).
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
  let journal: HeProviderJournal | null = null;
  try {
    // Рынок проекта (geo поиска, язык промптов/писем) — один read на джобу;
    // тем же чтением — владелец (страж блокировки ниже, только us).
    const { data: proj, error: projErr, status: projStatus } = await db
      .from('he_projects')
      .select('market, created_by')
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
    const projRow = proj as { market?: string; created_by?: unknown } | null;
    const market = normalizeHeMarket(projRow?.market);

    // Владелец us-проекта заблокирован (S3b, engBlockedSweep.guardHeEngJobOwner)
    // — стадия НЕ запускается: джоба погашена ('cancelled') или, если отметку
    // блокировки не прочитали, возвращена в очередь с паузой без траты
    // попытки ('released'); затем воркер берёт следующую джобу. RU-джобы
    // отметку не читают. Возврат не лёг — та же политика, что у обрыва чтения
    // проекта выше: бесплатное прерывание.
    if (market === 'us') {
      const owner = typeof projRow?.created_by === 'string' ? projRow.created_by : '';
      const guard = await guardHeEngJobOwner(db, job, owner, { log: (level, msg) => log(level, msg) });
      if (guard === 'not_released') {
        throw new HeJobInterruptionError('he_eng_account_blocks read: owner block not read and the job not released', 'db');
      }
      if (guard !== 'run') return;
    }

    // Журнал расхода ENG (lib/hypothesisEngine/costTelemetry.ts): только у
    // проекта market='us' — каждое обращение стадии к Requesty и Serper даёт
    // строку application_logs 'he_provider_usage'. Для 'ru' журнал null, и
    // стадия зовётся как раньше, без обёртки. Пишет общим `db` (не stageDb):
    // отмена джобы не должна обрывать запись уже оплаченного обращения. Сбой
    // записи стадию не роняет и не задерживает — см. шапку модуля.
    journal = openHeProviderJournal(db, market, job, (msg) =>
      log('warn', `Job ${job.id} (${job.stage}) project ${job.project_id}: ${msg}`));
    const stageResult = await withHeProviderJournal(journal, () => runHeStage(job, {
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
    }));
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

  // Журнал расхода ENG: дождаться фоновых строк прогона (не дольше
  // SETTLE_LIMIT_MS costTelemetry.ts, ~40 с при лежащей БД; обычно 0; не
  // бросает). Ждём ПОСЛЕ снятия сторожа — ожидание не съедает окно аварийного
  // выхода после abort — и только у вернувшегося непрерванного прогона: если
  // его результат ляжет done-записью, в ней поедет маркер пробела journal_gap
  // (на существующей записи, новой нет). Где done-записи не будет (прерывание,
  // ожидание base_collect, отмена), пробел несёт следующая легшая строка
  // проекта (lost_before). RU: journal === null — ни ожидания, ни маркера.
  const journalLost = journal && !interrupted ? await journal.settle() : 0;

  // Финализация (и учёт расхода прерванного прогона) — под своим сроком:
  // сторожа здесь уже нет, см. POST_STAGE_DEADLINE_MS.
  // Результат и бухгалтерия финализации — один объект: его же получит сборщик,
  // если строку придётся бросить, и по нему он знает, что уже записано.
  const delivery: HeStrandedDelivery = {
    result: journalLost ? markHeJournalGap(stageResult.result, journalLost) : stageResult.result,
    tokensUsed,
    costUsd,
    projectBooked: false,
  };
  let finalized: boolean;
  try {
    finalized = await withPostStageDeadline(job, 'finalization', async (client, signal) => {
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
  } catch (e) {
    // Наверх (pollOnce → failJob) уходят только два НАМЕРЕННЫХ отказа:
    // прерывание (стадия не доработала — повтор по политике прерываний) и
    // терминальный HeJobResultWriteError (done-запись отвергнута не блипом —
    // 'failed' без повтора). Любой ДРУГОЙ отказ финализации ЗАВЕРШЁННОЙ стадии
    // раньше становился обычным фейлом: attempts+1, 'pending' — и стадия,
    // результат которой уже на руках, оплачивалась заново. Теперь он отдаёт
    // строку с результатом сборщику: тот прочитает статус и доставит done-строку
    // ('running'), доведёт хвост легшей ('done') или закроет строку без повтора.
    if (interrupted || isHeJobTerminal(e)) throw e;
    markJobStranded(job, 'finalization threw', {
      failure: new HeJobResultWriteError(
        `he_jobs finalization abandoned (finalization threw): ${e instanceof Error ? e.message : String(e)}`,
      ),
      delivery,
    });
    log(
      'error',
      `Job ${job.id} (${job.stage}) финализация бросила неожиданный отказ — стадию НЕ повторяем, `
        + `результат доставит сборщик: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
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
 *
 * Чтение статуса ниже — быстрый путь (self-requeue, отмена до конца стадии), а
 * НЕ разрешение писать: между ним и done-записью может лечь отмена. Решает сама
 * запись — CAS по 'running' и токену клейма (deliverDoneRow). Весь набор
 * исходов и что с ним делается:
 *  - 'delivered' — done лёг этой записью: расход, дочейн, followups;
 *  - 'landed' — CAS не задел строку, а она уже 'done' ЭТОГО прогона: наша
 *    прошлая попытка легла, ответ потерян (обрыв соединения после отправки).
 *    Хвост — finishLandedDoneRow, с дедупом каждого шага; не дошёл — сборщику;
 *  - 'closed' — строку закрыли без нас (отмена, удаление, чужой прогон):
 *    done НЕ пишем, дочейн и followups НЕ ставим, оплаченный расход учитываем;
 *  - 'retry' — блип или срок: сборщику с результатом;
 *  - 'refused' — отказ не блипом: терминальный HeJobResultWriteError.
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
    // Весь набор статусов he_jobs_status_check, кроме 'running': 'cancelled' —
    // отмена; 'pending' — self-requeue base_collect (другого писателя 'pending'
    // поверх строки, пока её прогон идёт, у single-flight воркера нет); 'done' и
    // 'failed' — строку закрыли без этого прогона. Ни в одном случае done не
    // пишется и ничего дальше не ставится.
    log(
      'info',
      cancelled
        ? `Job ${job.id} (${job.stage}) → cancelled пользователем (+${tokensUsed} tok до отмены)`
        : current.status === 'pending'
          ? `Job ${job.id} (${job.stage}) → waiting (self-requeue, +${tokensUsed} tok)`
          : `Job ${job.id} (${job.stage}) → строка уже '${current.status}' без этого прогона — done не пишем, `
            + `дальше ничего не ставим (+${tokensUsed} tok учтено)`,
    );
    // Стадия доработала, а строку отменили: база могла остаться 'analyzing' без
    // живой джобы (запись баз у роута отмены не легла) — тот же ремонт, что у
    // отмены в записи отказа.
    if (cancelled) await closeAnalyzingBaseAfterCancel(client, job);
    return;
  }

  const outcome = await deliverDoneRow(client, signal, job, delivery);
  if (outcome.kind === 'delivered') return;
  if (outcome.kind === 'landed') {
    // Наша прошлая попытка done-записи легла без ответа. Обычный хвост
    // deliverDoneRow здесь не годится — его дедуп видит только живое, — поэтому
    // тот же хвост, что у сборщика, с барьером на каждом шаге. Он бросает на
    // отказе чтения дедупа: тогда строку с результатом доводит сборщик (прочитав
    // 'done', он идёт в этот же хвост со своим счётом попыток), а не failJob —
    // повтор оплаченной стадии здесь недопустим.
    try {
      await finishLandedDoneRow(client, job, delivery);
    } catch (e) {
      markJobStranded(job, 'landed done tail failed', {
        failure: new HeJobResultWriteError('he_jobs finalization abandoned (landed done tail failed)'),
        delivery,
      });
      log(
        'error',
        `Job ${job.id} (${job.stage}) done-строка легла без ответа, хвост не доведён — доведёт сборщик: `
          + `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return;
  }
  if (outcome.kind === 'closed') {
    await bookClosedRunSpend(client, job, delivery, outcome);
    return;
  }
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
  /**
   * CAS не задел строку, а она уже 'done' этого прогона: прошлая попытка этой
   * записи легла, ответ на неё потерян. Хвост — finishLandedDoneRow.
   */
  | { kind: 'landed' }
  /**
   * Строку закрыли без этого прогона: отмена, удаление, чужой прогон (новый
   * клейм), self-requeue. status — что прочитано (null — строки нет); ownRun —
   * started_at строки всё ещё токен этого прогона (отмена его не меняет).
   */
  | { kind: 'closed'; status: string | null; ownRun: boolean }
  /** Блип БД или срок участка: ту же запись можно повторить позже. */
  | { kind: 'retry'; message: string }
  /** Запись отвергнута не блипом: повтор её не исправит. */
  | { kind: 'refused'; message: string };

/**
 * Учёт расхода прогона, строку которого закрыли без него (исход 'closed').
 * Вызовы модели оплачены при любом исходе строки. В he_jobs расход пишем
 * только строке СВОЕГО прогона (ownRun: отменённой — отмена started_at не
 * меняет): у строки чужого прогона счётчики ведёт её прогон, и наша запись от
 * нашего снимка затёрла бы их, а удалённой строке писать некуда. В he_projects
 * — всегда, если ещё не учтено.
 */
async function bookClosedRunSpend(
  client: HeWorkerDb,
  job: HeJob,
  delivery: HeStrandedDelivery,
  closed: { status: string | null; ownRun: boolean },
): Promise<void> {
  const seen = closed.status ?? 'удалена';
  const why = `строка уже '${seen}' без этого прогона — done не пишем`;
  if (closed.ownRun) {
    await recordStageSpend(client, job, delivery.tokensUsed, delivery.costUsd, why, delivery);
  } else if (!delivery.projectBooked) {
    delivery.projectBooked = await accumulateProjectUsage(client, job.project_id, delivery.tokensUsed, delivery.costUsd);
  }
  log(
    closed.status === 'cancelled' ? 'info' : 'warn',
    `Job ${job.id} (${job.stage}) done-запись не легла: строка уже '${seen}'`
      + `${closed.ownRun ? '' : ' (другой прогон или без токена клейма)'} — `
      + `стадия оплачена, но следующую стадию и followups не ставим `
      + `(+${delivery.tokensUsed} tok, $${delivery.costUsd.toFixed(6)}, he_projects ${delivery.projectBooked ? 'учтён' : 'НЕ учтён'})`,
  );
}

/**
 * Записать done-строку готового результата и довести финализацию до конца
 * (расход в he_projects, дочейн, followups). Общая для финализации и сборщика
 * брошенных строк: результат один и тот же, и путь у него должен быть один.
 * Наружу не бросает: исход записи — в возвращаемом значении.
 *
 * Запись — CAS: `status = 'running'` И `started_at = токен клейма` (у строки
 * без токена — `started_at is null`). Раньше это был безусловный UPDATE по id
 * после ОТДЕЛЬНОГО чтения статуса: отмена, легшая между чтением и записью,
 * затиралась 'done', и дальше chainNextResearchStage и
 * enqueueAutopilotFollowups ставили НОВЫЕ платные стадии отменённому проекту.
 * Сколько строк задето, читаем из ответа (select); ноль — перечитываем строку
 * (readHeJobRowAfterCasMiss) и дальше ничего не ставим, если она не 'done'
 * этого же прогона.
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
   * оплачивался ещё дважды. Повторяем то, что сломалось: запись адресована по
   * id, а стадия — нет.
   *
   * С CAS повтор уже не «идемпотентен вслепую»: если прошлая попытка легла, а
   * ответ потерялся (обрыв соединения после отправки — транспорт такой PATCH
   * сам не повторяет), следующая попытка задевает ноль строк. Это узнаёт чтение
   * после цикла ('landed'), а не повтор.
   */
  let doneErr: { message: string; transient: boolean } | null = null;
  let matched = false;
  for (let attempt = 1; attempt <= DONE_WRITE_ATTEMPTS; attempt += 1) {
    const write = client.from('he_jobs').update(doneRow).eq('id', job.id).eq('status', 'running');
    const { data, error, status } = await (job.started_at
      ? write.eq('started_at', job.started_at)
      : write.is('started_at', null)
    ).select('id');
    if (!error) {
      doneErr = null;
      matched = Array.isArray(data) && data.length > 0;
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
  if (!matched) {
    const row = await readHeJobRowAfterCasMiss(client, job);
    // Не знаем, что в строке, — не гадаем: сборщик перечитает статус и разберёт
    // весь набор сам ('running' — доставит, 'done' — хвост, иначе — закроет).
    if (row.kind === 'unknown') {
      return { kind: 'retry', message: `done write matched no row; re-read failed: ${row.message}` };
    }
    if (row.kind === 'gone') return { kind: 'closed', status: null, ownRun: false };
    // 'done' пишет ТОЛЬКО воркер, и заклеймить строку можно только из
    // 'pending': 'done' с нашим токеном — это наша же прошлая попытка.
    if (row.status === 'done' && row.ownRun) return { kind: 'landed' };
    // 'running' с нашим токеном после CAS, не задевшего строку, — противоречие
    // одного мгновения; не пишем и не ставим ничего, решит перечитывание сборщика.
    if (row.status === 'running' && row.ownRun) {
      return { kind: 'retry', message: 'done write matched no row while the row still reads running' };
    }
    return { kind: 'closed', status: row.status, ownRun: row.ownRun };
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
    const followups = await enqueueAutopilotFollowups(client, job, { spendGate: followupSpendGate(client, job) });
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
 * оборвал финализацию уже после записи. Зовут его двое: сборщик, прочитав
 * 'done' у записи с результатом (collectStrandedJobs), и сама финализация,
 * когда CAS done-записи не задел строку, а та уже 'done' этого прогона
 * (исход 'landed' у deliverDoneRow: прошлая попытка легла, ответ потерян).
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
        const followups = await enqueueAutopilotFollowups(client, job, { spendGate: followupSpendGate(client, job) });
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
    `Job ${job.id} (${job.stage}) → done: хвост легшей done-строки доведён `
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
 * Второе условие — проект всё ещё 'researching'. Из сборщика хвост приходит
 * позже обычной финализации (минуты, а при лежащей БД и дольше), и за это время
 * cancel-роут мог перевести проект в 'draft', а отказ — в 'failed': дочейн
 * после этого — платная стадия проекта, который её не ждёт. Тот же барьер
 * теперь стоит и в самой вставке (enqueueNextResearchStage), так что здесь он
 * дублируется сознательно: отказ ЭТОГО чтения бросает и отдаёт хвост
 * следующему тику, а не превращается в 'chain stopped' с проектом 'failed'.
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
 *    вовсе — исчерпала попытки на другом отказе, умерла с подом. (Отменённая
 *    сборка сюда не приходит: отказ отменённой строки — ветка отмены
 *    writeJobFailure, и её базу разбирает closeAnalyzingBaseAfterCancel.)
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
        // msg уже очищен (writeJobFailure, сборщик); срез — по целым символам.
        error: sliceWholeChars(error, 0, 500),
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
 * Причина в he_bases.error у базы, остановленной отменой, — те же строки, что
 * пишут роуты отмены (ENG: api/client/eng/projects/[id]/cancel, staff:
 * api/tools/hypothesis-engine/projects/[id]/cancel). Кабинет узнаёт обе ПОЛНЫМ
 * совпадением и показывает отмену, а не сбой (clientEngProjection:
 * STAGE_CANCELLED_MARKERS): наружу уходит код 'cancelled', не сама строка.
 */
const HE_BASE_CANCELLED_ERROR_EN = 'Cancelled by user';
const HE_BASE_CANCELLED_ERROR_RU = 'Отменено пользователем';

/**
 * Довести ОТМЕНУ до базы, которую отменённая джоба оставила в 'analyzing' без
 * живой джобы: 'failed' с текстом отмены — ровно то, что роут отмены сделал бы
 * с ней сам, не будь гонки.
 *
 * Откуда такая база. Роуты отмены пишут сначала джобы ('cancelled'), потом базы
 * ('collecting'/'analyzing' → 'failed'), а стадия видит отмену только на тике
 * наблюдателя (CANCEL_WATCH_MS, 3 с). В этом окне база оживает:
 *  - финальная запись harvest base_collect (stages/baseCollect.ts, без барьера
 *    по статусу — см. там) легла после записи баз роутом, а постановку анализа
 *    отмена уже не пустила (абортнутый клиент стадий или проверка владения
 *    assertOwnRunningJob);
 *  - запись баз у роута не легла вовсе (он её только журналирует).
 * Раньше такая база висела 'analyzing' НАВСЕГДА: «Analyzing the base…» в
 * кабинете и «Разбираем…» у специалиста при отменённой джобе. У RU-инструмента
 * её не лечит никто, а у ENG её «лечит» кнопка «Start outreach» —
 * repairOrphanAnalyzingBase заново ставит и оплачивает анализ, который клиент
 * только что отменил.
 *
 * Почему 'failed', а не новый анализ (вставка которого бесплатна, а прогон —
 * нет): отмена — решение человека, и повторная постановка её бы перечеркнула.
 * Новую работу по вертикали человек запускает сам — как после обычной отмены.
 *
 * Текст — по рынку проекта (ENG-роут пишет английский, staff-роут — русский;
 * у ENG-проекта, отменённого из staff-инструмента, здесь будет английский —
 * кабинет узнаёт оба). Рынок не прочитался — английский: его тоже узнают оба
 * экрана, а русского текста в ENG-базе не будет ни при каком исходе.
 *
 * Что НЕ трогаем:
 *  - базу не в 'analyzing': терминальная ('analyzed'/'failed') уже решена;
 *    'collecting' без джобы — ремонт сироты СБОРКИ, отдельная волна
 *    (P-C-enqueue-orphan-repair); 'uploaded' — анализ ещё не начинался;
 *  - базу, по которой есть ЖИВАЯ джоба (например, «Start outreach» уже поставил
 *    ей анализ — последнее слово за человеком);
 *  - ничего при сбое любого чтения: «неизвестно» ≠ «мертва».
 * Запись — CAS по 'analyzing'. ФИНАЛЬНО упавший (не отменённый) анализ сюда не
 * относится: его база остаётся 'analyzing', как и раньше, потому что 'failed'
 * открыл бы автопилоту новую ПЛАТНУЮ сборку вертикали (дочейн после chain
 * сборку ставит, когда у вертикали нет 'analyzing'/'analyzed'-базы), а сейчас
 * он такую базу пропускает (analysis_failed_before).
 *
 * Только для стадий, у которых база — предмет работы (base_collect,
 * base_analyze), и только с base_id в payload. Никогда не бросает: зовётся из
 * записи отказа и из финализации.
 */
async function closeAnalyzingBaseAfterCancel(client: HeWorkerDb, job: HeJob): Promise<void> {
  if (job.stage !== 'base_collect' && job.stage !== 'base_analyze') return;
  const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
  if (!baseId) return;
  try {
    const { data: baseRow, error: baseErr } = await client
      .from('he_bases')
      .select('status')
      .eq('id', baseId)
      .maybeSingle();
    if (baseErr) throw new Error(`he_bases read: ${baseErr.message}`);
    if ((baseRow as { status?: unknown } | null)?.status !== 'analyzing') return;
    const liveBaseIds = await liveHeJobBaseIds(client, job.project_id);
    if (liveBaseIds.has(baseId)) {
      log('info', `Job ${job.id} (${job.stage}) отменена; база ${baseId} в analyzing, но по ней есть живая джоба — не трогаем`);
      return;
    }
    const { data: project, error: projectErr } = await client
      .from('he_projects')
      .select('market')
      .eq('id', job.project_id)
      .maybeSingle();
    const reason = !projectErr && normalizeHeMarket((project as { market?: string } | null)?.market) !== 'us'
      ? HE_BASE_CANCELLED_ERROR_RU
      : HE_BASE_CANCELLED_ERROR_EN;
    const { data: closed, error: closeErr } = await client
      .from('he_bases')
      .update({ status: 'failed', error: reason, updated_at: new Date().toISOString() })
      .eq('id', baseId)
      .eq('status', 'analyzing')
      .select('id');
    if (closeErr) throw new Error(`he_bases update: ${closeErr.message}`);
    log(
      'info',
      Array.isArray(closed) && closed.length > 0
        ? `Job ${job.id} (${job.stage}) отменена; база ${baseId} оставалась analyzing без живой джобы → failed («${reason}»)`
        : `Job ${job.id} (${job.stage}) отменена; база ${baseId} уже не analyzing — не трогаем`,
    );
  } catch (e) {
    log(
      'error',
      `Job ${job.id} (${job.stage}) отменена, но база ${baseId} не закрыта и может остаться analyzing: `
        + `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Сколько ждать до повтора после отказа, который проходит сам: 429 (провайдер
 * попросил подождать), временный сбой провайдера (heTransientProviderFailureOf)
 * или временный сбой у нас (heOwnTransientFailureOf: блип БД/шлюза, наш
 * резолвер — у них Retry-After нет). Ступень лестницы по номеру засчитанной
 * попытки — 60 с, потом 120 с (PROVIDER_RETRY_PAUSE_LADDER_MAX_MS); названный
 * провайдером срок (Retry-After) длиннее ступени — он, но не дольше
 * RATE_LIMIT_PAUSE_MAX_MS. Попытку это НЕ экономит (см.
 * RATE_LIMIT_PAUSE_DEFAULT_MS) — только отодвигает повтор.
 */
function rateLimitPauseMs(retryAfterMs: number | undefined, nextAttempts: number): number {
  const step = Math.min(
    RATE_LIMIT_PAUSE_DEFAULT_MS * 2 ** Math.max(0, nextAttempts - 1),
    PROVIDER_RETRY_PAUSE_LADDER_MAX_MS,
  );
  const asked = retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(RATE_LIMIT_PAUSE_MAX_MS, Math.max(step, asked));
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
  // не инкрементируем attempts, не затираем 'cancelled', не валим проект. Базу
  // трогает один случай — 'analyzing', оставшаяся без живой джобы
  // (closeAnalyzingBaseAfterCancel).
  // Чтение — быстрый путь для лога; если оно не прочиталось (или отмена легла
  // ПОСЛЕ него), 'cancelled' защищает CAS самой записи отказа ниже.
  const { data: currentBefore } = await client
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (currentBefore && (currentBefore as { status: string }).status === 'cancelled') {
    log('info', `Job ${job.id} (${job.stage}) aborted by user cancel`);
    await closeAnalyzingBaseAfterCancel(client, job);
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
  // Дискриминант heJobTerminal носят ТРИ класса, и они разные новости:
  // HeJobResultWriteError («результат оплачен, но не сохранился» — здешний и
  // тот, которым сборщик закрывает брошенную строку), HeVocabEmptyError
  // (stages/vocab.ts: обязательный список словаря пуст или отсутствует и после
  // повтора, платить за это трижды не за что) и HeLetterBrandInputError
  // (letterBrandGuard.ts: поле брифа клиента называет наш бренд — стадия писем
  // отказала до первого платного вызова, повтор с тем же брифом откажет так же).
  // Поэтому ниже в лог уходит ИМЯ класса, а не выдумка про запись результата.
  const terminalStageFailure = isHeJobTerminal(err);
  // Отказ за наш бренд в поле брифа ещё и БЕСПЛАТНЫЙ (heBrandInputRefusalOf —
  // по дискриминанту): вызовов модели в этом прогоне не было, и попытка ему
  // не засчитывается, а строка помечается в payload (HE_JOB_UNPAID_REFUSAL_KEY
  // и поля брифа). По пометке тормоз писем (heTemplateGenerationBudget) и
  // ночной гейт «цепочка уже падала» (autopilotReconcile) этот прогон не
  // считают, а письмо об остановке рынка называет поле шага 1. Попытки,
  // засчитанные ДО него (платные прогоны той же строки), остаются в attempts.
  const unpaidRefusal = heBrandInputRefusalOf(err);

  // Прерывание (сторож простоя, рестарт воркера, обрыв чтения проекта до
  // стадии): работа не выполнялась, платить попыткой не за что. Остановка
  // evidence с продвинутым чекпойнтом ('evidence_progress', см.
  // HE_JOB_FREE_INTERRUPTIONS) идёт этой же веткой: её работа сохранена и
  // повтором не покупается. Признак —
  // ТИП ошибки, не её текст. Бесплатность ограничена: после
  // HE_JOB_FREE_INTERRUPTIONS подряд прерывание считается обычной попыткой,
  // иначе застрявшая стадия крутилась бы бесплатно вечно.
  const interrupted = isHeJobInterruption(err);
  const interruptions = interrupted ? heJobInterruptions(job.payload) + 1 : 0;
  const free = interrupted && interruptions <= HE_JOB_FREE_INTERRUPTIONS;
  // attempts — число фейлов, а не клеймов: инкремент только здесь. Бесплатный
  // отказ (unpaidRefusal) его не трогает — платить попыткой не за что.
  const nextAttempts = job.attempts + (free || unpaidRefusal ? 0 : 1);
  const finalFail =
    !free && (terminalProviderRefusal || terminalStageFailure || nextAttempts >= MAX_ATTEMPTS);
  // Временный сбой провайдера (не 429 — у него ветка rateLimited): попытка
  // тратится как раньше, но повтор отодвигается той же лестницей пауз, а не
  // идёт через ~5 с. Прерывание сюда не попадает: у него своя пауза ниже.
  const transientProvider = rateLimited || interrupted ? null : heTransientProviderFailureOf(err);
  // Временный сбой у НАС (блип БД/шлюза, наш DNS-резолвер) — та же лестница
  // пауз, попытка тратится так же: повтор только отодвигается, а предел — те
  // же MAX_ATTEMPTS. Терминальные отказы и классы провайдера сюда не доходят.
  const ownTransient =
    rateLimited || interrupted || transientProvider || terminalProviderRefusal || terminalStageFailure || unpaidRefusal
      ? null
      : heOwnTransientFailureOf(err);
  const pauseMs =
    (rateLimited || transientProvider || ownTransient) && !finalFail && !unpaidRefusal
      ? rateLimitPauseMs(llmFailure?.retryAfterMs, nextAttempts)
      : 0;
  const pauseReason = transientProvider
    ? `временный сбой провайдера (${transientProvider})`
    : ownTransient === 'resolver'
      ? 'временный сбой у нас (DNS-резолвер)'
      : ownTransient === 'db'
        ? 'временный сбой у нас (БД/шлюз или сеть)'
        : '';
  if (unpaidRefusal) {
    log(
      'error',
      `Job ${job.id} (${job.stage}) terminal unpaid refusal (${err instanceof Error ? err.name : 'unknown'}) `
        + `— попытка не засчитана (${job.attempts}/${MAX_ATTEMPTS}), повтор не назначается, строка помечена `
        + `${HE_JOB_UNPAID_REFUSAL_KEY}=${HE_JOB_UNPAID_BRAND_INPUT}: ${msg}`,
    );
  } else if (terminalStageFailure) {
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
    log(
      'error',
      `Job ${job.id} (${job.stage}) failed (attempt ${nextAttempts}/${MAX_ATTEMPTS})`
        + `${pauseMs ? `, ${pauseReason} — повтор не раньше чем через ${pauseMs}ms` : ''}`
        + `: ${msg}`,
    );
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
   *  - rate limit, временный сбой провайдера и временный сбой у нас (блип
   *    БД/шлюза, наш резолвер): пауза по лестнице (rateLimitPauseMs), попытка
   *    потрачена (см. выше);
   *  - прочий обычный фейл: повтор сразу, как раньше, но серия прерываний
   *    закрыта.
   */
  const retryState: Record<string, unknown> = {};
  if (interrupted) {
    retryState.payload = stripUnstorableJsonChars({ ...job.payload, interruptions });
    retryState.run_after = new Date(
      Date.now() + Math.min(INTERRUPTION_RETRY_BASE_MS * 2 ** (interruptions - 1), INTERRUPTION_RETRY_MAX_MS),
    ).toISOString();
    retryState.started_at = null;
  } else {
    if (unpaidRefusal) {
      // Пометка бесплатного отказа (см. unpaidRefusal выше) — поверх payload
      // джобы, серия прерываний закрыта как у обычного фейла.
      retryState.payload = stripUnstorableJsonChars({
        ...(clearedPayload ?? job.payload ?? {}),
        [HE_JOB_UNPAID_REFUSAL_KEY]: HE_JOB_UNPAID_BRAND_INPUT,
        [HE_JOB_BRAND_INPUTS_KEY]: unpaidRefusal.inputs,
      });
    } else if (clearedPayload) retryState.payload = stripUnstorableJsonChars(clearedPayload);
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
    // Срез по целым символам: safeMsg уже без одиночных суррогатов, но slice(0,
    // 500) мог разрезать эмодзи пополам и вернуть одиночный high-суррогат — и
    // PostgREST отверг бы всю запись отказа (строка осталась бы 'running', а
    // сборщик повторял бы ту же отвергнутую запись каждым тиком).
    error: sliceWholeChars(safeMsg, 0, 500),
    finished_at: finalFail ? new Date().toISOString() : null,
    ...retryState,
    updated_at: new Date().toISOString(),
  };
  /**
   * Запись отказа при блипе БД ПОВТОРЯЕМ. Это ровно тот случай, когда
   * транзиентный отказ БД стоил ЦЕЛОЙ ДЖОБЫ: апдейт отвергался, строка
   * оставалась 'running', и подобрать её было некому до следующего рестарта
   * процесса — вместе с ней стоял весь проект, потому что воркер single-flight.
   * Повторяется ЗАПРОС (одни и те же attempts, run_after считается до цикла),
   * поэтому лишних прогонов стадии не появляется ни одного. Не легла и после
   * повторов — вызывающий отдаёт строку сборщику (pollOnce, resetStuckJobs →
   * markJobStranded).
   *
   * Запись — CAS по 'running' И по токену клейма (started_at этого прогона; у
   * строки без токена — `started_at is null`), тот же контракт, что у
   * done-записи (deliverDoneRow). Весь набор статусов строки и исход:
   *  - 'running' этого прогона → запись ложится;
   *  - 'cancelled' → не ложится: отмена, легшая между чтением выше и записью,
   *    больше не перетирается 'pending' (отменённая работа воскресала и снова
   *    оплачивалась);
   *  - 'done' → не ложится: результат оплаченной стадии не стирается;
   *  - 'pending' → не ложится. Раньше CAS пускал 'pending' ради self-requeue
   *    base_collect, но этот прогон requeue сам и сделал (requeueSelf стоит
   *    прямо перед return), и отказ поверх него только тратил попытку и на
   *    последней валил базу — хотя requeue лёг и следующий тик идёт штатно;
   *  - 'failed' → не ложится; свою же запись, легшую без ответа, узнаём ниже по
   *    чтению (статус и updated_at этой записи), а не повтором поверх 'failed';
   *  - 'running' ДРУГОГО прогона (строку вернули в очередь и заклеймили
   *    заново) → не ложится: запоздавший отказ не закрывает чужой прогон.
   * Сколько строк задето, читаем из ответа (select); ноль — перечитываем
   * строку: своя запись, легшая без ответа, → дальше как записанная; строку
   * закрыли без нас → проект этот отказ не трогает, а базу — только когда
   * строку отменили и база осталась 'analyzing' без живой джобы
   * (closeAnalyzingBaseAfterCancel, как и ветка отмены выше); перечитать не
   * удалось → как отказ записи (сборщик перечитает статус).
   */
  let failErrMsg: string | null = null;
  let failLanded = true;
  /** Строку закрыли без нас, и перечитанный статус — 'cancelled' (см. ниже). */
  let closedByCancel = false;
  for (let attempt = 1; attempt <= FAIL_WRITE_ATTEMPTS; attempt += 1) {
    const write = client.from('he_jobs').update(failRow).eq('id', job.id).eq('status', 'running');
    const { data: landed, error, status } = await (job.started_at
      ? write.eq('started_at', job.started_at)
      : write.is('started_at', null)
    ).select('id');
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
  if (!failErrMsg && !failLanded) {
    const row = await readHeJobRowAfterCasMiss(client, job);
    if (row.kind === 'unknown') {
      failErrMsg = `fail write matched no row; re-read failed: ${row.message}`;
    } else if (row.kind === 'row' && row.status === failRow.status && heSameInstant(row.updatedAt, failRow.updated_at)) {
      // Прошлая попытка этой же записи легла, ответ на неё потерян: строка
      // несёт ровно наш статус и наш updated_at (триггеров на he_jobs нет,
      // updated_at ставит только писатель).
      failLanded = true;
    } else if (row.kind === 'row' && row.status === 'cancelled') {
      closedByCancel = true;
    }
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
        + `(отменена пользователем, завершена или удалена) — проект не трогаем`
        + `${closedByCancel ? ', базу — только если она осталась analyzing без живой джобы' : ' и базу не трогаем'}: ${msg}`,
    );
    // Отмена, легшая ПОСЛЕ чтения статуса выше, — тот же случай, что ветка
    // отмены в начале функции, и тот же ремонт базы.
    if (closedByCancel) await closeAnalyzingBaseAfterCancel(client, job);
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
  // CAS по 'researching' — как у записи причины в chainNextResearchStage:
  // отмена, легшая между записью отказа и этой записью, уже перевела проект в
  // 'draft', и затирать её фейлом нельзя. Вне этой гонки research-стадия падает
  // в 'researching' — RU и ENG пишут то же, что раньше. Единственное другое
  // состояние — старт исследования, чья запись 'researching' сама отказала
  // (researchJob.ts: роут ответил ошибкой, джоба site_profile уже стоит): такой
  // проект остаётся 'draft', а не 'failed', и запускается заново той же кнопкой.
  if (finalFail && RESEARCH_STAGES.has(job.stage)) {
    await client
      .from('he_projects')
      .update({
        status: 'failed',
        error: sliceWholeChars(`${job.stage}: ${safeMsg}`, 0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id)
      .eq('status', 'researching');
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

/**
 * АВТОЗАПУСК ENG — тик между джобами (S3, engAutoLaunch.runHeEngAutoLaunchTick):
 * не чаще раза в HE_ENG_AUTO_LAUNCH_TICK_MS (дефолт минута), полностью
 * дожидается, не бросает и делает не больше ОДНОГО запуска. Здесь, а не новой
 * стадией he_jobs и не в done-ветке шаблона:
 *  - активной джобы во время тика нет, поэтому общий канал отмены запросов к
 *    модели (setHeActiveJob, llm.ts) не оборвёт классификатор сегментов
 *    запуска, а сторож простоя стадии не оборвёт вызовы рассыльщика посреди
 *    запуска (их ограничивают свои сроки: 90 с на вызов рассыльщика, срок
 *    попытки модели, 100 с на старт кампаний);
 *  - новая стадия потребовала бы миграции check-ограничения he_jobs и правки
 *    каждой исчерпывающей карты стадий, а done-ветка шаблона живёт в сроке
 *    участка после стадии (POST_STAGE_DEADLINE_MS) и не должна падать.
 * Цена: запуск (обычно секунды; в худшем случае — ядро, которое с
 * классификатором сегментов идёт минутами, и сразу за ним до 100 с старта
 * кампаний, отсчитанных от самого старта) задерживает очередь джоб обоих
 * рынков на это время. drain-worker.sh тик не видит:
 * SIGKILL посреди запуска оставляет строку автозапуска 'running' — по
 * истечении аренды записи у ядра (15 мин) и строки (10 мин) следующий тик
 * считает брошенную попытку платным сбоем и достраивает запуск без дублей
 * (вторая брошенная подряд — строка 'failed' и алерт, без нового запуска);
 * брошенную после ядра стартует, только если решение «стартуем» было
 * записано, иначе ничего не стартует ('done needs_support').
 * Выключатель запуска — HE_ENG_AUTO_LAUNCH=0 в окружении воркера; без
 * instantly-БД (supabaseInstantly null) — выключен с одной строкой warn.
 * Письма клиенту (engClientMail) идут тем же тиком: проход по данным —
 * независимо от выключателя, письма событий автозапуска — из его решений.
 * Без SMTP_* в .env воркера письма не уходят (заявка остаётся, повтор ≤ 3).
 */
let heEngAutoLaunchNextAtMs = 0;

async function maybeRunHeEngAutoLaunch(): Promise<boolean> {
  const nowMs = Date.now();
  if (nowMs < heEngAutoLaunchNextAtMs) return false;
  heEngAutoLaunchNextAtMs = nowMs + heEngAutoLaunchTickMs();
  try {
    return await runHeEngAutoLaunchTick({
      portalDb: db,
      instantlyDb: supabaseInstantly,
      log: (level, msg) => log(level, msg),
      shouldStop,
      mail: { send: sendHeEngClientNotice, scan: runHeEngClientMailScan },
    });
  } catch (err) {
    // runHeEngAutoLaunchTick не бросает; это страховка очереди.
    log('error', `[auto-launch] tick threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * ЗАБЛОКИРОВАННЫЕ ENG-АККАУНТЫ — фоновая проверка между джобами (S3b,
 * engBlockedSweep.ts, часть 2): выключатель отправки заблокированного аккаунта
 * снова выключен, кампании его запусков перечитаны и, если отправляют, стоят
 * на паузе. Не чаще раза в HE_ENG_BLOCK_SWEEP_MS (дефолт 5 мин), независимо от
 * HE_ENG_AUTO_LAUNCH; выключатель HE_ENG_BLOCK_SWEEP=0. Очередь обоих рынков
 * прогон держит не дольше HE_ENG_BLOCK_SWEEP_BUDGET_MS (20 с): дальше он
 * доходит фоном, а следующий не начнётся, пока этот не кончится. Нет активных
 * отметок — один запрос.
 */
const heEngBlockSweep = createHeEngBlockSweepTicker({
  portalDb: db,
  instantlyDb: supabaseInstantly,
  log: (level, msg) => log(level, msg),
  shouldStop,
});

/**
 * «DO NOT CONTACT» ENG — снятие адресов из списка клиента с его идущих
 * кампаний (engDncRemoval.ts): только с HE_ENG_DNC_REMOVE=1 (по умолчанию
 * выключено — тогда ни запроса в БД, ни вызова рассыльщика). Не чаще раза в
 * HE_ENG_DNC_TICK_MS (1 мин); за проход — не больше HE_ENG_DNC_CALLS_PER_PASS
 * (5) вызовов рассыльщика через общий ограничитель воркспейса; очередь обоих
 * рынков проход держит не дольше HE_ENG_DNC_QUEUE_HOLD_MS (15 с), дальше он
 * доходит фоном, и следующий не начнётся, пока этот не кончится. Пусто — два
 * запроса в БД.
 */
const heEngDncRemoval = createHeEngDncRemovalTicker({
  portalDb: db,
  instantlyDb: supabaseInstantly,
  log: (level, msg) => log(level, msg),
  shouldStop,
});

/**
 * Кампании непроверенных адресов ENG (engUnverifiedCampaign.ts): отправляют
 * вместе с основными кампаниями запуска и стоят вместе с ними. Не чаще раза в
 * HE_ENG_UNVERIFIED_TICK_MS (5 мин); HE_ENG_UNVERIFIED_SEND=0 — ставит на паузу
 * и не стартует.
 */
const heEngUnverifiedCampaigns = createHeEngUnverifiedCampaignTicker({
  portalDb: db,
  instantlyDb: supabaseInstantly,
  log: (level, msg) => log(level, msg),
  shouldStop,
});

async function runClaimedJob(job: HeJob): Promise<void> {
  if (strandedJobs.has(job.id)) forgetStrandedJob(job.id);
  try {
    await handleJob(job);
  } catch (err) {
    if (!(await failJob(job, err))) markJobStranded(job, 'fail write did not land', { failure: err });
  }
}

async function pollOnce(): Promise<boolean> {
  // Брошенные строки закрываем ДО клейма: пока такая строка висит в 'running',
  // её проект стоит, а воркер один на всех.
  if (activeCollections.size === 0) await collectStrandedJobs();
  // Do not keep refilling slots indefinitely while a paid result waits for
  // recovery. Drain the current pair, then run the single recovery sweep.
  if (activeCollections.size > 0 && strandedJobs.size > 0) return false;
  // SIGTERM, пришедший во время прохода сборщика (он ходит в БД, при лежащей
  // БД — подолгу), новой платной стадии уже не открывает: pollLoop проверяет
  // флаг только между тиками, и без этой строки остановка при деплое
  // (drain-worker.sh → docker compose stop) клеймила бы стадию уже после
  // сигнала — её мог оборвать SIGKILL по StopTimeout, и стадия без чекпоинта
  // оплачивалась бы второй раз. false — «джобы нет»: pollLoop дождётся своего
  // тика (при дефолтном WORKER_POLL_INTERVAL_MS — не дольше 30 с) и выйдет по
  // флагу. Клейм, уже начатый к сигналу (чтение и апдейт в claimJob), доходит
  // до конца, и эта джоба исполняется как текущая.
  if (shouldStop()) return false;
  // Заблокированные ENG-аккаунты — между джобами (см. heEngBlockSweep).
  // Полоса только ENG-сборов служебных проходов не делает: их ведёт процесс
  // остальных стадий, один на сервер.
  if (activeCollections.size === 0 && WORKER_LANE !== 'eng_collections') {
    await heEngBlockSweep.maybeRun();
    // «Do not contact» — снятие с идущих кампаний клиента (см. heEngDncRemoval).
    await heEngDncRemoval.maybeRun();
    // Кампании непроверенных адресов — в ногу с основными (heEngUnverifiedCampaigns).
    await heEngUnverifiedCampaigns.maybeRun();
    // Автозапуск ENG — только без активных сборок, как раньше между стадиями.
    if (await maybeRunHeEngAutoLaunch()) return true;
  }
  if (shouldStop()) return false;
  const claimed = await claimJob();
  if (!claimed) return false;
  // Клейм прошёл только поверх 'pending' — значит брошенная запись по этой
  // строке устарела (сборщик, прочитай он статус в этом тике, вычеркнул бы её
  // сам). Иначе её прежний результат (например {waiting} тика base_collect)
  // позже доставился бы поверх НОВОГО прогона.
  const { job, scope } = claimed;
  if (!scope.parallelEligible) {
    await runClaimedJob(job);
    return true;
  }
  // Register synchronously before executing the stage: a self-requeued row
  // cannot be reclaimed while its prior finalization is still in progress.
  const task = Promise.resolve().then(() => withHeActiveJobScope(() => runClaimedJob(job)))
    .catch((error) => {
      markJobStranded(job, 'parallel collection handler failed', { failure: error });
      log('error', `ENG collection ${job.id} left for recovery: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      activeCollections.delete(job.id);
      // Слот свободен, а только что вставшая в очередь сборка могла быть уже
      // к сроку, пока её прогон дописывал итог: опрос — сейчас, не через 30 с.
      wakeEngLane?.();
    });
  activeCollections.set(job.id, { ...scope, task });
  log('info', `ENG collection ${job.id} admitted (${activeCollections.size}/${HE_ENG_COLLECTION_CONCURRENCY} slots)`);
  return true;
}

async function main() {
  log('info', 'Hypothesis Engine worker starting…');
  log('info', WORKER_LANE === 'all'
    ? `ENG collection concurrency: ${HE_ENG_COLLECTION_CONCURRENCY}; one HE process; all other stages exclusive`
    : WORKER_LANE === 'eng_collections'
      ? `Lane eng_collections: only verified ENG collections, ${HE_ENG_COLLECTION_CONCURRENCY} slots`
      : 'Lane serial: every stage except verified ENG collections, one at a time');

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);
  // До первой стадии: дальше ключ читает getApiKey() на каждом вызове модели.
  applyEngineProviderKey();
  // Порядок бюджетов печатаем на старте: «срок одного запроса к модели <
  // окно простоя» — то условие, без которого здоровый платный вызов снова
  // объявят зависанием. Числа читаются из llm.ts, поэтому в логе видно и
  // действующий HE_LLM_TIMEOUT_MS.
  if (STAGE_WATCHDOG.rejected !== null) {
    log(
      'warn',
      `HE_STAGE_WATCHDOG_MODE='${STAGE_WATCHDOG.rejected}' не распознан (ожидается 'enforce' или 'log') — действует 'enforce'`,
    );
  }
  log(
    'info',
    `Stage watchdog [${STAGE_WATCHDOG.mode}${STAGE_WATCHDOG.mode === 'log' ? ': только пишет, не прерывает' : ''}]: `
      + `${stageIdleTimeoutMs()}ms idle `
      + `(≥ ${LLM_SILENCE_SAFETY_FACTOR}× LLM attempt ${heLlmMaxAttemptMs()}ms, floor ${STAGE_IDLE_FLOOR_MS}ms), `
      + `abort grace ${STAGE_ABORT_GRACE_MS}ms, free interruptions ${HE_JOB_FREE_INTERRUPTIONS}, `
      + `retry pause (429, временный сбой провайдера, блип БД/резолвера) ${RATE_LIMIT_PAUSE_DEFAULT_MS}→${PROVIDER_RETRY_PAUSE_LADDER_MAX_MS}ms, `
      + `Retry-After ≤ ${RATE_LIMIT_PAUSE_MAX_MS}ms (попытка тратится), `
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
      ...(ENG_LANE_WAKES ? {
        nextDueInMs: nextEngCollectionDueInMs,
        registerWake: (wake: () => void) => { wakeEngLane = wake; },
      } : {}),
    });
    // SIGTERM stops admission, not already-paid work. Wait for every running
    // collection's stage and finalization before the final recovery sweep.
    await Promise.allSettled([...activeCollections.values()].map((entry) => entry.task));
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
