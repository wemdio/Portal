import 'server-only';

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractTextFromBriefFile(file: File): Promise<{ text: string; companyHint: string | null }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const lowerName = file.name.toLowerCase();

  let text = '';
  if (lowerName.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    const r = await pdfParse(buffer);
    text = normalizeExtractedText(r.text ?? '');
  } else if (lowerName.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer });
    text = normalizeExtractedText(r.value ?? '');
  } else if (lowerName.endsWith('.doc')) {
    throw new Error('Формат .doc не поддерживается. Сохраните файл как .docx или .pdf.');
  } else {
    text = normalizeExtractedText(buffer.toString('utf-8'));
  }

  return { text, companyHint: guessCompanyName(text) };
}

function guessCompanyName(text: string): string | null {
  if (!text) return null;
  // Простая эвристика: ищем строки вида «Компания: ...», «ООО ...», «Бренд ...»
  const lines = text.split('\n').slice(0, 60);
  const patterns: Array<RegExp> = [
    /(?:^|\b)(?:компания|клиент|бренд|brand|company)\s*[:\-—]\s*([^\n]{2,80})/i,
    /(?:^|\b)название\s*(?:компании|бренда)?\s*[:\-—]\s*([^\n]{2,80})/i,
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        return m[1].trim().replace(/[«»"']/g, '').slice(0, 120);
      }
    }
  }
  return null;
}

/**
 * Извлекает «Ценности [название компании]» из первой строки уже сгенерированного
 * текста (промпт просит ставить такой заголовок на первой строке).
 */
export function extractCompanyNameFromValuesHeader(values: string): string | null {
  const first = String(values ?? '').split('\n')[0]?.trim() ?? '';
  if (!first) return null;
  const m = first.match(/^(?:ценности|values)\s+(.{2,160})$/i);
  if (!m) return null;
  return m[1].trim().replace(/[«»"']/g, '').slice(0, 160);
}
