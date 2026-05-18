/** Loads the agency profile from the event_outreach_config key/value table. */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { AgencyConfig, HookExample } from './types';

/** Config keys editable via the tool's config endpoint. */
export const AGENCY_CONFIG_KEYS = [
  'agency_name',
  'agency_services',
  'agency_tone',
  'hook_examples',
  'industry_pain_points',
] as const;

const EMPTY_CONFIG: AgencyConfig = {
  agency_name: '',
  agency_services: [],
  agency_tone: '',
  hook_examples: [],
  industry_pain_points: {},
};

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseHookExamples(raw: string | undefined): HookExample[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is HookExample => !!x && typeof x.signal === 'string' && typeof x.hook === 'string')
      .map((x) => ({ signal: x.signal, hook: x.hook }));
  } catch {
    return [];
  }
}

function parseStringRecord(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Reads and parses the agency profile; returns an empty profile if unset. */
export async function loadAgencyConfig(): Promise<AgencyConfig> {
  if (!supabaseAdmin) return { ...EMPTY_CONFIG };

  const { data, error } = await supabaseAdmin
    .from('event_outreach_config')
    .select('key, value');

  if (error || !data) return { ...EMPTY_CONFIG };

  const map = new Map<string, string>(data.map((r) => [r.key as string, r.value as string]));

  return {
    agency_name: map.get('agency_name') ?? '',
    agency_services: parseStringArray(map.get('agency_services')),
    agency_tone: map.get('agency_tone') ?? '',
    hook_examples: parseHookExamples(map.get('hook_examples')),
    industry_pain_points: parseStringRecord(map.get('industry_pain_points')),
  };
}
