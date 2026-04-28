import {
  applyClientGuard,
  ALWAYS_ON_STEPS_FOR_CLIENT,
  CLIENT_ROW_LIMIT,
} from '@/lib/tools/baseConstructorClientGuard';
import type { StepKey } from '@/lib/tools/processingSteps';

describe('applyClientGuard', () => {
  describe('for client role', () => {
    it('augments selected_steps with all always-on steps when none provided', () => {
      const result = applyClientGuard({
        role: 'client',
        selectedSteps: [],
        rowCount: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const step of ALWAYS_ON_STEPS_FOR_CLIENT) {
        expect(result.selectedSteps).toContain(step);
      }
    });

    it('preserves optional steps and adds missing always-on ones', () => {
      const result = applyClientGuard({
        role: 'client',
        selectedSteps: ['ta_scoring', 'personalization'],
        rowCount: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedSteps).toContain('ta_scoring');
      expect(result.selectedSteps).toContain('personalization');
      for (const step of ALWAYS_ON_STEPS_FOR_CLIENT) {
        expect(result.selectedSteps).toContain(step);
      }
    });

    it('does not duplicate steps already present', () => {
      const dup: StepKey = 'clean_names';
      const result = applyClientGuard({
        role: 'client',
        selectedSteps: [dup, 'ta_scoring'],
        rowCount: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const occurrences = result.selectedSteps.filter((s) => s === dup).length;
      expect(occurrences).toBe(1);
    });

    it('rejects when row count exceeds 10 000', () => {
      const result = applyClientGuard({
        role: 'client',
        selectedSteps: [],
        rowCount: CLIENT_ROW_LIMIT + 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/10\s?000/);
    });

    it('allows row count exactly equal to limit', () => {
      const result = applyClientGuard({
        role: 'client',
        selectedSteps: [],
        rowCount: CLIENT_ROW_LIMIT,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('for non-client roles', () => {
    it('does not augment selected_steps for admin', () => {
      const result = applyClientGuard({
        role: 'admin',
        selectedSteps: ['ta_scoring'],
        rowCount: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedSteps).toEqual(['ta_scoring']);
    });

    it('does not enforce row limit for admin', () => {
      const result = applyClientGuard({
        role: 'admin',
        selectedSteps: ['remove_empty'],
        rowCount: 100_000,
      });
      expect(result.ok).toBe(true);
    });

    it('does not augment selected_steps for manager', () => {
      const result = applyClientGuard({
        role: 'manager',
        selectedSteps: ['clean_names'],
        rowCount: 50_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedSteps).toEqual(['clean_names']);
    });

    it('does not augment when role is null (treated as internal)', () => {
      const result = applyClientGuard({
        role: null,
        selectedSteps: ['remove_empty'],
        rowCount: 100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedSteps).toEqual(['remove_empty']);
    });
  });

  describe('ALWAYS_ON_STEPS_FOR_CLIENT', () => {
    it('contains exactly the 9 always-on steps from the spec', () => {
      const expected: StepKey[] = [
        'remove_empty',
        'dedup_full',
        'split_emails',
        'dedup_email',
        'clean_names',
        'check_sites',
        'find_emails',
        'validate_emails',
        'enrich_descriptions',
      ];
      expect([...ALWAYS_ON_STEPS_FOR_CLIENT].sort()).toEqual(expected.sort());
    });

    it('does not contain ta_scoring or personalization (those are optional)', () => {
      expect(ALWAYS_ON_STEPS_FOR_CLIENT).not.toContain('ta_scoring');
      expect(ALWAYS_ON_STEPS_FOR_CLIENT).not.toContain('personalization');
    });
  });
});
