import { callOpenRouterChat } from '@/lib/openrouter/client';
import { EXPORT_BASE_CATALOG } from './exportBaseCatalog';
import { buildHypothesesPrompt, selectRelevantCatalog, type HypothesesAudience } from './sources';

export const DEFAULT_HYPOTHESES_MODEL =
  process.env.PROJECT_HYPOTHESES_MODEL ?? 'policy/gemini-flash';

const DEFAULT_CATALOG_LIMIT = Number(process.env.PROJECT_HYPOTHESES_CATALOG_LIMIT ?? '60');

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
  return trimmed;
}
