"""Маппинг комментариев AMO в строку amo_notes.

Логика вынесена в чистую функцию _to_row именно ради этих тестов: сетевая
часть (run — пагинация, watermark из БД) сетевая/БД-завязанная и в юните
непроверяема.

REPRESENTATIVE_NOTE ниже — НЕ дословный дамп с прода (в отличие от
REAL_TASK в test_amo_tasks_mapping.py / REAL_EVENT в
test_amo_events_mapping.py): для этой задачи доступа к продовому телу ответа
GET /api/v4/leads/notes не было, только перечень полей и типов из пробы
2026-08-03 (см. supabase/migrations/20260803_0003_amo_notes.sql) — id,
entity_id, entity_type, note_type, created_at, created_by, params.text.
Фикстура собрана из этих задокументированных полей, а не угадана произвольно.
"""
import json

from sources.amo_notes import NOTE_TYPE, AmoNotesSync

REPRESENTATIVE_NOTE = {
    "id": 98765432,
    "entity_id": 33462035,
    "entity_type": "leads",
    "note_type": "common",
    "created_by": 12036498,
    "created_at": 1785974400,
    "params": {"text": "Продление 1 - 159к"},
}


def test_representative_note_maps_correctly():
    row = AmoNotesSync._to_row(REPRESENTATIVE_NOTE)
    assert row is not None
    (
        amo_note_id,
        amo_deal_id,
        note_type,
        text,
        created_at_amo,
        created_by,
        raw,
    ) = row

    assert amo_note_id == 98765432
    assert amo_deal_id == 33462035
    assert note_type == "common"
    assert text == "Продление 1 - 159к"
    assert created_by == 12036498
    # unix 1785974400 → UTC.
    assert created_at_amo.isoformat() == "2026-08-06T00:00:00+00:00"


def test_note_type_constant_is_common():
    assert NOTE_TYPE == "common"


def test_non_common_note_type_is_dropped():
    """Дублирующий Python-фильтр — основной фильтр на стороне API
    (filter[note_type][]=common), это защита от его регрессии."""
    for other_type in ("call_out", "call_in", "service_message", "extended_service_message"):
        note = dict(REPRESENTATIVE_NOTE, note_type=other_type)
        assert AmoNotesSync._to_row(note) is None


def test_missing_note_id_is_dropped():
    note = dict(REPRESENTATIVE_NOTE)
    del note["id"]
    assert AmoNotesSync._to_row(note) is None


def test_missing_entity_id_is_dropped():
    note = dict(REPRESENTATIVE_NOTE)
    del note["entity_id"]
    assert AmoNotesSync._to_row(note) is None


def test_missing_created_at_is_dropped():
    """created_at — единственная временная метка комментария и то, на чём
    держится инкрементальный watermark; без неё строка бесполезна."""
    note = dict(REPRESENTATIVE_NOTE)
    del note["created_at"]
    assert AmoNotesSync._to_row(note) is None


def test_missing_params_does_not_crash_and_gives_none_text():
    note = dict(REPRESENTATIVE_NOTE)
    del note["params"]
    row = AmoNotesSync._to_row(note)
    assert row is not None
    assert row[3] is None  # text


def test_null_params_does_not_crash():
    note = dict(REPRESENTATIVE_NOTE, params=None)
    row = AmoNotesSync._to_row(note)
    assert row is not None
    assert row[3] is None  # text


def test_params_without_text_key_gives_none_text():
    note = dict(REPRESENTATIVE_NOTE, params={})
    row = AmoNotesSync._to_row(note)
    assert row is not None
    assert row[3] is None  # text


def test_payload_round_trips_original_note():
    row = AmoNotesSync._to_row(REPRESENTATIVE_NOTE)
    assert row is not None
    raw = row[-1]
    restored = json.loads(raw)
    assert restored == REPRESENTATIVE_NOTE
