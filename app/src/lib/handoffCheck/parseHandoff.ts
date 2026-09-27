/**
 * Разбор сообщения из ветки «Передача проектов». Пример — в спеке. Сообщение
 * пишут руками по шаблону, поэтому разбор терпим к пробелам, регистру, «к»/«k»
 * и тире вместо двоеточия.
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

// Разделитель после «Стоимость»/«Откуда лид» — двоеточие или любое тире
// (дефис, en-dash, em-dash): в чате его часто подставляет автозамена телефона.
const SEP = '[:—–-]';

/** Строка, где после удаления всего кроме букв остаётся ровно «продажа» — терпимо к эмодзи и знакам («Продажа 🎉», «# Продажа»). */
function hasProdazhaLine(text: string): boolean {
  return text.split('\n').some((line) => {
    const lettersOnly = line.replace(/[^a-zа-яё]/gi, '').toLowerCase();
    return lettersOnly === 'продажа';
  });
}

const MARKER_CHECKS: Array<(text: string) => boolean> = [
  hasProdazhaLine,
  (t) => new RegExp(`стоимость\\s*${SEP}`, 'i').test(t),
  (t) => /кто\s+завел\s*:/i.test(t),
  (t) => new RegExp(`откуда\\s+лид\\s*${SEP}`, 'i').test(t),
  (t) => /ссылка\s+на\s+амо/i.test(t),
];

const AMOUNT_LINE_RE = new RegExp(`стоимость\\s*${SEP}\\s*(.+)`, 'i');
const SOURCE_LINE_RE = new RegExp(`откуда\\s+лид\\s*${SEP}\\s*(.+)`, 'i');

// Схема необязательна — сообщения часто вставляют ссылку без «https://».
const AMO_LINK = /(?:https?:\/\/)?([a-z0-9-]+\.amocrm\.(?:ru|com)\/leads\/detail\/(\d+))/i;

// Число: необязательный минус, затем либо разбитое пробелами по тысячам
// («259 000»), либо слитное («259», «259000»); опциональная десятичная часть
// через запятую/точку («1,2»).
const NUMBER_RE = /(-)?(\d{1,3}(?:[  ]\d{3})+|\d+)([.,]\d+)?/;

// Суффикс сразу после числа (с необязательными пробелами перед ним). Отрицательный
// lookahead отсекает случайное совпадение внутри другого слова («метров» не даёт «м»).
const SUFFIX_RE = /^\s*(тыс\.?|млн\.?|к|k|m|м)(?![a-zа-яё])/i;

const THOUSAND_SUFFIXES = new Set(['тыс', 'тыс.', 'к', 'k']);
const MILLION_SUFFIXES = new Set(['млн', 'млн.', 'm', 'м']);

/**
 * «259k», «179 к», «259 000», «1,2 млн», «250 тыс», «259000 руб» → рубли;
 * не нашли число, получили ≤ 0 или отрицательное → null.
 */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;

  const numberMatch = NUMBER_RE.exec(raw);
  if (!numberMatch) return null;

  const isNegative = Boolean(numberMatch[1]);
  const integerPart = numberMatch[2].replace(/[  ]/g, '');
  const decimalPart = numberMatch[3] ? numberMatch[3].slice(1) : null;
  const numericText = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  let value = Number.parseFloat(numericText);
  if (!Number.isFinite(value)) return null;
  if (isNegative) value = -value;

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
  const markerCount = MARKER_CHECKS.filter((check) => check(text)).length;
  const isHandoff = markerCount >= 2;

  const linkMatch = AMO_LINK.exec(text);
  const amoId = linkMatch ? Number(linkMatch[2]) : null;
  const amoUrl = linkMatch ? `https://${linkMatch[1]}` : null;

  // «.» без флага «s» не переходит через перевод строки — значение само
  // обрезается до конца строки.
  const amountLine = AMOUNT_LINE_RE.exec(text);
  const statedAmount = amountLine ? parseAmount(amountLine[1].trim()) : null;

  const sourceLine = SOURCE_LINE_RE.exec(text);
  const statedSourceRaw = sourceLine ? sourceLine[1].trim() : '';
  const statedSource = statedSourceRaw.length > 0 ? statedSourceRaw : null;

  return { isHandoff, amoId, amoUrl, statedAmount, statedSource };
}
