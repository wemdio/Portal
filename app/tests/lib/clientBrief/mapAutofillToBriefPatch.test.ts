/**
 * Tests for mapAutofillToBriefPatch — the safety boundary between the AI's
 * raw JSON output and our brief schema.
 *
 * Why this is the heart of the feature:
 *   The AI does NOT decide which fields are autofillable. We do. This mapper
 *   is the single chokepoint that drops disallowed fields, normalizes text,
 *   and keeps low-confidence guesses out of the user's saved brief.
 *
 * Contract:
 *   mapAutofillToBriefPatch(rawJson: string | object) -> {
 *     patch: Partial<ClientBriefFields>;
 *     questions: string[];
 *     sources: Partial<Record<keyof ClientBriefFields, string>>;
 *   }
 *
 *   - Allowed fields:
 *       company_website, company_description, company_contacts,
 *       product_description, advantages, usp,
 *       impressive_numbers, existing_clients, impressive_results,
 *       target_audience, additional_notes, social_proof
 *   - Disallowed (silently dropped): deal_cycle, avg_check, price_tier,
 *       client_problems, common_questions, persona_*, lead_recipient_*,
 *       lead_magnets, guarantees, special_offer.
 *   - Empty strings are dropped from the patch (never overwrite with '').
 *   - social_proof entries with has=false are dropped; comment is trimmed.
 *   - The patch flowed through normalizeBriefFields semantics: \r\n -> \n,
 *     trimmed edges. Never throws on malformed input.
 */

import { mapAutofillToBriefPatch } from '@/lib/clientBrief/autofill/mapAutofillToBriefPatch';
import type { ClientBriefFields } from '@/lib/clientBrief';

describe('mapAutofillToBriefPatch — allowed fields', () => {
  it('keeps every allowed text field', () => {
    const raw = {
      company_website: 'acme.com',
      company_description: 'We build widgets.',
      company_contacts: 'hello@acme.com',
      product_description: 'Widgets in 5 colors.',
      advantages: 'Fast shipping\nSmall MOQ',
      usp: 'Only US-made widgets',
      impressive_numbers: '10 years on market',
      existing_clients: 'Acme A, Acme B',
      impressive_results: 'Doubled output for Acme A',
      target_audience: 'Plumbers and contractors',
      additional_notes: 'Site mentions a B2B portal in beta',
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.company_website).toBe('acme.com');
    expect(patch.company_description).toBe('We build widgets.');
    expect(patch.company_contacts).toBe('hello@acme.com');
    expect(patch.product_description).toBe('Widgets in 5 colors.');
    expect(patch.advantages).toBe('Fast shipping\nSmall MOQ');
    expect(patch.usp).toBe('Only US-made widgets');
    expect(patch.impressive_numbers).toBe('10 years on market');
    expect(patch.existing_clients).toBe('Acme A, Acme B');
    expect(patch.impressive_results).toBe('Doubled output for Acme A');
    expect(patch.target_audience).toBe('Plumbers and contractors');
    expect(patch.additional_notes).toBe('Site mentions a B2B portal in beta');
  });

  it('accepts a JSON string and parses it', () => {
    const raw = JSON.stringify({ company_website: 'acme.com' });
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.company_website).toBe('acme.com');
  });
});

describe('mapAutofillToBriefPatch — disallowed fields are dropped', () => {
  // После расширения whitelist'а в 9290c7a (feat(client-brief/autofill):
  // expand whitelist) реально остаются под запретом только persona_* и
  // lead_recipient_* — это бизнес-решения клиента (от чьего лица ведём
  // диалог / кому передаём лидов), сайт об этом ничего не знает.
  const DISALLOWED_FIELDS: Array<keyof ClientBriefFields> = [
    'persona_name',
    'persona_position',
    'lead_recipient_name',
    'lead_recipient_email',
    'lead_recipient_position',
  ];

  it.each(DISALLOWED_FIELDS)('drops "%s" from the patch even if AI returns it', (field) => {
    const raw: Record<string, unknown> = {
      [field]: 'AI guessed this somehow',
      company_website: 'acme.com',
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect((patch as Record<string, unknown>)[field]).toBeUndefined();
    expect(patch.company_website).toBe('acme.com');
  });

  it('keeps price_tier when value is one of the known enums', () => {
    const raw = { price_tier: 'business', company_website: 'acme.com' };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.price_tier).toBe('business');
  });

  it('drops price_tier when value is outside the enum (AI hallucination)', () => {
    const raw = { price_tier: 'super-cheap', company_website: 'acme.com' };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect((patch as Record<string, unknown>).price_tier).toBeUndefined();
    expect(patch.company_website).toBe('acme.com');
  });

  it('drops totally unknown keys silently', () => {
    const raw = {
      company_website: 'acme.com',
      hallucinated_field: 'should not appear',
      __proto__: { evil: true },
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect((patch as Record<string, unknown>).hallucinated_field).toBeUndefined();
    expect(patch.company_website).toBe('acme.com');
  });
});

describe('mapAutofillToBriefPatch — empty values dropped', () => {
  it('does not include empty string values in the patch (no silent overwrites)', () => {
    const raw = {
      company_website: 'acme.com',
      company_description: '',
      product_description: '   \n  ',
      advantages: '\t',
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.company_website).toBe('acme.com');
    expect((patch as Record<string, unknown>).company_description).toBeUndefined();
    expect((patch as Record<string, unknown>).product_description).toBeUndefined();
    expect((patch as Record<string, unknown>).advantages).toBeUndefined();
  });

  it('coerces non-string values to nothing rather than to string', () => {
    const raw = {
      company_website: 123,
      company_description: null,
      product_description: { weird: 1 },
      advantages: ['array'],
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect((patch as Record<string, unknown>).company_website).toBeUndefined();
    expect((patch as Record<string, unknown>).company_description).toBeUndefined();
    expect((patch as Record<string, unknown>).product_description).toBeUndefined();
    expect((patch as Record<string, unknown>).advantages).toBeUndefined();
  });
});

describe('mapAutofillToBriefPatch — social_proof', () => {
  it('keeps only entries with has=true and trims comments', () => {
    const raw = {
      social_proof: {
        ratings: { has: true, comment: '  TOP-20 Tagline 2025  ' },
        media: { has: false, comment: 'ignored' },
        cases: { has: true, comment: '' },
        nonexistent: { has: true, comment: 'invented key' },
      },
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.social_proof).toBeDefined();
    expect(patch.social_proof?.ratings).toEqual({ has: true, comment: 'TOP-20 Tagline 2025' });
    expect(patch.social_proof?.cases).toEqual({ has: true, comment: '' });
    expect(patch.social_proof?.media?.has).toBeFalsy();
    expect((patch.social_proof as Record<string, unknown>).nonexistent).toBeUndefined();
  });

  it('omits social_proof entirely when no entries are truthy', () => {
    const raw = {
      social_proof: {
        ratings: { has: false, comment: '' },
        media: { has: false, comment: '' },
      },
      company_website: 'acme.com',
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.social_proof).toBeUndefined();
    expect(patch.company_website).toBe('acme.com');
  });
});

describe('mapAutofillToBriefPatch — text normalization', () => {
  it('normalizes \\r\\n to \\n and trims edges in every string field', () => {
    const raw = {
      company_description: '  Hello world\r\nNext line  \r\n',
      advantages: '\r\nItem 1\r\nItem 2  ',
    };
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.company_description).toBe('Hello world\nNext line');
    expect(patch.advantages).toBe('Item 1\nItem 2');
  });
});

describe('mapAutofillToBriefPatch — questions and sources', () => {
  it('returns "questions" as a string[] (clarifications for the client)', () => {
    const raw = {
      company_website: 'acme.com',
      questions: ['Какой средний чек?', 'Кому слать тёплые лиды?'],
    };
    const { questions } = mapAutofillToBriefPatch(raw);
    expect(questions).toEqual(['Какой средний чек?', 'Кому слать тёплые лиды?']);
  });

  it('filters out non-string and empty questions', () => {
    const raw = {
      questions: ['Real question', '', '   ', 42, null, undefined],
    };
    const { questions } = mapAutofillToBriefPatch(raw);
    expect(questions).toEqual(['Real question']);
  });

  it('returns "sources" mapping fields to text snippets (only for allowed fields)', () => {
    const raw = {
      company_website: 'acme.com',
      // persona_name остаётся вне whitelist'а (бизнес-решение клиента,
      // не выводимо с сайта), поэтому используется как пример «должно
      // отфильтроваться» — deal_cycle с 9290c7a уже валидный.
      persona_name: 'we do not allow this',
      sources: {
        company_website: 'Found in <title>',
        persona_name: 'Should be filtered out',
        nonexistent: 'noise',
      },
    };
    const { sources } = mapAutofillToBriefPatch(raw);
    expect(sources.company_website).toBe('Found in <title>');
    expect((sources as Record<string, unknown>).persona_name).toBeUndefined();
    expect((sources as Record<string, unknown>).nonexistent).toBeUndefined();
  });
});

describe('mapAutofillToBriefPatch — malformed input', () => {
  it('returns empty result for invalid JSON string without throwing', () => {
    const result = mapAutofillToBriefPatch('not { valid json');
    expect(result.patch).toEqual({});
    expect(result.questions).toEqual([]);
    expect(result.sources).toEqual({});
  });

  it('returns empty result for null / undefined / primitive', () => {
    expect(mapAutofillToBriefPatch(null as unknown as object).patch).toEqual({});
    expect(mapAutofillToBriefPatch(undefined as unknown as object).patch).toEqual({});
    expect(mapAutofillToBriefPatch(42 as unknown as object).patch).toEqual({});
  });

  it('survives JSON wrapped in markdown code fences (common GPT output)', () => {
    const raw = '```json\n{"company_website":"acme.com"}\n```';
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.company_website).toBe('acme.com');
  });

  it('survives extra prose around the JSON', () => {
    const raw = 'Here is the JSON:\n{"company_website":"acme.com"}\nHope it helps!';
    const { patch } = mapAutofillToBriefPatch(raw);
    expect(patch.company_website).toBe('acme.com');
  });
});
