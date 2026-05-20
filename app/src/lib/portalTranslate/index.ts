import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { callOpenRouterChat } from '@/lib/openrouter/client';
import { TRANSLATABLE_TARGET_LOCALES, type TargetLocale } from '@/lib/i18n';

/**
 * Portal translation service.
 *
 * Powers the on-the-fly UI translator. When the client switches locale, the
 * GlobalTextTranslator collects every visible Russian string and asks
 * /api/portal/translate for a batch translation. This module is what that
 * route delegates to.
 *
 * Pipeline (translateBatch):
 *   1. Look up every requested source string in `portal_translations` for
 *      the target language → instant hits (no API spend, no latency).
 *   2. Any string that's missing OR is older 'machine' output we don't
 *      trust is sent to OpenRouter in a single chat call with a tight UI
 *      system prompt (concise, no quotes added, keep punctuation/HTML).
 *   3. Persist machine output back to the cache (source='machine'). Rows
 *      with source='human' are NEVER overwritten — those are blessed
 *      translations (e.g. seeded from globalTranslations.ts).
 *
 * Cost shape: the first user to visit a screen in a given locale pays the
 * LLM round-trip. Every subsequent user across the whole org reads from
 * the cache. For a portal with ~1500 unique UI strings × 5 target langs,
 * the warm-state cost is ~zero.
 */

const MODEL = process.env.PORTAL_TRANSLATE_MODEL ?? 'openai/gpt-4o-mini';
const OPENROUTER_API_KEY =
  process.env.PORTAL_TRANSLATE_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  '';

const MAX_STRINGS_PER_BATCH = 256;
const MAX_STRING_LENGTH = 1000;

const TARGET_LANG_NAMES: Record<TargetLocale, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
};

export interface TranslateBatchOptions {
  /** Source strings to translate. Order is irrelevant; duplicates are deduped. */
  strings: readonly string[];
  /** Target language. Must be a non-source locale (en/de/fr/es/it). */
  targetLang: TargetLocale;
}

export interface TranslateBatchResult {
  /** Map source → translated. Skipped strings are mapped to themselves. */
  translations: Record<string, string>;
  /** Diagnostics for logging / UI debug. */
  stats: {
    requested: number;
    cached: number;
    machine: number;
    skipped: number;
  };
}

/**
 * Strings the translator should never touch (URLs, pure numbers, brand
 * tokens, whitespace, single punctuation chars). Returning the source
 * verbatim for these saves LLM calls and avoids the LLM "improving"
 * brand names.
 */
function shouldSkip(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return true;
  if (trimmed.length === 1 && !/[\p{L}]/u.test(trimmed)) return true;
  if (/^[0-9\s.,:/_\-+%]+$/.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(trimmed)) return true;
  // Pure ASCII / Latin-only with no Cyrillic is presumed already-translated
  // (brand tokens, English code labels). Cheap heuristic that holds for
  // a portal whose source language is Russian.
  if (!/[Ѐ-ӿ]/.test(trimmed)) return true;
  return false;
}

function dedupe(strings: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    if (s.length > MAX_STRING_LENGTH) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_STRINGS_PER_BATCH) break;
  }
  return out;
}

interface CacheRow {
  source_text: string;
  translated_text: string;
}

async function readCache(
  unique: string[],
  targetLang: TargetLocale,
): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  if (!supabaseAdmin || unique.length === 0) return hits;
  const { data, error } = await supabaseAdmin
    .from('portal_translations')
    .select('source_text, translated_text')
    .eq('target_lang', targetLang)
    .in('source_text', unique);
  if (error) {
    console.warn('[portalTranslate] cache read failed:', error.message);
    return hits;
  }
  for (const row of (data ?? []) as CacheRow[]) {
    hits.set(row.source_text, row.translated_text);
  }
  return hits;
}

async function writeCache(
  entries: Array<{ source_text: string; translated_text: string }>,
  targetLang: TargetLocale,
): Promise<void> {
  if (!supabaseAdmin || entries.length === 0) return;
  // onConflict on (source_text, target_lang). We deliberately do NOT touch
  // rows where source='human' — that's enforced via the WHERE clause inside
  // an upsert wrapper: insert with ON CONFLICT DO UPDATE WHERE source = 'machine'.
  // Supabase-js doesn't support conditional onConflict directly, so we issue
  // a regular upsert that includes source='machine' in the payload. The PK
  // collision will only happen on rows we already wrote, which are themselves
  // machine — so this is safe. Human-seeded rows were inserted with source
  // 'human' and our payload's source='machine' will overwrite that column
  // unless we guard. Use the RPC-free guard: pre-fetch human rows in this
  // batch and exclude them from the upsert.
  const { data: existing, error: readErr } = await supabaseAdmin
    .from('portal_translations')
    .select('source_text, source')
    .eq('target_lang', targetLang)
    .in('source_text', entries.map((e) => e.source_text));
  if (readErr) {
    console.warn('[portalTranslate] guard read failed:', readErr.message);
    return;
  }
  const blessed = new Set(
    (existing ?? [])
      .filter((r: { source: string }) => r.source === 'human')
      .map((r: { source_text: string }) => r.source_text),
  );
  const writeable = entries.filter((e) => !blessed.has(e.source_text));
  if (writeable.length === 0) return;
  const rows = writeable.map((e) => ({
    source_text: e.source_text,
    target_lang: targetLang,
    translated_text: e.translated_text,
    source_lang: 'ru',
    source: 'machine',
    model: MODEL,
    updated_at: new Date().toISOString(),
  }));
  const { error: writeErr } = await supabaseAdmin
    .from('portal_translations')
    .upsert(rows, { onConflict: 'source_text,target_lang' });
  if (writeErr) {
    console.warn('[portalTranslate] cache write failed:', writeErr.message);
  }
}

function buildSystemPrompt(targetLang: TargetLocale): string {
  const langName = TARGET_LANG_NAMES[targetLang];
  return [
    `You are translating UI text from Russian to ${langName} for a B2B SaaS portal.`,
    'Constraints:',
    `- Output ONLY a JSON object mapping each numeric key to its ${langName} translation.`,
    '- Translate every input. Do not skip or merge entries.',
    '- Preserve punctuation, ellipses, line breaks, emoji and HTML/markdown tags exactly.',
    '- Keep placeholders like {name}, %s, {{count}}, $1 intact.',
    `- Use concise UI terminology (button/menu/label tone), not literary ${langName}.`,
    '- Do NOT add quotes around translations. Do NOT explain. Do NOT add notes.',
    '- Brand/product names ("Portal", "LinkedIn", "Instantly", "Unipile", "OpenAI", "GPT", "Supabase") stay in English regardless of target language.',
    `- Technical terms ("API", "JSON", "URL", "ID", "SMTP", "MX", "DNS") stay in English.`,
    '- "База" in this product means a contact database/lead list — translate accordingly (e.g. "Database" / "Datenbank" / "Base de données"), not "Base".',
    '- "Бриф" means a project brief — translate as "Brief" / "Briefing" depending on language.',
    '- "Кампания" → "Campaign" / "Kampagne" etc.',
    '- "Цепочка писем" → "Email sequence" / "E-Mail-Sequenz" etc.',
  ].join('\n');
}

function buildUserPrompt(strings: string[]): string {
  const payload: Record<string, string> = {};
  for (let i = 0; i < strings.length; i += 1) {
    payload[String(i)] = strings[i]!;
  }
  return JSON.stringify(payload);
}

/**
 * Parse the LLM JSON response back into a Map keyed by the original source
 * string. Resilient to surrounding prose (we set response_format=json_object
 * but some models still wrap output).
 */
function parseResponse(content: string, sources: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!content) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Last-resort: pluck the first JSON object substring.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return out;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return out;
    }
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const obj = parsed as Record<string, unknown>;
  for (let i = 0; i < sources.length; i += 1) {
    const v = obj[String(i)];
    if (typeof v === 'string' && v.trim()) {
      out.set(sources[i]!, v);
    }
  }
  return out;
}

async function translateViaLlm(
  strings: string[],
  targetLang: TargetLocale,
): Promise<Map<string, string>> {
  if (strings.length === 0) return new Map();
  if (!OPENROUTER_API_KEY) {
    console.warn('[portalTranslate] no OpenRouter key set — returning sources unchanged');
    return new Map(strings.map((s) => [s, s]));
  }
  const content = await callOpenRouterChat({
    apiKey: OPENROUTER_API_KEY,
    model: MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt(targetLang) },
      { role: 'user', content: buildUserPrompt(strings) },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
    maxRetries: 2,
    title: 'Portal i18n',
  });
  return parseResponse(content, strings);
}

export async function translateBatch(
  options: TranslateBatchOptions,
): Promise<TranslateBatchResult> {
  const { strings, targetLang } = options;
  if (!(TRANSLATABLE_TARGET_LOCALES as readonly string[]).includes(targetLang)) {
    throw new Error(`Unsupported target language: ${targetLang}`);
  }

  const unique = dedupe(strings);
  const skipped: string[] = [];
  const candidates: string[] = [];
  for (const s of unique) {
    if (shouldSkip(s)) skipped.push(s);
    else candidates.push(s);
  }

  const cached = await readCache(candidates, targetLang);
  const misses = candidates.filter((s) => !cached.has(s));

  let machineTranslations = new Map<string, string>();
  if (misses.length > 0) {
    try {
      machineTranslations = await translateViaLlm(misses, targetLang);
    } catch (err) {
      console.warn('[portalTranslate] LLM call failed:', err);
    }
    const writePayload = misses
      .filter((s) => machineTranslations.has(s))
      .map((s) => ({ source_text: s, translated_text: machineTranslations.get(s)! }));
    if (writePayload.length > 0) {
      await writeCache(writePayload, targetLang);
    }
  }

  const translations: Record<string, string> = {};
  // Skipped strings → identity.
  for (const s of skipped) translations[s] = s;
  // Cache hits.
  for (const [src, tgt] of cached) translations[src] = tgt;
  // Fresh machine output.
  for (const [src, tgt] of machineTranslations) translations[src] = tgt;
  // Any string the LLM failed to translate gets identity so the UI doesn't
  // disappear or render undefined.
  for (const s of misses) {
    if (!(s in translations)) translations[s] = s;
  }

  return {
    translations,
    stats: {
      requested: unique.length,
      cached: cached.size,
      machine: machineTranslations.size,
      skipped: skipped.length,
    },
  };
}
