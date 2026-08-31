import { z } from 'zod';
import { baseConstructorTool } from './tools/baseConstructor';
import { companyBaseTool } from './tools/companyBase';
import { googleMapsTool, googleNewsTool } from './tools/googleParsers';
import { hhArchiveTool, searchParserTool, yandexDirectTool } from './tools/moreParsers';
import { atsTool, engHiringTool, hhTool } from './tools/parserJobs';
import { yandexMapsTool } from './tools/yandexmaps';
import type { BenchTool } from './types';

/**
 * Единственное место, где перечислены инструменты витрины. Роуты не знают о
 * конкретных инструментах ничего — только про этот реестр. Добавить новый
 * инструмент значит написать адаптер и дописать его сюда; ни один роут при
 * этом не меняется.
 */
const TOOLS: BenchTool[] = [
  baseConstructorTool,
  yandexMapsTool,
  googleMapsTool,
  googleNewsTool,
  hhTool,
  atsTool,
  engHiringTool,
  hhArchiveTool,
  searchParserTool,
  yandexDirectTool,
  companyBaseTool,
];

const BY_ID = new Map<string, BenchTool>(TOOLS.map((tool) => [tool.id, tool]));

export function getBenchTool(id: string): BenchTool | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Пустой список разрешённых — это «ничего не разрешено», а не «разрешено
 * всё». Умолчание должно быть закрытым: свежевыданный ключ без явно
 * проставленных инструментов не должен открывать весь портал.
 */
export function listBenchTools(allowedIds: readonly string[]): BenchTool[] {
  const allowed = new Set(allowedIds);
  return TOOLS.filter((tool) => allowed.has(tool.id));
}

export interface BenchToolDescription {
  id: string;
  kind: 'job' | 'search';
  title: string;
  stop_supported: boolean;
  stop_reason: string | null;
  params: unknown;
}

/**
 * Машинное описание для `GET /tools`.
 *
 * Схема параметров берётся из той же zod-схемы, по которой идёт проверка
 * входа. Поэтому каталог не может разойтись с реальным поведением: если
 * параметр изменился, описание меняется тем же коммитом, а не тогда, когда
 * кто-то вспомнит поправить документацию.
 */
export function describeBenchTool(tool: BenchTool): BenchToolDescription {
  const schema = tool.kind === 'job' ? tool.paramsSchema : tool.filtersSchema;
  return {
    id: tool.id,
    kind: tool.kind,
    title: tool.title,
    stop_supported: tool.kind === 'job' ? tool.stop.supported : false,
    stop_reason: tool.kind === 'job' && !tool.stop.supported ? tool.stop.reason : null,
    params: z.toJSONSchema(schema),
  };
}
