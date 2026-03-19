const AVG_CHARS_PER_TOKEN = 4;

export interface ChunkResult {
  content: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

/**
 * Split text into chunks of roughly `maxTokens` tokens.
 * Prefers splitting on double-newlines (paragraphs), then single newlines, then sentences.
 * Adds `overlapTokens` tokens of overlap between consecutive chunks.
 */
export function chunkText(
  text: string,
  maxTokens: number = 500,
  overlapTokens: number = 50,
): ChunkResult[] {
  if (!text.trim()) return [];

  const maxChars = maxTokens * AVG_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * AVG_CHARS_PER_TOKEN;

  const paragraphs = text.split(/\n{2,}/);
  const chunks: ChunkResult[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current && (current.length + trimmed.length + 2) > maxChars) {
      chunks.push({
        content: current.trim(),
        tokenCount: estimateTokens(current.trim()),
        metadata: {},
      });
      const overlap = current.slice(-overlapChars);
      current = overlap ? overlap + '\n\n' + trimmed : trimmed;
    } else {
      current = current ? current + '\n\n' + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    chunks.push({
      content: current.trim(),
      tokenCount: estimateTokens(current.trim()),
      metadata: {},
    });
  }

  if (chunks.length === 0 && text.trim()) {
    chunks.push({
      content: text.trim(),
      tokenCount: estimateTokens(text.trim()),
      metadata: {},
    });
  }

  return chunks;
}

/**
 * Chunk a dialogue (array of messages) into conversation segments.
 * Groups messages until they exceed maxTokens, then starts a new chunk.
 */
export function chunkDialogue(
  messages: { speaker: string; text: string; date?: string }[],
  maxTokens: number = 500,
): ChunkResult[] {
  if (messages.length === 0) return [];

  const maxChars = maxTokens * AVG_CHARS_PER_TOKEN;
  const chunks: ChunkResult[] = [];
  let lines: string[] = [];
  let currentLen = 0;
  let firstSpeaker = messages[0]?.speaker ?? '';

  for (const msg of messages) {
    const line = msg.date
      ? `[${msg.date}] ${msg.speaker}: ${msg.text}`
      : `${msg.speaker}: ${msg.text}`;
    const lineLen = line.length + 1;

    if (currentLen > 0 && (currentLen + lineLen) > maxChars) {
      const content = lines.join('\n');
      chunks.push({
        content,
        tokenCount: estimateTokens(content),
        metadata: { first_speaker: firstSpeaker },
      });
      lines = [line];
      currentLen = lineLen;
      firstSpeaker = msg.speaker;
    } else {
      lines.push(line);
      currentLen += lineLen;
    }
  }

  if (lines.length > 0) {
    const content = lines.join('\n');
    chunks.push({
      content,
      tokenCount: estimateTokens(content),
      metadata: { first_speaker: firstSpeaker },
    });
  }

  return chunks;
}
