/**
 * Раскладка дат по корзинам день / неделя / месяц в московском времени.
 *
 * База живёт в UTC, бизнес — в МСК. Без явного сдвига «понедельник» уезжает
 * на три часа, и сделка, заведённая в 01:30 ночи, попадает во вчерашний день.
 * В России нет перехода на летнее время с 2014 года, поэтому фиксированный
 * сдвиг +3 корректен — тот же приём, что в `leadsReport/weekWindow.ts`.
 */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Страховка от бесконечного цикла в buildBuckets, а не бизнес-лимит на длину
 * периода — реальный потолок диапазона дат задаётся выше, на уровне вызывающего
 * кода (валидация параметров дашборда). Если 4000 шагов курсора не хватило,
 * чтобы дойти до последней корзины, buildBuckets бросает исключение вместо
 * того, чтобы вернуть обрезанный ряд — см. throw в конце функции.
 */
const MAX_BUCKETS = 4000;

export type GroupBy = 'day' | 'week' | 'month';

function toMsk(date: Date): Date {
  return new Date(date.getTime() + MSK_OFFSET_MS);
}

function isoDate(msk: Date): string {
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Ключ корзины: дата её начала в МСК, формат YYYY-MM-DD. */
export function bucketKey(date: Date, groupBy: GroupBy): string {
  const msk = toMsk(date);
  if (groupBy === 'month') {
    return isoDate(new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), 1)));
  }
  if (groupBy === 'week') {
    const dow = msk.getUTCDay();            // 0 = вс
    const backToMonday = (dow + 6) % 7;     // пн → 0, вс → 6
    return isoDate(
      new Date(
        Date.UTC(
          msk.getUTCFullYear(),
          msk.getUTCMonth(),
          msk.getUTCDate() - backToMonday,
        ),
      ),
    );
  }
  return isoDate(msk);
}

/** Непрерывный ряд ключей от начала до конца включительно. Пустые корзины нужны:
 *  без них график молча схлопывает провалы, и «ноль встреч в среду» выглядит как
 *  «среды не было». */
export function buildBuckets(from: Date, to: Date, groupBy: GroupBy): string[] {
  if (to.getTime() < from.getTime()) return [];

  const keys: string[] = [];
  const lastKey = bucketKey(to, groupBy);

  const start = toMsk(from);
  let cursor: Date;
  if (groupBy === 'month') {
    cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  } else if (groupBy === 'week') {
    const backToMonday = (start.getUTCDay() + 6) % 7;
    cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - backToMonday),
    );
  } else {
    cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
    );
  }

  // Курсор уже в «МСК-пространстве» (UTC-дата, сдвинутая на +3), поэтому
  // арифметику ведём в нём и ключ берём напрямую, без повторного сдвига.
  for (let guard = 0; guard < MAX_BUCKETS; guard += 1) {
    const key = isoDate(cursor);
    keys.push(key);
    if (key === lastKey) return keys;
    if (groupBy === 'month') {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    } else {
      const stepDays = groupBy === 'week' ? 7 : 1;
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate() + stepDays,
        ),
      );
    }
  }

  // Сюда попадаем, только если MAX_BUCKETS шагов курсора не хватило, чтобы
  // дойти до lastKey. Это не «слишком большой период» сам по себе — единственные
  // два реалистичных сценария: (1) диапазон в десятки лет просочился мимо
  // валидации вызывающего кода, либо (2) баг в арифметике курсора (шаг перестал
  // продвигать дату, и цикл крутится на месте). В обоих случаях громкое падение
  // честнее тихого обрезания ряда: обрезанный график на дашборде читается как
  // «ничего не было» и никто не заметит проблему, а исключение в логе заметят
  // и починят.
  throw new Error(
    `buildBuckets: не удалось дойти до последней корзины за ${MAX_BUCKETS} шагов `
      + `(groupBy="${groupBy}"). Накоплено корзин: ${keys.length}, ожидаемый `
      + `последний ключ: "${lastKey}". Похоже на аномально широкий диапазон дат `
      + 'или баг в арифметике курсора — молчаливое обрезание ряда здесь не выход.',
  );
}
