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
import type { HeClientStageErrorCode } from '@/lib/hypothesisEngine/clientEngProjection';

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
 * Локализует сообщение брошенной ошибки НА МЕСТЕ: экземпляр сохраняем, иначе
 * потеряется `AuthExpiredError` вместе с восстановлением сессии в формах
 * (проверка идёт по полю `code`, не по тексту, — переписать текст безопасно).
 */
export function localizeEngError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  e.message = isAuthExpiredError(e) ? AUTH_EXPIRED_EN : engErrorText(e.message);
  return e;
}
