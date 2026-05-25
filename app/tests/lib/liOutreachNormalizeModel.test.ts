/** @jest-environment node */

/**
 * Regression: `aiService.normalizeModel` must coerce model names into the
 * `provider/model` shape that Requesty's router requires.
 *
 * Background: production 2026-05 had bare model names like `gpt-4o-mini`
 * stored in li_settings.openai_model and li_campaigns.ai_model, which
 * the Requesty endpoint rejects with
 *   `400 {"error":{"message":"Invalid model, expected: \"provider/model\""}}`.
 * That 400 made GPT-personalization fall back to the unrendered template
 * (or to a 4o-mini retry hack) — leads received literal `{{first_name}}`.
 *
 * normalizeModel is the single, hot-path guard so a stale value sneaking
 * back into DB doesn't break the entire feature again.
 */

import { normalizeModel } from '@/lib/liOutreach/aiService';

describe('normalizeModel', () => {
  it('prefixes "openai/" when the name has no provider', () => {
    expect(normalizeModel('gpt-4o-mini')).toBe('openai/gpt-4o-mini');
    expect(normalizeModel('gpt-5-mini')).toBe('openai/gpt-5-mini');
    expect(normalizeModel('o3')).toBe('openai/o3');
  });

  it('leaves an already-prefixed name untouched', () => {
    expect(normalizeModel('openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
    expect(normalizeModel('anthropic/claude-3-5-sonnet')).toBe('anthropic/claude-3-5-sonnet');
    expect(normalizeModel('google/gemini-2.0-flash')).toBe('google/gemini-2.0-flash');
  });

  it('falls back to "openai/gpt-4o-mini" for empty / null / undefined / whitespace input', () => {
    expect(normalizeModel('')).toBe('openai/gpt-4o-mini');
    expect(normalizeModel(null)).toBe('openai/gpt-4o-mini');
    expect(normalizeModel(undefined)).toBe('openai/gpt-4o-mini');
    expect(normalizeModel('   ')).toBe('openai/gpt-4o-mini');
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(normalizeModel('  gpt-4o-mini  ')).toBe('openai/gpt-4o-mini');
    expect(normalizeModel('\topenai/gpt-4o-mini\n')).toBe('openai/gpt-4o-mini');
  });
});
