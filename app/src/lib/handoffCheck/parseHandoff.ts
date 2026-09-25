/**
 * Разбор сообщения из ветки «Передача проектов». Пример — в спеке. Сообщение
 * пишут руками по шаблону, поэтому разбор терпим к пробелам, регистру и «к»/«k».
 */
export interface ParsedHandoff {
  isHandoff: boolean;
  amoId: number | null;
  amoUrl: string | null;
  /** Рубли из «Стоимость: …»; null — не нашли или не разобрали. */
  statedAmount: number | null;
  /** Текст из «Откуда лид: …». */
  statedSource: string | null;
}

const MARKERS = [
  /(^|\n)\s*продажа\s*($|\n)/i,
  /стоимость\s*:/i,
  /кто\s+завел\s*:/i,
  /откуда\s+лид\s*:/i,
  /ссылка\s+на\s+амо/i,
];

const AMO_LINK = /https?:\/\/[a-z0-9-]+\.amocrm\.(?:ru|com)\/leads\/detail\/(\d+)/i;

// Число: либо разбитое пробелами по тысячам («259 000»), либо слитное («259»,
// «259000»); опциональная десятичная часть через запятую/точку («1,2»).
const NUMBER_RE = /(\d{1,3}(?:[  ]\d{3})+|\d+)([.,]\d+)?/;

// Суффикс сразу после числа (с необязательными пробелами перед ним). Отрицательный
// lookahead отсекает случайное совпадение внутри другого слова («метров» не даёт «м»).
const SUFFIX_RE = /^\s*(тыс\.?|млн\.?|к|k|m|м)(?![a-zа-яё])/i;

const THOUSAND_SUFFIXES = new Set(['тыс', 'тыс.', 'к', 'k']);
const MILLION_SUFFIXES = new Set(['млн', 'млн.', 'm', 'м']);

/**
 * «259k», «179 к», «259 000», «1,2 млн», «250 тыс», «259000 руб» → рубли;
 * не нашли число или получили ≤ 0 → null.
 */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;

  const numberMatch = NUMBER_RE.exec(raw);
  if (!numberMatch) return null;

  const integerPart = numberMatch[1].replace(/[  ]/g, '');
  const decimalPart = numberMatch[2] ? numberMatch[2].slice(1) : null;
  const numericText = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  let value = Number.parseFloat(numericText);
  if (!Number.isFinite(value)) return null;

  const rest = raw.slice(numberMatch.index + numberMatch[0].length);
  const suffixMatch = SUFFIX_RE.exec(rest);
  const suffix = suffixMatch ? suffixMatch[1].toLowerCase() : null;
  if (suffix) {
    if (THOUSAND_SUFFIXES.has(suffix)) value *= 1000;
    else if (MILLION_SUFFIXES.has(suffix)) value *= 1_000_000;
  }

  if (value <= 0) return null;
  return Math.round(value);
}

export function parseHandoff(text: string): ParsedHandoff {
  const markerCount = MARKERS.filter((re) => re.test(text)).length;
  const isHandoff = markerCount >= 2;

  const linkMatch = AMO_LINK.exec(text);
  const amoId = linkMatch ? Number(linkMatch[1]) : null;
  const amoUrl = linkMatch ? linkMatch[0] : null;

  // «.» без флага «s» не переходит через перевод строки — значение само
  // обрезается до конца строки.
  const amountLine = /стоимость\s*:\s*(.+)/i.exec(text);
  const statedAmount = amountLine ? parseAmount(amountLine[1].trim()) : null;

  const sourceLine = /откуда\s+лид\s*:\s*(.+)/i.exec(text);
  const statedSourceRaw = sourceLine ? sourceLine[1].trim() : '';
  const statedSource = statedSourceRaw.length > 0 ? statedSourceRaw : null;

  return { isHandoff, amoId, amoUrl, statedAmount, statedSource };
}
