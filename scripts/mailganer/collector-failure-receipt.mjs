// Diagnostic boundary only: no SSH, SQL, SDK, retry or collector launcher.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXCEPTION_CLASSES = Object.freeze([
  'AttributeError', 'AssertionError', 'BrokenPipeError', 'EOFError', 'Exception',
  'IndexError', 'KeyError', 'MemoryError', 'NotImplementedError', 'OSError',
  'OverflowError', 'RecursionError', 'RuntimeError', 'StopIteration', 'TimeoutError',
  'TypeError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'ValueError',
  'KeyboardInterrupt', 'SystemExit', 'JSONDecodeError', 'SafeFailure', 'OtherException',
]);
export const FAILURE_CODES = Object.freeze([
  'NEW_COMPANY_COLLECTOR_ABORT', 'DIAGNOSTIC_ABORT_UNKNOWN', 'DIAGNOSTIC_INPUT',
  'DIAGNOSTIC_QUERY_PHASE', 'DIAGNOSTIC_QUERY_LIMIT', 'DIAGNOSTIC_COMMIT_MISSING',
  'DIAGNOSTIC_FRAME_LIMIT', 'SESSION_DEADLINE', 'HELPER_HASH',
  'SOURCE_FAMILY_OR_SELECTOR', 'RESERVE116_PROOF', 'PRIOR116_SCOPE',
  'NEW_FAMILY_INITIAL_SOURCE_SCOPE', 'PRIOR_CARD_SCOPE', 'SOURCE_CURSOR',
  'PRIOR_CARD_BINDING', 'EXCLUSION_SCOPE', 'SOURCE_PROFILE_PIN',
  'SOURCE_PROFILE_NOT_VERIFIED', 'QUERY_FIELDS', 'SQL_BUDGET',
  'MAIN_DB_TRANSPORT', 'DB_TARGET_SCOPE', 'COMMIT_MISSING', 'SETTINGS_ONE',
  'SETTINGS_NOT_LIVE', 'PRIOR_IDENTITY_COUNT', 'PRIOR_IDENTITY_SCHEMA',
  'PRIOR_HOST_CAP', 'HOSTNAME_INPUT', 'PRIOR_IDENTITY_KEY_COVERAGE',
  'PRIOR_INN_SCHEMA', 'FROZEN_KNOWN_IDENTITY_MISSING_OR_AMBIGUOUS',
  'FROZEN_KNOWN_IDENTITY_CHANGED', 'PRIOR_KNOWN41_COVERAGE',
  'PRIOR_ALIAS_SCHEMA', 'DUPLICATE_SOURCE_PROFILE', 'SOURCE_CARD_COUNT',
  'SOURCE_IDENTITY_OR_LOCK', 'SOURCE_SNAPSHOT_CHANGED', 'SOURCE_PROFILE_ORDER',
  'DUPLICATE_WINDOW_META', 'NATIVE_CARD_SCHEMA', 'SOURCE_CARD_FIELD',
  'SOURCE_CARD_DUPLICATE_OR_CAP', 'SOURCE_BOUNDARY_TEMPLATE',
  'SOURCE_PROFILES_MISSING', 'SOURCE_WINDOW_META', 'SOURCE_WINDOW_CURSOR',
  'CANDIDATE_REQUEST_SCOPE', 'CANDIDATE_RESPONSE_SCOPE', 'CANDIDATE_ROW_CAP',
  'LEGAL_FIELDS', 'RESERVATION_OR_PILOT_CAP', 'OUTPUT_CAP', 'PAYLOAD_CAP',
  'FINAL_CAP', 'SQL_SIZE', 'SQL_NUL', 'SQL_MARKER', 'SQL_MARKER_UNFILLED',
  'SQL_COMMENT', 'SQL_LITERAL', 'SQL_DOLLAR_LITERAL', 'SQL_METACOMMAND',
  'SQL_NOT_READ_ONLY', 'SQL_BEGIN', 'SQL_COMMIT', 'SQL_STATEMENTS',
  'SQL_BEGIN_COUNT', 'SQL_COMMIT_COUNT', 'SQL_STATEMENT_KIND',
  'SQL_LINE_LIMIT', 'SQL_OUTPUT_LIMIT', 'SQL_TAG_ORDER', 'SQL_ROW_ORDER',
  'SQL_JSON_OBJECT', 'SQL_TIMEOUT', 'SQL_FAILED', 'SQL_STATEMENT_TIMEOUT',
  'SQL_SYNTAX_ERROR', 'SQL_LOCK_TIMEOUT', 'SQL_QUERY_CANCELED',
  'SQL_STDERR_READ_FAILED', 'SQL_COMMIT_MISSING', 'INNS_SHAPE', 'INN_FORMAT',
  'NODE_PROGRAM_SIZE', 'NODE_TIMEOUT', 'NODE_INPUT_LIMIT', 'NODE_OUTPUT_LIMIT',
  'NODE_PROTOCOL', 'NODE_FINISH',
]);
const FRAME_KEYS = [
  'kind', 'schema_version', 'binding_sha256', 'seq', 'stage_id', 'query_phase',
  'queries_started', 'commits_acknowledged', 'last_committed_query_phase',
  'node_operation_id', 'node_exit_code', 'node_timed_out', 'exception_class',
  'failure_code', 'cleanup_exception_class', 'terminal', 'node_stderr_bytes_seen',
  'node_stderr_overflow', 'node_stderr_complete', 'node_stderr_class_hint',
].sort();
const STDERR_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError']);
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGHUP']);
const SPAWN_CODES = new Set(['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'ECONNRESET', 'EPIPE', 'ENOMEM', 'EINTR']);
const isSha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const queryPhase = v => v === null || integer(v, 1, 9) || integer(v, 30, 134);
const exception = v => v === null || EXCEPTION_CLASSES.includes(v);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const canonical = v => Array.isArray(v) ? v.map(canonical) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const assert = (v, code) => { if (!v) throw new Error(code); };
const bytes = v => typeof v === 'string' ? Buffer.byteLength(v) : Buffer.isBuffer(v) ? v.length : 0;

function validFrame(f, binding) {
  return plain(f) && JSON.stringify(Object.keys(f).sort()) === JSON.stringify(FRAME_KEYS)
    && f.kind === 'collector_diagnostic' && f.schema_version === 1
    && f.binding_sha256 === binding && integer(f.seq, 1, 512)
    && integer(f.stage_id, 0, 7) && queryPhase(f.query_phase)
    && integer(f.queries_started, 0, 114) && integer(f.commits_acknowledged, 0, f.queries_started)
    && queryPhase(f.last_committed_query_phase)
    && (f.commits_acknowledged === 0 ? f.last_committed_query_phase === null : f.last_committed_query_phase !== null)
    && integer(f.node_operation_id, 0, 4)
    && (f.node_exit_code === null || integer(f.node_exit_code, -128, 255))
    && (f.node_timed_out === null || typeof f.node_timed_out === 'boolean')
    && exception(f.exception_class) && exception(f.cleanup_exception_class)
    && (f.failure_code === null || FAILURE_CODES.includes(f.failure_code))
    && [null, 'completed', 'failed'].includes(f.terminal)
    && integer(f.node_stderr_bytes_seen, 0, 1048576)
    && typeof f.node_stderr_overflow === 'boolean' && typeof f.node_stderr_complete === 'boolean'
    && (!f.node_stderr_overflow || f.node_stderr_bytes_seen === 1048576)
    && (f.node_stderr_class_hint === null || STDERR_CLASSES.has(f.node_stderr_class_hint))
    && (f.terminal === 'failed'
      ? f.failure_code !== null && f.exception_class !== null
      : f.failure_code === null && f.exception_class === null && f.cleanup_exception_class === null)
    && (f.terminal !== 'completed' || f.queries_started === f.commits_acknowledged);
}

// Discard ALL raw text. A partial/conflicting/malformed stream is not trusted.
export function parseDiagnosticFrames(stderr, binding) {
  assert(isSha(binding), 'DIAGNOSTIC_BINDING');
  const size = bytes(stderr);
  if (size > 1048576) return { trusted: false, reason: 'stream_limit', frames: [] };
  const frames = [];
  let previous = null;
  try {
    const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : '';
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 4096 || frames.length >= 512) throw new Error('frame_limit');
      const f = JSON.parse(line);
      if (!validFrame(f, binding) || f.seq !== frames.length + 1 || (previous && previous.terminal !== null)) throw new Error('frame_invalid');
      if (previous && (f.queries_started < previous.queries_started || f.commits_acknowledged < previous.commits_acknowledged || f.node_stderr_bytes_seen < previous.node_stderr_bytes_seen)) throw new Error('counter_regression');
      frames.push(f); previous = f;
    }
  } catch {
    return { trusted: false, reason: 'invalid_or_conflicting_frames', frames: [] };
  }
  if (!previous?.terminal) return { trusted: false, reason: 'terminal_missing', frames: [] };
  return { trusted: true, reason: 'validated_terminal', frames };
}

export function buildFailureReceipt(run, binding, boundary = 'transport') {
  assert(plain(run) && isSha(binding), 'FAILURE_RECEIPT_INPUT');
  assert(['transport', 'envelope'].includes(boundary), 'FAILURE_BOUNDARY');
  const parsed = parseDiagnosticFrames(run.stderr, binding);
  const last = parsed.frames.at(-1) ?? null;
  // A successful process still needs the independent source envelope/checkpoint
  // verifier. This module never creates a checkpoint or authorizes a retry.
  const statusValid = run.status === null || integer(run.status, -128, 255);
  const interrupted = run.status === null && (SIGNALS.has(run.signal) || SPAWN_CODES.has(run.error?.code));
  const consistent = parsed.trusted && statusValid && (last.terminal === 'failed'
    ? integer(run.status, -128, 255) && run.status !== 0 || interrupted
    : run.status === 0 && !run.signal && !run.error);
  return {
    schema_version: 1,
    kind: 'readonly_collector_failure_receipt',
    binding_sha256: binding,
    state: 'halted_no_retry',
    no_retry: true,
    failure_boundary: boundary,
    spawn_status: integer(run.status, -128, 255) ? run.status : null,
    spawn_signal: run.signal === null || run.signal === undefined ? null : SIGNALS.has(run.signal) ? run.signal : 'UNKNOWN',
    spawn_error_code: run.error ? SPAWN_CODES.has(run.error.code) ? run.error.code : 'UNKNOWN' : null,
    diagnostic_trusted: consistent,
    diagnostic_reason: consistent ? parsed.reason : parsed.trusted ? 'process_terminal_conflict' : parsed.reason,
    diagnostic_complete: consistent,
    diagnostic_frames_sha256: consistent ? digest(parsed.frames) : null,
    diagnostic_frames: consistent ? parsed.frames : [],
    confirmed_queries_started: consistent ? last.queries_started : null,
    confirmed_commits_acknowledged: consistent ? last.commits_acknowledged : null,
    candidate_company_count: null,
    candidate_address_count: null,
    checkpoint_created: false,
    execution_authorized: false,
  };
}

export function persistFailureReceipt(sessionDirectory, receipt) {
  assert(typeof sessionDirectory === 'string' && path.isAbsolute(sessionDirectory), 'RECEIPT_DIRECTORY');
  const actual = fs.realpathSync(sessionDirectory), stat = fs.statSync(actual);
  assert(actual === sessionDirectory && stat.isDirectory() && (stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid()), 'RECEIPT_DIRECTORY_PRIVATE');
  // Only receipts built by this module pass an exact reconstruction check.
  const frames = receipt?.diagnostic_frames;
  assert(Array.isArray(frames) && frames.length <= 512, 'RECEIPT_SCHEMA');
  const rebuilt = buildFailureReceipt({ status: receipt.spawn_status,
    signal: receipt.spawn_signal, error: receipt.spawn_error_code ? { code: receipt.spawn_error_code } : null,
    stderr: frames.map(f => JSON.stringify(f)).join('\n'),
  }, receipt.binding_sha256, receipt.failure_boundary);
  if (!receipt.diagnostic_trusted) {
    // No frame data may be preserved under an untrusted transport outcome.
    assert(frames.length === 0 && receipt.diagnostic_frames_sha256 === null
      && receipt.confirmed_queries_started === null && receipt.confirmed_commits_acknowledged === null,
    'UNTRUSTED_RECEIPT_CONTENT');
    assert(['stream_limit', 'invalid_or_conflicting_frames', 'terminal_missing', 'process_terminal_conflict'].includes(receipt.diagnostic_reason), 'RECEIPT_REASON');
    rebuilt.diagnostic_reason = receipt.diagnostic_reason;
  }
  assert(digest(rebuilt) === digest(receipt), 'RECEIPT_EXACT_SCHEMA');
  const filename = path.join(actual, 'collector-failure-diagnostic.json');
  // Rebuilt is owned plain JSON data. Never serialize a caller's toJSON hook.
  fs.writeFileSync(filename, JSON.stringify(rebuilt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return filename;
}

// Future runner integration point: accepts an ALREADY FINISHED result. It
// cannot launch or repeat a transport. Persist the failure BEFORE throwing.
export async function finishCollectorAttempt(run, { sessionDirectory, bindingSha256 }, verifyEnvelope) {
  assert(plain(run) && typeof verifyEnvelope === 'function', 'COLLECTOR_RESULT_INPUT');
  const parsed = parseDiagnosticFrames(run.stderr, bindingSha256);
  let boundary = 'transport';
  if (run.status === 0 && !run.error && !run.signal && parsed.trusted && parsed.frames.at(-1)?.terminal === 'completed') {
    boundary = 'envelope';
    try {
      return await verifyEnvelope(run.stdout);
    } catch {
      // Verification errors may contain a row/address. Never propagate them.
    }
  }
  const receipt = buildFailureReceipt(run, bindingSha256, boundary);
  try {
    persistFailureReceipt(sessionDirectory, receipt);
  } catch {
    throw new Error('COLLECTOR_RECEIPT_SAVE_FAILED_NO_RETRY');
  }
  throw new Error('COLLECTOR_STOPPED_NO_RETRY');
}
