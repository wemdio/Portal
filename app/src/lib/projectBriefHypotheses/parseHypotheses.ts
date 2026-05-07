/**
 * Лёгкий парсер markdown-вывода AI с гипотезами.
 *
 * Ожидаемый формат (см. system prompt в `sources.ts`):
 *
 *     ### Гипотеза 1: <название>
 *     - Источник: <текст>
 *     - Конкретные фильтры/запросы: <текст, иногда переносится>
 *       продолжение на следующей строке
 *     - Ожидаемый объём: <текст>
 *
 * Парсер устойчив к мелким вариациям:
 *   - bold-обёртка лейбла: `**Источник:** HH`
 *   - заголовки `### `, `## ` или просто `**Гипотеза N: …**`
 *   - вложенные суб-буллеты (`  - …`, `  * …`) — поглощаются в значение текущего поля
 *   - переносы строк внутри значения
 *   - текст без `###` разделителей вообще
 */

export interface HypothesisField {
  label: string;
  value: string;
}

export interface HypothesisBlock {
  number: string;
  title: string;
  fields: HypothesisField[];
}

/** Top-level bullet — line starts at column 0 (or has at most 0 leading spaces). */
const TOP_BULLET_LINE = /^[-*+]\s+(.*)$/;
/** Indented sub-bullet — line starts with whitespace, then a bullet marker. */
const NESTED_BULLET_LINE = /^\s+[-*+]\s+(.*)$/;
const TITLE_WITH_NUMBER = /^(?:Гипотеза\s+)?(\d+|N)\s*[:：]\s*(.+)$/i;
const MARKDOWN_EMPHASIS_EDGES = /^\s*[*_]+|[*_]+\s*$/g;
/**
 * "**Гипотеза 1: title**" without leading `#`. Some models (esp. when stripped
 * of system prompt heading discipline) use bold-only headers. We treat any
 * line that matches this pattern as a section boundary in the splitter.
 */
const BOLD_HYPOTHESIS_HEADING = /^\*\*\s*Гипотеза\s+\d+\s*[:：][^*]*\*\*\s*$/im;

const NESTED_VALUE_SEPARATOR = ' • ';

function stripEmphasis(raw: string): string {
  return raw.replace(MARKDOWN_EMPHASIS_EDGES, '').trim();
}

/**
 * Trying hard to extract `Label: Value` from a bullet body, tolerating
 * `**Label:** Value`, `**Label**: Value`, full-width colons, and bare URLs.
 */
function parseBulletAsField(inner: string): HypothesisField {
  const colonIdx = inner.search(/[:：]/);
  // label cannot be too long (60 chars) and cannot contain `/` — that is
  // typical for bare URL bullets (`https://...`), not for `Label:` lines.
  if (colonIdx > 0 && colonIdx <= 60) {
    const labelRaw = inner.slice(0, colonIdx);
    const valueRaw = inner.slice(colonIdx + 1);
    const label = stripEmphasis(labelRaw);
    // reject only if the candidate label looks like a URL scheme (`http`,
    // `https`, etc.) — bare-URL bullets shouldn't be split as fields.
    const looksLikeUrlScheme = /^[a-z]+$/i.test(label) && /^[/].+/.test(valueRaw.trim().slice(0, 2));
    if (label.length > 0 && !looksLikeUrlScheme) {
      return { label, value: stripEmphasis(valueRaw) };
    }
  }
  return { label: '', value: inner.trim() };
}

function splitIntoSections(markdown: string): string[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];

  // Primary boundary: lines starting with `## ` or `### ` (or more #).
  if (/^#{2,}\s/m.test(trimmed)) {
    return trimmed
      .split(/^#{2,}\s+/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // Secondary boundary: bold-only "**Гипотеза N: title**".
  if (BOLD_HYPOTHESIS_HEADING.test(trimmed)) {
    const sections: string[] = [];
    const lines = trimmed.split(/\r?\n/);
    let current: string[] = [];
    for (const line of lines) {
      if (BOLD_HYPOTHESIS_HEADING.test(line)) {
        if (current.length > 0) sections.push(current.join('\n').trim());
        // Strip ** wrapping so the title line is plain "Гипотеза N: title".
        current = [line.replace(/^\*\*\s*|\s*\*\*\s*$/g, '').trim()];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) sections.push(current.join('\n').trim());
    return sections.filter((s) => s.length > 0);
  }

  // No structured heading at all — return single block.
  return [trimmed];
}

function parseSection(section: string): HypothesisBlock {
  const lines = section.split(/\r?\n/);
  const titleLine = (lines.shift() ?? '').trim();

  let number = '';
  let title = titleLine;
  const titleMatch = titleLine.match(TITLE_WITH_NUMBER);
  if (titleMatch) {
    number = titleMatch[1] === 'N' || titleMatch[1] === 'n' ? '' : titleMatch[1];
    title = titleMatch[2].trim();
  }

  const fields: HypothesisField[] = [];
  let currentField: HypothesisField | null = null;

  const flushCurrent = () => {
    if (currentField) {
      currentField.value = currentField.value.trim();
      fields.push(currentField);
      currentField = null;
    }
  };

  /**
   * Append nested-bullet content to the current field's value.
   *
   * Behaviour:
   *  - if value is empty, replace it with the bullet text
   *  - otherwise join with NESTED_VALUE_SEPARATOR so a list of sub-bullets
   *    renders as `child1 • child2 • child3`
   *
   * If there is no current field (defensive, shouldn't happen with valid
   * input), drop the line — better than producing label-less pollution.
   */
  const appendNested = (text: string) => {
    if (!currentField) return;
    const cleaned = text.trim();
    if (!cleaned) return;
    currentField.value = currentField.value
      ? `${currentField.value.replace(/\s+$/, '')}${NESTED_VALUE_SEPARATOR}${cleaned}`
      : cleaned;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) {
      // blank line keeps current field intact (continuations may follow)
      continue;
    }

    // CHECK NESTED FIRST — TOP_BULLET_LINE only matches lines without leading
    // whitespace, so order matters but is unambiguous here. Sub-bullets of any
    // depth append to the current field instead of becoming siblings.
    const nestedMatch = line.match(NESTED_BULLET_LINE);
    if (nestedMatch) {
      appendNested(nestedMatch[1]);
      continue;
    }

    const topBullet = line.match(TOP_BULLET_LINE);
    if (topBullet) {
      flushCurrent();
      currentField = parseBulletAsField(topBullet[1]);
      continue;
    }

    // Plain continuation line (no bullet, no leading whitespace match).
    if (currentField) {
      const trimmedLine = line.trim();
      currentField.value = currentField.value
        ? `${currentField.value} ${trimmedLine}`.trim()
        : trimmedLine;
    }
  }

  flushCurrent();

  return { number, title, fields };
}

export function parseHypotheses(markdown: string | null | undefined): HypothesisBlock[] {
  return splitIntoSections(markdown ?? '').map(parseSection);
}
