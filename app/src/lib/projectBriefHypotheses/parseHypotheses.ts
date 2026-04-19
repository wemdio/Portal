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
 * Парсер устойчив к мелким вариациям (жирный label, отсутствие
 * "Гипотеза N:" префикса, текст без `###` разделителей).
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

const BULLET_LINE = /^-\s+(.*)$/;
const TITLE_WITH_NUMBER = /^(?:Гипотеза\s+)?(\d+|N)\s*[:：]\s*(.+)$/i;
const MARKDOWN_EMPHASIS_EDGES = /^\s*[*_]+|[*_]+\s*$/g;

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

  if (!/^###\s/m.test(trimmed)) {
    return [trimmed];
  }

  return trimmed
    .split(/^###\s+/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (!trimmed) {
      // blank line keeps current field intact (continuations may follow)
      continue;
    }

    const bulletMatch = trimmed.match(BULLET_LINE);
    if (bulletMatch) {
      flushCurrent();
      currentField = parseBulletAsField(bulletMatch[1]);
      continue;
    }

    if (currentField) {
      currentField.value = `${currentField.value} ${trimmed}`.trim();
    }
  }

  flushCurrent();

  return { number, title, fields };
}

export function parseHypotheses(markdown: string | null | undefined): HypothesisBlock[] {
  return splitIntoSections(markdown ?? '').map(parseSection);
}
