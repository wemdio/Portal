export interface VeLegacyProjectLink {
  legacy_he_project_id: string;
  verified_by: string;
  verified_at: string;
  review_notes: string | null;
  backfill_batch_id: string | null;
  created_at: string;
}

export interface VeLegacyProjectSummary {
  id: string;
  created_by: string | null;
  name: string;
  website_url: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  origin: 'legacy';
  read_only: true;
  verification: Pick<
    VeLegacyProjectLink,
    'verified_by' | 'verified_at' | 'review_notes' | 'backfill_batch_id'
  >;
}

export interface VeLegacyProjectDetail {
  origin: 'legacy';
  read_only: true;
  verification: VeLegacyProjectSummary['verification'];
  project: Record<string, unknown>;
  hypotheses: Array<Record<string, unknown>>;
  verticals: Array<Record<string, unknown>>;
  chains: Array<Record<string, unknown>>;
  vocabs: Array<Record<string, unknown>>;
  bases: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  dossiers: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
}

export interface VeLegacyCandidate {
  id: string;
  created_by: string | null;
  name: string;
  website_url: string;
  status: string;
  market: string | null;
  autopilot: boolean | null;
  created_at: string | null;
  linked: boolean;
}
