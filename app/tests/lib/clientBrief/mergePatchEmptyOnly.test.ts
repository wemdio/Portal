/**
 * Tests for mergePatchEmptyOnly — the merge rule that defines what
 * "autofill" does to fields the user already filled in.
 *
 * Rule: never silently overwrite. A field already containing a non-empty
 * user value stays untouched. Empty/whitespace-only user values are treated
 * as empty and may be replaced.
 *
 * social_proof rule: per-entry. If the user already marked has=true with a
 * comment, leave it. If has=false (default), the autofill suggestion can
 * fill it.
 */

import { EMPTY_BRIEF_FIELDS } from '@/lib/clientBrief';
import type { ClientBriefFields } from '@/lib/clientBrief';
import { mergePatchEmptyOnly } from '@/lib/clientBrief/autofill/mergePatchEmptyOnly';

describe('mergePatchEmptyOnly', () => {
  it('fills empty fields from the patch', () => {
    const current: ClientBriefFields = { ...EMPTY_BRIEF_FIELDS };
    const patch: Partial<ClientBriefFields> = {
      company_website: 'acme.com',
      company_description: 'We sell widgets.',
    };
    const merged = mergePatchEmptyOnly(current, patch);
    expect(merged.company_website).toBe('acme.com');
    expect(merged.company_description).toBe('We sell widgets.');
  });

  it('does not overwrite fields that already have user content', () => {
    const current: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      company_description: 'My own words about the company.',
    };
    const patch: Partial<ClientBriefFields> = {
      company_description: 'AI version that would clobber the user',
      company_website: 'acme.com',
    };
    const merged = mergePatchEmptyOnly(current, patch);
    expect(merged.company_description).toBe('My own words about the company.');
    expect(merged.company_website).toBe('acme.com');
  });

  it('treats whitespace-only existing values as empty (replaceable)', () => {
    const current: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      company_description: '   \n  ',
    };
    const patch: Partial<ClientBriefFields> = {
      company_description: 'Filled in by AI',
    };
    const merged = mergePatchEmptyOnly(current, patch);
    expect(merged.company_description).toBe('Filled in by AI');
  });

  it('ignores empty values in the patch (does not erase existing data)', () => {
    const current: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      company_description: 'Kept by user',
    };
    const patch: Partial<ClientBriefFields> = {
      company_description: '   ',
      company_website: '',
    };
    const merged = mergePatchEmptyOnly(current, patch);
    expect(merged.company_description).toBe('Kept by user');
    expect(merged.company_website).toBe('');
  });

  it('does NOT touch disallowed/sensitive fields even if patch contains them', () => {
    // mergePatchEmptyOnly relies on the mapper to drop disallowed fields,
    // but it also guards itself: it only writes keys present in the patch.
    const current: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      deal_cycle: '6-10 мес',
    };
    const patch: Partial<ClientBriefFields> = {
      company_website: 'acme.com',
    };
    const merged = mergePatchEmptyOnly(current, patch);
    expect(merged.deal_cycle).toBe('6-10 мес');
    expect(merged.company_website).toBe('acme.com');
  });

  it('merges social_proof per-entry: keeps existing has=true entries', () => {
    const current: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      social_proof: {
        ...EMPTY_BRIEF_FIELDS.social_proof,
        ratings: { has: true, comment: 'My own award note' },
      },
    };
    const patch: Partial<ClientBriefFields> = {
      social_proof: {
        ...EMPTY_BRIEF_FIELDS.social_proof,
        ratings: { has: true, comment: 'AI suggested different comment' },
        cases: { has: true, comment: 'AI: visible case studies on site' },
      },
    };
    const merged = mergePatchEmptyOnly(current, patch);
    // User's existing ratings comment stays.
    expect(merged.social_proof.ratings).toEqual({ has: true, comment: 'My own award note' });
    // AI fills in cases that user hadn't claimed.
    expect(merged.social_proof.cases).toEqual({ has: true, comment: 'AI: visible case studies on site' });
  });

  it('does not toggle social_proof.has from true to false', () => {
    const current: ClientBriefFields = {
      ...EMPTY_BRIEF_FIELDS,
      social_proof: {
        ...EMPTY_BRIEF_FIELDS.social_proof,
        ratings: { has: true, comment: 'kept' },
      },
    };
    const patch: Partial<ClientBriefFields> = {
      social_proof: {
        ...EMPTY_BRIEF_FIELDS.social_proof,
        // Even if the patch shows has=false here, do not override.
        ratings: { has: false, comment: '' },
      },
    };
    const merged = mergePatchEmptyOnly(current, patch);
    expect(merged.social_proof.ratings.has).toBe(true);
    expect(merged.social_proof.ratings.comment).toBe('kept');
  });

  it('is pure: does not mutate inputs', () => {
    const current: ClientBriefFields = { ...EMPTY_BRIEF_FIELDS, company_website: '' };
    const patch: Partial<ClientBriefFields> = { company_website: 'acme.com' };
    const beforeCurrent = JSON.stringify(current);
    const beforePatch = JSON.stringify(patch);
    mergePatchEmptyOnly(current, patch);
    expect(JSON.stringify(current)).toBe(beforeCurrent);
    expect(JSON.stringify(patch)).toBe(beforePatch);
  });
});
