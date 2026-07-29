import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface JsonLinesReadResult {
  rows: number;
  sha256: string;
}

export function parseJsonValue<T>(
  raw: Buffer | string,
  label: string,
): T {
  try {
    return JSON.parse(raw.toString()) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function readJsonLines(
  filePath: string,
  label: string,
  onRow: (value: unknown, rowNumber: number) => Promise<void> | void,
): Promise<JsonLinesReadResult> {
  const digest = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(filePath);
  let pending = '';
  let rows = 0;

  const handleLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      throw new Error(`${label} contains an empty JSONL line`);
    }
    rows += 1;
    await onRow(parseJsonValue(line, `${label}:${rows}`), rows);
  };

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    digest.update(chunk);
    pending += decoder.write(chunk);
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      await handleLine(line);
      newlineIndex = pending.indexOf('\n');
    }
  }
  pending += decoder.end();
  if (pending !== '') {
    await handleLine(pending);
  }

  return {
    rows,
    sha256: digest.digest('hex'),
  };
}
