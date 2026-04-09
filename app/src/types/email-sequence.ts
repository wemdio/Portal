export type EmailSequenceRunStatus = 'draft' | 'running' | 'completed' | 'failed';

export type EmailSequenceBrief = {
  site?: string;
  Company?: string;
  Product?: string;
  Service?: string;
  Segments?: string;
  ca?: string;
  FIGURES?: string;
  sender_name?: string;
  language?: string;
  notes?: string;
  analysis_model?: string;
  writer_model?: string;
};

export type EmailSequenceRunRow = {
  id: string;
  user_id: string;
  status: EmailSequenceRunStatus;
  brief: EmailSequenceBrief;
  segments: Array<{ segment: string }> | null;
  created_at: string;
  updated_at: string;
  error_message?: string | null;
};

export type EmailSequenceSegmentRow = {
  id: string;
  run_id: string;
  segment_index: number;
  segment_text: string;
  segment_research?: string | null;
  pains_and_solutions?: string | null;
  tasks_and_solutions?: string | null;
  social_proof?: string | null;
  cases_lpr?: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailSequenceLetterRow = {
  id: string;
  run_id: string;
  segment_index: number;
  letter_index: number;
  content: string;
  created_at: string;
};

