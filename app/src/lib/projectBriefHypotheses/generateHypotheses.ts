import { callOpenRouterChat } from '@/lib/openrouter/client';
import { EXPORT_BASE_CATALOG } from './exportBaseCatalog';
import { buildHypothesesPrompt, selectRelevantCatalog, type HypothesesAudience } from './sources';

export const DEFAULT_HYPOTHESES_MODEL =
  process.env.PROJECT_HYPOTHESES_MODEL ?? 'policy/gemini-flash';

// Урезано 60 → 20: при 60 в промпт попадал большой grab-bag export-base
// категорий, и модель добивала ими гипотезы для любого клиента (см. разбор
// прогонов Егора — одни и те же базы у разных ЦА). 20 релевантных достаточно.
const DEFAULT_CATALOG_LIMIT = Number(process.env.PROJECT_HYPOTHESES_CATALOG_LIMIT ?? '20');

const HH_SOURCE_RE = /^-\s*Источник\s*:\s*(?:.*\bHH\b|.*HeadHunter|.*hh\.ru)/im;
const CLIENT_HH_FORBIDDEN_SIZE_METRICS =
  /ССЧ|выручк|оборот|числен\w*|размер\s+(?:компани|бизнес)|микро[-\s]?\w*|крупн\w*\s+бизнес|enterprise|\d+\s*[–-]\s*\d+\s*(?:сотрудник\w*|чел\.?|человек)/i;
const SAFE_HH_CRITERIA =
  '- Критерии сбора / как собрать базу: поиск вакансий по релевантным ролям; регионы и дата публикации; собрать список компаний-работодателей';
const SAFE_HH_RISK =
  '- Риски/нюансы: HH не даёт все данные о компании; перед запуском базу лучше очистить от нерелевантных работодателей.';

function splitHypothesisBlocks(markdown: string): string[] {
  return markdown
    .split(/(?=^###\s+)/m)
    .map((block) => block.trim())
    .filter(Boolean);
}

function cleanHhFieldLine(line: string): string | null {
  if (!CLIENT_HH_FORBIDDEN_SIZE_METRICS.test(line)) return line;

  if (/^-\s*Риски\/нюансы\s*:/i.test(line)) return SAFE_HH_RISK;
  if (/^-\s*Критерии\s+сбора\s*\/\s*как\s+собрать\s+базу\s*:/i.test(line)) {
    const colonIdx = line.indexOf(':');
    const label = colonIdx >= 0 ? line.slice(0, colonIdx + 1) : '- Критерии сбора / как собрать базу:';
    const value = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';
    const safeSegments = value
      .split(';')
      .map((segment) => segment.trim())
      .filter((segment) => segment && !CLIENT_HH_FORBIDDEN_SIZE_METRICS.test(segment));
    return safeSegments.length > 0 ? `${label} ${safeSegments.join('; ')}` : SAFE_HH_CRITERIA;
  }

  return null;
}

function sanitizeClientHhBlock(block: string): string {
  if (!HH_SOURCE_RE.test(block)) return block;
  return block
    .split(/\r?\n/)
    .map(cleanHhFieldLine)
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .trim();
}

export function sanitizeClientHypothesesMarkdown(markdown: string): string {
  return splitHypothesisBlocks(markdown).map(sanitizeClientHhBlock).join('\n\n').trim();
}

export interface GenerateLeadSourceHypothesesOptions {
  apiKey: string;
  briefText: string;
  model?: string;
  catalogLimit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Кому пойдёт результат — 'client' исключает источники из CLIENT_EXCLUDED_SOURCE_IDS. */
  audience?: HypothesesAudience;
}

/**
 * Synchronously generates lead-source hypotheses for a project brief.
 * Returns raw markdown produced by the model (no schema-parsing — we rely on
 * the system prompt to enforce structure and trust UI to render markdown text).
 */
export async function generateLeadSourceHypotheses(
  options: GenerateLeadSourceHypothesesOptions,
): Promise<string> {
  const {
    apiKey,
    briefText,
    model = DEFAULT_HYPOTHESES_MODEL,
    catalogLimit = DEFAULT_CATALOG_LIMIT,
    signal,
    fetchImpl,
    maxRetries = 2,
    audience = 'internal',
  } = options;

  if (!apiKey) throw new Error('OPENROUTER_BRIEF_API_KEY is not configured');
  if (!briefText || typeof briefText !== 'string') {
    throw new Error('Missing required field: briefText');
  }

  const catalog = selectRelevantCatalog(briefText, EXPORT_BASE_CATALOG, catalogLimit);
  const { system, user } = buildHypothesesPrompt({ briefText, catalog, audience });

  const content = await callOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    // Bumped from 2400 (May 2026): on briefs with structured ICP (ОКВЭД,
    // regions, revenue bands) the model spent budget on the first 1–2
    // hypotheses and got cut off, leaving the user with only one block.
    // 4500 covers 7–8 hypotheses × 5 fields comfortably even with verbose RU.
    maxTokens: 4500,
    signal,
    fetchImpl,
    maxRetries,
    title: 'Portal - Project Brief Hypotheses',
  });

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('AI вернул пустой ответ');
  }
  return audience === 'client' ? sanitizeClientHypothesesMarkdown(trimmed) : trimmed;
}
