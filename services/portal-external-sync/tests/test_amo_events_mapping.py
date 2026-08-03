"""Маппинг AMO-событий lead_status_changed в строку amo_events.

Логика вынесена в чистую функцию _to_row именно ради этих тестов: сетевая
часть (run — пагинация, watermark из БД) сетевая/БД-завязанная и в юните
непроверяема. Реальная форма события — живая проба на проде 2026-07-30.
"""
import json

from sources.amo_events import EVENT_TYPE, AmoEventsSync

REAL_EVENT = {
    "id": "01kysdbvsnt5n43xgp5hmp2k77",
    "type": "lead_status_changed",
    "entity_id": 34079577,
    "entity_type": "lead",
    "created_by": 11121254,
    "created_at": 1785411792,
    "value_after": [{"lead_status": {"id": 143, "pipeline_id": 7670334}}],
    "value_before": [{"lead_status": {"id": 63384122, "pipeline_id": 7670334}}],
}


def test_real_event_from_probe_maps_correctly():
    row = AmoEventsSync._to_row(REAL_EVENT)
    assert row is not None
    amo_deal_id, event_type, changed_at, changed_by, from_value, to_value, payload = row

    assert amo_deal_id == 34079577
    assert event_type == EVENT_TYPE
    assert from_value == "63384122"
    assert to_value == "143"
    assert changed_by == 11121254
    # unix 1785411792 → UTC.
    assert changed_at.isoformat() == "2026-07-30T11:43:12+00:00"


def test_non_lead_entity_type_is_dropped():
    ev = dict(REAL_EVENT, entity_type="contact")
    assert AmoEventsSync._to_row(ev) is None


def test_missing_entity_id_is_dropped():
    ev = dict(REAL_EVENT)
    del ev["entity_id"]
    assert AmoEventsSync._to_row(ev) is None


def test_missing_created_at_is_dropped():
    ev = dict(REAL_EVENT)
    del ev["created_at"]
    assert AmoEventsSync._to_row(ev) is None


def test_empty_value_before_gives_none_from_value_but_keeps_event():
    """Сделка создана сразу в статусе — value_before пустой массив, а не
    отсутствует. Событие всё равно валидно, from_value просто None."""
    ev = dict(REAL_EVENT, value_before=[])
    row = AmoEventsSync._to_row(ev)
    assert row is not None
    assert row[4] is None  # from_value
    assert row[5] == "143"  # to_value не пострадал


def test_payload_round_trips_original_event():
    row = AmoEventsSync._to_row(REAL_EVENT)
    assert row is not None
    payload = row[6]
    restored = json.loads(payload)
    assert restored == REAL_EVENT
