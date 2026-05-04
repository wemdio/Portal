/**
 * Парсер ответа модели для «Цепочки писем 2.0».
 * Поддерживает два формата:
 * 1) Маркеры `---LETTER N---` (предпочтительно).
 * 2) Фолбэк: разбиение по строкам, начинающимся с `Тема:`.
 *
 * Возвращает 4-6 писем с темой и телом.
 */

export type ParsedLetter = {
  letter_index: number;
  subject: string | null;
  body: string;
};

function normalize(text: string): string {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitSubject(content: string): { subject: string | null; body: string } {
  const trimmed = content.trim();
  if (!trimmed) return { subject: null, body: '' };
  const firstLineEnd = trimmed.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  const rest = firstLineEnd === -1 ? '' : trimmed.slice(firstLineEnd + 1);
  const subjectMatch = firstLine.match(/^\s*Тема\s*:\s*(.+)\s*$/i);
  if (subjectMatch) {
    return { subject: subjectMatch[1].trim(), body: rest.trim() };
  }
  return { subject: null, body: trimmed };
}

export function parseLettersFromModelOutput(raw: string): ParsedLetter[] {
  const text = normalize(raw).trim();
  if (!text) return [];

  // Preferred: ---LETTER N--- markers.
  const markerRe = /---\s*LETTER\s*(\d+)\s*---/gi;
  const markers: Array<{ idx: number; n: number }> = [];
  for (;;) {
    const m = markerRe.exec(text);
    if (!m) break;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) markers.push({ idx: m.index, n });
  }

  if (markers.length >= 2) {
    const sorted = [...markers].sort((a, b) => a.idx - b.idx);
    const result: ParsedLetter[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i];
      const start = cur.idx;
      const end = i + 1 < sorted.length ? sorted[i + 1].idx : text.length;
      const block = text.slice(start, end).replace(/---\s*LETTER\s*\d+\s*---/i, '').trim();
      if (!block) continue;
      const { subject, body } = splitSubject(block);
      result.push({ letter_index: cur.n, subject, body });
    }
    // Re-index sequentially in case of duplicates / gaps.
    return dedupAndReindex(result);
  }

  // Fallback: split on lines starting with "Тема:".
  const blocks = text.split(/\n(?=\s*Тема\s*:)/i).map((b) => b.trim()).filter(Boolean);
  if (blocks.length >= 1) {
    return blocks.map((block, i) => {
      const { subject, body } = splitSubject(block);
      return { letter_index: i + 1, subject, body };
    });
  }

  return [];
}

function dedupAndReindex(letters: ParsedLetter[]): ParsedLetter[] {
  const seen = new Set<number>();
  const ordered: ParsedLetter[] = [];
  for (const l of letters) {
    if (seen.has(l.letter_index)) continue;
    seen.add(l.letter_index);
    ordered.push(l);
  }
  ordered.sort((a, b) => a.letter_index - b.letter_index);
  return ordered.map((l, i) => ({ ...l, letter_index: i + 1 }));
}
