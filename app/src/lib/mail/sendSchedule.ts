import { nextWindowSlot, type SendWindow } from '@/lib/sender/sendWindow';

export { isWithinWindow, nextWindowSlot, type SendWindow } from '@/lib/sender/sendWindow';

/**
 * Темп отправки BYO-кампаний.
 *
 * Прежде вся кампания вставала в очередь одним временем, а воркер выгребал её
 * пачкой по 25 писем с ровной паузой 4 секунды: сто секунд машинно-ровного
 * ритма в любое время суток. Для холодной рассылки это первое, что видно со
 * стороны принимающей почты.
 *
 * Поэтому время каждого письма считается заранее, при постановке кампании:
 * случайная пауза, рабочее окно и дневной лимит ящика. Воркер после этого
 * только отправляет то, чему пришёл срок, и ничего не решает сам.
 */

/** Минимальная и максимальная пауза между письмами одного ящика. */
export const MIN_GAP_SECONDS = 60;
export const MAX_GAP_SECONDS = 180;

/**
 * Окно отправки: будни, 9:00–18:00 по Москве.
 *
 * Пояс получателя взять неоткуда — в очереди есть только адрес и имя. Для
 * русскоязычной базы московское окно почти всегда совпадает с рабочим днём
 * получателя; если понадобится иначе, окно станет настройкой кампании, как в
 * инструменте «Рассылка».
 */
export const BYO_SEND_WINDOW: SendWindow = {
  timezone: 'Europe/Moscow',
  sendHourFrom: 9,
  sendHourTo: 18,
  sendWeekdays: [1, 2, 3, 4, 5],
};

/** Случайная пауза в миллисекундах — без ровного ритма между письмами. */
export function randomGapMs(
  minSeconds = MIN_GAP_SECONDS,
  maxSeconds = MAX_GAP_SECONDS,
): number {
  const span = Math.max(0, maxSeconds - minSeconds);
  return (minSeconds + Math.random() * span) * 1000;
}

/**
 * Время отправки для каждого письма кампании.
 *
 * Дневной лимит ящика размазывается по окну, а не выбирается пачкой в начале:
 * как только на сутки набралось `dailyLimit` писем, отсчёт переезжает в
 * следующее окно.
 */
export function spreadSchedule(opts: {
  count: number;
  /** Не раньше этого момента; по умолчанию — сейчас. */
  from?: Date;
  /** Сколько писем ящику разрешено за сутки. 0 или меньше — без ограничения. */
  dailyLimit?: number;
  window?: SendWindow;
}): Date[] {
  const window = opts.window ?? BYO_SEND_WINDOW;
  const limit = opts.dailyLimit && opts.dailyLimit > 0 ? opts.dailyLimit : Infinity;
  const out: Date[] = [];

  let cursor = nextWindowSlot(opts.from ?? new Date(), window);
  let dayKey = dayNumber(cursor, window.timezone);
  let usedToday = 0;

  for (let i = 0; i < opts.count; i += 1) {
    if (usedToday >= limit) {
      // Лимит на сегодня выбран — переносимся в начало следующего окна.
      cursor = nextWindowSlot(new Date(cursor.getTime() + 24 * 60 * 60 * 1000), window);
      dayKey = dayNumber(cursor, window.timezone);
      usedToday = 0;
    }

    const slot = nextWindowSlot(cursor, window);
    const slotDay = dayNumber(slot, window.timezone);
    if (slotDay !== dayKey) {
      // Окно закрылось и слот уехал на другой день — счётчик суток начинается заново.
      dayKey = slotDay;
      usedToday = 0;
    }

    out.push(slot);
    usedToday += 1;
    cursor = new Date(slot.getTime() + randomGapMs());
  }

  return out;
}

/** Номер суток в зоне окна — чтобы считать дневной лимит по местным датам. */
function dayNumber(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
