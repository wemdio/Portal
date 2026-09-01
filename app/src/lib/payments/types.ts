export const PAYMENT_DEPARTMENTS = [
  'outreach',
  'paid_traffic',
  'accounting',
  'sales',
] as const;

export type PaymentDepartment = (typeof PAYMENT_DEPARTMENTS)[number];
export type PaymentExpenseType = 'one_time' | 'planned' | 'legacy_unclassified';
export type NewPaymentExpenseType = Exclude<PaymentExpenseType, 'legacy_unclassified'>;
export type PaymentBudgetScope = 'general' | 'costs';
export const PAYMENT_COST_CATEGORIES = [
  'instantly',
  'email',
  'bases',
  'domains',
  'other',
] as const;
export type PaymentCostCategory = (typeof PAYMENT_COST_CATEGORIES)[number];
export type PaymentUrgency = 'normal' | 'urgent' | 'critical';
export type PaymentRequestStatus = 'pending' | 'approved' | 'paid' | 'rejected';
export type PaymentApprovalReason = 'planned' | 'limit_exceeded' | null;
export type PaymentPaidOnSource = 'entered' | 'legacy_created_at' | null;
export type PaymentBudgetLevel = 'normal' | 'warning' | 'exceeded';

export interface PaymentPerson {
  id: string;
  name: string;
}

export interface PaymentProject {
  id: string;
  client: string;
  name: string;
}

export interface PaymentRequest {
  id: string;
  requester: PaymentPerson;
  department: PaymentDepartment;
  description: string;
  amount: number;
  project: PaymentProject | null;
  comment: string | null;
  expenseType: PaymentExpenseType;
  budgetScope: PaymentBudgetScope;
  costCategory: PaymentCostCategory | null;
  expectedPaymentOn: string;
  urgency: PaymentUrgency;
  documentUrl: string | null;
  status: PaymentRequestStatus;
  approvalReason: PaymentApprovalReason;
  decisionComment: string | null;
  decidedBy: PaymentPerson | null;
  decidedAt: string | null;
  paidOn: string | null;
  paidOnSource: PaymentPaidOnSource;
  paidBy: PaymentPerson | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PaymentCostCategoryTotals = Record<PaymentCostCategory, {
  paid: number;
  reserved: number;
}>;

export interface PaymentCostBudgetSummary {
  limit: number;
  paid: number;
  reserved: number;
  used: number;
  remaining: number;
  overage: number;
  usagePct: number;
  level: PaymentBudgetLevel;
  dataComplete: boolean;
  missingFxCount: number;
  mailPaid: number;
  mailReserved: number;
  techPaid: number;
  techReserved: number;
  manualPaid: number;
  manualReserved: number;
  byCategory: PaymentCostCategoryTotals;
}

export interface PaymentMonthSummary {
  limit: number;
  paidOneTime: number;
  reservedOneTime: number;
  usedOneTime: number;
  remaining: number;
  overage: number;
  usagePct: number;
  level: PaymentBudgetLevel;
  legacyCount: number;
  legacyAmount: number;
  paidAll: number;
  pendingCount: number;
  approvedCount: number;
  costBudget: PaymentCostBudgetSummary;
}

export interface PaymentPeriod {
  key: string;
  label: string;
  previous: string;
  next: string;
  asOf: string;
}

export interface PaymentsReadModel {
  period: PaymentPeriod;
  summary: PaymentMonthSummary;
  requests: PaymentRequest[];
  projects: PaymentProject[];
  canManage: boolean;
}

export interface SubmitPaymentRequestInput {
  department: PaymentDepartment;
  description: string;
  amount: number;
  projectId: string | null;
  comment: string | null;
  expenseType: NewPaymentExpenseType;
  budgetScope: PaymentBudgetScope;
  costCategory: PaymentCostCategory | null;
  expectedPaymentOn: string;
  urgency: PaymentUrgency;
  documentUrl: string | null;
}

export interface SubmitPaymentRequestResponse {
  request: PaymentRequest;
  summary: PaymentMonthSummary;
  outcome: 'auto_approved' | 'approval_required';
}

export type PaymentRequestActionInput =
  | {
      action: 'approve';
      expectedUpdatedAt: string;
      decisionComment?: string;
    }
  | {
      action: 'reject';
      expectedUpdatedAt: string;
      decisionComment: string;
    }
  | {
      action: 'mark_paid';
      expectedUpdatedAt: string;
      paidOn: string;
    }
  | {
      action: 'classify_legacy';
      expectedUpdatedAt: string;
      expenseType: NewPaymentExpenseType;
      paidOn: string;
    };

export interface PaymentMonthSummaryUpdate {
  month: string;
  summary: PaymentMonthSummary;
}

export interface PaymentRequestActionResponse {
  request: PaymentRequest;
  summaries: PaymentMonthSummaryUpdate[];
  outcome: 'approved' | 'rejected' | 'paid' | 'legacy_classified';
}
