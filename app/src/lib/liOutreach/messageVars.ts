/**
 * Merge-tag vocabulary for LinkedIn campaign texts (invite / welcome / steps).
 *
 * Why this lives in its own module and not inside aiService: the same table is
 * needed by the campaign API (to reject unknown tags at save time) and by the
 * runner (to warn when a tag was blanked), and aiService pulls in `server-only`
 * plus the whole LLM path.
 *
 * Background — prod 2026-08-17. Operators write LinkedIn campaigns from the
 * same internal manual as Instantly ones (/reglament), and that manual teaches
 * camelCase tags: {{firstName}}, {{companyName}}. This module used to match
 * only three literal spellings per key (`first_name`, `FIRST_NAME`,
 * `First_name`), so `{{firstName}}` matched nothing and was then wiped by the
 * "clean remaining {{...}}" pass. Result: 145 of 160 invites in one week went
 * out as «Здравствуйте, Обратил внимание на Kommo» — no name at all — while
 * the health digest stayed green, because its invariant looks for *leftover*
 * braces and there were none. Lookup is now normalised (case- and
 * separator-insensitive), so both spellings resolve to the same value.
 */

export interface TemplateLeadInfo {
  name?: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  position?: string | null;
}

/** Canonical tag names, in the order shown to the operator on a validation error. */
export const SUPPORTED_TEMPLATE_VARS = [
  'name',
  'first_name',
  'last_name',
  'full_name',
  'company',
  'position',
] as const;

export type TemplateVar = (typeof SUPPORTED_TEMPLATE_VARS)[number];

/**
 * Extra spellings that don't survive normalisation on their own.
 *
 * `firstName`/`lastName`/`fullName` need no entry — stripping separators makes
 * them identical to their snake_case twins. `companyName` does, because the
 * canonical key is `company`.
 *
 * Instantly's `website` and `phone` are deliberately NOT aliased: a LinkedIn
 * lead has no such field, so they must surface as unknown tags rather than
 * quietly render as an empty string.
 */
const VAR_ALIASES: Record<string, TemplateVar> = {
  companyname: 'company',
};

/** Lowercase and drop separators: `First Name` / `first_name` / `firstName` → `firstname`. */
export function normalizeVarKey(raw: string): string {
  return raw.replace(/[\s_-]/g, '').toLowerCase();
}

/** Canonical values for one lead. Missing pieces fall back to splitting `name`. */
export function buildTemplateVarValues(lead: TemplateLeadInfo): Record<TemplateVar, string> {
  const parts = lead.name ? lead.name.split(/\s+/) : [];
  const firstName = lead.first_name || parts[0] || '';
  const lastName = lead.last_name || (parts.length > 1 ? parts[parts.length - 1] : '') || '';

  return {
    name: firstName,
    first_name: firstName,
    last_name: lastName,
    full_name: lead.name ?? '',
    company: lead.company ?? '',
    position: lead.position ?? '',
  };
}

/** Canonical key behind a raw tag body (`firstName`, `FIRST_NAME`, …), or undefined if unknown. */
export function canonicalVar(rawKey: string): TemplateVar | undefined {
  const key = normalizeVarKey(rawKey);
  const direct = (SUPPORTED_TEMPLATE_VARS as readonly string[]).find(
    (v) => normalizeVarKey(v) === key,
  ) as TemplateVar | undefined;
  return direct ?? VAR_ALIASES[key];
}

/** Resolve one raw tag body to its value for this lead, or undefined if the tag is unknown. */
export function resolveTemplateVar(
  values: Record<TemplateVar, string>,
  rawKey: string,
): string | undefined {
  const canonical = canonicalVar(rawKey);
  return canonical ? values[canonical] : undefined;
}

/**
 * Distinct `{{...}}` tags in `template` that no lead field can fill.
 *
 * Only double braces are inspected: those are what the manual teaches and what
 * the renderer blanks out. Unknown single-brace tokens are left verbatim by
 * `parseMessageTemplate`, so they can't silently swallow a word.
 */
export function findUnknownPlaceholders(template: string | null | undefined): string[] {
  if (!template) return [];
  const unknown = new Set<string>();
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    if (!canonicalVar(raw)) unknown.add(raw);
  }
  return [...unknown];
}

/** Human-readable hint listing what the operator may use. RU — it goes straight into the UI. */
export function supportedVarsHint(): string {
  const canonical = SUPPORTED_TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ');
  return `${canonical} (camelCase тоже работает: {{firstName}}, {{lastName}}, {{companyName}})`;
}
