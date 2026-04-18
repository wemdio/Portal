import { callOpenRouterChat } from '@/lib/openrouter/client';
import { EXPORT_BASE_CATALOG } from './exportBaseCatalog';
import { buildHypothesesPrompt, selectRelevantCatalog } from './sources';

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
  } = options;

  if (!apiKey) throw new Error('OPENROUTER_BRIEF_API_KEY is not configured');
  if (!briefText || typeof briefText !== 'string') {
    throw new Error('Missing required field: briefText');
  }

  const catalog = selectRelevantCatalog(briefText, EXPORT_BASE_CATALOG, catalogLimit);
  const { system, user } = buildHypothesesPrompt({ briefText, catalog });

  const content = await callOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: 2400,
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
