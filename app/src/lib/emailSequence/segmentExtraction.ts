export function extractSegmentBlocks(text: string, marker = '►'): string[] {
  const source = String(text ?? '');
  if (!source.trim()) return [];

  const result: string[] = [];
  let startIdx = 0;
  while (true) {
    const idx = source.indexOf(marker, startIdx);
    if (idx === -1) break;
    const nextIdx = source.indexOf(marker, idx + marker.length);
    const endIdx = nextIdx === -1 ? source.length : nextIdx;
    const block = source.slice(idx, endIdx).trim();
    if (block) result.push(block);
    startIdx = endIdx;
  }
  return result;
}

