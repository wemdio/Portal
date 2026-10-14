/**
 * Паузы между письмами финального шаблона — из цепочки, а не из лесенки.
 *
 * ЗАЧЕМ. Клиент выставляет паузы в редакторе цепочки (шаг «Letters» кабинета,
 * PATCH /api/client/eng/chains/[id] → he_chains.letters[].wait_days, клампинг
 * в chainLetters.ts). Стадия template собирала письма шаблона через
 * parsedToChainLetters, то есть с дефолтной лесенкой CHAIN_WAIT_DAYS по
 * индексу письма, и паузы клиента в he_templates не доезжали: в кампанию
 * (buildLaunchSequence → buildCampaignPayloadFromPreset, delay шага = wait_days
 * следующего письма) уходила лесенка, а не то, что клиент видел и правил.
 *
 * ПРАВИЛО. Письмо шаблона с номером i берёт wait_days письма цепочки с тем же
 * номером. Лесенка остаётся только фолбэком: там, где у цепочки нет письма с
 * таким номером (шаблон длиннее цепочки) или паузы у него нет — значение не
 * число или после приведения меньше 1 дня, — у письма остаётся то, что ему уже
 * дала лесенка. Сама лесенка (CHAIN_WAIT_DAYS) здесь не меняется — её значения
 * решение владельца. Первое письмо не трогаем: его wait_days запуск не читает
 * вовсе (delay считается по СЛЕДУЮЩЕМУ письму), а редактор и нормализатор
 * держат у него 0.
 *
 * Почему 0 у письма 2+ — «паузы нет», а не «0 дней». Нормализатор
 * (normalizeHeChainLetters) превращает в 0 всё нечисловое, в том числе
 * пустое поле редактора и отсутствующий ключ, так что 0 в he_chains чаще
 * значит «не задано», чем осознанный выбор, а 0 в кампании — письмо вслед
 * предыдущему без паузы. Задать 0 в кабинете нельзя (heClientChainLettersProblem
 * ниже), лесенку 0 не даёт (CHAIN_WAIT_DAYS[1..] ≥ 3).
 *
 * Значение цепочки приводится так же, как его сохраняет нормализатор
 * (целое, 0..HE_CHAIN_MAX_WAIT_DAYS), — строка, записанная мимо него, не уедет
 * в кампанию с дробной или отрицательной паузой.
 *
 * Модуль ЧИСТЫЙ. applyHeChainTiming зовёт только стадия template и только для
 * market 'us' (RU-инструмент собирает шаблоны с лесенкой, как раньше);
 * heClientChainLettersProblem — редактор цепочки кабинета (ChainEditor) и
 * клиентский роут его сохранения (api/client/eng/chains/[id]); staff-роут
 * цепочек его не зовёт.
 */

import { HE_CHAIN_MAX_WAIT_DAYS } from './chainLetters';

/**
 * Пауза письма цепочки (2+), как её сохранил бы нормализатор; null — паузы
 * нет: не число или после приведения 0 (см. «Почему 0» выше).
 */
function heChainLetterWaitDays(letter: unknown): number | null {
  if (!letter || typeof letter !== 'object') return null;
  const raw = (letter as { wait_days?: unknown }).wait_days;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const days = Math.min(HE_CHAIN_MAX_WAIT_DAYS, Math.max(0, Math.trunc(raw)));
  return days >= 1 ? days : null;
}

export interface HeChainTimingResult<L> {
  letters: L[];
  /** Сколько писем (не считая первого) получили паузу из цепочки. */
  fromChain: number;
  /** Сколько писем (не считая первого) остались на лесенке: у цепочки нет паузы (≥ 1 дня) с таким номером. */
  fromLadder: number;
}

/**
 * Письма шаблона с паузами цепочки по номеру письма. Вход не мутирует;
 * письмо, чья пауза не меняется, остаётся тем же объектом.
 */
export function applyHeChainTiming<L extends { wait_days: number }>(
  letters: readonly L[],
  chainLetters: readonly unknown[] | null | undefined,
): HeChainTimingResult<L> {
  let fromChain = 0;
  let fromLadder = 0;
  const out = letters.map((letter, i) => {
    if (i === 0) return letter;
    const wait = heChainLetterWaitDays(chainLetters?.[i]);
    if (wait === null) {
      fromLadder += 1;
      return letter;
    }
    fromChain += 1;
    return wait === letter.wait_days ? letter : { ...letter, wait_days: wait };
  });
  return { letters: out, fromChain, fromLadder };
}

/**
 * Меньше писем цепочка в кабинете не держит (решение владельца 2026-10-10).
 * Стадия chain и так не пишет цепочку короче трёх писем (`parsed.length < 3`
 * — отказ), так что в нынешнем коде короче она бывает только после полной
 * замены писем staff-инструментом (там 1..6).
 */
export const HE_CLIENT_CHAIN_MIN_LETTERS = 3;

/**
 * Почему письма цепочки нельзя сохранить из кабинета (редактор и клиентский
 * роут — одна проверка, один английский текст); null — можно. Только ENG-
 * контур: staff-роут и RU-инструмент живут по normalizeHeChainLetters (1..6
 * писем, пауза клампится).
 *  - писем меньше HE_CLIENT_CHAIN_MIN_LETTERS;
 *  - у письма 2+ пауза не целое число 1..HE_CHAIN_MAX_WAIT_DAYS. Пустое поле
 *    редактора, 0 и «не число» нормализатор сохранил бы нулём, а шаблон взял бы
 *    вместо него лесенку (applyHeChainTiming) — клиент не увидел бы в кампании
 *    того, что ввёл; дробь и больше максимума нормализатор молча поправил бы.
 * Остальное (тела, темы, варианты, больше 6 писем) проверяет нормализатор.
 */
export function heClientChainLettersProblem(letters: readonly unknown[]): string | null {
  if (letters.length < HE_CLIENT_CHAIN_MIN_LETTERS) {
    return `A sequence needs at least ${HE_CLIENT_CHAIN_MIN_LETTERS} letters, and this one has ${letters.length}, so it cannot be saved.`;
  }
  for (let i = 1; i < letters.length; i += 1) {
    const letter = letters[i];
    const raw = letter && typeof letter === 'object' ? (letter as { wait_days?: unknown }).wait_days : undefined;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > HE_CHAIN_MAX_WAIT_DAYS) {
      return `Step ${i + 1}: the wait must be a whole number of days from 1 to ${HE_CHAIN_MAX_WAIT_DAYS}.`;
    }
  }
  return null;
}
