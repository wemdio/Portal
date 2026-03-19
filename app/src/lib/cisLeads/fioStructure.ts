/**
 * Универсальная проверка структуры ФИО без чёрных списков.
 * Только позитивные паттерны: фамилия (суффикс) + имя + [отчество].
 */

const RU_SURNAME_SUFFIXES = [
  'ов', 'ова', 'ев', 'ева', 'ёв', 'ёва', 'ин', 'ина',
  'ский', 'ская', 'цкий', 'цкая',
  'ко', 'ук', 'юк', 'як', 'ич', 'вич',
  'ых', 'их', 'ец', 'ёнок', 'енко', 'чук', 'чёв',
];

const RU_PATRONYMIC_SUFFIXES = ['ович', 'евич', 'овна', 'евна', 'ич'];

function hasSurnameSuffix(word: string): boolean {
  const w = word.toLowerCase();
  if (w.length < 3) return false;
  return RU_SURNAME_SUFFIXES.some((s) => w.endsWith(s));
}

function hasPatronymicSuffix(word: string): boolean {
  const w = word.toLowerCase();
  return RU_PATRONYMIC_SUFFIXES.some((s) => w.endsWith(s));
}

/**
 * Проверяет, что строка имеет структуру ФИО: 2–3 слова, кириллица,
 * хотя бы одно слово с суффиксом фамилии, при 3 словах — отчество.
 */
export function hasFioStructure(candidate: string): boolean {
  const words = candidate.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  for (const w of words) {
    if (w.length < 2 || w.length > 20) return false;
    if (!/^[А-ЯЁа-яё]+$/.test(w)) return false;
  }
  const hasSurname = words.some((w) => hasSurnameSuffix(w));
  const hasPatronymic = words.length === 3 && hasPatronymicSuffix(words[2]!);
  const twoWords = words.length === 2 && hasSurname;
  const threeWords = words.length === 3 && hasSurname && (hasPatronymic || hasSurnameSuffix(words[2]!));
  return twoWords || threeWords;
}
