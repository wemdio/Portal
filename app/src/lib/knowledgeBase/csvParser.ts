export interface ParsedMessage {
  speaker: string;
  text: string;
  date?: string;
}

export interface CsvParseResult {
  messages: ParsedMessage[];
  title: string;
  managerNames: string[];
}

/**
 * Parse a CSV chat export into structured messages.
 * Auto-detects column mapping by header names (case-insensitive, ru/en).
 */
export function parseChatCsv(csvText: string, filename?: string): CsvParseResult {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return { messages: [], title: filename ?? 'Empty CSV', managerNames: [] };
  }

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());

  const speakerIdx = findColumn(headers, ['sender', 'speaker', 'from', 'author', 'отправитель', 'автор', 'имя']);
  const textIdx = findColumn(headers, ['message', 'text', 'body', 'content', 'сообщение', 'текст']);
  const dateIdx = findColumn(headers, ['date', 'time', 'datetime', 'timestamp', 'дата', 'время']);

  if (speakerIdx === -1 || textIdx === -1) {
    return parseFallback(lines, filename);
  }

  const messages: ParsedMessage[] = [];
  const speakerSet = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const speaker = cols[speakerIdx]?.trim();
    const text = cols[textIdx]?.trim();
    if (!speaker || !text) continue;

    speakerSet.add(speaker);
    messages.push({
      speaker,
      text,
      date: dateIdx !== -1 ? cols[dateIdx]?.trim() : undefined,
    });
  }

  return {
    messages,
    title: filename ?? `Chat export (${messages.length} messages)`,
    managerNames: Array.from(speakerSet),
  };
}

function findColumn(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return idx;
  }
  for (const c of candidates) {
    const idx = headers.findIndex(h => h.includes(c));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseFallback(lines: string[], filename?: string): CsvParseResult {
  const messages: ParsedMessage[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const text = cols.join(' ').trim();
    if (text) {
      messages.push({ speaker: 'unknown', text });
    }
  }
  return {
    messages,
    title: filename ?? 'Chat export',
    managerNames: [],
  };
}

function parseRow(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === ';' || ch === '\t') && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
