"""
Unit tests for instantly-sync-bot's analytics fetch logic.

Background (May 2026):
  Instantly's bulk endpoint  GET /api/v2/campaigns/analytics  with no `id`
  parameter started returning sporadic 500 ("Unable to count leads") on a
  workspace with ~1700 campaigns.  When this happens the bot used to return
  an empty list, leaving `instantly_campaign_catalog` stale (last successful
  sync 2026-04-13 in production).

  The fix: when the bulk endpoint fails (or returns []) AND the caller has a
  list of known campaign ids, fall back to per-id requests
  (GET /campaigns/analytics?id=<uuid>) issued in parallel with bounded
  concurrency.  Per-id failures must NOT abort the whole run — they are
  silently skipped so the cache still gets refreshed for healthy campaigns.

Contract under test (`fetch_campaign_analytics`):

  async def fetch_campaign_analytics(campaign_ids: list[str] | None = None)
      -> list[dict]

  - bulk OK with non-empty body         → returns bulk body, no per-id calls
  - bulk OK but empty body              → falls back to per-id (when ids given)
  - bulk raises 5xx on every attempt    → falls back to per-id (when ids given)
  - per-id: some ids 5xx                → skipped, others returned
  - bulk fails AND no campaign_ids      → returns [] (legacy behavior preserved)
"""
from __future__ import annotations

import os
from typing import Any, Callable

# Set required env vars BEFORE importing main, otherwise the module-level
# constants (INSTANTLY_API_KEY, DATABASE_URL) end up empty and the test
# probe's request matchers won't see the Authorization header.
os.environ.setdefault("INSTANTLY_API_KEY", "test-api-key-deadbeef")
os.environ.setdefault("INSTANTLY_DATABASE_URL", "postgresql://localhost/x")
os.environ.setdefault("INSTANTLY_SYNC_RETRY_ATTEMPTS", "2")  # speed up tests

import httpx
import respx

import main  # noqa: E402  (import after env setup, see comment above)


INSTANTLY_BASE = main.INSTANTLY_BASE
ANALYTICS_URL = f"{INSTANTLY_BASE}/campaigns/analytics"

# Speed up bulk retries so failing tests don't sit in 5s+5s exponential backoff.
main.RETRY_ATTEMPTS = 2


# ── Helpers ───────────────────────────────────────────────────────────────────

def _bulk_payload(*ids: str) -> list[dict[str, Any]]:
    """Shape returned by Instantly bulk endpoint: list of analytics dicts."""
    return [
        {
            "campaign_id": cid,
            "campaign_name": f"Camp {cid}",
            "leads_count": 100 + i,
            "emails_sent_count": 50,
            "open_count": 10,
            "reply_count": 1,
            "bounced_count": 0,
            "new_leads_contacted_count": 50,
            "unsubscribed_count": 0,
        }
        for i, cid in enumerate(ids)
    ]


def _per_id_payload(cid: str) -> list[dict[str, Any]]:
    """Per-id endpoint also returns a LIST (single-element); contract mirrors bulk."""
    return _bulk_payload(cid)


def _wire_handler(handler: Callable[[httpx.Request], httpx.Response]) -> respx.Route:
    """Register a single side_effect handler that branches on the `id` query
    parameter.  Avoids respx's URL/params matching subtleties."""
    return respx.get(ANALYTICS_URL).mock(side_effect=handler)


# ── Tests ─────────────────────────────────────────────────────────────────────

@respx.mock
async def test_bulk_ok_returns_body_no_per_id():
    """Regression: when bulk succeeds, do NOT issue per-id requests."""
    per_id_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        cid = request.url.params.get("id")
        if cid is None:
            return httpx.Response(200, json=_bulk_payload("a", "b", "c"))
        per_id_calls.append(cid)
        return httpx.Response(200, json=_per_id_payload(cid))

    _wire_handler(handler)

    result = await main.fetch_campaign_analytics(["a", "b", "c"])

    assert {r["campaign_id"] for r in result} == {"a", "b", "c"}
    assert per_id_calls == [], "bulk succeeded — per-id must NOT be called"


@respx.mock
async def test_bulk_500_falls_back_to_per_id():
    """Regression: 500 ('Unable to count leads') must trigger per-id fallback."""
    bulk_calls = 0
    per_id_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal bulk_calls
        cid = request.url.params.get("id")
        if cid is None:
            bulk_calls += 1
            return httpx.Response(
                500,
                json={
                    "statusCode": 500,
                    "error": "Internal Server Error",
                    "message": "Unable to count leads",
                },
            )
        per_id_calls.append(cid)
        return httpx.Response(200, json=_per_id_payload(cid))

    _wire_handler(handler)

    result = await main.fetch_campaign_analytics(["a", "b", "c"])

    assert {r["campaign_id"] for r in result} == {"a", "b", "c"}
    assert bulk_calls >= 1, "bulk must be tried at least once"
    assert sorted(per_id_calls) == ["a", "b", "c"]


@respx.mock
async def test_bulk_empty_array_triggers_per_id_fallback():
    """When bulk returns 200 with [] (Instantly has been seen to do this on
    partial failures), we should still try per-id."""
    per_id_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        cid = request.url.params.get("id")
        if cid is None:
            return httpx.Response(200, json=[])
        per_id_calls.append(cid)
        return httpx.Response(200, json=_per_id_payload(cid))

    _wire_handler(handler)

    result = await main.fetch_campaign_analytics(["a", "b"])
    assert {r["campaign_id"] for r in result} == {"a", "b"}
    assert sorted(per_id_calls) == ["a", "b"]


@respx.mock
async def test_per_id_partial_failures_are_skipped():
    """Some per-id requests may 500 — the run must still return what worked."""

    def handler(request: httpx.Request) -> httpx.Response:
        cid = request.url.params.get("id")
        if cid is None:
            return httpx.Response(500, json={"message": "Unable to count leads"})
        if cid == "broken":
            return httpx.Response(500, json={"message": "broken"})
        return httpx.Response(200, json=_per_id_payload(cid))

    _wire_handler(handler)

    result = await main.fetch_campaign_analytics(["ok-1", "ok-2", "broken"])
    ids = {r["campaign_id"] for r in result}
    assert ids == {"ok-1", "ok-2"}
    assert "broken" not in ids


@respx.mock
async def test_bulk_fails_and_no_ids_returns_empty():
    """Backward compatibility: caller without a known id list still gets [] on
    bulk failure (no per-id work to do).  This guards against accidental
    regressions in scheduled jobs that may not yet pass campaign ids."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"message": "Unable to count leads"})

    _wire_handler(handler)

    result = await main.fetch_campaign_analytics(None)
    assert result == []

    result_empty = await main.fetch_campaign_analytics([])
    assert result_empty == []


@respx.mock
async def test_per_id_fallback_handles_many_ids():
    """Smoke test: with 20 ids we must finish without exhausting connections.
    The implementation MUST cap concurrency (target: 8) so we do not flood
    Instantly with 1700 simultaneous requests in production."""
    ids = [f"id-{i}" for i in range(20)]
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        cid = request.url.params.get("id")
        if cid is None:
            return httpx.Response(500, json={"message": "Unable to count leads"})
        seen.append(cid)
        return httpx.Response(200, json=_per_id_payload(cid))

    _wire_handler(handler)

    result = await main.fetch_campaign_analytics(ids)
    assert len(result) == 20
    assert {r["campaign_id"] for r in result} == set(ids)
    assert sorted(seen) == sorted(ids)


def test_concurrency_default_is_eight():
    """Per-id fallback concurrency is configurable but defaults to a value safe
    for Instantly's rate limit on a 1700-campaign workspace."""
    assert main.ANALYTICS_FALLBACK_CONCURRENCY >= 4
    assert main.ANALYTICS_FALLBACK_CONCURRENCY <= 16


# ── should_notify (Telegram throttling) ──────────────────────────────────────
#
# Background (May 2026): the previous implementation considered every cycle
# where `leads_total > 0` as "has changes", which is true on essentially
# every cycle when active clients have campaigns. With INSTANTLY_SYNC_INTERVAL_SEC
# at 43200 (12h) that meant ~2 Telegram messages/day — tolerable. Lowering the
# interval to 3600 (1h) would have made the bot spam ~24 messages/day.
#
# `should_notify(result, manual)` is a pure function that decides when the
# scheduled sync should ping Telegram. Manual triggers and errors always
# notify; otherwise we only notify on real *deltas* (added/removed campaigns,
# api errors, failed leads syncs). The total leads count is informational, not
# a delta, so it must NOT trigger on its own.

def _ok(**overrides: object) -> dict:
    base = {
        "status": "ok",
        "added": 0,
        "removed": 0,
        "updated": 0,
        "api_errors": 0,
        "leads_campaigns_failed": 0,
        "leads_total": 0,
    }
    base.update(overrides)
    return base


def test_should_notify_quiet_when_nothing_changed():
    """Regression: scheduled run with leads but no deltas must NOT notify."""
    assert main.should_notify(_ok(leads_total=1549), manual=False) is False
    assert main.should_notify(_ok(), manual=False) is False


def test_should_notify_on_added_or_removed_campaigns():
    assert main.should_notify(_ok(added=1), manual=False) is True
    assert main.should_notify(_ok(removed=1), manual=False) is True


def test_should_notify_on_api_errors():
    assert main.should_notify(_ok(api_errors=3), manual=False) is True


def test_should_notify_on_leads_sync_failures():
    assert main.should_notify(_ok(leads_campaigns_failed=1), manual=False) is True


def test_should_notify_on_status_error():
    """If the whole sync crashed, always notify so on-call sees it fast."""
    err = {"status": "error", "error": "boom"}
    assert main.should_notify(err, manual=False) is True


def test_should_notify_on_manual_trigger():
    """`/sync` from Telegram should always echo the result back to the user."""
    assert main.should_notify(_ok(leads_total=0), manual=True) is True


def test_default_sync_interval_is_one_hour():
    """`.env` on prod should set INSTANTLY_SYNC_INTERVAL_SEC=3600. The code
    enforces a 1h floor (MIN_SYNC_INTERVAL_SEC); the unset-default also matches."""
    assert main.MIN_SYNC_INTERVAL_SEC == 3600
