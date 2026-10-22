"""In-memory diagnostics for an explicitly supplied collector; never a launcher.

This module imports nothing, opens nothing and starts no process or thread.  The
caller owns every injected callback and transport.  Merely loading/executing this
file has no operational effect.  It does not make an execution adapter reviewed,
authorize a retry, or explain an earlier failure whose diagnostics were lost.

``run_diagnosed(main, payload, helpers, binding_sha256, emit)`` temporarily wraps
the supplied helper dictionary, calls ``main(payload, helpers_override=helpers)``
and restores the dictionary on every exit.  ``emit`` receives only fixed-shape
JSON-compatible dictionaries.  Exceptions propagate; their messages, arguments,
tracebacks and source values are never emitted.  A failing ``close`` is deferred
so it cannot replace a primary failure already unwinding through the controller.

Stages: 0 prepare, 1 query, 2 node construction, 3 send, 4 receive, 5 finish,
6 cleanup, 7 successful terminal.  Node operations: 0 none, 1 send, 2 receive,
3 finish, 4 close.  Outside a directly wrapped operation, stage is the last
instrumented context, not proof that an intervening controller check succeeded.

The stderr sink drains without retaining text.  It records a saturated byte
count and an anchored JS class hint only; that hint is NOT a confirmed cause.
Completion is true only after EOF and acknowledgement by an injected Event.
No typed JS error emitter or live transport is added or wired by this library.
"""

EXCEPTION_CLASSES = (
    "AssertionError", "AttributeError", "BrokenPipeError", "EOFError",
    "Exception", "IndexError", "KeyError", "MemoryError",
    "NotImplementedError", "OSError", "OverflowError", "RecursionError",
    "RuntimeError", "StopIteration", "TimeoutError", "TypeError",
    "UnicodeDecodeError", "UnicodeEncodeError", "ValueError",
    "KeyboardInterrupt", "SystemExit", "JSONDecodeError", "SafeFailure",
    "OtherException",
)
FAILURE_CODES = (
    "DIAGNOSTIC_ABORT_UNKNOWN", "DIAGNOSTIC_INPUT", "DIAGNOSTIC_QUERY_PHASE",
    "DIAGNOSTIC_QUERY_LIMIT", "DIAGNOSTIC_COMMIT_MISSING",
    "DIAGNOSTIC_FRAME_LIMIT", "NEW_COMPANY_COLLECTOR_ABORT",
    "SESSION_DEADLINE", "HELPER_HASH",
    "SOURCE_FAMILY_OR_SELECTOR", "RESERVE116_PROOF", "PRIOR116_SCOPE",
    "NEW_FAMILY_INITIAL_SOURCE_SCOPE", "PRIOR_CARD_SCOPE", "SOURCE_CURSOR",
    "PRIOR_CARD_BINDING", "EXCLUSION_SCOPE", "SOURCE_PROFILE_PIN",
    "SOURCE_PROFILE_NOT_VERIFIED", "QUERY_FIELDS", "SQL_BUDGET",
    "MAIN_DB_TRANSPORT", "DB_TARGET_SCOPE", "COMMIT_MISSING", "SETTINGS_ONE",
    "SETTINGS_NOT_LIVE", "PRIOR_IDENTITY_COUNT", "PRIOR_IDENTITY_SCHEMA",
    "PRIOR_HOST_CAP", "HOSTNAME_INPUT", "PRIOR_IDENTITY_KEY_COVERAGE",
    "PRIOR_INN_SCHEMA", "FROZEN_KNOWN_IDENTITY_MISSING_OR_AMBIGUOUS",
    "FROZEN_KNOWN_IDENTITY_CHANGED", "PRIOR_KNOWN41_COVERAGE",
    "PRIOR_ALIAS_SCHEMA", "DUPLICATE_SOURCE_PROFILE", "SOURCE_CARD_COUNT",
    "SOURCE_IDENTITY_OR_LOCK", "SOURCE_SNAPSHOT_CHANGED", "SOURCE_PROFILE_ORDER",
    "DUPLICATE_WINDOW_META", "NATIVE_CARD_SCHEMA", "SOURCE_CARD_FIELD",
    "SOURCE_CARD_DUPLICATE_OR_CAP", "SOURCE_BOUNDARY_TEMPLATE",
    "SOURCE_PROFILES_MISSING", "SOURCE_WINDOW_META", "SOURCE_WINDOW_CURSOR",
    "CANDIDATE_REQUEST_SCOPE", "CANDIDATE_RESPONSE_SCOPE", "CANDIDATE_ROW_CAP",
    "LEGAL_FIELDS", "RESERVATION_OR_PILOT_CAP", "OUTPUT_CAP", "PAYLOAD_CAP",
    "FINAL_CAP", "SQL_SIZE", "SQL_NUL", "SQL_MARKER", "SQL_MARKER_UNFILLED",
    "SQL_COMMENT", "SQL_LITERAL", "SQL_DOLLAR_LITERAL", "SQL_METACOMMAND",
    "SQL_NOT_READ_ONLY", "SQL_BEGIN", "SQL_COMMIT", "SQL_STATEMENTS",
    "SQL_BEGIN_COUNT", "SQL_COMMIT_COUNT", "SQL_STATEMENT_KIND",
    "SQL_LINE_LIMIT", "SQL_OUTPUT_LIMIT", "SQL_TAG_ORDER", "SQL_ROW_ORDER",
    "SQL_JSON_OBJECT", "SQL_TIMEOUT", "SQL_FAILED", "SQL_STATEMENT_TIMEOUT",
    "SQL_SYNTAX_ERROR", "SQL_LOCK_TIMEOUT", "SQL_QUERY_CANCELED",
    "SQL_STDERR_READ_FAILED", "SQL_COMMIT_MISSING", "INNS_SHAPE", "INN_FORMAT",
    "NODE_PROGRAM_SIZE", "NODE_TIMEOUT", "NODE_INPUT_LIMIT", "NODE_OUTPUT_LIMIT",
    "NODE_PROTOCOL", "NODE_FINISH",
)
STDERR_CLASS_HINTS = (
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
)
FRAME_FIELDS = (
    "kind", "schema_version", "binding_sha256", "seq", "stage_id",
    "query_phase", "queries_started", "commits_acknowledged",
    "last_committed_query_phase", "node_operation_id", "node_exit_code",
    "node_timed_out", "exception_class", "failure_code",
    "cleanup_exception_class", "terminal", "node_stderr_bytes_seen",
    "node_stderr_overflow", "node_stderr_complete", "node_stderr_class_hint",
)
_BUILTIN_CLASSES = (
    AssertionError, AttributeError, BrokenPipeError, EOFError, Exception,
    IndexError, KeyError, MemoryError, NotImplementedError, OSError,
    OverflowError, RecursionError, RuntimeError, StopIteration, TimeoutError,
    TypeError, UnicodeDecodeError, UnicodeEncodeError, ValueError,
    KeyboardInterrupt, SystemExit,
)
_STDERR_CAP = 1048576
_SCRATCH_CAP = 128


def _query_phase(value):
    return type(value) is int and (1 <= value <= 9 or 30 <= value <= 134)


def run_diagnosed(controller_main, payload, helpers, binding_sha256, emit):
    """Instrument one supplied call, without retrying or creating a transport.

    ``queries_started`` counts entry into the wrapped query callback.  An ACK is
    counted only after that callback returns a dict with an exact boolean True
    ``commit_acknowledged``.  An interrupted callback has no inferred ACK.
    Failed frames preserve the first wrapped failure's context through cleanup.
    A missing/failed emit cannot be repaired here and never masks that failure.
    """
    if (type(helpers) is not dict or not callable(controller_main)
            or not callable(emit) or type(binding_sha256) is not str
            or len(binding_sha256) != 64
            or any(c not in "0123456789abcdef" for c in binding_sha256)
            or not callable(helpers.get("run_psql"))
            or not callable(helpers.get("NodePeer"))):
        raise ValueError("DIAGNOSTIC_INPUT")

    original_query = helpers["run_psql"]
    original_node = helpers["NodePeer"]
    had_drain = "discard_stderr" in helpers
    original_drain = helpers.get("discard_stderr")
    had_progress = "emit_progress" in helpers
    original_progress = helpers.get("emit_progress")
    state = {
        "seq": 0, "stage_id": 0, "query_phase": None,
        "queries_started": 0, "commits_acknowledged": 0,
        "last_committed_query_phase": None, "node_operation_id": 0,
        "node_exit_code": None, "node_timed_out": None,
        "node_stderr_bytes_seen": 0, "node_stderr_overflow": False,
        "node_stderr_complete": False, "node_stderr_class_hint": None,
    }
    primary = [None, None]
    cleanup = [None, None]
    peer = [None]
    drain_event = [None]

    def class_name(error):
        error_type = type(error)
        for builtin in _BUILTIN_CLASSES:
            if error_type is builtin:
                return builtin.__name__
        json_module = helpers.get("json")
        if error_type is getattr(json_module, "JSONDecodeError", None):
            return "JSONDecodeError"
        safe_failure = helpers.get("SafeFailure")
        if safe_failure is not None and error_type is safe_failure:
            return "SafeFailure"
        return "OtherException"

    def failure_code(error):
        # The value is compared with constants, never formatted or emitted raw.
        args = getattr(error, "args", ())
        if (type(args) is tuple and len(args) == 1 and type(args[0]) is str
                and args[0] in FAILURE_CODES):
            return args[0]
        return "DIAGNOSTIC_ABORT_UNKNOWN"

    def context():
        return (state["stage_id"], state["query_phase"],
                state["node_operation_id"])

    def restore_context(saved):
        state["stage_id"], state["query_phase"], state["node_operation_id"] = saved

    def remember(error):
        if primary[0] is None:
            primary[:] = [error, context()]

    def refresh_node():
        current = peer[0]
        if current is None:
            return
        try:
            code = getattr(getattr(current, "child", None), "returncode", None)
            if type(code) is int and -128 <= code <= 255:
                state["node_exit_code"] = code
            event = getattr(current, "timed_out", None)
            value = event.is_set() if event is not None else None
            if type(value) is bool:
                state["node_timed_out"] = value
        except BaseException:
            # Diagnostics must not introduce a new child operation or failure.
            pass

    def frame(terminal=None, error=None):
        # Keep the final sequence slot available for a failure terminal.
        if state["seq"] >= (512 if terminal is not None else 511):
            raise RuntimeError("DIAGNOSTIC_FRAME_LIMIT")
        refresh_node()
        state["seq"] += 1
        value = {"kind": "collector_diagnostic", "schema_version": 1,
                 "binding_sha256": binding_sha256, **state,
                 "exception_class": class_name(error) if error is not None else None,
                 "failure_code": failure_code(error) if error is not None else None,
                 "cleanup_exception_class": class_name(cleanup[0])
                 if cleanup[0] is not None else None, "terminal": terminal}
        if terminal == "failed" and primary[1] is not None:
            value["stage_id"], value["query_phase"], value["node_operation_id"] = primary[1]
        emit(value)

    def diagnosed_progress(phase, rows=0, elapsed_ms=0, committed=0):
        # The inherited SQL helper resolves this name in the injected globals.
        # Ignore raw counters and its early COMMIT marker: only callback return
        # acknowledges a commit.  Never forward the legacy unbound JSON line.
        if not _query_phase(phase):
            raise ValueError("DIAGNOSTIC_QUERY_PHASE")
        saved = context()
        state["stage_id"] = 1
        state["query_phase"] = phase
        state["node_operation_id"] = 0
        try:
            frame()
        finally:
            restore_context(saved)

    def diagnosed_query(sql, consume, phase):
        state["stage_id"] = 1
        state["node_operation_id"] = 0
        try:
            if not _query_phase(phase):
                raise ValueError("DIAGNOSTIC_QUERY_PHASE")
            state["query_phase"] = phase
            if state["queries_started"] >= 114:
                raise ValueError("DIAGNOSTIC_QUERY_LIMIT")
            state["queries_started"] += 1
            frame()
            result = original_query(sql, consume, phase)
            state["stage_id"] = 1
            state["node_operation_id"] = 0
            state["query_phase"] = phase
            if type(result) is not dict or result.get("commit_acknowledged") is not True:
                raise ValueError("DIAGNOSTIC_COMMIT_MISSING")
            state["commits_acknowledged"] += 1
            state["last_committed_query_phase"] = phase
            frame()
            return result
        except BaseException as error:
            if primary[0] is None:
                state["stage_id"] = 1
                state["node_operation_id"] = 0
                state["query_phase"] = phase if _query_phase(phase) else None
            remember(error)
            raise

    def bounded_drain(stream):
        # Keep at most 128 bytes of an anchored line prefix; never retain a tail.
        scratch = bytearray()
        discarding = False
        reached_eof = False
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    reached_eof = True
                    break
                if type(chunk) is not bytes:
                    break
                previous_bytes = state["node_stderr_bytes_seen"]
                total = previous_bytes + len(chunk)
                state["node_stderr_overflow"] = state["node_stderr_overflow"] or total > _STDERR_CAP
                state["node_stderr_bytes_seen"] = min(_STDERR_CAP, total)
                # Drain the entire pipe, but classification CPU is bounded to
                # the first MiB (and stops after the first class hint).
                if previous_bytes >= _STDERR_CAP or state["node_stderr_class_hint"] is not None:
                    scratch.clear()
                    continue
                for byte in chunk[:_STDERR_CAP - previous_bytes]:
                    if byte == 10:
                        scratch.clear()
                        discarding = False
                        continue
                    if discarding:
                        continue
                    if len(scratch) >= _SCRATCH_CAP:
                        scratch.clear()
                        discarding = True
                        continue
                    scratch.append(byte)
                    for hint in STDERR_CLASS_HINTS:
                        if scratch == (hint + ":").encode("ascii"):
                            if state["node_stderr_class_hint"] is None:
                                state["node_stderr_class_hint"] = hint
                            scratch.clear()
                            discarding = True
                            break
        except BaseException:
            reached_eof = False
        finally:
            scratch.clear()
            event = drain_event[0]
            if event is not None:
                try:
                    state["node_stderr_complete"] = reached_eof
                    event.set()
                except BaseException:
                    state["node_stderr_complete"] = False

    def wait_for_drain():
        event = drain_event[0]
        if event is None:
            state["node_stderr_complete"] = False
            return
        try:
            if event.wait(0.1) is not True:
                state["node_stderr_complete"] = False
        except BaseException:
            state["node_stderr_complete"] = False

    class DiagnosedPeer:
        def __init__(self, current):
            self.current = current

        def __getattr__(self, name):
            return getattr(self.current, name)

        def call(self, name, stage_id, operation_id, *args, **kwargs):
            state["stage_id"] = stage_id
            state["node_operation_id"] = operation_id
            try:
                return getattr(self.current, name)(*args, **kwargs)
            except BaseException as error:
                remember(error)
                raise
            finally:
                refresh_node()

        def send(self, *args, **kwargs):
            return self.call("send", 3, 1, *args, **kwargs)

        def receive(self, *args, **kwargs):
            return self.call("receive", 4, 2, *args, **kwargs)

        def finish(self, *args, **kwargs):
            return self.call("finish", 5, 3, *args, **kwargs)

        def close(self, *args, **kwargs):
            saved = context()
            state["stage_id"] = 6
            state["node_operation_id"] = 4
            try:
                return self.current.close(*args, **kwargs)
            except BaseException as error:
                if cleanup[0] is None:
                    cleanup[:] = [error, context()]
                # Defer: controller may already be unwinding another exception.
                return None
            finally:
                refresh_node()
                wait_for_drain()
                restore_context(saved)

    def diagnosed_node(*args, **kwargs):
        state["stage_id"] = 2
        state["node_operation_id"] = 0
        event_factory = getattr(helpers.get("threading"), "Event", None)
        if callable(event_factory):
            try:
                drain_event[0] = event_factory()
            except BaseException:
                drain_event[0] = None
        try:
            current = original_node(*args, **kwargs)
            peer[0] = current
            return DiagnosedPeer(current)
        except BaseException as error:
            remember(error)
            raise

    helpers["run_psql"] = diagnosed_query
    helpers["NodePeer"] = diagnosed_node
    helpers["discard_stderr"] = bounded_drain
    helpers["emit_progress"] = diagnosed_progress
    try:
        result = controller_main(payload, helpers_override=helpers)
        # A caller must not turn an already observed operation failure into a
        # successful terminal by catching it and returning a normal envelope.
        if primary[0] is not None:
            raise primary[0]
        if cleanup[0] is not None:
            primary[:] = cleanup
            raise cleanup[0]
        state["stage_id"] = 7
        state["node_operation_id"] = 0
        frame(terminal="completed")
        return result
    except BaseException as error:
        remember(error)
        try:
            frame(terminal="failed", error=primary[0])
        except BaseException:
            pass
        if error is primary[0]:
            raise
        raise primary[0]
    finally:
        helpers["run_psql"] = original_query
        helpers["NodePeer"] = original_node
        if had_drain:
            helpers["discard_stderr"] = original_drain
        else:
            helpers.pop("discard_stderr", None)
        if had_progress:
            helpers["emit_progress"] = original_progress
        else:
            helpers.pop("emit_progress", None)
