"""
Unit coverage for the conversation-loop helpers (2026-06-12 reply-reading).

Pure helpers only (no DB / browser): thread→LLM-context formatting and the
inbound dedup external_id. The DOM scrape (li_actions.read_thread) and the
DB glue (handle_follow_up) need a live LinkedIn session — covered by dogfood.
"""
import uuid

from linkedin.portal_daemon.handlers import _format_recent_messages, _inbound_external_id


# ─────────────── _format_recent_messages ───────────────


def test_format_tags_directions():
    thread = [
        {'direction': 'inbound', 'text': 'Привет'},
        {'direction': 'outbound', 'text': 'Здравствуйте'},
        {'direction': 'unknown', 'text': '?'},
    ]
    assert _format_recent_messages(thread) == 'Lead: Привет\nMe: Здравствуйте\n?: ?'


def test_format_keeps_only_last_n():
    thread = [{'direction': 'inbound', 'text': str(i)} for i in range(20)]
    out = _format_recent_messages(thread, limit=5)
    assert out.split('\n') == ['Lead: 15', 'Lead: 16', 'Lead: 17', 'Lead: 18', 'Lead: 19']


def test_format_empty_thread():
    assert _format_recent_messages([]) == ''


# ─────────────── _inbound_external_id ───────────────


def test_external_id_prefers_urn():
    lid = uuid.uuid4()
    assert _inbound_external_id(lid, 'urn:li:messagingMessage:123', 'hi') == 'urn:li:messagingMessage:123'


def test_external_id_fallback_is_stable():
    # Must NOT use hash() — it's per-process randomized, which would re-record
    # the same inbound message after every daemon restart.
    lid = uuid.uuid4()
    a = _inbound_external_id(lid, None, 'hello there')
    b = _inbound_external_id(lid, None, 'hello there')
    assert a == b
    assert a.startswith(f'{lid}:in:')


def test_external_id_fallback_differs_by_text():
    lid = uuid.uuid4()
    assert _inbound_external_id(lid, None, 'a') != _inbound_external_id(lid, None, 'b')


def test_external_id_fallback_scoped_to_lead():
    # Same text, different leads → different id (index is globally unique).
    assert _inbound_external_id(uuid.uuid4(), None, 'x') != _inbound_external_id(uuid.uuid4(), None, 'x')
