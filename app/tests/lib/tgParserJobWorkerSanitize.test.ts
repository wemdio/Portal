import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadSanitizeStringCell(): (value: unknown, maxLen: number) => string {
  const filePath = path.resolve(process.cwd(), 'src/lib/tgParser/tgParserJobWorker.ts');
  const src = readFileSync(filePath, 'utf8');
  const marker = 'function sanitizeStringCell(value: unknown, maxLen: number): string {';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('sanitizeStringCell not found');

  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('sanitizeStringCell end not found');
  const fnText = src.slice(start, end + 1);
  const jsFnText = fnText
    .replace('function sanitizeStringCell(value: unknown, maxLen: number): string {', 'function sanitizeStringCell(value, maxLen) {');
  return Function(`${jsFnText}; return sanitizeStringCell;`)() as (value: unknown, maxLen: number) => string;
}

describe('sanitizeStringCell', () => {
  const sanitizeStringCell = loadSanitizeStringCell();

  it('replaces invalid surrogate halves to avoid invalid JSON payloads', () => {
    const invalid = `ok ${String.fromCharCode(0xd800)} mid ${String.fromCharCode(0xdc00)} end`;
    const out = sanitizeStringCell(invalid, 500);
    expect(out).toBe('ok   mid   end');
  });

  it('keeps valid emoji surrogate pairs intact', () => {
    const emoji = 'hello \ud83d\ude00 world';
    const out = sanitizeStringCell(emoji, 500);
    expect(out).toBe(emoji);
  });
});
