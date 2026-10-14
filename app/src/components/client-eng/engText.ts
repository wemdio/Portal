'use client';

/**
 * Английская граница текстов кабинета /client/eng.
 *
 * Общий `scrubBrand` (lib/scrubBrand.ts) вычищает бренд рассыльщика из любых
 * клиентских сообщений, но подставляет вместо него РУССКУЮ «систему рассылки»:
 * для RU-кабинета это верно, а в английском получается русская вставка в
 * английской ошибке («Launch failed: система рассылки API 400: …»). Править
 * сам `scrubBrand` нельзя — он общий для обоих контуров, а язык замены знает
 * только контур. Поэтому локализуем здесь, на границе английского кабинета;
 * RU-контур и внутренний инструмент остаются нетронутыми.
 *
 * Тексты приезжают в кабинет ДВУМЯ разными путями, и правило для них разное:
 *
 * 1. ЖИВОЙ ответ `/api/client/eng/**` (`body.error`, брошенная ошибка фетча).
 *    Роуты после волны 0 отдают английскую КОНСТАНТУ роута
 *    (`api/client/eng/_shared.ts`), так что тут достаточно скраба: подменять
 *    осмысленную фразу роута на общий текст — значит терять конкретику. →
 *    `engErrorText`.
 * 2. СОХРАНЁННАЯ ошибка стадии (`he_projects.error`, `he_bases.error`). Её
 *    пишет воркер по-русски и вместе с внутренним сырьём: `he_bases <uuid>:
 *    status='...'`, имя стадии префиксом (`worker/hypothesisEngine.ts`), тело
 *    ответа LLM-подрядчика. Это текст для staff, клиенту его показывать нельзя
 *    ни на каком языке — и в кабинет он больше не приезжает вовсе: роут
 *    сворачивает строку в машинный код на границе ответа
 *    (`toClientEngStageErrorCode`). → `engStageErrorText`, разворачивающая
 *    код обратно в английский текст.
 */

import { scrubBrand } from '@/lib/scrubBrand';
import { isAuthExpiredError } from '@/lib/authFetch';
// Только справочник «код → текст», а НЕ классификатор: `lib/hypothesisEngine/
// clientErrors` в браузер не тянем вовсе — в его регэкспах имена провайдеров,
// наших каталогов и таблиц и русские фразы стадий, и всё это уезжало в чанк
// /client/eng. Разбор сырых строк живёт на сервере (проекция отдаёт код).
import {
  HE_REFILL_HOLD_LIFT_EN,
  HE_REFILL_RUN_KEPT_EN,
  HE_REFILL_RUN_WHAT_TO_DO_EN,
  HE_SPEND_PAUSED_EN,
  HE_TEAM_ON_IT_EN,
  formatHeClientFailure,
  heClientFailureFor,
  type HeClientErrorCode,
} from './clientFailureText';
// ТОЛЬКО ТИП, и это важно: `clientEngProjection` тянет launchHandoff и дальше
// серверный стек, а в бандл кабинета ему нельзя. `isolatedModules: true`
// (tsconfig) гарантирует, что `import type` стирается компилятором целиком —
// ни одного байта модуля в клиентском чанке не появляется. Взамен словарь
// кодов один на оба конца провода, и расхождение ловит компилятор.
import type {
  ClientEngTemplatePlaceholder,
  HeClientAutopilotHoldCode,
  HeClientRefillState,
  HeClientStageErrorCode,
  HeTemplateRewriteReason,
} from '@/lib/hypothesisEngine/clientEngProjection';
// Тоже только тип: поля брифа, в которых проверка писем нашла наш бренд.
import type { HeBrandInputField, HeBrandInputLeak } from '@/lib/hypothesisEngine/letterBrandGuard';
// Тоже только тип: набор причин этапа 'attention' один на оба конца провода.
import type { EngDashAttention } from '@/lib/hypothesisEngine/engDashboard';
// Тоже только типы: сводка отправки запуска и коды неудачного старта.
import type { HeEngSendingSummary, HeEngStartErrorCode } from '@/lib/hypothesisEngine/engCampaignStatus';

/** Нейтральная английская подстановка вместо русской из scrubBrand. */
const SENDING_SERVICE_EN = 'sending service';

/**
 * Сообщение `AuthExpiredError` задано по-русски в общем `lib/authFetch.ts`
 * (его читает и RU-кабинет), поэтому английский вариант подставляем здесь.
 */
const AUTH_EXPIRED_EN =
  'Your session has expired. Open the sign-in page in a new tab — the text in this form will be kept.';

/**
 * Кириллица в тексте, доехавшем до английского кабинета, — всегда признак, что
 * фраза написана для staff (стадия, воркер, RU-роут), а не для клиента рынка.
 */
const CYRILLIC_RE = /[Ѐ-ӿ]/;

/**
 * След отказа подрядчика движка в тексте — БЕЗ имён самих подрядчиков.
 * `scrubBrand` знает только рассыльщика, а отказы LLM- и поискового провайдера
 * собирает наш же код в узнаваемой форме: «<Имя> <HTTP-статус>: <тело>» и
 * «<Имя> transport: …» (lib/hypothesisEngine/llm.ts), «<Имя> billing |
 * configuration | transient | query rejected: …» (lib/search/serperClient.ts);
 * третья примета — сырое JSON-тело ответа. Такую строку клиенту показывать
 * нельзя: она говорит лишь то, на чём мы собраны.
 *
 * Раньше здесь был список имён (`Requesty|Serper|OpenRouter`), но этот модуль
 * едет в браузерный чанк кабинета, и список сам рассказывал, на чём мы
 * собраны, — тот же класс утечки, что и классификатор, который отсюда убран.
 * Форма ловит те же строки: имя без статуса и без префикса причины в отказах
 * провайдеров не встречается.
 */
const PROVIDER_TRACE_RE =
  /\b[A-Za-z]+\s+(?:HTTP\s*)?\d{3}\s*[:(]|\b[A-Za-z]+\s+(?:billing|configuration|transient|transport|query rejected):|\{\s*"/;

/**
 * Где показана ошибка стадии — от этого зависит, какое действие у клиента
 * вообще есть:
 *  - `research`   — шапка мастера и список проектов (`he_projects.error`, его
 *                   пишут только research-стадии); повтор — «Try again»
 *                   шага 1, и только после технического сбоя
 *                   (heResearchRetryAllowed, clientFailureText.ts);
 *  - `collection` — карточка основной базы вертикали; новую сборку ставит
 *                   «Launch» шага 3;
 *  - `refill`     — карточка прогона ежедневного долива («auto-refill: …»).
 *                   Перезапустить ночь клиент не может (её ставит крон), а
 *                   пойдёт ли следующая, решают конфиг, пауза и бюджет —
 *                   их показывает Command Center, а не эта карточка.
 */
export type EngFailureScope = 'research' | 'collection' | 'refill';

/**
 * Остановка руками — не сбой, и объяснять её надо другими словами, чем любой
 * код справочника («у вас что-то сломалось» вместо «вы это отменили» — прямая
 * ложь). Сами строки-маркеры и их сверку см. в `STAGE_CANCELLED_MARKERS`
 * проекции: разбор живёт на сервере, сюда приезжает уже код.
 *
 * «Всё собранное сохранено» здесь НЕ пишется: cancel-роут кабинета снимает с
 * отменённой базы харвест (`dropCancelledBaseHarvest`), а строки базы пишет
 * только финальная запись стадии — у базы, отменённой посреди сборки, других
 * копий собранного нет. Отменённая на анализе база строки хранит, но и её
 * «Launch» не переиспользует: упавшая база новую сборку не
 * останавливает, и та собирает заново.
 */
const CANCELLED_BASE_HEAD_EN =
  'Work on this base was cancelled before it finished, so this base will not be launched.';

/**
 * Отменённый research кабинет заново не запускает: повтор — только после
 * технического сбоя (решение владельца 10.10.2026), а отмена — решение
 * человека. Поэтому действие — Support (запустить заново может команда).
 */
const STAGE_CANCELLED_EN: Record<EngFailureScope, string> = {
  research:
    'The research was cancelled before it finished. This cabinet starts research again only when it stops because of a technical problem, so message Support if you need it researched.',
  collection:
    `${CANCELLED_BASE_HEAD_EN} If you still need this market, «Launch» on step 3 starts a new collection for it — it does not reuse this base.`,
  // «stopped», а не «cancelled»: тот же маркер базе прогона пишет и пропуск
  // ночи, чьи кампании не брали контакты (stages/baseCollectRefill.ts, отказ
  // с stats.sending_skip без очереди переноса), — его никто не отменял.
  refill: `This top-up run stopped before it finished. ${HE_REFILL_RUN_KEPT_EN} A top-up run is not restarted by hand; «Daily top-up» in the Command Center shows whether the daily top-up goes on.`,
};

/**
 * Коды, у которых в справочнике уже ДОЛИВНОЕ действие: ёмкость, дневной кап и
 * тариф клиента. У остальных «что делать» говорит про кнопки перезапуска
 * research/сборки — для ночи долива это неправда, их заменяет общий доливный
 * ответ.
 */
const REFILL_OWN_ACTION_CODES: ReadonlySet<HeClientErrorCode> = new Set<HeClientErrorCode>([
  'sending_capacity',
  'refill_budget_spent',
  'refill_repeat_run',
  'subscription_inactive',
  'awaiting_payment',
  'contacts_exhausted',
]);

/**
 * Запасной текст ЖИВОГО ответа, который показывать нельзя (кириллица или след
 * отказа подрядчика после скраба). Раньше здесь классифицировали сырую строку прямо в
 * браузере — ради этого классификатор и ехал в клиентский чанк. Живые ответы
 * кабинета — английские константы роутов, и разбор такой строки давал
 * `unknown` с текстом про «шаг движка» даже для неудачного сохранения формы.
 * Поэтому здесь одна честная фраза про запрос, а не про стадию.
 */
const LIVE_FAILED_EN =
  'The request did not go through because of a problem on our side. Try again in a minute; if it keeps failing, message Support.';

/**
 * Скраб без подстановки объяснения: `null`, если текст и после скраба показывать
 * нельзя (кириллица — фраза писалась для staff; след отказа подрядчика — светит,
 * на чём мы собраны).
 *
 * Вынесено из `engErrorText` отдельной функцией, чтобы вызывающий мог подставить
 * СВОЙ общий текст. Объяснения классификатора написаны про стадии движка
 * («everything collected so far is saved», «start the step again»), и на экранах
 * вне движка — например на подключении почты — звучат мимо и отбирают у клиента
 * то, что он мог бы починить сам.
 */
export function engSafeText(raw: string): string | null {
  const scrubbed = scrubBrand(raw).replace(/система рассылки/gi, SENDING_SERVICE_EN);
  if (CYRILLIC_RE.test(scrubbed) || PROVIDER_TRACE_RE.test(scrubbed)) return null;
  return scrubbed;
}

/**
 * Текст ЖИВОГО ответа кабинета: без бренда и без русской подстановки.
 *
 * Страховка на конце: если после скраба остался русский текст или след отказа
 * подрядчика — фраза пришла не из английской константы роута, и показывать её
 * нельзя. Тогда отдаём общую константу `LIVE_FAILED_EN`: ни один байт входа
 * наружу не уходит.
 */
export function engErrorText(raw: string): string {
  return engSafeText(raw) ?? LIVE_FAILED_EN;
}

/**
 * Текст СОХРАНЁННОЙ ошибки стадии для карточки базы/проекта — по коду причины,
 * который посчитал роут (`toClientEngStageErrorCode`), и по месту показа
 * (`EngFailureScope`).
 *
 * Функция принимает КОД, а не строку, и это не косметика: пока на вход шла
 * сырая `he_*.error`, текст стадии физически лежал в теле ответа и был виден в
 * devtools. Теперь его там нет — разбирать в браузере просто нечего.
 *
 * Собирается ответ только из констант: `STAGE_CANCELLED_EN` здесь и тексты
 * справочника `clientFailureText` (он тоже не пропускает наружу ни байта
 * входа). `unknown` — общая английская формулировка: причина у staff остаётся
 * в самой колонке `he_*.error`, в `he_jobs.error` и в логах воркера, а в
 * кабинете её не логируем, чтобы не вернуть утечку через консоль.
 *
 * У ночи долива «что уцелело» одно на все коды (`HE_REFILL_RUN_KEPT_EN`):
 * тексты справочника про «законченные шаги» и «собранные контакты» писались
 * для основной сборки, а у ночи долива уцелевшее — только то, что уже в
 * кампании.
 */
export function engStageErrorText(code: HeClientStageErrorCode, scope: EngFailureScope): string {
  if (code === 'cancelled') return STAGE_CANCELLED_EN[scope];
  const failure = heClientFailureFor(code);
  if (scope !== 'refill') return formatHeClientFailure(failure);
  return formatHeClientFailure({
    title: failure.title,
    whatIsSaved: HE_REFILL_RUN_KEPT_EN,
    whatToDo: REFILL_OWN_ACTION_CODES.has(code) ? failure.whatToDo : HE_REFILL_RUN_WHAT_TO_DO_EN,
  });
}

/** Первое предложение основной базы, упавшей без записанной причины (шаг 3). */
export const ENG_NO_REASON_BASE_HEAD_EN =
  'This collection stopped without a recorded reason, so this base will not be launched.';

/**
 * Остановленная основная база, которая НЕ решает, что дальше с вертикалью: у
 * вертикали есть своя авто-база новее, либо собирающаяся, анализирующаяся или
 * проанализированная (EngStepBases, `stopTextOffersRestart`). «Launch» решает
 * по ПОСЛЕДНЕЙ своей базе — новой сборки при живой или готовой базе не ставит,
 * а после остановки HE_COLLECT_STOP_REPEATS_CODES не ставит вовсе
 * (autopilotReconcile.ts), — а «Collect again» рисуется только у последней
 * остановленной. Поэтому у такой базы совет «перезапустите» был бы неправдой:
 * вместо «что делать» — одна фраза, действие показано на той, другой базе.
 * Заголовок и «что уцелело» — те же, что у полного текста (`engStageErrorText`).
 */
const EARLIER_BASE_NOTE_EN =
  'Another base of this market is newer, still being collected or already collected, so this stopped one needs nothing from you.';

export function engEarlierBaseStopText(code: HeClientStageErrorCode | null): string {
  if (code === null) return `${ENG_NO_REASON_BASE_HEAD_EN} ${EARLIER_BASE_NOTE_EN}`;
  if (code === 'cancelled') return `${CANCELLED_BASE_HEAD_EN} ${EARLIER_BASE_NOTE_EN}`;
  const failure = heClientFailureFor(code);
  return `${failure.title} ${failure.whatIsSaved} ${EARLIER_BASE_NOTE_EN}`;
}

/**
 * Отправка аккаунта выключена сотрудником (выключатель 'revoked'; так и после
 * разблокировки, пока сотрудник не включит отправку). Строка вместо «нажмите
 * X» у кнопок, которые тогда откажут 403 sending_turned_off: «Launch» и
 * «Launch now» (роуты запуска), «Rewrite letters» и «Collect again» (общая
 * проверка engSendingSwitchRefusal), «Start sending» / «Resume» (старт
 * отправки проверяет выключатель сам). Кабинет эти кнопки тогда не рисует или
 * выключает.
 */
export const ENG_SENDING_OFF_EN = 'Sending is turned off for your account. Message Support.';

/**
 * Последняя остановленная основная сборка рынка при выключенной отправке
 * аккаунта: заголовок и «что уцелело» — те же, что у полного текста
 * (`engStageErrorText`), а вместо «что делать» — ENG_SENDING_OFF_EN: новую
 * сборку ставят только «Launch» и «Collect again», и обе тогда откажут.
 */
export function engBaseStopSendingOffText(code: HeClientStageErrorCode | null): string {
  if (code === null) return `${ENG_NO_REASON_BASE_HEAD_EN} ${ENG_SENDING_OFF_EN}`;
  if (code === 'cancelled') return `${CANCELLED_BASE_HEAD_EN} ${ENG_SENDING_OFF_EN}`;
  const failure = heClientFailureFor(code);
  return `${failure.title} ${failure.whatIsSaved} ${ENG_SENDING_OFF_EN}`;
}

/**
 * Почему карточка вертикали Command Center в этапе 'attention' — только «что
 * произошло» (у кодов, которые чинит команда, это два предложения
 * HE_TEAM_ON_IT_EN); «что делать» карточка говорит строкой «next: …» и ведёт
 * туда, где полный текст (шаг 3 для базы, шапка проекта и шаг 1 для research).
 *
 * Собирается только из констант: заголовок справочника по коду
 * (`heClientFailureFor(code).title` — та же фраза, с которой начинается
 * объяснение базы на шаге 3 и «Last error» шапки проекта, поэтому экраны не
 * расходятся) либо своя фраза для отмены, отсутствующей причины и пустой
 * базы. Каждая правдива для любой строки своей причины:
 *  - отмена ('cancelled') — базу пишут 'failed' оба cancel-роута, и это
 *    не сбой, а решение человека: «was cancelled», без «failed»;
 *  - причины нет (`code` null) — колонка ошибки пуста: «without a recorded
 *    reason», ничего не выдумываем;
 *  - `base_empty` — последняя своя база 'analyzed' с нулём строк: запускать из
 *    неё нечего, и это всё, что про неё известно (причины у такой базы нет).
 */
const ATTENTION_CANCELLED_BASE_EN =
  'Work on the latest base of this market was cancelled before it finished, so that base will not be launched.';
const ATTENTION_NO_REASON_BASE_EN =
  'Collecting the latest base of this market stopped without a recorded reason, so that base will not be launched.';
const ATTENTION_EMPTY_BASE_EN =
  'The latest base of this market came back with no rows, so there is nothing to launch from it.';
const ATTENTION_CANCELLED_RESEARCH_EN = 'The research of this project was cancelled before it finished.';
const ATTENTION_NO_REASON_RESEARCH_EN = 'The research of this project stopped without a recorded reason.';

export function engDashAttentionText(attention: EngDashAttention): string {
  switch (attention.reason) {
    case 'base_empty':
      return ATTENTION_EMPTY_BASE_EN;
    case 'base_stopped':
      if (attention.code === 'cancelled') return ATTENTION_CANCELLED_BASE_EN;
      return attention.code ? heClientFailureFor(attention.code).title : ATTENTION_NO_REASON_BASE_EN;
    case 'project_failed':
      if (attention.code === 'cancelled') return ATTENTION_CANCELLED_RESEARCH_EN;
      return attention.code ? heClientFailureFor(attention.code).title : ATTENTION_NO_REASON_RESEARCH_EN;
  }
}

/**
 * Прогон долива упал, а причины в колонке нет (стадию убили вместе с подом,
 * легаси-строка). Тот же доливный ответ, что и у кодов без своего действия.
 */
export function engRefillStoppedText(): string {
  return `This top-up run stopped without a recorded reason. ${HE_REFILL_RUN_KEPT_EN} ${HE_REFILL_RUN_WHAT_TO_DO_EN}`;
}

/**
 * Пауза автопилота: код из проекции (`toClientEngAutopilotHold`) → английская
 * фраза. Тексты живут ЗДЕСЬ, а не в справочнике `clientErrors`, намеренно — и
 * по той же причине, по которой там нет `cancelled`: справочник описывает СБОИ
 * стадии (у каждого кода есть «что уцелело» и «что делать»), а пауза — это не
 * сбой стадии, а несделанный шаг координатора, и подавать её в форме сбоя —
 * такая же ложь, как молчать.
 *
 * Правила формулировок:
 *  - у КАЖДОГО кода назван следующий шаг: у `retrying` — уже существующая
 *    кнопка «Launch» шага 3; у `stage_stopped` — карточки рынков шага 3, а
 *    не «Launch»: код один на проект и не говорит, ЧТО встало, а «Launch»
 *    двигает не всё (сборку с повторяющейся остановкой, анализ, который он не
 *    ставит заново, и письма с исчерпанным бюджетом — нет), поэтому что
 *    нажать, говорит карточка самого рынка, и без такой карточки — Support;
 *    у остальных — Support (чат кабинета, отвечает команда; менеджера у
 *    self-serve кабинета нет). НОВОЙ кнопки, запускающей платную работу,
 *    кабинет для них не предлагает и не должен;
 *  - про автоматический повтор здесь НЕ обещано ничего, хотя у `read_failed` и
 *    `enqueue_failed` он предусмотрен: ночной проход
 *    (`runHeAutopilotReconcilePass`) выключен флагом `HE_AUTOPILOT_RECONCILE` и
 *    по умолчанию не запускается вовсе, а текст экрана про env инсталляции
 *    ничего не знает. Обещать «мы вернёмся сами» значило бы описать механизм,
 *    которого на этой установке может не быть — ровно та ложь, из-за которой
 *    остальным трём кодам такую фразу и не написали. Вместо обещания назван
 *    ручной выход, безопасный сам по себе: кнопка идёт тем же идемпотентным
 *    путём (`reconcileHeAutopilotProject`) и уже сделанную работу не повторяет;
 *  - но «ВСЕГДА» про эту кнопку писать НЕЛЬЗЯ, и поэтому текст отправляет НА
 *    ШАГ 3, а не обещает кнопку на нём. Кнопка рисуется только у
 *    исследованного проекта с выбранным рынком и не выключенной отправкой
 *    (EngStepLaunch), а пауза с автопилотом=true доживает и до других
 *    состояний: research проекта может оказаться не законченным (повтор после
 *    технического сбоя или сотрудником, отмена — cancel-роут возвращает проект
 *    в 'draft'), а легаси-доска могла снять все гипотезы. Тогда кнопки на шаге 3
 *    нет, зато он сам говорит, чего ждёт (шаг 1 или шаг 2) — на это текст и
 *    ссылается;
 *  - ни имён таблиц, стадий и провайдеров, ни внутренних id: наружу приехал
 *    КОД, разбирать в браузере уже нечего;
 *  - «команда уже знает» — только там, где пауза шлёт алерт (`spend_paused`);
 *    у `letters_exhausted` и `target_missing` алерта нет, и фраза у них — только
 *    Support (как и в письме об этих паузах, engClientNotice.ts);
 *  - `spend_paused` (потолок расхода, по умолчанию выключен) — общая фраза
 *    HE_SPEND_PAUSED_EN, та же, что в отказе 409 кнопок кабинета: следующий
 *    шаг — за командой, клиенту кнопку не предлагаем (кнопка, начинающая
 *    платную работу, упрётся в тот же потолок). Почему каждое её предложение
 *    правда — у константы.
 */
const AUTOPILOT_HOLD_EN: Record<HeClientAutopilotHoldCode, string> = {
  retrying:
    'We could not read or save the state of this project on the last check, so the next stage was not started. Nothing is lost and nothing was cancelled. Press «Launch» on step 3 to move it on — it picks up where the project stopped and does not repeat work that is already done. If that button is not on step 3, step 3 says what it is waiting for first. If it keeps coming back, message Support.',
  stage_stopped:
    'A paid step of this project stopped with an error earlier, and the autopilot does not pay for the same step twice on its own. Everything collected so far is saved. Each market’s card on step 3 «Launch» says what stopped there and what you can do next; if no card says what to do, message Support.',
  letters_exhausted:
    'Writing the final letters for one of your markets was retried as many times as we allow, so the autopilot stopped retrying and that market is not moving on. Everything collected so far is saved. Message Support to have the letters looked at.',
  target_missing:
    'The autopilot could not tell what to work on next for this project, so it stopped moving it forward. Nothing collected is lost. Message Support to get this project going again.',
  spend_paused: HE_SPEND_PAUSED_EN,
};

/**
 * `retrying` при выключенной отправке аккаунта: «Launch» тогда откажет 403 —
 * вместо неё ENG_SENDING_OFF_EN. Остальные коды «Launch» не называют.
 */
const AUTOPILOT_RETRYING_SENDING_OFF_EN =
  `We could not read or save the state of this project on the last check, so the next stage was not started. Nothing is lost and nothing was cancelled. ${ENG_SENDING_OFF_EN}`;

/** Фраза про паузу автопилота по коду причины; `sendingOff` — выключатель отправки аккаунта 'revoked'. */
export function engAutopilotHoldText(code: HeClientAutopilotHoldCode, sendingOff = false): string {
  if (code === 'retrying' && sendingOff) return AUTOPILOT_RETRYING_SENDING_OFF_EN;
  return AUTOPILOT_HOLD_EN[code];
}

/**
 * Что кабинет говорит про проект, которому остановлен ночной добор
 * (`he_auto_pipeline_configs.refill_paused_at`). Поводов у одной колонки три,
 * и проекция различает их до кабинета (HeClientRefillState): `paused` — нехватка
 * места под новые контакты, `spend_paused` — потолок расхода проекта,
 * `stopped` — проект отменён кнопкой «Cancel all jobs». Фразы у них разные,
 * потому что правда разная; ниже — правила для `paused`, про `spend_paused` и
 * `stopped` — у их текстов.
 *
 * ПРИЧИНУ НЕ НАЗЫВАЕМ. Решение владельца 04.10.2026: про ёмкость, рассыльщика
 * и тарифы клиент не читает ни слова — только общая фраза справочника
 * (`HE_TEAM_ON_IT_EN`, `clientFailureText`), одна на все отказы, которые чинит
 * команда. «Команда уже работает» здесь правда потому, что оба места записи
 * паузы ПО ЁМКОСТИ (stages/baseCollectRefill.ts, autoPipeline.ts) шлют алерт в
 * health-бот (lib/hypothesisEngine/opsAlert.ts); без этих вызовов фразу писать
 * нельзя. Пауза по ПОТОЛКУ РАСХОДА приходит сюда своим `spend_paused`: алерт
 * у неё есть, но «временная проблема, уже работают» про неё неправда — это не
 * сбой. Ещё одно место записи той же колонки — отмена клиентом
 * (pauseHeRefillForClientCancel) — алерта не шлёт, и поэтому эта фраза к ней
 * не применяется: отмена приходит сюда состоянием `stopped`.
 *
 * Правила формулировки — те же, что у пауз автопилота выше, плюс две вещи,
 * которые эта пауза добавляет от себя:
 *
 *  - СРОКА НЕТ И БЫТЬ НЕ МОЖЕТ. Автоснятия по таймеру у паузы намеренно нет:
 *    возвращает проект сотрудник, руками. «Вернёмся завтра/через час» здесь
 *    было бы описанием механизма, которого нет. Поэтому фраза про снятие
 *    паузы — общая с карточкой базы (`HE_REFILL_HOLD_LIFT_EN`): снимает только
 *    команда, по таймеру не вернётся;
 *  - КНОПКИ КЛИЕНТУ НЕ ПРЕДЛАГАЕТСЯ, и текст её не ищет. Возобновление лежит
 *    на staff-поверхности сознательно: клиентская мутирующая ручка означала бы
 *    право клиента начать платную работу у провайдера в момент, когда грузить
 *    всё равно некуда.
 *
 * ПРО СОБРАННОЕ СКАЗАНО РОВНО СТОЛЬКО, СКОЛЬКО ПРАВДА. «Ничего не потеряно»
 * написать нельзя: если место кончилось на ПОЛПУТИ, часть строк той ночи уже
 * уехала в кампанию, а остаток (`stats.deferred` долива) не досылается и
 * теряется. Поэтому фраза говорит только про то, что уже в кампаниях, — это
 * верно для обеих форм отказа (целиком и наполовину). И не говорит, что эти
 * контакты «keep sending»: кампании вертикали клиент мог сам поставить на
 * паузу (S2, кнопка Pause), — правда только то, что пауза добора отправку не
 * останавливает (та же фраза, что у `spend_paused`).
 *
 * `stopped` — ОТМЕНА. Причину называем: её записал сам клиент кнопкой
 * кабинета, и только эту кнопку пишет эта причина (pauseHeRefillForClientCancel
 * зовёт один роут — api/client/eng/projects/[id]/cancel). Ни «временной
 * проблемы», ни «команда уже знает» здесь нет: алерта отмена не шлёт. Вернуть
 * добор может сам клиент — переключатель «Daily top-up» дашборда снимает
 * именно эту паузу (S2, switchHeUsRefill в autoPipeline.ts; паузы ёмкости и
 * потолка он не трогает), «Launch» её не трогает. Лиды из кампаний
 * отмена не убирает (роут отмены рассыльщика не зовёт вовсе). Менять вместе с
 * подтверждением отмены в EngProjectWizard.
 *
 * `spend_paused` — ПОТОЛОК РАСХОДА (lib/hypothesisEngine/spendCeiling.ts,
 * autoPipeline.ts шаг 3a-; по умолчанию потолок выключен, и эту фразу не
 * видит никто). Говорит то же, что HE_SPEND_PAUSED_EN у карточки паузы
 * автопилота, только про добор; причину (деньги, порог) не называем — решение
 * владельца 04.10.2026. Каждое предложение — правда:
 *  - «on hold … paused on our side» — паузу записал потолок, не клиент;
 *  - «does not start any new collection» — ночь под паузой не покупает сборку
 *    (обход конфига кончается до покупки); уже купленную сборку пауза не
 *    обрывает, поэтому «ничего не добавится» не пишем;
 *  - «Our team has been notified» — запись паузы потолком и каждая ночь под
 *    ней шлют алерт (opsAlert, вид 'spend_ceiling'); без него фразу писать
 *    нельзя;
 *  - «continues when they resume it» — таймера нет: снимает паузу только
 *    staff-кнопка (суточный порог отпускает время — когда расход проекта за
 *    скользящие последние 24 часа опустится ниже него, — но паузу добора и
 *    тогда никто не снимает сам). Срока не называем;
 *  - «this hold does not stop sending» — потолок кампаний не касается.
 */
const REFILL_HOLD_EN: Record<EngRefillHoldState, string> = {
  paused: `The daily top-up for this project is on hold. ${HE_TEAM_ON_IT_EN} Everything already added to your campaigns stays there, and this hold does not stop sending. ${HE_REFILL_HOLD_LIFT_EN}`,
  spend_paused:
    'The daily top-up for this project is on hold. It was paused on our side, so the top-up does not start any new collection. Our team has been notified, and the top-up continues when they resume it. Leads already in your campaigns stay there, and this hold does not stop sending.',
  stopped:
    'The daily top-up for this project is off because the project was cancelled with «Cancel all jobs». Leads already added to your campaigns stay there. Turn it on to look for new contacts each night again and add them to the campaigns that can take them.',
};

/** Состояния добора, у которых есть что объяснить отдельным блоком. */
export type EngRefillHoldState = Extract<HeClientRefillState, 'paused' | 'spend_paused' | 'stopped'>;

/**
 * `spend_paused` коротко — для подписей Command Center, где полное
 * предложение не помещается. Правда по тем же причинам, что и полный текст
 * выше (REFILL_HOLD_EN.spend_paused), — менять их только вместе.
 */
export const ENG_REFILL_SPEND_PAUSED_SHORT_EN = 'paused on our side, our team has been notified';

export function engRefillHoldText(state: EngRefillHoldState): string {
  return REFILL_HOLD_EN[state];
}

/**
 * Что кабинет говорит про проект на автопилоте, у которого НЕТ ни идущих
 * стадий, ни паузы.
 *
 * Здоровые решения координатора («база уже готова», «сборка уже стоит»)
 * причины не пишут вовсе, поэтому без этой фразы такой проект — пустой экран,
 * неотличимый от забытого. Фраза намеренно НЕ обещает сроков и не называет
 * стадию: расписание автоматической сверки экран не знает, а состояние, которое
 * мы не читали, выдумывать нельзя.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ «ОТ ВАС НИЧЕГО НЕ НУЖНО». Это была самая частая ложь
 * кабинета. Паузу пишут ТРИ пути, и ни один из них не срабатывает на упавшей
 * платной стадии: координатор ПОСЛЕ done-джобы `chain`/`base_analyze`
 * (`enqueueAutopilotFollowups`), нажатие «Launch» самим клиентом
 * (`reconcileHeAutopilotProject` с trigger='client' — он и пишет, и СНИМАЕТ
 * причину) и ночной проход (выключен флагом, см. `retrying` выше). ФИНАЛЬНЫЙ
 * ФЕЙЛ платной стадии (chain, base_collect, template) не пишет ни паузы, ни
 * кода ошибки проекта: `failJob` воркера правит `he_projects` только для
 * research-стадий (RESEARCH_STAGES, worker/hypothesisEngine.ts), а followups
 * после упавшей джобы не зовут вовсе. То есть самая обычная остановка
 * конвейера выглядит отсюда ровно как «ничего не идёт и ничего не помечено» — и
 * добавлять к этому «ничего не ждёт вас» значило бы сказать «всё хорошо» ровно
 * там, где встало. Вместо необеспеченного обещания названа та же кнопка, что у
 * `retrying`: путь идемпотентный (`reconcileHeAutopilotProject`), уже сделанную
 * работу он не повторяет. И так же, как там, текст отправляет НА ШАГ 3, а не
 * обещает кнопку на нём: автопилот=true доживает и до состояний, где кнопки нет
 * (рынок не выбран, research перезапущен или отменён), и шаг 3 тогда говорит,
 * чего ждёт. Мастер показывает эту фразу только пока у выбранного рынка нет
 * готовых итоговых писем (дальше рынок ведёт автозапуск, и его карточка на
 * шаге 3 говорит, что с ним).
 */
export function engAutopilotIdleText(sendingOff = false): string {
  // Выключатель отправки аккаунта 'revoked': «Launch» откажет 403 — к ней не зовём.
  if (sendingOff) {
    return `Nothing is running on this project right now, and the autopilot has not flagged anything. ${ENG_SENDING_OFF_EN}`;
  }
  return 'Nothing is running on this project right now, and the autopilot has not flagged anything. If you were expecting it to move on by itself, press «Launch» on step 3 — it picks up where the project stopped and does not repeat work that is already done. If that button is not on step 3, step 3 says what it is waiting for first.';
}

/**
 * Письма ready-шаблона запуск откажет (признак проекции `needs_rewrite`,
 * clientEngProjection.heTemplateRewriteReasons: те же гейты писем, что у ядра
 * запуска, шаг 4b″). Один текст на карточку рынка шага 3, причина — словами
 * 409 ядра по причинам проекции (`needs_rewrite_reasons`):
 *  - 'placeholders' (`templateOperatorsUnresolved`): признак ловит ровно те три
 *    формы, что тот текст называет (пустое место, слово-заглушка, сырая
 *    подстановка);
 *  - 'brand' (template_brand_leak): письма называют наш бренд или вымышленную
 *    компанию из примера промпта, а клиент не мы. Самого слова фраза не
 *    печатает: «бренд или название компании, которое не ваше» правда для обоих
 *    видов.
 * Причин нет в ответе (старый ответ, демо) — 'placeholders', как до S4.
 *
 *  - `none` — запуска не было: кампании не созданы, из шаблона не ушло ничего;
 *  - `unfinished` — запуск до гейта, часть аудитории не уехала, а достройку
 *    ядро откажет тем же гейтом. «Ничего не отправлено» здесь неправда (часть
 *    уже в кампаниях), поэтому про отправленное фраза молчит.
 *
 * Действие:
 *  - `none` — кнопка «Rewrite letters» карточки рынка (POST
 *    /eng/templates/[id]/rewrite: новые итоговые письма в пределах бюджета
 *    генераций на анализ; исчерпан — отказ кнопки сам ведёт в Support).
 *    Карточка рисует кнопку всегда, когда рисует эту фразу; при выключенной
 *    отправке аккаунта (`sendingOff`) — ни кнопки, ни «Press», а
 *    ENG_SENDING_OFF_EN. Наш бренд в поле брифа (`brandInputs`, строка
 *    проекта `letters_brand_inputs`): роут переписки откажет, пока поле его
 *    называет, — фраза сначала зовёт поправить поле на шаге 1
 *    (engLettersBrandInputText);
 *  - `unfinished` — Support: письма уже в кампании, и роут переписки такой
 *    шаблон не берёт (409 launched). С причиной 'brand' фраза ещё и прямо
 *    говорит, что кампании рынка, пока отправляют, шлют эти письма уже
 *    загруженным людям (гейты отказывают только новым загрузкам, старту и
 *    «Resume»), — условием «while … is sending»: отправляют ли они сейчас,
 *    карточка не знает (сводку читает EngSendingBlock), а после «Pause» фраза
 *    должна оставаться правдой, — и зовёт нажать «Pause» на этом рынке: кнопку «Pause» блок
 *    отправки карточки (EngSendingBlock) рисует всегда, когда хоть одна
 *    кампания может отправлять (engCampaignStatus, сводка отправки), и пауза
 *    не отказывается ни выключателем, ни гейтом.
 * Обещания «команда уже видит» нет: алерта на это нет.
 */
const TEMPLATE_REWRITE_WHY_EN =
  'they contain a placeholder (such as a first name) that cannot be filled in from this audience, so ' +
  'recipients would see a blank, a stand-in word or the raw placeholder in its place.';
const TEMPLATE_REWRITE_BRAND_WHY_EN =
  'they mention a brand or company name that is not yours, and letters go out on behalf of your company only.';
const TEMPLATE_REWRITE_PLACEHOLDER_ALSO_EN =
  ' They also contain a placeholder (such as a first name) that cannot be filled in from this audience.';

function templateRewriteWhy(reasons: readonly HeTemplateRewriteReason[] | null): string {
  const brand = reasons?.includes('brand') === true;
  const placeholders = !reasons || reasons.length === 0 || reasons.includes('placeholders');
  if (brand && placeholders) {
    return `${TEMPLATE_REWRITE_WHY_EN} They also mention a brand or company name that is not yours.`;
  }
  return brand ? TEMPLATE_REWRITE_BRAND_WHY_EN : TEMPLATE_REWRITE_WHY_EN;
}

export function engTemplateNeedsRewriteText(
  launch: 'none' | 'unfinished',
  sendingOff = false,
  reasons: readonly HeTemplateRewriteReason[] | null = null,
  brandInputs: readonly HeBrandInputLeak[] = [],
): string {
  const why = templateRewriteWhy(reasons);
  if (launch === 'unfinished') {
    if (reasons?.includes('brand') === true) {
      const also = reasons.includes('placeholders') ? TEMPLATE_REWRITE_PLACEHOLDER_ALSO_EN : '';
      return (
        'These letters mention a brand or company name that is not yours, so the rest of this audience is not ' +
        `added to this market's campaigns.${also} While a campaign of this market is sending, the people already ` +
        'uploaded to it keep getting these letters; press «Pause» on this market to stop that. Message Support to ' +
        'have the letters rewritten.'
      );
    }
    return `Part of this audience has not gone out yet, and these letters cannot finish the launch: ${why} Message Support to have the letters rewritten.`;
  }
  // Выключатель отправки аккаунта 'revoked': «Rewrite letters» откажет 403 —
  // карточка кнопку не рисует, а фраза к ней не зовёт.
  if (sendingOff) {
    return `The final letters did not pass our automatic check, so nothing was sent: ${why} ${ENG_SENDING_OFF_EN}`;
  }
  return brandInputs.length > 0
    ? `The final letters did not pass our automatic check, so nothing was sent: ${why} ${engLettersBrandInputText(brandInputs, 'rewrite')}`
    : `The final letters did not pass our automatic check, so nothing was sent: ${why} Press «Rewrite letters» to have them written again.`;
}

/** Причины `needs_rewrite_reasons` шаблона из проекции; поля нет — null. */
export function engTemplateRewriteReasons(template: unknown): HeTemplateRewriteReason[] | null {
  const raw = (template as { needs_rewrite_reasons?: unknown } | null)?.needs_rewrite_reasons;
  if (!Array.isArray(raw)) return null;
  return raw.filter((r): r is HeTemplateRewriteReason => r === 'placeholders' || r === 'brand');
}

/** Подписи полей шага 1 «Your business» (EngStepBrief.tsx, карточка «Offer & style overrides»). */
const BRAND_INPUT_FIELD_LABEL_EN: Record<HeBrandInputField, string> = {
  signature_override: 'Sender signature',
  offer_override: 'Offer override',
  business_override: 'Business description',
};

/**
 * Наш бренд в полях брифа (`letters_brand_inputs` строки проекта —
 * clientEngProjection, letterBrandGuard.heBrandInputLeaks); нет поля или не
 * тот вид — пусто.
 */
export function engLettersBrandInputs(project: unknown): HeBrandInputLeak[] {
  const raw = (project as { letters_brand_inputs?: unknown } | null)?.letters_brand_inputs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is HeBrandInputLeak =>
      !!i &&
      typeof (i as HeBrandInputLeak).brand === 'string' &&
      Object.prototype.hasOwnProperty.call(BRAND_INPUT_FIELD_LABEL_EN, (i as HeBrandInputLeak).field),
  );
}

function listEn(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Поле шага 1 называет наш бренд, а клиент не мы: пока это так, стадии писем
 * отказывают до платных вызовов (HeLetterBrandInputError), и ни новые письма
 * рынка, ни «Rewrite letters» не пройдут. Фраза называет поле и слово, которые
 * клиент вписал сам, и путь к ним — раскрывающийся блок «What we know about
 * your business» шага 1, кнопка «Save overrides». `then` — кнопка после правки:
 * 'launch' — «Launch» вверху шага 3 (ставит письма заново), 'launch_again' —
 * та же кнопка из ответа на её нажатие (EngStepLaunch, launchResultText),
 * 'launch_or_support' — «Launch» у итоговых писем: их генерацию «Launch»
 * ставит, только пока бюджет писем поколения анализа не исчерпан
 * (heTemplateGenerationBudget; бесплатные отказы за поле брифа его не
 * тратят), поэтому с запасным Support, как у той же строки без поля брифа,
 * 'rewrite' — «Rewrite letters» карточки, 'none' — без кнопки (выключена или
 * откажет: отправка аккаунта выключена, пауза потолка расхода).
 */
export function engLettersBrandInputText(
  inputs: readonly HeBrandInputLeak[],
  then: 'launch' | 'launch_again' | 'launch_or_support' | 'rewrite' | 'none',
): string {
  const fields = [...new Set(inputs.map((i) => i.field))];
  const words = [...new Set(inputs.map((i) => i.brand))];
  const fieldText = listEn(fields.map((f) => `«${BRAND_INPUT_FIELD_LABEL_EN[f]}»`));
  const wordText = listEn(words.map((w) => `"${w}"`));
  const next =
    then === 'launch'
      ? ', then press «Launch» above'
      : then === 'launch_again'
        ? ', then press «Launch» again'
        : then === 'launch_or_support'
          ? ', then press «Launch» above; if the final letters still do not start, message Support'
        : then === 'rewrite'
          ? ', then press «Rewrite letters»'
          : '';
  return (
    `Your ${fieldText} on step 1 ${fields.length > 1 ? 'name' : 'names'} ${wordText}, ` +
    `${words.length > 1 ? 'brands that are' : 'a brand that is'} not your company. ` +
    'Letters go out on behalf of your company, so they are not written while that text is there. ' +
    `On step 1 «Your business», open «What we know about your business», remove ${wordText} from ${fieldText} ` +
    `and press «Save overrides»${next}.`
  );
}

/**
 * Подпись редактора цепочки (ChainEditor, шаги 3 и 5): это ЧЕРНОВИК, а в
 * кампанию уходят письма шаблона (he_templates.letters). Стадия template пишет
 * их ИЗ цепочки и анализа базы и потом цепочку не перечитывает: правка цепочки
 * готовый шаблон не меняет (правки итоговых писем в кабинете нет). Каждая
 * фраза правдива для любой строки своей ветки:
 *  - шаблона по вертикали ещё нет — «written from it later, together with
 *    what we learn about its base»: стадия читает последнюю цепочку вертикали
 *    и анализ базы; «later» ничего не обещает о том, когда (и будет ли вообще —
 *    без собранной базы шаблона нет). «Keeps the wait … with the same number»
 *    — chainTiming.ts: шаблон us-проекта берёт паузу письма цепочки с тем же
 *    номером (кабинет — только us), лесенка остаётся только там, где у цепочки
 *    письма с таким номером нет или его пауза не число либо меньше 1 дня, —
 *    тогда и «set here» нечего держать: такую паузу кабинет задать не даёт, а
 *    пришедшую с сервера редактор помечает как негодную
 *    (heClientChainLettersProblem);
 *  - шаблон есть — «already been written … does not change them»: шаблоны не
 *    перечитывают цепочку. Что правка дойдёт до шаблона, который соберут
 *    позже (новая база вертикали), фраза не отрицает и не обещает.
 * `review` — там, где итоговые письма показаны прямо над редактором.
 */
export function engChainDraftText(hasTemplate: boolean, place: 'letters' | 'review'): string {
  if (!hasTemplate) {
    return 'This is a draft. The final letters for this market are written from it later, together with what we learn about its base, and each final letter keeps the wait set here for the letter with the same number.';
  }
  return place === 'review'
    ? 'This is a draft. The final letters above have already been written, and changing this draft does not change them.'
    : 'This is a draft. The final letters for this market have already been written (see «Preview letters» on step 3), and changing this draft does not change them.';
}

/**
 * Подпись подстановки `{{name}}` в итоговых письмах («Preview letters») — по виду
 * наполнения из проекции (toClientEngTemplatePlaceholders: то же правило, что у
 * гейта писем запуска). Правдиво для любой строки своего вида:
 *  - per_recipient — значение берётся из строки базы получателя (у колонки
 *    компании — очищенное название той же строки); при пустой ячейке —
 *    `stand_in`. Без замены строку с пустой ячейкой не пускает гейт запуска и
 *    долива, поэтому «пусто» получатель не прочтёт и про это фраза молчит;
 *  - same_for_all — колонки нет, всем одна фраза;
 *  - unfilled — база это не наполняет (запуск us-шаблона такие письма
 *    откажет; почему — пишет фраза `needs_rewrite` над письмами).
 */
export function engPlaceholderText(placeholder: ClientEngTemplatePlaceholder): string {
  const token = `{{${placeholder.name}}}`;
  switch (placeholder.fill) {
    case 'per_recipient':
      return placeholder.stand_in
        ? `${token} — taken from each recipient's row in your base; where that row has no value, the letter says «${placeholder.stand_in}».`
        : `${token} — taken from each recipient's row in your base.`;
    case 'same_for_all':
      return `${token} — every recipient reads «${placeholder.stand_in ?? ''}» here.`;
    case 'unfilled':
      return `${token} — nothing in your base fills this in.`;
  }
}

/* ── Отправка кампаний запуска (S2) ── */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Кнопка СТАРТА, которая стоит на карточке при этой сводке (EngSendingBlock):
 * вторая рядом с Pause — «Start the rest» (`secondary_action`), иначе
 * единственная — «Start sending» / «Resume» (`action`). null — кнопки старта
 * нет: аккаунт выключен, запуск до self-serve отправки, клиент поставил паузу,
 * а часть кампаний ещё отправляет. Каждая фраза, которая зовёт нажать старт,
 * называет ровно эту кнопку, а без неё зовёт Support — иначе она отправляла бы
 * к кнопке, которой на экране нет.
 */
export type EngStartButton = 'Start sending' | 'Start the rest' | 'Resume';

export function engStartButtonOf(summary: HeEngSendingSummary): EngStartButton | null {
  if (summary.secondary_action === 'start_rest') return 'Start the rest';
  if (summary.action === 'start') return 'Start sending';
  if (summary.action === 'resume') return 'Resume';
  return null;
}

/**
 * Кнопка старта ПОСЛЕ старта, когда свежей сводки нет (итог запуска из роута
 * запуска: в его ответе сводки нет, а блок отправки дочитает её сам). Тот же
 * выбор, что у сводки (engStartButtonOf / summarizeHeEngSending), по итогу:
 * пауза клиента посреди старта — «Resume»; что-то отправляет — «Start the
 * rest»; ничего — «Start sending». Аккаунт и запуск до self-serve этот путь
 * уже прошли: старт без них не начинается.
 */
function startButtonAfter(r: {
  started: number;
  compensated: number;
  compensation_failed?: number;
  already_sending: number;
}): EngStartButton {
  if (r.compensated > 0 || (r.compensation_failed ?? 0) > 0) return 'Resume';
  return r.started - r.compensated + r.already_sending > 0 ? 'Start the rest' : 'Start sending';
}

/**
 * Почему стоящие кампании не стартовали — по коду старта (engCampaignStatus,
 * HeEngStartErrorCode). Продолжение фразы после «N campaigns were not started:»
 * или «… not sending:», поэтому со строчной буквы и без повтора «not started»;
 * `count` — сколько кампаний в этой голове. Код в сводке несёт
 * ХОТЬ ОДНА стоящая кампания (problem_campaigns ≥ 1, не обязательно все), а
 * итог старта отдаёт код первой из неудачных, — поэтому у нескольких кампаний
 * «one or more of them», а не «they all». Каждая фраза правдива для любой
 * кампании с этим кодом:
 *  - mailboxes_changed — адреса живой кампании не из ящиков проекта или она в
 *    другом воркспейсе: старт отказан проверкой, команде ушёл алерт;
 *  - needs_attention / not_found — рассыльщик остановил кампанию или её нет;
 *  - read_failed — перед стартом кампанию не прочитали, старта не было;
 *  - start_failed — старт отправлен, но проверочное чтение не показало
 *    отправку (или статус не стартуемый);
 *  - start_unconfirmed — ответа на старт нет и проверочное чтение не удалось:
 *    кампания могла начать отправку (не «не стартована»).
 * Повтор (read_failed, start_failed) — той кнопкой, что стоит на карточке
 * (`button`, engStartButtonOf); кнопки нет — Support.
 * `others` — сколько стоящих кампаний этой головы причины НЕ несут (сводка:
 * startable − problem_campaigns); больше нуля и кнопка старта есть — фраза
 * добавляет, что кнопка стартует их (номером, а не «the others»: в голове
 * «These campaigns» бывают и завершённые). Иначе этой части нет.
 */
export function engSendingProblemText(
  code: HeEngStartErrorCode,
  button: EngStartButton | null,
  count: number,
  others = 0,
): string {
  const one = count === 1;
  const retry = button
    ? `Try «${button}» again in a minute; if it keeps failing, message Support.`
    : 'Message Support if this stays this way.';
  const rest =
    button && others > 0 && !one
      ? ` — press «${button}» to start the other ${others === 1 ? 'one' : others.toLocaleString('en-US')}`
      : '';
  switch (code) {
    case 'mailboxes_changed':
      return one
        ? 'it sends from mailboxes that are not the ones set up for your project. Message Support.'
        : `one or more of them send from mailboxes that are not the ones set up for your project${rest}. Message Support.`;
    case 'needs_attention':
    case 'not_found':
      return one
        ? 'our sending service stopped or removed it. Message Support.'
        : `our sending service stopped or removed one or more of them${rest}. Message Support.`;
    case 'read_failed':
      return one
        ? `we could not check it before starting it. ${retry}`
        : `we could not check one or more of them before starting them${rest}. ${retry}`;
    case 'start_failed':
      return one
        ? `the sending service did not confirm its start. ${retry}`
        : `the sending service did not confirm the start of one or more of them${rest}. ${retry}`;
    case 'start_unconfirmed':
      // Код живёт у кампании со статусом «не знаем»; живое чтение заменяет его
      // на start_failed (стоит) или снимает — здесь он почти не бывает.
      return one
        ? 'we could not confirm whether it started — it may be sending; its status shows up within a few minutes.'
        : `we could not confirm whether one or more of them started${rest} — they may be sending; their status ` +
            'shows up within a few minutes.';
  }
}

/** Стоящие кампании без причины (сводка): их кнопка старта стартует. */
function othersWithoutProblem(summary: HeEngSendingSummary): number {
  return summary.problem ? Math.max(0, summary.startable - summary.problem_campaigns) : 0;
}

/**
 * Голова фразы про стоящие кампании (0 / 2) рядом с отправляющими:
 * «2 of 3 campaigns are not sending». Не отправляют и завершённые, и
 * остановленные рассыльщиком — если такие тоже есть, «not sending» про одни
 * стоящие было бы неверным счётом, и голова называет их статус: «paused or not
 * started yet» (2 — пауза, 0 — ни разу не стартовала).
 */
function restHead(summary: HeEngSendingSummary): string {
  const count = summary.startable;
  const verb = count === 1 ? 'is' : 'are';
  const of = `${count.toLocaleString('en-US')} of ${summary.campaigns.toLocaleString('en-US')} campaigns`;
  return count === summary.campaigns - summary.sending ? `${of} ${verb} not sending` : `${of} ${verb} paused or not started yet`;
}

/** Голова той же фразы, когда не отправляет ни одна кампания запуска. */
function noneSendingHead(campaigns: number): string {
  return campaigns === 1 ? 'This campaign is not sending' : 'These campaigns are not sending';
}

/**
 * Запуск до self-serve отправки проекта ('pre_self_serve'): кабинет его кампании
 * не стартует (проверка ящиков пула откажет), кнопки старта нет. Тот же смысл,
 * что у отказа старта ENG_START_PRE_SELF_SERVE_TEXT (engCampaignSending.ts, в
 * клиентский бандл не едет) — менять вместе.
 */
const PRE_SELF_SERVE_EN =
  'This launch was created before sending was set up for your project, so its campaigns cannot be started from here. Message Support.';

/**
 * Тот же запуск до self-serve, пока часть его кампаний отправляет (сводка
 * 'sending', `pre_self_serve`): Pause есть, кнопки старта нет.
 */
const PRE_SELF_SERVE_SENDING_EN =
  'This launch was created before sending was set up for your project: «Pause» stops it, but only Support can start it again.';

/**
 * Отправка аккаунта выключена сотрудником. Пояснение блока отправки печатает её
 * в ЛЮБОМ состоянии сводки (engSendingNote), и ровно её цитирует алерт команде
 * 'revoke_pause_failed' (engSendingAlert.ts) — менять вместе.
 */
const TURNED_OFF_EN = 'Sending is turned off for your account, so campaigns cannot be started. Message Support.';

/** Тег статуса отправки (status-tag карточки). */
export function engSendingTag(summary: HeEngSendingSummary): { label: string; tone: 'green' | 'amber' | 'red' | 'neutral' } {
  switch (summary.state) {
    case 'sending':
      return { label: 'sending', tone: 'green' };
    case 'paused':
      return { label: 'paused', tone: 'neutral' };
    case 'not_sending':
    case 'pre_self_serve':
      // Не «not started»: кампании запуска до self-serve мог стартовать
      // сотрудник, а потом их остановили.
      return { label: 'not sending', tone: 'amber' };
    case 'not_started':
      return { label: 'not started', tone: 'amber' };
    case 'completed':
      return { label: 'completed', tone: 'neutral' };
    case 'attention':
      return { label: 'needs attention', tone: 'red' };
    case 'empty':
      return { label: 'no contacts', tone: 'neutral' };
    case 'unknown':
      return { label: summary.readable ? 'status loading' : 'status unavailable', tone: 'neutral' };
  }
}

/**
 * Строка статуса: «Sending · N sent · M replies», «Paused …», «Completed …» и
 * т. п. Числа — только прочитанные у рассыльщика у ВСЕХ кампаний (иначе их
 * нет вовсе); «replies» — уникальные ответы людей, без автоответов. Статус
 * давно не обновлялся (чтения не удаются) — «as of» с временем последнего.
 */
export function engSendingLine(summary: HeEngSendingSummary): string {
  const counts =
    summary.sent !== null && summary.replies !== null
      ? ` · ${plural(summary.sent, 'email sent', 'emails sent')} · ${plural(summary.replies, 'reply', 'replies')}`
      : '';
  const asOf = summary.status_stale && shortTime(summary.status_as_of) ? ` · as of ${shortTime(summary.status_as_of)}` : '';
  switch (summary.state) {
    case 'sending':
      return (
        (summary.sending < summary.campaigns
          ? `Sending — ${summary.sending} of ${summary.campaigns} campaigns`
          : 'Sending') + counts + asOf
      );
    case 'paused': {
      const at = shortTime(summary.paused_at);
      return `Paused by you${at ? ` on ${at}` : ''}` + counts + asOf;
    }
    case 'not_sending':
      return 'Not sending' + counts + asOf;
    case 'pre_self_serve':
      return 'Not sending — created before self-serve sending' + counts + asOf;
    case 'not_started':
      return 'Not started yet' + counts + asOf;
    case 'completed':
      return 'Completed' + counts + asOf;
    case 'attention':
      return 'Needs attention' + counts + asOf;
    case 'empty':
      return 'These campaigns have no contacts, so there is nothing to send.';
    case 'unknown':
      if (!summary.readable) return 'The sending status of this launch is not available.';
      // Не прочитана часть: прочитанные не отправляют — но непрочитанная может.
      if (summary.unknown > 0 && summary.unknown < summary.campaigns) {
        return (
          `${summary.unknown.toLocaleString('en-US')} of ${summary.campaigns.toLocaleString('en-US')} campaigns: ` +
          'status not read yet' + counts + asOf
        );
      }
      return 'Reading the sending status — it shows up within a few minutes.';
  }
}

/**
 * Стоящие кампании рядом с отправляющими (сводка 'sending', `startable` > 0):
 * сколько не отправляет и почему, и кнопка, если она есть. Без кнопки
 * «Start the rest» (клиент поставил паузу, а часть кампаний ещё отправляет;
 * аккаунт выключен; запуск до self-serve) — только факт: почему не стартовать
 * при выключенном аккаунте и у запуска до self-serve, говорят свои фразы
 * engSendingNote.
 */
function restNotSendingText(summary: HeEngSendingSummary): string {
  const head = restHead(summary);
  const button = summary.secondary_action === 'start_rest' ? 'Start the rest' : null;
  const them = summary.startable === 1 ? 'it' : 'them';
  if (summary.problem) {
    return `${head}: ${engSendingProblemText(summary.problem, button, summary.startable, othersWithoutProblem(summary))}`;
  }
  if (button) return `${head} — press «${button}» to start ${them}.`;
  return `${head}.`;
}

/**
 * Пояснение под строкой — только когда клиенту есть что сделать или понять.
 * null — пояснять нечего. У 'sending' — и про остановленные рассыльщиком, и про
 * стоящие рядом с отправляющими (restNotSendingText): одно другого не
 * отменяет.
 */
export function engSendingNote(summary: HeEngSendingSummary): string | null {
  // Выключенный аккаунт — его фраза в ЛЮБОМ состоянии (её цитирует алерт
  // команде 'revoke_pause_failed'): кампании могут ещё отправлять, если пауза
  // выключения не встала, и старт им закрыт.
  const turnedOff = summary.access === 'turned_off' ? TURNED_OFF_EN : null;
  if (summary.state === 'unknown' && !summary.readable) {
    return turnedOff ?? 'Message Support if this stays this way.';
  }
  const stoppedHead = 'Our sending service stopped or removed one or more campaigns of this launch.';
  if (summary.state === 'sending') {
    const parts = [
      summary.attention > 0 ? (turnedOff ? stoppedHead : `${stoppedHead} Message Support.`) : null,
      summary.startable > 0 ? restNotSendingText(summary) : null,
      summary.pre_self_serve && !turnedOff ? PRE_SELF_SERVE_SENDING_EN : null,
      turnedOff,
    ].filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (summary.attention > 0) return turnedOff ? `${stoppedHead} ${turnedOff}` : `${stoppedHead} Message Support.`;
  if (turnedOff) return turnedOff;
  if (summary.state === 'pre_self_serve') return PRE_SELF_SERVE_EN;
  const button = engStartButtonOf(summary);
  // Стоят не все кампании (часть завершена или её статус не известен) —
  // голова называет число стоящих, а не «These campaigns are not sending».
  const allStand = summary.startable === summary.campaigns;
  const standHead = allStand ? noneSendingHead(summary.campaigns) : restHead(summary);
  if ((summary.state === 'not_sending' || summary.state === 'not_started') && summary.problem) {
    return `${standHead}: ${engSendingProblemText(
      summary.problem,
      button,
      allStand ? summary.campaigns : summary.startable,
      othersWithoutProblem(summary),
    )}`;
  }
  if (summary.state === 'not_sending') {
    // Верно и для кампаний, старт которых не пробовали (не успел), и для
    // неудавшегося: только факт и кнопка.
    const head = standHead;
    const them = summary.startable === 1 ? 'it' : 'them';
    return button
      ? `${head}. Press «${button}» to start ${them}.`
      : `${head}. Message Support if ${summary.startable === 1 ? 'it stays' : 'they stay'} this way.`;
  }
  // Статус части не прочитан, а часть стоит — про стоящие (кнопка «Start the
  // rest» рядом с Pause, если она есть).
  if (summary.state === 'unknown' && summary.startable > 0) return restNotSendingText(summary);
  return null;
}

/** Подпись кнопки карточки (`action` и вторая — `secondary_action`). */
export function engSendingActionLabel(action: 'pause' | 'start' | 'resume' | 'start_rest'): string {
  switch (action) {
    case 'pause':
      return 'Pause';
    case 'resume':
      return 'Resume';
    case 'start_rest':
      return 'Start the rest';
    case 'start':
      return 'Start sending';
  }
}

/**
 * Итог старта: начали / уже отправляли / не стартовали (с причиной) / не
 * успели. `button` — кнопка старта, которая будет на карточке после этого
 * старта (по свежей сводке или startButtonAfter); null — её нет.
 */
function startOutcomeText(
  r: {
    campaigns: number;
    started: number;
    already_sending: number;
    completed: number;
    failed: HeEngStartErrorCode[];
    not_attempted: number;
    unconfirmed?: number;
    compensated: number;
    compensation_failed?: number;
  },
  button: EngStartButton | null,
): string {
  if (r.campaigns === 0) return 'These campaigns have no contacts, so there is nothing to start.';
  const on = r.started - r.compensated + r.already_sending;
  const pauseFailed = r.compensation_failed ?? 0;
  const unconfirmed = r.unconfirmed ?? 0;
  const parts: string[] = [];
  if (pauseFailed > 0) {
    // Pause клиента посреди старта не встала у части кампаний — команде ушёл
    // алерт 'pause_failed' (engSendingAlert), она ставит их на паузу руками.
    parts.push(
      `You paused this market while it was starting, but ${plural(pauseFailed, 'campaign', 'campaigns')} could ` +
        `not be paused yet and may still be sending — our team is stopping ${pauseFailed === 1 ? 'it' : 'them'}.`,
    );
  } else if (r.compensated > 0) {
    parts.push('You paused this market while it was starting, so its campaigns stay paused.');
  } else if (on > 0) {
    parts.push(
      on === r.campaigns
        ? `Sending is on for ${r.campaigns === 1 ? 'the campaign' : `all ${r.campaigns} campaigns`}.`
        : `Sending is on for ${on} of ${r.campaigns} campaigns.`,
    );
  } else if (r.completed < r.campaigns && unconfirmed === 0) {
    parts.push('Sending did not start.');
  }
  // Неясный старт — не «не стартована»: могла начать отправку (Pause есть).
  if (unconfirmed > 0) {
    parts.push(
      r.campaigns === 1
        ? 'We could not confirm whether it started — it may be sending; its status shows up within a few minutes.'
        : `We could not confirm whether ${plural(unconfirmed, 'campaign', 'campaigns')} started — ` +
            `${unconfirmed === 1 ? 'it' : 'they'} may be sending; ${unconfirmed === 1 ? 'its' : 'their'} status shows ` +
            'up within a few minutes.',
    );
  }
  if (r.completed > 0) {
    parts.push(`${plural(r.completed, 'campaign is', 'campaigns are')} already completed.`);
  }
  if (r.failed.length > 0) {
    parts.push(
      `${plural(r.failed.length, 'campaign was', 'campaigns were')} not started: ${engSendingProblemText(r.failed[0], button, r.failed.length)}`,
    );
  }
  if (r.not_attempted > 0) {
    parts.push(
      `${plural(r.not_attempted, 'campaign was', 'campaigns were')} not started yet because this took long — ` +
        (button
          ? `press «${button}» for this market.`
          : `message Support if ${r.not_attempted === 1 ? 'it stays' : 'they stay'} this way.`),
    );
  }
  return parts.join(' ');
}

/** Итог старта кампаний (роут запуска и POST .../sending) — общая форма. */
interface EngStartOutcome {
  campaigns: number;
  started: number;
  already_sending: number;
  completed: number;
  failed: HeEngStartErrorCode[];
  not_attempted: number;
  unconfirmed?: number;
  compensated: number;
  compensation_failed?: number;
}

/**
 * Отказы старта, которые бывают и ПОСЛЕ стартов этого же вызова (выключение
 * аккаунта посреди цикла, желание клиента не прочиталось после цикла):
 * «Sending was not started:» перед ними было бы неправдой — часть кампаний
 * успела стартовать (и поставлена на паузу). Их фраза печатается одна — она
 * верна и до старта, и после.
 */
const START_REFUSALS_AFTER_ACTIVATION: ReadonlySet<string> = new Set([
  'sending_turned_off',
  'sending_not_enabled',
  'sending_state_unavailable',
]);

/**
 * Что сделал запуск с отправкой (`sending` ответа роута запуска,
 * EngLaunchSendingResult в api-client). null — сказать нечего. `after` —
 * свежая сводка из ответа запуска (`sending_summary`): фраза называет кнопку,
 * которая теперь на карточке (engStartButtonOf); сводки нет — кнопку после
 * старта называет startButtonAfter.
 */
export function engLaunchSendingText(
  r: EngStartOutcome & {
    outcome: 'done' | 'skipped' | 'refused' | 'client_paused';
    skip_reason?: 'launch_problem' | 'window_not_applied' | 'not_requested';
    refusal?: { code: string; message: string };
    paused_found?: number;
  },
  after: HeEngSendingSummary | null = null,
): string | null {
  switch (r.outcome) {
    case 'done':
      return startOutcomeText(r, after ? engStartButtonOf(after) : startButtonAfter(r));
    case 'skipped':
      // 'not_requested' этот экран не получает (launchEngTemplate шлёт
      // start_sending всегда), но фраза верна и для него: кампании созданы и не
      // стартованы, а какая кнопка их стартует (или почему никакая), говорит
      // блок отправки вертикали.
      return r.skip_reason === 'window_not_applied'
        ? 'Sending was not started — see the note about the sending window.'
        : r.skip_reason === 'not_requested'
          ? 'The campaigns were created but not started — the sending status of this market shows how to start them.'
          : 'Sending was not started — see the note about the problem with this launch.';
    case 'refused':
      if (!r.refusal) return 'Sending was not started.';
      return START_REFUSALS_AFTER_ACTIVATION.has(r.refusal.code)
        ? r.refusal.message
        : `Sending was not started: ${r.refusal.message}`;
    case 'client_paused': {
      const paused = r.paused_found ?? 0;
      if (paused > 0) {
        // Кампания записи стоит на паузе у рассыльщика — запуск не стартовал
        // ничего (её мог остановить клиент, сотрудник или наша страховка).
        const button = after ? engStartButtonOf(after) : 'Start sending';
        return (
          `${paused === 1 ? 'A campaign' : `${paused.toLocaleString('en-US')} campaigns`} of this market ` +
          `${paused === 1 ? 'is' : 'are'} paused, so this launch did not start any of its campaigns — ` +
          (button ? `press «${button}» to start them.` : 'message Support if they stay this way.')
        );
      }
      const button = after ? engStartButtonOf(after) : 'Resume';
      return `This market is paused, so its campaigns were not started.${button ? ` Press «${button}» to start sending.` : ''}`;
    }
  }
}

/**
 * Итог кнопки Start sending / Start the rest / Resume / Pause (POST
 * .../sending). `after` — свежая сводка из ответа (null — ответа без сводки):
 * по ней фраза итога называет кнопку старта, которая теперь на карточке.
 * Pause, чьё желание не записалось (`state_recorded: false`), — пауза может не
 * удержаться: повторить Pause (если кнопка Pause на карточке есть) или Support.
 */
export function engSendingActionText(
  action: 'start' | 'pause',
  result:
    | EngStartOutcome
    | { campaigns: number; paused: number; failed: number; not_attempted: number; state_recorded?: boolean },
  after: HeEngSendingSummary | null,
): string {
  if (action === 'start' && 'started' in result) {
    return startOutcomeText(result, after ? engStartButtonOf(after) : startButtonAfter(result));
  }
  if ('paused' in result) {
    const notPaused = result.failed + result.not_attempted;
    // «Pause» ещё раз — только если она на карточке (свежая сводка).
    const pauseShown = after !== null && (after.action === 'pause' || after.secondary_action === 'pause');
    if (result.state_recorded === false) {
      const retry = pauseShown
        ? 'Press «Pause» again in a minute; if this keeps happening, message Support.'
        : 'Message Support so we can make sure it stays paused.';
      return notPaused === 0
        ? `Sending is paused, but we could not save that you paused this market, so the pause may not hold. ${retry}`
        : `We could not pause ${plural(notPaused, 'campaign', 'campaigns')} of this launch, so ` +
            `${notPaused === 1 ? 'it' : 'they'} may still be sending, and we could not save that you paused this ` +
            `market. ${retry}`;
    }
    if (notPaused === 0) return 'Sending is paused.';
    // Не вставшие — команде ушёл алерт 'pause_failed' (её паузу держит и
    // доводка при чтении статуса: желание записано).
    return (
      `We could not pause ${plural(notPaused, 'campaign', 'campaigns')} of this launch, so ${notPaused === 1 ? 'it' : 'they'} may still be sending. ` +
      (pauseShown
        ? 'Press «Pause» again in a minute; if it keeps failing, message Support.'
        : `Our team is stopping ${notPaused === 1 ? 'it' : 'them'}; message Support if this keeps happening.`)
    );
  }
  return '';
}

/**
 * Локализует сообщение брошенной ошибки НА МЕСТЕ: экземпляр сохраняем, иначе
 * потеряется `AuthExpiredError` вместе с восстановлением сессии в формах
 * (проверка идёт по полю `code`, не по тексту, — переписать текст безопасно).
 */
export function localizeEngError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  e.message = isAuthExpiredError(e) ? AUTH_EXPIRED_EN : engErrorText(e.message);
  return e;
}
