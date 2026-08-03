"""Маппинг задач AMO в строку amo_tasks.

Логика вынесена в чистую функцию _to_row именно ради этих тестов: сетевая
часть (run — пагинация, watermark из БД) сетевая/БД-завязанная и в юните
непроверяема. Реальная форма задачи — живая проба на проде 2026-08-03
(см. docs/superpowers/plans/2026-08-03-renewals-from-payments.md, Task 1).
"""
import json

from sources.amo_tasks import ENTITY_TYPE, AmoTasksSync

REAL_TASK = {
    "id": 23248195,
    "created_by": 12036498,
    "updated_by": 12036498,
    "created_at": 1780555365,
    "updated_at": 1781095411,
    "responsible_user_id": 12036498,
    "entity_id": 33462035,
    "entity_type": "leads",
    "duration": 1800,
    "is_completed": True,
    "task_type_id": 2,
    "text": "",
    "result": {"text": "Встреча проведена\nОС завтра в обед"},
    "complete_till": 1781092800,
    "account_id": 31503022,
}


def test_real_task_from_probe_maps_correctly():
    row = AmoTasksSync._to_row(REAL_TASK)
    assert row is not None
    (
        amo_task_id,
        amo_deal_id,
        is_completed,
        result_text,
        text,
        task_type_id,
        responsible_user_id,
        created_by,
        complete_till,
        created_at_amo,
        updated_at_amo,
        raw,
    ) = row

    assert amo_task_id == 23248195
    assert amo_deal_id == 33462035
    assert is_completed is True
    assert result_text == "Встреча проведена\nОС завтра в обед"
    assert text == ""
    assert task_type_id == 2
    assert responsible_user_id == 12036498
    assert created_by == 12036498
    # unix 1781092800 / 1780555365 / 1781095411 → UTC.
    assert complete_till.isoformat() == "2026-06-10T12:00:00+00:00"
    assert created_at_amo.isoformat() == "2026-06-04T06:42:45+00:00"
    assert updated_at_amo.isoformat() == "2026-06-10T12:43:31+00:00"


def test_entity_type_is_leads_constant():
    assert ENTITY_TYPE == "leads"


def test_non_lead_entity_type_is_dropped():
    """Задачи по contacts/companies отбрасываются: у них нет amo_deal_id,
    а колонка в схеме NOT NULL. Основная фильтрация — на стороне API
    (filter[entity_type][]=leads), это защита от того, что где-то в ответе
    всё же проскочит чужой entity_type."""
    task = dict(REAL_TASK, entity_type="contacts")
    assert AmoTasksSync._to_row(task) is None

    task2 = dict(REAL_TASK, entity_type="companies")
    assert AmoTasksSync._to_row(task2) is None


def test_missing_entity_id_is_dropped():
    task = dict(REAL_TASK)
    del task["entity_id"]
    assert AmoTasksSync._to_row(task) is None


def test_missing_task_id_is_dropped():
    task = dict(REAL_TASK)
    del task["id"]
    assert AmoTasksSync._to_row(task) is None


def test_missing_updated_at_is_dropped():
    """updated_at — поле, на котором держится инкрементальный watermark;
    без него строка бесполезна для следующего прогона."""
    task = dict(REAL_TASK)
    del task["updated_at"]
    assert AmoTasksSync._to_row(task) is None


def test_missing_result_does_not_crash_and_gives_none_result_text():
    """Задача может быть не выполнена (или выполнена без комментария) —
    result отсутствует в ответе API целиком. Не должно ронять маппинг."""
    task = dict(REAL_TASK)
    del task["result"]
    row = AmoTasksSync._to_row(task)
    assert row is not None
    assert row[3] is None  # result_text


def test_null_result_does_not_crash():
    task = dict(REAL_TASK, result=None)
    row = AmoTasksSync._to_row(task)
    assert row is not None
    assert row[3] is None  # result_text


def test_missing_complete_till_gives_none():
    task = dict(REAL_TASK)
    del task["complete_till"]
    row = AmoTasksSync._to_row(task)
    assert row is not None
    assert row[8] is None  # complete_till


def test_missing_created_at_gives_none_but_keeps_row():
    task = dict(REAL_TASK)
    del task["created_at"]
    row = AmoTasksSync._to_row(task)
    assert row is not None
    assert row[9] is None  # created_at_amo


def test_incomplete_task_is_kept_not_dropped():
    """Тянем ВСЕ задачи, не только выполненные — незавершённая сегодня
    станет выполненной завтра, и инкремент по updated_at её подхватит."""
    task = dict(REAL_TASK, is_completed=False, result=None)
    row = AmoTasksSync._to_row(task)
    assert row is not None
    assert row[2] is False  # is_completed


def test_payload_round_trips_original_task():
    row = AmoTasksSync._to_row(REAL_TASK)
    assert row is not None
    raw = row[-1]
    restored = json.loads(raw)
    assert restored == REAL_TASK
