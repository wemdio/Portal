"""
Unit coverage for the scheduler rate-limit math (2026-06-12 backend fixes):

  - hard daily limit: a fast-draining queue must NOT trigger a second batch the
    same day (count tasks already created in the trailing 24h, not just queue size).
  - weekly connect limit: cap invites over a rolling 7-day window.

Tests the pure helper `_slots_to_create` — no DB, no LinkedIn. The DB glue
(_created_since / _refresh_campaign_runtime / reconcile) touches li2_* tables
that don't exist in the SQLite test DB (managed=False, no migrations), so it's
covered by import-smoke + an integration test against real Postgres (TODO).
"""
from linkedin.portal_daemon.scheduler import _slots_to_create


# ─────────────── hard daily limit ───────────────


def test_daily_fresh_day_creates_full_batch():
    assert _slots_to_create(n_per_day=10, daily_used=0) == 10


def test_daily_partially_used():
    assert _slots_to_create(n_per_day=10, daily_used=6) == 4


def test_daily_exhausted_creates_nothing():
    assert _slots_to_create(n_per_day=10, daily_used=10) == 0


def test_daily_overshoot_clamps_to_zero():
    # If somehow more than the limit was created, never go negative.
    assert _slots_to_create(n_per_day=10, daily_used=13) == 0


# ─────────────── weekly connect limit ───────────────


def test_weekly_binds_when_smaller_than_daily():
    # daily would allow 10, but only 3 left in the weekly window.
    assert _slots_to_create(n_per_day=10, daily_used=0, weekly_remaining=3) == 3


def test_daily_binds_when_weekly_has_room():
    assert _slots_to_create(n_per_day=10, daily_used=0, weekly_remaining=20) == 10


def test_weekly_exhausted_creates_nothing():
    assert _slots_to_create(n_per_day=10, daily_used=0, weekly_remaining=0) == 0


def test_weekly_negative_remaining_clamps_to_zero():
    # weekly_used > weekly_limit → remaining negative → 0, not negative.
    assert _slots_to_create(n_per_day=10, daily_used=0, weekly_remaining=-5) == 0


def test_weekly_none_ignores_weekly_cap():
    # Non-connect task types pass weekly_remaining=None.
    assert _slots_to_create(n_per_day=8, daily_used=2, weekly_remaining=None) == 6


def test_both_limits_take_the_min():
    # daily allows 4, weekly allows 2 → 2 wins.
    assert _slots_to_create(n_per_day=10, daily_used=6, weekly_remaining=2) == 2
