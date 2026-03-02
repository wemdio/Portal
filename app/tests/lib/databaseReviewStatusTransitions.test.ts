import {
  canTransition,
  getNextStatuses,
  assertTransition,
  ALL_REVIEW_STATUSES,
  type ReviewStatus,
} from '@/lib/databaseReview/statusTransitions';

describe('Database review status transitions', () => {
  describe('ALL_REVIEW_STATUSES', () => {
    it('contains all 6 statuses', () => {
      expect(ALL_REVIEW_STATUSES).toHaveLength(6);
      expect(ALL_REVIEW_STATUSES).toContain('submitted');
      expect(ALL_REVIEW_STATUSES).toContain('needs_rework');
      expect(ALL_REVIEW_STATUSES).toContain('review_approved');
      expect(ALL_REVIEW_STATUSES).toContain('sent_to_client');
      expect(ALL_REVIEW_STATUSES).toContain('client_approved');
      expect(ALL_REVIEW_STATUSES).toContain('client_requested_changes');
    });
  });

  describe('canTransition', () => {
    const allowed: [ReviewStatus, ReviewStatus][] = [
      ['submitted', 'review_approved'],
      ['submitted', 'needs_rework'],
      ['needs_rework', 'submitted'],
      ['review_approved', 'sent_to_client'],
      ['review_approved', 'needs_rework'],
      ['sent_to_client', 'client_approved'],
      ['sent_to_client', 'client_requested_changes'],
      ['client_requested_changes', 'submitted'],
    ];

    it.each(allowed)('%s → %s is allowed', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });

    const forbidden: [ReviewStatus, ReviewStatus][] = [
      ['submitted', 'sent_to_client'],
      ['submitted', 'client_approved'],
      ['needs_rework', 'review_approved'],
      ['needs_rework', 'sent_to_client'],
      ['review_approved', 'client_approved'],
      ['review_approved', 'submitted'],
      ['sent_to_client', 'submitted'],
      ['sent_to_client', 'needs_rework'],
      ['client_approved', 'submitted'],
      ['client_approved', 'needs_rework'],
      ['client_approved', 'sent_to_client'],
      ['client_requested_changes', 'review_approved'],
      ['client_requested_changes', 'client_approved'],
    ];

    it.each(forbidden)('%s → %s is forbidden', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });

    it('client_approved is a terminal state', () => {
      ALL_REVIEW_STATUSES.forEach((to) => {
        expect(canTransition('client_approved', to)).toBe(false);
      });
    });
  });

  describe('getNextStatuses', () => {
    it('submitted can go to review_approved or needs_rework', () => {
      const next = getNextStatuses('submitted');
      expect(next).toContain('review_approved');
      expect(next).toContain('needs_rework');
      expect(next).toHaveLength(2);
    });

    it('client_approved has no next statuses', () => {
      expect(getNextStatuses('client_approved')).toHaveLength(0);
    });

    it('sent_to_client can go to client_approved or client_requested_changes', () => {
      const next = getNextStatuses('sent_to_client');
      expect(next).toContain('client_approved');
      expect(next).toContain('client_requested_changes');
      expect(next).toHaveLength(2);
    });
  });

  describe('assertTransition', () => {
    it('does not throw for valid transitions', () => {
      expect(() => assertTransition('submitted', 'review_approved')).not.toThrow();
    });

    it('throws for invalid transitions', () => {
      expect(() => assertTransition('submitted', 'client_approved')).toThrow(
        'Invalid status transition: submitted → client_approved',
      );
    });
  });
});
