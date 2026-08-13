import {
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';
import {
  SBIS_EXACT_OKVED_SOURCE,
} from '@/lib/companiesDirectory/sbisExactOkvedPlan';

export type SbisExactDecisionCategory =
  | 'eligible_null_unique_inn'
  | 'eligible_null_extra_inn'
  | 'absent_inn'
  | 'ogrn_mismatch'
  | 'duplicate_identity'
  | 'occupied_same'
  | 'occupied_different'
  | 'partial_exact_state';

export interface SbisExactDecisionCandidate {
  ordinal: number;
  candidate_key_sha256: string;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
}

export interface SbisExactDecisionTargetRow {
  id: string | number;
  inn: string;
  ogrn: string | null;
  okved_code_exact: string | null;
  okved_exact_source: string | null;
}

export interface SbisExactDecisionTarget {
  id: string;
  okved_code_exact: string | null;
  okved_exact_source: string | null;
}

export interface SbisExactDecision {
  ordinal: number;
  candidate_key_sha256: string;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
  category: SbisExactDecisionCategory;
  inn_match_count: number;
  identity_match_count: number;
  inn_target_ids: string[];
  identity_target_ids: string[];
  target: SbisExactDecisionTarget | null;
}

export interface SbisExactDecisionSnapshot {
  source: typeof SBIS_EXACT_OKVED_SOURCE;
  decisions: SbisExactDecision[];
  decision_sha256: string;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function candidateIdentity(input: {
  ordinal: number;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
}): {
  ordinal: number;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
} {
  return {
    ordinal: input.ordinal,
    inn: input.inn,
    ogrn: input.ogrn,
    okved_code_exact: input.okved_code_exact,
  };
}

function expectedCandidateKey(candidate: {
  ordinal: number;
  inn: string;
  ogrn: string;
  okved_code_exact: string;
}): string {
  return sha256Hex(canonicalJson(candidateIdentity(candidate)));
}

function assertNonemptyText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be non-empty text`);
  }
}

function normalizeAndValidateCandidates(
  candidates: readonly SbisExactDecisionCandidate[],
): SbisExactDecisionCandidate[] {
  const seenOrdinals = new Set<number>();
  const seenKeys = new Set<string>();
  const seenIdentities = new Set<string>();
  const normalized = candidates.map((candidate, index) => {
    if (!Number.isSafeInteger(candidate.ordinal) || candidate.ordinal < 1) {
      throw new Error(`Candidate ordinal at index ${index} must be a positive integer`);
    }
    assertNonemptyText(candidate.inn, `Candidate INN at ordinal ${candidate.ordinal}`);
    assertNonemptyText(candidate.ogrn, `Candidate OGRN at ordinal ${candidate.ordinal}`);
    assertNonemptyText(
      candidate.okved_code_exact,
      `Candidate exact OKVED at ordinal ${candidate.ordinal}`,
    );
    assertNonemptyText(
      candidate.candidate_key_sha256,
      `Candidate key SHA at ordinal ${candidate.ordinal}`,
    );
    if (seenOrdinals.has(candidate.ordinal)) {
      throw new Error(`Candidate ordinal ${candidate.ordinal} is duplicated`);
    }
    seenOrdinals.add(candidate.ordinal);
    const expectedKey = expectedCandidateKey(candidate);
    if (candidate.candidate_key_sha256 !== expectedKey) {
      throw new Error(
        `Candidate ordinal/key SHA mismatch at ordinal ${candidate.ordinal}`,
      );
    }
    if (seenKeys.has(candidate.candidate_key_sha256)) {
      throw new Error(
        `Candidate key SHA ${candidate.candidate_key_sha256} is duplicated`,
      );
    }
    seenKeys.add(candidate.candidate_key_sha256);
    const identity = `${candidate.inn}\u0000${candidate.ogrn}`;
    if (seenIdentities.has(identity)) {
      throw new Error(
        `Candidate identity ${candidate.inn}/${candidate.ogrn} is duplicated`,
      );
    }
    seenIdentities.add(identity);
    return { ...candidate };
  });
  return normalized.sort((left, right) =>
    left.ordinal - right.ordinal
    || compareText(left.candidate_key_sha256, right.candidate_key_sha256));
}

function normalizeAndValidateTargets(input: {
  targetRows: readonly SbisExactDecisionTargetRow[];
  candidateInns: ReadonlySet<string>;
}): Array<{
  id: string;
  inn: string;
  ogrn: string | null;
  okved_code_exact: string | null;
  okved_exact_source: string | null;
}> {
  const seenIds = new Set<string>();
  return input.targetRows.map((row, index) => {
    const id = String(row.id);
    assertNonemptyText(id, `Target id at index ${index}`);
    assertNonemptyText(row.inn, `Target INN for id ${id}`);
    if (row.ogrn !== null) {
      assertNonemptyText(row.ogrn, `Target OGRN for id ${id}`);
    }
    if (!input.candidateInns.has(row.inn)) {
      throw new Error(`Target id ${id} has an INN outside the candidate set`);
    }
    if (
      row.okved_code_exact !== null
      && typeof row.okved_code_exact !== 'string'
    ) {
      throw new Error(`Target exact OKVED for id ${id} must be text or null`);
    }
    if (
      row.okved_exact_source !== null
      && typeof row.okved_exact_source !== 'string'
    ) {
      throw new Error(`Target exact source for id ${id} must be text or null`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Target id ${id} is duplicated`);
    }
    seenIds.add(id);
    return {
      id,
      inn: row.inn,
      ogrn: row.ogrn,
      okved_code_exact: row.okved_code_exact,
      okved_exact_source: row.okved_exact_source,
    };
  });
}

function classifyExactState(input: {
  candidate: SbisExactDecisionCandidate;
  innMatchCount: number;
  target: SbisExactDecisionTargetRow;
}): SbisExactDecisionCategory {
  const code = input.target.okved_code_exact;
  const source = input.target.okved_exact_source;
  if (code === null && source === null) {
    return input.innMatchCount === 1
      ? 'eligible_null_unique_inn'
      : 'eligible_null_extra_inn';
  }
  if (
    code === null
    || source === null
    || code.trim() === ''
    || source.trim() === ''
  ) {
    return 'partial_exact_state';
  }
  return code === input.candidate.okved_code_exact
    ? 'occupied_same'
    : 'occupied_different';
}

export function buildSbisExactDecisionSnapshot(input: {
  source: unknown;
  candidates: readonly SbisExactDecisionCandidate[];
  targetRows: readonly SbisExactDecisionTargetRow[];
}): SbisExactDecisionSnapshot {
  if (input.source !== SBIS_EXACT_OKVED_SOURCE) {
    throw new Error(
      `Decision snapshot source must be ${SBIS_EXACT_OKVED_SOURCE}`,
    );
  }
  const candidates = normalizeAndValidateCandidates(input.candidates);
  const candidateInns = new Set(candidates.map((candidate) => candidate.inn));
  const targets = normalizeAndValidateTargets({
    targetRows: input.targetRows,
    candidateInns,
  });
  const targetsByInn = new Map<string, typeof targets>();
  for (const target of targets) {
    const matches = targetsByInn.get(target.inn) ?? [];
    matches.push(target);
    targetsByInn.set(target.inn, matches);
  }

  const decisions = candidates.map((candidate): SbisExactDecision => {
    const innMatches = targetsByInn.get(candidate.inn) ?? [];
    const identityMatches = innMatches.filter((target) =>
      target.ogrn === candidate.ogrn);
    let category: SbisExactDecisionCategory;
    let target: SbisExactDecisionTarget | null = null;
    if (innMatches.length === 0) {
      category = 'absent_inn';
    } else if (identityMatches.length === 0) {
      category = 'ogrn_mismatch';
    } else if (identityMatches.length > 1) {
      category = 'duplicate_identity';
    } else {
      const matched = identityMatches[0];
      category = classifyExactState({
        candidate,
        innMatchCount: innMatches.length,
        target: matched,
      });
      target = {
        id: String(matched.id),
        okved_code_exact: matched.okved_code_exact,
        okved_exact_source: matched.okved_exact_source,
      };
    }
    return {
      ...candidateIdentity(candidate),
      candidate_key_sha256: candidate.candidate_key_sha256,
      category,
      inn_match_count: innMatches.length,
      identity_match_count: identityMatches.length,
      inn_target_ids: innMatches.map((row) => row.id).sort(compareText),
      identity_target_ids: identityMatches.map((row) => row.id).sort(compareText),
      target,
    };
  });
  const digestPayload = {
    source: SBIS_EXACT_OKVED_SOURCE,
    decisions,
  };
  return {
    source: SBIS_EXACT_OKVED_SOURCE,
    decisions,
    decision_sha256: sha256Hex(canonicalJson(digestPayload)),
  };
}
