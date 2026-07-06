export type EmailSequenceV2RunStatus =
  | 'draft'
  | 'extracting_values'
  | 'values_ready'
  | 'generating_letters'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Язык, на котором генерируются ценности и цепочка писем. */
export type EmailSequenceV2OutputLanguage = 'ru' | 'en' | 'pl';

export interface EmailSequenceV2RunRow {
  id: string;
  user_id: string;
  status: EmailSequenceV2RunStatus;

  company_name: string | null;

  brief_file_name: string | null;
  brief_file_key: string | null;
  brief_text: string | null;
  values_text: string | null;
  values_generated_at: string | null;

  segment_text: string | null;
  customer_edits: string | null;
  personalization_operators: string | null;

  values_model: string | null;
  writer_model: string | null;

  output_language: EmailSequenceV2OutputLanguage;

  custom_regulation_key: string | null;
  custom_structure_key: string | null;
  custom_examples_keys: string[] | null;

  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailSequenceV2LetterRow {
  id: string;
  run_id: string;
  letter_index: number;
  subject: string | null;
  body: string;
  /**
   * Пауза перед ЭТИМ письмом в днях относительно предыдущего (gap).
   * 0 = «сразу» (первое письмо). UI показывает кумулятивную сумму.
   */
  wait_days: number;
  is_user_added: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailSequenceV2RunWithLetters {
  run: EmailSequenceV2RunRow;
  letters: EmailSequenceV2LetterRow[];
}
