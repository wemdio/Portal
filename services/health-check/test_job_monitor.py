from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


MODULE_PATH = Path(__file__).with_name("main.py")
SPEC = importlib.util.spec_from_file_location("portal_health_check_main", MODULE_PATH)
assert SPEC and SPEC.loader
health = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = health
SPEC.loader.exec_module(health)


class FakeConnection:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.fetch = AsyncMock(return_value=self.rows)
        self.fetchrow = AsyncMock(return_value={"alert_key": "claimed"})
        self.fetchval = AsyncMock(return_value=1)
        self.execute = AsyncMock()
        self.executemany = AsyncMock()
        self.close = AsyncMock()


class JobMonitorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        health.DATABASE_URL = "postgres://test"
        health._JOB_PROGRESS_TRACKER.clear()

    def test_manual_stop_messages_are_not_failures(self):
        self.assertTrue(health._is_manual_stop_error("Остановлено пользователем"))
        self.assertTrue(health._is_manual_stop_error("Job cancelled by user"))
        self.assertFalse(health._is_manual_stop_error("Playwright browser crashed"))

    async def test_parser_archive_sink_is_filtered_from_monitor_queries(self):
        spec = next(item for item in health._JOB_MONITOR_SPECS if item.table == "parser_jobs")
        conn = FakeConnection()

        await health._fetch_active_job_rows(conn, spec)

        query = conn.fetch.await_args.args[0]
        self.assertIn("j.parser_type <> 'hh_vacancies_autopipeline'", query)

    def test_base_constructor_uses_database_heartbeat(self):
        spec = next(
            item for item in health._JOB_MONITOR_SPECS
            if item.table == "base_constructor_jobs"
        )

        self.assertEqual(spec.updated_column, "started_at")
        self.assertIsNone(spec.started_column)

    def test_tg_transcribe_uses_compact_worker_progress(self):
        spec = next(
            item for item in health._JOB_MONITOR_SPECS
            if item.table == "tg_transcribe_jobs"
        )

        self.assertEqual(spec.updated_column, "updated_at")
        self.assertIn("monitor_progress", spec.progress_sql or "")
        self.assertNotEqual(health._progress_sql(spec), "")

    async def test_stuck_pending_job_alerts_once(self):
        spec = health.JobMonitorSpec(
            "yandex_maps_jobs",
            "Яндекс.Карты",
            ("pending", "running"),
            ("processed_links",),
            "portal-worker-yandexmaps",
        )
        row = {
            "id": "12345678-aaaa-bbbb-cccc-123456789000",
            "status": "pending",
            "progress": "0",
            "activity_secs": None,
            "active_secs": 901,
            "age_secs": 901,
            "owner_name": "Ксения Хохлова",
            "owner_email": "x@example.com",
        }
        conn = FakeConnection()
        with (
            patch.object(health, "_JOB_MONITOR_SPECS", (spec,)),
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_fetch_active_job_rows", AsyncMock(return_value=[row])),
            patch.object(health, "_claim_job_alert", AsyncMock(side_effect=[True, False])),
        ):
            first = await health.check_stuck_jobs()
            second = await health.check_stuck_jobs()

        self.assertEqual(len(first), 1)
        self.assertIn("Долго висит: Яндекс.Карты", first[0])
        self.assertIn("Ксения Хохлова", first[0])
        self.assertEqual(second, [])

    async def test_failed_job_skips_manual_stop_and_alerts_real_error(self):
        spec = health.JobMonitorSpec(
            "yandex_maps_jobs",
            "Яндекс.Карты",
            ("pending", "running"),
            ("processed_links",),
            "portal-worker-yandexmaps",
        )
        rows = [
            {
                "id": "manual-stop",
                "status": "failed",
                "error_message": "Остановлено пользователем",
                "owner_name": "Коллега",
                "owner_email": None,
            },
            {
                "id": "real-error",
                "status": "failed",
                "error_message": "Playwright browser crashed",
                "owner_name": "Коллега",
                "owner_email": None,
            },
        ]
        conn = FakeConnection(rows=rows)
        claim = AsyncMock(return_value=True)
        with (
            patch.object(health, "_JOB_MONITOR_SPECS", (spec,)),
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_baseline_existing_failures", AsyncMock(return_value=True)),
            patch.object(health, "_claim_job_alert", claim),
        ):
            alerts = await health.check_failed_jobs()

        self.assertEqual(len(alerts), 1)
        self.assertIn("Playwright browser crashed", alerts[0])
        claim.assert_awaited_once_with(conn, "failed:yandex_maps_jobs:real-error")


if __name__ == "__main__":
    unittest.main()


class _RoutingConnection:
    """FakeConnection, роутящая fetch по подстроке имени таблицы в запросе."""

    def __init__(self, rows_by_marker=None, baseline_exists=True):
        self.rows_by_marker = rows_by_marker or {}
        self.queries: list[str] = []

        async def _fetch(query, *args):
            self.queries.append(query)
            for marker, rows in self.rows_by_marker.items():
                if marker in query:
                    return rows
            return []

        self.fetch = AsyncMock(side_effect=_fetch)
        self.fetchrow = AsyncMock(return_value={"alert_key": "claimed"})
        self.fetchval = AsyncMock(return_value=1 if baseline_exists else None)
        self.execute = AsyncMock()
        self.executemany = AsyncMock()
        self.close = AsyncMock()


def _fixed_now(hour=12, day=4, month=8, year=2026):
    class _DT(datetime.__class__):
        pass

    real = datetime
    fixed = real(year, month, day, hour, 0, 0, tzinfo=timezone.utc)

    class _FakeDatetime:
        @staticmethod
        def now(tz=None):
            return fixed

    return _FakeDatetime()


from datetime import datetime, timezone, timedelta  # noqa: E402  (для фабрик строк)


class PipelineRunsMonitorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        health.DATABASE_URL = "postgres://test"

    async def test_stuck_outreachos_run_alerts_with_log_hint(self):
        started = datetime.now(timezone.utc) - timedelta(hours=4)
        rows = [{
            "id": "run-stuck-1", "status": "running", "parsed": None,
            "new_employers": None, "valid_contacts": None, "appended": None,
            "appended_b": None, "error_message": None,
            "started_at": started, "finished_at": None,
        }]
        conn = _RoutingConnection({"outreachos_pipeline_runs": rows})
        with patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)):
            alerts = await health._check_outreachos_pipeline(conn)
        self.assertEqual(len(alerts), 1)
        self.assertIn("завис", alerts[0])
        self.assertIn("outreachos-cron.log", alerts[0])

    async def test_completed_today_sends_daily_digest(self):
        started = datetime.now(timezone.utc) - timedelta(hours=1)
        rows = [{
            "id": "run-ok-1", "status": "completed", "parsed": 6300,
            "new_employers": 400, "valid_contacts": 180, "appended": 79,
            "appended_b": 92, "error_message": None,
            "started_at": started, "finished_at": started,
        }]
        conn = _RoutingConnection({"outreachos_pipeline_runs": rows})
        with patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)):
            alerts = await health._check_outreachos_pipeline(conn)
        digests = [a for a in alerts if "завершён" in a]
        self.assertEqual(len(digests), 1)
        self.assertIn("всего 171", digests[0])

    async def test_missing_todays_run_alerts_once_per_day(self):
        conn = _RoutingConnection({"outreachos_pipeline_runs": []})
        with patch.object(health, "datetime", _fixed_now(hour=10)):
            alerts = await health._check_outreachos_pipeline(conn)
        self.assertEqual(len(alerts), 1)
        self.assertIn("не стартовал", alerts[0])

    async def test_missing_check_quiet_before_deadline(self):
        conn = _RoutingConnection({"outreachos_pipeline_runs": []})
        with patch.object(health, "datetime", _fixed_now(hour=2)):
            alerts = await health._check_outreachos_pipeline(conn)
        self.assertEqual(alerts, [])

    async def test_autopipeline_failed_run_alerts_after_baseline(self):
        started = datetime.now(timezone.utc) - timedelta(hours=2)
        rows = [{
            "id": "auto-fail-1", "status": "failed", "parsed_count": 100,
            "new_count": 10, "routed_count": 0, "stored_count": 0, "failed_count": 1,
            "error_message": "endpoint timeout", "started_at": started,
            "finished_at": started, "heartbeat_at": started, "owner": "Клиент",
        }]
        conn = _RoutingConnection({"client_auto_pipeline_runs": rows})
        with (
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_baseline_autopipe_failures", AsyncMock(return_value=True)),
        ):
            alerts = await health._check_autopipeline(conn)
        self.assertEqual(len(alerts), 1)
        self.assertIn("endpoint timeout", alerts[0])
        self.assertIn("portal-worker-autopipeline", alerts[0])

    async def test_autopipeline_stuck_on_stale_heartbeat(self):
        started = datetime.now(timezone.utc) - timedelta(hours=3)
        heartbeat = datetime.now(timezone.utc) - timedelta(minutes=45)
        rows = [{
            "id": "auto-stuck-1", "status": "running", "parsed_count": 500,
            "new_count": 50, "routed_count": 5, "stored_count": 3, "failed_count": 0,
            "error_message": None, "started_at": started,
            "finished_at": None, "heartbeat_at": heartbeat, "owner": "Клиент",
        }]
        conn = _RoutingConnection({"client_auto_pipeline_runs": rows})
        with (
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_baseline_autopipe_failures", AsyncMock(return_value=True)),
        ):
            alerts = await health._check_autopipeline(conn)
        self.assertEqual(len(alerts), 1)
        self.assertIn("завис", alerts[0])
        self.assertIn("heartbeat", alerts[0])

    async def test_autopipeline_fresh_run_is_quiet(self):
        started = datetime.now(timezone.utc) - timedelta(minutes=10)
        rows = [{
            "id": "auto-live-1", "status": "running", "parsed_count": 50,
            "new_count": 5, "routed_count": 0, "stored_count": 0, "failed_count": 0,
            "error_message": None, "started_at": started,
            "finished_at": None, "heartbeat_at": started, "owner": "Клиент",
        }]
        conn = _RoutingConnection({"client_auto_pipeline_runs": rows})
        with (
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_baseline_autopipe_failures", AsyncMock(return_value=True)),
        ):
            alerts = await health._check_autopipeline(conn)
        self.assertEqual(alerts, [])


class PipelineRunsCombinedTests(unittest.IsolatedAsyncioTestCase):
    """Регрессия 06.08: gather на одном asyncpg-коннекте молча пропускал
    autopipeline-проверку каждый тик. Обе проверки обязаны исполняться."""

    def setUp(self):
        health.DATABASE_URL = "postgres://test"

    async def test_both_pipeline_checks_run(self):
        started = datetime.now(timezone.utc) - timedelta(hours=1)
        out_rows = [{
            "id": "run-ok-9", "status": "completed", "parsed": 100,
            "new_employers": 10, "valid_contacts": 5, "appended": 2,
            "appended_b": 3, "error_message": None,
            "started_at": started, "finished_at": started,
        }]
        auto_rows = [{
            "id": "auto-fail-9", "status": "failed", "parsed_count": 1,
            "new_count": 1, "routed_count": 0, "stored_count": 0, "failed_count": 1,
            "error_message": "boom", "started_at": started,
            "finished_at": started, "heartbeat_at": started, "owner": "Клиент",
        }]
        conn = _RoutingConnection({
            "outreachos_pipeline_runs": out_rows,
            "client_auto_pipeline_runs": auto_rows,
        })
        with (
            patch.object(health.asyncpg, "connect", AsyncMock(return_value=conn)),
            patch.object(health, "_baseline_autopipe_failures", AsyncMock(return_value=True)),
        ):
            alerts = await health.check_pipeline_runs()
        tables_hit = " ".join(conn.queries)
        self.assertIn("outreachos_pipeline_runs", tables_hit)
        self.assertIn("client_auto_pipeline_runs", tables_hit)
        self.assertTrue(any("завершён" in a for a in alerts))
        self.assertTrue(any("boom" in a for a in alerts))
