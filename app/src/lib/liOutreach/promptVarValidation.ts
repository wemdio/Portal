import type { V2PromptKey } from '@/lib/liOutreach/v2DefaultPrompts';

/**
 * Jinja2 variable validation for OpenOutreach prompt overrides.
 *
 * When operators edit the per-user prompts in Settings, they can accidentally
 * delete a `{{ variable }}` that the worker actually substitutes at runtime
 * (e.g. removing `{{ self_name }}` from follow_up_agent). The worker would
 * then render a broken prompt — at best the LLM fills the gap with its own
 * default; at worst it leaks the bare template back into a message.
 *
 * To stop that at save-time we keep an explicit allowlist of the variables
 * each prompt MUST contain. The list is intentionally narrower than "every
 * {{ x }} that appears in the upstream default" — we exclude:
 *
 *  - Loop locals: {% for kw in exclude_keywords %} introduces `kw`, which is
 *    not a "variable from outside" the user can be required to keep.
 *  - Optional blocks: `days_since_last_outgoing` / `unanswered_outgoing` live
 *    inside an `{% if days_since_last_outgoing is not none %}` block in
 *    follow_up_agent, and `exclude_keywords` lives inside an `{% if %}` in
 *    search_keywords. Removing the whole optional block is a legitimate
 *    customisation, so we don't require the inner vars either.
 *
 * Anything else from the default IS required. Bump this list manually when
 * adding new mandatory placeholders to v2DefaultPrompts.ts.
 */
export const REQUIRED_VARS_BY_PROMPT: Record<V2PromptKey, readonly string[]> = {
  // Must match the variables the daemon supplies to follow_up_agent
  // (handlers.handle_follow_up). The daemon renders missing vars to empty, but
  // requiring these stops an operator from silently deleting a substitution
  // point the message depends on.
  follow_up_agent: [
    'product_docs',
    'campaign_objective',
    'target_market',
    'lead_name',
    'lead_position',
    'lead_company',
    'recent_messages',
  ],
  qualify_lead: ['product_docs', 'campaign_objective', 'profile_text'],
  search_keywords: ['product_docs', 'campaign_objective', 'n_keywords'],
};

/** Human-readable prompt labels matching the Settings UI section titles. */
export const PROMPT_LABELS: Record<V2PromptKey, string> = {
  follow_up_agent: 'Follow-up agent (диалог)',
  qualify_lead: 'Qualify lead (квалификация)',
  search_keywords: 'Search keywords (поиск)',
};

/**
 * Extract the set of Jinja2 top-level variable names that appear in {{ ... }}
 * expressions inside the template. Filter attributes (foo.bar → foo), method
 * calls (foo() → foo), and inline filter pipes (foo|trim → foo) are dropped
 * to their root identifier — that's the name the user can search for.
 *
 * Does NOT parse `{% ... %}` blocks: those are conditionals / loops, not
 * substitution points. A prompt may reference a variable only inside an `if`
 * (e.g. as the condition) and never substitute it — for our purposes that
 * variable isn't "missing" if `{{ }}` was the form we cared about.
 */
export function extractPromptVars(template: string): Set<string> {
  const vars = new Set<string>();
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) vars.add(m[1]);
  return vars;
}

export interface PromptVarCheck {
  promptKey: V2PromptKey;
  missing: string[];
}

/** Returns the missing required vars for a single prompt, or [] if all present. */
export function findMissingVars(promptKey: V2PromptKey, template: string): string[] {
  const present = extractPromptVars(template);
  return REQUIRED_VARS_BY_PROMPT[promptKey].filter((name) => !present.has(name));
}

/**
 * Build the russian human-facing error string returned to the API client when
 * one or more saved prompts have missing required variables.
 *
 * Example shape (two prompts, three vars):
 *   В промпте «Follow-up agent (диалог)» не хватает переменных: {{ self_name }},
 *   {{ today }}. В промпте «Qualify lead (квалификация)» не хватает: {{ profile_text }}.
 *   Добавьте их в текст промпта и попробуйте снова.
 */
export function buildMissingVarsMessage(checks: PromptVarCheck[]): string {
  const offenders = checks.filter((c) => c.missing.length > 0);
  if (offenders.length === 0) return '';

  const fragments = offenders.map((c, i) => {
    const label = PROMPT_LABELS[c.promptKey];
    const vars = c.missing.map((name) => `{{ ${name} }}`).join(', ');
    // First fragment includes "не хватает переменных"; subsequent ones use
    // the shorter "не хватает" to avoid repetition.
    return i === 0
      ? `В промпте «${label}» не хватает переменных: ${vars}.`
      : `В промпте «${label}» не хватает: ${vars}.`;
  });

  return `${fragments.join(' ')} Добавьте их в текст промпта и попробуйте снова.`;
}

/**
 * Run validation on the three prompt fields. Empty / whitespace-only strings
 * skip validation entirely — they mean "use the upstream default" downstream
 * (see start-job route fallback). Returns a list of per-prompt findings;
 * empty list = nothing to flag.
 */
export function validatePromptOverrides(input: {
  prompt_follow_up_agent?: unknown;
  prompt_qualify_lead?: unknown;
  prompt_search_keywords?: unknown;
}): PromptVarCheck[] {
  const checks: PromptVarCheck[] = [];

  const map: Array<[V2PromptKey, unknown]> = [
    ['follow_up_agent', input.prompt_follow_up_agent],
    ['qualify_lead',    input.prompt_qualify_lead],
    ['search_keywords', input.prompt_search_keywords],
  ];

  for (const [key, raw] of map) {
    if (typeof raw !== 'string') continue;
    if (raw.trim() === '') continue; // empty = fall back to default, nothing to check
    const missing = findMissingVars(key, raw);
    if (missing.length > 0) checks.push({ promptKey: key, missing });
  }

  return checks;
}
