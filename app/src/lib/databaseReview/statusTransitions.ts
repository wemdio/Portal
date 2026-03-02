export type ReviewStatus =
  | 'submitted'
  | 'needs_rework'
  | 'review_approved'
  | 'sent_to_client'
  | 'client_approved'
  | 'client_requested_changes';

export const ALL_REVIEW_STATUSES: readonly ReviewStatus[] = [
  'submitted',
  'needs_rework',
  'review_approved',
  'sent_to_client',
  'client_approved',
  'client_requested_changes',
] as const;

const TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  submitted: ['review_approved', 'needs_rework'],
  needs_rework: ['submitted'],
  review_approved: ['sent_to_client', 'needs_rework'],
  sent_to_client: ['client_approved', 'client_requested_changes'],
  client_approved: [],
  client_requested_changes: ['submitted'],
};

export function canTransition(from: ReviewStatus, to: ReviewStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getNextStatuses(from: ReviewStatus): readonly ReviewStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function assertTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`);
  }
}
