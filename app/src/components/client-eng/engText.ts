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
  HeClientAutopilotHoldCode,
  HeClientRefillState,
  HeClientStageErrorCode,
} from '@/lib/hypothesisEngine/clientEngProjection';

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
 *                   пишут только research-стадии); перезапуск — «Re-run
 *                   research» шага 1;
 *  - `collection` — карточка основной базы вертикали; новую сборку ставит
 *                   «Start outreach» шага 2;
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
 * «Start outreach» не переиспользует: упавшая база новую сборку не
 * останавливает, и та собирает заново.
 */
const STAGE_CANCELLED_EN: Record<EngFailureScope, string> = {
  research: 'The research was cancelled before it finished. Press «Re-run research» on step 1 to start it again.',
  collection:
    'Work on this base was cancelled before it finished, so this base will not be launched. If you still need this vertical, «Start outreach» on step 2 starts a new collection for it — it does not reuse this base.',
  refill: `This refill run was cancelled before it finished. ${HE_REFILL_RUN_KEPT_EN} A refill run is not restarted by hand; the Command Center shows whether the daily refill goes on.`,
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
  'The request did not go through because of a problem on our side. Try again in a minute; if it keeps failing, contact your manager.';

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

/**
 * Прогон долива упал, а причины в колонке нет (стадию убили вместе с подом,
 * легаси-строка). Тот же доливный ответ, что и у кодов без своего действия.
 */
export function engRefillStoppedText(): string {
  return `This refill run stopped without a recorded reason. ${HE_REFILL_RUN_KEPT_EN} ${HE_REFILL_RUN_WHAT_TO_DO_EN}`;
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
 *    кнопка «Start outreach» шага 2, у остальных трёх — менеджер. НОВОЙ кнопки,
 *    запускающей платную работу, кабинет для них не предлагает и не должен;
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
 *    ШАГ 2, а не обещает кнопку на нём. Кнопка рисуется только при
 *    `canStartOutreach` (`EngStepVerticals`: `status === 'researched'` И хотя бы
 *    одна accepted-гипотеза), а пауза с автопилотом=true доживает и до других
 *    состояний: клиент вправе отклонить все гипотезы или перезапустить и отменить
 *    research (cancel-роут возвращает проект в 'draft'). В обоих случаях кнопки
 *    на шаге 2 нет, зато есть его собственная подсказка `startOutreachHint` —
 *    ровно то, чего экран ждёт; на неё текст и ссылается;
 *  - ни имён таблиц, стадий и провайдеров, ни внутренних id: наружу приехал
 *    КОД, разбирать в браузере уже нечего;
 *  - `spend_paused` (потолок расхода, по умолчанию выключен) — общая фраза
 *    HE_SPEND_PAUSED_EN, та же, что в отказе 409 кнопок кабинета: следующий
 *    шаг — за командой, клиенту кнопку не предлагаем (кнопка, начинающая
 *    платную работу, упрётся в тот же потолок). Почему каждое её предложение
 *    правда — у константы.
 */
const AUTOPILOT_HOLD_EN: Record<HeClientAutopilotHoldCode, string> = {
  retrying:
    'We could not read or save the state of this project on the last check, so the next stage was not started. Nothing is lost and nothing was cancelled. Open step 2 and press «Start outreach» to move it on — it picks up where the project stopped and does not repeat work that is already done. If that button is not on step 2, step 2 says what it is waiting for first. If it keeps coming back, contact your manager.',
  stage_stopped:
    'A paid step of this project stopped with an error earlier, and the autopilot does not pay for the same step twice on its own. Everything collected so far is saved. Our team can see it — contact your manager if you want this project picked up again.',
  letters_exhausted:
    'Writing the letters for this base was retried as many times as we allow for one analysis, so the autopilot stopped retrying. The base and everything collected are saved. Our team can see it — contact your manager to have the letters looked at.',
  target_missing:
    'The autopilot could not tell what to work on next for this project, so it stopped moving it forward. Nothing collected is lost. Our team can see it — contact your manager to get this project going again.',
  spend_paused: HE_SPEND_PAUSED_EN,
};

/** Фраза про паузу автопилота по коду причины. */
export function engAutopilotHoldText(code: HeClientAutopilotHoldCode): string {
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
 * верно для обеих форм отказа (целиком и наполовину).
 *
 * `stopped` — ОТМЕНА. Причину называем: её записал сам клиент кнопкой
 * кабинета, и только эту кнопку пишет эта причина (pauseHeRefillForClientCancel
 * зовёт один роут — api/client/eng/projects/[id]/cancel). Ни «временной
 * проблемы», ни «команда уже знает» здесь нет: алерта отмена не шлёт. Кто
 * вернёт добор — менеджер: снимает паузу только staff-кнопка (refill-pause),
 * «Start outreach» её не трогает. Лиды из кампаний отмена не убирает (роут
 * отмены рассыльщика не зовёт вовсе). Если «Start outreach» когда-нибудь начнёт
 * снимать и эту паузу (открытое решение владельца), менять вместе: эту фразу и
 * подтверждение отмены в EngProjectWizard («only your manager can restart»).
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
  paused: `The daily refill for this project is on hold. ${HE_TEAM_ON_IT_EN} Everything already added to your campaigns stays there and keeps sending. ${HE_REFILL_HOLD_LIFT_EN}`,
  spend_paused:
    'The daily refill for this project is on hold. It was paused on our side, so the refill does not start any new collection. Our team has been notified, and the refill continues when they resume it. Leads already in your campaigns stay there, and this hold does not stop sending.',
  stopped:
    'The daily refill for this project is stopped because the project was cancelled with «Cancel all jobs». Leads already added to your campaigns stay there. Your manager can restart the daily refill.',
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
 * (`enqueueAutopilotFollowups`), нажатие «Start outreach» самим клиентом
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
 * работу он не повторяет. И так же, как там, текст отправляет НА ШАГ 2, а не
 * обещает кнопку на нём: автопилот=true доживает и до состояний, где кнопки нет
 * (все гипотезы отклонены, research перезапущен или отменён), и на шаге 2 тогда
 * стоит его собственная подсказка `startOutreachHint`.
 */
export function engAutopilotIdleText(): string {
  return 'Nothing is running on this project right now, and the autopilot has not flagged anything. If you were expecting it to move on by itself, open step 2 and press «Start outreach» — it picks up where the project stopped and does not repeat work that is already done. If that button is not on step 2, step 2 says what it is waiting for first.';
}

/**
 * Письма ready-шаблона запуск откажет (признак проекции `needs_rewrite`,
 * clientEngProjection.heTemplateNeedsRewrite: тот же гейт писем, что у ядра
 * запуска, шаг 4b″). Один текст на шаги 4 и 5, причина — словами 409 ядра
 * (`templateOperatorsUnresolved`): признак ловит ровно те три формы, что тот
 * текст называет (пустое место, слово-заглушка, сырая подстановка).
 *
 *  - `none` — запуска не было: кампании не созданы, из шаблона не ушло ничего;
 *  - `unfinished` — запуск до гейта, часть аудитории не уехала, а достройку
 *    ядро откажет тем же гейтом. «Ничего не отправлено» здесь неправда (часть
 *    уже в кампаниях), поэтому про отправленное фраза молчит.
 *
 * Действие — к менеджеру, как у 409: письма шаблона клиент не правит (правка
 * цепочки на шаге 3 в готовый шаблон не попадает), а пересборку писем кабинет
 * не запускает. Обещания «команда уже видит» нет: алерта на это нет.
 */
const TEMPLATE_REWRITE_WHY_EN =
  'they contain a placeholder (such as a first name) that cannot be filled in from this audience, so ' +
  'recipients would see a blank, a stand-in word or the raw placeholder in its place.';

export function engTemplateNeedsRewriteText(launch: 'none' | 'unfinished'): string {
  return launch === 'unfinished'
    ? `Part of this audience has not gone out yet, and these letters cannot finish the launch: ${TEMPLATE_REWRITE_WHY_EN} Ask your manager to have the letters rewritten.`
    : `These letters cannot be launched as written: ${TEMPLATE_REWRITE_WHY_EN} Nothing has been sent from this template. Ask your manager to have the letters rewritten.`;
}

/**
 * «Launch all» остановлен отказом, который получил бы и следующий шаблон
 * (классификатор сегментов не ответил: он общий у всех шаблонов прогона).
 * Дописывается к тексту отказа: без неё «Launched 1/4» не говорит, пробовали
 * ли остальные. «Tries them as well» — правда: не тронутые прогоном шаблоны
 * остаются в списке запуска (записи о запуске у них нет), и отказавший тоже.
 */
export function engLaunchRunStoppedText(notTried: number): string {
  return notTried === 1
    ? 'This run stopped here: 1 more template was not tried, and pressing «Launch all (paused)» again tries it as well.'
    : `This run stopped here: ${notTried} more templates were not tried, and pressing «Launch all (paused)» again tries them as well.`;
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
