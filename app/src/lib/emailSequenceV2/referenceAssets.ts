import 'server-only';

import { getMainS3ObjectText } from '@/lib/mainS3Server';

/**
 * Референсные тексты (регламент, структура писем, примеры офферов) лежат
 * в MAIN_S3_BUCKET под фиксированным префиксом. Файлы заливаются
 * один раз вручную (см. README ниже), инструмент только читает.
 *
 * Расположение в бакете (имена ключей фиксированы):
 *   tools/email-sequence-v2/reference/regulation.txt
 *   tools/email-sequence-v2/reference/structure.txt
 *   tools/email-sequence-v2/reference/examples/<имя>.txt   (любое количество, .txt)
 *
 * Список examples определяется конфигом ниже (EXAMPLE_FILE_NAMES).
 * Если хочется добавить ещё пример — заливаем .txt в examples/ и дописываем
 * имя файла сюда.
 */

export const REFERENCE_S3_PREFIX = 'tools/email-sequence-v2/reference';

export const REFERENCE_KEYS = {
  regulation: `${REFERENCE_S3_PREFIX}/regulation.txt`,
  structure: `${REFERENCE_S3_PREFIX}/structure.txt`,
  examplesDir: `${REFERENCE_S3_PREFIX}/examples`,
} as const;

/**
 * Имена файлов-примеров в examples/. Извлекаем .txt-версии из исходных
 * PDF/DOCX (через pdf-parse / mammoth) и кладём руками.
 */
const EXAMPLE_FILE_NAMES: Array<{ fileName: string; title: string }> = [
  { fileName: 'Оффер_DEAZ.IO.txt', title: 'Оффер DEAZ.IO' },
  { fileName: 'Оффер_Flextime.txt', title: 'Оффер Flextime' },
  { fileName: 'Оффер_Markway.txt', title: 'Оффер Markway' },
  { fileName: 'Оффер_ProdavAI.txt', title: 'Оффер ProdavAI' },
  { fileName: 'Оффер_TSMEDIA_оконщики.txt', title: 'Оффер TSMEDIA оконщики' },
  { fileName: 'Оффер_Мир_рекламы.txt', title: 'Оффер Мир рекламы' },
  { fileName: 'Оффер_Экопромцентр.txt', title: 'Оффер Экопромцентр' },
  { fileName: 'оффер_Chatme.txt', title: 'Оффер Chatme' },
  { fileName: 'оффер_Comindware.txt', title: 'Оффер Comindware' },
  { fileName: 'оффер_leonteona.ru.txt', title: 'Оффер leonteona.ru' },
];

export type ReferenceBundle = {
  regulation: string;
  structure: string;
  examples: Array<{ name: string; text: string }>;
};

let cachedBundle: ReferenceBundle | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export class ReferenceAssetsMissingError extends Error {
  missingKeys: string[];
  constructor(missing: string[]) {
    super(
      `Не найдены референсные файлы в S3 (bucket=${process.env.MAIN_S3_BUCKET ?? '<unset>'}): ${missing.join(', ')}. ` +
        'Залейте их вручную в указанные ключи и повторите.',
    );
    this.name = 'ReferenceAssetsMissingError';
    this.missingKeys = missing;
  }
}

export async function loadReferenceBundle(opts?: { force?: boolean }): Promise<ReferenceBundle> {
  const now = Date.now();
  if (!opts?.force && cachedBundle && now - cachedAt < CACHE_TTL_MS) {
    return cachedBundle;
  }

  const missing: string[] = [];

  const regulation = (await getMainS3ObjectText(REFERENCE_KEYS.regulation)) ?? '';
  if (!regulation.trim()) missing.push(REFERENCE_KEYS.regulation);

  const structure = (await getMainS3ObjectText(REFERENCE_KEYS.structure)) ?? '';
  if (!structure.trim()) missing.push(REFERENCE_KEYS.structure);

  const examples: Array<{ name: string; text: string }> = [];
  for (const ex of EXAMPLE_FILE_NAMES) {
    const key = `${REFERENCE_KEYS.examplesDir}/${ex.fileName}`;
    const text = (await getMainS3ObjectText(key)) ?? '';
    if (text.trim()) {
      examples.push({ name: ex.title, text: text.trim() });
    }
    // Отсутствие отдельного примера не критично — пропускаем.
  }

  // Регламент и структура — обязательны, иначе цепочка получится «вслепую».
  if (missing.length > 0) {
    throw new ReferenceAssetsMissingError(missing);
  }
  if (examples.length === 0) {
    throw new ReferenceAssetsMissingError([`${REFERENCE_KEYS.examplesDir}/*.txt`]);
  }

  cachedBundle = {
    regulation: regulation.trim(),
    structure: structure.trim(),
    examples,
  };
  cachedAt = now;
  return cachedBundle;
}
