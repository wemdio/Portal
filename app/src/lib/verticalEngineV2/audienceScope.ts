import { z } from 'zod';

/** Versioned buyer definition. Alternatives are OR; requirements are AND.
 * Kept browser-safe so the specialist sees exactly what workers receive. */
const item = z.string().trim().min(1).max(240).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid audience condition');
export const VeAudienceScopeSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['sector', 'segment']),
  any_of: z.array(item).min(1).max(12),
  required: z.array(item).max(12),
  excluded: z.array(item).max(12),
}).strict();
export type VeAudienceScope = z.infer<typeof VeAudienceScopeSchema>;

/** Missing scope is legacy. Unknown versions or malformed scopes must not
 * silently fall back to a wider title/description audience. */
export function readVeAudienceScope(value: unknown): VeAudienceScope | null {
  return value === null || value === undefined ? null : VeAudienceScopeSchema.parse(value);
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const ordered = (values: readonly string[]) => [...new Set(values.map(normalize))].sort();

/** Exact normalized meaning only: no fuzzy synonyms or inferred exclusions. */
export function veAudienceScopeKey(scope: VeAudienceScope): string {
  const valid = VeAudienceScopeSchema.parse(scope);
  return JSON.stringify({ version: valid.version, kind: valid.kind, any_of: ordered(valid.any_of),
    required: ordered(valid.required), excluded: ordered(valid.excluded) });
}

export function veAudienceScopeText(scope: VeAudienceScope): string {
  const valid = VeAudienceScopeSchema.parse(scope);
  return [
    `Audience scope v1 (${valid.kind}):`,
    `Target activities — ANY ONE is sufficient (OR): ${JSON.stringify(valid.any_of)}`,
    `Explicit mandatory conditions — ALL required (AND): ${JSON.stringify(valid.required)}`,
    `Excluded activities or company types: ${JSON.stringify(valid.excluded)}`,
    'Do not add restrictions from the title, pitch, pain, examples or parent vertical. Preserve every alternative.',
  ].join('\n');
}

/** Gates the source-policy pilot. Saved scopes remain authoritative after flag removal. */
export function isVeAudienceScopeEnabled(projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  const allowed = (process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS ?? '').split(/[,\s]+/).filter(Boolean);
  return allowed.includes('*') || allowed.includes(projectId);
}

export function isVeAudienceGenerationEnabled(projectId: string | null | undefined): boolean {
  if (!isVeAudienceScopeEnabled(projectId) || !projectId) return false;
  const allowed = (process.env.VE_AUDIENCE_GENERATION_PROJECT_IDS ?? '').split(/[,\s]+/).filter(Boolean);
  return allowed.includes('*') || allowed.includes(projectId);
}
