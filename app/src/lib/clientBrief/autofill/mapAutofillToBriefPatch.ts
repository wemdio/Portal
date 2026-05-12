/**
 * Safety boundary: AI-produced JSON → safe brief patch.
 *
 * The AI is treated as untrusted: we whitelist fields, drop empties, normalize
 * text, and discard anything outside the autofillable set. Never throws.
 */

import { SOCIAL_PROOF_KEYS } from '../constants';
import type {
  ClientBriefFields,
  ClientBriefSocialProof,
  ClientBriefSocialProofKey,
} from '../types';

/**
 * Fields the AI is allowed to fill from a public website.
 * Everything else (deal_cycle, avg_check, price_tier, persona_*, lead_recipient_*,
 * lead_magnets, guarantees, special_offer, client_problems, common_questions)
 * stays in the user's hands.
 */
const ALLOWED_TEXT_FIELDS = [
  'company_website',
  'company_description',
  'company_contacts',
  'product_description',
  'advantages',
  'usp',
  'impressive_numbers',
  'existing_clients',
  'impressive_results',
  'target_audience',
  'additional_notes',
] as const satisfies readonly (keyof ClientBriefFields)[];

export type AllowedAutofillField = (typeof ALLOWED_TEXT_FIELDS)[number] | 'social_proof';

export interface AutofillMappedResult {
  patch: Partial<ClientBriefFields>;
  questions: string[];
  sources: Partial<Record<keyof ClientBriefFields, string>>;
}

const EMPTY_RESULT: AutofillMappedResult = { patch: {}, questions: [], sources: {} };

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
}

function tryParseJson(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Direct parse first.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to fenced/embedded-JSON recovery.
  }

  // Strip ```json ... ``` fences if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  // Last resort: find the first {...} blob and try to parse it.
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // give up
    }
  }
  return null;
}

function mapSocialProof(raw: unknown): Partial<ClientBriefFields['social_proof']> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Partial<ClientBriefFields['social_proof']> = {};
  for (const key of SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]) {
    const entry = obj[key];
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<ClientBriefSocialProof>;
    const has = item.has === true;
    if (!has) continue;
    const comment = normalizeText(item.comment);
    out[key] = { has: true, comment };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapSources(raw: unknown): Partial<Record<keyof ClientBriefFields, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const allowed = new Set<string>([...ALLOWED_TEXT_FIELDS, 'social_proof']);
  const out: Partial<Record<keyof ClientBriefFields, string>> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!allowed.has(key)) continue;
    const text = normalizeText(value);
    if (!text) continue;
    (out as Record<string, string>)[key] = text;
  }
  return out;
}

function mapQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

export function mapAutofillToBriefPatch(input: unknown): AutofillMappedResult {
  const parsed = tryParseJson(input);
  if (!parsed) return { patch: {}, questions: [], sources: {} };

  const patch: Partial<ClientBriefFields> = {};

  for (const field of ALLOWED_TEXT_FIELDS) {
    const text = normalizeText(parsed[field]);
    if (text) {
      (patch[field] as string) = text;
    }
  }

  const socialProof = mapSocialProof(parsed.social_proof);
  if (socialProof) {
    patch.social_proof = socialProof as ClientBriefFields['social_proof'];
  }

  const questions = mapQuestions(parsed.questions);
  const sources = mapSources(parsed.sources);

  return { patch, questions, sources };
}

void EMPTY_RESULT;
