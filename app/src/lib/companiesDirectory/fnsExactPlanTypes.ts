export const FNS_SME_EXACT_OKVED_SOURCE = 'fns_sme_registry';

export type FnsExactMatchMethod =
  | 'ogrn_inn'
  | 'unique_inn_fallback';

export type FnsExactSkippedReason =
  | 'invalid_target_inn'
  | 'invalid_target_ogrn'
  | 'ogrn_not_found'
  | 'ogrn_inn_mismatch'
  | 'inn_not_found'
  | 'ambiguous_inn_multiple_ogrn'
  | 'legacy_okved_2001';

export interface FnsExactOkvedRegistryRow {
  inn: string;
  ogrn: string;
  okved_code_exact: string;
  okved_version: '2001' | '2014';
}

export interface ExistingDirectoryExactOkvedRow {
  id: string | number;
  inn: string;
  ogrn: string | null;
  okved_code_exact: string | null;
  okved_exact_source: string | null;
}

export interface FnsExactOkvedUpdate {
  id: string | number;
  inn: string;
  expected_ogrn: string | null;
  fns_ogrn: string;
  match_method: FnsExactMatchMethod;
  okved_code_exact: string;
  okved_exact_source: typeof FNS_SME_EXACT_OKVED_SOURCE;
}

export interface FnsExactOkvedNoop {
  id: string | number;
  inn: string;
  expected_ogrn: string | null;
  fns_ogrn: string;
  match_method: FnsExactMatchMethod;
  reason: 'already_exact';
}

export interface FnsExactOkvedConflict {
  id: string | number;
  inn: string;
  expected_ogrn: string | null;
  fns_ogrn: string;
  match_method: FnsExactMatchMethod;
  kind: 'existing_exact_preserved';
  existing_okved_code_exact: string | null;
  existing_okved_exact_source: string | null;
  incoming_okved_code_exact: string;
  incoming_okved_exact_source: typeof FNS_SME_EXACT_OKVED_SOURCE;
}

export interface FnsExactOkvedSkipped {
  id: string | number;
  inn: string;
  expected_ogrn: string | null;
  reason: FnsExactSkippedReason;
}

export interface FnsExactOkvedPlanMetrics {
  registry_rows: number;
  unique_registry_ogrns: number;
  unique_registry_inns: number;
  directory_rows: number;
  matched_directory_rows: number;
  unique_matched_inns: number;
  matched_by_ogrn_rows: number;
  matched_by_unique_inn_rows: number;
  updates: number;
  noops: number;
  conflicts: number;
  skipped: number;
  inserts: 0;
  registry_not_in_target: number;
  okved_2001_quarantined: number;
  registry_multi_registration_inns: number;
  invalid_target_inn_quarantined: number;
  invalid_target_ogrn_quarantined: number;
  ogrn_not_found_quarantined: number;
  identity_mismatch_quarantined: number;
  inn_not_found_quarantined: number;
  ambiguous_inn_quarantined: number;
  legacy_okved_2001_target_quarantined: number;
}

export interface FnsExactOkvedPlan {
  source: typeof FNS_SME_EXACT_OKVED_SOURCE;
  updates: FnsExactOkvedUpdate[];
  noops: FnsExactOkvedNoop[];
  conflicts: FnsExactOkvedConflict[];
  skipped: FnsExactOkvedSkipped[];
  metrics: FnsExactOkvedPlanMetrics;
  fingerprint: string;
}
