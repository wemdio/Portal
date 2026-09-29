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
 *    Роуты после волны 0 отдают английскую КОНСТАНТУ роута плюс машинный код
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
// Классификатор ЧИСТЫЙ (ни одного импорта, см. шапку clientErrors.ts), поэтому
// его можно тянуть в 'use client': в бандл уезжает только он сам, без
// supabaseAdmin, 'server-only' и node-модулей.
import {
  formatHeClientFailure,
  heClientErrorText,
  heClientFailureFor,
} from '@/lib/hypothesisEngine/clientErrors';
// ТОЛЬКО ТИП, и это важно: `clientEngProjection` тянет launchHandoff и дальше
// серверный стек, а в бандл кабинета ему нельзя. `isolatedModules: true`
// (tsconfig) гарантирует, что `import type` стирается компилятором целиком —
// ни одного байта модуля в клиентском чанке не появляется. Взамен словарь
// кодов один на оба конца провода, и расхождение ловит компилятор.
import type {
  HeClientAutopilotHoldCode,
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
 * Подрядчики движка. `scrubBrand` знает только рассыльщика, а имена LLM- и
 * поисковых провайдеров приезжают из текста их же ответов — клиенту они
 * говорят лишь то, на чём мы собраны.
 */
const VENDOR_RE = /\b(?:Requesty|Serper|OpenRouter)\b/i;

/**
 * Остановка руками — не сбой, и объяснять её надо другими словами, чем любой
 * код справочника `clientErrors` («у вас что-то сломалось» вместо «вы это
 * отменили» — прямая ложь). Сами строки-маркеры и их сверку см. в
 * `STAGE_CANCELLED_MARKERS` проекции: разбор живёт на сервере, сюда приезжает
 * уже код.
 */
const STAGE_CANCELLED_EN =
  'The run was cancelled before this step finished. Everything collected before the stop is saved — start it again whenever you are ready.';

/**
 * Скраб без подстановки объяснения: `null`, если текст и после скраба показывать
 * нельзя (кириллица — фраза писалась для staff; имя подрядчика — светит, на чём
 * мы собраны).
 *
 * Вынесено из `engErrorText` отдельной функцией, чтобы вызывающий мог подставить
 * СВОЙ общий текст. Объяснения классификатора написаны про стадии движка
 * («everything collected so far is saved», «start the step again»), и на экранах
 * вне движка — например на подключении почты — звучат мимо и отбирают у клиента
 * то, что он мог бы починить сам.
 */
export function engSafeText(raw: string): string | null {
  const scrubbed = scrubBrand(raw).replace(/система рассылки/gi, SENDING_SERVICE_EN);
  if (CYRILLIC_RE.test(scrubbed) || VENDOR_RE.test(scrubbed)) return null;
  return scrubbed;
}

/**
 * Текст ЖИВОГО ответа кабинета: без бренда и без русской подстановки.
 *
 * Страховка на конце: если после скраба остался русский текст или имя
 * подрядчика — фраза пришла не из английской константы роута, и показывать её
 * нельзя. Тогда отдаём объяснение классификатора; он собирает ответ ТОЛЬКО из
 * своих констант, так что ни один байт входа наружу не уходит. Классифицируем
 * ИСХОДНУЮ строку, а не `scrubbed`: правила классификатора опираются в том
 * числе на имена подрядчиков и коды их ответов, скраб бы их сломал.
 */
export function engErrorText(raw: string): string {
  return engSafeText(raw) ?? heClientErrorText(raw);
}

/**
 * Текст СОХРАНЁННОЙ ошибки стадии для карточки базы/проекта — по коду причины,
 * который посчитал роут (`toClientEngStageErrorCode`).
 *
 * Функция принимает КОД, а не строку, и это не косметика: пока на вход шла
 * сырая `he_*.error`, текст стадии физически лежал в теле ответа и был виден в
 * devtools. Теперь его там нет — разбирать в браузере просто нечего.
 *
 * Собирается ответ только из констант: `STAGE_CANCELLED_EN` здесь и тексты
 * справочника `clientErrors` (он тоже не пропускает наружу ни байта входа).
 * `unknown` — общая английская формулировка: причина у staff остаётся в самой
 * колонке `he_*.error`, в `he_jobs.error` и в логах воркера, а в кабинете её
 * не логируем, чтобы не вернуть утечку через консоль.
 */
export function engStageErrorText(code: HeClientStageErrorCode): string {
  if (code === 'cancelled') return STAGE_CANCELLED_EN;
  return formatHeClientFailure(heClientFailureFor(code));
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
 *    КОД, разбирать в браузере уже нечего.
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
};

/** Фраза про паузу автопилота по коду причины. */
export function engAutopilotHoldText(code: HeClientAutopilotHoldCode): string {
  return AUTOPILOT_HOLD_EN[code];
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
 * Локализует сообщение брошенной ошибки НА МЕСТЕ: экземпляр сохраняем, иначе
 * потеряется `AuthExpiredError` вместе с восстановлением сессии в формах
 * (проверка идёт по полю `code`, не по тексту, — переписать текст безопасно).
 */
export function localizeEngError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  e.message = isAuthExpiredError(e) ? AUTH_EXPIRED_EN : engErrorText(e.message);
  return e;
}
