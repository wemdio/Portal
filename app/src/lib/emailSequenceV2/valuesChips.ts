/**
 * Детерминированный парсер values_text (этап 1 «Цепочек писем 2.0») в группы
 * коротких чипов для UI «Что мы выделили».
 *
 * Формат values_text задан промптом EXTRACT_VALUES_PROMPTS (prompts.ts):
 * нумерованные разделы «1. УТП … 6. Дополнительный контекст» с маркерными
 * подпунктами. Заголовки локализованы (ru/en/pl) — матчим по ключевым словам.
 *
 * НИКАКОГО LLM: чистый текстовый парсинг. Если структура не распозналась
 * (например, модель отклонилась от формата) — возвращаем null, UI показывает
 * полный текст как раньше. Полный текст в любом случае доступен под чипами.
 */

export interface ValuesChipGroup {
  /** Стабильный ключ группы (для key= в React). */
  key: 'offer' | 'benefits' | 'promos' | 'trust';
  /** Заголовок группы в UI («ГЛАВНОЕ ПРЕДЛОЖЕНИЕ» и т.п.). */
  title: string;
  items: string[];
}

/** Порядок и заголовки групп — как в макете. */
const GROUPS: Array<{ key: ValuesChipGroup['key']; title: string; match: RegExp }> = [
  // «Уникальные торговые предложения (УТП)» / USP / Unikalne propozycje
  { key: 'offer', title: 'Главное предложение', match: /утп|уникальн|unique selling|usp|unikalne propozycje/i },
  // «Преимущества продукта/услуги» / benefits / Korzyści
  { key: 'benefits', title: 'Преимущества', match: /преимуществ|benefit|korzyści/i },
  // «Акции и бонусы» / Promotions and bonuses / Promocje i bonusy
  { key: 'promos', title: 'Акции', match: /акци|бонус|promotion|bonus|promocj/i },
  // «Социальные доказательства» / Social proof / Dowody społeczne
  { key: 'trust', title: 'Доверие', match: /социальн|доказательств|social proof|testimonial|dowody/i },
];

const MAX_CHIP_LEN = 90;
const MAX_ITEMS_PER_GROUP = 8;

/** Заголовок раздела: «1. Название…» / «2) Название…» (возможно с ** или ###). */
const SECTION_RE = /^\s*(?:[#*\s]*)(\d+)[.)]\s*(.+?)[\s*:]*$/;

/** Маркер подпункта: -, •, –, — или * в начале строки. */
const BULLET_RE = /^\s*[-•–—*]\s+(.+)$/;

function chipText(raw: string): string {
  // Чип = первая осмысленная часть пункта: до « — описание» / «: детали»,
  // иначе первое предложение, с обрезкой до MAX_CHIP_LEN.
  let t = raw.replace(/\*\*/g, '').trim();
  const sep = t.search(/\s[—–]\s|:\s/);
  if (sep > 8) t = t.slice(0, sep);
  const dot = t.indexOf('. ');
  if (dot > 8) t = t.slice(0, dot);
  t = t.replace(/[.;,\s]+$/, '').trim();
  if (t.length > MAX_CHIP_LEN) t = `${t.slice(0, MAX_CHIP_LEN - 1).trimEnd()}…`;
  return t;
}

/**
 * Разбирает values_text в группы чипов. null — структура не распозналась
 * (ни одной известной секции с пунктами) → UI падает в полнотекстовый вид.
 */
export function parseValuesChips(valuesText: string | null | undefined): ValuesChipGroup[] | null {
  const text = String(valuesText ?? '').trim();
  if (!text) return null;

  const lines = text.split(/\r?\n/);
  const collected = new Map<ValuesChipGroup['key'], string[]>();
  let currentKey: ValuesChipGroup['key'] | null = null;

  for (const line of lines) {
    const section = line.match(SECTION_RE);
    if (section) {
      const heading = section[2];
      const group = GROUPS.find((g) => g.match.test(heading));
      currentKey = group?.key ?? null; // незнакомый раздел (характеристики/контекст) — пропускаем
      continue;
    }
    if (!currentKey) continue;
    const bullet = line.match(BULLET_RE);
    if (!bullet) continue;
    const chip = chipText(bullet[1]);
    if (chip.length < 2) continue;
    const arr = collected.get(currentKey) ?? [];
    if (arr.length >= MAX_ITEMS_PER_GROUP) continue;
    // дедуп без регистра
    if (arr.some((x) => x.toLowerCase() === chip.toLowerCase())) continue;
    arr.push(chip);
    collected.set(currentKey, arr);
  }

  const groups: ValuesChipGroup[] = GROUPS
    .filter((g) => (collected.get(g.key)?.length ?? 0) > 0)
    .map((g) => ({ key: g.key, title: g.title, items: collected.get(g.key)! }));

  return groups.length > 0 ? groups : null;
}
